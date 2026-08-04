import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const acceptanceDataDir = `outputs/.tmp/wxdb-isolated-shutdown-drain-${process.pid}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = acceptanceDataDir;
process.env.WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR = `${acceptanceDataDir}/runtime-tmp/wxdb`;

const isolated = await import('../src/wxdb/isolated.js');

assert.equal(typeof isolated.activeWxDbIsolatedWorkerStatus, 'function', 'isolated workers must expose one shutdown snapshot');
assert.equal(typeof isolated.closeWxDbIsolatedWorkerAdmission, 'function', 'isolated workers must expose terminal admission closure');
assert.deepEqual(isolated.activeWxDbIsolatedWorkerStatus(), {
  active: 0,
  persistent: 0,
  one_shot: 0,
  cleanup_failed: 0,
  closing: false,
});
const pendingOneShot = isolated.listChatroomsFromWxDbIsolated({
  account_id: 'wxacc_0000000000000000',
  raw_keys: [],
});
assert.equal(isolated.activeWxDbIsolatedWorkerStatus().one_shot, 1, 'a live one-shot child must enter the global worker registry synchronously');
const closed = isolated.closeWxDbIsolatedWorkerAdmission('test shutdown');
assert.equal(closed.closing, true);
assert.equal(closed.cancelled, 1);
await assert.rejects(
  pendingOneShot,
  error => error?.name === 'AbortError' && error?.code === 'wxdb_worker_shutdown',
  'closing admission must reject the caller promptly without hiding the child cleanup lifecycle',
);
await isolated.releaseAllWxDbIsolatedBatchSessions('test shutdown');
assert.deepEqual(isolated.activeWxDbIsolatedWorkerStatus(), {
  active: 0,
  persistent: 0,
  one_shot: 0,
  cleanup_failed: 0,
  closing: true,
}, 'global release must wait for the one-shot child exit and worker-owned cleanup before reporting idle');
await assert.rejects(
  isolated.probeWxDbIsolated({}),
  error => error?.name === 'AbortError' && error?.code === 'wxdb_worker_shutdown',
  'new one-shot workers must be rejected after shutdown is accepted',
);

const [isolatedSource, mainSource] = await Promise.all([
  fsp.readFile(new URL('../src/wxdb/isolated.js', import.meta.url), 'utf8'),
  fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
]);
assert.ok(
  isolatedSource.includes('const ONE_SHOT_WXDB_WORKERS = new Map()')
    && isolatedSource.includes('function registerOneShotWxDbWorker(')
    && isolatedSource.includes('record.lifecycle_promise')
    && isolatedSource.includes('cleanupWorkerCopiesAfterExit(record.child?.pid, record.worker_token)')
    && isolatedSource.includes('const oneShotRecords = oneShotWxDbWorkerRecords()')
    && isolatedSource.includes('oneShotRecords.map(record => closeOneShotWxDbWorker(record, reason))'),
  'global release must retain every one-shot child until both process exit and worker-owned copy cleanup settle',
);
assert.ok(
  mainSource.includes("closeWxDbIsolatedWorkerAdmission('service_shutdown')")
    && mainSource.includes("await releaseAllWxDbIsolatedBatchSessions('service_shutdown')")
    && mainSource.includes('const isolatedWorkers = activeWxDbIsolatedWorkerStatus()')
    && mainSource.includes('isolatedWorkers?.active === 0')
    && mainSource.includes('isolatedWorkers?.cleanup_failed === 0'),
  'shutdown must close worker admission at acceptance, await all worker lifecycles, and block tmp cleanup on any survivor or cleanup failure',
);

console.log('wxdb isolated shutdown drain tests passed');
