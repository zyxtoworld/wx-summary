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
const { createSettingsWriteCoordinator, writeSettingsPatch } = await loader.load('js/shared/settings-write-coordinator.js');

const pendingId = recovery.beginPendingSettingsMutation('设置保存');
assert.match(pendingId, /^settings-/);
assert.equal(recovery.readPendingSettingsMutationRecords().length, 1,
  'side-effecting settings writes must leave a reload marker before submission');
recovery.completePendingSettingsMutationAfterError(pendingId, { outcomeUnknown: true });
assert.equal(recovery.readPendingSettingsMutationRecords().length, 1,
  'unknown settings outcomes must remain recoverable after reload');
recovery.completePendingSettingsMutationAfterError(pendingId, { status: 409, code: 'revision_conflict' });
assert.equal(recovery.readPendingSettingsMutationRecords().length, 0,
  'a confirmed HTTP rejection may clear the marker');

const confirmedId = recovery.beginPendingSettingsMutation('confirmed');
recovery.completePendingSettingsMutationAfterResponse(confirmedId);
assert.equal(recovery.readPendingSettingsMutationRecords().length, 0);

const coordinator = createSettingsWriteCoordinator({ locks: null });
const calls = [];
const api = {
  async get(path) {
    calls.push(`get:${path}`);
    return { settings_revision: 'rev-1' };
  },
  async request(path, options) {
    calls.push(`put:${path}:${options.body.base_settings_revision}`);
    return {
      ok: true,
      settings: { settings_revision: 'rev-2' },
      settings_revision: 'rev-2',
    };
  },
};
const result = await writeSettingsPatch({
  api,
  patch: { llm: { model: 'auto' } },
  coordinator,
});
assert.equal(result.settings_revision, 'rev-2');
assert.deepEqual(calls, [
  'get:/api/settings?wait_for_writes=1',
  'put:/api/settings:rev-1',
], 'the coordinator must read the latest revision immediately before PUT');
assert.equal(recovery.readPendingSettingsMutationRecords().length, 0,
  'a definitive response must clear the recoverable marker');

const unknownApi = {
  async get() { return { settings_revision: 'rev-3' }; },
  async request() { throw Object.assign(new Error('写入后断连'), { outcomeUnknown: true }); },
};
await assert.rejects(
  writeSettingsPatch({ api: unknownApi, patch: { output: { retention_days: 30 } }, coordinator }),
  error => error?.outcomeUnknown === true,
);
assert.equal(recovery.readPendingSettingsMutationRecords().length, 1,
  'a write that may have reached the service must remain marked after the response is unknown');
recovery.clearPendingSettingsMutationRecords();

for (const failingStorage of [
  { setItem() { throw new Error('quota'); }, getItem() { return null; }, removeItem() {}, key() { return null; }, length: 0 },
  { setItem() {}, getItem() { return null; }, removeItem() {}, key() { return null; }, length: 0 },
]) {
  globalThis.localStorage = failingStorage;
  assert.throws(
    () => recovery.beginPendingSettingsMutation('不可提交'),
    error => error?.code === 'settings_recovery_storage_unavailable' && /尚未发送/.test(error.message),
    'storage preflight failures must stop a settings mutation before the network request',
  );
}

console.log('settings interrupted-write recovery contract passed');
