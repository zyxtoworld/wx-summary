import assert from 'node:assert/strict';
import {
  createGroupLoadScope,
  createGroupProgressPoller,
} from '../src/web/public/js/pages/digest/group-load-scope.js';

function waitForAbort(signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

const scope = createGroupLoadScope();

const first = scope.begin();
assert.equal(first.signal.aborted, false);
assert.equal(first.isCurrent(), true);
const firstRequest = waitForAbort(first.signal);

const second = scope.begin();
await assert.rejects(firstRequest, error => {
  assert.equal(error?.name, 'AbortError');
  assert.equal(error?.status, 499);
  return true;
});
assert.equal(first.signal.aborted, true, '新群列表加载必须中止被取代的请求');
assert.equal(first.isCurrent(), false, '被取代的请求不得再提交页面状态');
assert.equal(second.signal.aborted, false);
assert.equal(second.isCurrent(), true);

first.finish();
assert.equal(second.signal.aborted, false, '旧请求的 finally 不得中止较新的请求');
assert.equal(second.isCurrent(), true);

second.finish();
assert.equal(second.signal.aborted, true, '加载结束必须停止仍在途的进度轮询');
assert.equal(second.isCurrent(), false);

const invalidated = scope.begin();
const invalidatedRequest = waitForAbort(invalidated.signal);
scope.invalidate('账号上下文已变化');
await assert.rejects(invalidatedRequest, error => {
  assert.equal(error?.name, 'AbortError');
  assert.equal(error?.status, 499);
  return true;
});
assert.equal(invalidated.isCurrent(), false, '账号上下文变化必须使旧群列表失效');

const third = scope.begin();
const thirdRequest = waitForAbort(third.signal);
scope.dispose();
await assert.rejects(thirdRequest, error => {
  assert.equal(error?.name, 'AbortError');
  assert.equal(error?.status, 499);
  return true;
});
assert.equal(third.signal.aborted, true, '页面销毁必须中止当前群列表请求');
assert.equal(third.isCurrent(), false);
assert.throws(() => scope.begin(), /已销毁/, '页面销毁后不得启动新请求');

// 进度 GET 即使忽略 AbortSignal 也可能晚到;作用域失效后不得再启动轮询,
// 晚到响应也不得投影旧账号/旧页面进度。
const pollCallbacks = [];
const clearedTimers = new Set();
const progressAbort = new AbortController();
let progressRequests = 0;
let projectedProgress = 0;
const deferredProgress = [];
const poller = createGroupProgressPoller({
  signal: progressAbort.signal,
  isCurrent: () => !progressAbort.signal.aborted,
  setIntervalFn: callback => {
    pollCallbacks.push(callback);
    return pollCallbacks.length - 1;
  },
  clearIntervalFn: timer => clearedTimers.add(timer),
  poll: () => {
    progressRequests += 1;
    return new Promise(resolve => deferredProgress.push({ resolve }));
  },
  onProgress: () => { projectedProgress += 1; },
});
assert.equal(pollCallbacks.length, 1, '进度协调器必须注册一轮定时器');
pollCallbacks[0]();
pollCallbacks[0]();
pollCallbacks[0]();
assert.equal(progressRequests, 1, '同一进度请求未结束时，定时器不得并发发起新的请求');
deferredProgress[0].resolve({ status: 'running', label: '当前进度' });
await Promise.resolve();
await Promise.resolve();
assert.equal(projectedProgress, 1, '请求结束后应投影当前进度');
pollCallbacks[0]();
assert.equal(progressRequests, 2, '前一轮结束后下一次定时器才可发起新请求');
progressAbort.abort(new Error('账号上下文已变化'));
assert.equal(clearedTimers.has(0), true, '作用域 abort 必须立即清理进度定时器');
pollCallbacks[0]();
assert.equal(progressRequests, 2, '作用域失效后不得再发起新的进度请求');
deferredProgress[1].resolve({ status: 'running', label: '旧进度' });
await Promise.resolve();
await Promise.resolve();
assert.equal(projectedProgress, 1, '失效进度的晚到响应不得投影到页面');
poller.stop();

console.log('web digest group load lifecycle tests passed');
