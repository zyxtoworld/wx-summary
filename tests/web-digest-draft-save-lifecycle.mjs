import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');
const start = source.indexOf('  function scheduleDraftSave()');
const end = source.indexOf('\n  function resetDraftState()', start);
assert.ok(start >= 0 && end > start, 'digest draft save scheduler must remain inspectable');

let nextTimer = 0;
const callbacks = new Map();
let clearCount = 0;
let saveCount = 0;
let currentAccount = {
  id: 'account-a',
  manual_key_account_fingerprint: 'a'.repeat(64),
};
const context = {
  page: { destroyed: false, draftSaveTimer: null },
  draftScopeLifecycle: { markEdited() {} },
  saveDraft() { saveCount += 1; },
  store: {
    get(key) {
      return key === 'account' ? currentAccount : null;
    },
  },
  digestAccountContextIdentity(account) {
    return `${account?.id || ''}|${account?.manual_key_account_fingerprint || ''}`;
  },
  setTimeout(callback) {
    const id = ++nextTimer;
    callbacks.set(id, callback);
    return id;
  },
  clearTimeout(id) {
    clearCount += 1;
    callbacks.delete(id);
  },
};

vm.runInNewContext(`
${source.slice(start, end)}
globalThis.scheduleDraftSave = scheduleDraftSave;
`, context, { timeout: 1000 });

context.scheduleDraftSave();
const queuedTimer = context.page.draftSaveTimer;
assert.ok(callbacks.has(queuedTimer), 'editing should queue one delayed draft save');
callbacks.get(queuedTimer)();
assert.equal(saveCount, 1, '当前账号的 draft timer 应正常保存');

saveCount = 0;
currentAccount = {
  id: 'account-a',
  manual_key_account_fingerprint: 'a'.repeat(64),
};
context.scheduleDraftSave();
const staleTimer = context.page.draftSaveTimer;
currentAccount = {
  id: 'account-b',
  manual_key_account_fingerprint: 'b'.repeat(64),
};
callbacks.get(staleTimer)();
assert.equal(saveCount, 0, '账号换代后的旧 draft timer 不得把来源账号草稿写入目标账号');

context.page.destroyed = true;
context.scheduleDraftSave();
const destroyedTimer = context.page.draftSaveTimer;
callbacks.get(destroyedTimer)();
assert.equal(saveCount, 0, 'a queued draft callback must not persist after page destruction');
assert.equal(clearCount, 0, '本用例的回调都是已执行 timer,不应伪造额外清理');

// 浏览器可能已经把旧 timer callback 放入事件队列,此时 clearTimeout 不能撤回它。
// 旧 callback 不得夺走新 timer 的 owner,也不得重复保存。
let ownerNextTimer = 0;
const ownerCallbacks = new Map();
let ownerSaveCount = 0;
const ownerContext = {
  page: { destroyed: false, draftSaveTimer: null },
  draftScopeLifecycle: { markEdited() {} },
  saveDraft() { ownerSaveCount += 1; },
  store: { get: key => (key === 'account' ? { id: 'owner-account', manual_key_account_fingerprint: 'owner-fingerprint' } : null) },
  digestAccountContextIdentity: account => `${account?.id || ''}|${account?.manual_key_account_fingerprint || ''}`,
  setTimeout(callback) {
    const id = ++ownerNextTimer;
    ownerCallbacks.set(id, callback);
    return id;
  },
  clearTimeout() {
    // 保留 callback,模拟已经排队而无法撤回的浏览器 timer。
  },
};
vm.runInNewContext(`
${source.slice(start, end)}
globalThis.scheduleDraftSave = scheduleDraftSave;
`, ownerContext, { timeout: 1000 });
ownerContext.scheduleDraftSave();
const oldOwnerTimer = ownerContext.page.draftSaveTimer;
ownerContext.scheduleDraftSave();
const currentOwnerTimer = ownerContext.page.draftSaveTimer;
ownerCallbacks.get(oldOwnerTimer)();
assert.equal(ownerSaveCount, 0, '已排队的旧 draft timer 不得抢先保存新 timer 的草稿');
assert.equal(ownerContext.page.draftSaveTimer, currentOwnerTimer,
  '已排队的旧 draft timer 不得清掉新 timer 的 owner');
ownerCallbacks.get(currentOwnerTimer)();
assert.equal(ownerSaveCount, 1, '新 draft timer 最终应只保存一次');

// 程序化账号换代在草稿持久化失败时会进入 blocked;随后路由卸载仍会调用
// saveDraft() 作为最后一次留档机会,但此时 store 已指向目标账号,不得把来源
// 页面字段写入目标账号的 scope。
const saveStart = source.indexOf('  function saveDraft()');
const saveEnd = source.indexOf('\n  function scheduleDraftSave()', saveStart);
assert.ok(saveStart >= 0 && saveEnd > saveStart, 'digest saveDraft must remain inspectable');
let persistCalls = 0;
const saveContext = {
  page: { accountContextBlocked: true, draftPersistenceFailed: true },
  draftScopeLifecycle: {
    accountIdentity: () => 'account-b|',
    persist() {
      persistCalls += 1;
      return { persisted: true, persistenceFailed: false };
    },
  },
  draftScope: () => 'scope-account-b',
  accountFingerprintOf: () => 'b'.repeat(64),
  store: { get: key => (key === 'account' ? { id: 'account-b' } : null) },
  digestAccountContextIdentity: account => `${account?.id || ''}|${account?.manual_key_account_fingerprint || ''}`,
};
vm.runInNewContext(`
${source.slice(saveStart, saveEnd)}
globalThis.saveDraft = saveDraft;
`, saveContext, { timeout: 1000 });
saveContext.saveDraft();
assert.equal(persistCalls, 0,
  'blocked 账号上下文卸载时不得把旧页面字段持久化到新账号 scope');

const detachedSaveContext = {
  page: { accountContextBlocked: false },
  draftScopeLifecycle: {
    accountIdentity: () => 'account-a|' + 'a'.repeat(64),
    persist() {
      persistCalls += 1;
      return { persisted: true, persistenceFailed: false };
    },
  },
  draftScope: () => 'scope-account-b',
  accountFingerprintOf: () => 'b'.repeat(64),
  store: { get: key => (key === 'account'
    ? { id: 'account-b', manual_key_account_fingerprint: 'b'.repeat(64) }
    : null) },
  digestAccountContextIdentity: account => `${account?.id || ''}|${account?.manual_key_account_fingerprint || ''}`,
};
vm.runInNewContext(`
${source.slice(saveStart, saveEnd)}
globalThis.saveDraft = saveDraft;
`, detachedSaveContext, { timeout: 1000 });
const beforeDetachedPersist = persistCalls;
detachedSaveContext.saveDraft();
assert.equal(persistCalls, beforeDetachedPersist,
  '卸载后账号 owner 已失联时不得把旧页面草稿写入当前账号 scope');

saveContext.page.accountContextBlocked = false;
saveContext.saveDraft();
assert.equal(persistCalls, 1, '非 blocked 页面仍应保留正常卸载留档');

console.log('web digest draft save lifecycle tests passed');
