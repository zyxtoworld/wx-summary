import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const acceptanceDataDir = `outputs/.tmp/shutdown-producer-terminal-admission-${process.pid}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = acceptanceDataDir;
process.env.WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR = `${acceptanceDataDir}/runtime-tmp/wxdb`;

const [discovery, mainModule] = await Promise.all([
  import('../src/wxenv/discovery.js'),
  import('../src/main.js'),
]);

assert.equal(typeof discovery.closeWxDbMirrorTaskAdmission, 'function', 'mirror work must expose terminal shutdown admission');
const closedMirrors = discovery.closeWxDbMirrorTaskAdmission('test shutdown');
assert.equal(closedMirrors.closing, true);
assert.equal(discovery.activeWxDbMirrorTaskStatus().active, 0);
await assert.rejects(
  () => discovery.ensureWxDbMirror({ reason: 'late_after_shutdown' }),
  error => error?.status === 503 && error?.code === 'wxdb_mirror_shutdown',
  'mirror work must reject registration after its settled shutdown snapshot',
);
assert.equal(discovery.activeWxDbMirrorTaskStatus().active, 0, 'rejected mirror work must never enter the active registry');

const {
  acquireLocalActionSlot,
  assertDigestWorkAdmissionOpen,
  beginLocalAction,
  closeDigestWorkAdmission,
  closeLocalActionAdmission,
  localActionLaneStatus,
  localActionWorkStatus,
} = mainModule.__mainInternals;
assert.equal(typeof closeLocalActionAdmission, 'function', 'local actions must expose terminal shutdown admission');
assert.equal(typeof beginLocalAction, 'function', 'local-action leases must remain testable');
assert.equal(typeof localActionWorkStatus, 'function', 'all local-action producers must share one live status snapshot');

const lease = beginLocalAction({ local_action_id: `shutdown-lease-${process.pid}` }, '测试本地动作');
assert.equal(localActionWorkStatus().leases, 1, 'active action leases must be visible to shutdown drain');
lease.done();
assert.equal(localActionWorkStatus().leases, 0);

const releaseSlot = await acquireLocalActionSlot({ lane: 'window' });
releaseSlot();
assert.equal(localActionLaneStatus().active, 0);
const closedActions = closeLocalActionAdmission('test shutdown');
assert.equal(closedActions.closing, true);
assert.equal(localActionLaneStatus().closing, true);

await assert.rejects(
  () => acquireLocalActionSlot({ lane: 'window' }),
  error => error?.status === 503 && error?.code === 'service_shutting_down',
  'local-action slots must reject registration after their settled shutdown snapshot',
);
assert.throws(
  () => beginLocalAction({ local_action_id: `shutdown-late-${process.pid}` }, '测试本地动作'),
  error => error?.status === 503 && error?.code === 'service_shutting_down',
  'local-action leases must reject registration after terminal shutdown starts',
);
assert.equal(localActionWorkStatus().leases, 0);
assert.equal(localActionLaneStatus().active, 0);

assert.equal(typeof closeDigestWorkAdmission, 'function', 'digest work must expose terminal shutdown admission');
closeDigestWorkAdmission('test_shutdown', 'test shutdown');
assert.throws(
  () => assertDigestWorkAdmissionOpen(),
  error => error?.status === 503 && error?.code === 'service_shutting_down',
  'digest work must reject registration after terminal shutdown starts',
);

const mainSource = await fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const shutdownStart = mainSource.indexOf('async function gracefulShutdown(');
const shutdownEnd = mainSource.indexOf('\nfunction localActionWorkStatus(', shutdownStart);
const shutdownSource = mainSource.slice(shutdownStart, shutdownEnd);
const firstShutdownAwait = shutdownSource.indexOf('await publishShutdownRuntimeInfo()');
for (const terminalClose of [
  'closeDigestWorkAdmission(',
  'cancelServerRenderWork(',
  'cancelThumbnailRenderWork(',
  'closeWxDbMirrorTaskAdmission(',
  'closeLocalActionAdmission(',
  'cancelLocalActionCapabilityProbes(',
]) {
  const closeAt = shutdownSource.indexOf(terminalClose);
  assert.ok(closeAt >= 0 && closeAt < firstShutdownAwait, `${terminalClose} must close admission before shutdown yields`);
}

console.log('shutdown producer terminal admission tests passed');
