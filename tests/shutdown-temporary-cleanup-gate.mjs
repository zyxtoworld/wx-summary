import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import vm from 'node:vm';

const mainSource = await fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const helperStart = mainSource.indexOf('function shutdownTemporaryCleanupSafe(');
const helperEnd = mainSource.indexOf('\nasync function gracefulShutdown(', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'shutdown temporary cleanup gate must remain independently testable');

const sandbox = {};
vm.runInNewContext(
  `${mainSource.slice(helperStart, helperEnd)}\nglobalThis.__shutdownTemporaryCleanupSafe = shutdownTemporaryCleanupSafe;`,
  sandbox,
  { timeout: 1_000 },
);

const settled = {
  schedulerCleanupSafe: true,
  rendererCleanupSafe: true,
  remainingMirrors: { active: 0 },
  capabilityProbes: { active: 0 },
  localActions: {
    active: 0,
    active_commands: 0,
    leases: 0,
    queued: 0,
    verification_timers: 0,
    active_verifications: 0,
  },
  remainingDigest: { requests: 0, saves: 0, batch_starts: 0 },
};

assert.equal(sandbox.__shutdownTemporaryCleanupSafe(settled), true, 'fully settled shutdown work may release temporary files');

for (const mutation of [
  value => { value.schedulerCleanupSafe = false; },
  value => { value.rendererCleanupSafe = false; },
  value => { value.remainingMirrors.active = 1; },
  value => { value.capabilityProbes.active = 1; },
  value => { value.localActions.active = 1; },
  value => { value.localActions.active_commands = 1; },
  value => { value.localActions.leases = 1; },
  value => { value.localActions.queued = 1; },
  value => { value.localActions.verification_timers = 1; },
  value => { value.localActions.active_verifications = 1; },
  value => { value.remainingDigest.requests = 1; },
  value => { value.remainingDigest.saves = 1; },
  value => { value.remainingDigest.batch_starts = 1; },
]) {
  const value = structuredClone(settled);
  mutation(value);
  assert.equal(sandbox.__shutdownTemporaryCleanupSafe(value), false, 'any active shutdown producer must preserve temporary files');
}

const shutdownStart = mainSource.indexOf('async function gracefulShutdown(');
const shutdownEnd = mainSource.indexOf('\nasync function waitForLocalActionWorkToSettle(', shutdownStart);
const shutdownSource = mainSource.slice(shutdownStart, shutdownEnd);
assert.match(shutdownSource, /const temporaryCleanupSafe = shutdownTemporaryCleanupSafe\(/);
assert.match(shutdownSource, /if \(temporaryCleanupSafe\) \{[\s\S]*?clearTmpDirForShutdown/);
assert.match(shutdownSource, /remainingDigest\.requests \|\| remainingDigest\.saves \|\| remainingDigest\.batch_starts/);
assert.match(shutdownSource, /const finalMirrors = activeWxDbMirrorTaskStatus\(\)/);
assert.match(shutdownSource, /const finalLocalActions = localActionWorkStatus\(\)/);

console.log('shutdown temporary cleanup gate tests passed');
