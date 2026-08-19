import assert from 'node:assert/strict';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

class MemoryStorage {
  getItem() { return null; }
  setItem() {}
  removeItem() {}
}

class TrackingSignal {
  aborted = false;
  reason = null;
  listeners = new Set();

  addEventListener(type, listener) {
    if (type === 'abort') this.listeners.add(listener);
  }

  removeEventListener(type, listener) {
    if (type === 'abort') this.listeners.delete(listener);
  }
}

globalThis.location = new URL('http://wx-summary.test/#/settings');
globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage();

const loader = createBrowserModuleLoader();
const { createSettingsProgressPoller } = await loader.load('js/pages/settings/privacy.js');
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

try {
  const timers = new Map();
  let nextTimerId = 0;
  globalThis.setTimeout = callback => {
    const id = ++nextTimerId;
    timers.set(id, callback);
    return id;
  };
  globalThis.clearTimeout = id => {
    timers.delete(id);
  };

  let rejectProgress;
  let inFlightSignal = null;
  const signal = new TrackingSignal();
  const pendingFetch = new Promise((resolve, reject) => { rejectProgress = reject; });
  const poller = createSettingsProgressPoller({
    signal,
    fetchProgress: ({ signal: requestSignal } = {}) => {
      inFlightSignal = requestSignal;
      return pendingFetch;
    },
    applyProgress() {},
  });
  poller.start();
  await Promise.resolve();
  assert.ok(inFlightSignal, '生产进度 poller 必须给请求提供自己持有的取消 signal');
  assert.equal(inFlightSignal.aborted, false);
  poller.stop();
  assert.equal(inFlightSignal.aborted, true,
    '停止 poller 必须立即取消仍在途的进度 I/O');
  rejectProgress(new Error('网络断开'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(timers.size, 0,
    '停止正在进行的进度请求后,其晚到响应不得重新安排轮询定时器');
  assert.equal(signal.listeners.size, 0,
    '停止进度轮询必须释放 abort 监听器');

  const ownerController = new AbortController();
  let ownerRequestSignal = null;
  const ownerPending = new Promise(() => {});
  const ownerPoller = createSettingsProgressPoller({
    signal: ownerController.signal,
    fetchProgress: ({ signal: requestSignal } = {}) => {
      ownerRequestSignal = requestSignal;
      return ownerPending;
    },
    applyProgress() {},
  });
  ownerPoller.start();
  await Promise.resolve();
  assert.equal(ownerRequestSignal?.aborted, false,
    'owner 有效时进度请求必须保持可用');
  ownerController.abort(new Error('账号上下文已变化'));
  assert.equal(ownerRequestSignal?.aborted, true,
    '账号切换或页面卸载 abort owner 时必须向下取消进度 I/O');

  const completedSignal = new TrackingSignal();
  let callCount = 0;
  const completedPoller = createSettingsProgressPoller({
    signal: completedSignal,
    fetchProgress: async () => {
      callCount += 1;
      return callCount === 1 ? { done: false } : { done: true };
    },
    applyProgress() {},
  });
  completedPoller.start();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(timers.size, 1, '未完成进度应安排下一轮轮询');
  const [, callback] = timers.entries().next().value;
  timers.clear();
  callback();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(callCount, 2);
  assert.equal(timers.size, 0, '终态进度不得留下后续定时器');

  let transientCalls = 0;
  const transientPoller = createSettingsProgressPoller({
    fetchProgress: async () => {
      transientCalls += 1;
      if (transientCalls === 1) throw new Error('temporary network failure');
      return { done: true };
    },
    applyProgress() {},
  });
  transientPoller.start();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(timers.size, 1, '普通瞬时进度读取失败必须保留下一轮重试');
  const [, transientCallback] = timers.entries().next().value;
  timers.clear();
  transientCallback();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(transientCalls, 2);
  assert.equal(timers.size, 0, '瞬时错误恢复到终态后不得继续轮询');

  for (const code of ['invalid_token', 'stale_frontend_asset', 'service_restart_required']) {
    const terminalSignal = new TrackingSignal();
    const terminalPoller = createSettingsProgressPoller({
      signal: terminalSignal,
      fetchProgress: async () => {
        throw Object.assign(new Error(code), { code, status: code === 'invalid_token' ? 403 : 409 });
      },
      applyProgress() {},
    });
    terminalPoller.start();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(timers.size, 0,
      `${code} 是终止性会话/资源错误，设置进度轮询不得继续发起下一轮`);
    terminalPoller.stop();
  }
} finally {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}

console.log('web settings progress poller lifecycle tests passed');
