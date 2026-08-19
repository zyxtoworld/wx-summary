// 设置页(#/settings):六个分区的编排层。
// - 统一持有 GET /api/settings 文档与 base_settings_revision;所有保存走 PUT /api/settings。
// - 跨标签/后台更新检测:调度状态轮询 + 窗口聚焦探测 revision,变更时显示通知条。
// - 手动密钥运行时字段(verified 列表等)经 /js/settings-runtime-sync.js 增量合并。
import {
  createLatestManualKeyRuntimeSync,
  createLatestSettingsRevisionProbe,
  isStaleSettingsProbeResponse,
} from '/js/shared/settings-runtime-sync.js';
import { writeSettingsPatch } from '/js/shared/settings-write-coordinator.js';
import { restorePendingSettingsMutationRecovery } from '/js/shared/settings-mutation-recovery.js';
import { requireSettingsDocument } from '/js/shared/settings-document.js';
import { associateFormLabels } from '/js/shared/form-accessibility.js';
import { settingsAccountSwitchBlockedMessage } from '/js/shared/settings-account-switch.js';
import { refreshPublicAccountIdentityUpgrade } from '/js/shared/account-context.js';
import {
  el,
  settingsRequestContext,
  isAbortError,
} from './core.js';
import { captureActionFocus, restoreActionFocus } from '/js/shared/action-focus.js';
import { createSettingsDraftState } from './draft-state.js';
import { createSettingsExternalActionControls } from './external-action-controls.js';
import { completeSettingsAction } from './action-lifecycle.js';
import {
  createSettingsAccountContextTracker,
  invalidateSettingsActionsForAccountChange,
  notifySettingsSectionsAccountChanged,
  notifySettingsSectionsStateChanged,
  settingsAccountContextIdentity,
} from './account-context.js';
import {
  createSettingsInitializationGate,
  createSettingsInitializationLifecycle,
} from './initialization.js';
import { restoreSettingsTransientFocus } from './focus.js';
import { createAiSection } from './ai.js';
import { createSchedulerSection } from './scheduler.js';
import { createOutputSection } from './output.js';
import { createPrivacySection } from './privacy.js';
import { createSystemSection } from './system.js';
import { createAboutSection } from './about.js';
import { setSegmentedButtonState } from '../../ui/segmented.js';
import { createScopedUi } from '../../ui/lifecycle.js';
import {
  activateSettingsNavItem,
  scrollSettingsNavItemIntoView,
} from './nav-scroll.js';

const SCHEDULER_POLL_MS = 5000;

let activePage = null;

export default {
  title: '设置',
  css: '/css/settings.css',

  async mount(root, ctx) {
    const page = buildPage(root, ctx);
    activePage = page;
    void page.init();
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
    return activePage.confirmLeave();
  },
};

function buildPage(root, ctx) {
  const { api, store, ui: baseUi } = ctx;
  const pageAbort = new AbortController();
  const ui = createScopedUi(baseUi, pageAbort.signal);

  const state = {
    destroyed: false,
    initializing: true,
    initializationFailed: false,
    generation: 0,
    settings: null,
    baseRevision: '',
    // 记录当前设置快照的代数,用来丢弃保存前已经发出的旧探测响应。
    revisionEpoch: 0,
    stale: false,
    staleDismissedRevision: '',
    drafts: createSettingsDraftState({ onDirtyChange: sectionId => updateNavBadge(sectionId) }),
    externalActions: createSettingsExternalActionControls(),
    accountContext: createSettingsAccountContextTracker(store.get('account')),
    actions: new Set(),
    pollTimer: null,
    unsubscribeAccount: null,
    unsubscribeState: null,
  };
  const initializationGate = createSettingsInitializationGate();

  // ---------------------------------------------------------------------------
  // 生命周期工具
  // ---------------------------------------------------------------------------
  const alive = token => !state.destroyed && token && token.generation === state.generation;

  function softToken() {
    return { generation: state.generation, signal: pageAbort.signal };
  }

  function isBusy() {
    return state.actions.size > 0;
  }

  function hasUnsavedDrafts() {
    return state.drafts.hasUnsaved();
  }

  function accountSwitchGuard() {
    return settingsAccountSwitchBlockedMessage({
      destroyed: state.destroyed,
      initializing: state.initializing,
      initializationFailed: state.initializationFailed,
      busy: isBusy(),
      dirtyCount: state.drafts.dirtyCount(),
      accountDraftCount: state.drafts.accountScopedCount(),
    });
  }

  function beginAction(label, buttons = [], { focusCandidates = buttons } = {}) {
    const controller = new AbortController();
    const focusTarget = captureActionFocus(focusCandidates, globalThis.document?.activeElement);
    let detachPageAbort = () => {};
    const token = {
      generation: state.generation,
      label,
      controller,
      signal: controller.signal,
      focusTarget,
      cleanup() {
        detachPageAbort();
        detachPageAbort = () => {};
      },
    };
    state.actions.add(token);
    // 页面级卸载时联动取消
    if (pageAbort.signal.aborted) {
      controller.abort(pageAbort.signal.reason || new Error('页面已卸载'));
    }
    else {
      const onAbort = () => controller.abort(pageAbort.signal.reason || new Error('页面已卸载'));
      detachPageAbort = () => pageAbort.signal.removeEventListener('abort', onAbort);
      pageAbort.signal.addEventListener('abort', onAbort, { once: true });
      token.signal.addEventListener('abort', token.cleanup, { once: true });
    }
    for (const btn of buttons) if (btn) btn.disabled = true;
    syncBusy();
    return token;
  }

  function endAction(token) {
    const identityUpgrade = token?.accountIdentityUpgrade || null;
    if (token) token.accountIdentityUpgrade = null;
    const owned = completeSettingsAction({
      actions: state.actions,
      token,
      destroyed: state.destroyed,
      syncBusy,
      restoreFocus() {
        // 禁用触发按钮会让浏览器把焦点退回 body;操作结束且用户没有移焦时恢复它。
        restoreActionFocus(token.focusTarget, {
          activeElement: globalThis.document?.activeElement,
          body: globalThis.document?.body,
        });
      },
    });
    if (owned && identityUpgrade) void refreshSavedAccountIdentity(identityUpgrade);
    return owned;
  }

  function queueAccountIdentityUpgrade(result, ownerToken, callbacks = {}) {
    if (!result?.account_identity_upgrade || !alive(ownerToken)) return false;
    ownerToken.accountIdentityUpgrade = {
      result,
      onUpgraded: typeof callbacks?.onUpgraded === 'function' ? callbacks.onUpgraded : null,
      onIncomplete: typeof callbacks?.onIncomplete === 'function' ? callbacks.onIncomplete : null,
      successMessage: String(callbacks?.successMessage || '').trim(),
      failureMessage: String(callbacks?.failureMessage || '').trim(),
    };
    return true;
  }

  function syncBusy() {
    const busy = isBusy();
    for (const section of sections) section.setBusy?.(busy);
    state.externalActions.setBusy(busy);
  }

  function applySettingsToSections(document, options) {
    let firstError = null;
    for (const section of sections) {
      try {
        section.applySettings?.(document, options);
      } catch (error) {
        if (!firstError) firstError = error;
      }
    }
    if (firstError) throw firstError;
  }

  // ---------------------------------------------------------------------------
  // 设置文档与 revision
  // ---------------------------------------------------------------------------
  function adoptSettingsDocument(settings, { repaint = true, preserveDirty = true } = {}) {
    const document = requireSettingsDocument(settings);
    state.settings = document;
    const revision = String(document.settings_revision).trim();
    if (revision !== state.baseRevision) {
      state.revisionEpoch += 1;
      state.baseRevision = revision;
    }
    if (repaint) applySettingsToSections(document, { preserveDirty });
    if (!preserveDirty) state.drafts.clear();
    return true;
  }

  async function loadInitialSettingsDocument(loadSettings, options = {}) {
    const generation = state.generation;
    const result = await initializationGate.load(
      loadSettings,
      document => adoptSettingsDocument(document, options),
      { isCurrent: () => !state.destroyed && generation === state.generation },
    );
    if (!state.destroyed && generation === state.generation) {
      state.initializationFailed = result.ok !== true;
    }
    if (!result.ok) throw result.error || new Error('设置响应采用失败');
    return true;
  }

  // 供分区在“微信验证”等也会改设置的操作后合并返回的设置文档。
  function applySettingsPayload(settings, { revision = '' } = {}) {
    if (state.destroyed) return;
    if (settings && typeof settings === 'object') {
      adoptSettingsDocument(settings, { repaint: true, preserveDirty: true });
    }
    const clean = String(revision || '').trim();
    if (clean && clean !== state.baseRevision) {
      state.revisionEpoch += 1;
      state.baseRevision = clean;
    }
  }

  // ---------------------------------------------------------------------------
  // 通知条(别处更新)
  // ---------------------------------------------------------------------------
  let noticeBar = null;
  let noticeText = null;

  function ensureNoticeBar() {
    if (noticeBar) return noticeBar;
    noticeText = el('span', { class: 'alert-text' });
    const reloadBtn = el('button', {
      class: 'btn btn-primary btn-sm', type: 'button', text: '重新载入设置',
      onclick: () => { void confirmReloadDiscardingDrafts(reloadBtn); },
    });
    const saveAllBtn = el('button', {
      class: 'btn btn-ghost btn-sm', type: 'button', text: '保存全部草稿并刷新',
      onclick: () => { void saveAllDraftsThenReload(saveAllBtn); },
    });
    const dismissBtn = el('button', {
      class: 'btn btn-ghost btn-sm', type: 'button', text: '暂不',
      onclick: () => {
        state.staleDismissedRevision = state.staleObservedRevision || state.baseRevision;
        hideNotice();
      },
    });
    state.externalActions.register(reloadBtn, saveAllBtn);
    noticeBar = el('div', { class: 'alert-bar alert-warn settings-notice', hidden: true },
      el('span', { class: 'alert-icon', text: '⚠' }),
      noticeText,
      reloadBtn,
      saveAllBtn,
      dismissBtn,
    );
    return noticeBar;
  }

  async function confirmReloadDiscardingDrafts(trigger = null) {
    const generation = state.generation;
    const isCurrent = () => !state.destroyed && generation === state.generation;
    const shouldRestoreFocus = globalThis.document?.activeElement === trigger;
    if (!isCurrent()) return;
    if (hasUnsavedDrafts()) {
      const confirmed = await ui.confirmDialog({
        title: '放弃未保存的草稿',
        message: '重新载入会使用最新设置,并放弃本页所有未保存草稿。确定继续吗?',
        confirmLabel: '放弃草稿并刷新',
        danger: true,
      });
      if (!confirmed || !isCurrent()) return;
    }
    if (!isCurrent()) return;
    const refreshed = await refreshFromServer({ announce: true, trigger });
    if (refreshed && isCurrent()) scheduleStablePageFocus(shouldRestoreFocus, trigger);
  }

  async function saveAllDraftsThenReload(trigger = null) {
    const generation = state.generation;
    const isCurrent = () => !state.destroyed && generation === state.generation;
    const shouldRestoreFocus = globalThis.document?.activeElement === trigger;
    if (!isCurrent()) return;
    if (isBusy()) {
      ui.toastWarn('有操作正在进行,请等待完成后再试。');
      return;
    }
    for (const section of sections) {
      if (!isCurrent()) return;
      try {
        await section.saveDraft?.();
      } catch (error) {
        if (!isCurrent()) return;
        console.warn('保存草稿失败', section?.id, error);
      }
      if (!isCurrent()) return;
    }
    if (!isCurrent()) return;
    if (hasUnsavedDrafts()) {
      ui.toastWarn('仍有草稿未保存成功,请检查各分区的错误提示。');
      return;
    }
    const refreshed = await refreshFromServer({ announce: true, trigger });
    if (refreshed && isCurrent()) scheduleStablePageFocus(shouldRestoreFocus, trigger);
  }

  function showNotice(message) {
    ensureNoticeBar();
    noticeText.textContent = message;
    noticeBar.hidden = false;
  }

  function hideNotice() {
    if (noticeBar) noticeBar.hidden = true;
  }

  function markStale(observedRevision = '') {
    if (state.destroyed) return;
    const revision = String(observedRevision || '').trim();
    if (revision && revision === state.staleDismissedRevision) return;
    state.stale = true;
    state.staleObservedRevision = revision;
    const dirtyNote = hasUnsavedDrafts()
      ? '当前页面有未保存草稿,重新载入会放弃草稿。'
      : '可以重新载入以取得最新设置。';
    showNotice(`设置已在其他窗口或后台任务中更新。${dirtyNote}`);
  }

  // ---------------------------------------------------------------------------
  // 跨标签同步:别处保存 / 手动密钥运行时字段
  // ---------------------------------------------------------------------------
  const focusProbe = createLatestSettingsRevisionProbe({
    // 把请求开始时的快照代数带回 applyFresh。revision 是内容哈希，无法判断
    // 不同哈希的先后；owner 换代后必须丢弃旧响应，并用同一单飞探测重读。
    fetchFresh: async () => {
      const probe = { epoch: state.revisionEpoch };
      const settings = await api.get('/api/settings', { signal: pageAbort.signal, timeoutMs: 30_000 });
      return { __wxSettingsProbe: probe, settings };
    },
    applyFresh: async response => {
      const fresh = response?.settings && response?.__wxSettingsProbe ? response.settings : response;
      const probe = response?.__wxSettingsProbe || null;
      const document = requireSettingsDocument(fresh);
      const revision = String(document.settings_revision).trim();
      if (!revision || revision === state.baseRevision) return;
      if (isStaleSettingsProbeResponse({
        probe,
        currentEpoch: state.revisionEpoch,
      })) {
        void focusProbe.request();
        return;
      }
      if (!hasUnsavedDrafts()) {
        // 没有草稿时直接采用最新,避免无谓打扰。
        adoptSettingsDocument(document, { repaint: true, preserveDirty: false });
        state.stale = false;
        hideNotice();
        ui.toast('设置已同步为其他窗口保存的最新设置。', { type: 'info' });
      } else {
        markStale(revision);
      }
    },
    isActive: () => !state.destroyed,
    onError: error => {
      if (!state.destroyed && !isAbortError(error)) console.warn('设置版本探测失败', error);
    },
  });

  const manualKeySync = createLatestManualKeyRuntimeSync({
    getCurrent: () => state.settings,
    fetchFresh: () => api.get('/api/settings', { signal: pageAbort.signal, timeoutMs: 30_000 }),
    applyMerged: merged => {
      adoptSettingsDocument(merged, { repaint: true, preserveDirty: true });
    },
    isActive: () => !state.destroyed,
  });

  // 调度状态等响应里携带的 revision / scheduler_runtime_revision 都经由这里观察。
  function observeRuntimePayload(payload) {
    if (state.destroyed || !payload || typeof payload !== 'object') return;
    const revision = String(payload.settings_revision || payload.settings?.settings_revision || '').trim();
    if (revision
      && state.baseRevision
      && revision !== state.baseRevision) {
      if (!hasUnsavedDrafts()) {
        void focusProbe.request();
      } else {
        markStale(revision);
      }
    }
    try { manualKeySync.request(payload); } catch {}
  }

  // ---------------------------------------------------------------------------
  // 保存
  // ---------------------------------------------------------------------------
  function saveHasWarnings(result) {
    return Array.isArray(result?.warnings) && result.warnings.length > 0;
  }

  function saveSummaryText(result, fallback) {
    const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
    const messages = warnings
      .map(item => String(item?.message || '').trim())
      .filter(Boolean)
      .slice(0, 3);
    return messages.length ? `${fallback}${messages.join('；')}` : fallback;
  }

  async function refreshSavedAccountIdentity(queuedUpgrade) {
    if (state.destroyed) return;
    const handoff = queuedUpgrade?.result
      ? queuedUpgrade
      : { result: queuedUpgrade };
    const result = handoff.result;
    const token = beginAction('刷新账号身份');
    const accountContext = settingsRequestContext(store.get('account'));
    const ownerGeneration = state.generation;
    const previousIdentity = state.accountContext.identity();
    const nextIdentity = settingsAccountContextIdentity(result?.account);
    const refreshOwnerIsCurrent = () => {
      if (state.destroyed) return false;
      const generation = state.generation;
      const identity = state.accountContext.identity();
      return (generation === ownerGeneration && identity === previousIdentity)
        || (!!nextIdentity && generation === ownerGeneration + 1 && identity === nextIdentity);
    };
    const upgradedOwnerIsCurrent = () => !state.destroyed
      && !!nextIdentity
      && state.generation === ownerGeneration + 1
      && state.accountContext.identity() === nextIdentity;
    const notifyIncomplete = outcome => {
      try { handoff.onIncomplete?.(outcome); } catch (error) {
        console.warn('账号身份刷新失败回调异常', error);
      }
      ui.toastWarn(handoff.failureMessage
        || '设置已保存,但账号身份刷新尚未完成;请点击左下角刷新账号后再继续账号相关操作。');
    };
    try {
      const outcome = await refreshPublicAccountIdentityUpgrade(result, {
        accountId: accountContext?.account_id || '',
        fingerprint: accountContext?.expected_account_fingerprint || '',
        refreshAccounts: ctx.refreshAccounts,
        isCurrent: refreshOwnerIsCurrent,
      });
      if (!refreshOwnerIsCurrent() || outcome.status === 'stale') return;
      if (outcome.status === 'upgraded') {
        if (!upgradedOwnerIsCurrent()) return;
        let callbackApplied = true;
        try {
          callbackApplied = handoff.onUpgraded?.(outcome.account) !== false;
        } catch (error) {
          callbackApplied = false;
          console.warn('账号身份刷新成功回调异常', error);
        }
        if (!callbackApplied) {
          notifyIncomplete({ status: 'callback_failed', account: outcome.account });
          return;
        }
        ui.toast(handoff.successMessage || '当前微信账号身份已更新,已按新身份保存。', { type: 'info' });
        return;
      }
      notifyIncomplete(outcome);
    } catch (error) {
      if (!state.destroyed) notifyIncomplete({ status: 'refresh_failed', error });
    } finally {
      endAction(token);
    }
  }

  function adoptSaveResult(result, ownerToken = null) {
    if (state.destroyed || !result || typeof result !== 'object') return;
    if (result.settings) adoptSettingsDocument(result.settings, { repaint: true, preserveDirty: true });
    const revision = String(result.settings_revision || result.settings?.settings_revision || '').trim();
    if (revision && revision !== state.baseRevision) {
      state.revisionEpoch += 1;
      state.baseRevision = revision;
    }
    state.stale = false;
    state.staleDismissedRevision = '';
    hideNotice();
    for (const warning of (Array.isArray(result.warnings) ? result.warnings : []).slice(0, 3)) {
      const message = String(warning?.message || '').trim();
      if (message) ui.toastWarn(message, { duration: 8000 });
    }
    if (result.output_dir_changed === true) {
      ui.toast('输出目录已切换;进行中的摘要与后台检查已按新目录处理。', { type: 'info', duration: 6000 });
    }
    if (result.digest_runtime_changed === true) {
      ui.toast('摘要生成相关设置已更新,进行中的摘要任务已取消,请用新设置重新生成。', { type: 'info', duration: 6000 });
    }
    queueAccountIdentityUpgrade(result, ownerToken);
    // 确认落盘:若保存后又有更新,采用最新文档。
    const savedRevision = revision;
    if (savedRevision) {
      void confirmPersisted(savedRevision, state.revisionEpoch);
    }
  }

  async function confirmPersisted(savedRevision, ownerEpoch = state.revisionEpoch) {
    const generation = state.generation;
    try {
      const fresh = await api.get('/api/settings?wait_for_writes=1', {
        signal: pageAbort.signal,
        timeoutMs: 30_000,
      });
      if (state.destroyed
          || generation !== state.generation
          || ownerEpoch !== state.revisionEpoch) return;
      const freshRevision = String(fresh?.settings_revision || '').trim();
      if (freshRevision && freshRevision !== savedRevision) {
        adoptSettingsDocument(fresh, { repaint: true, preserveDirty: true });
        ui.toast('设置保存后又有新的更新,页面已同步为最新设置。', { type: 'info' });
      }
    } catch (error) {
      if (!isAbortError(error)) console.warn('设置落盘确认失败', error);
    }
  }

  async function saveSection(patch, { signal, ownerToken } = {}) {
    if (!ownerToken) throw new Error('saveSection 需要 action owner token');
    const ownerIsCurrent = () => alive(ownerToken);
    let result;
    try {
      result = await writeSettingsPatch({
        api,
        patch,
        signal,
        timeoutMs: 180_000,
        isCurrent: ownerIsCurrent,
        onLatest: latest => {
          if (!state.destroyed && ownerIsCurrent()) {
            adoptSettingsDocument(latest, { repaint: true, preserveDirty: true });
          }
        },
      });
    } catch (error) {
      if (ownerIsCurrent() && error?.status === 428 && error?.code === 'settings_revision_required') markStale();
      else if (ownerIsCurrent() && error?.status === 409) markStale(String(error?.payload?.current_settings_revision || ''));
      throw error;
    }
    if (ownerIsCurrent()) adoptSaveResult(result, ownerToken);
    return result;
  }

  async function refreshFromServer({ announce = false, trigger = null } = {}) {
    const token = beginAction('重新载入设置', trigger ? [trigger] : []);
    try {
      const fresh = await api.get('/api/settings?wait_for_writes=1', {
        signal: token.signal,
        timeoutMs: 30_000,
      });
      if (!alive(token)) return false;
      await loadInitialSettingsDocument(
        () => Promise.resolve(fresh),
        { repaint: true, preserveDirty: false },
      );
      state.stale = false;
      state.staleDismissedRevision = '';
      hideNotice();
      if (announce) ui.toastSuccess('已载入最新设置。');
      return true;
    } catch (error) {
      if (!alive(token) || isAbortError(error)) return false;
      ui.toastError(error?.message || '重新载入设置失败');
      return false;
    } finally {
      const owned = endAction(token);
      if (owned && !state.destroyed && trigger?.isConnected) {
        trigger.disabled = isBusy();
        restoreActionFocus(token.focusTarget, {
          activeElement: globalThis.document?.activeElement,
          body: globalThis.document?.body,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 分区与导航
  // ---------------------------------------------------------------------------
  const page = {
    api,
    ui,
    store,
    getSettings: () => state.settings,
    getBaseRevision: () => state.baseRevision,
    getState: () => store.get('state'),
    getAccount: () => store.get('account'),
    getAccounts: () => store.get('accounts', []),
    getOutputDirIdentity: () => String(store.get('state')?.output_dir_identity || '').trim(),
    requestContext: settingsRequestContext,
    refreshAccounts: ctx.refreshAccounts,
    isActive: () => !state.destroyed,
    isBusy,
    alive,
    softToken,
    beginAction,
    endAction,
    queueAccountIdentityUpgrade,
    saveSection,
    saveHasWarnings,
    saveSummaryText,
    applySettingsPayload,
    observeRuntimePayload,
    markStale,
    markDirty(sectionId, dirty) {
      state.drafts.markDirty(sectionId, dirty);
    },
    markAccountScopedDraft(sectionId, dirty) {
      state.drafts.markAccountScoped(sectionId, dirty);
    },
  };

  const sections = [
    createAiSection(page),
    createSchedulerSection(page),
    createOutputSection(page),
    createPrivacySection(page),
    createSystemSection(page),
    createAboutSection(page),
  ];

  const NAV_ITEMS = [
    { id: 'ai', label: 'AI 接入', keys: ['ai'] },
    { id: 'groups', label: '群与调度', keys: ['groups', 'scheduler'] },
    { id: 'output', label: '渲染与输出', keys: ['output'] },
    { id: 'privacy', label: '隐私与安全', keys: ['privacy'] },
    { id: 'system', label: '本机状态', keys: [] },
    { id: 'about', label: '关于', keys: [] },
  ];

  const navButtons = new Map();
  let currentSectionId = 'ai';

  function updateNavBadge(sectionId) {
    for (const item of NAV_ITEMS) {
      if (!item.keys.includes(sectionId)) continue;
      const btn = navButtons.get(item.id);
      if (!btn) continue;
      const dirty = item.keys.some(key => state.drafts.isDirty(key));
      btn.querySelector('.settings-nav-badge')?.remove();
      if (dirty) btn.append(el('span', { class: 'settings-nav-badge', title: '有未保存更改' }));
    }
  }

  function switchSection(id) {
    currentSectionId = id;
    for (const item of NAV_ITEMS) {
      setSegmentedButtonState(navButtons.get(item.id), item.id === id);
    }
    for (const section of sections) {
      section.el.hidden = section.id !== id;
    }
    // 设置分区共用路由内容滚动容器;切换分区时必须从新分区顶部开始浏览。
    root.scrollTop = 0;
    const active = sections.find(section => section.id === id);
    active?.onActivated?.();
  }

  // ---------------------------------------------------------------------------
  // DOM 骨架
  // ---------------------------------------------------------------------------
  root.replaceChildren();
  const layout = el('div', { class: 'settings-layout' });
  const nav = el('nav', { class: 'settings-nav card', 'aria-label': '设置分区' });
  function settingsNavItemFromFocusEvent(event) {
    const target = event?.target?.closest?.('.settings-nav-item');
    return target && nav.contains(target) ? target : null;
  }
  nav.addEventListener('focusin', event => {
    const target = settingsNavItemFromFocusEvent(event);
    if (!target) return;
    setTimeout(() => {
      if (state.destroyed || !nav.isConnected || document.activeElement !== target) return;
      scrollSettingsNavItemIntoView(nav, target);
    }, 0);
  });
  for (const item of NAV_ITEMS) {
    const btn = el('button', {
      class: 'settings-nav-item', type: 'button', text: item.label,
      onclick: () => activateSettingsNavItem(nav, btn, () => switchSection(item.id)),
    });
    navButtons.set(item.id, btn);
    nav.append(btn);
  }
  const main = el('div', { class: 'settings-main' });
  const pageTitle = el('h1', { class: 'settings-page-title', tabIndex: -1, text: '设置' });
  const recoveryNotice = el('div', {
    class: 'alert-bar alert-info settings-recovery-notice',
    hidden: true,
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'true',
  },
  el('span', { class: 'alert-icon', text: '•' }),
  el('span', { class: 'alert-text', text: '已核对上次未确认的设置写入,页面已同步最终状态。' }));
  function scheduleStablePageFocus(shouldRestore, owner) {
    const run = () => restoreSettingsTransientFocus({
      shouldRestore,
      owner,
      fallback: pageTitle,
      activeElement: globalThis.document?.activeElement,
      body: globalThis.document?.body,
      isActive: () => !state.destroyed,
    });
    (globalThis.requestAnimationFrame || (callback => setTimeout(callback, 0)))(run);
  }
  main.append(pageTitle);
  main.append(recoveryNotice);
  main.append(ensureNoticeBar());
  for (const section of sections) {
    section.el.hidden = section.id !== currentSectionId;
    main.append(section.el);
  }
  const loading = el('div', { class: 'card card-pad' },
    el('div', { class: 'skeleton-list' },
      el('div', { class: 'skeleton-row' }),
      el('div', { class: 'skeleton-row' }),
      el('div', { class: 'skeleton-row' })));
  main.append(loading);
  layout.append(nav, main);
  root.append(layout);
  associateFormLabels(root, { prefix: 'settings' });
  switchSection(currentSectionId);

  let schedulerStarted = false;
  function startSchedulerPolling() {
    if (schedulerStarted || state.destroyed) return;
    schedulerStarted = true;
    const schedulerSection = sections.find(section => section.id === 'groups');
    void schedulerSection?.pollSchedulerStatus?.();
    const poll = async () => {
      if (state.destroyed) return;
      await schedulerSection?.pollSchedulerStatus?.();
      if (!state.destroyed) state.pollTimer = setTimeout(poll, SCHEDULER_POLL_MS);
    };
    state.pollTimer = setTimeout(poll, SCHEDULER_POLL_MS);
  }

  function renderInitializationFailure(error) {
    if (state.destroyed) return;
    state.initializationFailed = true;
    const retry = el('button', {
      class: 'btn btn-primary', type: 'button', text: '重试',
      onclick: async () => {
        const shouldRestoreFocus = globalThis.document?.activeElement === retry;
        const ok = await refreshFromServer({ announce: false, trigger: retry });
        if (!ok || state.destroyed) return;
        loading.remove();
        startSchedulerPolling();
        scheduleStablePageFocus(shouldRestoreFocus, retry);
      },
    });
    loading.replaceChildren(el('div', { class: 'empty-state' },
      el('span', { class: 'empty-icon', text: '⚠' }),
      el('p', { text: `设置读取失败:${error?.message || '未知错误'}` }),
      retry));
  }

  const initializationLifecycle = createSettingsInitializationLifecycle({
    getGeneration: () => state.generation,
    isActive: () => !state.destroyed,
    async run(generation) {
      const recovered = await restorePendingSettingsMutationRecovery({
        api,
        signal: pageAbort.signal,
      });
      if (state.destroyed || generation !== state.generation) return { stale: true };
      const loadSettings = recovered.settings
        ? () => Promise.resolve(recovered.settings)
        : () => api.get('/api/settings?wait_for_writes=1', {
          signal: pageAbort.signal,
          timeoutMs: 60_000,
        });
      await loadInitialSettingsDocument(loadSettings, { repaint: true, preserveDirty: false });
      if (state.destroyed || generation !== state.generation) return { stale: true };
      return { recovered };
    },
    onSuccess({ recovered }) {
      if (state.destroyed) return;
      loading.remove();
      if (recovered?.cleared) recoveryNotice.hidden = false;
    },
    onFailure: renderInitializationFailure,
  });

  // ---------------------------------------------------------------------------
  // 初始化
  // ---------------------------------------------------------------------------
  page.init = async () => {
    try {
      const result = await initializationLifecycle.start();
      if (result.ok === true && !state.destroyed) startSchedulerPolling();
    } finally {
      if (!state.destroyed) state.initializing = false;
    }
  };

  store.set('accountSwitchGuard', accountSwitchGuard);

  state.unsubscribeAccount = store.subscribe('account', (account, previous) => {
    if (state.destroyed) return;
    const change = state.accountContext.update(account);
    if (!change.changed) return;
    // 这两个同步器共享页面级 signal,不能依赖 abort 识别账号换代;
    // 先切断独立后台请求,否则旧账号响应可能在新账号页采用。
    focusProbe.invalidate?.();
    manualKeySync.invalidate?.();
    invalidateSettingsActionsForAccountChange(state, '账号上下文已变化', {
      onActionsReleased: syncBusy,
    });
    notifySettingsSectionsAccountChanged(sections, account, previous, change);
  });

  state.unsubscribeState = store.subscribe('state', (nextState) => {
    if (state.destroyed) return;
    notifySettingsSectionsStateChanged(sections, nextState);
  });

  const onFocus = () => {
    if (state.destroyed || document.visibilityState !== 'visible') return;
    void focusProbe.request();
  };
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onFocus);

  page.confirmLeave = async () => {
    if (state.destroyed) return true;
    if (isBusy()) {
      return ui.confirmDialog({
        title: '操作进行中',
        message: '有操作正在进行(保存 / 验证 / 检查)。离开设置页会取消这些操作,结果可能未知。确定离开吗?',
        confirmLabel: '取消操作并离开',
        danger: true,
      });
    }
    if (hasUnsavedDrafts()) {
      return ui.confirmDialog({
        title: '有未保存的更改',
        message: '设置草稿尚未保存,离开后将被放弃。确定离开设置页吗?',
        confirmLabel: '放弃并离开',
        danger: true,
      });
    }
    return true;
  };

  page.destroy = async () => {
    if (state.destroyed) return;
    state.destroyed = true;
    state.initializing = false;
    state.generation += 1;
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = null;
    for (const action of [...state.actions]) {
      try { action.controller.abort(new Error('已离开设置页,操作已取消')); } catch {}
    }
    state.actions.clear();
    state.drafts.clear({ notify: false });
    state.externalActions.clear();
    for (const section of sections) {
      try { section.destroy?.(); } catch {}
    }
    if (!pageAbort.signal.aborted) pageAbort.abort(new Error('已离开设置页'));
    try { initializationLifecycle.dispose(); } catch {}
    try { focusProbe.dispose(); } catch {}
    try { manualKeySync.dispose(); } catch {}
    try { state.unsubscribeAccount?.(); } catch {}
    try { state.unsubscribeState?.(); } catch {}
    if (store.get('accountSwitchGuard') === accountSwitchGuard) {
      store.set('accountSwitchGuard', null);
    }
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onFocus);
  };

  return page;
}
