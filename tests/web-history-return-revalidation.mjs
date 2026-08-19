import assert from 'node:assert/strict';
import { createHistoryReturnRevalidator } from '../src/web/public/js/pages/history/revalidation.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const listeners = new Map();
const windowTarget = {
  addEventListener(type, listener) { listeners.set(`window:${type}`, listener); },
  removeEventListener(type, listener) {
    if (listeners.get(`window:${type}`) === listener) listeners.delete(`window:${type}`);
  },
};
const documentTarget = {
  visibilityState: 'visible',
  addEventListener(type, listener) { listeners.set(`document:${type}`, listener); },
  removeEventListener(type, listener) {
    if (listeners.get(`document:${type}`) === listener) listeners.delete(`document:${type}`);
  },
};
const timers = new Map();
let timerId = 0;
const setTimeoutFn = (callback, delay) => {
  const id = ++timerId;
  timers.set(id, { callback, delay });
  return id;
};
const clearTimeoutFn = id => timers.delete(id);
const flushTimer = async () => {
  const entry = timers.entries().next().value;
  assert.ok(entry, '应存在一项待执行的重验任务');
  const [id, timer] = entry;
  timers.delete(id);
  timer.callback();
  await Promise.resolve();
  await Promise.resolve();
};
const flushTimerWith = async timerMap => {
  const entry = timerMap.entries().next().value;
  assert.ok(entry, '应存在一项待执行的重验任务');
  const [id, timer] = entry;
  timerMap.delete(id);
  timer.callback();
  await Promise.resolve();
  await Promise.resolve();
};

let busy = true;
let requests = 0;
let applied = 0;
const revalidator = createHistoryReturnRevalidator({
  request: async () => {
    requests += 1;
    return { version: requests };
  },
  isActive: () => true,
  isBusy: () => busy,
  onResult: () => { applied += 1; },
  windowTarget,
  documentTarget,
  setTimeoutFn,
  clearTimeoutFn,
});

listeners.get('window:focus')();
await flushTimer();
assert.equal(requests, 0, '详情忙时切回窗口不得用移动中的目标发起重验');
assert.equal(timers.size, 1, '忙态跳过后必须保留一次待重试任务');

busy = false;
await flushTimer();
assert.equal(requests, 1, '空闲后应只执行一次重验');
assert.equal(applied, 1, '重验结果必须到达当前详情');

// 请求发出后详情动作才进入忙态时,响应路径应保留 250ms 退避;
// finally 不能把忙态重试改成 0ms,否则会在动作持续期间快速自旋。
{
  const transitionTimers = new Map();
  let transitionTimerId = 0;
  const transitionRequest = deferred();
  let transitionBusy = false;
  const transition = createHistoryReturnRevalidator({
    request: () => transitionRequest.promise,
    isActive: () => true,
    isBusy: () => transitionBusy,
    onResult: () => {},
    windowTarget: { addEventListener() {}, removeEventListener() {} },
    documentTarget: { addEventListener() {}, removeEventListener() {} },
    setTimeoutFn: (callback, delay) => {
      const id = ++transitionTimerId;
      transitionTimers.set(id, { callback, delay });
      return id;
    },
    clearTimeoutFn: id => transitionTimers.delete(id),
  });

  const transitionRun = transition.run();
  transitionBusy = true;
  transitionRequest.resolve({ version: 'during-action' });
  await Promise.resolve();
  await Promise.resolve();
  const transitionRetry = [...transitionTimers.values()][0];
  assert.ok(transitionRetry, '进入忙态后必须保留一次待重试任务');
  assert.equal(transitionRetry.delay, 250,
    '请求响应期间进入忙态时必须保留退避,不得被 finally 改成 0ms');
  assert.equal(await transitionRun, false);
  transition.dispose();
}

// 跨标签更新可能在旧详情状态请求在途时再次 schedule。旧请求即使忽略
// abort/继续 resolve，也不能先把旧 item 投影到当前详情；应只触发后续重验。
{
  const staleTimers = new Map();
  let staleTimerId = 0;
  const staleA = deferred();
  const freshB = deferred();
  const staleRequests = [];
  const staleApplied = [];
  const staleRevalidator = createHistoryReturnRevalidator({
    request: () => {
      const next = staleRequests.length === 0 ? staleA : freshB;
      staleRequests.push(next);
      return next.promise;
    },
    isActive: () => true,
    isBusy: () => false,
    onResult: result => staleApplied.push(result.version),
    windowTarget: { addEventListener() {}, removeEventListener() {} },
    documentTarget: { addEventListener() {}, removeEventListener() {} },
    setTimeoutFn: (callback, delay) => {
      const id = ++staleTimerId;
      staleTimers.set(id, { callback, delay });
      return id;
    },
    clearTimeoutFn: id => staleTimers.delete(id),
  });
  const firstStaleRun = staleRevalidator.run();
  assert.equal(staleRequests.length, 1, '旧详情状态请求必须先发出');
  staleRevalidator.schedule(0);
  await flushTimerWith(staleTimers);
  staleA.resolve({ version: 'A' });
  await firstStaleRun;
  assert.deepEqual(staleApplied, [],
    '跨标签换代后旧详情状态响应不得先投影到当前详情');
  assert.equal(staleTimers.size, 1, '旧响应失效后必须保留一次后续重验');
  await flushTimerWith(staleTimers);
  assert.equal(staleRequests.length, 2, '旧响应失效后必须发起新的详情状态请求');
  freshB.resolve({ version: 'B' });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(staleApplied, ['B'], '后续详情状态响应必须正常投影');
  staleRevalidator.dispose();
}

revalidator.dispose();
assert.equal(timers.size, 0, '关闭详情必须清理待重验定时器');
assert.equal(listeners.has('window:focus'), false, '关闭详情必须移除 focus 监听');
assert.equal(listeners.has('document:visibilitychange'), false, '关闭详情必须移除 visibility 监听');

console.log('web history return revalidation tests passed');
