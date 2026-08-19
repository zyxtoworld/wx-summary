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

const timers = new Map();
let timerId = 0;
const setTimeoutFn = (callback, delay) => {
  const id = ++timerId;
  timers.set(id, { callback, delay });
  return id;
};
const clearTimeoutFn = id => timers.delete(id);
async function flushTimer() {
  const entry = timers.entries().next().value;
  assert.ok(entry, '应存在待执行的历史重验任务');
  const [id, timer] = entry;
  timers.delete(id);
  timer.callback();
  await Promise.resolve();
  await Promise.resolve();
}

const staleRequest = deferred();
const currentRequest = deferred();
const requests = [];
const errors = [];
const results = [];
const revalidator = createHistoryReturnRevalidator({
  request: () => {
    const next = requests.length === 0 ? staleRequest : currentRequest;
    requests.push(next);
    return next.promise;
  },
  isActive: () => true,
  isBusy: () => false,
  onResult: result => results.push(result),
  onError: error => errors.push(error),
  windowTarget: { addEventListener() {}, removeEventListener() {} },
  documentTarget: { addEventListener() {}, removeEventListener() {} },
  setTimeoutFn,
  clearTimeoutFn,
});

const firstRun = revalidator.run();
assert.equal(requests.length, 1, '历史详情重验必须先发起 A 请求');

// 跨标签换代会安排下一次重验；A 仍在途时，A 的普通失败也必须被视为过期。
revalidator.schedule(0);
await flushTimer();
staleRequest.reject(new Error('stale A failed'));
assert.equal(await firstRun, false, '被换代的 A 重验不得报告成功');
assert.deepEqual(errors, [], '旧 A 的普通 reject 不得投影到当前详情错误 UI');
assert.equal(timers.size, 1, '旧 A 失败后必须保留一次后续重验');

await flushTimer();
assert.equal(requests.length, 2, '旧 A 失败后必须发起当前代次 B 重验');
currentRequest.resolve({ version: 'B' });
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(results, [{ version: 'B' }], '当前 B 响应仍必须正常投影');
assert.deepEqual(errors, [], '当前 B 成功后不得出现旧 A 错误');

revalidator.dispose();
assert.equal(timers.size, 0, '重验结束后不得残留定时器');

console.log('web history return revalidation stale reject tests passed');
