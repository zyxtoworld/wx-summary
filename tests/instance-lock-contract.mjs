import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';

const acceptanceDataDir = `outputs/.tmp/instance-lock-contract-${process.pid}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = acceptanceDataDir;
process.env.WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR = `${acceptanceDataDir}/runtime-tmp/wxdb`;

const { __mainInternals } = await import('../src/main.js');
const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

const stale = { mtimeMs: 90_000 };
const fresh = { mtimeMs: 100_000 };
const owner = { pid: 123, process_start_id: 'start-a' };

assert.equal(typeof __mainInternals.instanceLockOwnerIsComplete, 'function');
assert.equal(__mainInternals.instanceLockOwnerIsComplete({
  pid: 123,
  process_start_id: 'start-a',
  lock_token: 'a'.repeat(32),
  project_root: root,
  started_at: new Date().toISOString(),
}), true, 'a fully published generation-bound lock owner should be eligible for immediate death verification');
assert.equal(__mainInternals.instanceLockOwnerIsComplete({
  pid: 123,
  process_start_id: 'start-a',
  lock_token: '',
  project_root: root,
  started_at: new Date().toISOString(),
}), false, 'a partially written fresh lock must remain fail-closed during its initialization grace period');
assert.equal(__mainInternals.instanceLockOwnerIsComplete({
  pid: 123,
  process_start_id: 'start-a',
  lock_token: 'a'.repeat(32),
  project_root: '',
  started_at: new Date().toISOString(),
}), false, 'an empty project root must not resolve to the current working directory and masquerade as a complete lock');
assert.equal(__mainInternals.instanceLockOwnerIsComplete({
  pid: 123,
  process_start_id: 'start-a',
  lock_token: 'a'.repeat(32),
  project_root: path.dirname(root),
  started_at: new Date().toISOString(),
}), false, 'a fresh lock claiming another project root must not be reclaimed immediately');

assert.equal(
  await __mainInternals.instanceLockOwnerMayBeReclaimed(owner, {
    lockStat: stale,
    now: 130_000,
    processAlive: () => true,
    processStartIdentityFn: async () => '',
  }),
  false,
  'a live PID must retain the lock when its process-start identity cannot be queried',
);
assert.equal(
  await __mainInternals.instanceLockOwnerMayBeReclaimed({ pid: 123 }, {
    lockStat: stale,
    now: 130_000,
    processAlive: () => true,
  }),
  false,
  'a live legacy owner without start identity must also fail closed after heartbeat expiry',
);
assert.equal(
  await __mainInternals.instanceLockOwnerMayBeReclaimed(owner, {
    lockStat: fresh,
    now: 101_000,
    processAlive: () => false,
  }),
  true,
  'a confirmed dead owner remains reclaimable',
);
assert.equal(
  await __mainInternals.instanceLockOwnerMayBeReclaimed(owner, {
    lockStat: fresh,
    now: 101_000,
    processAlive: () => true,
    processStartIdentityFn: async () => 'start-b',
  }),
  true,
  'an explicitly mismatched process generation remains reclaimable',
);

const mainSource = await fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const acquireStart = mainSource.indexOf('async function acquireInstanceLock(');
const acquireEnd = mainSource.indexOf('\nfunction normalizeDigestBatchId(', acquireStart);
const acquireSource = mainSource.slice(acquireStart, acquireEnd);
const immediateOwnerCheck = acquireSource.indexOf('instanceLockOwnerIsComplete(lockSnapshot?.owner)');
const initializationGraceWait = acquireSource.indexOf('await new Promise(resolve => setTimeout(resolve, 1200))');
assert.ok(
  immediateOwnerCheck >= 0 && immediateOwnerCheck < initializationGraceWait,
  'a complete fresh lock owner must be checked for confirmed death before startup waits and rejects the new service',
);

console.log('instance lock contract tests passed');
