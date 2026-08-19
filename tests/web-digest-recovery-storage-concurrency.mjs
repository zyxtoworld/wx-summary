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
const storage = new MemoryStorage();
globalThis.localStorage = storage;
globalThis.sessionStorage = new MemoryStorage();

const loader = createBrowserModuleLoader();
const {
  readInterruptedDigestBatchRecords,
  forgetInterruptedDigestBatch,
  rememberInterruptedDigestBatch,
} = await loader.load('js/pages/digest/recovery.js');

const accountFingerprint = 'a'.repeat(64);
const record = batchId => ({
  batch_id: batchId,
  batch_token: `token-${batchId}-123456789`,
  service_instance_id: 'service-instance-1234',
  account_id: 'recovery-storage-account',
  account_fingerprint: accountFingerprint,
  started_at: Date.now(),
  targets: [{ group_id: `group-${batchId}`, group_name: '测试群', since: '2026-01-01', until: '2026-01-02' }],
});
const recordKey = batchId =>
  `wx-summary:interrupted-digest-batch:http://wx-summary.test:record:${encodeURIComponent(batchId)}`;

const first = record('batch-concurrent-a');
const second = record('batch-concurrent-b');
let nested = false;
const originalSetItem = storage.setItem.bind(storage);
storage.setItem = (key, value) => {
  const parsed = JSON.parse(String(value));
  const firstKey = recordKey(first.batch_id);
  if (!nested
    && String(key) === firstKey
    && parsed?.record?.batch_id === first.batch_id) {
    nested = true;
    assert.equal(rememberInterruptedDigestBatch(second), true,
      '交错写入的第二个恢复记录本身必须成功');
    nested = false;
  }
  originalSetItem(key, value);
};

assert.equal(rememberInterruptedDigestBatch(first), true);
const records = readInterruptedDigestBatchRecords();
assert.ok(records.some(item => item.batch_id === first.batch_id), '第一个恢复记录必须保留');
assert.ok(records.some(item => item.batch_id === second.batch_id),
  '跨标签交错写入不同 batch 时不得丢失第二个恢复记录');

const legacy = record('batch-legacy-tombstone');
storage.setItem(
  'wx-summary:interrupted-digest-batch:http://wx-summary.test',
  JSON.stringify({ version: 5, records: [legacy] }),
);
assert.equal(forgetInterruptedDigestBatch(legacy.batch_id), true,
  '删除旧聚合 key 中的记录必须写入该 batch 的精确 tombstone');
assert.equal(
  readInterruptedDigestBatchRecords().some(item => item.batch_id === legacy.batch_id),
  false,
  '精确 tombstone 不得让旧聚合记录复活',
);

const expired = {
  ...record('batch-expired-record'),
  started_at: Date.now() - (2 * 60 * 60 * 1000 + 1),
  updated_at: Date.now() - (2 * 60 * 60 * 1000 + 1),
};
const expiredKey = recordKey(expired.batch_id);
originalSetItem(expiredKey, JSON.stringify({ version: 5, record: expired }));

const oldVersion = record('batch-old-version-record');
const oldVersionKey = recordKey(oldVersion.batch_id);
originalSetItem(oldVersionKey, JSON.stringify({ version: 4, record: oldVersion }));

const afterInvalidRecords = readInterruptedDigestBatchRecords();
assert.equal(
  afterInvalidRecords.some(item => item.batch_id === expired.batch_id),
  false,
  '过期普通恢复记录不得返回',
);
assert.equal(storage.getItem(expiredKey), null,
  '过期普通恢复记录的精确物理 key 必须回收');
assert.equal(
  afterInvalidRecords.some(item => item.batch_id === oldVersion.batch_id),
  false,
  '旧版本恢复记录不得返回',
);
assert.equal(storage.getItem(oldVersionKey), null,
  '旧版本恢复记录的精确物理 key 必须回收');

const missingUpdatedAt = record('batch-missing-tombstone-time');
const invalidUpdatedAt = record('batch-invalid-tombstone-time');
originalSetItem(
  'wx-summary:interrupted-digest-batch:http://wx-summary.test',
  JSON.stringify({ version: 5, records: [missingUpdatedAt, invalidUpdatedAt] }),
);
const missingUpdatedAtKey = recordKey(missingUpdatedAt.batch_id);
const invalidUpdatedAtKey = recordKey(invalidUpdatedAt.batch_id);
originalSetItem(missingUpdatedAtKey, JSON.stringify({
  version: 5,
  batch_id: missingUpdatedAt.batch_id,
  deleted: true,
}));
originalSetItem(invalidUpdatedAtKey, JSON.stringify({
  version: 5,
  batch_id: invalidUpdatedAt.batch_id,
  deleted: true,
  updated_at: 'not-a-number',
}));

const afterInvalidTombstones = readInterruptedDigestBatchRecords();
assert.ok(
  afterInvalidTombstones.some(item => item.batch_id === missingUpdatedAt.batch_id),
  '缺失 updated_at 的 tombstone 不得永久隐藏旧记录');
assert.ok(
  afterInvalidTombstones.some(item => item.batch_id === invalidUpdatedAt.batch_id),
  '非法 updated_at 的 tombstone 不得永久隐藏旧记录');
assert.equal(storage.getItem(missingUpdatedAtKey), null,
  '缺失 updated_at 的 tombstone 必须回收精确 key');
assert.equal(storage.getItem(invalidUpdatedAtKey), null,
  '非法 updated_at 的 tombstone 必须回收精确 key');

// 恢复记录不是尽力读取：枚举后的 get/remove 失败必须保留明确存储错误，
// 不能把尚未确认的恢复记录静默当成空列表。
{
  const previousStorage = globalThis.localStorage;
  const backing = new MemoryStorage();
  const key = recordKey('batch-recovery-reader-get-failure');
  const serialized = JSON.stringify({ version: 5, record: record('batch-recovery-reader-get-failure') });
  backing.setItem(key, serialized);
  globalThis.localStorage = {
    get length() { return backing.length; },
    key(index) { return backing.key(index); },
    getItem() { throw new Error('recovery reader get denied'); },
    setItem(name, value) { backing.setItem(name, value); },
    removeItem(name) { backing.removeItem(name); },
  };
  try {
    assert.throws(
      () => readInterruptedDigestBatchRecords(),
      error => error?.code === 'digest_recovery_storage_unavailable' && error?.status === 507,
      '恢复 marker getItem 失败时必须保留明确 507 存储错误',
    );
    assert.equal(backing.getItem(key), serialized,
      '恢复 marker getItem 失败时不得报告已读取或清理');
  } finally {
    globalThis.localStorage = previousStorage;
  }
}

{
  const previousStorage = globalThis.localStorage;
  const backing = new MemoryStorage();
  const key = recordKey('batch-recovery-reader-remove-failure');
  const malformed = '{not-json';
  backing.setItem(key, malformed);
  globalThis.localStorage = {
    get length() { return backing.length; },
    key(index) { return backing.key(index); },
    getItem(name) { return backing.getItem(name); },
    setItem(name, value) { backing.setItem(name, value); },
    removeItem() { throw new Error('recovery reader remove denied'); },
  };
  try {
    assert.throws(
      () => readInterruptedDigestBatchRecords(),
      error => error?.code === 'digest_recovery_storage_unavailable' && error?.status === 507,
      '无效恢复 marker 清理失败时必须保留明确 507 存储错误',
    );
    assert.equal(backing.getItem(key), malformed,
      '无效恢复 marker 清理失败时不得报告已清理');
  } finally {
    globalThis.localStorage = previousStorage;
  }
}

// 按 batch 清理必须把两个存储层都清掉；sessionStorage 清理失败时不能
// 报告成功，否则本地 tombstone 过期后旧记录会复活，且调用方失去重试机会。
{
  const previousLocalStorage = globalThis.localStorage;
  const previousSessionStorage = globalThis.sessionStorage;
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const batchId = 'batch-session-cleanup-failure';
  const key = recordKey(batchId);
  const serialized = JSON.stringify({ version: 5, record: record(batchId) });
  session.setItem(key, serialized);
  const originalRemoveItem = session.removeItem.bind(session);
  session.removeItem = name => {
    if (String(name) === key) throw new Error('session cleanup denied');
    originalRemoveItem(name);
  };
  globalThis.localStorage = local;
  globalThis.sessionStorage = session;
  try {
    assert.equal(
      forgetInterruptedDigestBatch(batchId),
      false,
      'sessionStorage 清理失败时按 batch 删除必须报告失败并允许重试',
    );
    assert.equal(session.getItem(key), serialized,
      'sessionStorage 清理失败时旧恢复记录必须保留以供重试');

    session.removeItem = originalRemoveItem;
    assert.equal(forgetInterruptedDigestBatch(batchId), true,
      '存储恢复后重试按 batch 删除必须成功');
    assert.equal(session.getItem(key), null,
      '重试成功后 sessionStorage 的精确记录必须删除');
    assert.equal(readInterruptedDigestBatchRecords().some(item => item.batch_id === batchId),
      false,
      '重试成功后旧恢复记录不得再次可见');

    const updateBatchId = 'batch-session-overwrite-failure';
    const updateKey = recordKey(updateBatchId);
    const updateSerialized = JSON.stringify({ version: 5, record: record(updateBatchId) });
    session.setItem(updateKey, updateSerialized);
    session.removeItem = name => {
      if (String(name) === updateKey) throw new Error('session overwrite cleanup denied');
      originalRemoveItem(name);
    };
    assert.equal(
      rememberInterruptedDigestBatch(record(updateBatchId)),
      false,
      'sessionStorage 清理失败时更新恢复记录也必须报告失败',
    );
    assert.equal(session.getItem(updateKey), updateSerialized,
      '更新清理失败时旧 session 恢复记录必须保留以供重试');
  } finally {
    globalThis.localStorage = previousLocalStorage;
    globalThis.sessionStorage = previousSessionStorage;
  }
}

console.log('web digest recovery storage concurrency tests passed');
