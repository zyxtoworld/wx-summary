import assert from 'node:assert/strict';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

class MemoryStorage {
  #values = new Map();

  getItem(key) { return this.#values.get(String(key)) ?? null; }
  setItem(key, value) { this.#values.set(String(key), String(value)); }
  removeItem(key) { this.#values.delete(String(key)); }
}

globalThis.location = new URL('http://wx-summary.test/');
globalThis.history = { state: null, replaceState() {} };
globalThis.document = { title: '' };
globalThis.sessionStorage = new MemoryStorage();
globalThis.localStorage = new MemoryStorage();

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const timers = new Map();
let nextTimerId = 0;
let fetchCalls = 0;
globalThis.setTimeout = (callback, delay) => {
  const id = ++nextTimerId;
  timers.set(id, { callback, delay });
  return id;
};
globalThis.clearTimeout = id => { timers.delete(id); };
globalThis.fetch = (_url, { signal } = {}) => {
  fetchCalls += 1;
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    }, { once: true });
  });
};

try {
  const loader = createBrowserModuleLoader();
  const { createApi } = await loader.load('js/api.js');
  const api = createApi({ assetVersion: 'fixture' });
  const pending = api.get('/api/needs-session', { timeoutMs: 25 });
  await new Promise(resolve => realSetTimeout(resolve, 0));

  const apiTimeout = [...timers.values()].find(item => item.delay === 25);
  assert.ok(apiTimeout, 'API 请求必须注册自己的 timeout timer');
  apiTimeout.callback();
  await assert.rejects(
    pending,
    error => error?.status === 504 && error?.code === 'api_timeout',
    '会话尚未建立时,API 自己的超时也必须保留 504/api_timeout 合同',
  );

  const sessionTimeout = [...timers.values()].find(item => item.delay === 10_000);
  assert.ok(sessionTimeout, '清理验证必须找到仍在运行的内部握手 timer');
  sessionTimeout.callback();
  await new Promise(resolve => realSetTimeout(resolve, 0));
  assert.equal(fetchCalls, 1, '请求超时期间只能发起一次会话握手');
  assert.equal(timers.size, 0, 'API 和会话超时结束后不得残留 timer');
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}

console.log('api session timeout tests passed');
