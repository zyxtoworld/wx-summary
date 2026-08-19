import assert from 'node:assert/strict';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

globalThis.location = new URL('http://wx-summary.test/#/digest');
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.sessionStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { locks: null },
});

const loader = createBrowserModuleLoader();
const { runDigestBatch } = await loader.load('js/pages/digest/batch-runner.js');

const accountFingerprint = 'd'.repeat(64);
const calls = [];
const results = [];
const abortController = new AbortController();
const encoder = new TextEncoder();
let streamController = null;

// 批次 start 挂起期间用户取消；底层 API 若忽略 signal 后普通拒绝，
// 仍必须归一为取消，不能让页面误报“生成失败”。
{
  const startAbort = new AbortController();
  let rejectStart;
  let notifyStartRequested;
  const startRequested = new Promise(resolve => { notifyStartRequested = resolve; });
  let streamCalls = 0;
  let groupResults = 0;
  const startRun = runDigestBatch({
    getServiceInstanceId() {
      return 'service-instance-start-cancel';
    },
    post(path) {
      assert.equal(path, '/api/digest-batch-start');
      notifyStartRequested();
      return new Promise((_resolve, reject) => { rejectStart = reject; });
    },
    async postStream() {
      streamCalls += 1;
      throw new Error('取消后不得开始摘要流');
    },
  }, {
    accountId: 'account-start-cancel',
    accountFingerprint,
    signal: startAbort.signal,
    targets: [{
      group_id: 'group-start-cancel',
      group_name: '启动取消测试群',
      since: '2026-08-01 00:00:00',
      until: '2026-08-02 00:00:00',
    }],
    onGroupResult: () => { groupResults += 1; },
  }).then(
    value => ({ value }),
    error => ({ error }),
  );
  await startRequested;
  startAbort.abort(new Error('用户在批次启动期间取消'));
  rejectStart(new Error('底层 API 晚到普通失败'));
  const startOutcome = await startRun;

  assert.equal(startOutcome.error?.name, 'AbortError', 'start 晚到普通拒绝必须投影为取消');
  assert.equal(startOutcome.error?.status, 499);
  assert.match(startOutcome.error?.message || '', /取消/);
  assert.equal(streamCalls, 0, 'start 取消后不得启动摘要流');
  assert.equal(groupResults, 0, 'start 取消不得伪造群终态');
}

const api = {
  getServiceInstanceId() {
    return 'service-instance-sse-cancel';
  },
  async post(path, body) {
    calls.push(path);
    if (path === '/api/digest-batch-start') return {
      ok: true,
      batch_id: body.batch_id,
      service_instance_id: body.service_instance_id,
      account_id: body.account_id,
      account_fingerprint: accountFingerprint,
    };
    if (path === '/api/digest-batch-finish') {
      return { ok: true, settled: true, pending: false, released: false };
    }
    return { ok: true };
  },
  async postStream(path) {
    assert.equal(path, '/api/digest');
    calls.push(path);
    const body = new ReadableStream({
      start(controller) {
        streamController = controller;
        controller.enqueue(encoder.encode(
          `event: stage\ndata: ${JSON.stringify({ name: 'context', status: 'running' })}\n\n`,
        ));
      },
    });
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    });
  },
};

const runOutcome = runDigestBatch(api, {
  accountId: 'account-sse-cancel',
  accountFingerprint,
  signal: abortController.signal,
  targets: [{
    group_id: 'group-sse-cancel',
    group_name: '取消测试群',
    since: '2026-08-01 00:00:00',
    until: '2026-08-02 00:00:00',
  }],
  onGroupResult: result => results.push(result),
}).then(
  value => ({ value }),
  error => ({ error }),
);

setTimeout(() => abortController.abort(new Error('用户明确取消')), 20);

const settled = await Promise.race([
  runOutcome,
  new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 500)),
]);

if (settled?.timeout) {
  try { streamController?.error(new Error('测试清理流')); } catch {}
  await runOutcome;
}

assert.equal(settled?.timeout, undefined,
  '外层取消后，已开始读取的 SSE 必须在有限时间内收口');
assert.equal(settled?.error?.name, 'AbortError', '取消应归一为 AbortError');
assert.equal(results.length, 1, '取消中的群必须收到唯一终态');
assert.equal(results[0].outcome, 'cancelled');
assert.equal(results[0].error?.cancelled, true);
assert.equal(calls.filter(path => path === '/api/digest-batch-finish').length, 1,
  '取消后必须释放批次资源');

// reader.read() 挂起期间取消，底层 reader 可能忽略 cancel() 并晚到终态帧。
// 取消必须赢过该响应，不能把旧请求投影成成功结果。
{
  const lateCalls = [];
  const lateResults = [];
  const lateAbort = new AbortController();
  let resolveRead;
  let notifyReadStarted;
  const readStarted = new Promise(resolve => { notifyReadStarted = resolve; });
  const lateApi = {
    getServiceInstanceId() {
      return 'service-instance-sse-late-cancel';
    },
    async post(path, body) {
      lateCalls.push(path);
      if (path === '/api/digest-batch-start') return {
        ok: true,
        batch_id: body.batch_id,
        service_instance_id: body.service_instance_id,
        account_id: body.account_id,
        account_fingerprint: accountFingerprint,
      };
      if (path === '/api/digest-batch-finish') {
        return { ok: true, settled: true, pending: false, released: false };
      }
      return { ok: true };
    },
    async postStream(path) {
      assert.equal(path, '/api/digest');
      lateCalls.push(path);
      return {
        body: {
          getReader() {
            return {
              read() {
                notifyReadStarted();
                return new Promise(resolve => { resolveRead = resolve; });
              },
              cancel() { return Promise.resolve(); },
              releaseLock() {},
            };
          },
        },
      };
    },
  };

  const lateRun = runDigestBatch(lateApi, {
    accountId: 'account-sse-late-cancel',
    accountFingerprint,
    signal: lateAbort.signal,
    targets: [{
      group_id: 'group-sse-late-cancel',
      group_name: '晚到取消测试群',
      since: '2026-08-01 00:00:00',
      until: '2026-08-02 00:00:00',
    }],
    onGroupResult: result => lateResults.push(result),
  }).then(
    value => ({ value }),
    error => ({ error }),
  );

  await readStarted;
  lateAbort.abort(new Error('用户已取消晚到请求'));
  resolveRead({
    done: false,
    value: encoder.encode(
      `event: digest\ndata: ${JSON.stringify({ digest_id: 'late-digest-must-not-apply' })}\n\n`,
    ),
  });
  const lateSettled = await lateRun;

  assert.equal(lateSettled.error?.name, 'AbortError', '取消必须优先于忽略 cancel 的晚到终态帧');
  assert.equal(lateResults.length, 1, '取消中的群仍只应收到一个终态');
  assert.equal(lateResults[0]?.outcome, 'cancelled', '晚到 digest 不得覆盖取消终态');
  assert.equal(lateResults[0]?.digest, undefined, '取消后不得向页面投影晚到摘要');
  assert.equal(lateCalls.filter(path => path === '/api/digest-batch-finish').length, 1,
    '晚到响应被取消后仍必须释放批次资源');
}

// 终态帧已经读到，但 reader.cancel() 仍在收口时，用户取消也必须胜出。
// 底层 cancel Promise 晚到 resolve 后不得再把该终态提交为成功。
{
  const settleCalls = [];
  const settleResults = [];
  const settleAbort = new AbortController();
  let resolveReaderCancel;
  let notifyReaderCancelStarted;
  const readerCancelStarted = new Promise(resolve => { notifyReaderCancelStarted = resolve; });
  const readerCancelPromise = new Promise(resolve => { resolveReaderCancel = resolve; });
  let readerCancelCalls = 0;
  let readCount = 0;
  const settleApi = {
    getServiceInstanceId() {
      return 'service-instance-sse-cancel-settle';
    },
    async post(path, body) {
      settleCalls.push(path);
      if (path === '/api/digest-batch-start') return {
        ok: true,
        batch_id: body.batch_id,
        service_instance_id: body.service_instance_id,
        account_id: body.account_id,
        account_fingerprint: accountFingerprint,
      };
      if (path === '/api/digest-batch-finish') {
        return { ok: true, settled: true, pending: false, released: false };
      }
      return { ok: true };
    },
    async postStream(path) {
      assert.equal(path, '/api/digest');
      settleCalls.push(path);
      return {
        body: {
          getReader() {
            return {
              async read() {
                readCount += 1;
                assert.equal(readCount, 1, '终态帧后不得继续读取');
                return {
                  done: false,
                  value: encoder.encode(
                    `event: digest\ndata: ${JSON.stringify({ digest_id: 'cancel-during-reader-settle' })}\n\n`,
                  ),
                };
              },
              cancel() {
                readerCancelCalls += 1;
                if (readerCancelCalls === 1) notifyReaderCancelStarted();
                return readerCancelPromise;
              },
              releaseLock() {},
            };
          },
        },
      };
    },
  };

  const settleRun = runDigestBatch(settleApi, {
    accountId: 'account-sse-cancel-settle',
    accountFingerprint,
    signal: settleAbort.signal,
    targets: [{
      group_id: 'group-sse-cancel-settle',
      group_name: '终态收口取消测试群',
      since: '2026-08-01 00:00:00',
      until: '2026-08-02 00:00:00',
    }],
    onGroupResult: result => settleResults.push(result),
  }).then(
    value => ({ value }),
    error => ({ error }),
  );

  await readerCancelStarted;
  settleAbort.abort(new Error('用户在终态收口期间取消'));
  resolveReaderCancel();
  const settleOutcome = await settleRun;

  assert.equal(settleOutcome.error?.name, 'AbortError', '终态 reader 收口期间的取消必须优先');
  assert.equal(settleResults.length, 1, '收口取消仍只应产生一个群终态');
  assert.equal(settleResults[0]?.outcome, 'cancelled', '收口晚到不得提交成功摘要');
  assert.equal(settleResults[0]?.digest, undefined, '收口取消后不得向页面投影摘要');
  assert.equal(settleCalls.filter(path => path === '/api/digest-batch-finish').length, 1,
    '收口取消后仍必须释放批次资源');
}

// SSE 收到新字节后,旧 idle timeout callback 可能已经排队而无法撤回。
// 旧 callback 不得取消仍在等待下一帧的 reader;终态收口本身仍只 cancel 一次。
{
  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  const idleTimers = new Map();
  let nextIdleTimer = 0;
  let secondReadStarted;
  const secondReadReady = new Promise(resolve => { secondReadStarted = resolve; });
  let resolveSecondRead;
  const secondRead = new Promise(resolve => { resolveSecondRead = resolve; });
  const cancelReasons = [];
  let readCount = 0;
  globalThis.setTimeout = callback => {
    const id = ++nextIdleTimer;
    idleTimers.set(id, callback);
    return id;
  };
  globalThis.clearTimeout = () => {
    // 保留 callback,模拟已经排队而无法撤回的浏览器 timeout。
  };
  try {
    const idleApi = {
      getServiceInstanceId() { return 'service-instance-sse-idle-owner'; },
      async post(path, body) {
        if (path === '/api/digest-batch-start') return {
          ok: true,
          batch_id: body.batch_id,
          service_instance_id: body.service_instance_id,
          account_id: body.account_id,
          account_fingerprint: accountFingerprint,
        };
        if (path === '/api/digest-batch-finish') {
          return { ok: true, settled: true, pending: false, released: false };
        }
        return { ok: true };
      },
      async postStream(path) {
        assert.equal(path, '/api/digest');
        return {
          body: {
            getReader() {
              return {
                read() {
                  readCount += 1;
                  if (readCount === 1) {
                    return Promise.resolve({
                      done: false,
                      value: encoder.encode(
                        `event: stage\ndata: ${JSON.stringify({ name: 'context', status: 'running' })}\n\n`,
                      ),
                    });
                  }
                  secondReadStarted();
                  return secondRead;
                },
                cancel(reason) {
                  cancelReasons.push(reason);
                  return Promise.resolve();
                },
                releaseLock() {},
              };
            },
          },
        };
      },
    };
    const runPromise = runDigestBatch(idleApi, {
      accountId: 'account-sse-idle-owner',
      accountFingerprint,
      targets: [{
        group_id: 'group-sse-idle-owner',
        group_name: 'idle owner test',
        since: '2026-08-01 00:00:00',
        until: '2026-08-02 00:00:00',
      }],
    });
    await secondReadReady;
    assert.equal(idleTimers.size >= 2, true, '收到首帧后必须已有新 idle timer');
    idleTimers.get(1)();
    assert.equal(cancelReasons.length, 0, '旧 idle timer 不得取消仍在途的当前 SSE reader');
    resolveSecondRead({
      done: false,
      value: encoder.encode(
        `event: digest\ndata: ${JSON.stringify({ digest_id: 'idle-owner-digest' })}\n\n`,
      ),
    });
    const run = await runPromise;
    assert.equal(run.results[0]?.outcome, 'done', '当前 SSE 终态仍应成功提交');
    await run.finish();
    assert.equal(cancelReasons.length, 1, '终态收口只能产生一次 reader cancel');
    for (const callback of idleTimers.values()) callback();
    assert.equal(cancelReasons.length, 1,
      '终态收口后晚到的 idle timer 不得再次 cancel 已结束 reader');
  } finally {
    globalThis.setTimeout = previousSetTimeout;
    globalThis.clearTimeout = previousClearTimeout;
  }
}

// SSE digest 帧是服务端已接受请求后的结果投影；缺少 digest_id 时不能
// 直接提交为 done，必须回到同一批次的 digest-result 终态合同核对。
{
  const malformedDigestCalls = [];
  const malformedDigestApi = {
    getServiceInstanceId() {
      return 'service-instance-sse-malformed-digest';
    },
    async post(path, body) {
      malformedDigestCalls.push(path);
      if (path === '/api/digest-batch-start') return {
        ok: true,
        batch_id: body.batch_id,
        service_instance_id: body.service_instance_id,
        account_id: body.account_id,
        account_fingerprint: accountFingerprint,
      };
      if (path === '/api/digest-result') {
        return { status: 'done', digest: { digest_id: 'recovered-after-malformed-sse' } };
      }
      if (path === '/api/digest-batch-finish') {
        return { ok: true, settled: true, pending: false, released: false };
      }
      return { ok: true };
    },
    async postStream(path) {
      assert.equal(path, '/api/digest');
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            'event: digest\ndata: {"not_a_digest":true}\n\n',
          ));
          controller.close();
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    },
  };
  const recovered = await runDigestBatch(malformedDigestApi, {
    accountId: 'account-sse-malformed-digest',
    accountFingerprint,
    targets: [{
      group_id: 'group-sse-malformed-digest',
      group_name: '畸形摘要帧测试群',
      since: '2026-08-01 00:00:00',
      until: '2026-08-02 00:00:00',
    }],
  });
  assert.equal(malformedDigestCalls.includes('/api/digest-result'), true,
    '缺少 digest_id 的 SSE digest 帧必须走终态恢复查询');
  assert.equal(recovered.results[0]?.outcome, 'done');
  assert.equal(recovered.results[0]?.digest?.digest_id, 'recovered-after-malformed-sse',
    '终态恢复成功后才允许提交摘要结果');
  await recovered.finish();
}

console.log('web digest SSE cancellation tests passed');
