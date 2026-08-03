import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

const acceptanceDataDir = `outputs/.tmp/wxdb-mirror-cleanup-partition-${process.pid}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = acceptanceDataDir;
process.env.WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR = `${acceptanceDataDir}/runtime-tmp/wxdb`;

const { DATA_DIR } = await import('../src/lib/paths.js');
const { __discoveryInternals, cleanupStaleWxDbMirrorWorkDirs } = await import('../src/wxenv/discovery.js');

const mirrorRoot = path.join(DATA_DIR, 'wxdb-mirror');
const accountA = 'wxacc_aaaaaaaaaaaaaaaa';
const accountB = 'wxacc_bbbbbbbbbbbbbbbb';
const accountC = 'wxacc_cccccccccccccccc';
const stagingA = path.join(mirrorRoot, `${accountA}.staging-test-a`);
const stagingB = path.join(mirrorRoot, `${accountB}.staging-test-b`);
const unsafeStaging = path.join(mirrorRoot, `${accountC}.staging-test-c`);
let releaseAccountA = null;
let accountAWork = null;
let allCleanupWork = null;

try {
  await fsp.mkdir(stagingA, { recursive: true });
  await fsp.mkdir(stagingB, { recursive: true });

  let notifyAccountAStarted;
  const accountAStarted = new Promise(resolve => { notifyAccountAStarted = resolve; });
  const accountAGate = new Promise(resolve => { releaseAccountA = resolve; });
  accountAWork = __discoveryInternals.runWithWxDbMirrorLock(accountA, async () => {
    notifyAccountAStarted();
    await accountAGate;
  });
  await accountAStarted;

  allCleanupWork = cleanupStaleWxDbMirrorWorkDirs();
  const cleanupDeadline = Date.now() + 3_000;
  while (Date.now() < cleanupDeadline && await fsp.lstat(stagingB).then(() => true, () => false)) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(await fsp.lstat(stagingB).then(() => true, () => false), false,
    'a busy account must not prevent another account stale work directory from being cleaned');

  releaseAccountA();
  releaseAccountA = null;
  await accountAWork;
  accountAWork = null;
  const allCleanupResult = await allCleanupWork;
  allCleanupWork = null;
  assert.equal(allCleanupResult.ok, true);

  await fsp.mkdir(unsafeStaging, { recursive: true });
  const outside = path.join(DATA_DIR, 'outside-cleanup-target');
  await fsp.mkdir(outside, { recursive: true });
  await fsp.symlink(outside, path.join(unsafeStaging, 'unsafe-link'), process.platform === 'win32' ? 'junction' : 'dir');
  const cleanupResult = await cleanupStaleWxDbMirrorWorkDirs({
    mirror_segment: accountC,
    continue_on_recovery_error: true,
  });
  assert.equal(cleanupResult.ok, false, 'a rejected stale-directory deletion must make cleanup explicitly incomplete');
  assert.equal(cleanupResult.recovery_errors.length, 1, 'a rejected stale-directory deletion must expose one bounded recovery error');
  assert.equal(cleanupResult.recovery_errors[0].segment, accountC);
  assert.equal(await fsp.lstat(unsafeStaging).then(() => true, () => false), true,
    'unsafe stale work must remain untouched while its cleanup error is reported');
} finally {
  releaseAccountA?.();
  await accountAWork?.catch(() => {});
  await allCleanupWork?.catch(() => {});
  await fsp.rm(DATA_DIR, { recursive: true, force: true });
}

console.log('wxdb mirror cleanup partition tests passed');
