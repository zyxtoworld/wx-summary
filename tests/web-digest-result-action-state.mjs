import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as resultActionStateModule from '../src/web/public/js/pages/digest/result-action-state.js';
import { createDigestResultRenderState } from '../src/web/public/js/pages/digest/result-render-state.js';
import { clearDigestAccountBoundResults } from '../src/web/public/js/pages/digest/account-result-state.js';
import { createPageTaskScope } from '../src/web/public/js/shared/page-task.js';
import { localActionEvidenceSettled } from '../src/web/public/js/shared/local-action-recovery.js';
import { submitBrowserClipboardWriteLocked } from '../src/web/public/js/shared/clipboard-write-coordinator.js';
import { createClipboardPermissionController } from '../src/web/public/js/shared/clipboard-permission.js';

const {
  digestResultActionState,
  digestResultStatusText,
  createDigestResultOperationState,
  trackDigestLocalActionRecovery,
} = resultActionStateModule;

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
    if (char === '`' || char === '\'' || char === '"') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${marker} 函数体未闭合`);
}

// 页面销毁时权限查询也可能永不返回；真实 copy caller 必须让自己的等待
// 随页面 signal 结束，否则结果操作虽然被 invalidate，旧 Promise 仍永久占着
// 调用链，迟到权限结果才会触发 finally。
{
  const source = fs.readFileSync(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');
  const copySource = extractFunction(source, 'async function copyCurrentImage()');
  const taskScope = createPageTaskScope();
  const resultRenderState = createDigestResultRenderState();
  resultRenderState.begin();
  const rendered = {
    canvas: { id: 'canvas-permission-destroy' },
    width: 640,
    height: 480,
    digest: { digest_id: 'digest-permission-destroy' },
  };
  const page = { destroyed: false, currentRender: rendered, currentResultIndex: 0 };
  const capturedRender = resultRenderState.current();
  const captureResultOwner = () => ({
    isCurrent: () => !page.destroyed
      && resultRenderState.isCurrent(capturedRender)
      && page.currentRender === rendered
      && page.currentResultIndex === 0,
  });
  const operation = Object.freeze({ kind: 'copy_image' });
  const actionAbort = new AbortController();
  let permissionStarted;
  const permissionEntered = new Promise(resolve => { permissionStarted = resolve; });
  let queryCalls = 0;
  const permissionController = createClipboardPermissionController({
    navigatorTarget: {
      permissions: {
        query() {
          queryCalls += 1;
          permissionStarted();
          return new Promise(() => {});
        },
      },
    },
    windowTarget: { addEventListener() {}, removeEventListener() {} },
    documentTarget: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    eventTarget: { dispatchEvent() {} },
  });
  const phases = [];
  const toastEvents = [];
  let endCalls = 0;
  let blobCalls = 0;
  let clipboardWrites = 0;
  const copyCurrentImage = new Function(
    'page',
    'beginResultOperation',
    'currentSavedItem',
    'taskScope',
    'resultRenderState',
    'captureResultOwner',
    'copySavedImageToSystemClipboard',
    'createLocalActionId',
    'api',
    'actionAbort',
    'clipboardPermission',
    'canvasToPngBlob',
    'submitBrowserClipboardWriteLocked',
    'ui',
    'endResultOperation',
    `${copySource}; return copyCurrentImage;`,
  )(
    page,
    () => operation,
    () => null,
    taskScope,
    resultRenderState,
    captureResultOwner,
    async () => { throw new Error('未保存分支不得调用已保存复制'); },
    () => 'copy-image-permission-destroy',
    {
      async post(_path, body) {
        phases.push(body?.phase || '');
        return { ok: true };
      },
    },
    actionAbort,
    permissionController,
    async () => {
      blobCalls += 1;
      return new Blob(['must-not-encode']);
    },
    async () => { clipboardWrites += 1; },
    {
      toastWarn(message) { toastEvents.push(['warn', message]); },
      toast(message, options) { toastEvents.push(['toast', message, options]); },
      toastError(message) { toastEvents.push(['error', message]); },
      toastSuccess(message) { toastEvents.push(['success', message]); },
    },
    () => { endCalls += 1; },
  );

  const pending = copyCurrentImage();
  await permissionEntered;
  assert.equal(queryCalls, 2, '复制动作必须进入真实双权限查询');
  page.destroyed = true;
  taskScope.dispose();
  resultRenderState.invalidate();
  permissionController.dispose();
  actionAbort.abort(new Error('页面已卸载'));
  const settled = await Promise.race([
    pending.then(() => true, () => true),
    new Promise(resolve => setTimeout(() => resolve(false), 50)),
  ]);
  assert.equal(settled, true, '页面销毁后权限查询不得永久挂起旧复制动作');
  assert.deepEqual(toastEvents, [], '页面销毁后的权限取消不得写旧 toast');
  assert.deepEqual(phases, ['prepared'], '权限查询取消后不得伪造 browser_rejected 阶段');
  assert.equal(blobCalls, 0, '权限查询取消后不得创建图片 Blob');
  assert.equal(clipboardWrites, 0, '权限查询取消后不得写浏览器剪贴板');
  assert.equal(endCalls, 1, '权限查询取消后仍必须释放自己的结果动作 lease');
}

assert.equal(typeof createDigestResultRenderState, 'function', '结果渲染必须有可测试的当前代次边界');
{
  const renderState = createDigestResultRenderState();
  const first = renderState.begin();
  let committed = '';
  const second = renderState.begin();
  assert.equal(renderState.isCurrent(first), false, 'B 渲染开始后 A 必须立即失效');
  assert.equal(renderState.isCurrent(second), true, '最新渲染必须持有当前代次');
  if (renderState.isCurrent(first)) committed = 'A';
  if (renderState.isCurrent(second)) committed = 'B';
  assert.equal(committed, 'B', 'A 的晚到完成不得覆盖 B 的当前画布');
  let rerenderToasts = 0;
  if (renderState.isCurrent(first)) rerenderToasts += 1;
  assert.equal(rerenderToasts, 0, 'A 重绘被 B 群 supersede 后不得发“已重绘”提示');
  renderState.invalidate();
  assert.equal(renderState.isCurrent(second), false, '页面/结果失效后旧渲染不得再提交');
}

// 页面卸载时，真实浏览器写入仍可能忽略 abort 并迟到完成；观察者必须
// 先收到页面 actionAbort，释放结果操作 lease，Web Lock 仍由 native promise 持有。
{
  const source = fs.readFileSync(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');
  const copySource = extractFunction(source, 'async function copyCurrentImage()');
  const taskScope = createPageTaskScope();
  const resultRenderState = createDigestResultRenderState();
  resultRenderState.begin();
  const rendered = { canvas: { id: 'canvas-unmount' }, width: 640, height: 480, digest: { digest_id: 'digest-copy-unmount' } };
  const page = { destroyed: false, currentRender: rendered, currentResultIndex: 0 };
  const captureResultOwner = (currentRendered = page.currentRender) => {
    const token = resultRenderState.current();
    const index = page.currentResultIndex;
    return {
      isCurrent: () => !page.destroyed
        && resultRenderState.isCurrent(token)
        && page.currentRender === currentRendered
        && page.currentResultIndex === index,
    };
  };
  const operation = Object.freeze({ kind: 'copy_image' });
  const actionAbort = new AbortController();
  const nativeWrite = new Promise(resolve => { page.resolveNativeWrite = resolve; });
  let writeStarted = null;
  const writeEntered = new Promise(resolve => { writeStarted = resolve; });
  const phases = [];
  const toastEvents = [];
  let endCalls = 0;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalClipboardItem = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      locks: {
        request(_name, _options, callback) {
          return Promise.resolve().then(() => callback({ name: 'wx-summary:browser-clipboard-write:v1' }));
        },
      },
      clipboard: {
        write() {
          writeStarted();
          return nativeWrite;
        },
      },
    },
  });
  Object.defineProperty(globalThis, 'ClipboardItem', {
    configurable: true,
    value: class ClipboardItem {
      constructor(items) { this.items = items; }
    },
  });
  try {
    const copyCurrentImage = new Function(
      'page',
      'beginResultOperation',
      'currentSavedItem',
      'taskScope',
      'resultRenderState',
      'captureResultOwner',
      'copySavedImageToSystemClipboard',
      'createLocalActionId',
      'api',
      'actionAbort',
      'clipboardPermission',
      'canvasToPngBlob',
      'submitBrowserClipboardWriteLocked',
      'ui',
      'endResultOperation',
      `${copySource}; return copyCurrentImage;`,
    )(
      page,
      () => operation,
      () => null,
      taskScope,
      resultRenderState,
      captureResultOwner,
      async () => { throw new Error('未保存分支不得调用已保存复制'); },
      () => 'copy-image-unmount',
      {
        async post(path, body) {
          assert.equal(path, '/api/browser-clipboard-action');
          phases.push(body?.phase || '');
          return { status: 'ok' };
        },
      },
      actionAbort,
      { async refresh() { return { write: 'granted' }; } },
      async () => new Blob(['png-unmount'], { type: 'image/png' }),
      submitBrowserClipboardWriteLocked,
      {
        toastWarn(message) { toastEvents.push(['warn', message]); },
        toast(message, options) { toastEvents.push(['toast', message, options]); },
        toastError(message) { toastEvents.push(['error', message]); },
        toastSuccess(message) { toastEvents.push(['success', message]); },
      },
      () => { endCalls += 1; },
    );

    let settledQuickly = false;
    const pending = copyCurrentImage().then(() => { settledQuickly = true; });
    await writeEntered;
    page.destroyed = true;
    taskScope.invalidate();
    resultRenderState.invalidate();
    actionAbort.abort(new Error('页面已卸载'));
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(settledQuickly, true, '页面卸载必须立即结束旧复制观察者，不得等浏览器写入超时');
    page.resolveNativeWrite('late native completion');
    await pending;
    assert.equal(endCalls, 1, '旧复制必须释放自己的结果操作 lease');
    assert.deepEqual(toastEvents, [], '页面卸载后的旧复制不得投影 toast');
    assert.deepEqual(phases, ['prepared', 'outcome_unknown'], '已发出的旧写入仍须只登记结果未知');
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
    if (originalClipboardItem) Object.defineProperty(globalThis, 'ClipboardItem', originalClipboardItem);
    else delete globalThis.ClipboardItem;
  }
}

// 页面卸载时，剪贴板阶段上报也必须绑定页面取消信号；否则 API 会继续等待
// 阶段上报超时，旧结果操作 lease 不能及时结束。
{
  const source = fs.readFileSync(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');
  const copySource = extractFunction(source, 'async function copyCurrentImage()');
  const taskScope = createPageTaskScope();
  const resultRenderState = createDigestResultRenderState();
  resultRenderState.begin();
  const actionAbort = new AbortController();
  const rendered = { canvas: { id: 'canvas-phase-unmount' }, width: 640, height: 480, digest: { digest_id: 'digest-phase-unmount' } };
  const page = { destroyed: false, currentRender: rendered, currentResultIndex: 0 };
  const captureResultOwner = (currentRendered = page.currentRender) => {
    const token = resultRenderState.current();
    const index = page.currentResultIndex;
    return {
      isCurrent: () => !page.destroyed
        && resultRenderState.isCurrent(token)
        && page.currentRender === currentRendered
        && page.currentResultIndex === index,
    };
  };
  const operation = Object.freeze({ kind: 'copy_image' });
  let phaseStarted;
  const phaseEntered = new Promise(resolve => { phaseStarted = resolve; });
  let receivedSignal = null;
  let endCalls = 0;
  const copyCurrentImage = new Function(
    'page',
    'beginResultOperation',
    'currentSavedItem',
    'taskScope',
    'resultRenderState',
    'captureResultOwner',
    'copySavedImageToSystemClipboard',
    'createLocalActionId',
    'api',
    'actionAbort',
    'clipboardPermission',
    'canvasToPngBlob',
    'submitBrowserClipboardWriteLocked',
    'ui',
    'endResultOperation',
    `${copySource}; return copyCurrentImage;`,
  )(
    page,
    () => operation,
    () => null,
    taskScope,
    resultRenderState,
    captureResultOwner,
    async () => { throw new Error('未保存分支不得调用已保存复制'); },
    () => 'copy-image-phase-unmount',
    {
      post(_path, _body, options = {}) {
        receivedSignal = options.signal || null;
        phaseStarted();
        return new Promise((_resolve, reject) => {
          if (options.signal?.aborted) {
            reject(options.signal.reason);
            return;
          }
          options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
      },
    },
    actionAbort,
    { async refresh() { throw new Error('页面卸载前不得进入权限查询'); } },
    async () => { throw new Error('页面卸载前不得编码图片'); },
    async callback => callback(),
    {
      toastWarn() {},
      toast() {},
      toastError() {},
      toastSuccess() {},
    },
    () => { endCalls += 1; },
  );

  let settledQuickly = false;
  const pending = copyCurrentImage().then(() => { settledQuickly = true; });
  await phaseEntered;
  page.destroyed = true;
  taskScope.invalidate();
  resultRenderState.invalidate();
  actionAbort.abort(new Error('页面已卸载'));
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.strictEqual(receivedSignal, actionAbort.signal,
    '剪贴板阶段上报必须绑定页面 actionAbort signal');
  assert.equal(settledQuickly, true,
    '页面卸载必须立即结束等待阶段上报的旧复制观察者');
  await pending;
  assert.equal(endCalls, 1, '阶段上报取消后仍必须释放自己的结果操作 lease');
}

// 直接执行生产 showImageResults: A 首帧等待期间切换账号清空结果,B 开始新渲染;
// A 晚到只能清理自己的 generationRender,不能把 B 的冻结选择擦掉。
{
  const source = fs.readFileSync(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');
  const recoverySource = fs.readFileSync(
    new URL('../src/web/public/js/pages/digest/recovery.js', import.meta.url),
    'utf8',
  );
  const terminalContractSource = extractFunction(
    recoverySource,
    'export function requireDigestTerminalResult(payload)',
  ).replace(/^export\s+/, '');
  const requireDigestTerminalResult = new Function(
    `${terminalContractSource}; return requireDigestTerminalResult;`,
  )();
  const terminalRecoveryMetadataSource = extractFunction(
    recoverySource,
    'export function digestTerminalRecoveryMetadata(value = {})',
  ).replace(/^export\s+/, '');
  const digestTerminalRecoveryMetadata = new Function(
    `${terminalRecoveryMetadataSource}; return digestTerminalRecoveryMetadata;`,
  )();
  const showSource = extractFunction(source, 'async function showImageResults(results, run)');
  const releaseSource = extractFunction(source, 'async function releaseActiveBatch(');
  const admissionSource = extractFunction(source, 'async function admitRecoveredBatch(');
  const page = {
    destroyed: false,
    activeBatch: null,
    activeBatchRelease: null,
    generationRender: { theme: 'dark', fontSize: 'large', accentColor: '#111111' },
    doneResults: [],
    currentResultIndex: 0,
    currentRender: null,
    previewProcessingGroup: '',
    previewDigests: [],
    previewMarkdown: '',
    savedItems: new Map(),
  };
  let toastWarnings = 0;
  const ui = { toastWarn() { toastWarnings += 1; } };
  const pendingRenders = [];
  let resolveRecoveryRenderStarted;
  const recoveryRenderStarted = new Promise(resolve => {
    resolveRecoveryRenderStarted = resolve;
  });
  const renderCurrentResult = () => {
    let resolve;
    const promise = new Promise(nextResolve => { resolve = nextResolve; });
    pendingRenders.push({ resolve });
    if (pendingRenders.length === 4) resolveRecoveryRenderStarted();
    return promise;
  };
  const showImageResults = new Function(
    'page',
    'ui',
    'renderCurrentResult',
    `${showSource}; return showImageResults;`,
  )(page, ui, renderCurrentResult);

  const noDoneSelection = { theme: 'dark', fontSize: 'large', accentColor: '#000000' };
  page.generationRender = noDoneSelection;
  await showImageResults([], { batch: { batch_id: 'batch-no-done' } });
  assert.equal(toastWarnings, 1, '无可用摘要时必须只提示一次结果状态');
  assert.equal(page.generationRender, null,
    '无可用摘要时也必须清理本批次自己持有的冻结渲染选择');

  const normalASelection = { theme: 'light', fontSize: 'large', accentColor: '#101010' };
  page.generationRender = normalASelection;
  assert.ok(normalASelection, '正常 A 必须持有非空的冻结渲染选择');
  assert.notStrictEqual(normalASelection, noDoneSelection,
    '正常 A 必须使用不同于 no-done 分支的 owner');
  const normalAShow = showImageResults(
    [{ outcome: 'done', digest: { digest_id: 'digest-a-normal' } }],
    { batch: { batch_id: 'batch-a-normal' } },
  );
  await Promise.resolve();
  pendingRenders[0].resolve(true);
  await normalAShow;
  assert.equal(page.generationRender, null,
    '同一 A 正常完成后必须清理 A 自己持有的冻结渲染选择');

  page.generationRender = { theme: 'dark', fontSize: 'large', accentColor: '#111111' };
  const selectionA = page.generationRender;
  assert.notStrictEqual(normalASelection, selectionA,
    '正常 A owner 必须与后续并发场景的 selectionA 相互独立');
  const showA = showImageResults(
    [{ outcome: 'done', digest: { digest_id: 'digest-a' } }],
    { batch: { batch_id: 'batch-a' } },
  );
  await Promise.resolve();
  assert.equal(pendingRenders.length, 2, 'A 必须已进入等待中的首帧渲染');

  clearDigestAccountBoundResults(page);
  const selectionB = { theme: 'light', fontSize: 'normal', accentColor: '#222222' };
  page.generationRender = selectionB;
  const showB = showImageResults(
    [{ outcome: 'done', digest: { digest_id: 'digest-b' } }],
    { batch: { batch_id: 'batch-b' } },
  );
  await Promise.resolve();
  assert.equal(pendingRenders.length, 3, 'B 必须在 A 未完成时开始自己的渲染');

  pendingRenders[1].resolve(true);
  await showA;
  assert.strictEqual(page.generationRender, selectionB,
    'A 晚到不得清掉账号切换后 B 的冻结渲染选择');

  pendingRenders[2].resolve(true);
  await showB;
  assert.equal(page.generationRender, null, 'B 正常完成后必须清理自己持有的冻结选择');

  // 恢复路径通过生产 recoverImageBatchResults 调用同一个 showImageResults;
  // 没有并发 owner 时正常收尾仍应清自己的选择。
  const recoverySelection = { theme: 'dark', fontSize: 'normal', accentColor: '#333333' };
  page.generationRender = recoverySelection;
  page.destroyed = false;
  page.renderOptions = { theme: 'auto', fontSize: 'normal' };
  let keepaliveStarts = 0;
  const startBatchKeepalive = () => { keepaliveStarts += 1; };
  const releaseActiveBatch = new Function(
    'page',
    'stopBatchKeepalive',
    'startBatchKeepalive',
    'digestBatchFinishConfirmed',
    `${releaseSource}; return releaseActiveBatch;`,
  )(
    page,
    () => {},
    startBatchKeepalive,
    value => value?.ok === true && value?.settled === true && value?.pending !== true,
  );
  const admitRecoveredBatch = new Function(
    'page',
    'releaseActiveBatch',
    'startBatchKeepalive',
    `${admissionSource}; return admitRecoveredBatch;`,
  )(page, releaseActiveBatch, startBatchKeepalive);
  const recoverSource = extractFunction(source, 'async function recoverImageBatchResults(');
  const recoverImageBatchResults = new Function(
    'page',
    'api',
    'interruptedDigestRenderSelection',
    'digestTerminalResultRequest',
    'requireDigestTerminalResult',
    'digestTerminalRecoveryMetadata',
    'startBatchKeepalive',
    'showImageResults',
    'admitRecoveredBatch',
    'releaseActiveBatch',
    'digestBatchFinishConfirmed',
    `${recoverSource}; return recoverImageBatchResults;`,
  )(
    page,
    {
      async post(path) {
        assert.equal(path, '/api/digest-result');
        return { status: 'done', digest: { digest_id: 'digest-recovered' } };
      },
      getServiceInstanceId() { return 'service-test'; },
    },
    () => recoverySelection,
    () => ({}),
    requireDigestTerminalResult,
    digestTerminalRecoveryMetadata,
    startBatchKeepalive,
    showImageResults,
    admitRecoveredBatch,
    releaseActiveBatch,
    value => value?.ok === true && value?.settled === true && value?.pending !== true,
  );
  const recoveryShow = recoverImageBatchResults(
    {
      batch_id: 'recovered-batch',
      batch_token: 'recovered-token',
      service_instance_id: 'service-test',
      account_id: 'account-a',
      account_fingerprint: 'a'.repeat(64),
    },
    [{ status: 'done', batch_index: 0, group_id: 'group-recovered' }],
    { isCurrent: () => true },
  );
  await Promise.race([
    recoveryRenderStarted,
    recoveryShow.then(() => {
      throw new Error('恢复成功前必须进入图片渲染等待');
    }),
  ]);
  assert.equal(pendingRenders.length, 4, '恢复成功后必须进入第 4 个图片渲染等待');
  pendingRenders[3].resolve(true);
  await recoveryShow;
  assert.equal(keepaliveStarts, 1, '恢复成功后必须由恢复路径启动唯一批次保活');
  assert.equal(page.generationRender, null, '恢复路径正常完成后必须清理自己的冻结选择');
  assert.notStrictEqual(selectionA, selectionB);
}

// 未保存图片复制在权限查询期间被账号切换/卸载失效后，权限结果晚到不得再投影旧动作。
{
  const source = fs.readFileSync(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');
  const copySource = extractFunction(source, 'async function copyCurrentImage()');
  const taskScope = createPageTaskScope();
  const resultRenderState = createDigestResultRenderState();
  resultRenderState.begin();
  const page = {
    destroyed: false,
    currentRender: { digest: { digest_id: 'digest-copy-stale' } },
    currentResultIndex: 0,
  };
  const captureResultOwner = (rendered = page.currentRender) => {
    const token = resultRenderState.current();
    const index = page.currentResultIndex;
    return {
      isCurrent: () => !page.destroyed
        && resultRenderState.isCurrent(token)
        && page.currentRender === rendered
        && page.currentResultIndex === index,
    };
  };
  const operation = Object.freeze({ kind: 'copy_image' });
  const permission = new Promise(resolve => { page.resolvePermission = resolve; });
  let permissionStarted = false;
  let resolvePermissionStarted;
  const permissionEntered = new Promise(resolve => { resolvePermissionStarted = resolve; });
  let endCalls = 0;
  let blobCalls = 0;
  let clipboardWrites = 0;
  const toastEvents = [];
  const phases = [];
  const copyCurrentImage = new Function(
    'page',
    'beginResultOperation',
    'currentSavedItem',
    'taskScope',
    'resultRenderState',
    'captureResultOwner',
    'copySavedImageToSystemClipboard',
    'createLocalActionId',
    'api',
    'actionAbort',
    'clipboardPermission',
    'canvasToPngBlob',
    'submitBrowserClipboardWriteLocked',
    'ui',
    'endResultOperation',
    `${copySource}; return copyCurrentImage;`,
  )(
    page,
    () => operation,
    () => null,
    taskScope,
    resultRenderState,
    captureResultOwner,
    async () => { throw new Error('未保存分支不得调用已保存复制'); },
    () => 'copy-image-stale',
    {
      async post(path, body) {
        assert.equal(path, '/api/browser-clipboard-action');
        phases.push(body?.phase || '');
        return { status: 'ok' };
      },
    },
    new AbortController(),
    {
      async refresh() {
        permissionStarted = true;
        resolvePermissionStarted();
        return permission;
      },
    },
    async () => {
      blobCalls += 1;
      return new Blob(['stale']);
    },
    async callback => {
      clipboardWrites += 1;
      return callback();
    },
    {
      toastWarn(message) { toastEvents.push(['warn', message]); },
      toast(message, options) { toastEvents.push(['toast', message, options]); },
      toastError(message) { toastEvents.push(['error', message]); },
      toastSuccess(message) { toastEvents.push(['success', message]); },
    },
    () => { endCalls += 1; },
  );
  const pending = copyCurrentImage();
  await permissionEntered;
  assert.equal(permissionStarted, true, '复制动作必须已进入可延迟的权限查询');
  taskScope.invalidate();
  page.resolvePermission({ write: 'denied' });
  await pending;
  assert.deepEqual(toastEvents, [], '失效复制动作的权限晚到不得再写 toast');
  assert.deepEqual(phases, ['prepared'], '失效复制动作不得再上报 browser_rejected');
  assert.equal(blobCalls, 0, '权限晚到且动作失效时不得创建图片 Blob');
  assert.equal(clipboardWrites, 0, '权限晚到且动作失效时不得写系统剪贴板');
  assert.equal(endCalls, 1, '失效复制动作仍必须释放自己的结果操作 lease');
}

// 未保存图片复制绑定的是点击时的当前渲染。权限查询挂起时用户切换到另一群结果，
// 旧画布不得继续生成 Blob、写剪贴板或把完成提示投影到新结果。
{
  const source = fs.readFileSync(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');
  const copySource = extractFunction(source, 'async function copyCurrentImage()');
  const taskScope = createPageTaskScope();
  const resultRenderState = createDigestResultRenderState();
  resultRenderState.begin();
  const renderedA = { canvas: { id: 'canvas-a' }, width: 800, height: 1200, digest: { digest_id: 'digest-copy-a' } };
  const renderedB = { canvas: { id: 'canvas-b' }, width: 900, height: 1300, digest: { digest_id: 'digest-copy-b' } };
  const page = {
    destroyed: false,
    currentRender: renderedA,
    currentResultIndex: 0,
  };
  const captureResultOwner = (rendered = page.currentRender) => {
    const token = resultRenderState.current();
    const index = page.currentResultIndex;
    return {
      isCurrent: () => !page.destroyed
        && resultRenderState.isCurrent(token)
        && page.currentRender === rendered
        && page.currentResultIndex === index,
    };
  };
  const operation = Object.freeze({ kind: 'copy_image' });
  let resolvePermission;
  let notifyPermissionStarted;
  const permissionStarted = new Promise(resolve => { notifyPermissionStarted = resolve; });
  const permission = new Promise(resolve => { resolvePermission = resolve; });
  let endCalls = 0;
  let blobCalls = 0;
  let clipboardWrites = 0;
  let clipboardWriteGate = null;
  let notifyClipboardWriteStarted = null;
  let expectedCanvas = renderedA.canvas;
  const toastEvents = [];
  const phases = [];
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalClipboardItem = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        async write() {
          clipboardWrites += 1;
          notifyClipboardWriteStarted?.();
          if (clipboardWriteGate) await clipboardWriteGate;
        },
      },
    },
  });
  Object.defineProperty(globalThis, 'ClipboardItem', {
    configurable: true,
    value: class ClipboardItem {
      constructor(items) { this.items = items; }
    },
  });
  try {
    const copyCurrentImage = new Function(
      'page',
      'beginResultOperation',
      'currentSavedItem',
      'taskScope',
      'resultRenderState',
      'captureResultOwner',
      'copySavedImageToSystemClipboard',
      'createLocalActionId',
      'api',
      'actionAbort',
      'clipboardPermission',
      'canvasToPngBlob',
      'submitBrowserClipboardWriteLocked',
      'ui',
      'endResultOperation',
      `${copySource}; return copyCurrentImage;`,
    )(
      page,
      () => operation,
      () => null,
      taskScope,
      resultRenderState,
      captureResultOwner,
      async () => { throw new Error('未保存分支不得调用已保存复制'); },
      () => 'copy-image-render-a',
      {
        async post(path, body) {
          assert.equal(path, '/api/browser-clipboard-action');
          phases.push(body?.phase || '');
          return { status: 'ok' };
        },
      },
      new AbortController(),
      {
        async refresh() {
          notifyPermissionStarted();
          return permission;
        },
      },
      async canvas => {
        blobCalls += 1;
        assert.strictEqual(canvas, expectedCanvas, '复制必须处理动作当前绑定的画布');
        return new Blob(['png-a'], { type: 'image/png' });
      },
      async callback => callback(),
      {
        toastWarn(message) { toastEvents.push(['warn', message]); },
        toast(message, options) { toastEvents.push(['toast', message, options]); },
        toastError(message) { toastEvents.push(['error', message]); },
        toastSuccess(message) { toastEvents.push(['success', message]); },
      },
      () => { endCalls += 1; },
    );

    const pending = copyCurrentImage();
    await permissionStarted;
    page.currentRender = renderedB;
    page.currentResultIndex = 1;
    resultRenderState.begin();
    resolvePermission({ write: 'prompt' });
    await pending;

    assert.equal(blobCalls, 0, '切到 B 后 A 的权限晚到不得继续生成旧画布 Blob');
    assert.equal(clipboardWrites, 0, '切到 B 后 A 的权限晚到不得写剪贴板');
    assert.deepEqual(toastEvents, [], '切到 B 后 A 的权限晚到不得把提示投影到 B');
    assert.deepEqual(phases, ['prepared'], '切到 B 后 A 不得继续上报提交阶段');
    assert.equal(endCalls, 1, '被结果切换取消的复制动作仍必须释放自己的 lease');

    expectedCanvas = renderedB.canvas;
    await copyCurrentImage();
    assert.equal(blobCalls, 1, '当前 B 的正常复制必须生成一次 B 画布 Blob');
    assert.equal(clipboardWrites, 1, '当前 B 的正常复制必须写入一次剪贴板');
    assert.deepEqual(toastEvents, [['success', '图片已复制到剪贴板。']],
      '当前 B 的正常复制必须保留成功提示');
    assert.deepEqual(phases, ['prepared', 'prepared', 'browser_committed'],
      '当前 B 的正常复制必须完成准备和提交阶段上报');
    assert.equal(endCalls, 2, '当前 B 的正常复制也必须释放自己的 lease');

    page.currentRender = renderedA;
    page.currentResultIndex = 0;
    resultRenderState.begin();
    expectedCanvas = renderedA.canvas;
    let resolveClipboardWrite;
    clipboardWriteGate = new Promise(resolve => { resolveClipboardWrite = resolve; });
    const clipboardWriteStarted = new Promise(resolve => { notifyClipboardWriteStarted = resolve; });
    const lateCommit = copyCurrentImage();
    await clipboardWriteStarted;
    page.currentRender = renderedB;
    page.currentResultIndex = 1;
    resultRenderState.begin();
    resolveClipboardWrite();
    await lateCommit;
    assert.equal(clipboardWrites, 2, 'A 的剪贴板写入必须已真实提交到浏览器调用');
    assert.deepEqual(phases,
      ['prepared', 'prepared', 'browser_committed', 'prepared', 'browser_committed'],
      'A 的晚到提交仍必须完成本地动作证据上报');
    assert.deepEqual(toastEvents, [['success', '图片已复制到剪贴板。']],
      'A 的晚到提交不得在 B 页面新增成功提示');
    assert.equal(endCalls, 3, 'A 的晚到提交仍必须释放自己的 lease');
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
    if (originalClipboardItem) Object.defineProperty(globalThis, 'ClipboardItem', originalClipboardItem);
    else delete globalThis.ClipboardItem;
  }
}

// 已保存图片的系统复制请求即使无法撤回，响应也只能投影到发起时的结果。
// A 请求挂起后切到 B，A 的普通成功不得在 B 页面提示成功。
{
  const source = fs.readFileSync(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');
  const copySavedSource = extractFunction(source, 'async function copySavedImageToSystemClipboard(');
  const taskScope = createPageTaskScope();
  const renderedA = { digest: { digest_id: 'digest-saved-a' } };
  const renderedB = { digest: { digest_id: 'digest-saved-b' } };
  const page = { currentRender: renderedA };
  const actionAbort = new AbortController();
  let resolveCopy;
  let notifyCopyStarted;
  const copyStarted = new Promise(resolve => { notifyCopyStarted = resolve; });
  const copyResponse = new Promise(resolve => { resolveCopy = resolve; });
  let activeCopyResponse = copyResponse;
  let recoveryClassification = 'verified';
  const toastEvents = [];
  const recoveryEvents = [];
  const scheduleLocalActionRecovery = (...args) => {
    if (args[3] !== undefined && localActionEvidenceSettled(args[1], args[3])) return false;
    recoveryEvents.push(args);
    return true;
  };
  const trackLocalActionRecovery = (request, options = {}) => trackDigestLocalActionRecovery(request, {
    ...options,
    schedule: scheduleLocalActionRecovery,
  });
  const copySavedImageToSystemClipboard = new Function(
    'taskScope',
    'trackLocalActionRecovery',
    'createLocalActionId',
    'api',
    'classifyLocalActionRecovery',
    'ui',
    'isMutationOutcomeUnknown',
    'scheduleLocalActionRecovery',
    'actionAbort',
    `${copySavedSource}; return copySavedImageToSystemClipboard;`,
  )(
    taskScope,
    trackLocalActionRecovery,
    () => 'copy-image-saved-a',
    {
      post() {
        notifyCopyStarted();
        return activeCopyResponse;
      },
    },
    () => recoveryClassification,
    {
      toastSuccess(message) { toastEvents.push(['success', message]); },
      toast(message, options) { toastEvents.push(['toast', message, options]); },
      toastError(message) { toastEvents.push(['error', message]); },
    },
    error => error?.mutation_outcome_unknown === true,
    scheduleLocalActionRecovery,
    actionAbort,
  );

  const pending = copySavedImageToSystemClipboard(
    {
      digest_id: 'digest-saved-a',
      history_item_key: 'history-a',
      file_version: 'version-a',
    },
    { isCurrent: () => page.currentRender === renderedA },
  );
  await copyStarted;
  page.currentRender = renderedB;
  taskScope.invalidate();
  resolveCopy({ local_action_committed: true, verified: true, evidence_persisted: true });
  await pending;
  assert.deepEqual(toastEvents, [], 'A 的已保存复制响应晚到时不得在 B 页面提示成功');
  assert.deepEqual(recoveryEvents, [], 'A 的已保存复制响应晚到时不得为 B 安排恢复动作');

  await copySavedImageToSystemClipboard(
    {
      digest_id: 'digest-saved-b',
      history_item_key: 'history-b',
      file_version: 'version-b',
    },
    { isCurrent: () => page.currentRender === renderedB },
  );
  assert.deepEqual(toastEvents, [['success', '图片已复制到剪贴板。']],
    '当前 B 的已保存图片复制必须保留成功提示');

  let rejectUnknownCopy;
  activeCopyResponse = new Promise((_resolve, reject) => { rejectUnknownCopy = reject; });
  page.currentRender = renderedA;
  const unknownCopy = copySavedImageToSystemClipboard(
    {
      digest_id: 'digest-saved-a',
      history_item_key: 'history-a',
      file_version: 'version-a',
    },
    { isCurrent: () => page.currentRender === renderedA },
  );
  page.currentRender = renderedB;
  taskScope.invalidate();
  rejectUnknownCopy(Object.assign(new Error('A 复制结果未知'), { mutation_outcome_unknown: true }));
  await unknownCopy;
  assert.equal(recoveryEvents.length, 1, 'A 的结果未知即使已切到 B 也必须启动后台恢复核对');
  assert.deepEqual(toastEvents, [['success', '图片已复制到剪贴板。']],
    'A 的结果未知不得在 B 页面新增提示');

  let resolveCommittedCopy;
  activeCopyResponse = new Promise(resolve => { resolveCommittedCopy = resolve; });
  recoveryClassification = 'committed_unverified';
  page.currentRender = renderedA;
  const committedCopy = copySavedImageToSystemClipboard(
    {
      digest_id: 'digest-saved-a',
      history_item_key: 'history-a',
      file_version: 'version-a',
    },
    { isCurrent: () => page.currentRender === renderedA },
  );
  page.currentRender = renderedB;
  taskScope.invalidate();
  resolveCommittedCopy({ local_action_committed: true, verification_pending: true });
  await committedCopy;
  assert.equal(recoveryEvents.length, 2,
    'A 的已提交待核验响应即使已切到 B 也必须启动后台恢复核对');
  assert.deepEqual(toastEvents, [['success', '图片已复制到剪贴板。']],
    'A 的已提交待核验响应不得在 B 页面新增提示');
}

// 路径复制/文件夹显示同样绑定点击时的已保存结果。服务动作可以已经发生，
// 但 A 的晚到响应不得在用户已切到 B 后投影提示或恢复状态。
for (const scenario of [
  {
    marker: 'async function copySavedPath()',
    endpoint: '/api/copy-path',
    label: '复制路径',
  },
  {
    marker: 'async function revealSavedItem()',
    endpoint: '/api/reveal',
    label: '在文件夹显示',
  },
]) {
  const source = fs.readFileSync(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');
  const actionSource = extractFunction(source, scenario.marker);
  const taskScope = createPageTaskScope();
  const resultRenderState = createDigestResultRenderState();
  resultRenderState.begin();
  const renderedA = { digest: { digest_id: 'digest-local-a' } };
  const renderedB = { digest: { digest_id: 'digest-local-b' } };
  const page = { currentRender: renderedA, currentResultIndex: 0 };
  const actionAbort = new AbortController();
  const captureResultOwner = () => {
    const rendered = page.currentRender;
    const index = page.currentResultIndex;
    const token = resultRenderState.current();
    return {
      isCurrent: () => page.currentRender === rendered
        && page.currentResultIndex === index
        && resultRenderState.isCurrent(token),
    };
  };
  let resolveAction;
  let notifyActionStarted;
  const actionStarted = new Promise(resolve => { notifyActionStarted = resolve; });
  const actionResponse = new Promise(resolve => { resolveAction = resolve; });
  let activeActionResponse = actionResponse;
  let recoveryClassification = 'verified';
  const toastEvents = [];
  const recoveryEvents = [];
  const scheduleLocalActionRecovery = (...args) => {
    if (args[3] !== undefined && localActionEvidenceSettled(args[1], args[3])) return false;
    recoveryEvents.push(args);
    return true;
  };
  const trackLocalActionRecovery = (request, options = {}) => trackDigestLocalActionRecovery(request, {
    ...options,
    schedule: scheduleLocalActionRecovery,
  });
  let endCalls = 0;
  const action = new Function(
    'page',
    'currentSavedItem',
    'beginResultOperation',
    'captureResultOwner',
    'createLocalActionId',
    'taskScope',
    'trackLocalActionRecovery',
    'api',
    'classifyLocalActionRecovery',
    'ui',
    'isMutationOutcomeUnknown',
    'scheduleLocalActionRecovery',
    'endResultOperation',
    'actionAbort',
    `${actionSource}; return ${scenario.marker.includes('copySavedPath') ? 'copySavedPath' : 'revealSavedItem'};`,
  )(
    page,
    () => {
      const suffix = page.currentRender === renderedA ? 'a' : 'b';
      return {
        digest_id: `digest-local-${suffix}`,
        history_item_key: `history-local-${suffix}`,
        file_version: `version-local-${suffix}`,
      };
    },
    () => Object.freeze({ kind: scenario.label }),
    captureResultOwner,
    () => `action-${scenario.label}`,
    taskScope,
    trackLocalActionRecovery,
    {
      post(path) {
        assert.equal(path, scenario.endpoint);
        notifyActionStarted();
        return activeActionResponse;
      },
    },
    () => recoveryClassification,
    {
      toastSuccess(message) { toastEvents.push(['success', message]); },
      toastWarn(message) { toastEvents.push(['warn', message]); },
      toast(message, options) { toastEvents.push(['toast', message, options]); },
      toastError(message) { toastEvents.push(['error', message]); },
    },
    error => error?.mutation_outcome_unknown === true,
    scheduleLocalActionRecovery,
    () => { endCalls += 1; },
    actionAbort,
  );

  const pending = action();
  await actionStarted;
  page.currentRender = renderedB;
  page.currentResultIndex = 1;
  resultRenderState.begin();
  taskScope.invalidate();
  resolveAction({
    local_action_committed: true,
    verified: true,
    evidence_persisted: true,
    clipboard_supported: true,
  });
  await pending;
  assert.deepEqual(toastEvents, [], `${scenario.label}: A 晚到响应不得在 B 页面投影提示`);
  assert.deepEqual(recoveryEvents, [], `${scenario.label}: A 晚到响应不得为 B 安排恢复动作`);
  assert.equal(endCalls, 1, `${scenario.label}: 失效动作仍必须释放自己的 lease`);

  await action();
  assert.equal(toastEvents.length, 1, `${scenario.label}: 当前 B 的正常响应必须保留成功提示`);
  assert.equal(toastEvents[0][0], 'success', `${scenario.label}: 当前 B 必须投影成功终态`);
  assert.equal(endCalls, 2, `${scenario.label}: 当前 B 的正常动作也必须释放自己的 lease`);

  let rejectLateAction;
  activeActionResponse = new Promise((_resolve, reject) => { rejectLateAction = reject; });
  page.currentRender = renderedA;
  page.currentResultIndex = 0;
  resultRenderState.begin();
  const lateFailure = action();
  page.currentRender = renderedB;
  page.currentResultIndex = 1;
  resultRenderState.begin();
  taskScope.invalidate();
  rejectLateAction(new Error(`${scenario.label} A 晚到失败`));
  await lateFailure;
  assert.equal(toastEvents.length, 1, `${scenario.label}: A 的普通晚到失败不得在 B 页面新增错误提示`);
  assert.deepEqual(recoveryEvents, [], `${scenario.label}: A 的普通晚到失败不得为 B 安排恢复动作`);
  assert.equal(endCalls, 3, `${scenario.label}: 晚到失败仍必须释放自己的 lease`);

  let rejectUnknownAction;
  activeActionResponse = new Promise((_resolve, reject) => { rejectUnknownAction = reject; });
  page.currentRender = renderedA;
  page.currentResultIndex = 0;
  resultRenderState.begin();
  const unknownFailure = action();
  page.currentRender = renderedB;
  page.currentResultIndex = 1;
  resultRenderState.begin();
  taskScope.invalidate();
  rejectUnknownAction(Object.assign(new Error(`${scenario.label} A 结果未知`), { mutation_outcome_unknown: true }));
  await unknownFailure;
  assert.equal(recoveryEvents.length, 1, `${scenario.label}: A 的结果未知必须继续后台恢复核对`);
  assert.equal(toastEvents.length, 1, `${scenario.label}: A 的结果未知不得在 B 页面新增提示`);
  assert.equal(endCalls, 4, `${scenario.label}: 结果未知仍必须释放自己的 lease`);

  let resolveCommittedAction;
  activeActionResponse = new Promise(resolve => { resolveCommittedAction = resolve; });
  recoveryClassification = 'committed_unverified';
  page.currentRender = renderedA;
  page.currentResultIndex = 0;
  resultRenderState.begin();
  const committedAction = action();
  page.currentRender = renderedB;
  page.currentResultIndex = 1;
  resultRenderState.begin();
  taskScope.invalidate();
  resolveCommittedAction({ local_action_committed: true, verification_pending: true });
  await committedAction;
  assert.equal(recoveryEvents.length, 2,
    `${scenario.label}: A 的已提交待核验响应必须继续后台恢复核对`);
  assert.equal(toastEvents.length, 1,
    `${scenario.label}: A 的已提交待核验响应不得在 B 页面新增提示`);
  assert.equal(endCalls, 5, `${scenario.label}: 已提交待核验动作仍必须释放自己的 lease`);
}

// 页面销毁必须同时取消摘要结果动作的真实 API 请求,不能只让 taskScope
// 丢弃晚到投影。三条已保存结果 caller 都要把页面 actionAbort 传到底层。
for (const scenario of [
  {
    marker: 'async function copySavedImageToSystemClipboard(',
    endpoint: '/api/copy-image',
    label: '复制已保存图片',
    functionName: 'copySavedImageToSystemClipboard',
  },
  {
    marker: 'async function copySavedPath(',
    endpoint: '/api/copy-path',
    label: '复制已保存路径',
    functionName: 'copySavedPath',
  },
  {
    marker: 'async function revealSavedItem(',
    endpoint: '/api/reveal',
    label: '显示已保存文件夹',
    functionName: 'revealSavedItem',
  },
]) {
  const source = fs.readFileSync(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');
  const actionSource = extractFunction(source, scenario.marker);
  const taskScope = createPageTaskScope();
  const resultRenderState = createDigestResultRenderState();
  resultRenderState.begin();
  const rendered = { digest: { digest_id: 'digest-unmount-a' } };
  const scenarioState = {
    page: { destroyed: false, currentRender: rendered, currentResultIndex: 0 },
  };
  const actionAbort = new AbortController();
  const captureResultOwner = () => {
    const token = resultRenderState.current();
    const index = scenarioState.page.currentResultIndex;
    return {
      isCurrent: () => !scenarioState.page.destroyed
        && resultRenderState.isCurrent(token)
        && scenarioState.page.currentRender === rendered
        && scenarioState.page.currentResultIndex === index,
    };
  };
  let resolveAction;
  let notifyActionStarted;
  const actionStarted = new Promise(resolve => { notifyActionStarted = resolve; });
  const actionResponse = new Promise(resolve => { resolveAction = resolve; });
  let receivedSignal = null;
  let endCalls = 0;
  const toastEvents = [];
  const scheduleLocalActionRecovery = () => true;
  const trackLocalActionRecovery = (request, options = {}) => trackDigestLocalActionRecovery(request, {
    ...options,
    schedule: scheduleLocalActionRecovery,
  });
  const action = scenario.functionName === 'copySavedImageToSystemClipboard'
    ? new Function(
      'taskScope', 'trackLocalActionRecovery', 'createLocalActionId', 'api',
      'classifyLocalActionRecovery', 'ui', 'isMutationOutcomeUnknown',
      'scheduleLocalActionRecovery', 'actionAbort',
      `${actionSource}; return copySavedImageToSystemClipboard;`,
    )(
      taskScope,
      trackLocalActionRecovery,
      () => 'copy-image-unmount-a',
      {
        post(path, body, options = {}) {
          assert.equal(path, scenario.endpoint);
          receivedSignal = options.signal || null;
          notifyActionStarted();
          return actionResponse;
        },
      },
      () => 'verified',
      {
        toastSuccess(message) { toastEvents.push(['success', message]); },
        toast(message) { toastEvents.push(['toast', message]); },
        toastError(message) { toastEvents.push(['error', message]); },
      },
      () => false,
      scheduleLocalActionRecovery,
      actionAbort,
    )
    : new Function(
      'page', 'currentSavedItem', 'beginResultOperation', 'captureResultOwner',
      'createLocalActionId', 'taskScope', 'trackLocalActionRecovery', 'api',
      'classifyLocalActionRecovery', 'ui', 'isMutationOutcomeUnknown',
      'scheduleLocalActionRecovery', 'endResultOperation', 'actionAbort',
      `${actionSource}; return ${scenario.functionName};`,
    )(
      scenarioState.page,
      () => ({
        digest_id: 'digest-unmount-a',
        history_item_key: 'history-unmount-a',
        file_version: 'version-unmount-a',
      }),
      () => Object.freeze({ kind: scenario.label }),
      captureResultOwner,
      () => `action-${scenario.label}`,
      taskScope,
      trackLocalActionRecovery,
      {
        post(path, body, options = {}) {
          assert.equal(path, scenario.endpoint);
          receivedSignal = options.signal || null;
          notifyActionStarted();
          return actionResponse;
        },
      },
      () => 'verified',
      {
        toastSuccess(message) { toastEvents.push(['success', message]); },
        toastWarn(message) { toastEvents.push(['warn', message]); },
        toast(message) { toastEvents.push(['toast', message]); },
        toastError(message) { toastEvents.push(['error', message]); },
      },
      () => false,
      scheduleLocalActionRecovery,
      () => { endCalls += 1; },
      actionAbort,
    );

  const pending = scenario.functionName === 'copySavedImageToSystemClipboard'
    ? action({
      digest_id: 'digest-unmount-a',
      history_item_key: 'history-unmount-a',
      file_version: 'version-unmount-a',
    }, { isCurrent: () => !scenarioState.page.destroyed })
    : action();
  await actionStarted;
  scenarioState.page.destroyed = true;
  taskScope.dispose();
  resultRenderState.invalidate();
  actionAbort.abort(new Error('页面已卸载'));
  resolveAction({ local_action_committed: true, verified: true, evidence_persisted: true });
  await pending;
  assert.ok(receivedSignal instanceof AbortSignal,
    `${scenario.label}: 页面卸载必须把自己的 AbortSignal 传给 API 请求`);
  assert.equal(receivedSignal.aborted, true,
    `${scenario.label}: 页面卸载必须立即 abort 仍在途的 API 请求`);
  assert.deepEqual(toastEvents, [], `${scenario.label}: 卸载后的晚到响应不得投影提示`);
  if (scenario.functionName !== 'copySavedImageToSystemClipboard') {
    assert.equal(endCalls, 1, `${scenario.label}: 卸载后的晚到响应仍必须释放自己的 lease`);
  }
}

assert.deepEqual(
  digestResultActionState({ hasRender: true, hasTicket: true, running: true }),
  {
    saveDisabled: true,
    copyImageDisabled: false,
    copyPathDisabled: true,
    revealDisabled: true,
    rerenderDisabled: true,
  },
  '渲染完成但批次仍在收尾时，结果操作必须保持一致的忙态',
);

assert.deepEqual(
  digestResultActionState({ hasRender: true, hasTicket: true, running: false }),
  {
    saveDisabled: false,
    copyImageDisabled: false,
    copyPathDisabled: true,
    revealDisabled: true,
    rerenderDisabled: false,
  },
  '批次收尾后必须立即开放首次保存和保存前重渲染',
);

assert.deepEqual(
  digestResultActionState({ hasRender: true, hasTicket: true, running: false, saving: true }),
  {
    saveDisabled: true,
    copyImageDisabled: true,
    copyPathDisabled: true,
    revealDisabled: true,
    rerenderDisabled: true,
  },
  'PNG 保存期间即使权限或结果状态重新计算，也不得重新开放并发结果操作',
);

assert.deepEqual(
  digestResultActionState({ hasRender: true, hasTicket: true, saved: true, actionBusy: true }),
  {
    saveDisabled: true,
    copyImageDisabled: true,
    copyPathDisabled: true,
    revealDisabled: true,
    rerenderDisabled: true,
  },
  '复制或文件夹操作进行中必须锁定全部结果操作，避免生成新 action_id 并发执行',
);

assert.equal(typeof createDigestResultOperationState, 'function', '结果本地动作必须有可测试的单一占用状态');
const operationState = createDigestResultOperationState();
const copyPathAction = operationState.begin('copy_path', '复制路径');
assert.deepEqual(copyPathAction, { kind: 'copy_path', label: '复制路径', revision: 1 });
assert.equal(operationState.begin('copy_image', '复制图片'), null, '当前动作未结算时必须拒绝第二个结果动作');
assert.equal(operationState.isBusy(), true);
assert.equal(operationState.isCurrent(copyPathAction), true);
operationState.end({ ...copyPathAction });
assert.equal(operationState.isBusy(), true, '非当前 lease 不得释放动作锁');
assert.equal(operationState.end(copyPathAction), true);
assert.equal(operationState.isBusy(), false);
const revealAction = operationState.begin('reveal', '在文件夹显示');
assert.equal(operationState.invalidate(), true);
assert.equal(operationState.isCurrent(revealAction), false, '页面卸载后旧动作必须失效');

// 直接执行生产 saveCurrentPng：A 在 PNG 编码期间持有 saving，结果标签必须同步禁用。
// 否则用户可切到 B，使 A 的 finally 因结果 owner 失效而无法释放全局 saving。
{
  const sourceText = fs.readFileSync(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');
  const updateSource = extractFunction(sourceText, 'function updateResultActionState(');
  const saveSource = extractFunction(sourceText, 'async function saveCurrentPng()');
  const resultRenderState = createDigestResultRenderState();
  resultRenderState.begin();
  const renderedA = {
    canvas: { id: 'canvas-save-a' },
    digest: {
      digest_id: 'digest-save-a',
      __generation: { id: 'generation-a', token: 'ticket-a' },
    },
    theme: 'light',
    fontSize: 'normal',
    accentColor: '#123456',
  };
  const renderedB = {
    canvas: { id: 'canvas-save-b' },
    digest: {
      digest_id: 'digest-save-b',
      __generation: { id: 'generation-b', token: 'ticket-b' },
    },
    theme: 'dark',
    fontSize: 'large',
    accentColor: '#654321',
  };
  const page = {
    destroyed: false,
    generation: 7,
    saving: false,
    running: false,
    currentRender: renderedA,
    currentResultIndex: 0,
    activeBatch: {
      batch: {
        batch_id: 'batch-save-a',
        batch_token: 'batch-token-save-a',
        service_instance_id: 'service-save-a',
      },
    },
    savedItems: new Map(),
  };
  let tabSwitches = 0;
  const tabs = [0, 1].map(index => ({
    disabled: false,
    click() {
      if (this.disabled) return;
      tabSwitches += 1;
      page.currentResultIndex = index;
      page.currentRender = index === 0 ? renderedA : renderedB;
      resultRenderState.begin();
    },
  }));
  const control = () => ({ disabled: false, title: '' });
  const resultUi = {
    tabs: { querySelectorAll: selector => selector === '.result-tab' ? tabs : [] },
    saveBtn: control(),
    copyImageBtn: control(),
    copyPathBtn: control(),
    revealBtn: control(),
    rerenderBtn: control(),
    resultStatus: { textContent: '' },
  };
  let resolveBytes;
  const bytesPromise = new Promise(resolve => { resolveBytes = resolve; });
  let saveRequests = 0;
  let saveRequestOptions = null;
  let postRawImpl = async () => {
    saveRequests += 1;
    return {
      local_action_committed: true,
      verified: true,
      item: { digest_id: 'digest-save-a', relative_path: 'synthetic/a.png' },
    };
  };
  const recoveryEvents = [];
  const actionAbort = new AbortController();
  const saveCurrentPng = new Function(
    'page',
    'resultUiSeed',
    'resultRenderState',
    'actionAbort',
    'alive',
    'currentGenerationTicket',
    'currentSavedItem',
    'digestInputsLocked',
    'clipboardPermission',
    'resultOperation',
    'digestResultActionState',
    'digestResultStatusText',
    'saveProgressMessage',
    'canvasToValidatedPngBytes',
    'api',
    'createLocalActionId',
    'store',
    'scheduleLocalActionRecovery',
    'classifyLocalActionRecovery',
    'ui',
    'isMutationOutcomeUnknown',
    `let resultUi = resultUiSeed;
     ${updateSource}
     function setSaving(saving, statusText = '') {
       page.saving = saving === true;
       updateResultActionState(statusText);
     }
     ${saveSource}
     return saveCurrentPng;`,
  )(
    page,
    resultUi,
    resultRenderState,
    actionAbort,
    token => !page.destroyed && token === page.generation,
    () => ({ id: 'generation-a', token: 'ticket-a' }),
    () => null,
    () => page.saving,
    { isWriteDenied: () => false },
    { isBusy: () => false },
    digestResultActionState,
    digestResultStatusText,
    phase => phase === 'saving' ? '正在保存 PNG…' : '已确认保存',
    async () => bytesPromise,
    {
      getServiceInstanceId: () => 'service-save-a',
      postRaw(...args) {
        saveRequestOptions = args[3] || null;
        return postRawImpl(...args);
      },
    },
    () => 'save-action-a',
    { get: () => ({ display_name: 'synthetic account' }) },
    (...args) => recoveryEvents.push(args),
    () => 'verified',
    {
      toastSuccess() {},
      toast() {},
      toastError() {},
    },
    error => error?.mutation_outcome_unknown === true,
  );

  const pendingSave = saveCurrentPng();
  assert.equal(page.saving, true, 'A 保存必须同步进入 busy');
  assert.equal(tabs.every(tab => tab.disabled), true,
    'PNG 保存期间所有结果标签必须同步禁用');
  tabs[1].click();
  assert.equal(tabSwitches, 0, '真实 disabled 标签点击不得启动 B 渲染');
  assert.strictEqual(page.currentRender, renderedA);
  resolveBytes(new Uint8Array([1, 2, 3]));
  await pendingSave;
  assert.equal(saveRequests, 1, 'A 未被标签切换取代时必须完成唯一保存请求');
  assert.strictEqual(saveRequestOptions?.signal, actionAbort.signal,
    '保存 PNG 请求必须绑定页面 actionAbort signal,卸载时不能继续占用网络请求');
  assert.equal(page.saving, false, 'A 正常 settle 后必须释放自己的 saving');
  assert.equal(tabs.every(tab => !tab.disabled), true,
    '保存 settle 后结果标签必须恢复可用');

  // 保存请求已发出后切换结果/账号上下文,服务端以结果未知晚到。
  // 持久恢复登记属于已发送的副作用,不能跟随 UI owner 一起丢失;
  // 但旧 owner 仍不得写当前页面 toast/status。
  recoveryEvents.length = 0;
  page.saving = false;
  resultRenderState.begin();
  let rejectLateSave;
  postRawImpl = async () => {
    saveRequests += 1;
    return new Promise((_resolve, reject) => { rejectLateSave = reject; });
  };
  const lateSave = saveCurrentPng();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saveRequests, 2, '第二次保存必须已发出请求后再进入旧 owner 场景');
  page.generation = 8;
  rejectLateSave(Object.assign(new Error('保存结果未知'), { mutation_outcome_unknown: true }));
  await lateSave;
  assert.equal(recoveryEvents.length, 1,
    '保存请求已发出但旧 owner 晚到结果未知时仍必须启动后台恢复核对');
}

assert.equal(
  digestResultStatusText({ saving: true }),
  '正在保存 PNG…',
  '权限回调在保存期间重算结果状态时必须保留明确忙态，不能把状态清空',
);
assert.equal(
  digestResultStatusText({ saving: true, statusText: '正在核对保存结果…' }),
  '正在核对保存结果…',
  '调用方提供的更精确保存阶段必须优先于通用忙态',
);
assert.equal(
  digestResultStatusText({ saved: true, savedPath: 'synthetic/result.png' }),
  '已保存:synthetic/result.png',
  '保存完成后必须恢复既有的明确路径终态',
);
assert.equal(
  digestResultStatusText({
    saving: false,
    saved: true,
    savedPath: 'synthetic/result.png',
    statusText: '正在保存 PNG…',
  }),
  '已保存:synthetic/result.png',
  '保存 finally 不得把上一帧通用忙态固化成永久终态',
);
assert.equal(
  digestResultStatusText({ saving: false, statusText: '保存失败:磁盘不可用' }),
  '保存失败:磁盘不可用',
  '清理通用忙态时不得吞掉具体失败原因',
);
assert.match(
  digestResultStatusText({ hasRender: true, hasTicket: false }),
  /缺少保存凭据/,
  '恢复结果缺少一次性凭据时必须保留既有可操作提示',
);

assert.deepEqual(
  digestResultActionState({ hasRender: true, hasTicket: true, saved: true, running: false }),
  {
    saveDisabled: true,
    copyImageDisabled: false,
    copyPathDisabled: false,
    revealDisabled: false,
    rerenderDisabled: true,
  },
  '一次性保存凭据消费后不得再次保存或生成与已保存文件不一致的重渲染画面',
);

assert.deepEqual(
  digestResultActionState({ hasRender: true, hasTicket: false, clipboardDenied: true }),
  {
    saveDisabled: true,
    copyImageDisabled: true,
    copyPathDisabled: true,
    revealDisabled: true,
    rerenderDisabled: false,
  },
  '恢复结果缺少保存凭据时仍可重渲染预览，但不得保存或绕过明确拒绝的剪贴板权限',
);

const source = fs.readFileSync(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');
const renderStart = source.indexOf('async function renderCurrentResult(index)');
const renderEnd = source.indexOf('\n  function currentSavedItem()', renderStart);
assert.ok(renderStart >= 0 && renderEnd > renderStart, '必须能定位结果渲染生命周期');
const renderSource = source.slice(renderStart, renderEnd);
assert.match(renderSource, /const item = page\.doneResults\[index\];\s*if \(!item\) return false;\s*const renderToken = resultRenderState\.begin\(\);/,
  '无效结果索引不得先作废当前合法渲染代次');
const rerenderStart = source.indexOf('async function rerenderCurrentTheme()');
const rerenderEnd = source.indexOf('\n  // -------------------------------------------------------------------------\n  // 文本预览', rerenderStart);
assert.ok(rerenderStart >= 0 && rerenderEnd > rerenderStart, '必须能定位重绘提示生命周期');
assert.match(source.slice(rerenderStart, rerenderEnd), /const rendered = await renderCurrentResult\(index\);[\s\S]*?if \(rendered && !page\.destroyed && page\.currentResultIndex === index\)/,
  '重绘提示只能由仍是当前结果且成功提交的本次渲染发出');
assert.match(source, /import \{\s*createDigestResultOperationState,\s*digestResultActionState,\s*digestResultStatusText,\s*trackDigestLocalActionRecovery,\s*\} from '\.\/result-action-state\.js';/);
assert.match(source, /const trackLocalActionRecovery = \(request, options = \{\}\) => trackDigestLocalActionRecovery\(request,[\s\S]*schedule: scheduleLocalActionRecovery/,
  '生产结果动作必须在 task scope 过滤 UI 之前独立跟踪本地副作用恢复');
assert.match(source, /const resultOperation = createDigestResultOperationState\(\);/,
  '生产摘要页必须实例化结果动作 lease，不能只让测试引用 helper');
assert.match(source, /const resultRenderState = createDigestResultRenderState\(\);/,
  '生产摘要页必须实例化结果渲染代次，不能只让测试引用 helper');
assert.match(source, /const renderToken = resultRenderState\.begin\(\);[\s\S]*?resultRenderState\.isCurrent\(renderToken\)/,
  '新结果渲染必须在每个 await 前后使用自己的代次');
const lockStart = source.indexOf('function lockInputs(locked)');
const lockEnd = source.indexOf('\n  function currentRangeOrError', lockStart);
assert.ok(lockStart >= 0 && lockEnd > lockStart, '必须能定位生产 lockInputs 状态转换');
assert.match(
  source.slice(lockStart, lockEnd),
  /updateResultActionState\(\);/,
  '批次 running 状态变化必须同步重算结果按钮，不能保留渲染期间的禁用快照',
);
assert.match(source, /const digestInputsLocked = \(\) =>[\s\S]*?\|\| page\.saving[\s\S]*?\|\| textPreviewAction\.isBusy\(\);/,
  'PNG 保存必须进入摘要输入的统一忙态，避免保存期间启动新批次或修改渲染选项');
assert.match(source, /const digestInputsLocked = \(\) =>[\s\S]*?\|\| resultOperation\.isBusy\(\)[\s\S]*?\|\| textPreviewAction\.isBusy\(\);/,
  '结果本地动作必须进入摘要输入的统一忙态，避免操作期间替换绑定结果');
assert.match(source, /digestResultActionState\(\{[\s\S]*?saving: page\.saving,[\s\S]*?\}\);/,
  '生产结果按钮必须把当前保存生命周期传给状态机');
assert.match(source, /digestResultActionState\(\{[\s\S]*?actionBusy: resultOperation\.isBusy\(\),[\s\S]*?\}\);/,
  '生产结果按钮必须把当前本地动作 lease 传给状态机');
const saveStart = source.indexOf('async function saveCurrentPng()');
const saveEnd = source.indexOf('\n  async function copyCurrentImage()', saveStart);
assert.ok(saveStart >= 0 && saveEnd > saveStart, '必须能定位生产 PNG 保存生命周期');
const saveSource = source.slice(saveStart, saveEnd);
assert.match(saveSource, /if \(!rendered \|\| !active\?\.batch \|\| !ticket \|\| page\.saving\) return;/,
  '保存入口本身必须 fail-closed 拒绝并发调用，不能只依赖按钮 disabled');
assert.match(saveSource, /const renderToken = resultRenderState\.current\(\);[\s\S]*?resultRenderState\.isCurrent\(renderToken\)/,
  'PNG 保存完成或失败时必须确认仍属于捕获的结果渲染代次');
assert.match(saveSource, /const isCurrentSave = \(\) =>[\s\S]*?page\.activeBatch === active[\s\S]*?page\.currentRender === rendered[\s\S]*?page\.currentResultIndex === renderedIndex/,
  'PNG 保存不得把旧批次/旧群的晚到结果投影到当前预览');
assert.match(saveSource, /setSaving\(true, saveProgressMessage\('saving'\)\);[\s\S]*?finally \{[\s\S]*?setSaving\(false, statusText\);[\s\S]*?\}/,
  '保存生命周期必须用 finally 释放，并保留明确的最终状态文案');
assert.match(saveSource, /finally \{\s*if \(isCurrentSave\(\)\) \{[\s\S]*?setSaving\(false, statusText\);[\s\S]*?\}\s*\}/,
  '旧账号保存晚到时不得释放新账号已经持有的 saving owner');
const leaveStart = source.indexOf('async confirmLeaveWhileRunning()');
const leaveEnd = source.indexOf('\n    async init()', leaveStart);
assert.match(source.slice(leaveStart, leaveEnd), /if \(page\.saving\) \{[\s\S]*?return false;[\s\S]*?\}/,
  'PNG 保存期间必须 fail-closed 阻止站内离页');
assert.match(source.slice(leaveStart, leaveEnd), /if \(resultOperation\.isBusy\(\)\) \{[\s\S]*?const confirmed = await ui\.confirmDialog\(\{[\s\S]*?title: '操作仍在进行'[\s\S]*?\}\);[\s\S]*?if \(!confirmed\) return false;[\s\S]*?\}[\s\S]*?return confirmDraftPersistenceBeforeLeave\(\);/,
  '结果本地动作未返回时必须先确认，再继续执行统一草稿持久化离页保护');
assert.match(source, /page\.onBeforeUnload = event => \{[\s\S]*?page\.saving[\s\S]*?event\.preventDefault\(\);/,
  'PNG 保存期间必须触发浏览器离页保护');
assert.match(source, /page\.onBeforeUnload = event => \{[\s\S]*?resultOperation\.isBusy\(\)[\s\S]*?event\.preventDefault\(\);/,
  '结果本地动作未返回时必须触发浏览器离页保护');
assert.match(source, /async function copyCurrentImage\(\) \{[\s\S]*?const operation = beginResultOperation\('copy_image', '复制图片'\);[\s\S]*?finally \{[\s\S]*?endResultOperation\(operation\);[\s\S]*?\}/,
  '复制图片入口必须持有并最终释放结果动作 lease');
assert.match(source, /async function copySavedPath\(\) \{[\s\S]*?const operation = beginResultOperation\('copy_path', '复制路径'\);[\s\S]*?finally \{[\s\S]*?endResultOperation\(operation\);[\s\S]*?\}/,
  '复制路径入口必须持有并最终释放结果动作 lease');
assert.match(source, /async function revealSavedItem\(\) \{[\s\S]*?const operation = beginResultOperation\('reveal', '在文件夹显示'\);[\s\S]*?finally \{[\s\S]*?endResultOperation\(operation\);[\s\S]*?\}/,
  '文件夹显示入口必须持有并最终释放结果动作 lease');
assert.match(source, /async destroy\(\) \{[\s\S]*?resultOperation\.invalidate\(\);[\s\S]*?taskScope\.dispose\(\);/,
  '页面卸载必须先使结果动作 lease 失效，再销毁异步回写作用域');

// 未保存图片复制必须先持久化 prepared 证据再交给浏览器。
// 服务端无法落盘时返回 503；生产 caller 若吞掉该失败，仍会创建 Blob 并写剪贴板，
// 之后浏览器结果未知却没有可恢复的本地 marker。
{
  const copySource = extractFunction(source, 'async function copyCurrentImage()');
  const rendered = {
    canvas: { id: 'canvas-prepared-failure' },
    width: 640,
    height: 480,
    digest: { digest_id: 'digest-prepared-failure' },
  };
  const page = { destroyed: false, currentRender: rendered, currentResultIndex: 0 };
  const taskScope = createPageTaskScope();
  const resultRenderState = createDigestResultRenderState();
  resultRenderState.begin();
  const actionAbort = new AbortController();
  const operation = Object.freeze({ kind: 'copy_image' });
  const phases = [];
  const toastEvents = [];
  let blobCalls = 0;
  let clipboardWrites = 0;
  let endCalls = 0;
  const originalClipboardItem = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem');
  Object.defineProperty(globalThis, 'ClipboardItem', {
    configurable: true,
    value: class ClipboardItem {
      constructor(items) { this.items = items; }
    },
  });
  const captureResultOwner = currentRendered => {
    const token = resultRenderState.current();
    const index = page.currentResultIndex;
    return {
      isCurrent: () => !page.destroyed
        && resultRenderState.isCurrent(token)
        && page.currentRender === currentRendered
        && page.currentResultIndex === index,
    };
  };
  const copyCurrentImage = new Function(
    'page',
    'beginResultOperation',
    'currentSavedItem',
    'taskScope',
    'resultRenderState',
    'captureResultOwner',
    'copySavedImageToSystemClipboard',
    'createLocalActionId',
    'api',
    'actionAbort',
    'clipboardPermission',
    'canvasToPngBlob',
    'submitBrowserClipboardWriteLocked',
    'ui',
    'endResultOperation',
    `${copySource}; return copyCurrentImage;`,
  )(
    page,
    () => operation,
    () => null,
    taskScope,
    resultRenderState,
    captureResultOwner,
    async () => { throw new Error('未保存分支不得调用已保存复制'); },
    () => 'copy-image-prepared-failure',
    {
      async post(_path, body) {
        phases.push(body?.phase || '');
        if (body?.phase === 'prepared') {
          throw Object.assign(new Error('无法持久化 prepared 证据'), {
            code: 'browser_clipboard_evidence_unavailable',
            status: 503,
          });
        }
        return { ok: true, evidence_persisted: true };
      },
    },
    actionAbort,
    { async refresh() { return { write: 'granted' }; } },
    async () => {
      blobCalls += 1;
      return new Blob(['png-prepared-failure'], { type: 'image/png' });
    },
    async () => {
      clipboardWrites += 1;
    },
    {
      toastWarn(message) { toastEvents.push(['warn', message]); },
      toast(message, options) { toastEvents.push(['toast', message, options]); },
      toastError(message) { toastEvents.push(['error', message]); },
      toastSuccess(message) { toastEvents.push(['success', message]); },
    },
    () => { endCalls += 1; },
  );
  try {
    await copyCurrentImage();
    assert.equal(blobCalls, 0,
      'prepared 证据无法落盘时不得创建浏览器剪贴板 Blob');
    assert.equal(clipboardWrites, 0,
      'prepared 证据无法落盘时不得调用浏览器剪贴板写入');
    assert.deepEqual(phases, ['prepared'],
      'prepared 证据失败后不得伪造提交或拒绝阶段');
    assert.equal(endCalls, 1, 'prepared 证据失败仍必须释放自己的结果动作 lease');
    assert.equal(toastEvents.at(-1)?.[0], 'error',
      'prepared 证据失败必须给出可操作错误，而不是误报复制成功');
  } finally {
    if (originalClipboardItem) Object.defineProperty(globalThis, 'ClipboardItem', originalClipboardItem);
    else delete globalThis.ClipboardItem;
  }
}

// 浏览器已经完成写入,但 browser_committed 证据落盘失败时,不能把写入
// 当作成功,也不能把它改写成 rejected；必须尽力登记 outcome_unknown,
// 保留用户核对剪贴板的路径。
{
  const copySource = extractFunction(source, 'async function copyCurrentImage()');
  const rendered = {
    canvas: { id: 'canvas-commit-evidence-failure' },
    width: 800,
    height: 600,
    digest: { digest_id: 'digest-commit-evidence-failure' },
  };
  const page = { destroyed: false, currentRender: rendered, currentResultIndex: 0 };
  const taskScope = createPageTaskScope();
  const resultRenderState = createDigestResultRenderState();
  resultRenderState.begin();
  const actionAbort = new AbortController();
  const operation = Object.freeze({ kind: 'copy_image' });
  const phases = [];
  const toastEvents = [];
  let blobCalls = 0;
  let clipboardWrites = 0;
  let endCalls = 0;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalClipboardItem = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { async write() {} } },
  });
  Object.defineProperty(globalThis, 'ClipboardItem', {
    configurable: true,
    value: class ClipboardItem {
      constructor(items) { this.items = items; }
    },
  });
  const captureResultOwner = currentRendered => {
    const token = resultRenderState.current();
    const index = page.currentResultIndex;
    return {
      isCurrent: () => !page.destroyed
        && resultRenderState.isCurrent(token)
        && page.currentRender === currentRendered
        && page.currentResultIndex === index,
    };
  };
  const copyCurrentImage = new Function(
    'page',
    'beginResultOperation',
    'currentSavedItem',
    'taskScope',
    'resultRenderState',
    'captureResultOwner',
    'copySavedImageToSystemClipboard',
    'createLocalActionId',
    'api',
    'actionAbort',
    'clipboardPermission',
    'canvasToPngBlob',
    'submitBrowserClipboardWriteLocked',
    'ui',
    'endResultOperation',
    `${copySource}; return copyCurrentImage;`,
  )(
    page,
    () => operation,
    () => null,
    taskScope,
    resultRenderState,
    captureResultOwner,
    async () => { throw new Error('未保存分支不得调用已保存复制'); },
    () => 'copy-image-commit-evidence-failure',
    {
      async post(_path, body) {
        phases.push(body?.phase || '');
        if (body?.phase === 'browser_committed') {
          throw Object.assign(new Error('无法持久化 browser_committed 证据'), {
            code: 'browser_clipboard_evidence_unavailable',
            status: 503,
          });
        }
        return { ok: true, evidence_persisted: true };
      },
    },
    actionAbort,
    { async refresh() { return { write: 'granted' }; } },
    async () => {
      blobCalls += 1;
      return new Blob(['png-commit-evidence-failure'], { type: 'image/png' });
    },
    async callback => {
      clipboardWrites += 1;
      return callback();
    },
    {
      toastWarn(message) { toastEvents.push(['warn', message]); },
      toast(message, options) { toastEvents.push(['toast', message, options]); },
      toastError(message) { toastEvents.push(['error', message]); },
      toastSuccess(message) { toastEvents.push(['success', message]); },
    },
    () => { endCalls += 1; },
  );
  try {
    await copyCurrentImage();
    assert.equal(blobCalls, 1, '提交证据失败不应撤销已经创建的浏览器 Blob');
    assert.equal(clipboardWrites, 1, '提交证据失败前浏览器写入必须确实发生');
    assert.deepEqual(phases, ['prepared', 'browser_committed', 'outcome_unknown'],
      'browser_committed 证据失败后必须转入 outcome_unknown,不得伪造 rejected');
    assert.equal(toastEvents.at(-1)?.[0], 'toast',
      '浏览器写入已发生但证据失败时必须提示用户粘贴核对');
    assert.equal(toastEvents.some(([kind]) => kind === 'success'), false,
      'browser_committed 证据失败时不得误报复制成功');
    assert.equal(toastEvents.some(([kind]) => kind === 'error'), false,
      '浏览器写入已发生时不得误报普通复制失败');
    assert.equal(endCalls, 1, '提交证据失败仍必须释放自己的结果动作 lease');
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
    if (originalClipboardItem) Object.defineProperty(globalThis, 'ClipboardItem', originalClipboardItem);
    else delete globalThis.ClipboardItem;
  }
}

console.log('web digest result action state tests passed');
