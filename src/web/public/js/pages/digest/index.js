// 总结页:选群 → 选范围/过滤 → 批次生成 → 长图渲染/保存/导出。
// 协议细节全部委托 batch-runner.js / recovery.js;本文件只做状态与 DOM。
import { isMutationOutcomeUnknown } from '/js/api.js';
import { RANGE_KEYS, RANGE_LABELS, resolveRange, rangeSummaryText } from './ranges.js';
import {
  runDigestBatch,
  cancelDigestBatch,
  digestBatchHasUsableResult,
  digestBatchFailureNeedsRecovery,
  digestBatchFinishConfirmed,
  digestBatchCancelConfirmed,
} from './batch-runner.js';
import {
  rememberInterruptedDigestBatch,
  forgetInterruptedDigestBatch,
  finalizeInterruptedDigestBatchRecord,
  interruptedDigestBatchMatchesAccount,
  createDigestRecoveryOwner,
  interruptedDigestBatchStorageKey,
  readInterruptedDigestBatchRecords,
  runRecoveryOnce,
  digestBatchRecoveryList,
  digestBatchPreviewRecovery,
  digestTerminalResultRequest,
  requireDigestTerminalResult,
  digestTerminalRecoveryMetadata,
  interruptedDigestRenderSelection,
  selectInterruptedDigestBatchRecord,
  subscribeInterruptedDigestRecoveryChanges,
} from './recovery.js';
import { createProgressView } from './progress.js';
import {
  renderDigestToCanvas,
  canvasToPngBlob,
  canvasToValidatedPngBytes,
} from './render.js';
import { freezeDigestRenderSelection } from './render-selection.js';
import { digestGenerationGroupAdmission } from './generation-admission.js';
import { reconcileDigestGroupSelection } from './group-selection.js';
import { digestMarkdownForDigests } from '/js/shared/digest-view-model.js';
import {
  digestDraftHasMeaningfulInput,
  readDigestDraftSnapshot,
  writeDigestDraftSnapshot,
} from '/js/shared/digest-draft-store.js';
import { parseLocalDateTime } from '/js/shared/local-date-time.js';
import { parseStrictIntegerInput } from '/js/shared/numeric-input.js';
import { focusFirstInvalid, setFieldInvalid } from '/js/shared/form-accessibility.js';
import { captureActionFocus, restoreActionFocus } from '/js/shared/action-focus.js';
import { submitBrowserClipboardWriteLocked } from '/js/shared/clipboard-write-coordinator.js';
import { createClipboardPermissionController } from '/js/shared/clipboard-permission.js';
import {
  browserDownloadCapability,
  browserDownloadUnsupportedMessage,
} from '/js/shared/browser-download-capability.js';
import { classifyLocalActionRecovery } from '/js/shared/local-action-recovery-state.js';
import {
  localActionEvidenceSettled,
  settleLocalActionInBackground,
} from '/js/shared/local-action-recovery.js';
import { createPageTaskScope } from '/js/shared/page-task.js';
import { createCrossTabTaskRunner } from '/js/shared/cross-tab-task-runner.js';
import { createZoomRegion } from '/js/shared/zoom-region.js';
import {
  createGroupLoadScope,
  createGroupProgressPoller,
  formatGroupProgressText,
} from './group-load-scope.js';
import { requireGroupList } from '/js/shared/group-list-contract.js';
import { publicAccountAliases } from '/js/shared/account-context.js';
import { createDigestDraftScopeLifecycle } from './draft-scope.js';
import { createAccountContextRefreshController } from './account-context-refresh.js';
import {
  digestAccountContextIdentity,
  invalidateDigestAccountAsyncWork,
} from './account-context.js';
import { createDigestSettingsDerivedLoader } from './settings-derived.js';
import { createRecoveryActionState } from './recovery-action-state.js';
import { createDigestResultRenderState } from './result-render-state.js';
import { createDigestAccountResultContextHandler } from './account-result-state.js';
import {
  clearDbMirrorAutoFailure,
  dbMirrorDiagnosticsReady,
  isDbMirrorFailure,
  rememberDbMirrorAutoFailure,
} from '/js/shared/db-mirror-failure.js';
import { createTextPreviewActionState } from './text-preview-action-state.js';
import {
  textPreviewAccountSwitchBlockedMessage,
  textPreviewBusyHint,
  textPreviewLeaveConfirmation,
} from './text-preview-action-feedback.js';
import { textPreviewExportFeedback } from './text-preview-export-feedback.js';
import { syncDigestPreviewIdentity } from './preview-identity.js';
import { createResultZoomTrigger } from './result-zoom-trigger.js';
import { createScopedUi } from '../../ui/lifecycle.js';
import {
  createDigestResultOperationState,
  digestResultActionState,
  digestResultStatusText,
  trackDigestLocalActionRecovery,
} from './result-action-state.js';
import {
  digestGroupSessionWarning,
  digestWechatStatusMessageTone,
  formatGroupLastMessageLabel,
} from './group-status.js';
import { createRenderProgressTracker, saveProgressMessage } from './progress-state.js';
import { setSegmentedButtonState } from '../../ui/segmented.js';
import {
  createCustomRangeValidationFeedback,
  validateCustomRange,
} from './custom-range.js';

const DRAFT_STORAGE_KEY = `wx-summary:digest-drafts:v1:${location.origin}`;
const INTERRUPTED_BATCH_STORAGE_KEY = interruptedDigestBatchStorageKey(location.origin);
const GROUPS_TIMEOUT_MS = 600 * 1000;
const BATCH_KEEPALIVE_MS = 15 * 1000;
const EXCLUDE_TYPE_OPTIONS = Object.freeze([
  ['image', '图片'],
  ['voice', '语音'],
  ['video', '视频'],
  ['file', '文件'],
]);

// 本地动作 ID 使用服务端接受的稳定格式。
function createLocalActionId(kind = 'action') {
  const cleanKind = String(kind || 'action').replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'action';
  const bytes = new Uint8Array(6);
  try { globalThis.crypto?.getRandomValues?.(bytes); } catch {}
  const random = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('')
    || Math.random().toString(16).slice(2, 14);
  return `${cleanKind}_${Date.now().toString(36)}_${random}`;
}

function createGroupProgressId() {
  const bytes = new Uint8Array(6);
  try { globalThis.crypto?.getRandomValues?.(bytes); } catch {}
  const random = [...bytes].map(value => value.toString(36).padStart(2, '0')).join('');
  return `gp2_${Date.now().toString(36)}_${random}`.slice(0, 80);
}

function accountFingerprintOf(account) {
  return String(account?.manual_key_account_fingerprint || '').trim().toLowerCase();
}

function accountIdOf(account) {
  return String(account?.id || account?.account_id || '').trim();
}

async function digestCrossTabTaskId(accountId, fingerprint) {
  const input = `${String(accountId || '').trim()}|${String(fingerprint || '').trim().toLowerCase()}`;
  const subtle = globalThis.crypto?.subtle;
  const Encoder = globalThis.TextEncoder;
  if (!subtle || typeof subtle.digest !== 'function' || typeof Encoder !== 'function') {
    const error = new Error('当前浏览器不支持摘要跨标签身份协调');
    error.code = 'digest_cross_tab_identity_hash_unavailable';
    throw error;
  }
  const bytes = await subtle.digest('SHA-256', new Encoder().encode(input));
  const hex = [...new Uint8Array(bytes)]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');
  return `digest-${hex}`;
}

function digestRecoveryIdentity(account) {
  return {
    accountId: accountIdOf(account),
    accountFingerprint: accountFingerprintOf(account),
  };
}

// 白名单匹配:ref 必须带当前账号的主 ID 或可信数据身份作用域。
function whitelistRefMatchesGroup(ref, group, accountOrId) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return false;
  const refAccount = String(ref.account_id || ref.account || '').trim();
  const accountScopes = accountOrId && typeof accountOrId === 'object'
    ? [
      accountIdOf(accountOrId),
      accountOrId.account_id,
      accountOrId.identity_id,
      accountOrId.mirror?.identity_id,
    ]
    : [accountOrId];
  if (!refAccount || !accountScopes.some(scope => String(scope || '').trim() === refAccount)) return false;
  const refGroupId = String(ref.group_id || ref.id || '').trim();
  if (refGroupId && refGroupId === String(group.id || '').trim()) return true;
  const refGroupName = String(ref.group_name || ref.name || '').trim();
  return !!refGroupName && refGroupName === String(group.name || '').trim();
}

function recentRefBelongsToAccount(ref, account) {
  const refAccount = String(ref?.account_id || ref?.account || '').trim();
  if (!refAccount) return false;
  const aliases = new Set([
    ...publicAccountAliases(account),
    account?.identity_id,
    account?.mirror?.identity_id,
  ].map(value => String(value || '').trim()).filter(Boolean));
  return aliases.has(refAccount);
}

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

// 当前页面实例(模块被 router 缓存,同一时刻只挂载一次)。
let activePage = null;

export default {
  title: '总结',

  async mount(root, ctx) {
    const page = buildPage(root, ctx);
    activePage = page;
    await page.init();
    return () => page.destroy();
  },

  async unmount() {
    if (activePage) {
      await activePage.destroy();
      activePage = null;
    }
  },

  async canLeave() {
    if (!activePage) return true;
    return activePage.confirmLeaveWhileRunning();
  },
};

function buildPage(root, ctx) {
  const { api, store, ui: baseUi } = ctx;
  const taskScope = createPageTaskScope();
  const groupLoadScope = createGroupLoadScope();
  const recoveryAction = createRecoveryActionState();
  const textPreviewAction = createTextPreviewActionState();
  const resultOperation = createDigestResultOperationState();
  const resultRenderState = createDigestResultRenderState();
  const actionAbort = new AbortController();
  const ui = createScopedUi(baseUi, actionAbort.signal);
  const digestGenerationRunner = createCrossTabTaskRunner({
    locks: globalThis.navigator?.locks || null,
    namespace: 'digest-generation',
  });
  let draftScopeLifecycle = null;

  const scheduleLocalActionRecovery = (actionId, kind, target = null, response = undefined) => {
    if (response !== undefined && localActionEvidenceSettled(kind, response)) return false;
    void settleLocalActionInBackground({
      api,
      actionId,
      kind,
      target,
      maxWaitMs: 38_000,
    }).catch(() => {});
    return true;
  };

  const trackLocalActionRecovery = (request, options = {}) => trackDigestLocalActionRecovery(request, {
    ...options,
    schedule: scheduleLocalActionRecovery,
  });

  // -------------------------------------------------------------------------
  // 页面状态
  // -------------------------------------------------------------------------
  const page = {
    destroyed: false,
    running: false,
    saving: false,
    generation: 0, // 异步竞态防护:每次 mount/重要操作递增
    groups: [],
    groupsStatus: 'idle', // idle | loading | error | ready
    groupsError: '',
    groupsProgressText: '',
    groupsNeedsAccountRefresh: false,
    accountContextBlocked: false,
    searchText: '',
    selected: new Set(),
    recentRefs: [],
    whitelistRefs: [],
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
    minMessages: 1,
    renderOptions: { theme: 'auto', fontSize: 'normal' },
    generationRender: null,
    previewProcessingGroup: '',
    // 运行态
    generationStarting: false,
    abortController: null,
    progressView: null,
    progressCleanupTimer: null,
    activeBatch: null,       // { batch, finish, previewText, results }
    activeBatchRelease: null, // { owner, promise } 当前 owner 的服务端收尾
    crossTabGenerationLease: null,
    cancelGenerationOwner: null, // 当前用户取消请求的 job owner
    keepaliveTimer: null,
    // 结果态
    doneResults: [],
    currentResultIndex: 0,
    currentRender: null,     // { canvas, digest, ... }
    savedItems: new Map(),   // digest_id -> item
    previewDigests: [],
    previewMarkdown: '',
    draftSaveTimer: null,
    draftPersistenceFailed: false,
  };

  page.acquireCrossTabGenerationLease = async (accountId, fingerprint) => {
    const taskId = await digestCrossTabTaskId(accountId, fingerprint);
    const current = page.crossTabGenerationLease;
    if (current) {
      if (current.taskId === taskId) return { acquired: true, reused: true };
      return { acquired: false, busy: true };
    }
    const result = await digestGenerationRunner.acquire(taskId, { ifAvailable: true });
    if (result?.acquired === true) {
      page.crossTabGenerationLease = { ...result, taskId };
    }
    return result;
  };
  page.releaseCrossTabGenerationLease = expectedLease => {
    const lease = page.crossTabGenerationLease;
    if (expectedLease !== undefined
      && (expectedLease?.acquired !== true || lease?.release !== expectedLease.release)) return false;
    page.crossTabGenerationLease = null;
    return lease?.release?.() === true;
  };

  function clearProgressCleanupTimer() {
    const timer = page.progressCleanupTimer;
    page.progressCleanupTimer = null;
    if (timer !== null && timer !== undefined) clearTimeout(timer);
  }

  function scheduleProgressCleanup(progressElement) {
    clearProgressCleanupTimer();
    const timer = setTimeout(() => {
      if (page.progressCleanupTimer !== timer) return;
      page.progressCleanupTimer = null;
      if (!page.destroyed && !page.running
        && progressSlot.firstElementChild === progressElement) {
        progressSlot.replaceChildren();
      }
    }, 4000);
    page.progressCleanupTimer = timer;
  }

  const settingsDerived = createDigestSettingsDerivedLoader({
    api,
    signal: actionAbort.signal,
    isActive: () => !page.destroyed,
    apply: ({ whitelistRefs, recentRefs }) => {
      page.whitelistRefs = whitelistRefs;
      page.recentRefs = recentRefs;
      renderRecentRefs();
    },
  });

  // 页面弹层挂在全局 modal-root,路由卸载不会替它们自动清理。
  const pageModals = new Set();
  function openPageModal(options = {}) {
    let entry = null;
    const modal = ui.openModal({
      ...options,
      onClose: () => {
        if (entry) pageModals.delete(entry);
        try { options.onClose?.(); } catch (error) {
          console.error('page modal close callback failed', error);
        }
      },
    });
    entry = { modal };
    pageModals.add(entry);
    return modal;
  }

  function closePageModals({ restoreFocus = true } = {}) {
    for (const entry of [...pageModals]) {
      try { entry.modal.close({ restoreFocus }); } catch {}
    }
    pageModals.clear();
  }

  const accountContextRefresh = createAccountContextRefreshController({
    refreshAccounts: ctx.refreshAccounts,
    isCurrent: () => !page.destroyed,
    isBlocked: () => page.accountContextBlocked,
  });
  const clipboardPermission = createClipboardPermissionController();
  page.clipboardPermission = clipboardPermission;
  page.clipboardPermissionUnsubscribe = clipboardPermission.subscribe(() => updateResultActionState());
  void clipboardPermission.refresh();

  const alive = token => !page.destroyed && token === page.generation;
  const digestInputsLocked = () => page.accountContextBlocked
    || page.generationStarting
    || page.running
    || page.saving
    || resultOperation.isBusy()
    || textPreviewAction.isBusy();
  const accountSwitchGuard = () => {
    if (page.destroyed) return '';
    if (page.accountContextBlocked) return '账号上下文尚未安全切换，请重新进入总结页后再继续。';
    if (page.generationStarting) return '正在确认摘要生成设置，请完成或取消后再切换账号。';
    if (page.running) return '摘要仍在生成，请完成或取消后再切换账号。';
    if (page.saving) return '摘要 PNG 正在保存，请等待保存结果后再切换账号。';
    if (resultOperation.isBusy()) return `${resultOperation.snapshot()?.label || '结果操作'}仍在进行，请等待结果后再切换账号。`;
    if (recoveryAction.isBusy()) return '正在恢复未完成的摘要批次，请等待恢复操作结束。';
    if (textPreviewAction.isBusy()) {
      return textPreviewAccountSwitchBlockedMessage(textPreviewAction.snapshot()?.kind);
    }
    if (page.activeBatch) return '当前摘要结果仍绑定原账号的批次凭据；请先完成结果操作或离开总结页，再切换账号。';
    if (page.draftSaveTimer || draftScopeLifecycle?.hasPendingPersistence?.()) {
      if (digestDraftPersistenceRisk()) return '摘要草稿暂时无法保存，请恢复浏览器存储后再切换账号。';
      return '摘要草稿正在保存，请稍后再切换账号。';
    }
    if (digestDraftPersistenceRisk()) return '摘要草稿暂时无法保存，请恢复浏览器存储后再切换账号。';
    return '';
  };

  // -------------------------------------------------------------------------
  // DOM 骨架
  // -------------------------------------------------------------------------
  root.replaceChildren();
  const layout = el('div', 'digest-layout');

  // 左:群侧栏
  const sidebar = el('aside', 'digest-sidebar card');
  const alertSlot = el('div', 'digest-alerts');
  const searchWrap = el('div', 'digest-search');
  const searchInput = document.createElement('input');
  searchInput.className = 'input';
  searchInput.type = 'search';
  searchInput.placeholder = '搜索群名 / 拼音 / 首字母';
  searchInput.setAttribute('aria-label', '搜索群');
  searchWrap.appendChild(searchInput);

  const listToolbar = el('div', 'digest-list-toolbar');
  const selectedCount = el('span', 'selected-count muted', '已选 0 个');
  const toolbarBtns = el('div', 'toolbar-btns');
  const clearBtn = el('button', 'btn btn-ghost btn-sm', '清空');
  clearBtn.type = 'button';
  const whitelistBtn = el('button', 'btn btn-ghost btn-sm', '全选白名单');
  whitelistBtn.type = 'button';
  const refreshBtn = el('button', 'btn btn-ghost btn-sm', '刷新');
  refreshBtn.type = 'button';
  toolbarBtns.append(clearBtn, whitelistBtn, refreshBtn);
  listToolbar.append(selectedCount, toolbarBtns);

  const recentWrap = el('div', 'digest-recent');
  const listStatus = el('div', 'digest-list-status muted');
  const groupList = el('div', 'group-list');
  groupList.setAttribute('role', 'group');
  groupList.setAttribute('aria-label', '可总结群列表');

  sidebar.append(alertSlot, searchWrap, listToolbar, recentWrap, listStatus, groupList);

  // 右:设置 + 动作 + 进度 + 结果
  const mainCol = el('div', 'digest-main');
  const pageTitle = el('h1', 'digest-page-title', '总结');
  pageTitle.tabIndex = -1;

  const settingsCard = el('section', 'card card-pad digest-settings');
  settingsCard.append(el('h3', 'card-title', '生成设置'));

  // 时间范围
  const rangeBlock = el('div', 'setting-block');
  rangeBlock.append(el('label', 'field-label', '时间范围'));
  const rangeSegmented = el('div', 'segmented range-segmented');
  rangeSegmented.setAttribute('role', 'group');
  rangeSegmented.setAttribute('aria-label', '时间范围');
  for (const key of RANGE_KEYS.filter(k => k !== 'custom')) {
    const btn = el('button', 'segmented-btn', RANGE_LABELS[key]);
    btn.type = 'button';
    btn.dataset.rangeKey = key;
    rangeSegmented.appendChild(btn);
  }
  const customBtn = el('button', 'segmented-btn', '自定义');
  customBtn.type = 'button';
  customBtn.dataset.rangeKey = 'custom';
  rangeSegmented.appendChild(customBtn);
  const rangeSummary = el('p', 'range-summary muted');
  rangeBlock.append(rangeSegmented, rangeSummary);

  // 过滤
  const filterBlock = el('div', 'setting-block');
  filterBlock.append(el('label', 'field-label', '过滤(可选)'));
  const senderChips = createChipInput(
    '只看发送人,回车添加',
    values => { page.filters.senders = values; },
    value => { page.filters.pending_senders = value; },
  );
  const keywordChips = createChipInput(
    '只看关键词,回车添加',
    values => { page.filters.keywords = values; },
    value => { page.filters.pending_keywords = value; },
  );
  const excludeRow = el('div', 'exclude-row');
  excludeRow.append(el('span', 'exclude-label muted', '排除类型:'));
  const excludeBoxes = new Map();
  for (const [value, label] of EXCLUDE_TYPE_OPTIONS) {
    const item = el('label', 'exclude-item');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = value;
    excludeBoxes.set(value, box);
    item.append(box, document.createTextNode(label));
    excludeRow.appendChild(item);
  }
  const minRow = el('div', 'min-row');
  minRow.append(el('span', 'exclude-label muted', '最少消息数:'));
  const minInput = document.createElement('input');
  minInput.className = 'input min-input';
  minInput.type = 'number';
  minInput.setAttribute('aria-label', '最少消息数');
  minInput.min = '1';
  minInput.max = '9999';
  minInput.value = '1';
  minRow.appendChild(minInput);
  filterBlock.append(senderChips.wrap, keywordChips.wrap, excludeRow, minRow);

  // 渲染选项
  const renderBlock = el('div', 'setting-block');
  renderBlock.append(el('label', 'field-label', '渲染选项'));
  const renderRow = el('div', 'render-row');
  const themeSegmented = el('div', 'segmented');
  themeSegmented.setAttribute('role', 'group');
  themeSegmented.setAttribute('aria-label', '主题');
  for (const [value, label] of [['auto', '自动'], ['light', '亮'], ['dark', '暗']]) {
    const btn = el('button', 'segmented-btn', label);
    btn.type = 'button';
    btn.dataset.renderTheme = value;
    themeSegmented.appendChild(btn);
  }
  const fontSegmented = el('div', 'segmented');
  fontSegmented.setAttribute('role', 'group');
  fontSegmented.setAttribute('aria-label', '字号');
  for (const [value, label] of [['normal', '标准字号'], ['large', '大字号']]) {
    const btn = el('button', 'segmented-btn', label);
    btn.type = 'button';
    btn.dataset.renderFontsize = value;
    fontSegmented.appendChild(btn);
  }
  renderRow.append(themeSegmented, fontSegmented);
  renderBlock.appendChild(renderRow);

  settingsCard.append(rangeBlock, filterBlock, renderBlock);

  // 操作条
  const actionBar = el('section', 'digest-actions card card-pad');
  const generateBtn = el('button', 'btn btn-primary', '生成长图');
  generateBtn.type = 'button';
  generateBtn.title = 'Ctrl+Enter';
  const previewBtn = el('button', 'btn btn-ghost', '仅文本预览');
  previewBtn.type = 'button';
  const cancelBtn = el('button', 'btn btn-danger', '取消 (Esc)');
  cancelBtn.type = 'button';
  cancelBtn.hidden = true;
  const actionHint = el('span', 'action-hint muted', 'Ctrl+Enter 生成长图');
  actionBar.append(generateBtn, previewBtn, cancelBtn, actionHint);

  const progressSlot = el('div', 'digest-progress-slot');
  const recoverySlot = el('div', 'digest-recovery-slot');
  const batchResultSlot = el('div', 'digest-batch-result-slot');
  const resultSlot = el('div', 'digest-result-slot');
  const textPreviewSlot = el('div', 'digest-text-preview-slot');

  mainCol.append(settingsCard, actionBar, progressSlot, recoverySlot, batchResultSlot, resultSlot, textPreviewSlot);
  layout.append(pageTitle, sidebar, mainCol);
  root.appendChild(layout);

  // chip 输入组件(工厂在使用前定义,提升函数)
  function createChipInput(placeholder, onChange, onPendingChange) {
    const wrap = el('div', 'chip-input-wrap');
    const chipsBox = el('div', 'chip-list');
    const row = el('div', 'chip-input-row');
    const input = document.createElement('input');
    input.className = 'input';
    input.placeholder = placeholder;
    input.setAttribute('aria-label', placeholder.replace(/,回车添加$/, ''));
    input.maxLength = 500;
    const addBtn = el('button', 'btn btn-ghost btn-sm', '添加');
    addBtn.type = 'button';
    let disabled = false;
    row.append(input, addBtn);
    wrap.append(chipsBox, row);
    const values = [];
    const apiChips = {
      wrap,
      get values() { return [...values]; },
      set values(next) {
        values.length = 0;
        values.push(...(Array.isArray(next) ? next : []));
        apiChips.render();
      },
      get pendingValue() { return input.value; },
      set pendingValue(next) {
        input.value = String(next || '').slice(0, 500);
      },
      setDisabled(value) {
        disabled = value === true;
        input.disabled = disabled;
        addBtn.disabled = disabled;
        for (const button of chipsBox.querySelectorAll('.chip-x')) button.disabled = disabled;
      },
      add(value) {
        const clean = String(value || '').trim().slice(0, 120);
        if (!clean || values.includes(clean) || values.length >= 100) return false;
        values.push(clean);
        apiChips.render();
        onChange?.([...values]);
        return true;
      },
      render() {
        chipsBox.replaceChildren();
        for (const value of values) {
          const chip = el('span', 'chip');
          const text = el('span', 'chip-text', value);
          const x = el('button', 'chip-x', '×');
          x.type = 'button';
          x.disabled = disabled;
          x.setAttribute('aria-label', `移除 ${value}`);
          x.addEventListener('click', () => {
            const restoreFocus = document.activeElement === x;
            const index = values.indexOf(value);
            if (index !== -1) values.splice(index, 1);
            apiChips.render();
            onChange?.([...values]);
            scheduleDraftSave();
            if (restoreFocus) input.focus({ preventScroll: true });
          });
          chip.append(text, x);
          chipsBox.appendChild(chip);
        }
      },
    };
    const submit = () => {
      const pending = String(input.value || '').slice(0, 500);
      const added = apiChips.add(pending);
      if (!pending && !added) return;
      input.value = '';
      onPendingChange?.('');
      scheduleDraftSave();
    };
    addBtn.addEventListener('click', submit);
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
    input.addEventListener('input', () => {
      const pending = String(input.value || '').slice(0, 500);
      if (input.value !== pending) input.value = pending;
      onPendingChange?.(pending);
      scheduleDraftSave();
    });
    return apiChips;
  }

  // -------------------------------------------------------------------------
  // 草稿(sessionStorage,复用 digest-draft-store)
  // -------------------------------------------------------------------------
  function draftScope() {
    const account = store.get('account');
    const accountId = accountIdOf(account);
    const accountFingerprint = accountFingerprintOf(account);
    const stateAccountContext = store.get('stateAccountContext') || {};
    const stateAccountId = String(stateAccountContext.accountId || '').trim();
    const stateAccountFingerprint = String(stateAccountContext.accountFingerprint || '')
      .trim().toLowerCase();
    const project = String(store.get('state')?.project_root || '');
    if (!project || !accountId
      || stateAccountId !== accountId
      || stateAccountFingerprint !== accountFingerprint) return '';
    return JSON.stringify([project, accountId, accountFingerprint]);
  }

  function currentDraftSnapshot() {
    return {
      selected_group_ids: [...page.selected],
      range_key: page.rangeKey,
      custom_since: page.customSince,
      custom_until: page.customUntil,
      filters: {
        senders: page.filters.senders,
        keywords: page.filters.keywords,
        exclude_types: page.filters.exclude_types,
        pending_senders: page.filters.pending_senders,
        pending_keywords: page.filters.pending_keywords,
      },
      min_messages: page.minMessages,
      render_options: {
        theme: page.renderOptions.theme,
        font_size: page.renderOptions.fontSize,
      },
    };
  }

  function digestDraftPersistenceRisk() {
    return draftScopeLifecycle?.persistenceRisk?.() === true;
  }

  function saveDraft() {
    // blocked 表示账号已经切到目标上下文,但来源草稿没有安全落盘;
    // 此时即使 destroy() 仍做最后一次留档,也不能把来源页面字段写进目标账号。
    if (page.accountContextBlocked) return false;
    const ownerIdentity = draftScopeLifecycle?.accountIdentity?.() || '';
    const currentIdentity = digestAccountContextIdentity(store.get('account'));
    if (ownerIdentity !== currentIdentity) return false;
    const result = draftScopeLifecycle?.persist(draftScope(), {
      accountFingerprint: accountFingerprintOf(store.get('account')),
    }) || { persisted: false, persistenceFailed: false };
    page.draftPersistenceFailed = result.persistenceFailed === true;
    return result.persisted === true;
  }

  function scheduleDraftSave() {
    draftScopeLifecycle?.markEdited();
    const scheduledAccountIdentity = digestAccountContextIdentity(store.get('account'));
    if (page.draftSaveTimer) clearTimeout(page.draftSaveTimer);
    const timer = setTimeout(() => {
      if (page.draftSaveTimer !== timer) return;
      page.draftSaveTimer = null;
      if (page.destroyed) return;
      if (digestAccountContextIdentity(store.get('account')) !== scheduledAccountIdentity) return;
      saveDraft();
    }, 300);
    page.draftSaveTimer = timer;
  }

  function resetDraftState() {
    page.selected.clear();
    page.rangeKey = 'yesterdayToday';
    page.customSince = '';
    page.customUntil = '';
    page.filters = {
      senders: [],
      keywords: [],
      exclude_types: [],
      pending_senders: '',
      pending_keywords: '',
    };
    page.minMessages = 1;
    page.renderOptions = { theme: 'auto', fontSize: 'normal' };
  }

  function applyDraftState(draft = {}) {
    page.selected = new Set(draft.selected_group_ids);
    page.rangeKey = draft.range_key;
    page.customSince = draft.custom_since;
    page.customUntil = draft.custom_until;
    page.filters = {
      senders: [...draft.filters.senders],
      keywords: [...draft.filters.keywords],
      exclude_types: [...draft.filters.exclude_types],
      pending_senders: draft.filters.pending_senders,
      pending_keywords: draft.filters.pending_keywords,
    };
    page.minMessages = draft.min_messages;
    page.renderOptions = {
      theme: draft.render_options?.theme || 'auto',
      fontSize: draft.render_options?.font_size || 'normal',
    };
  }

  draftScopeLifecycle = createDigestDraftScopeLifecycle({
    readDraft: (scope, { accountFingerprint = '' } = {}) => readDigestDraftSnapshot(
      sessionStorage,
      DRAFT_STORAGE_KEY,
      scope,
      { accountFingerprint },
    ),
    writeDraft: (scope, draft, { accountFingerprint = '' } = {}) => writeDigestDraftSnapshot(
      sessionStorage,
      DRAFT_STORAGE_KEY,
      scope,
      draft,
      { accountFingerprint },
    ),
    resetDraft: resetDraftState,
    applyDraft: applyDraftState,
    snapshot: currentDraftSnapshot,
    isMeaningful: digestDraftHasMeaningfulInput,
  });

  function restoreDraft() {
    const result = draftScopeLifecycle.reconcile(draftScope(), {
      accountFingerprint: accountFingerprintOf(store.get('account')),
      accountIdentity: digestAccountContextIdentity(store.get('account')),
    });
    page.draftPersistenceFailed = result.persistenceFailed === true;
    return result;
  }

  function syncInputControls() {
    const locked = digestInputsLocked();
    for (const btn of rangeSegmented.querySelectorAll('[data-range-key]')) {
      setSegmentedButtonState(btn, btn.dataset.rangeKey === page.rangeKey);
      btn.disabled = locked;
    }
    rangeSummary.textContent = rangeSummaryText(page.rangeKey, {
      customSince: page.customSince,
      customUntil: page.customUntil,
    });
    senderChips.values = page.filters.senders;
    keywordChips.values = page.filters.keywords;
    senderChips.pendingValue = page.filters.pending_senders;
    keywordChips.pendingValue = page.filters.pending_keywords;
    senderChips.setDisabled(locked);
    keywordChips.setDisabled(locked);
    for (const [value, box] of excludeBoxes) {
      box.checked = page.filters.exclude_types.includes(value);
      box.disabled = locked;
    }
    minInput.value = String(page.minMessages);
    searchInput.disabled = locked;
    minInput.disabled = locked;
    whitelistBtn.disabled = locked;
    syncRefreshButton();
    for (const btn of themeSegmented.querySelectorAll('[data-render-theme]')) {
      setSegmentedButtonState(btn, btn.dataset.renderTheme === page.renderOptions.theme);
      btn.disabled = locked;
    }
    for (const btn of fontSegmented.querySelectorAll('[data-render-fontsize]')) {
      setSegmentedButtonState(btn, btn.dataset.renderFontsize === page.renderOptions.fontSize);
      btn.disabled = locked;
    }
  }

  // -------------------------------------------------------------------------
  // 微信状态警示条
  // -------------------------------------------------------------------------
  function renderWechatAlerts() {
    const state = store.get('state');
    alertSlot.replaceChildren();
    const wechat = state?.wechat;
    if (!wechat) {
      if (page.accountContextBlocked) {
        alertSlot.appendChild(el('div', 'alert-bar alert-error',
          '账号已变化,但原账号总结草稿未能安全保存;当前页面已锁定,请重新进入总结页后继续。'));
      }
      return;
    }
    const alerts = [];
    if (page.accountContextBlocked) {
      alerts.push({
        type: 'error',
        text: '账号已变化,但原账号总结草稿未能安全保存;当前页面已锁定,请重新进入总结页后继续。',
      });
    }
    const groupWarning = digestGroupSessionWarning(page.groups);
    if (groupWarning) alerts.push({ type: 'warn', text: groupWarning });
    if (wechat.running === false) {
      alerts.push({ type: 'warn', text: '微信未在运行;群列表与消息可能不是最新的。' });
    }
    if (String(wechat.message || '').trim()) {
      alerts.push({
        type: digestWechatStatusMessageTone(wechat),
        text: String(wechat.message).trim(),
      });
    }
    const keyScanState = String(wechat.key_auto_scan_state || '').trim();
    if (keyScanState === 'failed') {
      alerts.push({
        type: 'error',
        text: `数据库 key 自动获取失败${wechat.key_auto_scan_reason ? `:${wechat.key_auto_scan_reason}` : '。'}请到设置页处理后再生成。`,
      });
    } else if (wechat.manual_key_required) {
      alerts.push({ type: 'warn', text: '当前账号需要手动配置数据库 key,请到设置页完成后再生成。' });
    }
    if (wechat.account_selection_required) {
      alerts.push({ type: 'info', text: '检测到多个微信账号,请先在左下角选择要总结的账号。' });
    }
    for (const alert of alerts.slice(0, 3)) {
      const bar = el('div', `alert-bar alert-${alert.type}`);
      const icon = el('span', 'alert-icon', alert.type === 'error' ? '⛔' : alert.type === 'warn' ? '⚠' : 'ℹ');
      const text = el('span', 'alert-text', alert.text);
      bar.append(icon, text);
      alertSlot.appendChild(bar);
    }
  }

  // -------------------------------------------------------------------------
  // 群列表
  // -------------------------------------------------------------------------
  function filteredGroups() {
    const needle = page.searchText.trim().toLowerCase();
    if (!needle) return page.groups;
    return page.groups.filter(group => {
      const name = String(group.name || '').toLowerCase();
      const pinyin = String(group.pinyin || '').toLowerCase();
      const initial = String(group.pinyin_initial || '').toLowerCase();
      return name.includes(needle) || pinyin.includes(needle) || initial.includes(needle);
    });
  }

  function reconcileGroupSelection({ notify = true, persist = true } = {}) {
    const reconciliation = reconcileDigestGroupSelection({
      selectedIds: page.selected,
      groups: page.groups,
      authoritative: page.groupsStatus === 'ready',
    });
    if (!reconciliation.changed) return reconciliation;
    page.selected = reconciliation.selectedIds;
    if (notify) {
      ui.toast(`已移除 ${reconciliation.removedIds.length} 个不可用的已选群`, { type: 'warn' });
    }
    if (persist) scheduleDraftSave();
    return reconciliation;
  }

  function renderGroupList() {
    groupList.replaceChildren();
    if (page.groupsStatus === 'loading') {
      listStatus.textContent = page.groupsProgressText || '正在读取群列表…';
      const skeleton = ui.skeletonRows(7);
      groupList.appendChild(skeleton);
      return;
    }
    if (page.groupsStatus === 'error') {
      listStatus.textContent = '';
      const box = el('div', 'empty-state');
      box.append(el('div', 'empty-icon', '⚠'), el('p', '', page.groupsError || '群列表读取失败'));
      const retry = el('button', 'btn btn-ghost btn-sm', page.groupsNeedsAccountRefresh ? '刷新账号列表并重试' : '重试');
      retry.type = 'button';
      retry.addEventListener('click', () => {
        const focusTarget = captureActionFocus([retry], globalThis.document?.activeElement);
        if (page.groupsNeedsAccountRefresh) {
          void accountContextRefresh.retryExplicitly(() => loadGroups({ focusTarget }));
        } else {
          void loadGroups({ focusTarget });
        }
      });
      box.appendChild(retry);
      groupList.appendChild(box);
      return;
    }
    const visible = filteredGroups();
    const total = page.groups.length;
    listStatus.textContent = page.searchText
      ? `搜索到 ${visible.length} 个群,共 ${total} 个`
      : (total ? `共 ${total} 个群` : '');
    if (!visible.length) {
      const box = el('div', 'empty-state');
      box.append(
        el('div', 'empty-icon', '💬'),
        el('p', '', total ? '没有匹配搜索的群。' : '该账号在所选范围内没有可用的群。'),
      );
      groupList.appendChild(box);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const group of visible) {
      const id = String(group.id || '');
      const row = el('label', 'group-row');
      const checked = page.selected.has(id);
      row.classList.toggle('selected', checked);
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = checked;
      box.disabled = digestInputsLocked();
      const name = el('span', 'group-name', group.name || id);
      name.title = group.name || id;
      const meta = el('span', 'group-meta muted');
      const bits = [];
      if (Number(group.members) > 0) bits.push(`${group.members} 人`);
      const lastMessage = formatGroupLastMessageLabel(group.last_msg_at, group.last_msg_status);
      if (lastMessage) bits.push(lastMessage);
      meta.textContent = bits.join(' · ');
      box.addEventListener('change', () => {
        if (box.checked) page.selected.add(id);
        else page.selected.delete(id);
        row.classList.toggle('selected', box.checked);
        syncSelectionUi();
        scheduleDraftSave();
      });
      row.append(box, name, meta);
      fragment.appendChild(row);
    }
    groupList.appendChild(fragment);
  }

  function renderRecentRefs() {
    recentWrap.replaceChildren();
    if (!page.recentRefs.length || !page.groups.length) return;
    const title = el('span', 'recent-title muted', '最近:');
    recentWrap.appendChild(title);
    const currentAccount = store.get('account');
    const recentRefs = page.recentRefs
      .filter(ref => recentRefBelongsToAccount(ref, currentAccount))
      .slice(0, 5);
    for (const ref of recentRefs) {
      const refName = String(ref?.group_name || ref?.name || ref?.group || '').trim();
      const refId = String(ref?.group_id || ref?.id || '').trim();
      const group = page.groups.find(item => String(item.id) === refId)
        || page.groups.find(item => String(item.name) === refName);
      if (!group) continue;
      const chip = el('button', 'recent-chip', group.name || group.id);
      chip.type = 'button';
      chip.disabled = digestInputsLocked();
      chip.classList.toggle('selected', page.selected.has(String(group.id)));
      chip.addEventListener('click', () => {
        const id = String(group.id);
        if (page.selected.has(id)) page.selected.delete(id);
        else page.selected.add(id);
        syncSelectionUi();
        renderGroupList();
        scheduleDraftSave();
      });
      recentWrap.appendChild(chip);
    }
  }

  function syncSelectionUi() {
    const locked = digestInputsLocked();
    syncRefreshButton();
    const admission = digestGenerationGroupAdmission({
      locked,
      groupsStatus: page.groupsStatus,
      selectedCount: page.selected.size,
    });
    selectedCount.textContent = `已选 ${page.selected.size} 个`;
    clearBtn.disabled = locked || !page.selected.size;
    generateBtn.disabled = !admission.allowed;
    previewBtn.disabled = !admission.allowed;
    renderRecentRefs();
  }

  function syncRefreshButton() {
    refreshBtn.disabled = digestInputsLocked() || page.groupsStatus === 'loading';
  }

  function finishGroupLoad(operation, token, focusTarget) {
    const shouldRestoreFocus = !!focusTarget
      && !page.destroyed
      && groupList.isConnected
      && alive(token)
      && operation.isCurrent();
    operation.finish();
    if (!shouldRestoreFocus) return;
    restoreActionFocus(focusTarget, {
      activeElement: globalThis.document?.activeElement,
      body: globalThis.document?.body,
      fallbackTargets: [
        groupList.querySelector('.empty-state button:not([disabled])'),
        groupList.querySelector('.group-row input:not([disabled])'),
        refreshBtn,
      ],
    });
  }

  async function loadGroups({ forceGroups = false, focusTarget = null } = {}) {
    if (page.destroyed) return;
    const token = page.generation;
    const operation = groupLoadScope.begin();
    const account = store.get('account');
    const accountId = accountIdOf(account);
    if (!accountId) {
      if (alive(token) && operation.isCurrent()) {
        page.groups = [];
        page.groupsStatus = 'ready';
        page.groupsError = '';
        renderGroupList();
        syncSelectionUi();
      }
      finishGroupLoad(operation, token, focusTarget);
      return;
    }
    const fingerprint = accountFingerprintOf(account);
    if (!fingerprint) {
      if (alive(token) && operation.isCurrent()) {
        page.groupsStatus = 'error';
        page.groupsError = '账号身份凭据尚未就绪,请点击左侧「刷新」重试;仍失败请重启本地服务。';
        renderGroupList();
        syncSelectionUi();
      }
      finishGroupLoad(operation, token, focusTarget);
      return;
    }
    page.groupsStatus = 'loading';
    page.groupsProgressText = '正在读取群列表…';
    renderGroupList();
    syncSelectionUi();

    const progressId = createGroupProgressId();
    let progressPoller = null;
    progressPoller = createGroupProgressPoller({
      signal: operation.signal,
      isCurrent: () => alive(token) && operation.isCurrent(),
      poll: () => api.get(`/api/group-progress/${encodeURIComponent(progressId)}`, {
        signal: operation.signal,
        timeoutMs: 10000,
      }),
      onProgress: progress => {
        const text = formatGroupProgressText(progress);
        if (!text) return;
        page.groupsProgressText = text;
        renderGroupList();
      },
    });

    try {
      const params = new URLSearchParams();
      params.set('account', accountId);
      params.set('expected_account_fingerprint', fingerprint);
      params.set('progress_id', progressId);
      params.set('prepare_digest', 'true');
      if (forceGroups) params.set('refresh_groups', 'true');
      const payload = await api.get(`/api/groups?${params.toString()}`, {
        signal: operation.signal,
        timeoutMs: GROUPS_TIMEOUT_MS,
      });
      if (!alive(token) || !operation.isCurrent()) return;
      const upgradeResult = await accountContextRefresh.handleUpgrade(payload, {
        accountId,
        fingerprint,
        retry: () => loadGroups({ focusTarget }),
      });
      if (!alive(token) || !operation.isCurrent() || upgradeResult.status === 'stale') return;
      if (upgradeResult.status !== 'not_upgrade') {
        if (upgradeResult.status === 'retried') return;
        page.groupsNeedsAccountRefresh = true;
        page.groupsStatus = 'error';
        page.groupsError = upgradeResult.status === 'refresh_failed'
          ? (upgradeResult.error?.message || '账号列表刷新失败,请稍后重试。')
          : '群列表响应的账号身份尚未完成确认,请刷新账号列表后重试。';
        renderGroupList();
        syncSelectionUi();
        return;
      }
      if (String(payload?.account_id || '').trim() !== accountId
        || String(payload?.account_fingerprint || '').trim().toLowerCase() !== fingerprint) {
        page.groupsNeedsAccountRefresh = true;
        page.groupsStatus = 'error';
        page.groupsError = '群列表响应的账号身份与当前选择不一致,请刷新账号列表后重试。';
        renderGroupList();
        syncSelectionUi();
        return;
      }
      const groups = requireGroupList(payload);
      clearDbMirrorAutoFailure({
        accountId,
        accounts: store.get('accounts') || [],
        accountFingerprint: fingerprint,
      });
      page.groups = groups;
      page.groupsStatus = 'ready';
      page.groupsError = '';
      page.groupsNeedsAccountRefresh = false;
      reconcileGroupSelection();
      renderGroupList();
      syncSelectionUi();
      renderWechatAlerts();
    } catch (error) {
      if (!alive(token) || !operation.isCurrent() || error?.name === 'AbortError') return;
      const mirrorFailure = isDbMirrorFailure(error)
        ? rememberDbMirrorAutoFailure(error, accountId, {
          accounts: store.get('accounts') || [],
          accountFingerprint: fingerprint,
        })
        : null;
      const refreshPromise = accountContextRefresh.handle(error, {
        accountId,
        fingerprint,
        retry: () => loadGroups({ focusTarget }),
      });
      if (accountContextRefresh.isRefreshing()) {
        page.groupsNeedsAccountRefresh = true;
        page.groupsStatus = 'loading';
        page.groupsProgressText = '账号数据已变化,正在刷新账号列表…';
        renderGroupList();
        syncSelectionUi();
      }
      const refreshResult = await refreshPromise;
      if (!alive(token) || !operation.isCurrent() || refreshResult.status === 'stale') return;
      if (refreshResult.status !== 'not_account_context') {
        page.groupsStatus = 'error';
        page.groupsError = refreshResult.status === 'refresh_failed'
          ? (refreshResult.error?.message || '账号列表刷新失败,请稍后重试。')
          : '当前微信账号的数据身份已变化,已刷新账号列表;请点击“刷新账号列表并重试”。';
        renderGroupList();
        syncSelectionUi();
        return;
      }
      page.groupsStatus = 'error';
      page.groupsNeedsAccountRefresh = false;
      page.groupsError = `${error?.message || '群列表读取失败'}${dbMirrorDiagnosticsReady(mirrorFailure)
        ? '；本地数据连续检查失败,请稍后重试。'
        : ''}`;
      renderGroupList();
      syncSelectionUi();
    } finally {
      progressPoller?.stop();
      finishGroupLoad(operation, token, focusTarget);
    }
  }

  function loadSettingsDerived() {
    return settingsDerived.load();
  }

  // -------------------------------------------------------------------------
  // 生成流程
  // -------------------------------------------------------------------------
  function syncActionHint() {
    actionHint.textContent = page.generationStarting
      ? '正在启动生成…'
      : (page.running
        ? '生成中,Esc 可取消'
        : (page.saving
          ? '正在保存 PNG…'
          : (resultOperation.isBusy()
            ? `${resultOperation.snapshot()?.label || '结果操作'}中…`
            : (textPreviewAction.isBusy()
              ? textPreviewBusyHint(textPreviewAction.snapshot()?.kind)
              : 'Ctrl+Enter 生成长图'))));
  }

  function setGenerationStarting(starting) {
    page.generationStarting = starting === true;
    if (page.destroyed) return;
    syncInputControls();
    syncSelectionUi();
    renderGroupList();
    syncActionHint();
  }

  function lockInputs(locked) {
    page.running = locked;
    syncInputControls();
    syncSelectionUi();
    cancelBtn.hidden = !locked;
    syncActionHint();
    renderGroupList();
    updateResultActionState();
  }

  function setSaving(saving, statusText = '') {
    page.saving = saving === true;
    if (page.destroyed) return;
    syncInputControls();
    syncSelectionUi();
    renderGroupList();
    syncActionHint();
    updateResultActionState(statusText);
  }

  function syncResultOperationUi() {
    if (page.destroyed) return;
    syncInputControls();
    syncSelectionUi();
    renderGroupList();
    syncActionHint();
    updateResultActionState();
  }

  function beginResultOperation(kind, label) {
    if (page.destroyed || page.generationStarting || page.running || page.saving
        || recoveryAction.isBusy() || textPreviewAction.isBusy()) return null;
    const operation = resultOperation.begin(kind, label);
    if (operation) syncResultOperationUi();
    return operation;
  }

  function endResultOperation(operation) {
    if (!resultOperation.end(operation)) return false;
    syncResultOperationUi();
    return true;
  }

  function currentRangeOrError() {
    const range = resolveRange(page.rangeKey, {
      customSince: page.customSince,
      customUntil: page.customUntil,
    });
    // 空 until 视为 now(草稿恢复时 'now' 不会被持久化)。
    range.until = String(range.until || '').trim() || 'now';
    if (page.rangeKey === 'custom') {
      if (!parseLocalDateTime(page.customSince)) {
        throw new Error('自定义开始时间无效,请重新选择。');
      }
      if (range.until !== 'now' && !parseLocalDateTime(page.customUntil, { endOfMinuteWhenSecondsMissing: true })) {
        throw new Error('自定义结束时间无效,请重新选择。');
      }
    }
    return range;
  }

  function startBatchKeepalive(batch) {
    stopBatchKeepalive();
    const leaseController = new AbortController();
    let ownerAbortAttached = false;
    const detachOwnerAbort = () => {
      if (!ownerAbortAttached) return;
      ownerAbortAttached = false;
      actionAbort.signal.removeEventListener('abort', onOwnerAbort);
    };
    const lease = { active: true, timer: null, controller: leaseController, detachOwnerAbort };
    page.keepaliveLease = lease;
    let inFlight = false;
    const onOwnerAbort = () => stopBatchKeepalive();
    if (actionAbort.signal.aborted) onOwnerAbort();
    else {
      actionAbort.signal.addEventListener('abort', onOwnerAbort, { once: true });
      ownerAbortAttached = true;
    }
    const tick = () => {
      if (!lease.active || page.keepaliveLease !== lease || inFlight
        || page.destroyed || leaseController.signal.aborted) return;
      inFlight = true;
      api.post('/api/digest-batch-heartbeat', {
        batch_id: batch.batch_id,
        batch_token: batch.batch_token,
        service_instance_id: batch.service_instance_id || api.getServiceInstanceId(),
      }, { signal: leaseController.signal }).catch(() => {}).finally(() => {
        inFlight = false;
      });
    };
    if (lease.active) {
      lease.timer = setInterval(tick, BATCH_KEEPALIVE_MS);
      page.keepaliveTimer = lease.timer;
    }
  }

  function stopBatchKeepalive() {
    const lease = page.keepaliveLease;
    if (lease) {
      lease.active = false;
      lease.detachOwnerAbort?.();
      if (lease.controller && !lease.controller.signal.aborted) {
        lease.controller.abort(actionAbort.signal.reason || Object.assign(new Error('摘要页保活已停止'), {
          name: 'AbortError',
          status: 499,
        }));
      }
    }
    if (page.keepaliveTimer !== null && page.keepaliveTimer !== undefined) {
      clearInterval(page.keepaliveTimer);
    }
    page.keepaliveTimer = null;
    page.keepaliveLease = null;
  }

  // 收尾并释放服务端批次(新批次开始/离开页面/用户取消时调用)。
  async function releaseActiveBatch({
    owner = undefined,
    releaseTerminalResults = true,
    releasePreview = true,
    preserveCrossTabGenerationLease = false,
  } = {}) {
    const pendingRelease = page.activeBatchRelease;
    const active = page.activeBatch;
    const releaseLease = page.crossTabGenerationLease;
    if (pendingRelease) {
      // 页面卸载/账号清理可能与生成 finally 同时进入。只要当前槽仍是
      // 同一个 owner(或已暂时为空),所有 caller 都等待同一份 finish 结果；
      // 不允许第二个 caller 把 B 当成 A 的收尾对象。
      if (owner !== undefined && owner !== pendingRelease.owner) return false;
      if (active !== null && active !== pendingRelease.owner) return false;
      return pendingRelease.promise;
    }
    if (owner !== undefined && active !== owner) return false;
    if (!active) return true;
    stopBatchKeepalive();
    const releaseOwner = active;
    const restoreUnconfirmedBatch = () => {
      if (page.activeBatch !== releaseOwner) return;
      if (page.destroyed) {
        page.activeBatch = null;
        return;
      }
      if (releaseOwner?.batch && typeof startBatchKeepalive === 'function') {
        startBatchKeepalive(releaseOwner.batch);
      }
    };
    const releasePromise = (async () => {
      if (releaseOwner?.finish) {
        let finishResult;
        try {
          finishResult = await releaseOwner.finish({ releasePreview, releaseTerminalResults });
        } catch (error) {
          restoreUnconfirmedBatch();
          throw error;
        }
        if (!digestBatchFinishConfirmed(finishResult)) {
          restoreUnconfirmedBatch();
          return false;
        }
      }
      if (page.activeBatch === releaseOwner) {
        page.activeBatch = null;
        if (!preserveCrossTabGenerationLease) page.releaseCrossTabGenerationLease?.(releaseLease);
      }
      return true;
    })();
    let trackedRelease;
    trackedRelease = releasePromise.finally(() => {
      if (page.activeBatchRelease?.promise === trackedRelease) {
        page.activeBatchRelease = null;
      }
    });
    page.activeBatchRelease = { owner: releaseOwner, promise: trackedRelease };
    return trackedRelease;
  }

  async function admitRecoveredBatch(nextOwner, {
    isCurrent = () => true,
    accountId = '',
    accountFingerprint = '',
  } = {}) {
    const current = () => !page.destroyed && isCurrent() === true;
    const sameLease = (left, right) => !!left?.batch
      && !!right?.batch
      && String(left.batch.batch_id || '') === String(right.batch.batch_id || '')
      && String(left.batch.batch_token || '') === String(right.batch.batch_token || '');
    let generationLease = null;
    if (typeof page.acquireCrossTabGenerationLease === 'function'
      && String(accountId || '').trim()
      && String(accountFingerprint || '').trim()) {
      try {
        generationLease = await page.acquireCrossTabGenerationLease(accountId, accountFingerprint);
      } catch {
        generationLease = { acquired: false, busy: true };
      }
      if (!generationLease?.acquired) {
        return {
          admitted: false,
          blocked: true,
          lockUnavailable: generationLease?.lockUnavailable === true,
        };
      }
    }
    const releaseUncommittedLease = () => {
      if (generationLease?.acquired === true && generationLease?.reused !== true) {
        page.releaseCrossTabGenerationLease?.(generationLease);
      }
    };
    const stale = () => {
      releaseUncommittedLease();
      return { admitted: false, stale: true };
    };
    const blocked = () => {
      releaseUncommittedLease();
      return { admitted: false, blocked: true };
    };
    const waitForPendingRelease = async () => {
      try {
        return await page.activeBatchRelease.promise;
      } catch {
        return false;
      }
    };
    if (!current()) return stale();

    // 先等已有 owner 的收尾。即使槽位暂时为空,也不能让恢复结果
    // 趁旧 owner 的 finish 在途时抢占页面状态。
    if (page.activeBatchRelease) {
      const settled = await waitForPendingRelease();
      if (!current()) return stale();
      if (settled !== true || page.activeBatch !== null) return blocked();
    }

    const active = page.activeBatch;
    if (active && sameLease(active, nextOwner)) {
      // onBatchCreated 可能先安装只有 batch 身份的占位 owner。恢复结果
      // 复用同一 lease 时只补齐缺失能力,不替换对象 identity,也不以新的
      // null/空字段覆盖旧 owner 已经具备的收尾能力或结果。
      if (typeof active.finish !== 'function' && typeof nextOwner?.finish === 'function') {
        active.finish = nextOwner.finish;
      }
      if ((!Array.isArray(active.results) || active.results.length === 0)
        && Array.isArray(nextOwner?.results)) {
        active.results = nextOwner.results;
      }
      if (typeof nextOwner?.previewText === 'boolean') {
        active.previewText = nextOwner.previewText;
      }
      return { admitted: true, owner: active, reused: true };
    }
    if (active) {
      let released = false;
      try {
        released = await releaseActiveBatch({
          owner: active,
          preserveCrossTabGenerationLease: generationLease?.acquired === true,
        });
      } catch {
        released = false;
      }
      if (!current()) return stale();
      if (released !== true || page.activeBatch !== null) return blocked();
    }
    if (page.activeBatchRelease) {
      const settled = await waitForPendingRelease();
      if (!current()) return stale();
      if (settled !== true || page.activeBatch !== null) return blocked();
    }
    if (!current()) return stale();
    if (page.activeBatch) return blocked();
    page.activeBatch = nextOwner;
    if (nextOwner?.batch) startBatchKeepalive(nextOwner.batch);
    return { admitted: true, owner: nextOwner, reused: false };
  }

  function forgetCancelledBatchMarker(owner) {
    if (owner?.cancelOnly !== true) return false;
    const batchId = String(owner.batch?.batch_id || '').trim();
    if (!batchId) return false;
    try {
      return forgetInterruptedDigestBatch(batchId) === true;
    } catch {
      return false;
    }
  }

  async function startGeneration(previewText) {
    if (digestInputsLocked()) return;
    const account = store.get('account');
    const accountId = accountIdOf(account);
    const fingerprint = accountFingerprintOf(account);
    if (!accountId || !fingerprint) {
      ui.toastError('账号身份凭据尚未就绪,请刷新群列表或重启本地服务后再生成。');
      return;
    }
    const admission = digestGenerationGroupAdmission({
      locked: digestInputsLocked(),
      groupsStatus: page.groupsStatus,
      selectedCount: page.selected.size,
    });
    if (!admission.allowed) {
      if (admission.reason) ui.toastWarn(admission.reason);
      return;
    }
    const selectedGroups = page.groups.filter(group => page.selected.has(String(group.id)));
    if (!selectedGroups.length) {
      ui.toastWarn('请先选择至少一个群。');
      return;
    }
    let range;
    try {
      range = currentRangeOrError();
    } catch (error) {
      ui.toastError(error.message);
      return;
    }
    const startToken = page.generation;
    const activeElement = globalThis.document?.activeElement;
    const generationFocusTarget = captureActionFocus([generateBtn, previewBtn], activeElement)
      || (root.contains(activeElement) ? (previewText ? previewBtn : generateBtn) : null);
    let generationAdmitted = false;
    let generationLease = null;
    setGenerationStarting(true);
    try {
      if (typeof page.acquireCrossTabGenerationLease === 'function') {
        let lease;
        try {
          lease = await page.acquireCrossTabGenerationLease(accountId, fingerprint);
        } catch {
          if (alive(startToken)) {
            ui.toastWarn('当前浏览器无法建立安全的跨标签摘要协调，请稍后重试。');
          }
          return;
        }
        if (!lease?.acquired) {
          if (alive(startToken)) {
            ui.toastWarn(lease?.lockUnavailable
              ? '当前浏览器不支持安全的跨标签摘要协调，请稍后在支持该功能的环境中重试。'
              : '另一个页面正在生成当前账号的摘要，请等待它结束或恢复后再重试。');
          }
          return;
        }
        generationLease = lease;
      }
      if (page.minMessages >= 100) {
        const confirmed = await ui.confirmDialog({
          title: '确认最少消息数',
          message: `最少消息数已设为 ${page.minMessages} 条;消息不足的群会被跳过。确认按此阈值生成?`,
          confirmLabel: '确认生成',
        });
        if (!confirmed) return;
      }

      // 新批次开始前释放旧批次(保存凭据随之作废)。
      if (!alive(startToken)) return;
      const releaseOwner = page.activeBatch;
      const released = await (releaseOwner
        ? releaseActiveBatch({ owner: releaseOwner, preserveCrossTabGenerationLease: true })
        : releaseActiveBatch());
      if (released === true) forgetCancelledBatchMarker(releaseOwner);
      generationAdmitted = released === true && alive(startToken);
    } finally {
      if (!generationAdmitted && generationLease?.acquired === true && generationLease?.reused !== true) {
        page.releaseCrossTabGenerationLease?.(generationLease);
      }
      if (alive(startToken)) {
        setGenerationStarting(false);
        if (!generationAdmitted && !page.destroyed) {
          restoreActionFocus(generationFocusTarget, {
            activeElement: globalThis.document?.activeElement,
            body: globalThis.document?.body,
          });
        }
      }
    }
    if (!generationAdmitted) return;
    // 旧取消请求即使晚到,也不得触碰新批次的 marker 或页面状态。
    page.cancelGenerationOwner = null;
    clearProgressCleanupTimer();
    resultSlot.replaceChildren();
    textPreviewSlot.replaceChildren();
    batchResultSlot.replaceChildren();
    resultRenderState.invalidate();
    page.doneResults = [];
    page.currentRender = null;
    page.generationRender = null;
    page.savedItems.clear();
    page.previewDigests = [];

    const token = startToken; // 不递增:避免使进行中的群列表加载失效
    const controller = new AbortController();
    page.abortController = controller;
    lockInputs(true);
    ui.setGlobalProgress(true);

    const progressView = createProgressView({
      onCancel: () => { void cancelGeneration('user_button'); },
    });
    page.progressView = progressView;
    progressSlot.replaceChildren(progressView.el);

    const targets = selectedGroups.map(group => ({
      group_id: String(group.id),
      group_name: String(group.name || group.id),
      since: range.since,
      until: range.until,
    }));
    // 在任何异步请求开始前解析 auto 主题，恢复记录和后续保存都绑定同一份选择。
    const generationRender = freezeDigestRenderSelection(page.renderOptions);
    page.generationRender = generationRender;
    const resultRange = {
      key: page.rangeKey,
      since: range.since,
      until: range.until,
      dynamic: page.rangeKey !== 'custom',
    };
    const resultInputKey = JSON.stringify({
      account_id: accountId,
      targets: targets.map(target => target.group_id),
      min_messages: page.minMessages,
      filters: page.filters,
      preview_text: previewText === true,
    });
    const resultRuntimeVersion = 1;
    progressView.setTotal(0, targets.length);

    let batchRecordRegistered = false;
    let recoveryRecordPersistenceFailed = false;
    let terminalError = null;
    let retainActiveBatchForRecovery = false;
    let terminalRecoveryPersistenceFailed = false;
    let batchOwner = null;
    const registerRecord = extra => {
      const active = page.activeBatch;
      if (!active?.batch) return;
      const persisted = rememberInterruptedDigestBatch({
        batch_id: active.batch.batch_id,
        batch_token: active.batch.batch_token,
        service_instance_id: active.batch.service_instance_id,
        account_id: accountId,
        account_fingerprint: fingerprint,
        preview_text: previewText,
        batch_total: targets.length,
        targets,
        render: generationRender,
        result_input_key: resultInputKey,
        result_range: resultRange,
        result_runtime_version: resultRuntimeVersion,
        ...extra,
      });
      if (persisted === true) {
        batchRecordRegistered = true;
        recoveryRecordPersistenceFailed = false;
      } else {
        recoveryRecordPersistenceFailed = true;
      }
      return persisted === true;
    };

    // 批次结果卡(增量更新)
    const resultRows = new Map();
    const batchCard = el('section', 'card card-pad batch-result-card');
    batchCard.hidden = true;
    const batchCardTitle = el('h3', 'card-title', '批次结果');
    const batchList = el('ol', 'batch-result-list');
    batchCard.append(batchCardTitle, batchList);
    batchResultSlot.replaceChildren(batchCard);

    const upsertResultRow = (index, target, outcome, error) => {
      batchCard.hidden = false;
      let row = resultRows.get(index);
      if (!row) {
        row = el('li', 'batch-result-row');
        const name = el('span', 'batch-result-name', target.group_name);
        const status = el('span', 'batch-result-status');
        row.append(name, status);
        resultRows.set(index, row);
        batchList.appendChild(row);
      }
      const statusEl = row.querySelector('.batch-result-status');
      const cancellationMarkers = [error?.code, error?.public_code, error?.reason, error?.message]
        .map(value => String(value || '').trim().toLowerCase());
      const cancelled = outcome === 'cancelled'
        || error?.cancelled === true
        || cancellationMarkers.some(value => ['user_button', 'user_cancelled', 'digest_batch_cancelled'].includes(value));
      row.dataset.outcome = cancelled ? 'cancelled' : outcome;
      if (outcome === 'running') {
        statusEl.textContent = '生成中…';
        statusEl.className = 'batch-result-status muted';
      } else if (outcome === 'done') {
        statusEl.textContent = '成功';
        statusEl.className = 'batch-result-status ok';
      } else if (cancelled) {
        statusEl.textContent = '已取消';
        statusEl.className = 'batch-result-status skip';
      } else if (outcome === 'skipped') {
        const code = String(error?.code || '');
        statusEl.textContent = `跳过:${code === 'digest_below_minimum' ? '消息数不足' : (error?.message || '无消息')}`;
        statusEl.className = 'batch-result-status skip';
      } else {
        statusEl.textContent = `失败:${error?.message || '未知错误'}`;
        statusEl.className = 'batch-result-status fail';
      }
    };

    let progressTerminalStatus = 'done';
    try {
      const run = await runDigestBatch(api, {
        accountId,
        accountFingerprint: fingerprint,
        targets,
        previewText,
        minMessages: page.minMessages,
        filters: page.filters,
        signal: controller.signal,
        onBatchCreated: batch => {
          // 批次标识一创建就持有:取消请求与中断恢复登记都依赖它。
          if (!alive(token)) return;
          const cancelOnlyOwner = {
            batch,
            accountId,
            accountFingerprint: fingerprint,
            // start 响应尚未回来时还没有 runner.finish。账号换代/卸载
            // 仍必须先用同一批次凭据登记取消，避免服务端晚到创建无主租约。
            finish: async () => {
              if (cancelOnlyOwner.cancelConfirmed === true) {
                return { ok: true, settled: true, pending: false };
              }
              const response = await cancelDigestBatch(api, batch, { reason: 'owner_released' });
              if (!digestBatchCancelConfirmed(response)) return null;
              return { ...response, settled: true, pending: false };
            },
            cancelOnly: true,
            cancelConfirmed: false,
            cancelMarkerForgotten: false,
            previewText,
            results: [],
          };
          page.activeBatch = cancelOnlyOwner;
          batchOwner = page.activeBatch;
          registerRecord({ batch_index: -1, phase: 'starting' });
        },
        onGroupStart: ({ index, target }) => {
          if (!alive(token)) return;
          progressView.setCurrentGroup(target.group_name);
          page.previewProcessingGroup = target.group_name;
          updatePreviewIdentity();
          progressView.resetStages();
          upsertResultRow(index, target, 'running');
          registerRecord({ batch_index: index, current_group: target.group_name, phase: 'running' });
        },
        onStage: (stage, { target }) => {
          if (!alive(token)) return;
          progressView.setCurrentGroup(target.group_name);
          progressView.onStage(stage);
        },
        onGroupResult: ({ index, target, outcome, error }) => {
          if (!alive(token)) return;
          upsertResultRow(index, target, outcome, error);
          if (outcome !== 'running' && page.previewProcessingGroup === target.group_name) {
            page.previewProcessingGroup = '';
          }
          updatePreviewIdentity();
          registerRecord({ batch_index: index, current_group: target.group_name, phase: 'running' });
        },
        onRecoveryPending: ({ index, target, phase }) => {
          if (!alive(token)) return;
          registerRecord({
            batch_index: index,
            current_group: target.group_name,
            phase,
          });
        },
        onProgress: ({ done, total }) => {
          if (!alive(token)) return;
          progressView.setTotal(done, total);
          ui.setGlobalProgress(true, total > 0 ? done / total : null);
        },
      });
      if (controller.signal.aborted) {
        progressTerminalStatus = 'cancelled';
      } else if (run.results.some(item => item?.outcome === 'error')) {
        progressTerminalStatus = 'error';
      }
      if (!alive(token)) {
        await run.finish({ releasePreview: false, releaseTerminalResults: false });
        return;
      }
      // runner 只负责生成期保活;结果阶段由页面统一持有唯一心跳。
      const activeBatch = {
        batch: run.batch,
        accountId,
        accountFingerprint: fingerprint,
        finish: run.finish,
        previewText,
        results: run.results,
      };
      page.activeBatch = activeBatch;
      batchOwner = activeBatch;
      run.stopHeartbeat?.();
      startBatchKeepalive(run.batch);
      terminalRecoveryPersistenceFailed = run.results.some(
        item => item?.terminal_recovery_persisted === false,
      );
      const recoveryRecordCleared = !terminalRecoveryPersistenceFailed
        && forgetInterruptedDigestBatch(run.batch.batch_id) === true;
      if (!terminalRecoveryPersistenceFailed) {
        batchRecordRegistered = false;
        recoveryRecordPersistenceFailed = !recoveryRecordCleared;
      } else {
        recoveryRecordPersistenceFailed = false;
      }
      if (terminalRecoveryPersistenceFailed) {
        ui.toastWarn('服务端摘要恢复记录持久化失败;当前结果可继续使用,但本地服务重启后无法自动恢复。');
      } else if (!recoveryRecordCleared) {
        ui.toastWarn('浏览器无法清理本地恢复记录;本次结果已生成,请恢复本站点存储后重新打开页面确认。');
      }

      if (previewText) {
        showTextPreview(run.results, run);
      } else {
        await showImageResults(run.results, run);
      }
      if (!digestBatchHasUsableResult(run.results)) {
        await releaseActiveBatch({ owner: activeBatch });
      }
    } catch (error) {
      if (!alive(token)) return;
      terminalError = error;
      retainActiveBatchForRecovery = digestBatchFailureNeedsRecovery(error);
      if (error?.name === 'AbortError' || error?.status === 499) {
        progressTerminalStatus = 'cancelled';
        progressView.log('已取消。');
        ui.toast('已取消生成。', { type: 'info' });
      } else if (isMutationOutcomeUnknown(error)) {
        progressTerminalStatus = 'pending';
        if (recoveryRecordPersistenceFailed) {
          progressView.log('摘要请求已发出但结果尚未确认;浏览器无法保存本地恢复记录,请恢复站点存储并保持此页面打开。');
          ui.toastWarn('浏览器无法保存本地恢复记录;请恢复本站点存储并保持此页面打开,不要重复生成。');
        } else {
          progressView.log('摘要请求已发出，但结果尚未确认；请使用恢复记录查询终态。');
          ui.toastWarn('生成结果尚未确认，请在“未完成的批次”中恢复，勿重复生成。');
        }
      } else {
        progressTerminalStatus = 'error';
        progressView.log(`批次失败:${error?.message || '未知错误'}`);
        ui.toastError(error?.message || '生成失败');
      }
    } finally {
      if (alive(token)) {
        const cancelled = terminalError?.name === 'AbortError' || terminalError?.status === 499;
        if (!cancelled && !terminalRecoveryPersistenceFailed
          && (batchRecordRegistered || recoveryRecordPersistenceFailed)
          && page.activeBatch?.batch) {
          const recovery = terminalError?.digestRecovery || {};
          const disposition = finalizeInterruptedDigestBatchRecord(terminalError, {
            batchId: page.activeBatch.batch.batch_id,
            currentGroup: targets[recovery.batch_index]?.group_name || '',
          });
          batchRecordRegistered = disposition.retained;
          recoveryRecordPersistenceFailed = disposition.retained !== true;
          if (disposition.retained) void checkInterruptedRecovery();
        }
        if (terminalError && !retainActiveBatchForRecovery) {
          await releaseActiveBatch({ owner: batchOwner });
          if (!alive(token)) return;
        }
        lockInputs(false);
        restoreActionFocus(generationFocusTarget, {
          activeElement: globalThis.document?.activeElement,
          body: globalThis.document?.body,
        });
        ui.setGlobalProgress(false);
        progressView.setTerminal(progressTerminalStatus);
        progressView.dispose();
        page.progressView = null;
        page.abortController = null;
        // 没有产出时收起进度卡。
        if (!page.doneResults.length && !page.previewDigests.length) {
          scheduleProgressCleanup(progressView.el);
        }
      }
      if (!page.activeBatch && generationLease?.acquired === true && generationLease?.reused !== true) {
        page.releaseCrossTabGenerationLease?.(generationLease);
      }
    }
  }

  async function cancelGeneration(reason = 'user_cancelled') {
    const controller = page.abortController;
    if (!controller || controller.signal.aborted) return;
    page.progressView?.setCancelling();
    controller.abort(new Error('已取消生成'));
    const active = page.activeBatch;
    if (active?.batch) {
      const cancelOwner = {
        generation: page.generation,
        batch: active.batch,
        batchId: active.batch.batch_id,
        controller,
      };
      page.cancelGenerationOwner = cancelOwner;
      const isCurrentCancel = () => !page.destroyed
        && page.cancelGenerationOwner === cancelOwner
        && page.generation === cancelOwner.generation;
      try {
        let cancelResult = null;
        try {
          cancelResult = await cancelDigestBatch(api, active.batch, { reason });
        } catch {
          if (isCurrentCancel()) {
            ui.toastWarn('服务端取消请求失败,恢复记录仍保留,请稍后重试。');
          }
          return;
        }
        if (!isCurrentCancel()) return;
        if (digestBatchCancelConfirmed(cancelResult)) {
          const forgotten = forgetInterruptedDigestBatch(cancelOwner.batchId);
          if (active?.cancelOnly === true && page.activeBatch === active) {
            active.cancelConfirmed = true;
            active.cancelMarkerForgotten = forgotten === true;
          }
          if (!forgotten && !page.destroyed) {
            ui.toastWarn('服务端已取消但本地记录清理失败,可重试清理。');
          }
        }
      } finally {
        if (page.cancelGenerationOwner === cancelOwner) page.cancelGenerationOwner = null;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 长图结果
  // -------------------------------------------------------------------------
  async function showImageResults(results, run) {
    const done = results.filter(item => item?.outcome === 'done' && item.digest);
    const generationRender = page.generationRender;
    page.doneResults = done;
    if (!done.length) {
      ui.toastWarn('没有群生成成功;请查看批次结果中的原因。');
      if (page.generationRender === generationRender) page.generationRender = null;
      return;
    }
    try {
      await renderCurrentResult(0);
    } finally {
      if (page.generationRender === generationRender) page.generationRender = null;
    }
  }

  function buildResultCard() {
    const card = el('section', 'card card-pad result-card');
    const head = el('div', 'result-head');
    const title = el('h3', 'card-title', '长图预览');
    const identity = el('p', 'result-preview-identity muted');
    identity.setAttribute('aria-live', 'polite');
    identity.setAttribute('role', 'status');
    const tabs = el('div', 'result-tabs');
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', '群结果');
    head.append(title, tabs);

    const canvasWrap = el('div', 'result-canvas-wrap');
    const actions = el('div', 'result-actions');
    const saveBtn = el('button', 'btn btn-primary btn-sm', '保存 PNG');
    saveBtn.type = 'button';
    saveBtn.title = 'Ctrl+S';
    const copyImageBtn = el('button', 'btn btn-ghost btn-sm', '复制图片');
    copyImageBtn.type = 'button';
    copyImageBtn.title = 'Ctrl+Shift+C';
    const copyPathBtn = el('button', 'btn btn-ghost btn-sm', '复制路径');
    copyPathBtn.type = 'button';
    const revealBtn = el('button', 'btn btn-ghost btn-sm', '在文件夹显示');
    revealBtn.type = 'button';
    const rerenderBtn = el('button', 'btn btn-ghost btn-sm', '按新主题重渲染');
    rerenderBtn.type = 'button';
    const resultStatus = el('p', 'result-status muted');
    actions.append(saveBtn, copyImageBtn, copyPathBtn, revealBtn, rerenderBtn);
    card.append(head, identity, canvasWrap, actions, resultStatus);
    return { card, tabs, identity, canvasWrap, saveBtn, copyImageBtn, copyPathBtn, revealBtn, rerenderBtn, resultStatus };
  }

  let resultUi = null;
  let accountResultContext = null;

  function updatePreviewIdentity() {
    if (!resultUi) return;
    syncDigestPreviewIdentity({
      identityElement: resultUi.identity,
      canvas: page.currentRender?.canvas,
      previewGroup: page.doneResults[page.currentResultIndex]?.target?.group_name,
      processingGroup: page.previewProcessingGroup,
    });
  }

  async function renderCurrentResult(index) {
    const token = page.generation;
    const item = page.doneResults[index];
    if (!item) return false;
    const renderToken = resultRenderState.begin();
    page.currentResultIndex = index;
    if (!resultUi) {
      resultUi = buildResultCard();
      resultSlot.replaceChildren(resultUi.card);
      wireResultActions();
    }
    // 群切换 tabs
    resultUi.tabs.replaceChildren();
    page.doneResults.forEach((entry, entryIndex) => {
      const tab = el('button', 'result-tab', entry.target.group_name);
      tab.type = 'button';
      setSegmentedButtonState(tab, entryIndex === index);
      tab.addEventListener('click', () => {
        if (digestInputsLocked()) return;
        void renderCurrentResult(entryIndex);
      });
      resultUi.tabs.appendChild(tab);
    });
    const renderProgress = createRenderProgressTracker({
      onUpdate: text => {
        if (alive(token) && resultRenderState.isCurrent(renderToken)) resultUi.resultStatus.textContent = text;
      },
    });
    renderProgress.start();
    resultUi.canvasWrap.replaceChildren(ui.spinner(28));

    const renderSelection = page.generationRender || page.renderOptions;
    let rendered;
    try {
      // 下一帧再渲染,让 loading 先上屏。
      await new Promise(resolve => setTimeout(resolve, 30));
      if (!alive(token) || !resultRenderState.isCurrent(renderToken)) {
        renderProgress.stop();
        return false;
      }
      rendered = renderDigestToCanvas(item.digest, {
        theme: renderSelection.theme,
        fontSize: renderSelection.fontSize,
        accentColor: renderSelection.accentColor,
      });
    } catch (error) {
      renderProgress.stop();
      if (!alive(token) || !resultRenderState.isCurrent(renderToken)) return false;
      resultUi.resultStatus.textContent = `渲染失败:${error?.message || '未知错误'}`;
      return false;
    }
    renderProgress.stop();
    if (!alive(token) || !resultRenderState.isCurrent(renderToken)) return false;
    page.currentRender = rendered;
    // 离屏绘制完成后原子替换可见 canvas。
    const visible = rendered.canvas;
    visible.className = 'result-canvas';
    visible.setAttribute('role', 'img');
    syncDigestPreviewIdentity({
      identityElement: resultUi.identity,
      canvas: visible,
      previewGroup: item.target.group_name,
      processingGroup: page.previewProcessingGroup,
    });
    const zoomTrigger = createResultZoomTrigger(visible, {
      label: `打开${String(item.target.group_name || '').trim()}摘要长图预览`,
      onOpen: openZoomModal,
    });
    if (!zoomTrigger) return false;
    resultUi.canvasWrap.replaceChildren(zoomTrigger);
    updateResultActionState();
    return true;
  }

  function currentSavedItem() {
    const digest = page.currentRender?.digest;
    return digest ? page.savedItems.get(String(digest.digest_id || '')) || null : null;
  }

  function captureResultOwner(rendered = page.currentRender) {
    const renderToken = resultRenderState.current();
    const renderedIndex = page.currentResultIndex;
    return {
      isCurrent: () => !page.destroyed
        && !actionAbort.signal.aborted
        && resultRenderState.isCurrent(renderToken)
        && page.currentRender === rendered
        && page.currentResultIndex === renderedIndex,
    };
  }

  function currentGenerationTicket() {
    const generation = page.currentRender?.digest?.__generation;
    const id = String(generation?.id || '').trim();
    const ticket = String(generation?.token || '').trim();
    return id && ticket ? { id, token: ticket } : null;
  }

  function updateResultActionState(statusText = '') {
    if (!resultUi) return;
    const inputsLocked = digestInputsLocked();
    for (const tab of resultUi.tabs.querySelectorAll('.result-tab')) {
      tab.disabled = inputsLocked;
    }
    const hasRender = !!page.currentRender;
    const saved = currentSavedItem();
    const ticket = currentGenerationTicket();
    const browserPermissionDenied = !saved && clipboardPermission.isWriteDenied();
    const actionState = digestResultActionState({
      hasRender,
      hasTicket: !!ticket,
      saved: !!saved,
      running: page.running,
      saving: page.saving,
      actionBusy: resultOperation.isBusy(),
      clipboardDenied: browserPermissionDenied,
    });
    resultUi.saveBtn.disabled = actionState.saveDisabled;
    resultUi.copyImageBtn.disabled = actionState.copyImageDisabled;
    resultUi.copyImageBtn.title = browserPermissionDenied
      ? '浏览器已明确拒绝图片剪贴板权限,请使用保存 PNG'
      : 'Ctrl+Shift+C';
    resultUi.copyPathBtn.disabled = actionState.copyPathDisabled;
    resultUi.revealBtn.disabled = actionState.revealDisabled;
    resultUi.rerenderBtn.disabled = actionState.rerenderDisabled;
    resultUi.resultStatus.textContent = digestResultStatusText({
      statusText,
      saving: page.saving,
      saved: !!saved,
      savedPath: saved?.relative_path,
      hasRender,
      hasTicket: !!ticket,
    });
  }

  function openZoomModal(canvas) {
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    copy.getContext('2d').drawImage(canvas, 0, 0);
    copy.className = 'zoom-canvas';
    const wrap = createZoomRegion(copy);
    if (!wrap) return;
    openPageModal({ title: '长图预览(100%)', content: wrap, wide: true });
  }

  function wireResultActions() {
    resultUi.saveBtn.addEventListener('click', () => { void saveCurrentPng(); });
    resultUi.copyImageBtn.addEventListener('click', () => { void copyCurrentImage(); });
    resultUi.copyPathBtn.addEventListener('click', () => { void copySavedPath(); });
    resultUi.revealBtn.addEventListener('click', () => { void revealSavedItem(); });
    resultUi.rerenderBtn.addEventListener('click', () => { void rerenderCurrentTheme(); });
  }

  async function saveCurrentPng() {
    const rendered = page.currentRender;
    const active = page.activeBatch;
    const ticket = currentGenerationTicket();
    if (!rendered || !active?.batch || !ticket || page.saving) return;
    const saveGeneration = page.generation;
    const renderToken = resultRenderState.current();
    const renderedIndex = page.currentResultIndex;
    const isCurrentSave = () => !page.destroyed
      && !actionAbort.signal.aborted
      && alive(saveGeneration)
      && resultRenderState.isCurrent(renderToken)
      && page.activeBatch === active
      && page.currentRender === rendered
      && page.currentResultIndex === renderedIndex;
    const digest = rendered.digest;
    let saveActionId = '';
    setSaving(true, saveProgressMessage('saving'));
    try {
      const bytes = await canvasToValidatedPngBytes(rendered.canvas, { signal: actionAbort.signal });
      if (!isCurrentSave()) return;
      const metadata = {
        render: {
          theme: rendered.theme,
          font_size: rendered.fontSize,
          accent_color: rendered.accentColor || '',
        },
        batch_id: active.batch.batch_id,
        batch_token: active.batch.batch_token,
        service_instance_id: active.batch.service_instance_id || api.getServiceInstanceId(),
        local_action_id: createLocalActionId('savepng'),
        generation_id: ticket.id,
        generation_token: ticket.token,
        digest_id: String(digest.digest_id || ''),
        account_label: String(store.get('account')?.display_name || store.get('account')?.name || ''),
      };
      saveActionId = metadata.local_action_id;
      const result = await api.postRaw('/api/save-render', bytes, {
        'Content-Type': 'image/png',
        'x-wx-save-metadata': encodeURIComponent(JSON.stringify(metadata)),
        'x-wx-batch-id': active.batch.batch_id,
        'x-wx-batch-token': active.batch.batch_token,
      }, {
        timeoutMs: 180 * 1000,
        localActionId: metadata.local_action_id,
        signal: actionAbort.signal,
      });
      scheduleLocalActionRecovery(saveActionId, 'save_render', {
        digest_id: String(digest.digest_id || ''),
      }, result);
      if (!isCurrentSave()) return;
      if (result?.item && typeof result.item === 'object') {
        page.savedItems.set(String(digest.digest_id || ''), result.item);
      }
      const recovery = classifyLocalActionRecovery(result);
      if (recovery === 'verified') {
        ui.toastSuccess(`已保存:${result?.item?.relative_path || ''}`);
        resultUi.resultStatus.textContent = saveProgressMessage('confirmed');
      } else {
        ui.toast('保存已提交,本地服务未能完成核对;请查看批次结果或文件后再重试。', { type: 'warn' });
        resultUi.resultStatus.textContent = saveProgressMessage('warning');
      }
      updateResultActionState();
    } catch (error) {
      const outcomeUnknown = isMutationOutcomeUnknown(error);
      if (outcomeUnknown && saveActionId) {
        scheduleLocalActionRecovery(saveActionId, 'save_render', {
          digest_id: String(digest.digest_id || ''),
        });
      }
      if (!isCurrentSave()) return;
      if (outcomeUnknown) {
        ui.toast('保存请求超时/断连,结果未知;请先核对输出目录,不要立即重复保存。', { type: 'warn', duration: 6000 });
        resultUi.resultStatus.textContent = saveProgressMessage('unknown');
      } else {
        ui.toastError(error?.message || '保存失败');
        resultUi.resultStatus.textContent = saveProgressMessage('failed', { reason: error?.message || '未知错误' });
      }
      updateResultActionState(resultUi.resultStatus.textContent);
    } finally {
      if (isCurrentSave()) {
        const statusText = resultUi?.resultStatus?.textContent || '';
        setSaving(false, statusText);
      }
    }
  }

  async function copyCurrentImage() {
    const rendered = page.currentRender;
    if (!rendered) return;
    const operation = beginResultOperation('copy_image', '复制图片');
    if (!operation) return;
    const taskToken = taskScope.capture();
    const resultOwner = captureResultOwner(rendered);
    const isCurrentCopy = () => resultOwner.isCurrent()
      && taskScope.isCurrent(taskToken);
    try {
      const saved = currentSavedItem();
      // 已保存 → 系统剪贴板;未保存 → 浏览器剪贴板(结果未知语义)。
      if (saved) {
        await copySavedImageToSystemClipboard(saved, { isCurrent: isCurrentCopy });
        return;
      }
      const localActionId = createLocalActionId('copyimg');
      const reportPhase = (phase, extra = {}) => api.post('/api/browser-clipboard-action', {
        local_action_id: localActionId,
        kind: 'preview_clipboard_copy',
        phase,
        digest_id: String(rendered.digest?.digest_id || ''),
        preview_source: 'digest_result',
        ...extra,
      }, { timeoutMs: 10000, signal: actionAbort.signal }).catch(error => {
        const failure = error instanceof Error ? error : new Error(String(error || '无法记录浏览器剪贴板状态'));
        if (phase === 'prepared') {
          failure.clipboard_prepared_evidence_failed = true;
          throw failure;
        }
        if (phase === 'browser_committed') {
          failure.clipboard_commit_evidence_failed = true;
          throw failure;
        }
        return null;
      });
      try {
        await reportPhase('prepared');
        if (!isCurrentCopy()) return;
        const permission = await clipboardPermission.refresh({ signal: actionAbort.signal });
        if (!isCurrentCopy()) return;
        if (permission.write === 'denied') {
          ui.toastWarn('浏览器已明确拒绝图片剪贴板权限,请使用「保存 PNG」。');
          await reportPhase('browser_rejected', { message: 'clipboard_permission_denied' });
          return;
        }
        const blob = await canvasToPngBlob(rendered.canvas, { signal: actionAbort.signal });
        if (!isCurrentCopy()) return;
        if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
          ui.toastWarn('当前浏览器不支持复制图片,请使用「保存 PNG」。');
          await reportPhase('browser_rejected', { message: 'clipboard_api_unavailable' });
          return;
        }
        await submitBrowserClipboardWriteLocked(
          () => navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]),
          { signal: actionAbort.signal, timeoutMs: 5000, action: '复制图片到剪贴板' },
        );
        await reportPhase('browser_committed', {
          clipboard: { width: rendered.width, height: rendered.height },
        });
        if (!isCurrentCopy()) return;
        ui.toastSuccess('图片已复制到剪贴板。');
      } catch (error) {
        if (error?.clipboard_prepared_evidence_failed) {
          if (!isCurrentCopy()) return;
          ui.toastError('无法记录浏览器复制准备状态,未开始写入剪贴板;请稍后重试。');
        } else if (error?.clipboard_commit_evidence_failed) {
          await reportPhase('outcome_unknown');
          if (!isCurrentCopy()) return;
          ui.toast('浏览器已接收复制请求,但最终结果未知;请粘贴确认,不要立即重复复制。', { type: 'warn', duration: 6000 });
        } else if (error?.clipboard_outcome_unknown) {
          await reportPhase('outcome_unknown');
          if (!isCurrentCopy()) return;
          ui.toast('浏览器已接收复制请求,但最终结果未知;请粘贴确认,不要立即重复复制。', { type: 'warn', duration: 6000 });
        } else if (error?.clipboard_write_pending || error?.browser_clipboard_cross_context_pending) {
          if (!isCurrentCopy()) return;
          ui.toastWarn(error.message);
        } else if (actionAbort.signal.aborted) {
          return;
        } else {
          await reportPhase('browser_rejected', { message: String(error?.message || '').slice(0, 200) });
          if (!isCurrentCopy()) return;
          ui.toastError(error?.message || '复制图片失败');
        }
      }
    } finally {
      endResultOperation(operation);
    }
  }

  async function copySavedImageToSystemClipboard(item, { isCurrent = () => true } = {}) {
    const actionId = createLocalActionId('copyimg');
    await taskScope.run(
        () => trackLocalActionRecovery(
          api.post('/api/copy-image', {
            local_action_id: actionId,
            digest_id: String(item.digest_id || ''),
            history_item_key: String(item.history_item_key || ''),
            expected_file_version: String(item.file_version || ''),
          }, { signal: actionAbort.signal }),
          { actionId, kind: 'clipboard_copy', target: item },
        ),
      {
        onSuccess(result) {
          if (!isCurrent()) return;
          const recovery = classifyLocalActionRecovery(result);
          if (recovery === 'verified') ui.toastSuccess('图片已复制到剪贴板。');
          else ui.toast('复制请求已提交,但本地服务未能确认剪贴板内容;请粘贴确认。', { type: 'warn' });
        },
        onError(error) {
          if (isMutationOutcomeUnknown(error)) {
            if (!isCurrent()) return;
            ui.toast('复制请求超时,结果未知;请粘贴确认后再决定是否重试。', { type: 'warn', duration: 6000 });
          } else {
            if (!isCurrent()) return;
            ui.toastError(error?.message || '复制图片失败');
          }
        },
      },
    );
  }

  async function copySavedPath() {
    const saved = currentSavedItem();
    if (!saved) return;
    const operation = beginResultOperation('copy_path', '复制路径');
    if (!operation) return;
    const resultOwner = captureResultOwner(page.currentRender);
    try {
      const actionId = createLocalActionId('copypath');
      await taskScope.run(
        () => trackLocalActionRecovery(
          api.post('/api/copy-path', {
            local_action_id: actionId,
            digest_id: String(saved.digest_id || ''),
            history_item_key: String(saved.history_item_key || ''),
            expected_file_version: String(saved.file_version || ''),
            copy_to_system: true,
          }, { signal: actionAbort.signal }),
          { actionId, kind: 'text_clipboard_copy', target: saved },
        ),
        {
          onSuccess(result) {
            if (!resultOwner.isCurrent()) return;
            if (result?.clipboard_supported === false) {
              ui.toastWarn('系统剪贴板不可用,请手动复制路径。');
              return;
            }
            const recovery = classifyLocalActionRecovery(result);
            if (recovery === 'verified') ui.toastSuccess('路径已复制。');
            else ui.toast('复制路径请求已提交,但未能确认剪贴板内容;请粘贴确认。', { type: 'warn' });
          },
          onError(error) {
            if (isMutationOutcomeUnknown(error)) {
              if (!resultOwner.isCurrent()) return;
              ui.toast('复制路径请求超时,结果未知;请粘贴确认后再决定是否重试。', { type: 'warn', duration: 6000 });
            } else {
              if (!resultOwner.isCurrent()) return;
              ui.toastError(error?.message || '复制路径失败');
            }
          },
        },
      );
    } finally {
      endResultOperation(operation);
    }
  }

  async function revealSavedItem() {
    const saved = currentSavedItem();
    if (!saved) return;
    const operation = beginResultOperation('reveal', '在文件夹显示');
    if (!operation) return;
    const resultOwner = captureResultOwner(page.currentRender);
    try {
      const actionId = createLocalActionId('reveal');
      await taskScope.run(
        () => trackLocalActionRecovery(
          api.post('/api/reveal', {
            local_action_id: actionId,
            digest_id: String(saved.digest_id || ''),
            history_item_key: String(saved.history_item_key || ''),
            expected_file_version: String(saved.file_version || ''),
          }, { signal: actionAbort.signal }),
          { actionId, kind: 'reveal', target: saved },
        ),
        {
          onSuccess(result) {
            if (!resultOwner.isCurrent()) return;
            const recovery = classifyLocalActionRecovery(result);
            if (recovery === 'verified') ui.toastSuccess('已在文件夹中显示。');
            else ui.toast('打开文件夹的请求已提交,本地服务未能完成窗口核对;请查看文件管理器。', { type: 'warn' });
          },
          onError(error) {
            if (isMutationOutcomeUnknown(error)) {
              if (!resultOwner.isCurrent()) return;
              ui.toast('请求超时,结果未知;请查看文件管理器,不要立即重复操作。', { type: 'warn', duration: 6000 });
            } else {
              if (!resultOwner.isCurrent()) return;
              ui.toastError(error?.message || '打开文件夹失败');
            }
          },
        },
      );
    } finally {
      endResultOperation(operation);
    }
  }

  async function rerenderCurrentTheme() {
    const index = page.currentResultIndex;
    // 首次保存前可按当前选项重画;保存成功后一次性凭据已消费,按钮会关闭。
    const rendered = await renderCurrentResult(index);
    if (rendered && !page.destroyed && page.currentResultIndex === index) {
      ui.toast('已按当前渲染选项重新绘制;请保存 PNG。', { type: 'info' });
    }
  }

  // -------------------------------------------------------------------------
  // 文本预览
  // -------------------------------------------------------------------------
  function showTextPreview(results, run) {
    const digests = results
      .filter(item => item?.outcome === 'done' && item.digest)
      .map(item => item.digest);
    page.previewDigests = digests;
    if (!digests.length) {
      ui.toastWarn('没有群生成成功;请查看批次结果中的原因。');
      return;
    }
    invalidateTextPreviewAction('文本预览已更新');
    page.previewMarkdown = digestMarkdownForDigests(digests);
    renderTextPreviewCard();
  }

  function syncTextPreviewActionControls() {
    if (page.destroyed) return;
    syncInputControls();
    syncSelectionUi();
    renderGroupList();
    syncActionHint();
  }

  function invalidateTextPreviewAction(reason = '文本预览已失效') {
    const changed = textPreviewAction.invalidate(reason);
    if (changed) syncTextPreviewActionControls();
    return changed;
  }

  function renderTextPreviewCard() {
    // 恢复预览也可能替换当前卡片;旧导出不得写回新卡片。
    invalidateTextPreviewAction('文本预览已替换');
    const card = el('section', 'card card-pad text-preview-card');
    const head = el('div', 'result-head');
    head.append(
      el('h3', 'card-title', `文本预览(${page.previewDigests.length} 个群)`),
    );
    const textarea = document.createElement('textarea');
    textarea.className = 'text-preview-body';
    textarea.readOnly = true;
    textarea.value = page.previewMarkdown;
    textarea.setAttribute('aria-label', '摘要文本预览');
    const actions = el('div', 'result-actions');
    const copyBtn = el('button', 'btn btn-primary btn-sm', '复制全文');
    copyBtn.type = 'button';
    const exportBtn = el('button', 'btn btn-ghost btn-sm', '导出 MD');
    exportBtn.type = 'button';
    const downloadBtn = el('button', 'btn btn-ghost btn-sm', '下载 MD');
    downloadBtn.type = 'button';
    const downloadCapability = browserDownloadCapability({ requireObjectUrl: true });
    const downloadSupported = downloadCapability.supported;
    if (!downloadSupported) {
      downloadBtn.title = browserDownloadUnsupportedMessage({ artifactLabel: 'Markdown 文件' });
    }
    downloadBtn.disabled = !downloadSupported;
    const status = el('p', 'result-status muted');
    actions.append(copyBtn, exportBtn, downloadBtn);
    card.append(head, textarea, actions, status);
    textPreviewSlot.replaceChildren(card);

    const actionButtons = [copyBtn, exportBtn, downloadBtn];
    const syncActionButtons = () => {
      const busy = textPreviewAction.isBusy();
      for (const button of actionButtons) {
        button.disabled = busy || (button === downloadBtn && !downloadSupported);
      }
      if (busy) card.setAttribute('aria-busy', 'true');
      else card.removeAttribute('aria-busy');
    };
    const releaseAction = action => {
      if (!textPreviewAction.end(action)) return false;
      syncActionButtons();
      syncTextPreviewActionControls();
      return true;
    };

    copyBtn.addEventListener('click', async () => {
      const action = textPreviewAction.begin('copy');
      if (!action) return;
      const actionFocusTarget = captureActionFocus(actionButtons, globalThis.document?.activeElement);
      syncActionButtons();
      syncTextPreviewActionControls();
      const markdown = page.previewMarkdown;
      const actionId = createLocalActionId('copytext');
      try {
        await taskScope.run(
          () => trackLocalActionRecovery(
            api.post('/api/copy-text', {
              local_action_id: actionId,
              text: markdown,
            }, { signal: action.controller.signal }),
            { actionId, kind: 'text_clipboard_copy' },
          ),
          {
            onSuccess(result) {
              if (!textPreviewAction.isCurrent(action)) return;
              const recovery = classifyLocalActionRecovery(result);
              if (recovery === 'verified') ui.toastSuccess('全文已复制。');
              else ui.toast('复制请求已提交,但未能确认剪贴板内容;请粘贴确认。', { type: 'warn' });
            },
            onError(error) {
              if (isMutationOutcomeUnknown(error)) {
                if (!textPreviewAction.isCurrent(action)) return;
                ui.toast('复制请求超时,结果未知;请粘贴确认后再决定是否重试。', { type: 'warn', duration: 6000 });
              } else if (textPreviewAction.isCurrent(action) && error?.name !== 'AbortError') {
                ui.toastError(error?.message || '复制失败');
              }
            },
          },
        );
      } finally {
        if (releaseAction(action)) {
          restoreActionFocus(actionFocusTarget, {
            activeElement: globalThis.document?.activeElement,
            body: globalThis.document?.body,
          });
        }
      }
    });

    exportBtn.addEventListener('click', async () => {
      const active = page.activeBatch;
      if (!active?.batch) {
        ui.toastWarn('批次已释放,无法导出;请重新生成文本预览。');
        return;
      }
      const action = textPreviewAction.begin('export');
      if (!action) return;
      const actionFocusTarget = captureActionFocus(actionButtons, globalThis.document?.activeElement);
      syncActionButtons();
      syncTextPreviewActionControls();
      const markdown = page.previewMarkdown;
      const actionId = createLocalActionId('exportmd');
      status.textContent = '正在导出 Markdown…';
      const exportStillCurrent = () => !page.destroyed
        && page.activeBatch === active
        && textPreviewAction.isCurrent(action);
      try {
        const account = store.get('account');
        const result = await api.post('/api/export-preview', {
          batch_id: active.batch.batch_id,
          batch_token: active.batch.batch_token,
          service_instance_id: active.batch.service_instance_id || api.getServiceInstanceId(),
          local_action_id: actionId,
          title: `群聊摘要 ${new Date().toLocaleDateString('zh-CN')}`,
          markdown,
          account_id: accountIdOf(account),
          expected_account_fingerprint: accountFingerprintOf(account) || undefined,
        }, { signal: action.controller.signal });
        scheduleLocalActionRecovery(actionId, 'export_preview', null, result);
        if (!exportStillCurrent()) return;
        const path = result?.item?.relative_path || '';
        const recovery = classifyLocalActionRecovery(result);
        const feedback = textPreviewExportFeedback({
          recovery,
          path,
          redacted: result?.redacted === true,
        });
        if (feedback.type === 'success') ui.toastSuccess(feedback.toast);
        else ui.toast(feedback.toast, { type: 'warn', duration: 6000 });
        status.textContent = feedback.status;
      } catch (error) {
        if (isMutationOutcomeUnknown(error)) {
          scheduleLocalActionRecovery(actionId, 'export_preview');
          if (!exportStillCurrent()) return;
          ui.toast('导出请求超时,结果未知;请先核对输出目录,不要立即重复导出。', { type: 'warn', duration: 6000 });
          status.textContent = '导出结果未知(请求超时);请核对输出目录后再决定是否重试。';
        } else if (exportStillCurrent() && error?.name !== 'AbortError') {
          ui.toastError(error?.message || '导出失败');
          status.textContent = `导出失败:${error?.message || '未知错误'}`;
        }
      } finally {
        if (releaseAction(action)) {
          if (!page.destroyed && page.activeBatch === active) {
            restoreActionFocus(actionFocusTarget, {
              activeElement: globalThis.document?.activeElement,
              body: globalThis.document?.body,
            });
          }
        }
      }
    });

    downloadBtn.addEventListener('click', () => {
      if (!browserDownloadCapability({ requireObjectUrl: true }).supported) {
        ui.toastWarn(browserDownloadUnsupportedMessage({ artifactLabel: 'Markdown 文件' }));
        return;
      }
      const focusTarget = document.activeElement;
      const action = textPreviewAction.begin('download');
      if (!action) return;
      syncActionButtons();
      syncTextPreviewActionControls();
      let url = '';
      let anchor = null;
      try {
        const blob = new Blob([page.previewMarkdown], { type: 'text/markdown;charset=utf-8' });
        url = URL.createObjectURL(blob);
        anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `群聊摘要-${new Date().toISOString().slice(0, 10)}.md`;
        document.body.appendChild(anchor);
        anchor.click();
      } catch (error) {
        if (textPreviewAction.isCurrent(action) && error?.name !== 'AbortError') {
          ui.toastError(error?.message || '下载失败');
        }
      } finally {
        if (anchor) {
          try { anchor.remove(); } catch {}
        }
        if (url) {
          const urlToRevoke = url;
          setTimeout(() => {
            try { URL.revokeObjectURL(urlToRevoke); } catch {}
          }, 5000);
        }
        releaseAction(action);
        if (!page.destroyed && focusTarget?.isConnected && typeof focusTarget.focus === 'function') {
          focusTarget.focus({ preventScroll: true });
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  // 中断恢复
  // -------------------------------------------------------------------------
  const currentRecoveryIdentity = () => digestRecoveryIdentity(store.get('account'));
  const currentRecoveryRecord = (batchId = '') => selectInterruptedDigestBatchRecord(
    readInterruptedDigestBatchRecords(),
    currentRecoveryIdentity(),
    batchId,
  );

  // 跨标签恢复 claim 覆盖 API 读取之后的准入/渲染/marker 清理窗口。
  // 页面销毁时旧 claim 不抢着删除,等短租约过期后再允许其他标签接管。
  let recoveryClaim = null;
  let recoveryClaimAction = null;
  const releaseRecoveryClaim = action => {
    if (!action || recoveryClaimAction !== action) return false;
    const claim = recoveryClaim;
    recoveryClaim = null;
    recoveryClaimAction = null;
    try { return claim?.release?.() === true; } catch { return false; }
  };

  function handleRecoveryStorageChange(source) {
    if (page.destroyed) return;
    if (source === 'storage' && recoveryAction.isBusy()) {
      const action = recoveryAction.snapshot?.();
      let markerStillPresent = false;
      try {
        markerStillPresent = !!action?.batchId && !!currentRecoveryRecord(action.batchId);
      } catch {}
      if (!markerStillPresent) recoveryAction.invalidate('恢复记录已被其他页面改变');
    }
    void checkInterruptedRecovery();
  }

  function finishRecoveryAction(action, focusTarget) {
    if (!recoveryAction.isCurrent(action)) return false;
    recoveryAction.end(action);
    releaseRecoveryClaim(action);
    if (!page.activeBatch) page.releaseCrossTabGenerationLease?.();
    if (page.destroyed) return true;
    const target = focusTarget?.isConnected && !focusTarget.disabled
      ? focusTarget
      : pageTitle;
    restoreActionFocus(target, {
      activeElement: globalThis.document?.activeElement,
      body: globalThis.document?.body,
    });
    return true;
  }

  async function checkInterruptedRecovery() {
    if (page.destroyed || page.accountContextBlocked || recoveryAction.isBusy()) return;
    const readCurrentRecoveryRecord = (batchId = '') => {
      try {
        return { record: currentRecoveryRecord(batchId), error: null };
      } catch (error) {
        return { record: null, error };
      }
    };
    const recoveryStorageReadFailureMessage =
      '浏览器无法读取本地恢复记录；请允许本站使用本地存储后重试。';
    const showRecoveryStorageReadFailure = target => {
      if (page.destroyed) return;
      const status = el('p', 'result-status muted', recoveryStorageReadFailureMessage);
      target?.replaceChildren(status);
    };
    recoverySlot.replaceChildren();
    const recoveryRead = readCurrentRecoveryRecord();
    if (recoveryRead.error) {
      showRecoveryStorageReadFailure(recoverySlot);
      return;
    }
    const record = recoveryRead.record;
    if (!record) return;

    const card = el('section', 'card card-pad recovery-card');
    const title = el('h3', 'card-title', '检测到未完成的批次');
    const detail = el('p', 'muted',
      `批次 ${record.batch_id.slice(0, 8)}…(${record.targets.length} 个群,${record.preview_text ? '文本预览' : '长图'}模式)在页面关闭前未完成。`);
    const actions = el('div', 'result-actions');
    const recoverBtn = el('button', 'btn btn-primary btn-sm', '恢复结果');
    recoverBtn.type = 'button';
    const discardBtn = el('button', 'btn btn-ghost btn-sm', '放弃并取消');
    discardBtn.type = 'button';
    const status = el('p', 'result-status muted');
    actions.append(recoverBtn, discardBtn);
    card.append(title, detail, actions, status);
    recoverySlot.replaceChildren(card);

    const showRecoveryCleanupFailure = (
      message = '浏览器无法清理本地恢复记录；结果仍需核对，请允许本站使用本地存储后重试。',
    ) => {
      status.textContent = message;
      recoverBtn.disabled = false;
      discardBtn.disabled = false;
      card.removeAttribute('aria-busy');
    };
    const showTerminalRecoveryPersistenceFailure = () => {
      showRecoveryCleanupFailure(
        '服务端摘要恢复记录持久化失败;当前结果可继续使用,但本地服务重启后无法自动恢复。',
      );
    };
    const recoveryActionIsCurrent = action => !page.destroyed
      && (!action || recoveryAction.isCurrent(action));
    const clearRecoveryRecord = async (batchId, failureMessage = '', action = null) => {
      const claim = action && recoveryClaimAction === action ? recoveryClaim : null;
      if (!recoveryActionIsCurrent(action)) return false;
      if (claim && !claim.isCurrent?.()) return false;
      try {
        if (claim) {
          const committed = await claim.commit?.(() => {
            if (!recoveryActionIsCurrent(action) || !claim.isCurrent?.()) return false;
            return forgetInterruptedDigestBatch(batchId, {
              claimOwnerId: claim.ownerId,
            }) === true;
          });
          if (committed === true && recoveryActionIsCurrent(action)) return true;
        } else if (recoveryActionIsCurrent(action)
          && forgetInterruptedDigestBatch(batchId) === true
          && recoveryActionIsCurrent(action)) return true;
      } catch {}
      if (!recoveryActionIsCurrent(action) || (claim && !claim.isCurrent?.())) return false;
      showRecoveryCleanupFailure(failureMessage || undefined);
      return false;
    };
    const showRecoveryCancelFailure = (action, recordRestored = true) => {
      if (page.destroyed || !recoveryAction.isCurrent(action)) return;
      status.textContent = recordRestored
        ? '服务端未确认取消；恢复记录仍保留，请稍后重试。'
        : '服务端未确认取消，恢复记录恢复失败；请刷新页面并重新核对。';
      recoverBtn.disabled = false;
      discardBtn.disabled = false;
      card.removeAttribute('aria-busy');
    };

    discardBtn.addEventListener('click', async () => {
      const action = recoveryAction.begin(record.batch_id, 'discard');
      if (!action) return;
      const actionFocusTarget = captureActionFocus([recoverBtn, discardBtn], globalThis.document?.activeElement);
      recoverBtn.disabled = true;
      discardBtn.disabled = true;
      card.setAttribute('aria-busy', 'true');
      const recoveryRead = readCurrentRecoveryRecord(record.batch_id);
      if (recoveryRead.error) {
        status.textContent = recoveryStorageReadFailureMessage;
        recoverBtn.disabled = false;
        discardBtn.disabled = false;
        card.removeAttribute('aria-busy');
        finishRecoveryAction(action, actionFocusTarget);
        return;
      }
      const currentRecord = recoveryRead.record;
      if (!currentRecord) {
        finishRecoveryAction(action, actionFocusTarget);
        await checkInterruptedRecovery();
        return;
      }
      let refreshAfter = true;
      try {
        let cancelResult = null;
        try {
          cancelResult = await cancelDigestBatch(api, {
            batch_id: currentRecord.batch_id,
            batch_token: currentRecord.batch_token,
            service_instance_id: currentRecord.service_instance_id,
          }, { reason: 'recovery_discarded', signal: action.controller.signal });
        } catch {}
        if (page.destroyed || !recoveryAction.isCurrent(action)) {
          refreshAfter = false;
          return;
        }
        if (!digestBatchCancelConfirmed(cancelResult)) {
          refreshAfter = false;
          showRecoveryCancelFailure(action, true);
          return;
        }
        if (!await clearRecoveryRecord(
          currentRecord.batch_id,
          '服务端已取消但本地记录清理失败，可重试清理。',
          action,
        )) {
          refreshAfter = false;
          return;
        }
        if (!recoveryActionIsCurrent(action)) {
          refreshAfter = false;
          return;
        }
        recoverySlot.replaceChildren();
      } finally {
        finishRecoveryAction(action, actionFocusTarget);
        if (refreshAfter && !page.destroyed) void checkInterruptedRecovery();
      }
    });

    recoverBtn.addEventListener('click', async () => {
      const action = recoveryAction.begin(record.batch_id, 'recover');
      if (!action) return;
      const actionFocusTarget = captureActionFocus([recoverBtn, discardBtn], globalThis.document?.activeElement);
      recoverBtn.disabled = true;
      discardBtn.disabled = true;
      card.setAttribute('aria-busy', 'true');
      status.textContent = '正在恢复…';
      let outcome;
      let lockedRecord = null;
      let recoveryOwner = null;
      try {
        outcome = await runRecoveryOnce(record.batch_id, async (currentRecord, claim) => {
          lockedRecord = currentRecord;
          recoveryClaim = claim;
          recoveryClaimAction = action;
          recoveryOwner = createDigestRecoveryOwner({
            action,
            isCurrentAction: candidate => recoveryAction.isCurrent(candidate)
              && (typeof claim?.isCurrent !== 'function' || claim.isCurrent() === true),
            getIdentity: currentRecoveryIdentity,
            record: currentRecord,
            isDestroyed: () => page.destroyed,
          });
          if (!recoveryOwner.isCurrent()) return { kind: 'stale' };
          if (typeof page.acquireCrossTabGenerationLease === 'function') {
            let lease;
            try {
              lease = await page.acquireCrossTabGenerationLease(
                currentRecord.account_id,
                currentRecord.account_fingerprint,
              );
            } catch {
              lease = { acquired: false, lockUnavailable: true };
            }
            if (!lease?.acquired) {
              return {
                kind: 'generation_busy',
                lockUnavailable: lease?.lockUnavailable === true,
              };
            }
          }
          if (currentRecord.preview_text) {
            const preview = await api.post('/api/digest-batch-preview', {
              batch_id: currentRecord.batch_id,
              batch_token: currentRecord.batch_token,
              service_instance_id: currentRecord.service_instance_id,
              account_id: currentRecord.account_id,
              expected_account_fingerprint: currentRecord.account_fingerprint,
              batch_total: currentRecord.batch_total,
            }, { timeoutMs: 30000, signal: action.controller.signal });
            return { kind: 'preview', payload: preview };
          }
          const results = await api.post('/api/digest-batch-results', {
            batch_id: currentRecord.batch_id,
            batch_token: currentRecord.batch_token,
            service_instance_id: currentRecord.service_instance_id,
            account_id: currentRecord.account_id,
            expected_account_fingerprint: currentRecord.account_fingerprint,
          }, { timeoutMs: 30000, signal: action.controller.signal });
          return { kind: 'results', payload: results };
        }, {
          getIdentity: currentRecoveryIdentity,
          signal: action.controller.signal,
        });
      } catch (error) {
        if (page.destroyed
          || !recoveryAction.isCurrent(action)
          || (recoveryOwner && !recoveryOwner.isCurrent())) {
          finishRecoveryAction(action, actionFocusTarget);
          return;
        }
        status.textContent = `恢复失败:${error?.message || '未知错误'}`;
        recoverBtn.disabled = false;
        discardBtn.disabled = false;
        card.removeAttribute('aria-busy');
        finishRecoveryAction(action, actionFocusTarget);
        return;
      }
      if (page.destroyed || !recoveryAction.isCurrent(action)) {
        finishRecoveryAction(action, actionFocusTarget);
        return;
      }
      if (recoveryOwner && !recoveryOwner.isCurrent()) {
        finishRecoveryAction(action, actionFocusTarget);
        if (!page.destroyed) await checkInterruptedRecovery();
        return;
      }
      if (!outcome?.ran) {
        if (outcome?.busy) {
          status.textContent = outcome.lockUnavailable
            ? '当前浏览器不支持安全的跨标签恢复协调，请稍后在支持该功能的环境中重试。'
            : '另一个页面正在恢复该批次;本页面不重复恢复。';
        } else {
          await checkInterruptedRecovery();
        }
        recoverBtn.disabled = false;
        discardBtn.disabled = false;
        card.removeAttribute('aria-busy');
        finishRecoveryAction(action, actionFocusTarget);
        return;
      }
      if (outcome.value?.kind === 'generation_busy') {
        status.textContent = outcome.value.lockUnavailable
          ? '当前浏览器不支持安全的跨标签摘要协调，请稍后在支持该功能的环境中重试。'
          : '另一个页面正在生成或恢复当前账号的摘要，请等待它结束后重试。';
        recoverBtn.disabled = false;
        discardBtn.disabled = false;
        card.removeAttribute('aria-busy');
        finishRecoveryAction(action, actionFocusTarget);
        return;
      }
      const recoveryRead = readCurrentRecoveryRecord(lockedRecord?.batch_id);
      if (recoveryRead.error) {
        status.textContent = recoveryStorageReadFailureMessage;
        recoverBtn.disabled = false;
        discardBtn.disabled = false;
        card.removeAttribute('aria-busy');
        finishRecoveryAction(action, actionFocusTarget);
        return;
      }
      const currentRecord = recoveryRead.record;
      if (!lockedRecord
        || !currentRecord
        || currentRecord.batch_token !== lockedRecord.batch_token
        || !interruptedDigestBatchMatchesAccount(lockedRecord, currentRecoveryIdentity())) {
        finishRecoveryAction(action, actionFocusTarget);
        await checkInterruptedRecovery();
        return;
      }
      try {
        if (outcome.value?.kind === 'preview') {
          const payload = outcome.value.payload;
          const previewRecovery = digestBatchPreviewRecovery(payload);
          if (previewRecovery.status === 'pending') {
            status.textContent = '服务端仍在结算该批次，请稍后点击“恢复结果”重试。';
            recoverBtn.disabled = false;
            discardBtn.disabled = false;
            card.removeAttribute('aria-busy');
            finishRecoveryAction(action, actionFocusTarget);
            return;
          }
          if (previewRecovery.status === 'ready') {
            const recoveredBatch = {
              batch_id: lockedRecord.batch_id,
              batch_token: lockedRecord.batch_token,
              service_instance_id: lockedRecord.service_instance_id || api.getServiceInstanceId(),
            };
            // 恢复也必须经过同一 active-batch admission:不能在旧 owner
            // 尚未得到服务端确认时直接覆盖它。
            const recoveredActive = {
              batch: recoveredBatch,
              accountId: lockedRecord.account_id,
              accountFingerprint: lockedRecord.account_fingerprint,
              finish: async () => {
                try {
                  const response = await api.post('/api/digest-batch-finish', {
                    batch_id: recoveredBatch.batch_id,
                    batch_token: recoveredBatch.batch_token,
                    service_instance_id: recoveredBatch.service_instance_id,
                  }, { timeoutMs: 15000, signal: actionAbort.signal });
                    if (!digestBatchFinishConfirmed(response)) return null;
                  return response;
                } catch {
                  return null;
                }
              },
              previewText: true,
              results: [],
            };
            const admission = await admitRecoveredBatch(recoveredActive, {
              accountId: lockedRecord.account_id,
              accountFingerprint: lockedRecord.account_fingerprint,
              isCurrent: () => recoveryAction.isCurrent(action)
                && recoveryOwner?.isCurrent() === true,
            });
            if (!admission.admitted) {
              if (!admission.stale) {
                status.textContent = '当前摘要批次仍在收尾，请稍后点击“恢复结果”重试。';
                recoverBtn.disabled = false;
                discardBtn.disabled = false;
                card.removeAttribute('aria-busy');
              }
              finishRecoveryAction(action, actionFocusTarget);
              return;
            }
            page.previewDigests = previewRecovery.digests;
            page.previewMarkdown = digestMarkdownForDigests(previewRecovery.digests);
            try {
              renderTextPreviewCard();
            } catch (error) {
              if (admission.reused !== true && page.activeBatch === admission.owner) {
                try {
                  await releaseActiveBatch({
                    owner: admission.owner,
                    releasePreview: true,
                    releaseTerminalResults: true,
                  });
                } catch {}
              }
              throw error;
            }
            if (previewRecovery.terminal_recovery_persisted === false) {
              showTerminalRecoveryPersistenceFailure();
              finishRecoveryAction(action, actionFocusTarget);
              return;
            }
            if (!await clearRecoveryRecord(lockedRecord.batch_id, '', action)) {
              finishRecoveryAction(action, actionFocusTarget);
              return;
            }
            if (!recoveryActionIsCurrent(action)) {
              finishRecoveryAction(action, actionFocusTarget);
              return;
            }
            recoverySlot.replaceChildren();
            ui.toastSuccess('已恢复文本预览。');
            finishRecoveryAction(action, actionFocusTarget);
            return;
          }
          if (!await clearRecoveryRecord(lockedRecord.batch_id, '', action)) {
            finishRecoveryAction(action, actionFocusTarget);
            return;
          }
          if (!recoveryActionIsCurrent(action)) {
            finishRecoveryAction(action, actionFocusTarget);
            return;
          }
          status.textContent = '服务端已没有该批次的可恢复内容。';
          recoverBtn.disabled = false;
          discardBtn.disabled = false;
          card.removeAttribute('aria-busy');
          finishRecoveryAction(action, actionFocusTarget);
          return;
        }
        // 长图批次:取回原摘要并绑定当前画布,不重新请求 AI。
        const recoveryList = digestBatchRecoveryList(outcome.value?.payload);
        if (recoveryList.pending) {
          status.textContent = '服务端仍在结算该批次，请稍后点击“恢复结果”重试。';
          recoverBtn.disabled = false;
          discardBtn.disabled = false;
          card.removeAttribute('aria-busy');
          finishRecoveryAction(action, actionFocusTarget);
          return;
        }
        const { items } = recoveryList;
        if (!items.length) {
          if (!await clearRecoveryRecord(lockedRecord.batch_id, '', action)) {
            finishRecoveryAction(action, actionFocusTarget);
            return;
          }
          if (!recoveryActionIsCurrent(action)) {
            finishRecoveryAction(action, actionFocusTarget);
            return;
          }
          status.textContent = '服务端已没有该批次的可恢复内容。';
          recoverBtn.disabled = false;
          discardBtn.disabled = false;
          card.removeAttribute('aria-busy');
          finishRecoveryAction(action, actionFocusTarget);
          return;
        }
        status.textContent = '';
        const recovered = await recoverImageBatchResults(lockedRecord, items, {
          isCurrent: () => recoveryOwner?.isCurrent() === true,
          signal: action.controller.signal,
        });
        if (recovered?.blocked) {
          status.textContent = '当前摘要批次仍在收尾，请稍后点击“恢复结果”重试。';
          recoverBtn.disabled = false;
          discardBtn.disabled = false;
          card.removeAttribute('aria-busy');
          finishRecoveryAction(action, actionFocusTarget);
          return;
        }
        if (page.destroyed || !recovered || !recoveryOwner?.isCurrent()) {
          finishRecoveryAction(action, actionFocusTarget);
          return;
        }
        batchResultSlot.replaceChildren(buildRecoveredResultsCard(recovered.summaries));
        if (recovered.summaries?.some(item => item?.terminal_recovery_persisted === false)) {
          showTerminalRecoveryPersistenceFailure();
          finishRecoveryAction(action, actionFocusTarget);
          return;
        }
        if (!await clearRecoveryRecord(lockedRecord.batch_id, '', action)) {
          finishRecoveryAction(action, actionFocusTarget);
          return;
        }
        if (!recoveryActionIsCurrent(action)) {
          finishRecoveryAction(action, actionFocusTarget);
          return;
        }
        recoverySlot.replaceChildren();
        finishRecoveryAction(action, actionFocusTarget);
      } catch (error) {
        if (page.destroyed
          || !recoveryAction.isCurrent(action)
          || (recoveryOwner && !recoveryOwner.isCurrent())) {
          finishRecoveryAction(action, actionFocusTarget);
          return;
        }
        status.textContent = `恢复失败:${error?.message || '未知错误'}`;
        recoverBtn.disabled = false;
        discardBtn.disabled = false;
        card.removeAttribute('aria-busy');
        finishRecoveryAction(action, actionFocusTarget);
      }
    });
  }

  async function recoverImageBatchResults(record, items, {
    isCurrent = () => true,
    signal = null,
  } = {}) {
    const ownerIsCurrent = () => !page.destroyed && isCurrent();
    const renderSelection = interruptedDigestRenderSelection(record, page.renderOptions);
    const results = [];
    const summaries = [];
    for (const item of Array.isArray(items) ? items : []) {
      if (!ownerIsCurrent()) return null;
      const status = String(item?.status || '').trim();
      const index = Math.max(0, Math.trunc(Number(item?.batch_index || 0)) || 0);
      const target = {
        group_id: String(item?.group_id || record.targets?.[index]?.group_id || '').trim(),
        group_name: String(item?.group_name || record.targets?.[index]?.group_name || '').trim(),
        since: String(record.targets?.[index]?.since || '').trim(),
        until: String(record.targets?.[index]?.until || '').trim(),
      };
      if (status === 'done') {
        const terminal = requireDigestTerminalResult(
          await api.post('/api/digest-result', digestTerminalResultRequest(record, item), {
            timeoutMs: 30000,
            signal,
          }),
        );
        const terminalRecoveryMetadata = digestTerminalRecoveryMetadata(terminal);
        if (!ownerIsCurrent()) return null;
        if (String(terminal?.status || '').trim() === 'saved' && terminal?.item) {
          const savedItem = terminal.item;
          if (savedItem?.digest_id) page.savedItems.set(String(savedItem.digest_id), savedItem);
          summaries.push({ ...item, status: 'saved', item: savedItem, ...terminalRecoveryMetadata });
          continue;
        }
        const digest = terminal?.digest || terminal?.item?.digest || null;
        if (!digest || typeof digest !== 'object') {
          throw new Error(`${target.group_name || '某群'} 的终态摘要尚未可恢复，请稍后重试。`);
        }
        results.push({ target, outcome: 'done', digest, recovered: true, ...terminalRecoveryMetadata });
        summaries.push({ ...item, status: 'done', recovered: true, ...terminalRecoveryMetadata });
        continue;
      }
      if (status === 'saved') {
        const savedItem = item?.item && typeof item.item === 'object' ? item.item : null;
        if (savedItem?.digest_id) page.savedItems.set(String(savedItem.digest_id), savedItem);
        summaries.push({ ...item, status: 'saved' });
        continue;
      }
      summaries.push({ ...item, status: status || 'error' });
    }
    if (results.length) {
      if (!ownerIsCurrent()) return null;
      const recoveredBatch = {
        batch_id: record.batch_id,
        batch_token: record.batch_token,
        service_instance_id: record.service_instance_id || api.getServiceInstanceId(),
      };
      const recoveredActive = {
        batch: recoveredBatch,
        accountId: record.account_id,
        accountFingerprint: record.account_fingerprint,
        finish: async ({ releasePreview = true, releaseTerminalResults = true } = {}) => {
          try {
            const response = await api.post('/api/digest-batch-finish', {
              batch_id: recoveredBatch.batch_id,
              batch_token: recoveredBatch.batch_token,
              service_instance_id: recoveredBatch.service_instance_id,
              release_preview: releasePreview,
              release_terminal_results: releaseTerminalResults,
            }, { timeoutMs: 15000, signal: actionAbort.signal });
            if (!digestBatchFinishConfirmed(response)) return null;
            return response;
          } catch {
            return null;
          }
        },
        previewText: false,
        results,
      };
      const admission = await admitRecoveredBatch(recoveredActive, {
        accountId: record.account_id,
        accountFingerprint: record.account_fingerprint,
        isCurrent: ownerIsCurrent,
      });
      if (!admission.admitted) {
        return admission.stale ? null : { blocked: true };
      }
      const admittedOwner = admission.owner;
      page.generationRender = renderSelection;
      try {
        await showImageResults(results, { batch: recoveredBatch, results });
      } catch (error) {
        if (admission.reused !== true && page.activeBatch === admittedOwner) {
          try {
            await releaseActiveBatch({
              owner: admittedOwner,
              releasePreview: true,
              releaseTerminalResults: true,
            });
          } catch {}
        }
        throw error;
      }
      if (!ownerIsCurrent()) {
        if (page.activeBatch === admittedOwner) {
          try {
            await releaseActiveBatch({
              owner: admittedOwner,
              releasePreview: true,
              releaseTerminalResults: true,
            });
          } catch {}
        }
        return null;
      }
    }
    if (!ownerIsCurrent()) return null;
    return { results, summaries };
  }

  function buildRecoveredResultsCard(items) {
    const card = el('section', 'card card-pad batch-result-card');
    card.append(el('h3', 'card-title', '恢复的批次结果'));
    const list = el('ol', 'batch-result-list');
    for (const item of items) {
      const row = el('li', 'batch-result-row');
      const name = el('span', 'batch-result-name', String(item?.group_name || item?.group_id || `第 ${Number(item?.batch_index) + 1} 个群`));
      const statusEl = el('span', 'batch-result-status');
      const statusText = String(item?.status || '');
      if (statusText === 'saved' || statusText === 'done') {
        statusEl.textContent = statusText === 'saved' ? `已保存:${item?.item?.relative_path || ''}` : '已完成,摘要已绑定当前预览';
        statusEl.className = 'batch-result-status ok';
      } else if (statusText === 'skipped') {
        statusEl.textContent = `跳过:${item?.error?.message || ''}`;
        statusEl.className = 'batch-result-status skip';
      } else {
        statusEl.textContent = `失败:${item?.error?.message || statusText || '未知'}`;
        statusEl.className = 'batch-result-status fail';
      }
      row.append(name, statusEl);
      list.appendChild(row);
    }
    const hint = el('p', 'muted', '提示:已完成的摘要已绑定当前预览；需要 PNG 文件时可直接保存。');
    card.append(list, hint);
    return card;
  }

  // -------------------------------------------------------------------------
  // 自定义时间弹层
  // -------------------------------------------------------------------------
  function toLocalInputValue(text) {
    const parsed = parseLocalDateTime(text);
    if (!parsed) return '';
    const pad = value => String(value).padStart(2, '0');
    return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
  }

  function openCustomRangeModal() {
    const wrap = el('div', 'custom-range');
    const sinceLabel = el('label', 'field-label', '开始时间');
    const sinceInput = document.createElement('input');
    sinceInput.id = 'digest-custom-since';
    sinceLabel.htmlFor = sinceInput.id;
    sinceInput.type = 'datetime-local';
    sinceInput.className = 'input';
    sinceInput.value = toLocalInputValue(page.customSince) || toLocalInputValue(resolveRange('today').since);
    const untilLabel = el('label', 'field-label', '结束时间(留空 = 现在)');
    const untilInput = document.createElement('input');
    untilInput.id = 'digest-custom-until';
    untilLabel.htmlFor = untilInput.id;
    untilInput.type = 'datetime-local';
    untilInput.className = 'input';
    untilInput.value = toLocalInputValue(page.customUntil);
    const errorText = el('p', 'custom-range-error');
    errorText.id = 'digest-custom-range-error';
    errorText.setAttribute('role', 'alert');
    errorText.setAttribute('aria-live', 'assertive');
    errorText.setAttribute('aria-atomic', 'true');
    sinceInput.setAttribute('aria-describedby', errorText.id);
    untilInput.setAttribute('aria-describedby', errorText.id);
    const validationFeedback = createCustomRangeValidationFeedback({
      sinceInput,
      untilInput,
      errorText,
      setFieldInvalid,
      focusFirstInvalid,
    });
    wrap.append(sinceLabel, sinceInput, untilLabel, untilInput, errorText);
    openPageModal({
      title: '自定义时间范围',
      content: wrap,
      actions: [
        { label: '取消' },
        {
          label: '应用',
          kind: 'primary',
          onClick: modal => {
            const sinceValue = sinceInput.value ? sinceInput.value.replace('T', ' ') : '';
            const untilValue = untilInput.value ? untilInput.value.replace('T', ' ') : '';
            const validation = validateCustomRange(sinceValue, untilValue);
            if (!validationFeedback.show(validation)) return false;
            page.customSince = validation.sinceValue;
            page.customUntil = validation.untilValue;
            page.rangeKey = 'custom';
            syncInputControls();
            scheduleDraftSave();
            return true;
          },
        },
      ],
    });
  }

  function preserveInterruptedDigestBatchForUnload() {
    const owner = page.activeBatch;
    const active = owner?.batch;
    if (!active?.batch_id || !active?.batch_token) return false;
    const accountId = String(owner.accountId || active.account_id || '').trim();
    const accountFingerprint = String(
      owner.accountFingerprint || active.account_fingerprint || '',
    ).trim().toLowerCase();
    try {
      return rememberInterruptedDigestBatch({
        batch_id: active.batch_id,
        batch_token: active.batch_token,
        service_instance_id: active.service_instance_id || api.getServiceInstanceId?.() || '',
        ...(accountId && accountFingerprint
          ? { account_id: accountId, account_fingerprint: accountFingerprint }
          : {}),
        preview_text: owner.previewText === true,
      });
    } catch (error) {
      console.error('摘要批次卸载恢复记录保存失败', error);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // 事件绑定
  // -------------------------------------------------------------------------
  function wireEvents() {
    accountResultContext = createDigestAccountResultContextHandler({
      state: page,
      slots: {
        recovery: recoverySlot,
        batch: batchResultSlot,
        result: resultSlot,
        textPreview: textPreviewSlot,
      },
      beforeClear(change) {
        page.accountContextBlocked = change?.status === 'blocked';
        page.cancelGenerationOwner = null;
        invalidateDigestAccountAsyncWork(page);
        page.generationStarting = false;
        page.running = false;
        page.saving = false;
        page.progressView?.dispose?.();
        page.progressView = null;
        clearProgressCleanupTimer();
        progressSlot.replaceChildren();
        cancelBtn.hidden = true;
        ui.setGlobalProgress(false);
        taskScope.invalidate();
        resultOperation.invalidate();
        recoveryAction.invalidate();
        invalidateTextPreviewAction('账号已切换');
        resultRenderState.invalidate();
        settingsDerived.invalidate();
        resultUi = null;
        groupLoadScope.invalidate('账号上下文已变化');
        page.groups = [];
        page.groupsStatus = 'idle';
        page.groupsError = '';
        page.groupsProgressText = '';
        page.groupsNeedsAccountRefresh = false;
        page.selected.clear();
        page.whitelistRefs = [];
        page.recentRefs = [];
        renderGroupList();
        renderRecentRefs();
        syncSelectionUi();
        if (page.activeBatch) {
          const releaseOwner = page.activeBatch;
        void releaseActiveBatch({
            owner: releaseOwner,
            releaseTerminalResults: true,
            releasePreview: true,
          }).then(released => {
            if (released === true) forgetCancelledBatchMarker(releaseOwner);
          }).catch(() => {});
        } else {
          page.releaseCrossTabGenerationLease?.();
        }
      },
    });
    page.onBeforeUnload = event => {
      if (!page.generationStarting
        && !page.running
        && !page.saving
        && !resultOperation.isBusy()
        && !recoveryAction.isBusy()
        && !textPreviewAction.isBusy()
        && !digestDraftPersistenceRisk()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', page.onBeforeUnload);
    page.onPageHide = event => {
      if (event.persisted === true) return;
      preserveInterruptedDigestBatchForUnload();
    };
    window.addEventListener('pagehide', page.onPageHide);
    searchInput.addEventListener('input', () => {
      page.searchText = searchInput.value;
      renderGroupList();
    });
    clearBtn.addEventListener('click', () => {
      page.selected.clear();
      syncSelectionUi();
      renderGroupList();
      scheduleDraftSave();
    });
    whitelistBtn.addEventListener('click', () => {
      const account = store.get('account');
      const matches = page.groups.filter(group => page.whitelistRefs
        .some(ref => whitelistRefMatchesGroup(ref, group, account)));
      if (!matches.length) {
        ui.toast('白名单中的群不在当前群列表里。', { type: 'info' });
        return;
      }
      for (const group of matches) page.selected.add(String(group.id));
      syncSelectionUi();
      renderGroupList();
      scheduleDraftSave();
      ui.toastSuccess(`已选中白名单的 ${matches.length} 个群。`);
    });
    refreshBtn.addEventListener('click', () => { void loadGroups({ forceGroups: true }); });

    rangeSegmented.addEventListener('click', event => {
      const btn = event.target.closest('[data-range-key]');
      if (!btn) return;
      const key = btn.dataset.rangeKey;
      if (key === 'custom') {
        openCustomRangeModal();
        return;
      }
      page.rangeKey = key;
      syncInputControls();
      scheduleDraftSave();
    });

    excludeRow.addEventListener('change', () => {
      page.filters.exclude_types = [...excludeBoxes.entries()]
        .filter(([, box]) => box.checked)
        .map(([value]) => value);
      scheduleDraftSave();
    });
    minInput.addEventListener('input', () => {
      const parsed = parseStrictIntegerInput(minInput.value, { min: 1, max: 9999, clamp: true });
      if (!parsed.ok) return;
      page.minMessages = parsed.value;
      minInput.value = String(parsed.value);
      scheduleDraftSave();
    });
    minInput.addEventListener('change', () => {
      const parsed = parseStrictIntegerInput(minInput.value, { min: 1, max: 9999, clamp: true });
      if (!parsed.ok) {
        ui.toastWarn('最少消息数必须是 1-9999 的整数。');
        minInput.value = String(page.minMessages);
        return;
      }
      page.minMessages = parsed.value;
      minInput.value = String(parsed.value);
      scheduleDraftSave();
    });

    themeSegmented.addEventListener('click', event => {
      const btn = event.target.closest('[data-render-theme]');
      if (!btn) return;
      page.renderOptions.theme = btn.dataset.renderTheme;
      syncInputControls();
      scheduleDraftSave();
    });
    fontSegmented.addEventListener('click', event => {
      const btn = event.target.closest('[data-render-fontsize]');
      if (!btn) return;
      page.renderOptions.fontSize = btn.dataset.renderFontsize;
      syncInputControls();
      scheduleDraftSave();
    });

    generateBtn.addEventListener('click', () => { void startGeneration(false); });
    previewBtn.addEventListener('click', () => { void startGeneration(true); });
    cancelBtn.addEventListener('click', () => { void cancelGeneration('user_button'); });

    // 快捷键:Ctrl+Enter 生成、Ctrl+S 保存、Ctrl+Shift+C 复制图片、Esc 取消。
    page.onKeydown = event => {
      if (page.destroyed) return;
      const isMac = navigator.platform?.toLowerCase().includes('mac');
      const mod = isMac ? event.metaKey : event.ctrlKey;
      if (event.key === 'Escape' && page.running) {
        event.preventDefault();
        void cancelGeneration('esc');
        return;
      }
      if (!mod) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        if (!page.running) void startGeneration(false);
      } else if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (resultUi && !resultUi.saveBtn.disabled) void saveCurrentPng();
      } else if (event.shiftKey && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        if (resultUi && !resultUi.copyImageBtn.disabled) void copyCurrentImage();
      }
    };
    document.addEventListener('keydown', page.onKeydown);
    page.unsubscribeRecoveryChanges = subscribeInterruptedDigestRecoveryChanges({
      storageTarget: window,
      storageKey: INTERRUPTED_BATCH_STORAGE_KEY,
      subscribeAccount: notify => store.subscribe('account', () => {
        if (page.destroyed) return;
        const contextChange = draftScopeLifecycle.beginContextChange(
          digestAccountContextIdentity(store.get('account')),
        );
        accountResultContext.handle(contextChange);
        if (contextChange.status === 'unchanged') {
          notify();
          return;
        }
        accountContextRefresh.resetForContext?.();
        if (contextChange.status === 'blocked') {
          page.draftPersistenceFailed = contextChange.persistenceFailed === true;
          syncInputControls();
          renderWechatAlerts();
          notify();
          return;
        }
        page.accountContextBlocked = false;
        page.draftPersistenceFailed = false;
        restoreDraft();
        syncInputControls();
        syncSelectionUi();
        renderGroupList();
        renderWechatAlerts();
        const targetIdentity = digestAccountContextIdentity(store.get('account'));
        void settingsDerived.load({
          isCurrent: () => !page.destroyed
            && digestAccountContextIdentity(store.get('account')) === targetIdentity,
        });
        const retryGroups = () => loadGroups();
        if (!accountContextRefresh.queueRetryWhileBusy(retryGroups)) void retryGroups();
        notify();
      }),
      onChange: handleRecoveryStorageChange,
    });
    page.unsubscribeState = store.subscribe('state', () => {
      if (page.destroyed) return;
      const draftResult = restoreDraft();
      if (['restored', 'default', 'preserved'].includes(draftResult.status)) {
        reconcileGroupSelection();
        syncInputControls();
        syncSelectionUi();
        renderGroupList();
      }
      renderWechatAlerts();
    });
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------
  async function confirmDraftPersistenceBeforeLeave() {
    saveDraft();
    if (!digestDraftPersistenceRisk()) return true;
    return ui.confirmDialog({
      title: '摘要草稿未能保存',
      message: '浏览器暂时无法保存当前总结设置；离开页面会丢失这份草稿。请恢复浏览器存储后重试。',
      confirmLabel: '仍然继续',
      cancelLabel: '返回检查',
      danger: true,
    });
  }

  return {
    isRunning: () => page.generationStarting || page.running || page.saving
      || resultOperation.isBusy() || recoveryAction.isBusy() || textPreviewAction.isBusy(),

    async confirmLeaveWhileRunning() {
      if (page.saving) {
        ui.toastWarn('摘要 PNG 正在保存，请等待保存结果后再离开。');
        return false;
      }
      if (resultOperation.isBusy()) {
        const label = resultOperation.snapshot()?.label || '结果操作';
        const confirmed = await ui.confirmDialog({
          title: '操作仍在进行',
          message: `${label}还没返回结果；离开页面后可在历史页重新核对。确定离开？`,
          confirmLabel: '离开',
          danger: true,
        });
        if (!confirmed) return false;
      }
      if (recoveryAction.isBusy()) {
        ui.toastWarn('正在恢复或取消未完成的摘要批次，请等待操作结束后再离开。');
        return false;
      }
      if (page.generationStarting) {
        const confirmed = await ui.confirmDialog({
          title: '摘要正在启动',
          message: '正在释放上一批次并准备本次生成；离开页面会放弃本次启动。确定离开？',
          confirmLabel: '离开并放弃',
          danger: true,
        });
        if (!confirmed) return false;
        page.generation += 1;
      }
      if (!page.running && textPreviewAction.isBusy()) {
        const confirmation = textPreviewLeaveConfirmation(textPreviewAction.snapshot()?.kind);
        const confirmed = await ui.confirmDialog({
          ...confirmation,
          danger: true,
        });
        if (!confirmed) return false;
        invalidateTextPreviewAction('页面已离开');
      }
      if (page.running) {
        const confirmed = await ui.confirmDialog({
          title: '生成仍在进行',
          message: '摘要还在生成中,离开页面会取消本次生成。确定离开?',
          confirmLabel: '离开并取消',
          danger: true,
        });
        if (!confirmed) return false;
        await cancelGeneration('navigate_away');
      }
      return confirmDraftPersistenceBeforeLeave();
    },

    async init() {
      store.set('accountSwitchGuard', accountSwitchGuard);
      wireEvents();
      restoreDraft();
      syncInputControls();
      syncSelectionUi();
      renderGroupList();
      renderWechatAlerts();
      void loadSettingsDerived();
      // 群列表读取可能很慢(镜像重建):不阻塞 mount 返回,避免拖住路由切换;
      // 加载完成后再检查中断恢复,destroy() 会用 generation/abort 使其失效。
      void loadGroups().then(() => {
        if (!page.destroyed) void checkInterruptedRecovery();
      });
    },

    async destroy() {
      if (page.destroyed) return;
      // 先在 store 里留档,避免 unmount 后残留"仍在运行"的误判。
      page.destroyed = true;
      page.generation += 1;
      page.cancelGenerationOwner = null;
      clearProgressCleanupTimer();
      if (store.get('accountSwitchGuard') === accountSwitchGuard) {
        store.set('accountSwitchGuard', null);
      }
      resultOperation.invalidate();
      recoveryAction.invalidate();
      resultRenderState.invalidate();
      taskScope.dispose();
      groupLoadScope.dispose();
      accountContextRefresh.dispose();
      settingsDerived.dispose();
      invalidateTextPreviewAction('页面已卸载');
      window.removeEventListener('beforeunload', page.onBeforeUnload);
      window.removeEventListener('pagehide', page.onPageHide);
      if (!actionAbort.signal.aborted) actionAbort.abort(new Error('页面已卸载'));
      if (page.draftSaveTimer) clearTimeout(page.draftSaveTimer);
      page.draftSaveTimer = null;
      document.removeEventListener('keydown', page.onKeydown);
      page.unsubscribeRecoveryChanges?.();
      page.unsubscribeState?.();
      page.clipboardPermissionUnsubscribe?.();
      clipboardPermission.dispose();
      page.progressView?.dispose();
      closePageModals({ restoreFocus: false });
      if (page.abortController && !page.abortController.signal.aborted) {
        page.abortController.abort(new Error('页面已卸载'));
      }
      // 离开页面:取消服务端批次并释放资源。
      const active = page.activeBatch;
      const cancelledRunningBatchId = active?.batch && page.running
        ? active.batch.batch_id
        : '';
      let cancelResult = null;
      // onBatchCreated 阶段的占位 owner 已经把 finish 定义为同一批次的
      // cancel 请求。销毁时复用该 owner 的 finish，避免先显式 cancel、再
      // releaseActiveBatch 再 cancel 一次；完整 runner owner 仍需先 cancel
      // 生成任务，再由 finish 释放其终态资源。
      if (cancelledRunningBatchId && active?.cancelOnly !== true) {
        cancelResult = await cancelDigestBatch(api, active.batch, { reason: 'page_unmounted' });
      }
      const released = await releaseActiveBatch({
        owner: active,
        releaseTerminalResults: true,
        releasePreview: true,
      });
      if ((cancelledRunningBatchId && digestBatchCancelConfirmed(cancelResult))
        || (released === true
          && active?.cancelOnly === true
          && active.cancelMarkerForgotten !== true)) {
        const batchId = cancelledRunningBatchId || active?.batch?.batch_id;
        if (batchId) {
          const forgotten = forgetInterruptedDigestBatch(batchId);
          if (forgotten === true && active?.cancelOnly === true) {
            active.cancelMarkerForgotten = true;
          }
        }
      }
      page.releaseCrossTabGenerationLease?.();
      saveDraft();
    },
  };
}
