import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

globalThis.location = new URL('http://wx-summary.test/#/digest');
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.sessionStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { locks: null },
});

const loader = createBrowserModuleLoader();
const runner = await loader.load('js/pages/digest/batch-runner.js');
const indexSource = await readFile(
  new URL('../src/web/public/js/pages/digest/index.js', import.meta.url),
  'utf8',
);

function extractFunction(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `生产摘要页必须包含 ${marker}`);
  const signatureEnd = source.indexOf(') {', start);
  assert.ok(signatureEnd >= 0, `${marker} 必须有可定位的函数体`);
  const open = source.indexOf('{', signatureEnd + 2);
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
    if (char === String.fromCharCode(96) || char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${marker} 函数体未闭合`);
}

assert.equal(typeof runner.digestBatchHasUsableResult, 'function');
assert.equal(typeof runner.digestBatchFailureNeedsRecovery, 'function');
assert.equal(typeof runner.requireDigestBatchStartResult, 'function');

const startContract = {
  ok: true,
  batch_id: 'batch-start-contract',
  service_instance_id: 'service-start-contract',
  account_id: 'account-start-contract',
  account_fingerprint: 'b'.repeat(64),
};
assert.throws(
  () => runner.requireDigestBatchStartResult(startContract, {
    batchId: startContract.batch_id,
    serviceInstanceId: startContract.service_instance_id,
    accountId: startContract.account_id,
    accountFingerprint: 'a'.repeat(64),
  }),
  error => error?.code === 'digest_batch_start_response_invalid' && error?.outcomeUnknown === true,
  '批次启动响应即使 fingerprint 格式合法，也必须拒绝与请求账号身份不一致的响应',
);
assert.strictEqual(
  runner.requireDigestBatchStartResult(startContract, {
    batchId: startContract.batch_id,
    serviceInstanceId: startContract.service_instance_id,
    accountId: startContract.account_id,
    accountFingerprint: startContract.account_fingerprint,
  }),
  startContract,
  '批次启动响应与请求账号身份精确一致时才可进入后续分组请求',
);

assert.equal(runner.digestBatchHasUsableResult([
  { outcome: 'done', digest: { digest_id: 'digest-ok' } },
]), true, '有完整摘要时必须保留批次凭据给导出/保存操作');
assert.equal(runner.digestBatchHasUsableResult([
  { outcome: 'done', digest: null },
  { outcome: 'skipped', error: { code: 'digest_below_minimum' } },
  { outcome: 'error', error: { message: 'failed' } },
]), false, '没有可用摘要时不得继续占有批次');

const unknown = new Error('result unknown');
unknown.outcomeUnknown = true;
assert.equal(runner.digestBatchFailureNeedsRecovery(unknown), true,
  '结果未知时必须保留批次给确定性恢复');
const cancelled = new Error('cancelled');
cancelled.name = 'AbortError';
cancelled.status = 499;
assert.equal(runner.digestBatchFailureNeedsRecovery(cancelled), false,
  '明确取消已终止，不得伪装成结果未知继续持有批次');
assert.equal(runner.digestBatchFailureNeedsRecovery(new Error('rejected')), false);

// 旧生成在 showImageResults 的 await 期间被切换后,新账号可能已经持有 B 批次;
// 旧 owner 的收尾不得把 B 当成自己的批次释放。
{
  const releaseSource = extractFunction(indexSource, 'async function releaseActiveBatch(');
  const batchA = { batch: { batch_id: 'batch-a' }, finish: async () => {} };
  const batchB = { batch: { batch_id: 'batch-b' }, finish: async () => { throw new Error('B 不应被释放'); } };
  const page = { activeBatch: batchB, keepaliveTimer: 'batch-b-keepalive' };
  let stopCalls = 0;
  const releaseActiveBatch = new Function(
    'page',
    'stopBatchKeepalive',
    'digestBatchFinishConfirmed',
    `${releaseSource}; return releaseActiveBatch;`,
  )(page, () => { stopCalls += 1; }, runner.digestBatchFinishConfirmed);
  const released = await releaseActiveBatch({ owner: batchA });
  assert.equal(released, false, '旧 owner 收尾发现当前已是 B 时必须报告未持有');
  assert.strictEqual(page.activeBatch, batchB, '旧 owner 不得清掉新账号批次');
  assert.equal(stopCalls, 0, '旧 owner 不得停止新账号批次的心跳');
}

// 当前 owner 的正常收尾仍必须真正停止心跳、清空批次并把释放参数传给服务端。
{
  const releaseSource = extractFunction(indexSource, 'async function releaseActiveBatch(');
  const finishCalls = [];
  const batchA = {
    batch: { batch_id: 'batch-a' },
    finish: async options => {
      finishCalls.push(options);
      return { ok: true, settled: true, pending: false };
    },
  };
  const page = { activeBatch: batchA, keepaliveTimer: 'batch-a-keepalive' };
  let stopCalls = 0;
  const releaseActiveBatch = new Function(
    'page',
    'stopBatchKeepalive',
    'digestBatchFinishConfirmed',
    `${releaseSource}; return releaseActiveBatch;`,
  )(page, () => { stopCalls += 1; }, runner.digestBatchFinishConfirmed);
  const released = await releaseActiveBatch({
    owner: batchA,
    releasePreview: false,
    releaseTerminalResults: false,
  });
  assert.equal(released, true, '当前 owner 必须允许正常释放');
  assert.equal(page.activeBatch, null, '当前 owner 正常释放后不得继续占有批次');
  assert.equal(stopCalls, 1, '当前 owner 正常释放必须停止一次心跳');
  assert.deepEqual(finishCalls, [{ releasePreview: false, releaseTerminalResults: false }],
    '当前 owner 正常释放必须传递精确释放参数');
}

// 服务端 200 pending 是合法的“收尾仍在进行”,不能当成已确认释放。
{
  const releaseSource = extractFunction(indexSource, 'async function releaseActiveBatch(');
  const pendingBatch = {
    batch: { batch_id: 'batch-finish-pending' },
    finish: async () => ({ ok: true, settled: false, pending: true, released: false }),
  };
  const page = { activeBatch: pendingBatch, keepaliveTimer: 'batch-pending-keepalive' };
  let stopCalls = 0;
  const releaseActiveBatch = new Function(
    'page',
    'stopBatchKeepalive',
    'digestBatchFinishConfirmed',
    `${releaseSource}; return releaseActiveBatch;`,
  )(page, () => { stopCalls += 1; }, runner.digestBatchFinishConfirmed);
  const released = await releaseActiveBatch({ owner: pendingBatch });
  assert.equal(released, false, 'settled=false/pending=true 不能报告已释放');
  assert.strictEqual(page.activeBatch, pendingBatch,
    '服务端仍 pending 时必须保留当前批次 owner 以便重试');
  assert.equal(stopCalls, 1, 'pending 收尾仍只停止自己的心跳一次');
}

// pending 后的显式重试可以收到 settled=true/released=false:幂等收尾已确认，
// 本地应允许释放；只有 {ok:true} 没有终态字段时仍必须保留 owner。
{
  const releaseSource = extractFunction(indexSource, 'async function releaseActiveBatch(');
  const responses = [
    { ok: true, settled: false, pending: true, released: false },
    { ok: true, settled: true, pending: false, released: false },
  ];
  const retryBatch = {
    batch: { batch_id: 'batch-finish-retry' },
    finish: async () => responses.shift(),
  };
  const page = { activeBatch: retryBatch, keepaliveTimer: 'batch-retry-keepalive' };
  const releaseActiveBatch = new Function(
    'page',
    'stopBatchKeepalive',
    'digestBatchFinishConfirmed',
    `${releaseSource}; return releaseActiveBatch;`,
  )(page, () => {}, runner.digestBatchFinishConfirmed);
  assert.equal(await releaseActiveBatch({ owner: retryBatch }), false,
    '第一次 pending 收尾必须保留 owner');
  assert.strictEqual(page.activeBatch, retryBatch);
  assert.equal(await releaseActiveBatch({ owner: retryBatch }), true,
    'settled=true/released=false 仍是合法的最终收尾');
  assert.equal(page.activeBatch, null);
}

{
  const releaseSource = extractFunction(indexSource, 'async function releaseActiveBatch(');
  const invalidBatch = {
    batch: { batch_id: 'batch-finish-invalid' },
    finish: async () => ({ ok: true }),
  };
  const page = { activeBatch: invalidBatch, keepaliveTimer: 'batch-invalid-keepalive' };
  const releaseActiveBatch = new Function(
    'page',
    'stopBatchKeepalive',
    'digestBatchFinishConfirmed',
    `${releaseSource}; return releaseActiveBatch;`,
  )(page, () => {}, runner.digestBatchFinishConfirmed);
  assert.equal(await releaseActiveBatch({ owner: invalidBatch }), false,
    '缺少 settled 终态字段的 {ok:true} 不得释放 owner');
  assert.strictEqual(page.activeBatch, invalidBatch);
}

// finish 在途时若服务端拒绝/断开，A 不能因为 release 先清空 slot 而丢失；
// 但如果期间已经有 B 取得 slot，A 的失败收尾也不能覆盖 B。
{
  const releaseSource = extractFunction(indexSource, 'async function releaseActiveBatch(');
  const batchA = {
    batch: { batch_id: 'batch-finish-failed' },
    finish: async () => null,
  };
  const page = { activeBatch: batchA, keepaliveTimer: 'batch-a-keepalive' };
  let stopCalls = 0;
  const releaseActiveBatch = new Function(
    'page',
    'stopBatchKeepalive',
    'digestBatchFinishConfirmed',
    `${releaseSource}; return releaseActiveBatch;`,
  )(page, () => { stopCalls += 1; }, runner.digestBatchFinishConfirmed);
  const released = await releaseActiveBatch({ owner: batchA });
  assert.equal(released, false, 'finish 返回 null 时必须报告服务端收尾未确认');
  assert.strictEqual(page.activeBatch, batchA,
    'finish 失败且没有新 owner 时不得丢失当前批次所有权');
  assert.equal(stopCalls, 1, '失败收尾仍只停止自己的心跳一次');

  const batchB = { batch: { batch_id: 'batch-b' } };
  const handoffA = {
    batch: { batch_id: 'batch-finish-handoff' },
    finish: async () => {
      page.activeBatch = batchB;
      return null;
    },
  };
  page.activeBatch = handoffA;
  const handoffReleased = await releaseActiveBatch({ owner: handoffA });
  assert.equal(handoffReleased, false, 'A finish 未确认时交接路径也不能报告成功');
  assert.strictEqual(page.activeBatch, batchB,
    'A finish 未确认且 B 已接管时不得覆盖 B');
}

assert.match(
  indexSource,
  /if \(!digestBatchHasUsableResult\(run\.results\)\) \{\s*await releaseActiveBatch\(\{ owner: activeBatch \}\);\s*\}/,
  '正常返回但全部失败/跳过时，生产页必须释放批次',
);
assert.match(
  indexSource,
  /retainActiveBatchForRecovery = digestBatchFailureNeedsRecovery\(error\);[\s\S]*?if \(terminalError && !retainActiveBatchForRecovery\) \{\s*await releaseActiveBatch\(\{ owner: batchOwner \}\);\s*if \(!alive\(token\)\) return;\s*\}/,
  '明确取消/拒绝的生产路径必须在恢复记录收口后释放批次,并在 await 后停止旧代次收尾',
);

console.log('web digest batch ownership tests passed');
