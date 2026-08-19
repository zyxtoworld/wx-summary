import assert from 'node:assert/strict';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

class MemoryStorage {
  #values = new Map();
  get length() { return this.#values.size; }
  key(index) { return [...this.#values.keys()][index] ?? null; }
  getItem(key) { return this.#values.get(String(key)) ?? null; }
  setItem(key, value) { this.#values.set(String(key), String(value)); }
  removeItem(key) { this.#values.delete(String(key)); }
}

globalThis.location = new URL('http://wx-summary.test/#/digest');
globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage();
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { locks: null },
});

const loader = createBrowserModuleLoader();
const {
  finalizeInterruptedDigestBatchRecord,
  readInterruptedDigestBatchRecords,
  rememberInterruptedDigestBatch,
} = await loader.load('js/pages/digest/recovery.js');

const accountId = 'account-record-lifecycle';
const accountFingerprint = 'd'.repeat(64);
const baseRecord = batchId => ({
  batch_id: batchId,
  batch_token: `token-${batchId}-123456789`,
  service_instance_id: 'service-instance-1234',
  account_id: accountId,
  account_fingerprint: accountFingerprint,
  preview_text: false,
  batch_total: 2,
  batch_index: -1,
  phase: 'starting',
  targets: [
    { group_id: 'group-1', group_name: '群一' },
    { group_id: 'group-2', group_name: '群二' },
  ],
  started_at: Date.now(),
});

function record(batchId) {
  return readInterruptedDigestBatchRecords().find(item => item.batch_id === batchId) || null;
}

{
  const original = baseRecord('batch-digest-unknown');
  assert.equal(rememberInterruptedDigestBatch(original), true);
  const persistedOriginal = record(original.batch_id);
  const error = Object.assign(new Error('摘要结果未知'), {
    outcomeUnknown: true,
    digestRecovery: {
      phase: 'terminal_results_pending_recovery',
      batch_id: original.batch_id,
      batch_index: 1,
      account_id: 'attacker-account',
      account_fingerprint: 'e'.repeat(64),
    },
  });
  const disposition = finalizeInterruptedDigestBatchRecord(error, {
    batchId: original.batch_id,
    currentGroup: '群二',
  });
  assert.deepEqual(disposition, {
    retained: true,
    forgotten: false,
    phase: 'terminal_results_pending_recovery',
  });
  const retained = record(original.batch_id);
  assert.equal(retained.batch_token, persistedOriginal.batch_token, '结果未知时必须保留原 batch token');
  assert.deepEqual(retained.targets, persistedOriginal.targets, '结果未知时必须保留原 targets');
  assert.equal(retained.account_id, accountId);
  assert.equal(retained.account_fingerprint, accountFingerprint, '错误载荷不得改写原账号指纹');
  assert.equal(retained.batch_index, 1);
  assert.equal(retained.current_group, '群二');
  assert.equal(retained.phase, 'terminal_results_pending_recovery');
}

{
  const original = baseRecord('batch-start-unknown');
  assert.equal(rememberInterruptedDigestBatch(original), true);
  const error = Object.assign(new Error('批次启动结果未知'), { outcomeUnknown: true });
  const disposition = finalizeInterruptedDigestBatchRecord(error, { batchId: original.batch_id });
  assert.equal(disposition.retained, true);
  assert.equal(record(original.batch_id).phase, 'starting_outcome_unknown',
    'batch-start unknown 没有 digestRecovery 上下文时也必须保留明确阶段');
  assert.equal(record(original.batch_id).batch_index, -1);
}

{
  const original = baseRecord('batch-http-rejected');
  assert.equal(rememberInterruptedDigestBatch(original), true);
  const error = Object.assign(new Error('请求被拒绝'), { status: 400, code: 'invalid_request' });
  assert.deepEqual(finalizeInterruptedDigestBatchRecord(error, { batchId: original.batch_id }), {
    retained: false,
    forgotten: true,
    phase: '',
  });
  assert.equal(record(original.batch_id), null, '明确 HTTP 拒绝允许删除恢复记录');
}

{
  const original = baseRecord('batch-user-cancelled');
  assert.equal(rememberInterruptedDigestBatch(original), true);
  const error = Object.assign(new Error('用户取消'), { name: 'AbortError', status: 499 });
  const disposition = finalizeInterruptedDigestBatchRecord(error, { batchId: original.batch_id });
  assert.equal(disposition.forgotten, true);
  assert.equal(record(original.batch_id), null, '显式取消允许删除恢复记录');
}

console.log('web digest record lifecycle tests passed');
