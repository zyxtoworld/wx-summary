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

globalThis.location = new URL('http://wx-summary.test/#/settings');
globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage();

const loader = createBrowserModuleLoader();
const recovery = await loader.load('js/shared/settings-mutation-recovery.js');
const {
  createSettingsWriteCoordinator,
  requireSettingsWriteResult,
  writeSettingsPatch,
} = await loader.load('js/shared/settings-write-coordinator.js');
const {
  saveWizardSettings,
  syncWizardStateFromSettingsResponse,
} = await loader.load('js/pages/setup/state.js');
const settingsMarkerPrefix = recovery.pendingSettingsMutationStoragePrefix;

for (const malformed of [
  { settings: {}, settings_revision: 'outer-revision' },
  { settings: { settings_revision: 'inner-revision' }, settings_revision: 'outer-revision' },
  { settings: { settings_revision: 'inner-revision' }, settings_revision: '' },
]) {
  const wiz = {
    settings: { settings_revision: 'current-revision', llm: { model: 'current-model' } },
    baseRevision: 'current-revision',
  };
  assert.throws(
    () => syncWizardStateFromSettingsResponse(wiz, malformed),
    error => error?.code === 'invalid_settings_document' && error?.status === 502,
    '携带 settings 的响应必须让顶层与文档 revision 完整一致',
  );
  assert.equal(wiz.settings.llm.model, 'current-model',
    '畸形 settings envelope 不得覆盖当前向导设置');
  assert.equal(wiz.baseRevision, 'current-revision',
    '畸形 settings envelope 不得覆盖当前 revision');
}

{
  const settings = { settings_revision: 'next-revision', llm: { model: 'next-model' } };
  const wiz = { settings: null, baseRevision: '' };
  syncWizardStateFromSettingsResponse(wiz, {
    settings,
    settings_revision: 'next-revision',
  });
  assert.strictEqual(wiz.settings, settings, '合法 settings envelope 必须采用同一文档');
  assert.equal(wiz.baseRevision, 'next-revision');
}

const validWriteResult = {
  ok: true,
  settings: { settings_revision: 'rev-valid' },
  settings_revision: 'rev-valid',
};
assert.equal(requireSettingsWriteResult(validWriteResult), validWriteResult,
  '共享设置写合同必须接受后端的完整成功响应');
for (const malformed of [
  null,
  {},
  { ok: false, settings: { settings_revision: 'rev-valid' }, settings_revision: 'rev-valid' },
  { ok: true, settings: null, settings_revision: 'rev-valid' },
  { ok: true, settings: {}, settings_revision: '' },
  { ok: true, settings: { settings_revision: 'rev-a' }, settings_revision: 'rev-b' },
]) {
  assert.throws(
    () => requireSettingsWriteResult(malformed),
    error => error?.code === 'settings_write_response_invalid'
      && error?.outcomeUnknown === true
      && error?.status === 502,
    '提交后的畸形响应必须统一投影为结果未知，不能被调用方当作成功',
  );
}

const mutationId = recovery.beginPendingSettingsMutation('设置保存');
assert.match(mutationId, /^settings-/);
assert.equal(recovery.readPendingSettingsMutationRecords().length, 1,
  '提交前必须持久化一条不含设置 payload 的恢复标记');

const staleMarkerKey = `${settingsMarkerPrefix}settings-stale-version`;
const mismatchedMarkerKey = `${settingsMarkerPrefix}settings-mismatched-key`;
const malformedMarkerKey = `${settingsMarkerPrefix}settings-malformed-json`;
globalThis.localStorage.setItem(staleMarkerKey, JSON.stringify({
  version: 0,
  id: 'settings-stale-version',
  label: '旧版本',
  created_at: Date.now(),
}));
globalThis.localStorage.setItem(mismatchedMarkerKey, JSON.stringify({
  version: 1,
  id: 'settings-other-key',
  label: 'key 不一致',
  created_at: Date.now(),
}));
globalThis.localStorage.setItem(malformedMarkerKey, '{not-json');
assert.doesNotThrow(
  () => recovery.readPendingSettingsMutationRecords(),
  '无效 marker 不得让整个设置恢复读取失败',
);
assert.equal(globalThis.localStorage.getItem(staleMarkerKey), null,
  '旧版本设置 marker 必须回收精确 key');
assert.equal(globalThis.localStorage.getItem(mismatchedMarkerKey), null,
  'key 不一致的设置 marker 必须回收精确 key');
assert.equal(globalThis.localStorage.getItem(malformedMarkerKey), null,
  '坏 JSON 设置 marker 必须回收精确 key');

// 读取 marker 不是“尽力而为”：枚举后读取失败必须保留 507 合同，
// 不能把未确认的恢复记录当成已恢复或已清理。
{
  const previousStorage = globalThis.localStorage;
  const backingStorage = new MemoryStorage();
  const key = `${settingsMarkerPrefix}settings-reader-get-failure`;
  const serialized = JSON.stringify({
    version: 1,
    id: 'settings-reader-get-failure',
    label: '读取失败',
    created_at: Date.now(),
  });
  backingStorage.setItem(key, serialized);
  globalThis.localStorage = {
    get length() { return backingStorage.length; },
    key(index) { return backingStorage.key(index); },
    getItem() { throw new Error('reader get denied'); },
    setItem(name, value) { backingStorage.setItem(name, value); },
    removeItem(name) { backingStorage.removeItem(name); },
  };
  try {
    assert.throws(
      () => recovery.readPendingSettingsMutationRecords(),
      error => error?.code === 'settings_recovery_storage_unavailable' && error?.status === 507,
      '枚举到 marker 但 getItem 失败时必须保留 507 恢复存储错误',
    );
    assert.equal(backingStorage.getItem(key), serialized,
      'getItem 失败时不得报告 marker 已恢复或清理');
  } finally {
    globalThis.localStorage = previousStorage;
  }
}

{
  const previousStorage = globalThis.localStorage;
  const backingStorage = new MemoryStorage();
  const key = `${settingsMarkerPrefix}settings-reader-remove-failure`;
  const malformed = '{not-json';
  backingStorage.setItem(key, malformed);
  globalThis.localStorage = {
    get length() { return backingStorage.length; },
    key(index) { return backingStorage.key(index); },
    getItem(name) { return backingStorage.getItem(name); },
    setItem(name, value) { backingStorage.setItem(name, value); },
    removeItem() { throw new Error('reader remove denied'); },
  };
  try {
    assert.throws(
      () => recovery.readPendingSettingsMutationRecords(),
      error => error?.code === 'settings_recovery_storage_unavailable' && error?.status === 507,
      '无效 marker 清理失败时必须保留 507 恢复存储错误',
    );
    assert.equal(backingStorage.getItem(key), malformed,
      'removeItem 失败时不得报告无效 marker 已清理');
  } finally {
    globalThis.localStorage = previousStorage;
  }
}

recovery.completePendingSettingsMutationAfterError(mutationId, { outcomeUnknown: true });
assert.equal(recovery.readPendingSettingsMutationRecords().length, 1,
  '结果未知时必须保留 marker，防止刷新后重复写入');

recovery.completePendingSettingsMutationAfterError(mutationId, { status: 400, code: 'validation_failed' });
assert.equal(recovery.readPendingSettingsMutationRecords().length, 0,
  '明确 HTTP 拒绝时才可以清理 marker');

const confirmedId = recovery.beginPendingSettingsMutation('确认保存');
recovery.completePendingSettingsMutationAfterResponse(confirmedId);
assert.equal(recovery.readPendingSettingsMutationRecords().length, 0,
  '明确响应后必须清理 marker');

const pendingA = recovery.beginPendingSettingsMutation('刷新恢复 A');
const pendingB = recovery.beginPendingSettingsMutation('刷新恢复 B');
const order = [];
let applied = null;
const restored = await recovery.restorePendingSettingsMutationRecovery({
  api: {
    async get(path) {
      order.push(path);
      return { settings_revision: 'rev-after-writes', llm: { model: 'auto' } };
    },
  },
  applySettings(settings) { applied = settings; },
});
assert.deepEqual(order, ['/api/settings?wait_for_writes=1'],
  '启动恢复必须先等待服务端串行写入再读取权威设置');
assert.equal(restored.cleared, 2);
assert.equal(applied.settings_revision, 'rev-after-writes');
assert.equal(recovery.readPendingSettingsMutationRecords().length, 0,
  '成功核对权威设置后必须清理全部已恢复 marker');

// 恢复旧 marker 等待服务端时，另一标签可能已经登记新的设置写入。
// 旧恢复只能清理自己启动时看到的 marker，不能把新写入的恢复线索一并删掉。
const raceOld = recovery.beginPendingSettingsMutation('并发恢复旧写入');
let resolveRaceSettings;
const raceRecovery = recovery.restorePendingSettingsMutationRecovery({
  api: {
    get() {
      return new Promise(resolve => { resolveRaceSettings = resolve; });
    },
  },
});
await Promise.resolve();
const raceNew = recovery.beginPendingSettingsMutation('并发恢复新写入');
resolveRaceSettings({ settings_revision: 'rev-race', llm: { model: 'auto' } });
const raceResult = await raceRecovery;
assert.equal(raceResult.pending, 1,
  '并发恢复应只统计启动时捕获的旧 marker');
assert.equal(raceResult.cleared, 1,
  '并发恢复应只清理启动时捕获的旧 marker');
const remainingRaceMarkers = recovery.readPendingSettingsMutationRecords();
assert.equal(remainingRaceMarkers.some(item => item.id === raceOld), false,
  '旧恢复 marker 应在权威文档采用后清理');
assert.equal(remainingRaceMarkers.some(item => item.id === raceNew), true,
  '恢复等待期间新建的 marker 不得被旧恢复流程删除');
recovery.clearPendingSettingsMutationRecords();

// 页面卸载/账号生命周期取消后，API 可能忽略 abort 并晚到；旧恢复不得再
// 把设置写入向导对象，也不得清掉这次尚未核对的 marker。
{
  const lateMarker = recovery.beginPendingSettingsMutation('卸载中的恢复');
  const controller = new AbortController();
  let resolveLateSettings;
  let applyCalls = 0;
  const lateRecovery = recovery.restorePendingSettingsMutationRecovery({
    signal: controller.signal,
    api: {
      get() {
        return new Promise(resolve => { resolveLateSettings = resolve; });
      },
    },
    applySettings() { applyCalls += 1; },
  });
  await Promise.resolve();
  controller.abort(new Error('页面已卸载'));
  resolveLateSettings({ settings_revision: 'rev-late-after-abort', llm: { model: 'late' } });
  const lateResult = await lateRecovery;
  assert.equal(lateResult.cancelled, true,
    '恢复请求被页面 signal 取消后必须显式返回 cancelled');
  assert.equal(applyCalls, 0,
    '页面 signal 已取消时晚到设置不得再写入向导/页面状态');
  assert.equal(recovery.readPendingSettingsMutationRecords().some(item => item.id === lateMarker), true,
    '页面 signal 已取消时不得清理仍需核对的恢复 marker');
  recovery.forgetPendingSettingsMutation(lateMarker);
}

const stillPending = recovery.beginPendingSettingsMutation('恢复失败');
await assert.rejects(
  recovery.restorePendingSettingsMutationRecovery({
    api: { async get() { throw Object.assign(new Error('断连'), { outcomeUnknown: true }); } },
  }),
  /断连/,
  '权威恢复读取失败时必须保留 marker 并把错误交给页面显示',
);
assert.equal(recovery.readPendingSettingsMutationRecords().some(item => item.id === stillPending), true);

let malformedRecoveryApplyCalls = 0;
await assert.rejects(
  recovery.restorePendingSettingsMutationRecovery({
    api: { async get() { return {}; } },
    applySettings() { malformedRecoveryApplyCalls += 1; },
  }),
  error => error?.code === 'invalid_settings_document' && error?.status === 502,
  '200+空对象不得被当作权威设置并清除待恢复 marker',
);
assert.equal(malformedRecoveryApplyCalls, 0,
  '畸形设置恢复响应不得进入 applySettings');
assert.equal(recovery.readPendingSettingsMutationRecords().some(item => item.id === stillPending), true,
  '畸形设置恢复响应后必须保留原 marker 供下次核对');
recovery.clearPendingSettingsMutationRecords();

{
  const coordinator = createSettingsWriteCoordinator({ locks: null });
  const unknownApi = {
    async get() { return { settings_revision: 'rev-unknown' }; },
    async request() { throw Object.assign(new Error('写入后断连'), { outcomeUnknown: true }); },
  };
  await assert.rejects(
    writeSettingsPatch({ api: unknownApi, patch: { llm: { model: 'auto' } }, coordinator }),
    error => error?.outcomeUnknown === true,
  );
  assert.equal(recovery.readPendingSettingsMutationRecords().length, 1,
    '协调器提交后结果未知时必须让页面刷新仍能发现 marker');
  recovery.clearPendingSettingsMutationRecords();
}

{
  const wiz = {
    baseRevision: 'rev-before-malformed',
    settings: { settings_revision: 'rev-before-malformed', llm: { model: 'auto' } },
    llm: { saved: false },
  };
  const malformedApi = {
    async get(path) {
      assert.equal(path, '/api/settings?wait_for_writes=1');
      return { settings_revision: 'rev-before-malformed', llm: { model: 'auto' } };
    },
    async request(path, options) {
      assert.equal(path, '/api/settings');
      assert.equal(options.body.base_settings_revision, 'rev-before-malformed');
      return null;
    },
  };
  let failure = null;
  try {
    await saveWizardSettings({ api: malformedApi }, wiz, { llm: { model: 'auto' } });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, 'settings_write_response_invalid',
    'PUT 200 + null 必须由共享写路径按固定合同拒绝，不能返回给向导当作成功');
  assert.equal(failure?.outcomeUnknown, true,
    '畸形成功响应发生在提交之后，必须保留结果未知语义');
  assert.equal(wiz.llm.saved, false, '向导调用链不得把畸形响应后的步骤标为已保存');
  assert.equal(recovery.readPendingSettingsMutationRecords().length, 1,
    '畸形成功响应不得清理恢复 marker，避免用户立即重复提交');
  recovery.clearPendingSettingsMutationRecords();
}

for (const failingStorage of [
  { setItem() { throw new Error('quota'); }, getItem() { return null; }, removeItem() {}, key() { return null; }, length: 0 },
  { setItem() {}, getItem() { return null; }, removeItem() {}, key() { return null; }, length: 0 },
]) {
  globalThis.localStorage = failingStorage;
  assert.throws(
    () => recovery.beginPendingSettingsMutation('不可提交'),
    error => error?.code === 'settings_recovery_storage_unavailable' && /尚未发送/.test(error.message),
    'marker 无法写入并回读时必须在请求发送前失败',
  );
}

console.log('web settings mutation recovery tests passed');
