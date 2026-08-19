import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

globalThis.location = new URL('http://wx-summary.test/#/digest');
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.sessionStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };

const indexSource = await readFile(
  new URL('../src/web/public/js/pages/digest/index.js', import.meta.url),
  'utf8',
);
const runnerSource = await readFile(
  new URL('../src/web/public/js/pages/digest/batch-runner.js', import.meta.url),
  'utf8',
);
const { runDigestBatch } = await createBrowserModuleLoader().load('js/pages/digest/batch-runner.js');

function extractFunction(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `必须能定位 ${marker}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '`' || char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${marker} 函数体未闭合`);
}

assert.match(
  runnerSource,
  /return \{ batch, started, results, account_fingerprint: fingerprint, finish, stopHeartbeat \};/,
  '批次执行器必须显式交出生成期心跳停止权',
);
assert.match(
  indexSource,
  /const activeBatch = \{\s*batch: run\.batch,\s*accountId,\s*accountFingerprint: fingerprint,\s*finish: run\.finish,\s*previewText,\s*results: run\.results,\s*\};\s*page\.activeBatch = activeBatch;\s*batchOwner = activeBatch;\s*run\.stopHeartbeat\?\.\(\);\s*startBatchKeepalive\(run\.batch\);/,
  '生成完成后必须先停掉 runner 心跳，再把唯一保活权交给页面结果阶段',
);

// runner 自己的心跳也不能依赖 clearInterval 撤回已入队 callback。
{
  const previousSetInterval = globalThis.setInterval;
  const previousClearInterval = globalThis.clearInterval;
  const timers = [];
  const cleared = new Set();
  const heartbeatCalls = [];
  globalThis.setInterval = callback => {
    timers.push(callback);
    return timers.length;
  };
  globalThis.clearInterval = timer => cleared.add(timer);
  try {
    const fingerprint = 'a'.repeat(64);
    const api = {
      getServiceInstanceId: () => 'service-a',
      async post(path, body) {
        if (path === '/api/digest-batch-start') return {
          ok: true,
          batch_id: body.batch_id,
          service_instance_id: body.service_instance_id,
          account_id: body.account_id,
          account_fingerprint: fingerprint,
        };
        heartbeatCalls.push(path);
        return { ok: true };
      },
      async postStream() {
        let readCount = 0;
        return { body: { getReader() {
          return {
            async read() {
              readCount += 1;
              if (readCount === 1) {
                return {
                  done: false,
                  value: new TextEncoder().encode(
                    'event: digest\ndata: {"digest_id":"digest-a"}\n\n',
                  ),
                };
              }
              return { done: true };
            },
            cancel() { return Promise.resolve(); },
            releaseLock() {},
          };
        } } };
      },
    };
    const run = await runDigestBatch(api, {
      accountId: 'account-a',
      accountFingerprint: fingerprint,
      targets: [{ group_id: 'group-a', group_name: 'group-a' }],
    });
    assert.equal(timers.length, 1, 'runner 必须注册一个 heartbeat timer');
    run.stopHeartbeat();
    assert.equal(cleared.has(1), true, 'runner stopHeartbeat 必须清理 timer');
    timers[0]();
    await Promise.resolve();
    assert.equal(heartbeatCalls.length, 0,
      'runner stopHeartbeat 后已排队 callback 不得发送旧批次 heartbeat');
  } finally {
    globalThis.setInterval = previousSetInterval;
    globalThis.clearInterval = previousClearInterval;
  }
}

// clearInterval 无法撤回已经进入事件队列的 callback;旧批次 callback 晚到时
// 必须由自己的 lease 识别已失效,不能在新批次/finish 之后再次发送 heartbeat。
{
  const startSource = extractFunction(indexSource, 'function startBatchKeepalive(batch)');
  const stopSource = extractFunction(indexSource, 'function stopBatchKeepalive()');
  const actionAbort = new AbortController();
  const page = { keepaliveTimer: null, destroyed: false, activeBatch: null };
  const timers = [];
  const cleared = new Set();
  const heartbeats = [];
  let resolveHeartbeat;
  const heartbeatPending = new Promise(resolve => { resolveHeartbeat = resolve; });
  const api = {
    post(path, body, options) {
      heartbeats.push({ path, body, options });
      return heartbeatPending;
    },
    getServiceInstanceId: () => 'service',
  };
  const keepalive = new Function(
    'page', 'api', 'BATCH_KEEPALIVE_MS', 'setInterval', 'clearInterval', 'actionAbort',
    `${startSource}; ${stopSource}; return { startBatchKeepalive, stopBatchKeepalive };`,
  )(
    page,
    api,
    900,
    callback => { timers.push(callback); return timers.length; },
    timer => cleared.add(timer),
    actionAbort,
  );
  const batch = {
    batch_id: 'batch-a',
    batch_token: 'token-a',
    service_instance_id: 'service-a',
  };
  page.activeBatch = { batch };
  keepalive.startBatchKeepalive(batch);
  assert.equal(timers.length, 1);
  keepalive.stopBatchKeepalive();
  assert.equal(cleared.has(1), true, '当前批次结束必须清理自己的 heartbeat timer');
  timers[0]();
  await Promise.resolve();
  assert.equal(heartbeats.length, 0,
    '已排队的旧 heartbeat callback 不得在批次释放后再次请求旧批次');

  keepalive.startBatchKeepalive(batch);
  timers[1]();
  assert.equal(heartbeats.length, 1, '当前 heartbeat callback 必须发起一次请求');
  assert.ok(heartbeats[0].options?.signal instanceof AbortSignal,
    '页面 keepalive 请求必须持有自己的 owner signal');
  assert.equal(heartbeats[0].options.signal.aborted, false);
  keepalive.stopBatchKeepalive();
  assert.equal(heartbeats[0].options.signal.aborted, true,
    '页面销毁或批次释放必须立即取消已经发出的 keepalive');
  resolveHeartbeat({ ok: true });
  await Promise.resolve();
}

// callback 已经发出请求后,停止自己的 lease 仍必须取消在途 I/O;
// 仅清 interval 不能阻止旧批次 heartbeat 晚到续租。
{
  const previousSetInterval = globalThis.setInterval;
  const previousClearInterval = globalThis.clearInterval;
  const timers = [];
  const cleared = new Set();
  let heartbeatOptions = null;
  let heartbeatCalls = 0;
  let resolveHeartbeat;
  const heartbeatPending = new Promise(resolve => { resolveHeartbeat = resolve; });
  globalThis.setInterval = callback => {
    timers.push(callback);
    return timers.length;
  };
  globalThis.clearInterval = timer => cleared.add(timer);
  try {
    const fingerprint = 'b'.repeat(64);
    const api = {
      getServiceInstanceId: () => 'service-b',
      async post(path, body, options) {
        if (path === '/api/digest-batch-start') return {
          ok: true,
          batch_id: body.batch_id,
          service_instance_id: body.service_instance_id,
          account_id: body.account_id,
          account_fingerprint: fingerprint,
        };
        heartbeatCalls += 1;
        heartbeatOptions = options;
        return heartbeatPending;
      },
      async postStream() {
        let readCount = 0;
        return { body: { getReader() {
          return {
            async read() {
              readCount += 1;
              if (readCount === 1) {
                return {
                  done: false,
                  value: new TextEncoder().encode(
                    'event: digest\ndata: {"digest_id":"digest-b"}\n\n',
                  ),
                };
              }
              return { done: true };
            },
            cancel() { return Promise.resolve(); },
            releaseLock() {},
          };
        } } };
      },
    };
    const run = await runDigestBatch(api, {
      accountId: 'account-b',
      accountFingerprint: fingerprint,
      targets: [{ group_id: 'group-b', group_name: 'group-b' }],
    });
    timers[0]();
    await Promise.resolve();
    assert.equal(heartbeatCalls, 1, 'heartbeat callback 必须已经发起一次真实请求');
    assert.ok(heartbeatOptions?.signal instanceof AbortSignal,
      'heartbeat 请求必须持有自己的 owner signal');
    assert.equal(heartbeatOptions.signal.aborted, false);
    run.stopHeartbeat();
    assert.equal(cleared.has(1), true, '停止 heartbeat 必须清理自己的 timer');
    assert.equal(heartbeatOptions.signal.aborted, true,
      '停止 heartbeat 必须立即取消已经发出的旧批次 heartbeat');
    resolveHeartbeat({ ok: true });
    await Promise.resolve();
  } finally {
    globalThis.setInterval = previousSetInterval;
    globalThis.clearInterval = previousClearInterval;
  }
}

console.log('web digest heartbeat ownership tests passed');
