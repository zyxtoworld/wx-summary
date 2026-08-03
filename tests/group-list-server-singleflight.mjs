import assert from 'node:assert/strict';
import { __mainInternals } from '../src/main.js';

const {
  groupListReadInFlightKey,
  joinGroupListReadOperation,
} = __mainInternals;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function waitWithSignal(operation, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const accountFingerprint = 'a'.repeat(64);
const key = groupListReadInFlightKey({
  accountId: 'wxid_singleflight',
  accountFingerprint,
  allowStaleAccount: false,
});
assert.ok(key, '同账号并发读取必须生成稳定的服务端合并键');
assert.notEqual(key, groupListReadInFlightKey({
  accountId: 'wxid_singleflight',
  accountFingerprint,
  allowStaleAccount: true,
}), '允许旧账号数据的请求不能与严格账号请求共享读取结果');

const gate = deferred();
const strongerGate = deferred();
const firstProgress = [];
const secondProgress = [];
const strongerProgress = [];
let runCount = 0;
let strongerStarted = false;
const first = joinGroupListReadOperation(key, {
  reporter: progress => firstProgress.push(progress.phase),
  run: async ({ signal, onProgress }) => {
    runCount += 1;
    assert.ok(signal && !signal.aborted, '共享读取必须使用独立于 HTTP 请求的超时信号');
    onProgress({ phase: 'groups_test_read' });
    return gate.promise;
  },
});
const second = joinGroupListReadOperation(key, {
  reporter: progress => secondProgress.push(progress.phase),
  run: async () => {
    runCount += 1;
    throw new Error('相同账号的第二个执行函数不应启动');
  },
});

assert.equal(first.shared, false, '首个请求必须创建共享读取');
assert.equal(second.shared, true, '后续同账号请求必须加入已有读取');
assert.ok(secondProgress.includes('groups_shared_read'), '加入者必须收到明确的等待同账号读取进度');
await Promise.resolve();
assert.equal(runCount, 1, '并发请求只能执行一次数据库镜像准备和群列表读取');
assert.ok(firstProgress.includes('groups_test_read') && secondProgress.includes('groups_test_read'), '共享读取的细分进度必须广播给所有调用者');

const stronger = joinGroupListReadOperation(key, {
  strength: 2,
  reporter: progress => strongerProgress.push(progress.phase),
  run: async () => {
    runCount += 1;
    strongerStarted = true;
    return strongerGate.promise;
  },
});
assert.equal(stronger.shared, false, '更强的强制刷新不能把较弱读取冒充成自己的结果');
assert.equal(stronger.queued, true, '更强刷新必须排在当前同账号读取之后');
assert.ok(strongerProgress.includes('groups_stronger_read_queued'), '更强刷新必须显示明确排队进度');
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(strongerStarted, false, '强制刷新不能与当前同账号镜像读取并发执行');
const followerOfStronger = joinGroupListReadOperation(key, {
  strength: 0,
  run: async () => {
    runCount += 1;
    throw new Error('较弱请求应加入已排队的强制刷新');
  },
});
assert.equal(followerOfStronger.shared, true, '更强刷新排队后，新的普通请求应加入更强操作');

const cancelledWait = new AbortController();
const secondWait = waitWithSignal(second.promise, cancelledWait.signal);
cancelledWait.abort(new Error('测试调用者取消等待'));
await assert.rejects(secondWait, /测试调用者取消等待/, '取消一个 HTTP 等待不应要求取消共享任务');

const expected = { groups: [{ id: 'group-1' }], account_id: 'wxid_singleflight', account_fingerprint: accountFingerprint };
gate.resolve(expected);
assert.deepEqual(await first.promise, expected, '首个调用者必须收到共享读取结果');
assert.deepEqual(await second.promise, expected, '取消单独等待后，共享任务本身仍必须正常完成');
first.detach();
second.detach();

await waitFor(() => strongerStarted, '当前读取完成后，排队的强制刷新没有启动');
const strongerExpected = { ...expected, groups: [{ id: 'group-2' }] };
strongerGate.resolve(strongerExpected);
assert.deepEqual(await stronger.promise, strongerExpected, '排队的强制刷新必须在当前读取结束后执行');
assert.deepEqual(await followerOfStronger.promise, strongerExpected, '排队期间加入的普通请求必须复用更强刷新结果');
stronger.detach();
followerOfStronger.detach();

const third = joinGroupListReadOperation(key, {
  run: async () => {
    runCount += 1;
    return { ...expected, groups: [{ id: 'group-3' }] };
  },
});
assert.equal(third.shared, false, '已完成的共享读取必须从运行表移除，后续请求可重新核验源快照');
assert.equal((await third.promise).groups[0].id, 'group-3');
third.detach();
assert.equal(runCount, 3, '普通读取、排队强制刷新和后续新读取都只能各执行一次');

const cancelledQueueKey = `${key}\ncancelled-queue`;
const predecessorGate = deferred();
let cancelledQueuedStarted = false;
let replacementStarted = false;
const predecessor = joinGroupListReadOperation(cancelledQueueKey, {
  run: async () => predecessorGate.promise,
});
const cancelledQueued = joinGroupListReadOperation(cancelledQueueKey, {
  strength: 2,
  run: async ({ signal }) => {
    cancelledQueuedStarted = true;
    if (signal.aborted) throw signal.reason;
    throw new Error('已取消的排队刷新不应启动');
  },
});
await Promise.resolve();
const cancelledQueuedOutcome = assert.rejects(cancelledQueued.promise, /群列表读取已取消/, '排队刷新失去最后一个调用者后必须立即取消');
cancelledQueued.detach();
const replacement = joinGroupListReadOperation(cancelledQueueKey, {
  strength: 2,
  run: async ({ signal }) => {
    replacementStarted = true;
    assert.equal(signal.aborted, false, '后续强制刷新不能继承前一个排队任务的取消信号');
    return { ...expected, groups: [{ id: 'group-after-cancel' }] };
  },
});
assert.equal(replacement.shared, false, '后续强制刷新不能加入已经取消的排队任务');
assert.equal(replacement.queued, true, '替代刷新仍必须排在尚未完成的前序读取之后');
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(replacementStarted, false, '替代刷新不能绕过仍在执行的前序读取');
predecessorGate.resolve(expected);
await predecessor.promise;
await cancelledQueuedOutcome;
assert.equal(cancelledQueuedStarted, false, '取消排队任务时不能在前序读取结束后误启动执行函数');
assert.equal((await replacement.promise).groups[0].id, 'group-after-cancel', '前序读取完成后应执行未取消的替代刷新');
predecessor.detach();
replacement.detach();

console.log('group-list server single-flight tests passed');
