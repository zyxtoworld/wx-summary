import assert from 'node:assert/strict';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

globalThis.location = {
  origin: 'http://fixture.test',
  href: 'http://fixture.test/#/digest',
};
const storage = new Map();
globalThis.sessionStorage = {
  getItem(key) { return storage.get(key) ?? null; },
  setItem(key, value) { storage.set(key, String(value)); },
  removeItem(key) { storage.delete(key); },
};
globalThis.history = { replaceState() {} };
globalThis.document = { title: 'fixture' };

let fetchCalls = 0;
let resolveResponse;
globalThis.fetch = (_url, { signal } = {}) => {
  fetchCalls += 1;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    resolveResponse = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve(new Response(JSON.stringify({
        token: 'synthetic-session-token',
        service_instance_id: 'synthetic-service-instance-1234',
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    };
  });
};

const session = await createBrowserModuleLoader().load('js/session.js');
const oldPage = new AbortController();
const livePage = new AbortController();
const oldRequest = session.ensureSessionToken({ signal: oldPage.signal, assetVersion: 'fixture' });
await new Promise(resolve => setImmediate(resolve));
const liveRequest = session.ensureSessionToken({ signal: livePage.signal, assetVersion: 'fixture' });
const outcomesPromise = Promise.allSettled([oldRequest, liveRequest]);

oldPage.abort(new Error('old page unmounted'));
await new Promise(resolve => setImmediate(resolve));
resolveResponse();

const [oldOutcome, liveOutcome] = await outcomesPromise;
assert.equal(fetchCalls, 1, '并发会话请求必须复用一次握手');
assert.equal(oldOutcome.status, 'rejected', '已卸载页面的会话等待必须响应自身取消');
assert.equal(oldOutcome.reason?.name, 'AbortError', '会话等待取消必须归一为 AbortError');
assert.equal(oldOutcome.reason?.status, 499, '会话等待取消必须使用 499 状态');
assert.equal(liveOutcome.status, 'fulfilled',
  '仍存活页面的会话等待不得被旧页面的 AbortSignal 取消');
assert.equal(liveOutcome.value, 'synthetic-session-token');

session.resetSessionForReload();
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const timers = new Map();
let nextTimerId = 0;
let timeoutFetchCalls = 0;
globalThis.setTimeout = (callback, delay) => {
  const id = ++nextTimerId;
  timers.set(id, { callback, delay });
  return id;
};
globalThis.clearTimeout = id => { timers.delete(id); };
globalThis.fetch = (_url, { signal } = {}) => {
  timeoutFetchCalls += 1;
  if (timeoutFetchCalls === 1) {
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      }, { once: true });
    });
  }
  return Promise.resolve(new Response(JSON.stringify({
    token: 'recovered-session-token',
    service_instance_id: 'recovered-service-instance-1234',
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
};

try {
  const timeoutSession = session;
  const timeoutA = timeoutSession.ensureSessionToken({ assetVersion: 'fixture' });
  await new Promise(resolve => setImmediate(resolve));
  const timeoutB = timeoutSession.ensureSessionToken({ assetVersion: 'fixture' });
  const timeoutOutcomesPromise = Promise.allSettled([timeoutA, timeoutB]);
  const timeoutTimer = [...timers.values()].find(item => item.delay === 10_000);
  assert.ok(timeoutTimer, '握手必须注册可识别的内部超时');
  timeoutTimer.callback();
  const [timeoutOutcomeA, timeoutOutcomeB] = await timeoutOutcomesPromise;
  for (const outcome of [timeoutOutcomeA, timeoutOutcomeB]) {
    assert.equal(outcome.status, 'rejected', '握手超时必须拒绝所有仍存活的等待者');
    assert.equal(outcome.reason?.status, 504, '握手超时必须投影为 504');
    assert.equal(outcome.reason?.code, 'session_bootstrap_timeout',
      '握手超时必须保留 session_bootstrap_timeout 合同');
  }
  assert.equal(timers.size, 0, '握手结束后必须清理内部超时 timer');

  const recovered = await timeoutSession.ensureSessionToken({ assetVersion: 'fixture' });
  assert.equal(recovered, 'recovered-session-token',
    '握手超时后共享 Promise 必须释放,允许下一次重新建立会话');
  assert.equal(timeoutFetchCalls, 2, '重建会话必须发起第二次握手');

  const cachedCallerAbort = new AbortController();
  cachedCallerAbort.abort(new Error('缓存会话调用者已取消'));
  await assert.rejects(
    timeoutSession.ensureSessionToken({ signal: cachedCallerAbort.signal, assetVersion: 'fixture' }),
    error => error?.name === 'AbortError'
      && error?.status === 499
      && error?.message === '缓存会话调用者已取消',
    '已有缓存 token 时也必须尊重已取消调用者,不能同步成功返回 token',
  );
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}

// 内部握手超时可能在最后一次 reader.read() 已完成、但 releaseLock() 尚未返回
// 的窗口触发；session caller 必须在 bounded reader 返回后再次检查 controller，
// 不能把半响应解析并写入会话凭据。
{
  session.resetSessionForReload();
  const savedSetTimeout = globalThis.setTimeout;
  const savedClearTimeout = globalThis.clearTimeout;
  let timeoutCallback = null;
  let timeoutId = 0;
  let releaseCount = 0;
  globalThis.setTimeout = (callback, delay) => {
    const id = ++timeoutId;
    if (delay === 10_000) timeoutCallback = callback;
    return id;
  };
  globalThis.clearTimeout = () => {};
  globalThis.fetch = async (_url, { signal } = {}) => ({
    ok: true,
    status: 200,
    headers: { get() { return 'application/json'; } },
    bodyUsed: false,
    body: {
      getReader() {
        let reads = 0;
        return {
          read() {
            reads += 1;
            if (reads === 1) {
              return Promise.resolve({
                done: false,
                value: new TextEncoder().encode(JSON.stringify({
                  token: 'late-release-token',
                  service_instance_id: 'late-release-service-0001',
                })),
              });
            }
            return Promise.resolve({ done: true, value: undefined });
          },
          cancel() { return Promise.resolve(); },
          releaseLock() {
            releaseCount += 1;
            assert.equal(typeof timeoutCallback, 'function',
              '握手响应读取期间必须已经注册内部超时回调');
            timeoutCallback();
          },
        };
      },
    },
    signal,
  });
  try {
    await assert.rejects(
      session.ensureSessionToken({ assetVersion: 'fixture' }),
      error => error?.status === 504 && error?.code === 'session_bootstrap_timeout',
      'releaseLock 期间握手超时不得把半响应当成成功会话',
    );
    assert.equal(releaseCount, 1, 'late release timeout fixture 必须确实经过 reader.releaseLock');
    assert.equal(session.currentToken(), '', '超时后的半响应不得写入内存 session token');
    assert.equal(session.storedSessionToken(), '', '超时后的半响应不得写入 sessionStorage token');
  } finally {
    globalThis.setTimeout = savedSetTimeout;
    globalThis.clearTimeout = savedClearTimeout;
  }
}

console.log('web session bootstrap lifecycle tests passed');
