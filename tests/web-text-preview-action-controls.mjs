import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTextPreviewActionState } from '../src/web/public/js/pages/digest/text-preview-action-state.js';
import { createPageTaskScope } from '../src/web/public/js/shared/page-task.js';
import { trackDigestLocalActionRecovery } from '../src/web/public/js/pages/digest/result-action-state.js';
import { classifyLocalActionRecovery } from '../src/web/public/js/shared/local-action-recovery-state.js';
import { textPreviewExportFeedback } from '../src/web/public/js/pages/digest/text-preview-export-feedback.js';

function extractFunction(sourceText, marker) {
  const start = sourceText.indexOf(marker);
  assert.ok(start >= 0, `必须能定位 ${marker}`);
  const open = sourceText.indexOf('{', start);
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
    if (char === '`' || char === '\'' || char === '"') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return sourceText.slice(start, index + 1);
  }
  throw new Error(`${marker} 函数体未闭合`);
}

function extractFunctionWithDestructuredOptions(sourceText, marker) {
  const start = sourceText.indexOf(marker);
  assert.ok(start >= 0, `必须能定位 ${marker}`);
  const open = sourceText.indexOf(') {', start);
  assert.ok(open >= 0, `${marker} 必须能定位函数体`);
  const bodyOpen = open + 2;
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = bodyOpen; index < sourceText.length; index += 1) {
    const char = sourceText[index];
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
    else if (char === '}' && --depth === 0) return sourceText.slice(start, index + 1);
  }
  throw new Error(`${marker} 函数体未闭合`);
}

const source = fs.readFileSync(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');
const admitRecoveredBatchSource = extractFunctionWithDestructuredOptions(
  source,
  'async function admitRecoveredBatch',
);

const syncStart = source.indexOf('function syncTextPreviewActionControls()');
const syncEnd = source.indexOf('\n  function invalidateTextPreviewAction', syncStart);
assert.ok(syncStart >= 0 && syncEnd > syncStart, '必须能定位文本预览动作的统一控件同步');
const syncSource = source.slice(syncStart, syncEnd);
assert.match(
  syncSource,
  /syncInputControls\(\);[\s\S]*syncSelectionUi\(\);[\s\S]*renderGroupList\(\);[\s\S]*syncActionHint\(\);/,
  '文本复制或导出忙态必须重绘现有群复选框，不能只更新其他输入控件',
);
assert.match(
  syncSource,
  /function syncTextPreviewActionControls\(\) \{\s*if \(page\.destroyed\) return;/,
  '文本预览页面销毁后不得再通过失效 action 重绘旧页面控件',
);

const cardStart = source.indexOf('function renderTextPreviewCard()');
const cardEnd = source.indexOf('\n  // -------------------------------------------------------------------------', cardStart);
assert.ok(cardStart >= 0 && cardEnd > cardStart, '必须能定位文本预览卡片动作生命周期');
const card = source.slice(cardStart, cardEnd);

const copyStart = card.indexOf("copyBtn.addEventListener('click'");
const copyEnd = card.indexOf("exportBtn.addEventListener('click'", copyStart);
const exportStart = copyEnd;
const exportEnd = card.indexOf("downloadBtn.addEventListener('click'", exportStart);
assert.ok(copyStart >= 0 && copyEnd > copyStart && exportEnd > exportStart, '必须能定位复制和导出动作');

for (const [label, actionSource] of [
  ['复制全文', card.slice(copyStart, copyEnd)],
  ['导出 Markdown', card.slice(exportStart, exportEnd)],
]) {
  assert.match(
    actionSource,
    /const actionFocusTarget = captureActionFocus\(actionButtons, globalThis\.document\?\.activeElement\);[\s\S]*syncActionButtons\(\);/,
    `${label}必须在禁用动作按钮前捕获真实触发焦点`,
  );
  assert.match(
    actionSource,
    /finally \{[\s\S]*if \(releaseAction\(action\)\) \{[\s\S]*restoreActionFocus\(actionFocusTarget,[\s\S]*activeElement: globalThis\.document\?\.activeElement,[\s\S]*body: globalThis\.document\?\.body/,
    `${label}只应在当前 action 成功释放并重新启用按钮后安全恢复焦点`,
  );
}

const downloadStart = card.indexOf("downloadBtn.addEventListener('click'");
assert.ok(downloadStart >= 0, '必须能定位 Markdown 下载动作');
const downloadSource = card.slice(downloadStart);
assert.match(
  downloadSource,
  /if \(!page\.destroyed && focusTarget\?\.isConnected && typeof focusTarget\.focus === 'function'\)/,
  'Markdown 下载动作在页面销毁后不得把焦点恢复到旧按钮',
);

// 直接执行生产 renderTextPreviewCard 里的 copy/export listener：请求已经发出后预览被替换，
// API 即使忽略 abort 并晚到“结果未知”，恢复日志仍必须启动后台核对；旧卡片不得写 toast/status/focus。
for (const scenario of [
  { label: '复制全文', buttonText: '复制全文', endpoint: '/api/copy-text', recoveryKind: 'text_clipboard_copy' },
  { label: '导出 Markdown', buttonText: '导出 MD', endpoint: '/api/export-preview', recoveryKind: 'export_preview' },
]) {
  const renderSource = extractFunction(source, 'function renderTextPreviewCard()');
  const nodes = [];
  const makeNode = (tag = 'div', text = '') => {
    const listeners = new Map();
    const node = {
      tag,
      textContent: String(text || ''),
      children: [],
      disabled: false,
      hidden: false,
      isConnected: true,
      append(...children) { this.children.push(...children.filter(Boolean)); },
      appendChild(child) { if (child) this.children.push(child); return child; },
      replaceChildren(...children) { this.children = children.filter(Boolean); },
      setAttribute() {},
      removeAttribute() {},
      addEventListener(type, listener) { listeners.set(type, listener); },
      listener(type) { return listeners.get(type); },
      focus() { focusWrites += 1; },
      click() {},
      remove() { this.isConnected = false; },
    };
    nodes.push(node);
    return node;
  };
  const document = {
    activeElement: null,
    body: makeNode('body'),
    createElement: tag => makeNode(tag),
  };
  const el = (tag, className = '', text = '') => {
    const node = makeNode(tag, text);
    node.className = className;
    return node;
  };
  const page = {
    destroyed: false,
    previewDigests: [{ digest_id: 'digest-preview-a' }],
    previewMarkdown: '# A',
    activeBatch: { batch: { batch_id: 'batch-a', batch_token: 'token-a', service_instance_id: 'service-a' } },
  };
  const textPreviewSlot = makeNode('slot');
  const textPreviewAction = createTextPreviewActionState();
  const taskScope = createPageTaskScope();
  let resolveRequest;
  let rejectRequest;
  let notifyRequestStarted;
  const requestStarted = new Promise(resolve => { notifyRequestStarted = resolve; });
  let activeRequest = new Promise((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });
  const paths = [];
  const recoveryEvents = [];
  const toastEvents = [];
  const scheduleLocalActionRecovery = (...args) => recoveryEvents.push(args);
  const trackLocalActionRecovery = (request, options = {}) => trackDigestLocalActionRecovery(request, {
    ...options,
    schedule: scheduleLocalActionRecovery,
  });
  let focusWrites = 0;
  const renderTextPreviewCard = new Function(
    'page',
    'document',
    'textPreviewSlot',
    'textPreviewAction',
    'taskScope',
    'trackLocalActionRecovery',
    'invalidateTextPreviewAction',
    'syncTextPreviewActionControls',
    'el',
    'browserDownloadCapability',
    'browserDownloadUnsupportedMessage',
    'captureActionFocus',
    'api',
    'createLocalActionId',
    'classifyLocalActionRecovery',
    'ui',
    'isMutationOutcomeUnknown',
    'scheduleLocalActionRecovery',
    'restoreActionFocus',
    'store',
    'accountIdOf',
    'accountFingerprintOf',
    'textPreviewExportFeedback',
    `${renderSource}; return renderTextPreviewCard;`,
  )(
    page,
    document,
    textPreviewSlot,
    textPreviewAction,
    taskScope,
    trackLocalActionRecovery,
    reason => textPreviewAction.invalidate(reason),
    () => {},
    el,
    () => ({ supported: true }),
    () => '',
    () => ({ focus: 'old-card' }),
    {
      getServiceInstanceId: () => 'service-a',
      post(path) {
        paths.push(path);
        notifyRequestStarted();
        return activeRequest;
      },
    },
    kind => `${kind}-action-a`,
    classifyLocalActionRecovery,
    {
      toastSuccess(message) { toastEvents.push(['success', message]); },
      toastWarn(message) { toastEvents.push(['warn', message]); },
      toast(message, options) { toastEvents.push(['toast', message, options]); },
      toastError(message) { toastEvents.push(['error', message]); },
    },
    error => error?.mutation_outcome_unknown === true,
    scheduleLocalActionRecovery,
    () => { focusWrites += 1; },
    { get: key => key === 'account' ? { id: 'account-a', manual_key_account_fingerprint: 'fingerprint-a' } : null },
    account => account?.id || '',
    account => account?.manual_key_account_fingerprint || '',
    textPreviewExportFeedback,
  );

  renderTextPreviewCard();
  const button = nodes.find(node => node.tag === 'button' && node.textContent === scenario.buttonText);
  assert.ok(button?.listener('click'), `${scenario.label}必须由生产 listener 绑定`);
  document.activeElement = button;
  const status = nodes.find(node => String(node.className || '').includes('result-status'));
  const pending = button.listener('click')();
  await requestStarted;
  assert.deepEqual(paths, [scenario.endpoint], `${scenario.label}必须真实发起生产 API`);
  const statusBeforeLateFailure = status.textContent;
  textPreviewAction.invalidate('预览 B 已替换 A');
  taskScope.invalidate();
  rejectRequest(Object.assign(new Error(`${scenario.label}结果未知`), { mutation_outcome_unknown: true }));
  await pending;

  assert.equal(recoveryEvents.length, 1, `${scenario.label}失效后的结果未知仍必须启动一次后台恢复核对`);
  assert.equal(recoveryEvents[0][1], scenario.recoveryKind,
    `${scenario.label}必须使用正确的恢复动作类型`);
  assert.deepEqual(toastEvents, [], `${scenario.label}旧动作不得把提示投影到新预览`);
  assert.equal(status.textContent, statusBeforeLateFailure, `${scenario.label}旧动作不得改写旧卡片终态`);
  assert.equal(focusWrites, 0, `${scenario.label}旧动作不得从新预览抢回焦点`);

  activeRequest = new Promise((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });
  const committedPending = button.listener('click')();
  textPreviewAction.invalidate('预览 C 已替换 B');
  taskScope.invalidate();
  resolveRequest({ local_action_committed: true, verification_pending: true });
  await committedPending;
  assert.equal(recoveryEvents.length, 2,
    `${scenario.label}失效后的已提交待核验响应仍必须启动一次后台恢复核对`);
  assert.deepEqual(toastEvents, [], `${scenario.label}旧待核验动作不得把提示投影到新预览`);
  assert.equal(status.textContent, statusBeforeLateFailure, `${scenario.label}旧待核验动作不得改写旧卡片终态`);
  assert.equal(focusWrites, 0, `${scenario.label}旧待核验动作不得从新预览抢回焦点`);

  if (scenario.recoveryKind === 'export_preview') {
    // 恢复按钮走 admitRecoveredBatch() 时可以在导出请求挂起期间接管
    // page.activeBatch;该 owner 换代路径不依赖 textPreviewAction.invalidate。
    // 旧导出即使成功晚到,也不得把提示、状态或焦点写回新批次。
    activeRequest = new Promise((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const ownerSwapStatus = status.textContent;
    focusWrites = 0;
    const ownerSwapPending = button.listener('click')();
    const admitRecoveredBatch = new Function(
      'page',
      'releaseActiveBatch',
      'startBatchKeepalive',
      `${admitRecoveredBatchSource}; return admitRecoveredBatch;`,
    )(
      page,
      async ({ owner }) => {
        assert.equal(page.activeBatch, owner, '恢复 admission 必须只释放当前 owner');
        page.activeBatch = null;
        return true;
      },
      () => {},
    );
    const admission = await admitRecoveredBatch({
      batch: { batch_id: 'batch-b', batch_token: 'token-b', service_instance_id: 'service-b' },
    });
    assert.equal(admission.admitted, true, '恢复 admission 必须能够接管已确认释放的旧批次');
    resolveRequest({
      local_action_committed: true,
      local_action_id: 'export-action-a',
      verified: true,
      item: { relative_path: 'preview-a.md' },
    });
    await ownerSwapPending;
    assert.deepEqual(toastEvents, [], '旧批次导出晚到不得向新批次投影提示');
    assert.equal(status.textContent, ownerSwapStatus, '旧批次导出晚到不得改写新批次状态');
    assert.equal(focusWrites, 0, '旧批次导出晚到不得抢回新批次焦点');

    activeRequest = new Promise((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    page.activeBatch = {
      batch: { batch_id: 'batch-b', batch_token: 'token-b', service_instance_id: 'service-b' },
    };
    const staleRejectStatus = status.textContent;
    focusWrites = 0;
    const staleRejectPending = button.listener('click')();
    const rejectAdmission = new Function(
      'page',
      'releaseActiveBatch',
      'startBatchKeepalive',
      `${admitRecoveredBatchSource}; return admitRecoveredBatch;`,
    )(
      page,
      async ({ owner }) => {
        assert.equal(page.activeBatch, owner, '错误交错的恢复 admission 也必须只释放当前 owner');
        page.activeBatch = null;
        return true;
      },
      () => {},
    );
    const rejectAdmissionResult = await rejectAdmission({
      batch: { batch_id: 'batch-c', batch_token: 'token-c', service_instance_id: 'service-c' },
    });
    assert.equal(rejectAdmissionResult.admitted, true);
    rejectRequest(new Error('旧批次导出失败'));
    await staleRejectPending;
    assert.deepEqual(toastEvents, [], '旧批次导出错误晚到不得向新批次投影提示');
    assert.equal(status.textContent, staleRejectStatus, '旧批次导出错误晚到不得改写新批次状态');
    assert.equal(focusWrites, 0, '旧批次导出错误晚到不得抢回新批次焦点');

    // 当前卡片的 verified 响应若只完成服务端副作用、但 marker 清理失败,
    // 生产 caller 仍必须显示待核对,而不是把已执行误报成完全成功。
    activeRequest = new Promise((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const currentPending = button.listener('click')();
    resolveRequest({
      local_action_committed: true,
      local_action_id: 'export-action-a',
      verified: true,
      item: { relative_path: 'preview.md' },
      local_action_recovery_cleanup_failed: true,
    });
    await currentPending;
    assert.equal(toastEvents.at(-1)?.[0], 'toast', 'marker 清理失败时导出必须走可见警告提示');
    assert.equal(toastEvents.at(-1)?.[2]?.type, 'warn', 'marker 清理失败时不得显示成功 toast');
    assert.match(status.textContent, /核对待完成/, 'marker 清理失败时状态必须保留待核对语义');
  }
}

console.log('web text preview action controls tests passed');
