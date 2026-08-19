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
  addCount = 0;
  removeCount = 0;

  addEventListener(type, listener) {
    if (type !== 'abort') return;
    this.addCount += 1;
    this.listeners.add(listener);
  }

  removeEventListener(type, listener) {
    if (type !== 'abort') return;
    this.removeCount += 1;
    this.listeners.delete(listener);
  }

  abort(reason = new Error('已取消')) {
    this.aborted = true;
    this.reason = reason;
    for (const listener of [...this.listeners]) listener();
  }
}

globalThis.location = new URL('http://wx-summary.test/#/digest');
globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage();

const loader = createBrowserModuleLoader();
const {
  pollDigestTerminalResult,
  requireDigestTerminalResult,
  createInterruptedDigestRecoveryRunner,
} = await loader.load('js/pages/digest/recovery.js');
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

for (const valid of [
  { status: 'pending' },
  { status: 'missing' },
  { status: 'done', digest: { digest_id: 'digest-valid' } },
  { status: 'saved', item: { digest_id: 'digest-saved' } },
  { status: 'error', error: { message: '生成失败' } },
  { status: 'skipped', error: { message: '已跳过' } },
]) {
  assert.strictEqual(requireDigestTerminalResult(valid), valid,
    `${valid.status} 的完整终态必须按原对象返回`);
}
for (const malformed of [
  null,
  {},
  { status: 'unknown' },
  { status: 'done' },
  { status: 'done', digest: {} },
  { status: 'saved', item: {} },
  { status: 'error' },
  { status: 'skipped', error: 'bad' },
]) {
  assert.throws(
    () => requireDigestTerminalResult(malformed),
    error => error?.status === 502 && error?.code === 'digest_terminal_result_response_invalid',
    '畸形摘要终态必须使用固定 502 合同拒绝',
  );
}

try {
  let timerId = 0;
  globalThis.setTimeout = callback => {
    callback();
    timerId += 1;
    return timerId;
  };
  globalThis.clearTimeout = () => {};

  const signal = new TrackingSignal();
  let calls = 0;
  const result = await pollDigestTerminalResult(
    {
      async post(path, body, options) {
        calls += 1;
        assert.equal(path, '/api/digest-result');
        assert.deepEqual(body, {});
        assert.equal(options.signal, signal);
        return calls === 1
          ? { status: 'pending' }
          : { status: 'done', digest: { digest_id: 'digest-recovered' } };
      },
    },
    {},
    { signal, intervalMs: 0 },
  );

  assert.equal(result.status, 'done');
  assert.equal(result.digest.digest_id, 'digest-recovered');
  assert.equal(calls, 2, '轮询应在一次 pending 后读取终态');
  assert.equal(signal.listeners.size, 0, '等待完成后不得把 abort 监听器留在页面 signal 上');
  assert.equal(signal.addCount, signal.removeCount, '每次等待注册的 abort 监听器都必须成对移除');

  const lateSignal = new TrackingSignal();
  const lateAbortReason = new Error('恢复请求期间页面已离开');
  let resolveLateResult;
  let notifyLateRequestStarted;
  const lateRequestStarted = new Promise(resolve => { notifyLateRequestStarted = resolve; });
  let latePendingWrites = 0;
  const lateRecovery = pollDigestTerminalResult(
    {
      post(path, body, options) {
        assert.equal(path, '/api/digest-result');
        assert.deepEqual(body, { batch_id: 'batch-late' });
        assert.equal(options.signal, lateSignal);
        notifyLateRequestStarted();
        return new Promise(resolve => { resolveLateResult = resolve; });
      },
    },
    { batch_id: 'batch-late' },
    {
      signal: lateSignal,
      intervalMs: 0,
      onPending: () => { latePendingWrites += 1; },
    },
  );
  await lateRequestStarted;
  lateSignal.abort(lateAbortReason);
  resolveLateResult({ status: 'done', digest: { digest_id: 'late-recovery-must-not-apply' } });
  await assert.rejects(lateRecovery, error => error === lateAbortReason,
    '恢复 GET 忽略 abort 并晚到终态时，调用方取消必须优先');
  assert.equal(latePendingWrites, 0, '取消后的晚到恢复响应不得投影 pending 状态');

  const pendingTimers = new Map();
  let nextPendingTimer = 0;
  let clearedPendingTimers = 0;
  globalThis.setTimeout = callback => {
    nextPendingTimer += 1;
    pendingTimers.set(nextPendingTimer, callback);
    return nextPendingTimer;
  };
  globalThis.clearTimeout = timer => {
    clearedPendingTimers += 1;
    pendingTimers.delete(timer);
  };
  const abortSignal = new TrackingSignal();
  const abortReason = new Error('页面离开');
  const pending = pollDigestTerminalResult(
    { async post() { throw new Error('取消前不应发请求'); } },
    {},
    { signal: abortSignal },
  );
  await Promise.resolve();
  abortSignal.abort(abortReason);
  await assert.rejects(pending, error => error === abortReason,
    '等待中的取消必须保留调用方的 abort reason');
  assert.equal(pendingTimers.size, 0, '取消等待必须清除挂起的定时器');
  assert.equal(abortSignal.listeners.size, 0, '取消等待必须移除 abort 监听器');
  assert.equal(abortSignal.addCount, abortSignal.removeCount);
  assert.equal(clearedPendingTimers, 1);

  // 真实恢复 caller 已经拿到 Web Lock 后,恢复 API 可能忽略 signal 并迟到。
  // 页面取消必须先结束 caller 自己的等待;底层任务仍保留到自然结束以释放 lock。
  {
    const identity = { accountId: 'account-a', accountFingerprint: 'a'.repeat(64) };
    const record = {
      version: 5,
      batch_id: 'batch-lock-cancel',
      batch_token: 'token-lock-cancel-123456',
      service_instance_id: 'service-lock-cancel',
      account_id: identity.accountId,
      account_fingerprint: identity.accountFingerprint,
      preview_text: false,
      targets: [{ group_id: 'group-a' }],
      started_at: Date.now() - 1000,
      updated_at: Date.now(),
    };
    let notifyStarted;
    const started = new Promise(resolve => { notifyStarted = resolve; });
    let resolveRecovery;
    const recovery = new Promise(resolve => { resolveRecovery = resolve; });
    let lockBusy = false;
    const locks = {
      request(_name, options, callback) {
        assert.equal(options.ifAvailable, true);
        if (options.signal) assert.equal(options.signal, lockSignal);
        if (lockBusy) return Promise.resolve(callback(null));
        lockBusy = true;
        return Promise.resolve(callback({ name: 'held' })).finally(() => { lockBusy = false; });
      },
    };
    const runner = createInterruptedDigestRecoveryRunner({
      locks,
      readRecords: () => [record],
    });
    const lockSignal = new TrackingSignal();
    const run = runner.run(record.batch_id, {
      getIdentity: () => identity,
      signal: lockSignal,
      recover: async () => {
        notifyStarted();
        return recovery;
      },
    });
    await started;
    lockSignal.abort(new Error('页面已卸载'));
    const callerState = await Promise.race([
      run.then(() => 'resolved', () => 'rejected'),
      new Promise(resolve => originalSetTimeout(() => resolve('still-pending'), 20)),
    ]);
    const secondRunner = createInterruptedDigestRecoveryRunner({
      locks,
      readRecords: () => [record],
    });
    const second = await secondRunner.run(record.batch_id, {
      getIdentity: () => identity,
      recover: async () => 'must-not-run',
    });
    assert.deepEqual(second, { ran: false, coordinated: true, busy: true, value: undefined },
      '取消 caller 不得提前释放底层 Web Lock 让另一页面重复恢复');
    resolveRecovery('late');
    let runError = null;
    try { await run; } catch (error) { runError = error; }
    assert.equal(callerState, 'rejected',
      '已拿到 Web Lock 后调用者取消也必须立即结束自己的等待');
    assert.equal(runError?.name, 'AbortError');
    assert.equal(runError?.status, 499);
  }
} finally {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}

console.log('web digest recovery signal lifecycle tests passed');
