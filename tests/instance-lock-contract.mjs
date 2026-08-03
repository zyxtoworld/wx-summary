import assert from 'node:assert/strict';

const acceptanceDataDir = `outputs/.tmp/instance-lock-contract-${process.pid}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = acceptanceDataDir;
process.env.WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR = `${acceptanceDataDir}/runtime-tmp/wxdb`;

const { __mainInternals } = await import('../src/main.js');

const stale = { mtimeMs: 90_000 };
const fresh = { mtimeMs: 100_000 };
const owner = { pid: 123, process_start_id: 'start-a' };

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

console.log('instance lock contract tests passed');
