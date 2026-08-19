import assert from 'node:assert/strict';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

class MemoryStorage {
  #values = new Map();
  getItem(key) { return this.#values.get(String(key)) ?? null; }
  setItem(key, value) { this.#values.set(String(key), String(value)); }
  removeItem(key) { this.#values.delete(String(key)); }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function createExclusiveLocks() {
  let busy = false;
  return {
    request(name, options, callback) {
      assert.equal(options.ifAvailable, true);
      if (busy) return Promise.resolve(callback(null));
      busy = true;
      return Promise.resolve(callback({ name })).finally(() => { busy = false; });
    },
  };
}

const localStorage = new MemoryStorage();
const sessionStorage = new MemoryStorage();
globalThis.location = new URL('http://wx-summary.test/#/digest');
globalThis.localStorage = localStorage;
globalThis.sessionStorage = sessionStorage;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { locks: null },
});

const loader = createBrowserModuleLoader();
const {
  createInterruptedDigestRecoveryRunner,
  digestTerminalResultRequest,
  interruptedDigestRenderSelection,
  interruptedDigestBatchMatchesAccount,
  interruptedDigestBatchStorageKey,
  readInterruptedDigestBatchRecords,
  selectInterruptedDigestBatchRecord,
  subscribeInterruptedDigestRecoveryChanges,
  createDigestRecoveryOwner,
} = await loader.load('js/pages/digest/recovery.js');

const identity = {
  accountId: 'account-a',
  accountFingerprint: 'a'.repeat(64),
};
const validRecord = {
  version: 5,
  batch_id: 'batch-account-a',
  batch_token: 'token-account-a-123456',
  service_instance_id: 'service-instance-1234',
  account_id: identity.accountId,
  account_fingerprint: identity.accountFingerprint,
  preview_text: false,
  targets: [{ group_id: 'group-a' }],
  started_at: Date.now() - 1000,
  updated_at: Date.now(),
};

assert.equal(interruptedDigestBatchMatchesAccount(validRecord, identity), true);
assert.equal(interruptedDigestBatchMatchesAccount(
  { ...validRecord, account_id: 'account-b' },
  identity,
), false, '其他账号 ID 的恢复记录绝不能进入当前页面');
assert.equal(interruptedDigestBatchMatchesAccount(
  { ...validRecord, account_fingerprint: 'b'.repeat(64) },
  identity,
), false, '旧数据库指纹的恢复记录绝不能绑定当前账号');
assert.equal(interruptedDigestBatchMatchesAccount(
  { ...validRecord, account_fingerprint: '' },
  identity,
), false, '缺少指纹时必须 fail-closed');
assert.equal(interruptedDigestBatchMatchesAccount(
  { ...validRecord, account_id: '' },
  identity,
), false, '缺少账号 ID 时必须 fail-closed');

{
  let currentIdentity = identity;
  const action = Object.freeze({ batchId: validRecord.batch_id, kind: 'recover' });
  const owner = createDigestRecoveryOwner({
    action,
    isCurrentAction: candidate => candidate === action,
    getIdentity: () => currentIdentity,
    isDestroyed: () => false,
    record: validRecord,
  });
  assert.equal(owner.isCurrent(), true, '恢复开始时必须持有原账号 owner');
  currentIdentity = { accountId: 'account-b', accountFingerprint: 'b'.repeat(64) };
  let committed = 0;
  await Promise.resolve().then(() => {
    if (owner.isCurrent()) committed += 1;
  });
  assert.equal(committed, 0, 'A 恢复请求晚到时,账号已切到 B 不得提交 A 的结果');
}

assert.equal(selectInterruptedDigestBatchRecord([
  { ...validRecord, account_fingerprint: 'b'.repeat(64) },
  validRecord,
], identity), validRecord);

assert.deepEqual(digestTerminalResultRequest(validRecord, {
  batch_index: 2,
  batch_total: 4,
  account_id: identity.accountId,
  group_id: 'group-a',
}), {
  batch_id: validRecord.batch_id,
  batch_token: validRecord.batch_token,
  service_instance_id: validRecord.service_instance_id,
  batch_index: 2,
  batch_total: 4,
  account_id: identity.accountId,
  expected_account_fingerprint: identity.accountFingerprint,
  group_id: 'group-a',
}, '终态恢复请求必须绑定原批次、索引、账号指纹和群 ID');

assert.deepEqual(interruptedDigestRenderSelection({
  render: { theme: 'dark', fontSize: 'large', accentColor: '#112233' },
}, { theme: 'auto', fontSize: 'normal' }), {
  theme: 'dark',
  fontSize: 'large',
  accentColor: '#112233',
  rendererVersion: 1,
  rendererEngine: 'browser_canvas',
}, '恢复时必须使用批次冻结的渲染选择');

const storageKey = interruptedDigestBatchStorageKey(globalThis.location.origin);
localStorage.setItem(storageKey, JSON.stringify({
  version: 5,
  records: [{ ...validRecord, account_id: '' }, validRecord],
}));
assert.deepEqual(readInterruptedDigestBatchRecords().map(record => record.batch_id), [validRecord.batch_id],
  '存储读取时就必须丢弃缺少账号身份的记录');

{
  const listeners = new Map();
  const storageTarget = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  let accountListener = null;
  let accountUnsubscribed = false;
  const changes = [];
  const unsubscribe = subscribeInterruptedDigestRecoveryChanges({
    storageTarget,
    storageKey,
    subscribeAccount(listener) {
      accountListener = listener;
      return () => { accountUnsubscribed = true; accountListener = null; };
    },
    onChange: source => changes.push(source),
  });

  listeners.get('storage')?.({ key: 'unrelated' });
  listeners.get('storage')?.({ key: storageKey });
  listeners.get('storage')?.({ key: null });
  accountListener?.();
  assert.deepEqual(changes, ['storage', 'storage', 'account'],
    '具体键和 clear() 产生的跨标签存储变化都必须重新选择恢复记录');
  unsubscribe();
  assert.equal(accountUnsubscribed, true);
  assert.equal(listeners.has('storage'), false, '页面卸载后不得残留恢复监听器');
}

{
  const locks = createExclusiveLocks();
  let records = [validRecord];
  const firstRunner = createInterruptedDigestRecoveryRunner({ locks, readRecords: () => records });
  const secondRunner = createInterruptedDigestRecoveryRunner({ locks, readRecords: () => records });
  const started = deferred();
  const finish = deferred();
  let duplicateRuns = 0;

  const first = firstRunner.run(validRecord.batch_id, {
    getIdentity: () => identity,
    recover: async lockedRecord => {
      assert.equal(lockedRecord.batch_token, validRecord.batch_token);
      started.resolve();
      await finish.promise;
      records = [];
      return 'recovered';
    },
  });
  await started.promise;
  const second = await secondRunner.run(validRecord.batch_id, {
    getIdentity: () => identity,
    recover: async () => { duplicateRuns += 1; },
  });
  assert.equal(second.ran, false);
  assert.equal(second.busy, true, '另一标签持锁时必须报告忙且不重复恢复');
  finish.resolve();
  assert.deepEqual(await first, {
    ran: true,
    coordinated: true,
    value: 'recovered',
  });
  assert.equal(duplicateRuns, 0);

  const staleAfterLock = await secondRunner.run(validRecord.batch_id, {
    getIdentity: () => identity,
    recover: async () => { duplicateRuns += 1; },
  });
  assert.equal(staleAfterLock.ran, false, '拿锁后必须重读记录，已被其他标签消费时不得执行');
  assert.equal(duplicateRuns, 0);
}

{
  const releaseLock = deferred();
  const locks = {
    request(_name, _options, callback) {
      return releaseLock.promise.then(() => callback({ name: 'delayed' }));
    },
  };
  let currentIdentity = identity;
  let records = [validRecord];
  let recoveredToken = '';
  const runner = createInterruptedDigestRecoveryRunner({ locks, readRecords: () => records });
  const pending = runner.run(validRecord.batch_id, {
    getIdentity: () => currentIdentity,
    recover: async record => { recoveredToken = record.batch_token; },
  });
  records = [{ ...validRecord, batch_token: 'fresh-token-after-lock' }];
  currentIdentity = { accountId: 'account-b', accountFingerprint: 'b'.repeat(64) };
  releaseLock.resolve();
  const outcome = await pending;
  assert.equal(outcome.ran, false, '账号在拿锁前变化时必须停止恢复');
  assert.equal(recoveredToken, '');
}

console.log('web digest recovery isolation tests passed');
