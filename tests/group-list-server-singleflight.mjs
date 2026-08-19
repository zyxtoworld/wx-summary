import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { __mainInternals } from '../src/main.js';

const {
  groupListReadInFlightKey,
  joinGroupListReadOperation,
} = __mainInternals;

const mainSource = await fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const groupsRouteStart = mainSource.indexOf("if (pathname === '/api/groups'");
const groupsRouteEnd = mainSource.indexOf("if (pathname === '/api/recent-groups'", groupsRouteStart);
assert.ok(groupsRouteStart >= 0 && groupsRouteEnd > groupsRouteStart, '必须找到真实 /api/groups caller');
const groupsRouteSource = mainSource.slice(groupsRouteStart, groupsRouteEnd);
assert.ok(
  groupsRouteSource.includes('mirror: requestAccountContext.account?.mirror || null'),
  '真实 /api/groups caller 必须把账号镜像快照传给共享读取 owner',
);

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

const mirrorA = {
  source_snapshot_meta_hash: '1'.repeat(64),
  published_manifest_hash: '2'.repeat(64),
  refreshed_at: '2026-08-18T10:00:00.000Z',
};
const mirrorB = {
  source_snapshot_meta_hash: '3'.repeat(64),
  published_manifest_hash: '4'.repeat(64),
  refreshed_at: '2026-08-18T10:01:00.000Z',
};
const snapshotKeyA = groupListReadInFlightKey({
  accountId: 'wxid_singleflight',
  accountFingerprint,
  mirror: mirrorA,
  allowStaleAccount: false,
});
const snapshotKeyB = groupListReadInFlightKey({
  accountId: 'wxid_singleflight',
  accountFingerprint,
  mirror: mirrorB,
  allowStaleAccount: false,
});
assert.notEqual(
  snapshotKeyA,
  snapshotKeyB,
  '同一账号指纹的不同本地工作副本必须使用不同共享读取 owner，不能让新快照加入旧读取',
);

const snapshotGateA = deferred();
const snapshotGateB = deferred();
let snapshotRunCount = 0;
const snapshotReadA = joinGroupListReadOperation(snapshotKeyA, {
  run: async () => {
    snapshotRunCount += 1;
    return snapshotGateA.promise;
  },
});
const snapshotReadB = joinGroupListReadOperation(snapshotKeyB, {
  run: async () => {
    snapshotRunCount += 1;
    return snapshotGateB.promise;
  },
});
assert.equal(snapshotReadA.shared, false, '旧镜像快照必须创建自己的共享读取');
assert.equal(snapshotReadB.shared, false, '新镜像快照不得加入旧镜像读取');
await Promise.resolve();
assert.equal(snapshotRunCount, 2, '镜像快照换代时 A/B 必须各自执行一次读取');
snapshotGateA.resolve({ snapshot: 'A', groups: [{ id: 'group-a' }] });
snapshotGateB.resolve({ snapshot: 'B', groups: [{ id: 'group-b' }] });
assert.equal((await snapshotReadA.promise).snapshot, 'A', 'A 只能收到自己的镜像快照结果');
assert.equal((await snapshotReadB.promise).snapshot, 'B', 'B 只能收到新镜像快照结果');
snapshotReadA.detach();
snapshotReadB.detach();

const cancelledSnapshotKey = `${snapshotKeyA}\ncancel-late`;
const lateSnapshotGate = deferred();
const lateSnapshotProgress = [];
let lateSnapshotSignal = null;
let lateSnapshotOnProgress = null;
const cancelledSnapshot = joinGroupListReadOperation(cancelledSnapshotKey, {
  reporter: progress => lateSnapshotProgress.push(progress.phase),
  run: async ({ signal, onProgress }) => {
    lateSnapshotSignal = signal;
    lateSnapshotOnProgress = onProgress;
    return lateSnapshotGate.promise;
  },
});
await Promise.resolve();
assert.equal(lateSnapshotSignal?.aborted, false, '旧镜像读取开始时应仍持有自己的取消信号');
cancelledSnapshot.detach();
assert.equal(lateSnapshotSignal?.aborted, true, '最后一个调用者离开后必须只取消自己的镜像读取');

const replacementSnapshotGate = deferred();
const replacementProgress = [];
const replacementSnapshot = joinGroupListReadOperation(snapshotKeyB, {
  reporter: progress => replacementProgress.push(progress.phase),
  run: async ({ onProgress }) => {
    onProgress({ phase: 'replacement_snapshot_running' });
    return replacementSnapshotGate.promise;
  },
});
assert.equal(replacementSnapshot.shared, false, '新镜像快照不能加入已取消的旧读取');
await Promise.resolve();
replacementSnapshotGate.resolve({ snapshot: 'B-current', groups: [{ id: 'group-b-current' }] });
assert.equal((await replacementSnapshot.promise).snapshot, 'B-current', '新镜像读取必须独立完成');
lateSnapshotOnProgress?.({ phase: 'old_snapshot_late_progress' });
lateSnapshotGate.resolve({ snapshot: 'A-late', groups: [{ id: 'group-a-late' }] });
assert.equal((await cancelledSnapshot.promise).snapshot, 'A-late', '底层忽略取消时旧读取也只能完成自己的 promise');
assert.deepEqual(replacementProgress, ['replacement_snapshot_running'], '旧读取迟到进度不得投影到新镜像 owner');
assert.deepEqual(lateSnapshotProgress, [], '取消后的旧 reporter 必须立即脱离，迟到结果不得回写调用者');
replacementSnapshot.detach();

const failedSnapshotKey = `${snapshotKeyB}\nfailed-retry`;
const failedSnapshot = joinGroupListReadOperation(failedSnapshotKey, {
  run: async () => { throw new Error('snapshot failed'); },
});
await assert.rejects(failedSnapshot.promise, /snapshot failed/, '镜像读取失败必须传递原错误');
failedSnapshot.detach();
const retrySnapshot = joinGroupListReadOperation(failedSnapshotKey, {
  run: async () => ({ snapshot: 'retry', groups: [] }),
});
assert.equal(retrySnapshot.shared, false, '失败读取完成后同一镜像 owner 必须允许重试');
assert.equal((await retrySnapshot.promise).snapshot, 'retry');
retrySnapshot.detach();

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
