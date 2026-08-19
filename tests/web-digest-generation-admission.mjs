import assert from 'node:assert/strict';
import fs from 'node:fs';
import { invalidateDigestAccountAsyncWork } from '../src/web/public/js/pages/digest/account-context.js';

const source = fs.readFileSync(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');
const digestBatchFinishConfirmed = value => !!value
  && typeof value === 'object'
  && value.ok === true
  && value.settled === true
  && value.pending !== true;
const digestBatchCancelConfirmed = value => !!value
  && typeof value === 'object'
  && value.ok === true
  && value.lease_released === true;

function extractFunction(sourceText, marker) {
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

const forgetCancelledSource = extractFunction(source, 'function forgetCancelledBatchMarker(');

assert.match(
  source,
  /const digestInputsLocked = \(\) =>[\s\S]*page\.generationStarting[\s\S]*page\.running[\s\S]*page\.saving[\s\S]*textPreviewAction\.isBusy\(\);/,
  '摘要输入的唯一忙态必须同时覆盖启动准备、生成运行、PNG 保存和文本结果操作',
);

const start = source.indexOf('async function startGeneration(previewText)');
const end = source.indexOf('\n  async function cancelGeneration', start);
assert.ok(start >= 0 && end > start, '必须能定位摘要生成启动流程');
const generation = source.slice(start, end);
assert.match(generation, /if \(digestInputsLocked\(\)\) return;/, '启动入口本身必须拒绝重入，不能只依赖按钮禁用');
assert.match(
  generation,
  /const startToken = page\.generation;[\s\S]*setGenerationStarting\(true\);[\s\S]*if \(!alive\(startToken\)\) return;[\s\S]*const releaseOwner = page\.activeBatch;[\s\S]*const released = await \(releaseOwner[\s\S]*releaseActiveBatch\(\{ owner: releaseOwner(?:,[\s\S]*?)? \}\)[\s\S]*forgetCancelledBatchMarker\(releaseOwner\)[\s\S]*generationAdmitted = released === true && alive\(startToken\);/,
  '释放上一批次前必须先确认启动代次仍然有效,释放必须绑定捕获 owner 并在确认后再准入',
);
assert.match(
  generation,
  /finally \{[\s\S]*setGenerationStarting\(false\);[\s\S]*if \(!generationAdmitted\)[\s\S]*restoreActionFocus\(generationFocusTarget/,
  '启动取消或过期时必须解除统一忙态并恢复触发焦点',
);
assert.match(
  generation,
  /if \(!generationAdmitted\) return;[\s\S]*lockInputs\(true\);/,
  '过期启动不得继续清空结果或进入真实生成忙态',
);

assert.match(
  source,
  /isRunning: \(\) => page\.generationStarting \|\| page\.running \|\| page\.saving\s*\|\| resultOperation\.isBusy\(\) \|\| recoveryAction\.isBusy\(\) \|\| textPreviewAction\.isBusy\(\)/,
  '路由守卫必须把启动准备期、PNG 保存期与结果本地动作都视为运行态',
);
assert.match(
  source,
  /function clearProgressCleanupTimer\(\)/,
  '摘要页必须提供可由页面销毁调用的进度卡延迟清理 disposer',
);
const destroySource = source.slice(source.indexOf('async destroy()'));
assert.match(
  destroySource,
  /clearProgressCleanupTimer\(\)/,
  '页面销毁必须撤销自己持有的进度卡延迟清理 timer',
);
const leaveStart = source.indexOf('async confirmLeaveWhileRunning()');
const leaveEnd = source.indexOf('\n    async init()', leaveStart);
assert.ok(leaveStart >= 0 && leaveEnd > leaveStart, '必须能定位摘要页离开守卫');
assert.match(
  source.slice(leaveStart, leaveEnd),
  /if \(page\.generationStarting\)[\s\S]*page\.generation \+= 1;/,
  '用户确认离开启动准备期时必须立即使尚未完成的启动失效',
);

// 真实 startGeneration 入口在确认框挂起时遇到程序化账号代际切换:
// 账号 beforeClear 释放 A 后，B 可在旧确认完成前取得新的 activeBatch。
// 旧入口不得再用无 owner 的收尾把 B 当成自己的批次释放。
{
  const generationSource = extractFunction(source, 'async function startGeneration(previewText)');
  const admissionEnd = generationSource.indexOf('\n    resultSlot.replaceChildren();');
  assert.ok(admissionEnd > 0, '必须能截取生产生成入口的确认/批次准入阶段');
  const admissionSource = `${generationSource.slice(0, admissionEnd)}\n  }`;
  const releaseSource = extractFunction(source, 'async function releaseActiveBatch(');
  const page = {
    generation: 0,
    destroyed: false,
    generationStarting: false,
    activeBatch: null,
    minMessages: 100,
    groupsStatus: 'ready',
    groups: [{ id: 'g1', name: 'group-1' }],
    selected: new Set(['g1']),
  };
  let currentAccount = { id: 'account-a', manual_key_account_fingerprint: 'fingerprint-a' };
  const store = { get: key => (key === 'account' ? currentAccount : null) };
  let resolveBatchA;
  const batchAFinished = new Promise(resolve => { resolveBatchA = resolve; });
  let batchBFinishCalls = 0;
  const batchA = {
    batch: { batch_id: 'batch-a' },
    finish: () => batchAFinished,
  };
  const batchB = {
    batch: { batch_id: 'batch-b' },
    finish: async () => {
      batchBFinishCalls += 1;
      return { ok: true };
    },
  };
  page.activeBatch = batchA;
  let stopKeepaliveCalls = 0;
  const releaseActiveBatch = new Function(
    'page',
    'stopBatchKeepalive',
    'digestBatchFinishConfirmed',
    `${releaseSource}; return releaseActiveBatch;`,
  )(page, () => { stopKeepaliveCalls += 1; }, digestBatchFinishConfirmed);
  const makeDeferred = () => {
    let resolve;
    const promise = new Promise(nextResolve => { resolve = nextResolve; });
    return { promise, resolve };
  };
  const confirmationA = makeDeferred();
  const confirmationB = makeDeferred();
  const confirmations = [confirmationA, confirmationB];
  const ui = {
    confirmDialog: () => confirmations.shift().promise,
    toastError() {},
    toastWarn() {},
  };
  const startGeneration = new Function(
    'page',
    'store',
    'ui',
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
    'forgetCancelledBatchMarker',
    `${admissionSource}; return startGeneration;`,
  )(
    page,
    store,
    ui,
    () => page.generationStarting,
    value => value.id,
    value => value.manual_key_account_fingerprint,
    () => ({ allowed: true }),
    () => ({ since: '2026-08-12 00:00:00', until: '2026-08-12 23:59:59' }),
    {},
    {},
    { contains: () => false },
    () => null,
    starting => { page.generationStarting = starting; },
    releaseActiveBatch,
    token => !page.destroyed && token === page.generation,
    () => {},
    () => false,
  );

  const pendingStart = startGeneration(false);
  await Promise.resolve();
  assert.equal(page.generationStarting, true, '确认框等待期间必须持有生成启动态');

  // 这是生产账号 beforeClear 的代际失效与旧批次释放顺序。
  invalidateDigestAccountAsyncWork(page, 'account changed');
  page.generationStarting = false;
  currentAccount = { id: 'account-b', manual_key_account_fingerprint: 'fingerprint-b' };
  const oldBatchRelease = releaseActiveBatch({ releaseTerminalResults: true, releasePreview: true });
  assert.strictEqual(page.activeBatch, batchA,
    '账号清理等待服务端确认期间必须保留 A 的 activeBatch owner');
  page.activeBatch = batchB;
  const pendingB = startGeneration(false);
  await Promise.resolve();
  assert.equal(page.generationStarting, true, 'B 生成确认挂起时必须重新持有启动态');
  confirmationA.resolve(true);
  await pendingStart;
  assert.strictEqual(page.activeBatch, batchB,
    '账号切换后旧确认协程不得用无 owner 收尾清掉 B 批次');
  assert.equal(batchBFinishCalls, 0, '旧确认协程不得调用 B 的 finish');
  assert.equal(stopKeepaliveCalls, 1, 'A 的账号清理只能停止自己的心跳');
  assert.equal(page.generationStarting, true,
    '旧确认协程不得在 B 确认挂起时解除 B 的生成启动态');
  confirmationB.resolve(false);
  await pendingB;
  resolveBatchA({ ok: true, settled: true, pending: false, released: false });
  await oldBatchRelease;
}

// 真实生成收尾时序: A 的异常收尾正在等待服务端 finish,账号上下文切到 B
// 并建立了新的批次/进度后,A 的 finally 不得再清掉 B 的共享页面状态。
{
  const generationSource = extractFunction(source, 'async function startGeneration(previewText)');
  const releaseSource = extractFunction(source, 'async function releaseActiveBatch(');
  const makeNode = () => ({
    children: [],
    hidden: false,
    className: '',
    disabled: false,
    append(...nodes) { this.children.push(...nodes.filter(Boolean)); },
    appendChild(node) { if (node) this.children.push(node); return node; },
    replaceChildren(...nodes) { this.children = nodes.filter(Boolean); },
    querySelector() { return null; },
  });
  const page = {
    generation: 0,
    destroyed: false,
    generationStarting: false,
    running: false,
    saving: false,
    activeBatch: null,
    abortController: null,
    progressView: null,
    progressCleanupTimer: null,
    doneResults: [],
    savedItems: new Map(),
    previewDigests: [],
    generationRender: null,
    renderOptions: { theme: 'auto', fontSize: 'normal' },
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
  const resultSlot = makeNode();
  const textPreviewSlot = makeNode();
  const batchResultSlot = makeNode();
  const progressSlot = makeNode();
  const root = { contains: () => false };
  const generateBtn = {};
  const previewBtn = {};
  const resultRenderState = { invalidate() {} };
  const oldProgress = {
    el: makeNode(),
    terminalCalls: 0,
    disposeCalls: 0,
    setTotal() {},
    setCurrentGroup() {},
    resetStages() {},
    onStage() {},
    log() {},
    setTerminal() { this.terminalCalls += 1; },
    dispose() { this.disposeCalls += 1; },
  };
  const newProgress = { el: makeNode() };
  let createdProgress = null;
  const progressViewFactory = () => {
    createdProgress = oldProgress;
    return oldProgress;
  };
  let globalProgress = [];
  const ui = {
    setGlobalProgress(value) { globalProgress.push(value); },
    toastError() {},
    toastWarn() {},
    toast() {},
  };
  const currentAccount = { id: 'account-a', manual_key_account_fingerprint: 'fingerprint-a' };
  const store = { get: key => (key === 'account' ? currentAccount : null) };
  const batchB = {
    batch: { batch_id: 'batch-b' },
    finish: async () => ({ ok: true, settled: true, pending: false, released: false }),
  };
  let resolveFinish;
  let finishCalls = 0;
  const finishPending = new Promise(resolve => { resolveFinish = resolve; });
  const batchA = {
    batch: { batch_id: 'batch-a' },
    finish: () => {
      finishCalls += 1;
      // 模拟生产 account subscriber 的同步清理和 B 代次建立。
      page.generation += 1;
      page.generationStarting = false;
      page.running = true;
      page.saving = false;
      page.activeBatch = batchB;
      page.progressView = newProgress;
      page.previewDigests = ['B'];
      oldProgress.dispose();
      globalProgress.push(true);
      return finishPending;
    },
  };
  const pageReleaseActiveBatch = new Function(
    'page',
    'stopBatchKeepalive',
    'digestBatchFinishConfirmed',
    `${releaseSource}; return releaseActiveBatch;`,
  )(page, () => {}, digestBatchFinishConfirmed);
  const runDigestBatch = async (_api, options) => {
    options.onBatchCreated(batchA.batch);
    return {
      batch: batchA.batch,
      finish: batchA.finish,
      results: [{ outcome: 'done', digest: { digest_id: 'digest-a' } }],
      stopHeartbeat() {},
    };
  };
  const clearProgressCleanupTimer = new Function(
    'page',
    'clearTimeout',
    `${extractFunction(source, 'function clearProgressCleanupTimer()')}; return clearProgressCleanupTimer;`,
  )(page, () => {});
  const startGeneration = new Function(
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
    'runDigestBatch',
    'cancelDigestBatch',
    'startBatchKeepalive',
    'forgetInterruptedDigestBatch',
    'rememberInterruptedDigestBatch',
    'digestBatchHasUsableResult',
    'showTextPreview',
    'digestBatchFailureNeedsRecovery',
    'isMutationOutcomeUnknown',
    'finalizeInterruptedDigestBatchRecord',
    'checkInterruptedRecovery',
    'clearProgressCleanupTimer',
    'scheduleProgressCleanup',
    `${forgetCancelledSource}\n${generationSource}; return startGeneration;`,
  )(
    page,
    store,
    ui,
    {},
    () => page.generationStarting || page.running || page.saving,
    account => account.id,
    account => account.manual_key_account_fingerprint,
    () => ({ allowed: true }),
    () => ({ since: '2026-08-12 00:00:00', until: '2026-08-12 23:59:59' }),
    generateBtn,
    previewBtn,
    root,
    () => null,
    starting => { page.generationStarting = starting; },
    pageReleaseActiveBatch,
    token => !page.destroyed && token === page.generation,
    () => {},
    resultSlot,
    textPreviewSlot,
    batchResultSlot,
    resultRenderState,
    locked => { page.running = locked; },
    progressViewFactory,
    progressSlot,
    () => ({ theme: 'auto', fontSize: 'normal', accentColor: '#07c160' }),
    () => makeNode(),
    runDigestBatch,
    async () => ({ ok: true, lease_released: true }),
    () => {},
    () => {},
    () => {},
    () => false,
    () => { throw new Error('render failed'); },
    () => false,
    () => false,
    () => ({ retained: false }),
    () => {},
    clearProgressCleanupTimer,
    () => {},
  );

  const pending = startGeneration(true);
  for (let index = 0; index < 32 && finishCalls === 0; index += 1) {
    await Promise.resolve();
  }
  assert.equal(createdProgress, oldProgress, 'A 必须真实建立自己的进度视图');
  assert.equal(finishCalls, 1, 'A 异常收尾必须等待自己的批次 finish');
  assert.equal(page.activeBatch, batchB, 'B 必须在 A finish 等待期间取得新的批次所有权');
  assert.equal(page.running, true, 'B 批次在 A finish 等待期间必须保持运行态');
  resolveFinish({ ok: true, settled: true, pending: false, released: false });
  await pending;
  assert.equal(page.activeBatch, batchB, 'A 的 finally 不得清掉 B 的批次');
  assert.equal(page.progressView, newProgress, 'A 的 finally 不得清掉 B 的进度视图');
  assert.equal(page.running, true, 'A 的 finally 不得解除 B 的运行态');
  assert.equal(globalProgress.at(-1), true, 'A 的 finally 不得关闭 B 的全局进度');
  assert.equal(oldProgress.terminalCalls, 0, 'A 的旧进度视图在账号清理后不得再结算');
  assert.equal(oldProgress.disposeCalls, 1, 'A 的旧进度视图只允许由账号清理释放一次');
}

// 无产出批次会延迟收起自己的进度卡。这个 timer 不能跨后续真实生成入口：
// A 的旧 timer 触发时，如果 B 已经完成并把自己的进度节点留在同一 slot，
// 只能保留 B；同时没有后继批次时仍应正常清掉 A 自己的节点。
{
  const generationSource = extractFunction(source, 'async function startGeneration(previewText)');
  const releaseSource = extractFunction(source, 'async function releaseActiveBatch(');
  const makeNode = label => ({
    label,
    children: [],
    hidden: false,
    className: '',
    disabled: false,
    dataset: {},
    get firstElementChild() { return this.children[0] || null; },
    append(...nodes) { this.children.push(...nodes.filter(Boolean)); },
    appendChild(node) { if (node) this.children.push(node); return node; },
    replaceChildren(...nodes) { this.children = nodes.filter(Boolean); },
    querySelector() { return null; },
  });
  const page = {
    generation: 0,
    destroyed: false,
    generationStarting: false,
    running: false,
    saving: false,
    activeBatch: null,
    abortController: null,
    progressView: null,
    doneResults: [],
    savedItems: new Map(),
    previewDigests: [],
    generationRender: null,
    renderOptions: { theme: 'auto', fontSize: 'normal' },
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
  const resultSlot = makeNode('result');
  const textPreviewSlot = makeNode('text-preview');
  const batchResultSlot = makeNode('batch-result');
  const progressSlot = makeNode('progress');
  const progressViews = ['A-own', 'A-stale', 'B-current', 'storage-failure', 'cleanup-failure', 'server-unpersisted', 'error-terminal', 'render-failure'].map(label => ({
    label,
    el: makeNode(label),
    setTotal() {},
    setCurrentGroup() {},
    resetStages() {},
    onStage() {},
    log() {},
    setTerminal() {},
    dispose() {},
  }));
  const scheduled = [];
  const clearedTimers = [];
  let runCount = 0;
  let rememberCalls = 0;
  let forgetCalls = 0;
  const toastWarnings = [];
  let renderFailure = null;
  const runDigestBatch = async (_api, options) => {
    runCount += 1;
    const batch = { batch_id: `batch-${runCount}` };
    options.onBatchCreated(batch);
    if (runCount === 4) {
      throw Object.assign(new Error('摘要连接断开'), {
        outcomeUnknown: true,
        digestRecovery: {
          phase: 'terminal_results_pending_recovery',
          batch_id: batch.batch_id,
          batch_index: 0,
        },
      });
    }
    const results = runCount < 3
      ? []
      : runCount === 7
        ? [{
          outcome: 'error',
          error: { message: '终态错误' },
          terminal_recovery_persisted: false,
        }]
        : [{
          outcome: 'done',
          digest: { digest_id: 'digest-b' },
          ...([6, 8].includes(runCount) ? { terminal_recovery_persisted: false } : {}),
        }];
    return {
      batch,
      results,
      finish: async () => ({ ok: true, settled: true, pending: false, released: false }),
      stopHeartbeat() {},
    };
  };
  const releaseActiveBatch = new Function(
    'page',
    'stopBatchKeepalive',
    'digestBatchFinishConfirmed',
    `${releaseSource}; return releaseActiveBatch;`,
  )(page, () => {}, digestBatchFinishConfirmed);
  const rememberInterruptedDigestBatch = () => {
    rememberCalls += 1;
    return runCount !== 4;
  };
  const forgetInterruptedDigestBatch = () => {
    forgetCalls += 1;
    return runCount !== 5;
  };
  const currentAccount = { id: 'account-a', manual_key_account_fingerprint: 'fingerprint-a' };
  const clearProgressCleanupTimer = new Function(
    'page',
    'clearTimeout',
    `${extractFunction(source, 'function clearProgressCleanupTimer()')}; return clearProgressCleanupTimer;`,
  )(page, timer => { clearedTimers.push(timer); });
  const scheduleProgressCleanup = new Function(
    'page',
    'progressSlot',
    'clearProgressCleanupTimer',
    'setTimeout',
    `${extractFunction(source, 'function scheduleProgressCleanup(progressElement)')}; return scheduleProgressCleanup;`,
  )(
    page,
    progressSlot,
    clearProgressCleanupTimer,
    callback => { scheduled.push(callback); return scheduled.length; },
  );
  const startGeneration = new Function(
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
    'runDigestBatch',
    'cancelDigestBatch',
    'digestBatchCancelConfirmed',
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
    `${forgetCancelledSource}\n${generationSource}; return startGeneration;`,
  )(
    page,
    { get: key => (key === 'account' ? currentAccount : null) },
    {
      setGlobalProgress() {},
      toastError() {},
      toastWarn(message) { toastWarnings.push(String(message || '')); },
      toast(message) { toastWarnings.push(String(message || '')); },
    },
    {},
    () => page.generationStarting || page.running || page.saving,
    account => account.id,
    account => account.manual_key_account_fingerprint,
    () => ({ allowed: true }),
    () => ({ since: '2026-08-12 00:00:00', until: '2026-08-12 23:59:59' }),
    {},
    {},
    { contains: () => false },
    () => null,
    starting => { page.generationStarting = starting; },
    releaseActiveBatch,
    token => !page.destroyed && token === page.generation,
     () => {},
    resultSlot,
    textPreviewSlot,
    batchResultSlot,
    { invalidate() {} },
    locked => { page.running = locked; },
    () => progressViews[runCount],
    progressSlot,
    () => ({ theme: 'auto', fontSize: 'normal', accentColor: '#07c160' }),
    (_tag, className = '', text = '') => Object.assign(makeNode(text), { className, textContent: text }),
    runDigestBatch,
    async () => ({ ok: true, lease_released: true }),
    digestBatchCancelConfirmed,
    () => {},
    forgetInterruptedDigestBatch,
    rememberInterruptedDigestBatch,
    results => results.some(item => item?.outcome === 'done' && item?.digest),
     () => {},
     () => {
       if (renderFailure) throw renderFailure;
     },
     () => false,
     error => error?.outcomeUnknown === true,
     (error, { batchId } = {}) => {
       if (!error) return { retained: false, forgotten: false };
       if (error?.outcomeUnknown === true) return { retained: false, forgotten: false };
      return {
        retained: false,
        forgotten: forgetInterruptedDigestBatch(batchId),
      };
    },
    () => {},
    clearProgressCleanupTimer,
    scheduleProgressCleanup,
    callback => { scheduled.push(callback); return scheduled.length; },
    timer => { clearedTimers.push(timer); },
  );

  await startGeneration(false);
  assert.equal(scheduled.length, 1, '首个无产出批次必须安排一次延迟收起');
  assert.equal(page.progressCleanupTimer, 1,
    '无产出批次的延迟清理必须登记为页面拥有的 timer');
  assert.strictEqual(progressSlot.firstElementChild, progressViews[0].el);
  scheduled.shift()();
  assert.equal(page.progressCleanupTimer, null,
    '延迟清理执行后必须释放页面对 timer 的所有权');
  assert.equal(progressSlot.firstElementChild, null,
    '没有后继批次时，延迟清理必须收起自己拥有的无产出进度卡');

  await startGeneration(false);
  assert.equal(scheduled.length, 1, '第二个无产出批次必须安排自己的延迟收起');
  const pendingCleanupTimer = page.progressCleanupTimer;
  assert.notEqual(pendingCleanupTimer, null, '第二个批次必须拥有独立的延迟清理 timer');
  page.destroyed = true;
  clearProgressCleanupTimer();
  assert.equal(page.progressCleanupTimer, null,
    '页面销毁时必须立即释放延迟清理 timer 所有权');
  assert.deepEqual(clearedTimers, [pendingCleanupTimer],
    '页面销毁只能撤销当前批次自己的延迟清理 timer');
  page.destroyed = false;
  await startGeneration(false);
  assert.strictEqual(progressSlot.firstElementChild, progressViews[2].el,
    '第三个真实生成入口必须安装自己的当前进度节点');
  assert.equal(page.running, false, 'B 快速完成后会回到可再次操作的非运行态');
  scheduled.shift()();
  assert.strictEqual(progressSlot.firstElementChild, progressViews[2].el,
    'A 的旧延迟清理不得在 B 已完成后清掉 B 的进度节点');

  // 真实结果未知但恢复记录写入失败时，不能提示用户去一个不存在的恢复卡片。
  // 当前 registerRecord 无条件把 rememberInterruptedDigestBatch(false) 当成成功，
  // 因而这条断言先固定为红态。
  await startGeneration(false);
  assert.equal(runCount, 4, '存储故障场景必须真实进入第四次未知结果批次');
  assert.ok(rememberCalls >= 4, '生产入口必须真实尝试登记中断恢复记录');
  assert.equal(
    toastWarnings.some(message => message.includes('未完成的批次')),
    false,
    '恢复记录持久化失败时不得提示用户去不存在的“未完成的批次”恢复',
  );
  assert.match(
    toastWarnings.at(-1) || '',
    /恢复记录.*(无法|失败)|浏览器.*存储/,
    '恢复记录持久化失败必须给出可操作的存储故障提示',
  );

  // 成功批次的恢复记录清理失败时，旧记录会继续留在 storage；不能无提示地
  // 把本次 UI 当成完全收口，否则下次打开页面会看到已完成批次的假恢复卡。
  toastWarnings.length = 0;
  await startGeneration(false);
  assert.equal(runCount, 5, '恢复记录清理失败场景必须真实进入后续成功批次');
  assert.ok(forgetCalls >= 4, '成功批次必须真实尝试清理自己的恢复记录');
  assert.match(
    toastWarnings.at(-1) || '',
    /恢复记录.*(清理|存储)|浏览器.*存储/,
    '恢复记录清理失败必须给出可操作提示，不能静默留下过期恢复记录',
  );

  // 服务端摘要已成功但 durable recovery 写入失败时，当前结果仍可使用；
  // 本地 marker 不能被无条件删除，否则服务重启前的唯一恢复证据会消失。
  toastWarnings.length = 0;
  const forgetBeforeUnpersisted = forgetCalls;
  await startGeneration(false);
  assert.equal(runCount, 6, '服务端恢复持久化失败场景必须真实进入下一次成功批次');
  assert.equal(forgetCalls, forgetBeforeUnpersisted,
    'terminal_recovery_persisted=false 时不得清理本地恢复 marker');
  assert.match(
    toastWarnings.at(-1) || '',
    /服务端.*(恢复|持久化).*失败|重启后.*恢复/,
    '服务端恢复持久化失败必须提示当前结果可用但重启恢复受限',
  );

  // 同一 owner 的 error 终态也必须把未持久化事实交给页面；即使没有可展示的
  // 摘要，页面仍不能把本地 marker 当成已安全收口。
  const forgetBeforeErrorTerminal = forgetCalls;
  toastWarnings.length = 0;
  await startGeneration(false);
  assert.equal(runCount, 7, 'error 终态恢复场景必须真实进入下一次生成收尾');
  assert.equal(forgetCalls, forgetBeforeErrorTerminal,
    'error 终态 terminal_recovery_persisted=false 时不得清理本地恢复 marker');
  assert.match(
    toastWarnings.at(-1) || '',
    /服务端.*(恢复|持久化).*失败|重启后.*恢复/,
    'error 终态恢复持久化失败必须保留可操作提示',
  );

  // 服务端已返回未持久化终态后，本地渲染失败不能删除唯一恢复 marker。
  // marker 代表服务端终态尚未可靠落盘，不能被后续普通 UI 错误覆盖。
  const forgetBeforeRenderFailure = forgetCalls;
  renderFailure = new Error('本地渲染失败');
  await startGeneration(false);
  renderFailure = null;
  assert.equal(runCount, 8, '未持久化终态的本地渲染失败必须真实进入下一次生成收尾');
  assert.equal(
    forgetCalls,
    forgetBeforeRenderFailure,
    '未持久化终态随后发生本地渲染失败时不得清理恢复 marker',
  );
}

console.log('web digest generation admission tests passed');
