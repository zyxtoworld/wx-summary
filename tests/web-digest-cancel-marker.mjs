import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';
import { createDigestAccountResultContextHandler } from '../src/web/public/js/pages/digest/account-result-state.js';
import { invalidateDigestAccountAsyncWork } from '../src/web/public/js/pages/digest/account-context.js';

globalThis.location = new URL('http://wx-summary.test/#/digest');
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.sessionStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { locks: null },
});

const loader = createBrowserModuleLoader();
const session = await loader.load('js/session.js');
const { createApi, isMutationOutcomeUnknown } = await loader.load('js/api.js');
const {
  digestBatchCancelConfirmed,
  digestBatchFailureNeedsRecovery,
  digestBatchFinishConfirmed,
  runDigestBatch: realRunDigestBatch,
  cancelDigestBatch: realCancelDigestBatch,
} = await loader.load(
  'js/pages/digest/batch-runner.js',
);
session.rememberSessionToken('digest-cancel-marker-session');
session.rememberServiceInstanceId('service-cancel-release-owner');

const source = fs.readFileSync(
  new URL('../src/web/public/js/pages/digest/index.js', import.meta.url),
  'utf8',
);

assert.match(source, /beforeClear\(change\)\s*\{[\s\S]*?page\.cancelGenerationOwner = null;/,
  '真实账号上下文清理必须使取消 owner 失效');
assert.match(source, /page\.destroyed = true;[\s\S]*?page\.cancelGenerationOwner = null;/,
  '真实页面卸载必须使取消 owner 失效');
assert.match(source, /if \(!generationAdmitted\) return;[\s\S]*?page\.cancelGenerationOwner = null;/,
  '真实新批次准入必须使旧取消 owner 失效');

function extractFunction(sourceText, marker) {
  const start = sourceText.indexOf(marker);
  assert.ok(start >= 0, `必须能定位生产函数 ${marker}`);
  const signatureEnd = sourceText.indexOf(') {', start);
  assert.ok(signatureEnd >= 0, `${marker} 必须有函数体`);
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

const startSource = extractFunction(source, 'async function startGeneration(previewText)');
const releaseSource = extractFunction(source, 'async function releaseActiveBatch(');
const forgetCancelledSource = extractFunction(source, 'function forgetCancelledBatchMarker(');
const beforeClearSource = extractFunction(source, 'beforeClear(change) {');
const cancelSource = extractFunction(source, 'async function cancelGeneration(reason = \'user_cancelled\')');

function makeNode(_tag = '', className = '', textContent = '') {
  return {
    children: [],
    hidden: false,
    className,
    textContent,
    dataset: {},
    firstElementChild: null,
    replaceChildren(...nodes) {
      this.children = nodes.filter(Boolean);
      this.firstElementChild = this.children[0] || null;
    },
    append(...nodes) { this.children.push(...nodes.filter(Boolean)); },
    appendChild(node) { if (node) this.children.push(node); return node; },
    querySelector(selector) {
      const className = String(selector || '').startsWith('.') ? String(selector).slice(1) : '';
      if (!className) return null;
      const queue = [...this.children];
      while (queue.length) {
        const node = queue.shift();
        if (String(node?.className || '').split(/\s+/).includes(className)) return node;
        queue.push(...(node?.children || []));
      }
      return null;
    },
  };
}

function settle() {
  return new Promise(resolve => setImmediate(resolve));
}

function createHarness(cancelOutcome, options = {}) {
  const page = {
    generation: 0,
    destroyed: false,
    generationStarting: false,
    running: false,
    saving: false,
    activeBatch: null,
    activeBatchRelease: null,
    abortController: null,
    progressView: null,
    progressCleanupTimer: null,
    doneResults: [],
    savedItems: new Map(),
    previewDigests: [],
    generationRender: null,
    renderOptions: { theme: 'auto', fontSize: 'normal', accentColor: '#07c160' },
    selected: new Set(['g1']),
    groupsStatus: 'ready',
    groups: [{ id: 'g1', name: 'group-1' }],
    minMessages: 1,
    rangeKey: 'yesterdayToday',
    customSince: '',
    customUntil: '',
    filters: {
      senders: [],
      keywords: [],
      exclude_types: [],
      pending_senders: '',
      pending_keywords: '',
    },
  };
  const account = {
    id: 'account-a',
    manual_key_account_fingerprint: options.accountFingerprint || 'f'.repeat(64),
  };
  const store = { get: key => (key === 'account' ? account : null) };
  const resultSlot = makeNode();
  const textPreviewSlot = makeNode();
  const batchResultSlot = makeNode();
  const progressSlot = makeNode();
  const scheduled = [];
  let nextTimer = 0;
  const fakeSetTimeout = callback => {
    scheduled.push(callback);
    nextTimer += 1;
    return nextTimer;
  };
  const fakeClearTimeout = () => {};
  const clearProgressCleanupTimer = new Function(
    'page',
    'clearTimeout',
    `${extractFunction(source, 'function clearProgressCleanupTimer()')}; return clearProgressCleanupTimer;`,
  )(page, fakeClearTimeout);
  const scheduleProgressCleanup = new Function(
    'page',
    'progressSlot',
    'clearProgressCleanupTimer',
    'setTimeout',
    `${extractFunction(source, 'function scheduleProgressCleanup(progressElement)')}; return scheduleProgressCleanup;`,
  )(page, progressSlot, clearProgressCleanupTimer, fakeSetTimeout);
  const calls = { cancel: 0, forgotten: 0, finalize: 0, warnings: 0, errors: [] };
  let markerPresent = false;
  let cancelClick = null;
  let resolveCancel;
  let rejectCancel;
  const cancelPromise = new Promise((resolve, reject) => {
    resolveCancel = resolve;
    rejectCancel = reject;
  });
  const view = {
    el: makeNode(),
    setTotal() {},
    setCurrentGroup() {},
    resetStages() {},
    onStage() {},
    log() {},
    setCancelling() {},
    setTerminal() {},
    dispose() {},
  };
  const createProgressView = ({ onCancel }) => {
    cancelClick = onCancel;
    return view;
  };
  const batch = {
    batch_id: 'batch-cancel-marker',
    batch_token: 'batch-token-cancel-marker',
    service_instance_id: 'service-cancel-marker',
  };
  const fakeRunDigestBatch = async (_api, runOptions) => {
    runOptions.onBatchCreated(batch);
    markerPresent = true;
    return new Promise((_resolve, reject) => {
      const rejectCancelled = () => {
        const error = Object.assign(new Error('已取消生成'), {
          name: 'AbortError',
          status: 499,
        });
        reject(error);
      };
      runOptions.signal.addEventListener('abort', rejectCancelled, { once: true });
      if (runOptions.signal.aborted) rejectCancelled();
    });
  };
  const fakeCancelDigestBatch = async () => {
    calls.cancel += 1;
    if (cancelOutcome === 'pending') return cancelPromise;
    if (cancelOutcome === 'throw') throw new Error('取消请求失败');
    return cancelOutcome;
  };
  const forgetInterruptedDigestBatch = () => {
    calls.forgotten += 1;
    markerPresent = false;
    return true;
  };
  const finalizeInterruptedDigestBatchRecord = error => {
    calls.finalize += 1;
    const cancelled = error?.name === 'AbortError' || error?.status === 499;
    if (cancelled) {
      // 当前生产 helper 的行为:取消错误立即删除 marker。红测要求这个调用
      // 必须在服务端取消明确成功后才发生。
      forgetInterruptedDigestBatch(batch.batch_id);
      return { retained: false, forgotten: true, phase: '' };
    }
    return { retained: true, forgotten: false, phase: 'starting_outcome_unknown' };
  };
  const forgetCancelledBatchMarker = owner => {
    if (owner?.cancelOnly !== true) return false;
    const batchId = String(owner.batch?.batch_id || '').trim();
    if (!batchId) return false;
    return forgetInterruptedDigestBatch(batchId) === true;
  };
  const fakeReleaseActiveBatch = async ({ owner = undefined } = {}) => {
    if (owner !== undefined && page.activeBatch !== owner) return false;
    if (options.releaseOwnerFinish && page.activeBatch?.finish) {
      const result = await page.activeBatch.finish();
      if (!digestBatchCancelConfirmed(result)) return false;
    }
    page.activeBatch = null;
    return true;
  };
  const startBatchKeepalive = () => {};
  const releaseActiveBatch = options.useRealRelease === true
    ? new Function(
      'page',
      'stopBatchKeepalive',
      'digestBatchFinishConfirmed',
      'startBatchKeepalive',
      `${releaseSource}; return releaseActiveBatch;`,
    )(page, () => {}, digestBatchFinishConfirmed, startBatchKeepalive)
    : fakeReleaseActiveBatch;
  const ui = {
    confirmDialog: async () => true,
    toastError(message) { calls.errors.push(String(message || '')); },
    toastWarn() { calls.warnings += 1; },
    toast() {},
    setGlobalProgress() {},
  };
  const lifecycle = () => ({ invalidate() {}, dispose() {} });
  const beforeClear = new Function(
    'page',
    'invalidateDigestAccountAsyncWork',
    'progressSlot',
    'clearProgressCleanupTimer',
    'cancelBtn',
    'ui',
    'taskScope',
    'resultOperation',
    'recoveryAction',
    'invalidateTextPreviewAction',
    'resultRenderState',
    'settingsDerived',
    'groupLoadScope',
    'renderGroupList',
    'renderRecentRefs',
    'syncSelectionUi',
    'releaseActiveBatch',
    'forgetInterruptedDigestBatch',
    `${forgetCancelledSource}; return ({${beforeClearSource}}).beforeClear;`,
  )(
    page,
    invalidateDigestAccountAsyncWork,
    progressSlot,
    clearProgressCleanupTimer,
    { hidden: false },
    ui,
    lifecycle(),
    lifecycle(),
    lifecycle(),
    () => {},
    lifecycle(),
    lifecycle(),
    lifecycle(),
    () => {},
    () => {},
    () => {},
    releaseActiveBatch,
    forgetInterruptedDigestBatch,
  );
  const accountResultContext = createDigestAccountResultContextHandler({
    state: page,
    slots: {
      recovery: makeNode(),
      batch: makeNode(),
      result: makeNode(),
      textPreview: makeNode(),
    },
    beforeClear,
  });
  const combinedSource = `${forgetCancelledSource}\n${startSource}\n${cancelSource}\nreturn { startGeneration, cancelGeneration };`;
  const { startGeneration, cancelGeneration } = new Function(
    'page',
    'store',
    'ui',
    'api',
    'digestInputsLocked',
    'accountIdOf',
    'accountFingerprintOf',
    'digestGenerationGroupAdmission',
    'currentRangeOrError',
    'generateBtn',
    'previewBtn',
    'root',
    'captureActionFocus',
    'setGenerationStarting',
    'releaseActiveBatch',
    'alive',
    'restoreActionFocus',
    'resultSlot',
    'textPreviewSlot',
    'batchResultSlot',
    'resultRenderState',
    'lockInputs',
    'createProgressView',
    'progressSlot',
    'freezeDigestRenderSelection',
    'el',
    'updatePreviewIdentity',
    'runDigestBatch',
    'startBatchKeepalive',
    'forgetInterruptedDigestBatch',
    'rememberInterruptedDigestBatch',
    'digestBatchHasUsableResult',
    'showTextPreview',
    'showImageResults',
    'digestBatchFailureNeedsRecovery',
    'isMutationOutcomeUnknown',
    'finalizeInterruptedDigestBatchRecord',
    'checkInterruptedRecovery',
    'clearProgressCleanupTimer',
    'scheduleProgressCleanup',
    'setTimeout',
    'clearTimeout',
    'digestBatchCancelConfirmed',
    'cancelDigestBatch',
    combinedSource,
  )(
    page,
    store,
    ui,
    options.api || {},
    () => page.generationStarting || page.running || page.saving,
    value => value.id,
    value => value.manual_key_account_fingerprint,
    () => ({ allowed: true }),
    () => ({ since: '2026-08-12 00:00:00', until: '2026-08-12 23:59:59' }),
    {},
    {},
    { contains: () => false },
    () => null,
    value => { page.generationStarting = value; },
    releaseActiveBatch,
    token => !page.destroyed && token === page.generation,
    () => {},
    resultSlot,
    textPreviewSlot,
    batchResultSlot,
    { invalidate() {} },
    value => { page.running = value; },
    createProgressView,
    progressSlot,
    () => ({ theme: 'auto', fontSize: 'normal', accentColor: '#07c160' }),
    (tag, className, text) => makeNode(tag, className, text),
    () => {},
    options.runDigestBatch || fakeRunDigestBatch,
    startBatchKeepalive,
    forgetInterruptedDigestBatch,
    () => { markerPresent = true; return true; },
    () => false,
    () => {},
    () => {},
    options.digestBatchFailureNeedsRecovery || (() => false),
    options.isMutationOutcomeUnknown || (() => false),
    finalizeInterruptedDigestBatchRecord,
    () => {},
    clearProgressCleanupTimer,
    scheduleProgressCleanup,
    fakeSetTimeout,
    fakeClearTimeout,
    digestBatchCancelConfirmed,
    options.cancelDigestBatch || fakeCancelDigestBatch,
  );
  return {
    page,
    calls,
    get markerPresent() { return markerPresent; },
    get cancelClick() { return cancelClick; },
    startGeneration,
    cancelGeneration,
    resolveCancel,
    rejectCancel,
    accountContextChanged() {
      return accountResultContext.handle({ status: 'changed' });
    },
  };
}

{
  const harness = createHarness('pending');
  const generation = harness.startGeneration(false);
  for (let index = 0; index < 10 && !harness.cancelClick; index += 1) await settle();
  assert.equal(typeof harness.cancelClick, 'function', '生成进度视图必须提供真实取消回调');
  harness.cancelClick();
  await settle();
  assert.equal(harness.calls.cancel, 1, '取消按钮必须只发起一次服务端取消');
  assert.equal(harness.calls.forgotten, 0,
    '服务端取消仍 pending 时不得删除本地恢复 marker');
  assert.equal(harness.markerPresent, true,
    '服务端取消仍 pending 时恢复 marker 必须保留');
  harness.resolveCancel(null);
  await generation;
  await settle();
  assert.equal(harness.calls.forgotten, 0,
    '服务端返回 null 时不得删除本地恢复 marker');
  assert.equal(harness.markerPresent, true,
    '服务端返回 null 时恢复 marker 必须保留以便重试');
}

{
  const harness = createHarness({ ok: true, lease_released: true });
  const generation = harness.startGeneration(false);
  for (let index = 0; index < 10 && !harness.cancelClick; index += 1) await settle();
  harness.cancelClick();
  await generation;
  await settle();
  assert.equal(harness.calls.cancel, 1);
  assert.equal(harness.calls.forgotten, 1,
    '只有服务端明确 {ok:true} 后才允许删除本地恢复 marker');
  assert.equal(harness.markerPresent, false);
}

{
  const harness = createHarness({ ok: true, lease_released: false });
  const generation = harness.startGeneration(false);
  for (let index = 0; index < 10 && !harness.cancelClick; index += 1) await settle();
  harness.cancelClick();
  await generation;
  await settle();
  assert.equal(harness.calls.cancel, 1);
  assert.equal(harness.calls.forgotten, 0,
    '取消请求已接受但服务端 lease 尚未释放时不得删除恢复 marker');
  assert.equal(harness.markerPresent, true,
    'lease 尚未释放时必须保留 marker 供后续收尾/恢复重试');
}

{
  const harness = createHarness('pending');
  const generation = harness.startGeneration(false);
  for (let index = 0; index < 10 && !harness.cancelClick; index += 1) await settle();
  assert.equal(typeof harness.cancelClick, 'function');
  harness.cancelClick();
  await settle();
  assert.equal(harness.calls.cancel, 1);

  // 这是实际账号 subscriber 的清理路径:推进 generation、abort 旧请求、
  // 清空 account-bound 结果并释放 active batch。取消请求仍在途时，旧回调
  // 不得在当前账号上下文中删除 marker。
  const change = harness.accountContextChanged();
  assert.equal(change.cleared, true);
  assert.equal(harness.page.activeBatch, null);

  harness.resolveCancel({ ok: true, lease_released: true });
  await generation;
  await settle();
  assert.equal(harness.calls.forgotten, 0,
    '账号上下文换代后旧取消响应不得清理当前恢复 marker');
  assert.equal(harness.markerPresent, true,
    '账号上下文换代后旧取消响应不得丢失恢复 marker');
}

{
  const harness = createHarness('pending');
  const generation = harness.startGeneration(false);
  for (let index = 0; index < 10 && !harness.cancelClick; index += 1) await settle();
  harness.cancelClick();
  await settle();
  harness.accountContextChanged();

  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  harness.rejectCancel(new Error('旧账号取消请求失败'));
  await generation;
  await settle();
  await settle();
  process.off('unhandledRejection', onUnhandled);

  assert.equal(unhandled.length, 0,
    '迟到的旧取消失败不得变成未处理 rejection');
  assert.equal(harness.calls.warnings, 0,
    '迟到的旧取消失败不得向新账号页面投影提示');
  assert.equal(harness.calls.forgotten, 0);
  assert.equal(harness.markerPresent, true);
}

{
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const start = deferred();
  let startBody = null;
  const cancelRequests = [];
  let notifyStart;
  const startRequested = new Promise(resolve => { notifyStart = resolve; });
  let streamCalls = 0;
  const api = {
    getServiceInstanceId() {
      return 'service-start-account-owner';
    },
    post(path, body) {
      if (path === '/api/digest-batch-start') {
        startBody = body;
        notifyStart(body);
        return start.promise;
      }
      if (path === '/api/digest-cancel') {
        const request = deferred();
        cancelRequests.push({ body, ...request });
        return request.promise;
      }
      if (path === '/api/digest-batch-finish') {
        return Promise.resolve({ ok: true, settled: true, pending: false, released: false });
      }
      throw new Error(`unexpected API call: ${path}`);
    },
    postStream() {
      streamCalls += 1;
      throw new Error('账号换代后的迟到 start 不得启动 SSE');
    },
  };
  const harness = createHarness(null, {
    api,
    runDigestBatch: realRunDigestBatch,
    cancelDigestBatch: realCancelDigestBatch,
    releaseOwnerFinish: true,
  });
  const generation = harness.startGeneration(false);
  await startRequested;
  assert.equal(harness.markerPresent, true, '批次创建后必须已经登记恢复 marker');
  harness.cancelClick();
  await settle();
  assert.equal(cancelRequests.length, 1, '取消按钮必须先发起自己的取消请求');

  // 账号订阅在真实页面会推进 generation 并释放 onBatchCreated 的 placeholder owner;
  // 该释放会发起第二个、独立的服务端取消请求。
  harness.accountContextChanged();
  await settle();
  assert.equal(cancelRequests.length, 2, '账号清理必须收尾页面仍持有的 placeholder owner');
  cancelRequests[1].resolve({ ok: true, lease_released: true });
  await settle();

  start.resolve({
    ok: true,
    batch_id: startBody.batch_id,
    service_instance_id: startBody.service_instance_id,
    account_id: startBody.account_id,
    account_fingerprint: 'f'.repeat(64),
  });
  await generation;
  assert.equal(streamCalls, 0, '账号换代后迟到 start 不得启动旧账号 SSE');

  cancelRequests[0].resolve({ ok: true, lease_released: true });
  await settle();
  assert.equal(harness.calls.forgotten, 1,
    '账号换代路径确认占位 owner 取消后必须清理该批次 marker');
  assert.equal(harness.markerPresent, false,
    '账号换代路径的旧取消响应不得再次改写已清理 marker');
}

// 账号换代直接释放仍在 start 阶段的占位 owner 时，服务端已经确认取消；
// 这条路径没有用户取消按钮可替它清理 marker，确认成功后也不得把已取消批次
// 留给 A→B→A 再次展示。
{
  const harness = createHarness({ ok: true, lease_released: true }, {
    releaseOwnerFinish: true,
  });
  const generation = harness.startGeneration(false);
  for (let index = 0; index < 10 && !harness.cancelClick; index += 1) await settle();
  assert.equal(typeof harness.cancelClick, 'function');
  await settle();
  assert.equal(harness.markerPresent, true, '占位 owner 创建后必须有恢复 marker');

  harness.accountContextChanged();
  await settle();
  assert.equal(harness.calls.cancel, 1, '账号清理必须取消占位批次');
  assert.equal(harness.calls.forgotten, 1,
    '账号清理确认服务端取消后必须清理该批次 marker');
  assert.equal(harness.markerPresent, false,
    '已确认取消的批次不得在切回原账号时重新出现');
  await generation;
}

// 结果未知后用户在同一账号再次点击生成，会先释放旧的 cancel-only owner；
// 旧 marker 必须在该释放确认后清掉，随后新批次可以登记自己的 marker。
{
  let runCount = 0;
  const harness = createHarness({ ok: true, lease_released: true }, {
    releaseOwnerFinish: true,
    digestBatchFailureNeedsRecovery: error => error?.outcomeUnknown === true,
    isMutationOutcomeUnknown: error => error?.outcomeUnknown === true,
    runDigestBatch: async (_api, runOptions) => {
      runCount += 1;
      runOptions.onBatchCreated({
        batch_id: `batch-retry-${runCount}`,
        batch_token: `batch-retry-token-${runCount}`,
        service_instance_id: 'service-retry',
      });
      throw Object.assign(new Error('摘要结果尚未确认'), {
        outcomeUnknown: true,
        digestRecovery: {
          phase: 'starting_outcome_unknown',
          batch_id: `batch-retry-${runCount}`,
          batch_index: -1,
        },
      });
    },
  });
  await harness.startGeneration(false);
  assert.equal(harness.markerPresent, true, '结果未知后旧恢复 marker 必须保留');
  assert.equal(harness.calls.forgotten, 0);

  await harness.startGeneration(false);
  assert.equal(runCount, 2, '旧 marker 保留时再次生成仍应经过真实准入释放旧 owner');
  assert.equal(harness.calls.cancel, 1, '再次生成必须取消旧的 cancel-only owner');
  assert.equal(harness.calls.forgotten, 1,
    '再次生成确认释放旧 owner 后必须只清理旧 marker');
  assert.equal(harness.markerPresent, true, '新批次应登记自己的恢复 marker');
}

// 真实 UI 交错：批次 start 已确认、SSE 请求在途，用户取消后 cancel 与
// runner 自己的 finish 并发收口。页面已经恢复生成按钮时不能继续残留一个
// 没有可用结果的 activeBatch，否则账号菜单会永久提示“结果仍绑定原账号”。
{
  const calls = { cancel: 0, finish: 0, stream: 0, streamError: null };
  const requestApi = createApi({ assetVersion: 'digest-cancel-marker-asset' });
  globalThis.fetch = async (_url, { signal } = {}) => {
    calls.stream += 1;
    // 模拟真实浏览器中已经发出的摘要 POST 忽略 abort。api.js 必须先把
    // 调用者取消投影为 499，同时保留写请求 outcomeUnknown 证据。
    return await new Promise(() => {
      void signal;
    });
  };
  const api = {
    getServiceInstanceId() { return 'service-cancel-release-owner'; },
    async post(path, body) {
      if (path === '/api/digest-batch-start') {
        return {
          ok: true,
          batch_id: body.batch_id,
          service_instance_id: body.service_instance_id,
          account_id: body.account_id,
          account_fingerprint: 'f'.repeat(64),
        };
      }
      if (path === '/api/digest-cancel') {
        calls.cancel += 1;
        return { ok: true, cancelled: true, lease_released: true };
      }
      if (path === '/api/digest-batch-finish') {
        calls.finish += 1;
        return { ok: true, settled: true, pending: false, released: true };
      }
      throw new Error(`unexpected API call: ${path}`);
    },
    postStream(path, body, options = {}) {
      return requestApi.postStream(path, body, options).catch(error => {
        calls.streamError = {
          name: error?.name,
          status: error?.status,
          outcomeUnknown: error?.outcomeUnknown,
        };
        throw error;
      });
    },
  };
  const harness = createHarness({ ok: true, cancelled: true, lease_released: true }, {
    api,
    runDigestBatch: realRunDigestBatch,
    cancelDigestBatch: realCancelDigestBatch,
    digestBatchFailureNeedsRecovery,
    isMutationOutcomeUnknown,
    useRealRelease: true,
  });
  const generation = harness.startGeneration(false);
  for (let index = 0; index < 20 && calls.stream === 0; index += 1) await settle();
  assert.equal(calls.stream, 1,
    `真实 batch runner 必须已进入 SSE 请求；state=${JSON.stringify({
      generationStarting: harness.page.generationStarting,
      running: harness.page.running,
      activeBatch: !!harness.page.activeBatch,
      cancelCalls: calls.cancel,
      finishCalls: calls.finish,
      errors: harness.calls.errors,
    })}`);
  assert.equal(typeof harness.cancelClick, 'function', '真实 batch runner 必须进入可取消生成态');
  harness.cancelClick();
  await generation;
  await settle();
  assert.equal(calls.cancel, 1, '用户取消必须只发一个取消请求');
  assert.equal(calls.finish, 1, 'runner 必须只收尾一次批次');
  assert.deepEqual(calls.streamError, {
    name: 'AbortError',
    status: 499,
    outcomeUnknown: true,
  }, '真实 api.js 必须保留“调用者取消 + 已发送写请求结果未知”的组合错误');
  assert.equal(harness.page.activeBatch, null,
    '取消已确认且无可用结果时必须释放 activeBatch，不能继续阻止账号切换');
}

console.log('web digest cancel marker tests passed');
