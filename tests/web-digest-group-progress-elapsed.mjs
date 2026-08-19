import assert from 'node:assert/strict';
import {
  createGroupProgressPoller,
  formatGroupProgressText,
} from '../src/web/public/js/pages/digest/group-load-scope.js';

function flush() {
  return Promise.resolve().then(() => Promise.resolve());
}

function createTimerHarness() {
  const timers = [];
  const cleared = new Set();
  return {
    timers,
    cleared,
    setIntervalFn(callback, intervalMs) {
      const id = timers.length;
      timers.push({ callback, intervalMs });
      return id;
    },
    clearIntervalFn(id) {
      cleared.add(id);
    },
    run(id) {
      timers[id]?.callback();
    },
  };
}

let nowMs = 10_000;
const timers = createTimerHarness();
const progressEvents = [];
const displayedProgress = [];
const deferredPolls = [];
let pollRequests = 0;
const progressAbort = new AbortController();
const poller = createGroupProgressPoller({
  signal: progressAbort.signal,
  isCurrent: () => !progressAbort.signal.aborted,
  now: () => nowMs,
  elapsedIntervalMs: 1_000,
  setIntervalFn: timers.setIntervalFn,
  clearIntervalFn: timers.clearIntervalFn,
  poll: () => {
    pollRequests += 1;
    return new Promise(resolve => deferredPolls.push({ resolve }));
  },
  onProgress: progress => {
    progressEvents.push(progress);
    displayedProgress.push(formatGroupProgressText(progress));
  },
});

assert.equal(timers.timers[0].intervalMs, 900, '进度轮询仍应使用原有轮询间隔');
timers.run(0);
assert.equal(pollRequests, 1);
deferredPolls.shift().resolve({
  status: 'running',
  phase: 'groups_account',
  label: '读取群列表',
  elapsed_ms: 1_200,
});
await flush();
assert.equal(progressEvents.at(-1).elapsed_ms, 1_200);
assert.match(displayedProgress.at(-1), /已耗时 1 秒/, '生产进度投影必须显示服务端 elapsed');

nowMs += 2_500;
const elapsedTimerId = timers.timers.findIndex(timer => timer.intervalMs === 1_000);
assert.notEqual(elapsedTimerId, -1, '收到 running 事件后必须启动本地 elapsed ticker');
timers.run(elapsedTimerId);
const firstLocalElapsed = progressEvents.at(-1).elapsed_ms;
assert.ok(firstLocalElapsed > 1_200, '推进 fake clock 后 elapsed 必须增加');
assert.match(displayedProgress.at(-1), /已耗时 [2-9] 秒/, '本地 ticker 必须更新用户可见 elapsed');

nowMs += 500;
timers.run(0);
deferredPolls.shift().resolve({
  status: 'running',
  phase: 'groups_read',
  label: '读取群列表',
  elapsed_ms: 2_000,
});
await flush();
const phaseElapsed = progressEvents.at(-1).elapsed_ms;
assert.ok(phaseElapsed >= firstLocalElapsed, '阶段更新不得让 elapsed 回退');

nowMs += 1_000;
timers.run(elapsedTimerId);
assert.ok(progressEvents.at(-1).elapsed_ms > phaseElapsed, '阶段更新后本地 elapsed 必须继续增加');

const beforeStop = progressEvents.length;
poller.stop();
assert.ok(timers.cleared.has(0), 'stop 必须清理进度轮询 timer');
assert.ok(timers.cleared.has(elapsedTimerId), 'stop 必须清理 elapsed ticker');
timers.run(elapsedTimerId);
timers.run(0);
assert.equal(progressEvents.length, beforeStop, 'stop 后不得继续投影进度');

const abortTimers = createTimerHarness();
const abortController = new AbortController();
const abortEvents = [];
const abortPoller = createGroupProgressPoller({
  signal: abortController.signal,
  now: () => nowMs,
  setIntervalFn: abortTimers.setIntervalFn,
  clearIntervalFn: abortTimers.clearIntervalFn,
  poll: () => Promise.resolve({ status: 'running', elapsed_ms: 500 }),
  onProgress: progress => abortEvents.push(progress),
});
abortTimers.run(0);
await flush();
const abortElapsedTimerId = abortTimers.timers.findIndex(timer => timer.intervalMs === 1_000);
abortController.abort(new Error('账号已切换'));
const beforeAbortLateTick = abortEvents.length;
abortTimers.run(abortElapsedTimerId);
assert.equal(abortTimers.cleared.has(0), true, 'abort 必须清理进度轮询 timer');
assert.equal(abortTimers.cleared.has(abortElapsedTimerId), true, 'abort 必须清理 elapsed ticker');
assert.equal(abortEvents.length, beforeAbortLateTick, 'abort 后晚到 ticker 不得投影');

const completionTimers = createTimerHarness();
const completionEvents = [];
let completionPolls = 0;
const completionPoller = createGroupProgressPoller({
  setIntervalFn: completionTimers.setIntervalFn,
  clearIntervalFn: completionTimers.clearIntervalFn,
  poll: () => {
    completionPolls += 1;
    return Promise.resolve(completionPolls === 1
      ? { status: 'running', label: '读取群列表', elapsed_ms: 2_000 }
      : { status: 'done', done: true, elapsed_ms: 3_000 });
  },
  onProgress: progress => completionEvents.push(progress),
});
completionTimers.run(0);
await flush();
const completionElapsedTimerId = completionTimers.timers.findIndex(timer => timer.intervalMs === 1_000);
assert.notEqual(completionElapsedTimerId, -1, '完成前 running 阶段必须持有 elapsed ticker');
completionTimers.run(0);
await flush();
assert.equal(completionPoller.isStopped(), true, '完成响应必须立即停止进度协调器');
assert.equal(completionTimers.cleared.has(0), true, '完成响应必须清理进度轮询 timer');
assert.equal(completionTimers.cleared.has(completionElapsedTimerId), true, '完成响应必须清理 elapsed ticker');
const completionEventCount = completionEvents.length;
completionTimers.run(completionElapsedTimerId);
assert.equal(completionEvents.length, completionEventCount, '完成后不得继续投影 running 进度');

for (const error of [
  Object.assign(new Error('token'), { code: 'invalid_token' }),
  Object.assign(new Error('session'), { code: 'session-invalid' }),
  Object.assign(new Error('asset'), { code: 'stale_frontend_asset' }),
  Object.assign(new Error('restart'), { code: 'service_restart_required' }),
]) {
  const errorTimers = createTimerHarness();
  let requests = 0;
  let errors = 0;
  const terminalPoller = createGroupProgressPoller({
    setIntervalFn: errorTimers.setIntervalFn,
    clearIntervalFn: errorTimers.clearIntervalFn,
    poll: () => {
      requests += 1;
      return Promise.reject(error);
    },
    onError: () => { errors += 1; },
  });
  errorTimers.run(0);
  await flush();
  assert.equal(errors, 1, `${error.code} 应投影一次错误`);
  assert.equal(terminalPoller.isStopped(), true, `${error.code} 必须立即停止轮询`);
  errorTimers.run(0);
  assert.equal(requests, 1, `${error.code} 停止后不得重试`);
}

const transientTimers = createTimerHarness();
let transientRequests = 0;
let transientErrors = 0;
const transientPoller = createGroupProgressPoller({
  maxErrorRetries: 2,
  setIntervalFn: transientTimers.setIntervalFn,
  clearIntervalFn: transientTimers.clearIntervalFn,
  poll: () => {
    transientRequests += 1;
    return Promise.reject(new Error('暂时不可用'));
  },
  onError: () => { transientErrors += 1; },
});
transientTimers.run(0);
await flush();
assert.equal(transientPoller.isStopped(), false, '普通瞬时错误首次发生时应允许有界重试');
transientTimers.run(0);
await flush();
transientTimers.run(0);
await flush();
assert.equal(transientErrors, 3);
assert.equal(transientRequests, 3, '普通错误只能重试到明确上限');
assert.equal(transientPoller.isStopped(), true, '超过普通错误上限后必须停止');

console.log('web digest group progress elapsed tests passed');
