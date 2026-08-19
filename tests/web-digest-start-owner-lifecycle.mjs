import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

globalThis.location = new URL('http://wx-summary.test/#/digest');
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.sessionStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { locks: null },
});

const loader = createBrowserModuleLoader();
const {
  cancelDigestBatch,
  digestBatchFinishConfirmed,
  digestBatchCancelConfirmed,
} = await loader.load(
  'js/pages/digest/batch-runner.js',
);
const source = await fs.readFile(
  new URL('../src/web/public/js/pages/digest/index.js', import.meta.url),
  'utf8',
);

function extractNamedFunction(sourceText, marker) {
  const start = sourceText.indexOf(marker);
  assert.ok(start >= 0, `生产摘要页必须包含 ${marker}`);
  const signatureEnd = sourceText.indexOf(') {', start);
  assert.ok(signatureEnd >= 0, `${marker} 必须有可定位的函数体`);
  const open = sourceText.indexOf('{', signatureEnd + 2);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < sourceText.length; index += 1) {
    const char = sourceText[index];
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
    else if (char === '}' && --depth === 0) return sourceText.slice(start, index + 1);
  }
  throw new Error(`${marker} 函数体未闭合`);
}

function extractObjectArrow(sourceText, marker) {
  const start = sourceText.indexOf(marker);
  assert.ok(start >= 0, `生产摘要页必须包含 ${marker}`);
  const arrow = sourceText.indexOf('=>', start);
  const open = sourceText.indexOf('{', arrow);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < sourceText.length; index += 1) {
    const char = sourceText[index];
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
    else if (char === '}' && --depth === 0) {
      return sourceText.slice(start, index + 1).replace(/^onBatchCreated:\s*/, '');
    }
  }
  throw new Error(`${marker} 函数体未闭合`);
}

const releaseSource = extractNamedFunction(source, 'async function releaseActiveBatch(');
const onBatchCreatedSource = extractObjectArrow(source, 'onBatchCreated: batch => {');

function makeDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createHarness(cancelResponse) {
  const page = {
    destroyed: false,
    activeBatch: null,
    activeBatchRelease: null,
  };
  const cancelCalls = [];
  const api = {
    getServiceInstanceId() { return 'service-start-owner'; },
    async post(path, body) {
      cancelCalls.push({ path, body });
      assert.equal(path, '/api/digest-cancel');
      return typeof cancelResponse === 'function' ? cancelResponse() : cancelResponse;
    },
  };
  const releaseActiveBatch = new Function(
    'page',
    'stopBatchKeepalive',
    'digestBatchFinishConfirmed',
    `${releaseSource}; return releaseActiveBatch;`,
  )(page, () => {}, digestBatchFinishConfirmed);
  const onBatchCreated = new Function(
    'page',
    'token',
    'alive',
    'previewText',
    'accountId',
    'fingerprint',
    'api',
    'cancelDigestBatch',
    'digestBatchCancelConfirmed',
    'registerRecord',
    'batchOwner',
    `return (${onBatchCreatedSource});`,
  )(
    page,
    1,
    () => true,
    false,
    'account-start-owner',
    'f'.repeat(64),
    api,
    cancelDigestBatch,
    digestBatchCancelConfirmed,
    () => true,
    null,
  );
  const batch = {
    batch_id: 'batch-start-owner',
    batch_token: 'token-start-owner',
    service_instance_id: 'service-start-owner',
  };
  onBatchCreated(batch);
  assert.ok(page.activeBatch, '生产 onBatchCreated 必须先安装占位 owner');
  assert.strictEqual(page.activeBatch.batch, batch);
  return { page, cancelCalls, releaseActiveBatch };
}

// 账号换代/卸载发生在 batch-start 仍在途时:取消请求挂起期间不能先清占位
// owner,否则 late start 会在服务端创建一个再也没有 caller 的批次。
{
  const cancel = makeDeferred();
  const harness = createHarness(() => cancel.promise);
  const owner = harness.page.activeBatch;
  const release = harness.releaseActiveBatch({ owner });
  await Promise.resolve();
  assert.equal(harness.cancelCalls.length, 1,
    '释放只有 batch 凭据的占位 owner 必须先向服务端发送取消');
  assert.strictEqual(harness.page.activeBatch, owner,
    '取消结果未确认前不得清除占位 owner');
  cancel.resolve({ ok: true, lease_released: true });
  assert.equal(await release, true,
    '服务端确认取消后才允许完成占位 owner 的释放');
  assert.equal(harness.page.activeBatch, null);
  assert.equal(harness.cancelCalls[0].body.batch_id, 'batch-start-owner');
}

// 服务端接受取消但仍在收尾时，placeholder owner 不能被当成已释放；
// 之后仍须允许页面/账号清理路径重试同一批次。
{
  const harness = createHarness({ ok: true, lease_released: false });
  const owner = harness.page.activeBatch;
  assert.equal(await harness.releaseActiveBatch({ owner }), false,
    '取消已接受但 lease 未释放时必须报告未释放');
  assert.strictEqual(harness.page.activeBatch, owner,
    'lease 未释放时必须保留 placeholder owner');
}

// 网络失败仍需保留 owner,让账号清理/恢复路径可以再次重试,不能把服务端
// 可能已经接受的 batch-start 变成无主 lease。
{
  const harness = createHarness(null);
  const owner = harness.page.activeBatch;
  assert.equal(await harness.releaseActiveBatch({ owner }), false,
    '占位 owner 取消失败时必须报告未释放');
  assert.strictEqual(harness.page.activeBatch, owner,
    '占位 owner 取消失败时必须保留以便重试');
}

console.log('web digest start owner lifecycle tests passed');
