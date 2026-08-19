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

const loader = createBrowserModuleLoader();
const session = await loader.load('js/session.js');
const { createApi } = await loader.load('js/api.js');

session.rememberSessionToken('session-owner-old');
session.rememberServiceInstanceId('service-owner-old-1234');

let sessionFetchCalls = 0;
let businessFetchCalls = 0;
let invalidNotices = 0;
globalThis.fetch = async url => {
  if (String(url).startsWith('/api/session')) {
    sessionFetchCalls += 1;
    return new Response(JSON.stringify({
      code: 'invalid_bootstrap_token',
      error: '会话已失效',
    }), { status: 403, headers: { 'content-type': 'application/json' } });
  }
  businessFetchCalls += 1;
  return new Response(JSON.stringify({
    code: 'invalid_token',
    error: 'invalid token',
  }), { status: 403, headers: { 'content-type': 'application/json' } });
};

const api = createApi({
  assetVersion: 'fixture',
  onSessionInvalid: () => { invalidNotices += 1; },
});

const concurrentOutcomes = await Promise.allSettled([
  api.get('/api/old-account-one'),
  api.get('/api/old-account-two'),
]);
assert.equal(sessionFetchCalls, 1, '并发 token 失效必须共享一次续租握手');
assert.equal(businessFetchCalls, 2, '并发失效请求各自只能完成一次原始请求');
assert.equal(invalidNotices, 1,
  '同一旧 session owner 的并发失效只能向全局错误处理报告一次');
assert.ok(concurrentOutcomes.every(outcome => outcome.status === 'rejected'));

session.rememberSessionToken('session-owner-staggered');
session.rememberServiceInstanceId('service-owner-staggered-1234');
sessionFetchCalls = 0;
businessFetchCalls = 0;
let releaseStaggeredResponse;
globalThis.fetch = async url => {
  if (String(url).startsWith('/api/session')) {
    sessionFetchCalls += 1;
    return new Response(JSON.stringify({
      code: 'invalid_bootstrap_token',
      error: '会话已失效',
    }), { status: 403, headers: { 'content-type': 'application/json' } });
  }
  businessFetchCalls += 1;
  if (businessFetchCalls === 1) {
    return new Response(JSON.stringify({
      code: 'invalid_token',
      error: 'invalid token',
    }), { status: 403, headers: { 'content-type': 'application/json' } });
  }
  return new Promise(resolve => {
    releaseStaggeredResponse = () => resolve(new Response(JSON.stringify({
      code: 'invalid_token',
      error: 'invalid token',
    }), { status: 403, headers: { 'content-type': 'application/json' } }));
  });
};
const staggeredFirst = api.get('/api/staggered-first');
const staggeredSecond = api.get('/api/staggered-second');
await assert.rejects(staggeredFirst, error => error?.code === 'invalid_token');
releaseStaggeredResponse();
await assert.rejects(staggeredSecond, error => error?.code === 'invalid_token');
assert.equal(sessionFetchCalls, 1,
  '第一次续租已明确失败后,同一旧 session owner 的迟到 403 不得再次握手');
assert.equal(invalidNotices, 2,
  '新旧 token 代际各只允许报告一次会话失效');

let lateBusinessCalls = 0;
let releaseLateResponse;
let lateRequestStarted;
const lateRequestReady = new Promise(resolve => { lateRequestStarted = resolve; });
session.rememberSessionToken('session-owner-old-2');
session.rememberServiceInstanceId('service-owner-old-2-1234');
globalThis.fetch = async url => {
  if (String(url).startsWith('/api/session')) {
    throw new Error('新 session 已存在时不应重新握手');
  }
  lateBusinessCalls += 1;
  if (lateBusinessCalls === 1) {
    lateRequestStarted();
    return new Promise(resolve => {
      releaseLateResponse = () => resolve(new Response(JSON.stringify({
        code: 'invalid_token',
        error: 'invalid token',
      }), { status: 403, headers: { 'content-type': 'application/json' } }));
    });
  }
  return new Response(JSON.stringify({ ok: true, owner: 'new-session' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
const lateRequest = api.get('/api/late-old-request');
await lateRequestReady;
session.rememberSessionToken('session-owner-new');
session.rememberServiceInstanceId('service-owner-new-1234');
releaseLateResponse();
assert.deepEqual(
  await lateRequest,
  { ok: true, owner: 'new-session' },
  '旧请求迟到失效时应复用当前新 session 重试，不得清除新 token');
assert.equal(session.currentToken(), 'session-owner-new');
assert.equal(invalidNotices, 2, '当前新 session 已接管时不得重复报告旧 token 失效');

globalThis.fetch = async () => new Response(JSON.stringify({
  code: 'invalid_token',
  error: 'invalid token',
}), { status: 401, headers: { 'content-type': 'application/json' } });
await assert.rejects(
  api.get('/api/old-401'),
  error => error?.status === 401 && error?.code === 'invalid_token',
  '401 失败应原样返回给调用层');
assert.equal(session.currentToken(), 'session-owner-new', '401 不得清除当前 session');
assert.equal(invalidNotices, 2, '401 迟到错误不得覆盖当前 session owner 的错误状态');

for (const lateFailure of ['http', 'network']) {
  let releaseLateFailure;
  let lateFailureStarted;
  const lateFailureReady = new Promise(resolve => { lateFailureStarted = resolve; });
  globalThis.fetch = async () => {
    lateFailureStarted();
    return new Promise((resolve, reject) => {
      releaseLateFailure = () => {
        if (lateFailure === 'http') {
          resolve(new Response(JSON.stringify({
            code: 'invalid_token',
            error: 'invalid token',
          }), { status: 403, headers: { 'content-type': 'application/json' } }));
        } else {
          reject(new Error('旧页面网络失败'));
        }
      };
    });
  };
  const caller = new AbortController();
  const pending = api.get(`/api/old-page-${lateFailure}`, { signal: caller.signal });
  await lateFailureReady;
  caller.abort(new Error('旧页面已卸载'));
  releaseLateFailure();
  await assert.rejects(
    pending,
    error => error?.name === 'AbortError' && error?.status === 499,
    `旧页面 ${lateFailure} 迟到错误必须只归一为调用者取消`,
  );
  assert.equal(session.currentToken(), 'session-owner-new',
    `旧页面 ${lateFailure} 迟到错误不得清除当前 session`);
  assert.equal(invalidNotices, 2,
    `旧页面 ${lateFailure} 迟到错误不得触发全局会话失效提示`);
}

// 即使底层 fetch 错误地忽略 AbortSignal,调用者取消也必须立即结束
// 自己的 API 等待并释放 timeout owner;迟到响应不能重新占住已卸载页面。
{
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  let nextTimerId = 0;
  let releaseLateResponse;
  let notifyFetchStarted;
  const fetchStarted = new Promise(resolve => { notifyFetchStarted = resolve; });
  globalThis.setTimeout = (callback, delay) => {
    const id = ++nextTimerId;
    timers.set(id, { callback, delay });
    return id;
  };
  globalThis.clearTimeout = id => { timers.delete(id); };
  globalThis.fetch = async () => {
    notifyFetchStarted();
    return new Promise(resolve => {
      releaseLateResponse = () => resolve(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    });
  };
  const caller = new AbortController();
  let pending;
  try {
    pending = api.get('/api/abort-ignored-fetch', {
      signal: caller.signal,
      timeoutMs: 10_000,
    });
    await fetchStarted;
    caller.abort(new Error('页面已卸载'));
    const cancellation = await Promise.race([
      pending.then(() => 'fulfilled', () => 'rejected'),
      new Promise(resolve => realSetTimeout(() => resolve('still-pending'), 25)),
    ]);
    assert.equal(cancellation, 'rejected',
      '底层 fetch 忽略 abort 时,API 也必须立即结束调用者等待');
    assert.equal(timers.size, 0,
      '调用者取消后必须立即清理 API 自有 timeout timer');
  } finally {
    releaseLateResponse?.();
    if (pending) await pending.catch(() => {});
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}

console.log('api session owner checks passed');
