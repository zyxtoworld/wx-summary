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
let businessFetchCalls = 0;
let sessionFetchCalls = 0;

globalThis.setTimeout = (callback, delay) => {
  const id = ++nextTimerId;
  timers.set(id, { callback, delay });
  return id;
};
globalThis.clearTimeout = id => { timers.delete(id); };
globalThis.fetch = (url, { signal } = {}) => {
  if (String(url).startsWith('/api/session')) {
    sessionFetchCalls += 1;
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      }, { once: true });
    });
  }
  businessFetchCalls += 1;
  return Promise.resolve(new Response(JSON.stringify({
    ok: false,
    code: 'invalid_token',
    error: 'invalid token',
  }), { status: 403, headers: { 'content-type': 'application/json' } }));
};

try {
  const loader = createBrowserModuleLoader();
  const session = await loader.load('js/session.js');
  session.rememberSessionToken('stale-session-token');
  session.rememberServiceInstanceId('stale-service-instance-1234');
  const { createApi } = await loader.load('js/api.js');
  const api = createApi({ assetVersion: 'fixture' });

  const pending = api.get('/api/needs-renewal', { timeoutMs: 25 });
  await new Promise(resolve => realSetTimeout(resolve, 0));

  const apiTimeout = [...timers.values()].find(item => item.delay === 25);
  assert.ok(apiTimeout, 'API 请求必须注册自己的 timeout timer');
  apiTimeout.callback();
  await assert.rejects(
    pending,
    error => error?.status === 504 && error?.code === 'api_timeout',
    '403 后续 session renewal 尚未完成时,API 自有超时仍必须保留 504/api_timeout 合同',
  );

  const sessionTimeout = [...timers.values()].find(item => item.delay === 10_000);
  assert.ok(sessionTimeout, '清理验证必须找到仍在运行的 renewal 握手 timer');
  sessionTimeout.callback();
  await new Promise(resolve => realSetTimeout(resolve, 0));
  assert.equal(businessFetchCalls, 1, 'renewal 超时期间不得重复发送原业务请求');
  assert.equal(sessionFetchCalls, 1, 'invalid_token renewal 只能发起一次会话握手');
  assert.equal(timers.size, 0, 'API 和 renewal 握手结束后不得残留 timer');

  session.rememberSessionToken('second-stale-session-token');
  session.rememberServiceInstanceId('second-stale-service-instance-1234');
  businessFetchCalls = 0;
  sessionFetchCalls = 0;
  const caller = new AbortController();
  const cancelled = api.get('/api/needs-renewal-cancel', {
    signal: caller.signal,
    timeoutMs: 5000,
  });
  await new Promise(resolve => realSetTimeout(resolve, 0));
  caller.abort(new Error('页面已离开'));
  await assert.rejects(
    cancelled,
    error => error?.name === 'AbortError' && error?.status === 499,
    'renewal 等待期间调用者主动取消必须保持 499,不能被 API timeout 修复误报为 504',
  );
  const cancelledSessionTimeout = [...timers.values()].find(item => item.delay === 10_000);
  assert.ok(cancelledSessionTimeout, '调用者取消后仍需清理共享 renewal 握手 timer');
  cancelledSessionTimeout.callback();
  await new Promise(resolve => realSetTimeout(resolve, 0));
  assert.equal(businessFetchCalls, 1, '调用者取消期间不得重复发送原业务请求');
  assert.equal(sessionFetchCalls, 1, '调用者取消期间只应有一次 renewal 握手');
  assert.equal(timers.size, 0, '调用者取消后的 API 和 renewal timer 必须全部释放');
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}

console.log('api session renewal timeout tests passed');
