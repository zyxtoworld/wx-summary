import assert from 'node:assert/strict';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

class MemoryStorage {
  #values = new Map();

  getItem(key) { return this.#values.get(String(key)) ?? null; }
  setItem(key, value) { this.#values.set(String(key), String(value)); }
}

globalThis.location = new URL('http://wx-summary.test/');
globalThis.history = { state: null, replaceState() {} };
globalThis.document = { title: '' };
globalThis.sessionStorage = new MemoryStorage();
globalThis.localStorage = new MemoryStorage();

const loader = createBrowserModuleLoader();
const session = await loader.load('js/session.js');
const { createApi } = await loader.load('js/api.js');
const { createAssetReloadCoordinator } = await loader.load('js/asset-reload.js');

session.rememberSessionToken('asset-trigger-session');

function deferred() {
  let resolve;
  const promise = new Promise(nextResolve => { resolve = nextResolve; });
  return { promise, resolve };
}

const stateGate = deferred();
const calls = [];
let scheduled = 0;
const storage = new MemoryStorage();
let api = null;
const reload = createAssetReloadCoordinator({
  assetVersion: 'asset-client',
  readState: () => api.get('/api/state'),
  storage,
  showRestartRequiredNotice() { throw new Error('unexpected restart notice'); },
  showReloadScheduledNotice() { calls.push('scheduled-notice'); },
  showManualReloadNotice() { throw new Error('unexpected manual notice'); },
  scheduleReload() { scheduled += 1; },
});

api = createApi({
  assetVersion: 'asset-client',
  onStaleAsset() { void reload(); },
});

globalThis.fetch = async path => {
  calls.push(String(path));
  if (String(path) === '/api/state') return stateGate.promise;
  return new Response(JSON.stringify({
    ok: false,
    code: 'stale_frontend_asset',
    error: '页面资源已过期',
  }), { status: 409, headers: { 'content-type': 'application/json' } });
};

const first = api.get('/api/stale-one');
const second = api.get('/api/stale-two');
await Promise.all([
  assert.rejects(first, error => error?.status === 409 && error?.code === 'stale_frontend_asset'),
  assert.rejects(second, error => error?.status === 409 && error?.code === 'stale_frontend_asset'),
]);
assert.equal(calls.filter(path => path === '/api/state').length, 1,
  '并发版本错误必须由资源恢复协调器合并为一次 state 读取');
assert.equal(scheduled, 0, '版本事实尚未返回时不得提前安排重载');

stateGate.resolve(new Response(JSON.stringify({
  asset_version: 'asset-client',
  source_asset_version: 'asset-client',
}), { status: 200, headers: { 'content-type': 'application/json' } }));
await new Promise(resolve => setImmediate(resolve));
assert.equal(scheduled, 1, '当前资源版本确认后必须只安排一次重载');
assert.equal(storage.getItem('wx-summary:asset-reload:asset-client'), 'asset-client');
assert.equal(calls.filter(path => path === 'scheduled-notice').length, 1);

await api.get('/api/stale-three').catch(error => {
  assert.equal(error?.code, 'stale_frontend_asset');
});
await new Promise(resolve => setImmediate(resolve));
assert.equal(calls.filter(path => path === '/api/state').length, 1,
  '已安排重载后的迟到版本错误不得重新读取或重复安排');
assert.equal(scheduled, 1);

console.log('web asset reload API trigger tests passed');
