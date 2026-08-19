import assert from 'node:assert/strict';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

class MemoryStorage {
  #values = new Map();
  getItem(key) { return this.#values.get(String(key)) ?? null; }
  setItem(key, value) { this.#values.set(String(key), String(value)); }
  removeItem(key) { this.#values.delete(String(key)); }
}

globalThis.location = new URL('http://wx-summary.test/#/digest');
globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage();
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { locks: null },
});

const loader = createBrowserModuleLoader();
const { isMutationOutcomeUnknown } = await loader.load('js/api.js');
const { runDigestBatch } = await loader.load('js/pages/digest/batch-runner.js');

const accountId = 'account-outcome-unknown';
const accountFingerprint = 'c'.repeat(64);
const calls = [];
const recoveryEvents = [];
const api = {
  getServiceInstanceId() { return 'service-instance-1234'; },
    async post(path, body) {
      calls.push(path);
      if (path === '/api/digest-batch-start') return {
        ok: true,
        batch_id: body.batch_id,
        service_instance_id: body.service_instance_id,
        account_id: body.account_id,
        account_fingerprint: accountFingerprint,
      };
    if (path === '/api/digest-result') return { status: 'missing' };
    if (path === '/api/digest-batch-finish') {
      return { ok: true, settled: true, pending: false, released: false };
    }
    if (path === '/api/digest-cancel') return { ok: true };
    return { ok: true };
  },
  async postStream(path) {
    calls.push(path);
    const error = new Error('连接在请求发出后中断');
    error.outcomeUnknown = true;
    throw error;
  },
};

let returnedRun = null;
let caught = null;
try {
  returnedRun = await runDigestBatch(api, {
    accountId,
    accountFingerprint,
    targets: [{
      group_id: 'group-1',
      group_name: '目标群',
      since: '2026-08-01 00:00:00',
      until: '2026-08-02 00:00:00',
    }],
    onRecoveryPending: event => recoveryEvents.push(event),
  });
} catch (error) {
  caught = error;
} finally {
  returnedRun?.stopHeartbeat?.();
}

assert.equal(isMutationOutcomeUnknown(caught), true, '摘要写结果无法确认时必须把统一 unknown 分类抛给 UI');
assert.equal(calls.filter(path => path === '/api/digest').length, 1, '结果未知的摘要写请求绝不能重发');
assert.equal(calls.includes('/api/digest-result'), true, '结果未知后只能查询 digest-result 确认终态');
assert.equal(calls.includes('/api/digest-batch-finish'), false, '结果未知时不得 finish 释放仍可能执行的批次');
assert.equal(calls.includes('/api/digest-cancel'), false, '结果未知时不得自动 cancel');
assert.deepEqual(
  calls.filter(path => path !== '/api/digest-batch-start' && path !== '/api/digest'),
  ['/api/digest-result'],
  '摘要写发出后的恢复路径不得调用其他端点',
);
assert.equal(recoveryEvents.length, 1);
assert.equal(recoveryEvents[0].phase, 'terminal_results_pending_recovery');
assert.equal(recoveryEvents[0].index, 0);
assert.equal(recoveryEvents[0].accountId, accountId);
assert.equal(recoveryEvents[0].accountFingerprint, accountFingerprint);
assert.equal(recoveryEvents[0].batch.batch_id, caught.digestRecovery.batch_id);
assert.equal(recoveryEvents[0].target.group_id, 'group-1');

// SSE 写结果未知后，终态接口的结构也必须完整。status=done 但缺 digest
// 不能伪装成成功结果，否则页面会丢掉恢复意图并继续走空摘要渲染。
{
  const malformedCalls = [];
  const malformedResults = [];
  const malformedRecoveryEvents = [];
  const malformedApi = {
    getServiceInstanceId() { return 'service-instance-1234'; },
    async post(path, body) {
      malformedCalls.push(path);
      if (path === '/api/digest-batch-start') return {
        ok: true,
        batch_id: body.batch_id,
        service_instance_id: body.service_instance_id,
        account_id: body.account_id,
        account_fingerprint: accountFingerprint,
      };
      if (path === '/api/digest-result') return { status: 'done', digest: null };
      if (path === '/api/digest-batch-finish') {
        return { ok: true, settled: true, pending: false, released: false };
      }
      return { ok: true };
    },
    async postStream(path) {
      malformedCalls.push(path);
      const error = new Error('连接在请求发出后中断');
      error.outcomeUnknown = true;
      throw error;
    },
  };
  let malformedRun = null;
  let malformedError = null;
  try {
    malformedRun = await runDigestBatch(malformedApi, {
      accountId,
      accountFingerprint,
      targets: [{ group_id: 'group-malformed', group_name: '终态结构测试' }],
      onGroupResult: event => malformedResults.push(event),
      onRecoveryPending: event => malformedRecoveryEvents.push(event),
    });
  } catch (error) {
    malformedError = error;
  } finally {
    malformedRun?.stopHeartbeat?.();
  }
  assert.equal(isMutationOutcomeUnknown(malformedError), true,
    '缺失 digest 的 done 终态必须继续保留结果未知恢复语义');
  assert.deepEqual(malformedResults, [], '畸形终态不得提交成功群结果');
  assert.equal(malformedRecoveryEvents.length, 1, '畸形终态必须保留唯一恢复记录事件');
  assert.equal(malformedCalls.includes('/api/digest-batch-finish'), false,
    '畸形终态不得 finish 并释放仍需核对的批次');
}

// 服务端已经发送 done，但服务重启/恢复记录丢失时，紧接着的终态查询
// 可能合法返回 missing。这个请求已经被接受，不能把它降级为 done + null，
// 否则页面会清掉恢复记录并释放仍需核对的批次。
{
  const doneMissingCalls = [];
  const doneMissingRecoveryEvents = [];
  const doneMissingResults = [];
  const doneMissingApi = {
    getServiceInstanceId() { return 'service-instance-done-missing'; },
    async post(path, body) {
      doneMissingCalls.push(path);
      if (path === '/api/digest-batch-start') return {
        ok: true,
        batch_id: body.batch_id,
        service_instance_id: body.service_instance_id,
        account_id: body.account_id,
        account_fingerprint: accountFingerprint,
      };
      if (path === '/api/digest-result') return { status: 'missing' };
      if (path === '/api/digest-batch-finish') {
        return { ok: true, settled: true, pending: false, released: false };
      }
      return { ok: true };
    },
    async postStream(path) {
      doneMissingCalls.push(path);
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'event: done\ndata: {"digest_id":"server-done-but-recovery-missing"}\n\n',
          ));
          controller.close();
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    },
  };
  let doneMissingError = null;
  try {
    await runDigestBatch(doneMissingApi, {
      accountId,
      accountFingerprint,
      targets: [{ group_id: 'group-done-missing', group_name: 'done 后恢复记录缺失' }],
      onGroupResult: event => doneMissingResults.push(event),
      onRecoveryPending: event => doneMissingRecoveryEvents.push(event),
    });
  } catch (error) {
    doneMissingError = error;
  }
  assert.equal(isMutationOutcomeUnknown(doneMissingError), true,
    'done 后终态记录缺失仍是结果未知，不能投影为成功或普通失败');
  assert.deepEqual(doneMissingResults, [], 'done 后缺失终态不得提交群结果');
  assert.equal(doneMissingRecoveryEvents.length, 1,
    'done 后缺失终态必须保留唯一恢复事件');
  assert.equal(doneMissingCalls.filter(path => path === '/api/digest-result').length, 1,
    'done 后只查询一次终态，不得盲目重发摘要');
  assert.equal(doneMissingCalls.includes('/api/digest-batch-finish'), false,
    'done 后缺失终态不得释放仍需恢复的批次');
}

// 服务端终态已完成但 durable recovery 写入失败时，SSE 仍会交付当前摘要；
// runner 必须保留这个事实，页面才不会把唯一的本地恢复 marker 当成已安全收口。
{
  const unpersistedCalls = [];
  const unpersistedApi = {
    getServiceInstanceId() { return 'service-instance-unpersisted-terminal'; },
    async post(path, body) {
      unpersistedCalls.push(path);
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
      unpersistedCalls.push(path);
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'event: digest\ndata: {"digest_id":"unpersisted-terminal-digest","terminal_recovery_persisted":false,"terminal_recovery_code":"digest_terminal_persist_failed"}\n\n',
          ));
          controller.close();
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    },
  };
  const unpersistedRun = await runDigestBatch(unpersistedApi, {
    accountId,
    accountFingerprint,
    targets: [{ group_id: 'group-unpersisted-terminal', group_name: '恢复持久化失败' }],
  });
  assert.equal(unpersistedRun.results[0]?.terminal_recovery_persisted, false,
    'SSE 成功摘要必须向页面保留 terminal_recovery_persisted=false');
  await unpersistedRun.finish();
  assert.equal(unpersistedCalls.filter(path => path === '/api/digest-batch-finish').length, 1);
}

// error/skipped 也是服务端终态。恢复查询返回终态持久化失败时，结果顶层
// 必须保留这个 owner/marker 事实，页面才能阻止误删本地恢复记录。
for (const terminalStatus of ['error', 'skipped']) {
  const terminalCalls = [];
  const terminalApi = {
    getServiceInstanceId() { return `service-instance-${terminalStatus}`; },
    async post(path, body) {
      terminalCalls.push(path);
      if (path === '/api/digest-batch-start') return {
        ok: true,
        batch_id: body.batch_id,
        service_instance_id: body.service_instance_id,
        account_id: body.account_id,
        account_fingerprint: accountFingerprint,
      };
      if (path === '/api/digest-result') return {
        status: terminalStatus,
        error: { message: terminalStatus === 'error' ? '终态失败' : '消息数不足' },
        terminal_recovery_persisted: false,
        terminal_recovery_code: 'digest_terminal_persist_failed',
      };
      if (path === '/api/digest-batch-finish') {
        return { ok: true, settled: true, pending: false, released: false };
      }
      return { ok: true };
    },
    async postStream() {
      const error = new Error('连接在请求发出后中断');
      error.outcomeUnknown = true;
      throw error;
    },
  };
  const terminalRun = await runDigestBatch(terminalApi, {
    accountId,
    accountFingerprint,
    targets: [{ group_id: `group-${terminalStatus}`, group_name: terminalStatus }],
  });
  assert.equal(terminalRun.results[0]?.outcome, terminalStatus,
    `${terminalStatus} 终态必须从恢复响应投影到批次结果`);
  assert.equal(terminalRun.results[0]?.terminal_recovery_persisted, false,
    `${terminalStatus} 终态恢复持久化失败必须保留顶层 owner/marker 元数据`);
  await terminalRun.finish();
  assert.equal(terminalCalls.filter(path => path === '/api/digest-batch-finish').length, 1,
    `${terminalStatus} 终态恢复后仍必须可收尾批次 owner`);
}

{
  const controller = new AbortController();
  const cancelCalls = [];
  const cancelResults = [];
  const cancelApi = {
    getServiceInstanceId() { return 'service-instance-1234'; },
    async post(path, body) {
      cancelCalls.push(path);
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
      cancelCalls.push(path);
      controller.abort(new Error('用户明确取消'));
      throw controller.signal.reason;
    },
  };
  let cancelledRun = null;
  let cancelError = null;
  try {
    cancelledRun = await runDigestBatch(cancelApi, {
      accountId,
      accountFingerprint,
      signal: controller.signal,
      targets: [{ group_id: 'group-cancel', group_name: '取消目标' }],
      onGroupResult: event => cancelResults.push(event),
    });
  } catch (error) {
    cancelError = error;
  } finally {
    cancelledRun?.stopHeartbeat?.();
  }
  assert.equal(cancelError?.name, 'AbortError', '显式取消即使携带普通 Error reason 也必须归一为取消');
  assert.equal(isMutationOutcomeUnknown(cancelError), false);
  assert.equal(cancelCalls.includes('/api/digest-result'), false, '显式取消不得进入结果未知恢复轮询');
  assert.equal(cancelCalls.filter(path => path === '/api/digest-batch-finish').length, 1,
    '显式取消允许收尾释放批次');
  assert.equal(cancelResults.length, 1, '当前群从运行中取消时必须收到唯一终态结果');
  assert.equal(cancelResults[0].index, 0);
  assert.equal(cancelResults[0].outcome, 'cancelled');
  assert.equal(cancelResults[0].error?.cancelled, true);
}

// 批次创建是进入逐群写入前的协议闸门。200 + null/缺少批次凭据不能继续
// 启动 SSE，否则前端会把未确认的创建结果当成可用批次继续写入。
for (const [label, makeResponse] of [
  ['null', () => null],
  ['缺少 batch_id', body => ({
    ok: true,
    service_instance_id: body.service_instance_id,
    account_id: body.account_id,
    account_fingerprint: accountFingerprint,
  })],
]) {
  let streamCalls = 0;
  let finishCalls = 0;
  const malformedStartApi = {
    getServiceInstanceId() { return 'service-instance-1234'; },
    async post(path, body) {
      if (path === '/api/digest-batch-start') return makeResponse(body);
      if (path === '/api/digest-batch-finish') {
        finishCalls += 1;
        return { ok: true, settled: true, pending: false, released: false };
      }
      return { ok: true };
    },
    async postStream() {
      streamCalls += 1;
      throw new Error('畸形 start 响应不得进入 SSE');
    },
  };
  await assert.rejects(
    runDigestBatch(malformedStartApi, {
      accountId,
      accountFingerprint,
      targets: [{ group_id: `group-malformed-start-${label}`, group_name: '启动响应测试' }],
    }),
    error => error?.code === 'digest_batch_start_response_invalid'
      && error?.status === 502
      && isMutationOutcomeUnknown(error),
    `${label} 批次创建响应必须进入固定结果未知错误合同`,
  );
  assert.equal(streamCalls, 0, `${label} 响应不得启动逐群 SSE 写入`);
  assert.equal(finishCalls, 0, `${label} 响应不得盲目发送 finish`);
}

// finish 结果未知时不能把 finishedSent 提前锁死；调用方保留 owner 后，
// 后续显式收尾必须还能重试同一幂等服务端操作。
{
  let finishCalls = 0;
  let finishMode = 'throw';
  const finishApi = {
    getServiceInstanceId() { return 'service-instance-finish-retry'; },
    async post(path, body) {
      if (path === '/api/digest-batch-start') return {
        ok: true,
        batch_id: body.batch_id,
        service_instance_id: body.service_instance_id,
        account_id: body.account_id,
        account_fingerprint: accountFingerprint,
      };
      if (path === '/api/digest-batch-finish') {
        finishCalls += 1;
        if (finishMode === 'pending') {
          return { ok: true, settled: false, pending: true, released: false };
        }
        throw Object.assign(new Error('finish 结果未知'), { outcomeUnknown: true });
      }
      return { ok: true };
    },
    async postStream() {
      let reads = 0;
      return {
        body: {
          getReader() {
            return {
              async read() {
                reads += 1;
                if (reads === 1) {
                  return {
                    done: false,
                    value: new TextEncoder().encode(
                      'event: digest\ndata: {"digest_id":"finish-retry-digest"}\n\n',
                    ),
                  };
                }
                return { done: true };
              },
              cancel() { return Promise.resolve(); },
              releaseLock() {},
            };
          },
        },
      };
    },
  };
  const run = await runDigestBatch(finishApi, {
    accountId,
    accountFingerprint,
    targets: [{ group_id: 'group-finish-retry', group_name: '收尾重试测试' }],
  });
  assert.equal(await run.finish(), null, 'finish 未确认时不能伪装成成功');
  assert.equal(await run.finish(), null, 'finish 仍未确认时第二次也应保留未知结果');
  assert.equal(finishCalls, 2, 'finish 未确认后显式重试必须再次提交同一批次');
  run.stopHeartbeat();

  finishCalls = 0;
  finishMode = 'pending';
  const pendingRun = await runDigestBatch(finishApi, {
    accountId,
    accountFingerprint,
    targets: [{ group_id: 'group-finish-pending', group_name: '收尾 pending 测试' }],
  });
  assert.equal(await pendingRun.finish(), null,
    'settled=false/pending=true 不能伪装成已确认收尾');
  assert.equal(await pendingRun.finish(), null,
    'pending 收尾必须允许显式重试');
  assert.equal(finishCalls, 2, 'pending 收尾重试必须再次提交同一批次');
  pendingRun.stopHeartbeat();
}

console.log('web digest outcome unknown tests passed');
