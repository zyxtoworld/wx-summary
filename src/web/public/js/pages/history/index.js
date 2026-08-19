// 历史页:搜索/分段筛选 → 卡片网格 → 详情弹层。
// 所有写操作走 local_action 语义(见 actions.js);超时/断连一律"结果未知",提供"查询结果"入口。
import { isMutationOutcomeUnknown } from '/js/api.js';
import { digestMarkdownForDigests } from '/js/shared/digest-view-model.js';
import {
  browserDownloadCapability,
  browserDownloadUnsupportedMessage,
} from '/js/shared/browser-download-capability.js';
import { currentResolvedTheme } from '../../theme.js';
import { historyStorageKeys } from './storage.js';
import {
  createHistoryViewStateStorage,
  findHistoryFocusTarget,
  historyInitialFocusCanRestore,
  historyListFocusSnapshot,
  restoreHistoryPaginationFocus,
  restoreHistoryRetryFocus,
  restoreHistoryListFocus,
} from './view-state.js';
import { createHistoryActions } from './actions.js';
import {
  RERENDER_PREVIEW_EXPECTED_WIDTH,
  accountIdOf,
  blockingIssueLabel,
  copyToCurrentOutputEligible,
  deleteCheck,
  el,
  formatCount,
  formatDateTime,
  historyItemStableKey,
  isMarkdownItem,
  itemBadges,
  itemRerenderFileVersion,
  markdownSourceCheck,
  markdownRecoveryInstruction,
  markdownSourceReferenceAvailable,
  mdFileActionCheck,
  pngFileActionCheck,
  rerenderCheck,
  exportMarkdownCheck,
  restoreToCurrentOutputEligible,
} from './format.js';
import {
  digestFilePath,
  digestThumbPath,
  historyDigestPath,
  historyItemStatusPath,
  historyMarkdownSourcePath,
  outputFilePath,
} from './paths.js';
import { canvasToValidatedPngBytes, renderHistoryDigestCanvas } from './rerender.js';
import { createHistoryReturnRevalidator } from './revalidation.js';
import { revalidateHistoryActionTarget } from './action-guard.js';
import { historyActionResultTarget } from './action-target.js';
import { createHistoryThumbnailQueue } from './thumbnail-queue.js';
import {
  HISTORY_AUTO_DISCOVERY_PASS_LIMIT,
  shouldQueueHistoryAutoDiscovery,
} from './auto-discovery.js';
import { createZoomRegion } from '/js/shared/zoom-region.js';
import { makeScrollableRegion } from '/js/shared/scroll-region.js';
import { captureActionFocus, restoreActionFocus } from '/js/shared/action-focus.js';
import { createHistoryZoomToggle } from './zoom-toggle.js';
import {
  captureHistoryDetailActionFocus,
  restoreHistoryDetailActionFocus,
  setHistoryDetailActionBusy,
} from './detail-action-focus.js';
import { revealHistoryDetailStatus } from './detail-status.js';
import {
  classifyHistoryEvidence,
  createHistoryEvidenceLifecycle,
} from './evidence-settlement.js';
import {
  historyAccountSwitchBlockedMessage,
  historyActionResultAppliesToView,
  createHistoryAccountContextTracker,
} from './account-switch.js';
import {
  invalidateHistoryDetailForDeletedItem,
  queueHistoryCrossTabItemRefresh,
} from './cross-tab.js';
import { createHistoryStatusRefreshController } from './status-refresh.js';
import { setSegmentedButtonState } from '../../ui/segmented.js';
import { createScopedUi } from '../../ui/lifecycle.js';
import {
  historyItemMatchesFilter,
  historyListStatusTransition,
  requireHistoryListItems,
} from './list-state.js';

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 350;
const PNG_FETCH_MAX_BYTES = 88 * 1024 * 1024;
const THUMB_FETCH_MAX_BYTES = 32 * 1024 * 1024;
const MD_FETCH_MAX_BYTES = 3 * 1024 * 1024;
const THUMB_CONCURRENCY = 3;
const RERENDER_HTTP_TIMEOUT_MS = 180 * 1000;
const HISTORY_STORAGE_KEYS = historyStorageKeys(location.origin);
const CROSS_TAB_KEY = HISTORY_STORAGE_KEYS.itemUpdated;

const FILTER_OPTIONS = Object.freeze([
  ['ok', '正常'],
  ['issues', '问题项'],
  ['all', '全部'],
]);
const ACCOUNT_OPTIONS = Object.freeze([
  ['current', '当前账号'],
  ['all', '全部'],
]);

// 当前页面实例(模块被 router 缓存,同一时刻只挂载一次)。
let activePage = null;

export default {
  title: '历史',
  css: '/css/history.css',

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
    if (!activePage || !activePage.isBusy()) return true;
    return activePage.confirmLeaveWhileBusy();
  },
};

function buildPage(root, ctx) {
  const { api, store, ui: baseUi, navigate } = ctx;
  const pageAbort = new AbortController();
  const ui = createScopedUi(baseUi, pageAbort.signal);
  const goToDigest = () => {
    if (typeof navigate === 'function') navigate('#/digest');
    else location.hash = '#/digest';
  };
  const actions = createHistoryActions({ api, store });
  const viewStateStorage = createHistoryViewStateStorage({ storage: localStorage, keys: HISTORY_STORAGE_KEYS });

  // -------------------------------------------------------------------------
  // 页面状态
  // -------------------------------------------------------------------------
  const page = {
    destroyed: false,
    generation: 0,
    items: [],
    status: 'idle', // idle | loading | error | ready
    errorText: '',
    warnings: [],
    incompleteReasons: [],
    autoDiscoveryPasses: 0,
    total: 0,
    totalExact: true,
    okTotal: 0,
    issueTotal: 0,
    q: '',
    filter: 'ok',
    accountScope: 'current',
    focusKey: '',
    focusAction: '',
    nextCursor: '',
    nextSearchCursor: '',
    hasMore: false,
    searchScanHasMore: false,
    loadingMore: false,
    moreController: null,
    listController: null,
    listSeq: 0, // 列表请求序号:loadFirstPage 递增,使在途 loadMore/旧请求失效
    thumbController: new AbortController(),
    thumbs: new Map(), // key -> { status: 'loading'|'ready'|'error'|'missing', url, stamp }
    crossTabRefreshes: new Map(), // history item key -> AbortController
    crossTabReloadTimer: null,
    autoDiscoveryTimer: null,
    detail: null, // { item, modal, statusEl, bodySlot, actionsSlot, busy, invalidated, pendingTimers, controller, revalidator }
    modals: new Set(), // 页面打开的弹层(modal-root 不随路由清空,destroy 时统一关闭)
    pendingRerender: 0, // 重渲染提交在途计数(弹层独立于详情,离开守卫需要感知)
    searchTimer: null,
    unsubscribers: [],
    accountId: accountIdOf(store.get('account')),
    accountContext: createHistoryAccountContextTracker(store.get('account')),
  };

  const alive = token => !page.destroyed && token === page.generation;
  const accountSwitchGuard = () => historyAccountSwitchBlockedMessage({
    destroyed: page.destroyed,
    detailBusy: page.detail?.busy === true,
    pendingRerender: page.pendingRerender,
  });
  const itemKey = item => historyItemStableKey(item)
    || `${String(item?.digest_id || '')}:${String(item?.created_at || '')}:${String(item?.relative_path || '')}`;
  const accountFingerprintOf = account => String(account?.manual_key_account_fingerprint || '').trim().toLowerCase();
  const actionAccountIdForItem = item => accountIdOf(item)
    || (page.accountScope === 'current' ? page.accountId : '');
  const actionAccountFingerprintForItem = item => page.accountScope === 'current'
    ? accountFingerprintOf(store.get('account'))
    : String(item?.account_fingerprint || '').trim().toLowerCase();
  const actionResultStillApplies = (actionAccountId, actionAccountFingerprint) => historyActionResultAppliesToView({
    accountScope: page.accountScope,
    currentAccountId: page.accountId,
    currentAccountFingerprint: accountFingerprintOf(store.get('account')),
    actionAccountId,
    actionAccountFingerprint,
  });

  // 弹层统一登记:路由切换/unmount 时全部关闭,避免残留并中断其异步流程。
  function openPageModal(options = {}) {
    const modal = ui.openModal({
      ...options,
      onClose: () => {
        page.modals.delete(entry);
        try { options.onClose?.(); } catch (error) {
          console.error('page modal close callback failed', error);
        }
      },
    });
    const entry = { modal };
    page.modals.add(entry);
    return modal;
  }

  function closeAllModals({ restoreFocus = true } = {}) {
    for (const entry of [...page.modals]) {
      try { entry.modal.close({ restoreFocus }); } catch {}
    }
    page.modals.clear();
  }

  // -------------------------------------------------------------------------
  // 视图状态与焦点身份使用同一个当前键。
  // -------------------------------------------------------------------------
  function restoreViewPrefs() {
    const prefs = viewStateStorage.read();
    if (!prefs) return;
    page.filter = prefs.filter;
    page.accountScope = prefs.accountScope;
    page.q = prefs.q;
    page.focusKey = prefs.focusKey;
    page.focusAction = prefs.focusAction;
  }

  function saveViewPrefs({ captureFocus = false } = {}) {
    if (captureFocus) {
      const snapshot = historyListFocusSnapshot(grid);
      if (snapshot) {
        page.focusKey = snapshot.focusKey;
        page.focusAction = snapshot.focusAction;
      }
    }
    viewStateStorage.write({
      filter: page.filter,
      accountScope: page.accountScope,
      q: page.q,
      focusKey: page.focusKey,
      focusAction: page.focusAction,
    });
  }

  // -------------------------------------------------------------------------
  // DOM 骨架
  // -------------------------------------------------------------------------
  root.replaceChildren();
  const wrap = el('div', 'history-page');
  const pageTitle = el('h1', 'history-page-title', '历史');
  pageTitle.tabIndex = -1;

  const toolbar = el('section', 'card history-toolbar');
  const searchInput = document.createElement('input');
  searchInput.className = 'input history-search';
  searchInput.type = 'search';
  searchInput.placeholder = '搜索群名 / 摘要内容';
  searchInput.setAttribute('aria-label', '搜索历史');
  searchInput.value = '';

  const filterSegmented = el('div', 'segmented');
  filterSegmented.setAttribute('role', 'group');
  filterSegmented.setAttribute('aria-label', '状态筛选');
  for (const [value, label] of FILTER_OPTIONS) {
    const btn = el('button', 'segmented-btn', label);
    btn.type = 'button';
    btn.dataset.filterValue = value;
    filterSegmented.appendChild(btn);
  }

  const accountSegmented = el('div', 'segmented');
  accountSegmented.setAttribute('role', 'group');
  accountSegmented.setAttribute('aria-label', '账号范围');
  for (const [value, label] of ACCOUNT_OPTIONS) {
    const btn = el('button', 'segmented-btn', label);
    btn.type = 'button';
    btn.dataset.accountValue = value;
    accountSegmented.appendChild(btn);
  }

  const refreshBtn = el('button', 'btn btn-ghost', '刷新');
  refreshBtn.type = 'button';
  refreshBtn.title = '绕过缓存重新读取历史目录';

  toolbar.append(searchInput, filterSegmented, accountSegmented, refreshBtn);

  const alertSlot = el('div', 'history-alerts');
  const summaryEl = el('p', 'history-summary muted');
  const grid = el('div', 'history-grid');
  const moreWrap = el('div', 'history-more');
  const moreBtn = el('button', 'btn btn-ghost', '加载更多');
  moreBtn.type = 'button';
  const moreStatus = el('span', 'history-more-status muted');
  moreWrap.append(moreBtn, moreStatus);

  wrap.append(pageTitle, toolbar, alertSlot, summaryEl, grid, moreWrap);
  root.appendChild(wrap);

  const thumbnailQueue = createHistoryThumbnailQueue({
    concurrency: THUMB_CONCURRENCY,
    root: grid,
    load: async (key, { isCurrent }) => {
      const item = page.items.find(entry => itemKey(entry) === key);
      if (!item) return;
      await loadThumb(item, isCurrent);
    },
  });

  // -------------------------------------------------------------------------
  // 列表数据
  // -------------------------------------------------------------------------
  function clearAutoDiscoveryTimer() {
    if (page.autoDiscoveryTimer === null) return;
    clearTimeout(page.autoDiscoveryTimer);
    page.autoDiscoveryTimer = null;
  }

  function historyListPath({ cursor = '', searchCursor = '', refresh = false } = {}) {
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    if (searchCursor) params.set('search_cursor', searchCursor);
    else if (cursor) params.set('cursor', cursor);
    else params.set('offset', '0');
    if (page.q) params.set('q', page.q);
    params.set('filter', page.filter);
    if (page.accountScope === 'current') {
      const accountId = accountIdOf(store.get('account'));
      if (accountId) params.set('account_id', accountId);
    }
    if (refresh) params.set('refresh', 'true');
    return `/api/history?${params.toString()}`;
  }

  function clearThumbCache() {
    page.thumbController.abort();
    page.thumbController = new AbortController();
    thumbnailQueue.clear();
    for (const state of page.thumbs.values()) {
      if (state?.url) {
        try { URL.revokeObjectURL(state.url); } catch {}
      }
    }
    page.thumbs.clear();
  }

  function dropThumb(item) {
    const key = itemKey(item);
    thumbnailQueue.cancel(key);
    const state = page.thumbs.get(key);
    if (state?.url) {
      try { URL.revokeObjectURL(state.url); } catch {}
    }
    page.thumbs.delete(key);
  }

  function applyListPage(payload, { reset }) {
    const items = requireHistoryListItems(payload);
    if (reset) {
      page.items = items.slice();
      clearThumbCache();
    } else {
      const seen = new Set(page.items.map(item => itemKey(item)));
      for (const item of items) {
        const key = itemKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        page.items.push(item);
      }
    }
    page.total = Math.max(0, Number(payload?.total ?? page.items.length) || 0);
    page.totalExact = payload?.total_exact === true;
    page.okTotal = Math.max(0, Number(payload?.ok_total || 0) || 0);
    page.issueTotal = Math.max(0, Number(payload?.issue_total || 0) || 0);
    page.hasMore = payload?.has_more === true && !!String(payload?.next_cursor || '').trim();
    page.nextCursor = String(payload?.next_cursor || '').trim();
    page.searchScanHasMore = payload?.search_scan_has_more === true && !!String(payload?.next_search_cursor || '').trim();
    page.nextSearchCursor = String(payload?.next_search_cursor || '').trim();
    page.warnings = Array.isArray(payload?.warnings) ? payload.warnings : [];
    page.incompleteReasons = Array.isArray(payload?.incomplete_reasons) ? payload.incomplete_reasons : [];
  }

  async function loadFirstPage({ refresh = false, clearItems = false, autoDiscovery = false } = {}) {
    // listSeq 使并发的 loadMore / 上一次 loadFirstPage 立即失效。
    clearAutoDiscoveryTimer();
    if (page.crossTabReloadTimer !== null) {
      clearTimeout(page.crossTabReloadTimer);
      page.crossTabReloadTimer = null;
    }
    abortCrossTabListItemRefreshes();
    const seq = ++page.listSeq;
    const valid = () => !page.destroyed && seq === page.listSeq;
    if (page.listController) page.listController.abort();
    if (page.moreController) page.moreController.abort();
    page.moreController = null;
    page.loadingMore = false;
    const controller = new AbortController();
    page.listController = controller;
    if (clearItems) {
      page.items = [];
      clearThumbCache();
    }
    if (!autoDiscovery) page.autoDiscoveryPasses = 0;
    page.status = 'loading';
    page.errorText = '';
    refreshBtn.disabled = true;
    renderAll();
    try {
      const payload = await api.get(historyListPath({ refresh }), {
        signal: controller.signal,
        timeoutMs: 300000,
        maxBytes: 64 * 1024 * 1024,
      });
      if (!valid() || controller.signal.aborted) return false;
      applyListPage(payload, { reset: true });
      page.status = 'ready';
      renderAll();
      if (shouldQueueHistoryAutoDiscovery({
        items: page.items,
        incompleteReasons: page.incompleteReasons,
        pass: page.autoDiscoveryPasses,
        limit: HISTORY_AUTO_DISCOVERY_PASS_LIMIT,
      })) {
        page.autoDiscoveryPasses += 1;
        const timer = setTimeout(() => {
          if (page.autoDiscoveryTimer !== timer) return;
          page.autoDiscoveryTimer = null;
          if (!page.destroyed && seq === page.listSeq) {
            void loadFirstPage({ refresh: true, autoDiscovery: true });
          }
        }, 0);
        page.autoDiscoveryTimer = timer;
      }
      return true;
    } catch (error) {
      if (!valid() || error?.name === 'AbortError' || controller.signal.aborted) return false;
      page.status = 'error';
      page.errorText = error?.message || '历史列表读取失败';
      renderAll();
      return false;
    } finally {
      if (page.listController === controller) {
        page.listController = null;
        if (!page.destroyed) {
          refreshBtn.disabled = false;
        }
      }
    }
  }

  async function loadMore() {
    if (page.loadingMore || page.status !== 'ready') return false;
    const useSearchCursor = page.searchScanHasMore && page.nextSearchCursor;
    const useCursor = !useSearchCursor && page.hasMore && page.nextCursor;
    if (!useSearchCursor && !useCursor) return false;
    clearAutoDiscoveryTimer();
    const seq = page.listSeq;
    const valid = () => !page.destroyed && seq === page.listSeq;
    const controller = new AbortController();
    const focusTarget = captureActionFocus([moreBtn], globalThis.document?.activeElement);
    const firstNewIndex = page.items.length;
    page.loadingMore = true;
    page.moreController = controller;
    renderMore();
    try {
      const payload = await api.get(historyListPath(
        useSearchCursor ? { searchCursor: page.nextSearchCursor } : { cursor: page.nextCursor },
      ), { signal: controller.signal, timeoutMs: 300000, maxBytes: 64 * 1024 * 1024 });
      if (!valid()) return false;
      applyListPage(payload, { reset: false });
      renderAll();
      return true;
    } catch (error) {
      if (!valid() || error?.name === 'AbortError' || controller.signal.aborted) return false;
      moreStatus.textContent = `加载失败:${error?.message || '未知错误'}`;
      ui.toastError(error?.message || '加载更多失败');
      return false;
    } finally {
      if (page.moreController === controller) {
        page.moreController = null;
        page.loadingMore = false;
        if (!page.destroyed) {
          renderMore();
          if (focusTarget) {
            const schedule = globalThis.requestAnimationFrame || (callback => setTimeout(callback, 0));
            schedule(() => {
              if (page.destroyed || seq !== page.listSeq) return;
              restoreHistoryPaginationFocus({
                trigger: focusTarget,
                container: grid,
                firstNewIndex,
                focusHeading: () => pageTitle.focus({ preventScroll: true }),
              });
            });
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 渲染:警示 / 摘要 / 网格 / 加载更多
  // -------------------------------------------------------------------------
  const incompleteReasonLabels = Object.freeze({
    history_base_scan_limited: '历史目录扫描达到安全上限，列表可能不完整，请刷新后重试。',
    history_base_visit_limited: '历史目录访问达到安全上限，列表可能不完整，请刷新后重试。',
    history_base_unreadable: '部分历史目录无法读取，相关记录可能未显示。',
    history_discovery_unreadable: '部分历史来源无法读取，相关记录可能未显示。',
    history_search_scan_pending: '历史搜索仍在扫描，当前结果和总数可能暂不完整；可继续加载更多。',
    history_search_index_bounded: '部分历史记录的搜索索引只覆盖正文前段，关键词搜索可能漏检。',
    history_search_index_repair_incomplete: '部分历史记录的搜索索引无法从摘要文件修复，搜索结果可能不完整；可打开记录查看文件状态。',
  });

  function warningText(entry) {
    if (typeof entry === 'string') {
      const code = entry.trim();
      if (incompleteReasonLabels[code]) return incompleteReasonLabels[code];
      return /^history_[a-z0-9_]+$/i.test(code)
        ? '历史数据检查未完成，搜索结果可能不完整，请刷新后重试。'
        : code;
    }
    return String(entry?.message || entry?.code || '').trim();
  }

  function renderAlerts() {
    alertSlot.replaceChildren();
    const refreshFailure = page.status === 'error' && page.items.length
      ? `历史列表刷新失败：${page.errorText || '未知错误'}。当前显示上次加载结果，可点击“刷新”重试。`
      : '';
    const texts = [
      refreshFailure,
      ...page.warnings.map(warningText),
      ...page.incompleteReasons.map(warningText),
    ].filter(Boolean);
    for (const text of [...new Set(texts)].slice(0, 3)) {
      const bar = el('div', 'alert-bar alert-warn');
      bar.append(el('span', 'alert-icon', '⚠'), el('span', 'alert-text', text));
      alertSlot.appendChild(bar);
    }
  }

  function renderSummary() {
    if (page.status === 'loading' && !page.items.length) {
      summaryEl.textContent = '';
      return;
    }
    const bits = [];
    bits.push(page.totalExact ? `共 ${page.total} 条` : `已加载 ${page.items.length} 条(总数至少 ${page.total})`);
    if (page.filter !== 'ok') bits.push(`正常 ${page.okTotal} · 问题 ${page.issueTotal}`);
    if (page.searchScanHasMore) bits.push('搜索仍在扫描,可继续加载更多');
    if (page.q) bits.push(`搜索:「${page.q}」`);
    summaryEl.textContent = bits.join(' · ');
  }

  function renderMore() {
    const canMore = page.status === 'ready' && (page.searchScanHasMore ? !!page.nextSearchCursor : page.hasMore);
    moreBtn.hidden = !canMore;
    moreBtn.disabled = page.loadingMore || searchDraftPending();
    moreBtn.textContent = page.loadingMore
      ? '正在加载…'
      : (page.searchScanHasMore ? '继续扫描并加载更多' : '加载更多');
    if (searchDraftPending()) {
      moreStatus.textContent = '搜索条件正在等待应用';
    } else if (page.status === 'ready' && !canMore && page.items.length) {
      moreStatus.textContent = '已加载全部';
    } else if (!page.loadingMore && moreStatus.textContent.startsWith('加载失败')) {
      // 保留错误文本,等下一次操作覆盖
    } else if (!page.loadingMore) {
      moreStatus.textContent = '';
    }
  }

  function renderAll() {
    renderAlerts();
    renderSummary();
    renderGrid();
    renderMore();
  }

  function renderGrid() {
    grid.replaceChildren();
    if (page.status === 'loading' && !page.items.length) {
      const skeleton = el('div', 'history-grid-skeleton');
      for (let i = 0; i < 6; i += 1) {
        const card = el('div', 'history-skeleton-card');
        card.append(el('div', 'skeleton-row history-skeleton-thumb'), el('div', 'skeleton-row'), el('div', 'skeleton-row short'));
        skeleton.appendChild(card);
      }
      grid.appendChild(skeleton);
      return;
    }
    if (page.status === 'error' && !page.items.length) {
      const box = el('div', 'empty-state');
      box.append(el('div', 'empty-icon', '⚠'), el('p', '', page.errorText || '历史列表读取失败'));
      const retry = el('button', 'btn btn-ghost btn-sm', '重试');
      retry.type = 'button';
      retry.addEventListener('click', () => {
        const retryWasFocused = globalThis.document?.activeElement === retry;
        void (async () => {
          const loaded = await loadFirstPage();
          if (!loaded) return;
          const loadedSeq = page.listSeq;
          const schedule = globalThis.requestAnimationFrame || (callback => setTimeout(callback, 0));
          schedule(() => {
            if (page.destroyed || loadedSeq !== page.listSeq) return;
            restoreHistoryRetryFocus({
              shouldRestore: retryWasFocused,
              container: grid,
              focusHeading: () => pageTitle.focus({ preventScroll: true }),
            });
          });
        })();
      });
      box.appendChild(retry);
      grid.appendChild(box);
      return;
    }
    if (!page.items.length) {
      const box = el('div', 'empty-state');
      const hint = page.q
        ? '没有匹配搜索的历史记录。'
        : (page.filter === 'issues' ? '没有问题项,一切正常。' : '还没有历史记录。先到「总结」页生成并保存长图。');
      box.append(el('div', 'empty-icon', '🗂'), el('p', '', hint));
      grid.appendChild(box);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const item of page.items) fragment.appendChild(buildCard(item));
    grid.appendChild(fragment);
    thumbnailQueue.refresh();
  }

  // -------------------------------------------------------------------------
  // 卡片
  // -------------------------------------------------------------------------
  function badgeRow(item, badgesSlot) {
    badgesSlot.replaceChildren();
    for (const badge of itemBadges(item)) {
      badgesSlot.appendChild(el('span', `history-badge history-badge-${badge.tone}`, badge.label));
    }
  }

  function buildCard(item) {
    const key = itemKey(item);
    const card = el('article', 'history-card');
    card.dataset.key = key;
    const openBtn = el('button', 'history-card-open');
    openBtn.type = 'button';
    openBtn.dataset.historyFocusKey = key;
    openBtn.dataset.historyFocusAction = 'card';
    openBtn.setAttribute('aria-label', `查看 ${item.group || '历史记录'} 详情`);
    openBtn.addEventListener('click', () => {
      openBtn.focus({ preventScroll: true });
      openDetail(item);
    });

    const thumb = el('div', 'history-thumb');
    renderThumbInto(thumb, item);
    const body = el('div', 'history-card-body');
    const title = el('h3', 'history-card-title', item.group || item.group_id || '(未命名群)');
    title.title = item.group || '';
    const meta = el('p', 'history-card-meta muted',
      [item.since || '', item.until ? `~ ${item.until}` : ''].filter(Boolean).join(' ')
      + (formatCount(item.message_count) ? ` · ${formatCount(item.message_count)} 条消息` : ''));
    const subBits = [];
    if (item.model) subBits.push(String(item.model));
    if (formatDateTime(item.created_at)) subBits.push(formatDateTime(item.created_at));
    if (page.accountScope === 'all' && item.account_label) subBits.push(String(item.account_label));
    if (isMarkdownItem(item)) subBits.push('MD 导出');
    const sub = el('p', 'history-card-sub muted', subBits.join(' · '));
    const badges = el('div', 'history-badges');
    badgeRow(item, badges);
    body.append(title, meta, sub, badges);

    const related = item.related_markdown_export && typeof item.related_markdown_export === 'object'
      ? item.related_markdown_export
      : null;
    if (related && !isMarkdownItem(item)) {
      const chip = el('button', 'history-related-chip', '已导出 MD');
      chip.type = 'button';
      chip.title = '查看关联的 MD 导出记录';
      chip.dataset.historyFocusKey = key;
      chip.dataset.historyFocusAction = 'related-markdown';
      chip.addEventListener('click', () => {
        chip.focus({ preventScroll: true });
        openDetail(related, { focusKey: key, focusAction: 'related-markdown' });
      });
      body.appendChild(chip);
    }
    if (isMarkdownItem(item)
      && (item.history_commit_failed === true
        || (item.file_exists === false && !markdownSourceReferenceAvailable(item)))) {
      const committedUnbound = item.history_commit_failed === true;
      const recover = el('button', 'history-related-chip', committedUnbound ? '去设置页核对输出' : '去总结页重生成');
      recover.type = 'button';
      recover.title = markdownRecoveryInstruction(item);
      recover.addEventListener('click', () => {
        closeDetail();
        if (committedUnbound) {
          if (typeof navigate === 'function') navigate('#/settings');
          else location.hash = '#/settings';
        } else goToDigest();
      });
      body.appendChild(recover);
    }

    card.append(openBtn, thumb, body);
    return card;
  }

  // -------------------------------------------------------------------------
  // 缩略图(带鉴权 fetch → objectURL;失败显示占位)
  // -------------------------------------------------------------------------
  // 缩略图缓存以 记录key+内容戳(rerendered_at/created_at) 判定:重渲染后同 key 新图会重新拉取。
  function thumbStamp(item) {
    return String(item?.rerendered_at || item?.created_at || item?.relative_path || item?.digest_id || '');
  }

  function thumbState(item) {
    const state = page.thumbs.get(itemKey(item));
    return state && state.stamp === thumbStamp(item) ? state : null;
  }

  function renderThumbInto(slot, item) {
    slot.replaceChildren();
    if (isMarkdownItem(item)) {
      const placeholder = el('div', 'history-thumb-placeholder history-thumb-md', 'MD');
      slot.appendChild(placeholder);
      return;
    }
    if (item.file_exists === false) {
      slot.appendChild(el('div', 'history-thumb-placeholder', '文件缺失'));
      return;
    }
    const state = thumbState(item);
    if (state?.status === 'ready' && state.url) {
      const img = document.createElement('img');
      img.className = 'history-thumb-img';
      img.alt = `${item.group || '历史'} 缩略图`;
      img.loading = 'lazy';
      img.src = state.url;
      slot.appendChild(img);
      return;
    }
    if (state?.status === 'error' || state?.status === 'missing') {
      slot.appendChild(el('div', 'history-thumb-placeholder', state.status === 'missing' ? '文件缺失' : '缩略图不可用'));
      return;
    }
    slot.appendChild(ui.spinner(20));
    queueThumb(item, slot);
  }

  function queueThumb(item, slot = null, { immediate = false } = {}) {
    const key = itemKey(item);
    const stamp = thumbStamp(item);
    const existing = page.thumbs.get(key);
    if (existing && existing.stamp === stamp) {
      if (immediate) thumbnailQueue.request(key);
      else thumbnailQueue.watch(key, slot);
      return;
    }
    if (existing) thumbnailQueue.cancel(key);
    if (existing?.url) {
      try { URL.revokeObjectURL(existing.url); } catch {}
    }
    page.thumbs.set(key, { status: 'loading', url: '', stamp });
    if (immediate) thumbnailQueue.request(key);
    else thumbnailQueue.watch(key, slot);
  }

  async function loadThumb(item, isCurrent = () => true) {
    const key = itemKey(item);
    const stamp = thumbStamp(item);
    const token = page.generation;
    try {
      const bytes = await api.get(digestThumbPath(item), {
        expect: 'bytes',
        maxBytes: THUMB_FETCH_MAX_BYTES,
        signal: page.thumbController.signal,
        timeoutMs: 60000,
      });
      if (!alive(token) || !isCurrent()) return;
      const blob = new Blob([bytes], { type: 'image/png' });
      page.thumbs.set(key, { status: 'ready', url: URL.createObjectURL(blob), stamp });
    } catch (error) {
      if (!alive(token) || !isCurrent()) return;
      if (page.destroyed) return;
      const missing = error?.status === 404;
      page.thumbs.set(key, { status: missing ? 'missing' : 'error', url: '', stamp });
    }
    // 只更新仍在 DOM 中的对应卡片;若卡片数据已换代(stamp 变化),renderThumbInto 会重新排队。
    const card = grid.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (card) {
      const slot = card.querySelector('.history-thumb');
      const current = page.items.find(entry => itemKey(entry) === key);
      if (slot && current) renderThumbInto(slot, current);
    }
  }

  // -------------------------------------------------------------------------
  // 详情弹层
  // -------------------------------------------------------------------------
  function restoreDetailFocus(focusKey, focusAction) {
    const expectedDetail = page.detail;
    const expectedListSeq = page.listSeq;
    const schedule = globalThis.requestAnimationFrame || (callback => setTimeout(callback, 0));
    schedule(() => {
      if (page.destroyed || page.detail !== expectedDetail || page.listSeq !== expectedListSeq) return;
      const active = globalThis.document?.activeElement;
      const explicitFocus = active
        && active !== globalThis.document?.body
        && active !== globalThis.document?.documentElement
        && active.isConnected !== false;
      if (explicitFocus) return;
      const target = findHistoryFocusTarget(grid, focusKey, focusAction);
      if (target?.focus) {
        target.focus({ preventScroll: true });
        return;
      }
      pageTitle.focus({ preventScroll: true });
    });
  }

  function releaseDetailTimer(detail, timer) {
    if (!detail || timer === null || timer === undefined) return false;
    clearInterval(timer);
    const index = detail.pendingTimers.indexOf(timer);
    if (index >= 0) detail.pendingTimers.splice(index, 1);
    if (detail.thumbTimer === timer) {
      detail.thumbTimer = null;
      detail.thumbTimerKey = '';
    }
    return true;
  }

  function clearDetailTimers(detail) {
    if (!detail) return;
    for (const timer of [...detail.pendingTimers]) releaseDetailTimer(detail, timer);
    detail.pendingTimers.length = 0;
    detail.thumbTimer = null;
    detail.thumbTimerKey = '';
  }

  function closeDetail() {
    if (!page.detail) return;
    const detail = page.detail;
    page.detail = null;
    detail.invalidated = true;
    detail.controller.abort();
    detail.revalidator?.dispose();
    clearDetailTimers(detail);
    detail.modal.close();
  }

  function detailBusy(flag, { restoreFocus = true } = {}) {
    const detail = page.detail;
    if (!detail) return;
    setHistoryDetailActionBusy({
      detail,
      busy: flag,
      restoreFocus,
      isActive: () => !page.destroyed && page.detail === detail,
    });
  }

  function setDetailStatus(text, tone = '') {
    const detail = page.detail;
    if (!detail) return;
    detail.statusEl.className = `history-action-status${tone ? ` ${tone}` : ''}`;
    detail.statusEl.replaceChildren();
    if (text) {
      detail.statusEl.appendChild(document.createTextNode(text));
      revealHistoryDetailStatus(detail.statusEl, {
        isActive: () => !page.destroyed && page.detail === detail,
      });
    }
  }

  function setDetailStatusWithEvidence(text, outcome) {
    const detail = page.detail;
    if (!detail) return;
    setDetailStatus(text, 'warn');
    const queryBtn = el('button', 'btn btn-ghost btn-sm', '查询结果');
    queryBtn.type = 'button';
    queryBtn.addEventListener('click', () => {
      openEvidenceModal(outcome.actionId, {
        kind: String(outcome.result?.__evidenceKind || ''),
        item: outcome.item || detail.item,
      });
    });
    detail.statusEl.appendChild(document.createTextNode(' '));
    detail.statusEl.appendChild(queryBtn);
  }

  function updateDetailItem(nextItem) {
    const detail = page.detail;
    if (!detail) return;
    const focusedAction = captureHistoryDetailActionFocus({ detail });
    detail.item = nextItem;
    renderDetailBody();
    if (focusedAction) {
      restoreHistoryDetailActionFocus({
        detail,
        action: focusedAction,
        isActive: () => !page.destroyed && page.detail === detail,
      });
    }
  }

  function openDetail(item, { focusKey = itemKey(item), focusAction = 'card' } = {}) {
    closeDetail();
    const content = el('div', 'history-detail-wrap');
    const bodySlot = el('div', 'history-detail-body');
    const actionsSlot = el('div', 'history-detail-actions');
    const statusEl = el('p', 'history-action-status');
    content.append(bodySlot, actionsSlot, statusEl);
    const modal = openPageModal({
      title: item.group || '历史详情',
      content,
      wide: true,
      onClose: () => {
        if (page.detail?.modal === modal) {
          // 用户直接关闭弹层(Esc/遮罩/×):停掉进行中的核对与定时器。
          page.detail.invalidated = true;
          page.detail.controller.abort();
          page.detail.revalidator?.dispose();
          clearDetailTimers(page.detail);
          page.detail = null;
          restoreDetailFocus(focusKey, focusAction);
        }
      },
    });
    page.detail = {
      item,
      modal,
      statusEl,
      bodySlot,
      actionsSlot,
      busy: false,
      deleteConfirmPending: false,
      invalidated: false,
      busyFocusAction: '',
      pendingTimers: [],
      thumbTimer: null,
      thumbTimerKey: '',
      controller: new AbortController(),
      revalidator: null,
    };
    const detail = page.detail;
    detail.revalidator = createHistoryReturnRevalidator({
      request: ({ signal }) => api.get(historyItemStatusPath(detail.item), {
        signal,
        timeoutMs: 30000,
      }),
      signal: detail.controller.signal,
      isActive: () => !page.destroyed && page.detail === detail,
      isBusy: () => detail.busy,
      onResult: payload => {
        if (page.destroyed || page.detail !== detail) return;
        const next = payload?.item;
        if (!next || typeof next !== 'object') return;
        const reconciliation = reconcileHistoryListItem(next, { fallbackItem: detail.item });
        if (!reconciliation.found && historyItemMatchesFilter(next, page.filter)) scheduleCrossTabListReload();
        renderAll();
        if (page.detail === detail) updateDetailItem(next);
      },
    });
    renderDetailBody();
    // 打开详情及切回窗口时核对最新状态;忙态由协调器延迟,避免覆盖危险操作目标。
    detail.revalidator.schedule(0);
  }

  function kv(label, value) {
    const displayValue = String(value || '—');
    const valueEl = el('span', 'history-kv-value', displayValue);
    valueEl.title = displayValue;
    const row = el('div', 'history-kv-row');
    row.append(el('span', 'history-kv-label muted', label), valueEl);
    return row;
  }

  function renderDetailBody() {
    const detail = page.detail;
    if (!detail) return;
    const item = detail.item;
    detail.bodySlot.replaceChildren();

    const preview = el('div', 'history-detail-preview');
    if (isMarkdownItem(item)) {
      preview.appendChild(el('div', 'history-thumb-placeholder history-thumb-md history-detail-md', 'MD'));
    } else {
      const state = thumbState(item);
      if (state?.status === 'ready' && state.url) {
        const img = document.createElement('img');
        img.alt = `${item.group || '历史'} 预览`;
        img.src = state.url;
        preview.appendChild(img);
      } else if (state?.status === 'error' || state?.status === 'missing') {
        preview.appendChild(el(
          'div',
          'history-thumb-placeholder',
          state.status === 'missing' ? '文件缺失' : '缩略图不可用',
        ));
      } else if (item.file_exists === false) {
        preview.appendChild(el('div', 'history-thumb-placeholder', '文件缺失'));
      } else {
        preview.appendChild(ui.spinner(24));
        queueThumb(item, null, { immediate: true });
        // 缩略图就绪后局部刷新预览;detail.pendingTimers 由 closeDetail/destroy 统一清理。
        const key = itemKey(item);
        if (detail.thumbTimer !== null && detail.thumbTimerKey !== key) {
          releaseDetailTimer(detail, detail.thumbTimer);
        }
        if (detail.thumbTimer === null) {
          const timer = setInterval(() => {
            if (page.destroyed || page.detail !== detail) {
              releaseDetailTimer(detail, timer);
              return;
            }
            const next = thumbState(item);
            if (next?.status === 'ready' || next?.status === 'error' || next?.status === 'missing') {
              releaseDetailTimer(detail, timer);
              if (page.detail === detail && itemKey(detail.item) === key) renderDetailBody();
            }
          }, 400);
          detail.thumbTimer = timer;
          detail.thumbTimerKey = key;
          detail.pendingTimers.push(timer);
        }
      }
    }

    const info = el('div', 'history-detail-info');
    const badges = el('div', 'history-badges');
    badgeRow(item, badges);
    info.appendChild(badges);
    info.append(
      kv('群', item.group || item.group_id),
      kv('时间范围', `${item.since || '—'} ~ ${item.until || '—'}`),
      kv('消息数', formatCount(item.message_count) || '—'),
      kv('模型', item.model),
      kv('创建时间', formatDateTime(item.created_at)),
      kv('账号', item.account_label || item.account_id),
      kv('类型', isMarkdownItem(item) ? 'MD 导出' : '长图 PNG'),
    );
    if (item.rerendered_at) info.appendChild(kv('重渲染时间', formatDateTime(item.rerendered_at)));
    if (item.has_blocking_issue === true && item.blocking_issue_reason) {
      info.appendChild(kv('问题原因', blockingIssueLabel(item.blocking_issue_reason)));
    }
    if (item.history_current === false) {
      info.appendChild(kv('输出目录', item.history_output_relative_path || item.output_dir_identity || '非当前输出目录'));
    }
    const pathRow = el('p', 'history-detail-path muted', item.relative_path || '(路径未知)');
    pathRow.title = item.relative_path || '';
    info.appendChild(pathRow);

    const detailGrid = el('div', 'history-detail');
    detailGrid.append(preview, info);
    detail.bodySlot.appendChild(detailGrid);
    renderDetailActions();
  }

  function addActionButton(slot, {
    label,
    check,
    onClick,
    primary = false,
    danger = false,
    title = '',
    action = '',
  }) {
    const usable = !check || check.ok;
    const emphasisClass = usable && primary ? 'btn-primary' : 'btn-ghost';
    const dangerClass = usable && danger ? ' btn-danger' : '';
    const btn = el('button', `btn btn-sm ${emphasisClass}${dangerClass}`, label);
    btn.type = 'button';
    if (action) btn.dataset.historyDetailAction = action;
    if (!usable) {
      btn.disabled = true;
      btn.dataset.disabledReason = '1';
      btn.title = check.reason || '当前不可用';
    } else if (title) {
      btn.title = title;
    }
    btn.addEventListener('click', () => { void onClick(); });
    slot.appendChild(btn);
    return btn;
  }

  function downloadActionCheck(check, artifactLabel) {
    if (!check?.ok) return check;
    const capability = browserDownloadCapability({ requireObjectUrl: true });
    return capability.supported
      ? check
      : { ok: false, reason: browserDownloadUnsupportedMessage({ artifactLabel }) };
  }

  function renderDetailActions() {
    const detail = page.detail;
    if (!detail) return;
    const item = detail.item;
    const slot = detail.actionsSlot;
    slot.replaceChildren();
    const markdown = isMarkdownItem(item);
    const oldOutput = item.history_current === false;

    if (markdown) {
      addActionButton(slot, {
        label: '查看 MD',
        check: mdFileActionCheck(item),
        primary: true,
        action: 'view-markdown',
        onClick: () => openMarkdownViewer(item),
      });
      addActionButton(slot, {
        label: '下载 MD',
        check: downloadActionCheck(mdFileActionCheck(item), 'Markdown 文件'),
        action: 'download-markdown',
        onClick: () => downloadMarkdown(item),
      });
      addActionButton(slot, {
        label: '复制路径',
        check: mdFileActionCheck(item),
        action: 'copy-path',
        onClick: () => runDetailAction('复制路径', () => actions.copyPath(item, { signal: detail.controller.signal })),
      });
      addActionButton(slot, {
        label: '在文件夹显示',
        check: mdFileActionCheck(item),
        action: 'reveal-file',
        onClick: () => runDetailAction('在文件夹显示', () => actions.revealItem(item, { signal: detail.controller.signal })),
      });
      addActionButton(slot, {
        label: '查看 MD 源',
        check: markdownSourceCheck(item),
        title: '定位生成这条 MD 的源摘要',
        action: 'view-markdown-source',
        onClick: () => viewMarkdownSource(item),
      });
      if (item.history_commit_failed === true
        || (item.file_exists === false && !markdownSourceReferenceAvailable(item))) {
        const committedUnbound = item.history_commit_failed === true;
        addActionButton(slot, {
          label: committedUnbound ? '去设置页核对输出' : '去总结页重生成',
          title: markdownRecoveryInstruction(item),
          action: 'recover-output',
          onClick: () => {
            closeDetail();
            if (committedUnbound) {
              if (typeof navigate === 'function') navigate('#/settings');
              else location.hash = '#/settings';
            } else goToDigest();
          },
        });
      }
    } else {
      addActionButton(slot, {
        label: '打开原图',
        check: pngFileActionCheck(item),
        primary: true,
        action: 'open-image',
        onClick: () => openImageViewer(item),
      });
      addActionButton(slot, {
        label: '下载 PNG',
        check: downloadActionCheck(pngFileActionCheck(item), 'PNG 图片'),
        action: 'download-png',
        onClick: () => downloadPng(item),
      });
      addActionButton(slot, {
        label: '复制图片',
        check: pngFileActionCheck(item),
        action: 'copy-image',
        onClick: () => runDetailAction('复制图片', () => actions.copyImage(item, { signal: detail.controller.signal })),
      });
      addActionButton(slot, {
        label: '复制路径',
        check: pngFileActionCheck(item),
        action: 'copy-path',
        onClick: () => runDetailAction('复制路径', () => actions.copyPath(item, { signal: detail.controller.signal })),
      });
      addActionButton(slot, {
        label: '在文件夹显示',
        check: pngFileActionCheck(item),
        action: 'reveal-file',
        onClick: () => runDetailAction('在文件夹显示', () => actions.revealItem(item, { signal: detail.controller.signal })),
      });
      addActionButton(slot, {
        label: '导出 MD',
        check: exportMarkdownCheck(item),
        title: '按原摘要 JSON 导出 Markdown 到当前输出目录',
        action: 'export-markdown',
        onClick: () => exportMarkdown(item),
      });
      addActionButton(slot, {
        label: '重新渲染',
        check: rerenderCheck(item),
        action: 'rerender',
        onClick: () => openRerenderModal(item),
      });
    }

    // 非当前输出目录恢复操作。
    if (!markdown && oldOutput) {
      if (restoreToCurrentOutputEligible(item)) {
        addActionButton(slot, {
          label: '恢复到当前目录',
          check: rerenderCheck(item),
          action: 'restore-current-output',
          title: '原 PNG 已丢失或不可安全读取,按原摘要重新生成到当前输出目录',
          onClick: () => openRerenderModal(item),
        });
      } else if (copyToCurrentOutputEligible(item)) {
        addActionButton(slot, {
          label: '复制到当前目录',
          check: null,
          action: 'copy-current-output',
          title: '把非当前输出目录的 PNG 原样复制到当前输出目录',
          onClick: () => runDetailAction(
            '复制到当前输出目录',
            () => actions.copyToCurrentOutput(item, { signal: detail.controller.signal }),
            { replacesItem: true },
          ),
        });
      }
    }

    addActionButton(slot, {
      label: '刷新状态',
      check: null,
      action: 'refresh-status',
      onClick: () => refreshItemStatus(item, { silent: false }),
    });
    addActionButton(slot, {
      label: '删除',
      check: deleteCheck(item),
      danger: true,
      action: 'delete',
      onClick: () => confirmDelete(item),
    });
    // 操作进行中重建按钮(状态刷新回流)时保持禁用。
    if (detail.busy) detailBusy(true);
  }

  // -------------------------------------------------------------------------
  // 操作执行与结果呈现
  // -------------------------------------------------------------------------
  async function runDetailAction(label, fn, { replacesItem = false, removesItem = false, closesDetail = false } = {}) {
    const detail = page.detail;
    if (!detail || detail.busy) return;
    const actionItem = detail.item;
    const actionAccountId = actionAccountIdForItem(detail.item);
    const actionAccountFingerprint = actionAccountFingerprintForItem(detail.item);
    detailBusy(true);
    setDetailStatus(`${label}中…`);
    let outcome;
    try {
      outcome = await fn();
    } catch (error) {
      if (error?.name === 'AbortError' || error?.status === 499) {
        outcome = { status: 'cancelled', tone: 'info', message: '', actionId: '' };
      } else {
        outcome = { status: 'failed', tone: 'error', message: error?.message || `${label}失败`, actionId: '' };
      }
    }
    if (page.destroyed) return;
    if (outcome.status === 'cancelled') {
      if (page.detail === detail && detail.busy) {
        detailBusy(false);
        setDetailStatus(`${label}已取消。`);
      }
      return;
    }
    if (page.detail !== detail) {
      // 已经打开另一条详情时,旧详情 owner 的结果不能投影到新详情;
      // 只有用户主动关闭后没有新详情的离屏完成结果才允许提示。
      if (page.detail && page.detail !== detail) return;
      // 跨标签删除已明确终止该详情对应的动作;即使 API 忽略 abort 晚到,
      // 也不能把已删除记录的结果投影成当前页面提示。
      if (detail.suppressLateActionOutcome === true) return;
      // 弹层已关:结果用 toast 呈现,绝不在已卸载 DOM 上写字。
      if (!actionResultStillApplies(actionAccountId, actionAccountFingerprint)) return;
      if (outcome.status === 'verified') ui.toastSuccess(outcome.message || `${label}完成`);
      else ui.toast(outcome.message || `${label}结果未知`, { type: 'warn', duration: 6000 });
      if (outcome.status === 'verified'
        && detail.invalidated !== true
        && actionResultStillApplies(actionAccountId, actionAccountFingerprint)) {
        applyOutcomeItem(outcome, { replacesItem, removesItem, actionItem });
      }
      return;
    }
    detailBusy(false);
    if (outcome.status === 'verified') {
      setDetailStatus(outcome.message || `${label}完成`, 'ok');
      ui.toastSuccess(outcome.message || `${label}完成`);
      applyOutcomeItem(outcome, { replacesItem, removesItem, actionItem });
      if (closesDetail) closeDetail();
      return;
    }
    if (outcome.status === 'unknown') {
      setDetailStatusWithEvidence(outcome.message || `${label}结果未知`, outcome);
      ui.toast(outcome.message || `${label}结果未知`, { type: 'warn', duration: 6000 });
      return;
    }
    if (outcome.status === 'committed_unverified') {
      setDetailStatusWithEvidence(outcome.message || `${label}已提交但未完成核对`, outcome);
      ui.toast(outcome.message || '', { type: 'warn', duration: 6000 });
      applyOutcomeItem(outcome, { replacesItem, removesItem, actionItem });
      return;
    }
    setDetailStatus(outcome.message || `${label}失败`, 'err');
    ui.toastError(outcome.message || `${label}失败`);
  }

  // 操作成功后把返回的 item 合并回列表/详情;删除则移除。
  function removeHistoryListItemAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= page.items.length) return null;
    const [removedItem] = page.items.splice(index, 1);
    if (!removedItem) return null;
    dropThumb(removedItem);
    page.total = Math.max(0, page.total - 1);
    if (removedItem.has_blocking_issue === true) page.issueTotal = Math.max(0, page.issueTotal - 1);
    else page.okTotal = Math.max(0, page.okTotal - 1);
    return removedItem;
  }

  function reconcileHistoryListItem(nextItem, { fallbackItem = null } = {}) {
    if (!nextItem || typeof nextItem !== 'object') return { found: false, visible: false };
    const key = itemKey(nextItem);
    const fallbackKey = fallbackItem ? itemKey(fallbackItem) : '';
    const index = page.items.findIndex(entry => itemKey(entry) === key
      || (fallbackKey && itemKey(entry) === fallbackKey)
      || (String(entry.digest_id || '') === String(nextItem.digest_id || '')
        && String(entry.relative_path || '') === String(nextItem.relative_path || '')));
    if (index < 0) return { found: false, visible: false };
    const currentItem = page.items[index];
    const transition = historyListStatusTransition(currentItem, nextItem, page.filter);
    page.total = Math.max(0, page.total + transition.totalDelta);
    page.okTotal = Math.max(0, page.okTotal + transition.okDelta);
    page.issueTotal = Math.max(0, page.issueTotal + transition.issueDelta);
    if (transition.action === 'remove') {
      dropThumb(currentItem);
      page.items.splice(index, 1);
      return { found: true, visible: false, previous: currentItem };
    }
    page.items.splice(index, 1, nextItem);
    return { found: true, visible: true, previous: currentItem };
  }

  function applyOutcomeItem(outcome, {
    replacesItem = false,
    removesItem = false,
    actionItem = null,
  } = {}) {
    const current = historyActionResultTarget({
      actionItem,
      outcomeItem: outcome.item,
      itemKey,
    });
    if (removesItem) {
      const key = current ? itemKey(current) : '';
      const removedIndex = page.items.findIndex(entry => current && itemKey(entry) === key);
      removeHistoryListItemAt(removedIndex);
      renderAll();
      broadcastItemUpdate(null, { deletedKey: key });
      return;
    }
    const next = outcome.item;
    if (!next || !replacesItem) return;
    const key = itemKey(next);
    const reconciliation = reconcileHistoryListItem(next);
    if (!reconciliation.found && historyItemMatchesFilter(next, page.filter)) {
      page.items.unshift(next);
      page.total += 1;
      if (next.has_blocking_issue === true) page.issueTotal += 1;
      else page.okTotal += 1;
    }
    renderAll();
    if (page.detail && (itemKey(page.detail.item) === key
      || String(page.detail.item?.digest_id || '') === String(next.digest_id || ''))) {
      updateDetailItem(next);
    }
    broadcastItemUpdate(next);
  }

  const statusRefresh = createHistoryStatusRefreshController({
    api,
    getStatusPath: historyItemStatusPath,
    getDetail: item => page.detail && itemKey(page.detail.item) === itemKey(item)
      ? page.detail
      : null,
    isPageDestroyed: () => page.destroyed,
    reconcile: (next, options) => reconcileHistoryListItem(next, options),
    render: renderAll,
    matchesFilter: next => historyItemMatchesFilter(next, page.filter),
    scheduleReload: scheduleCrossTabListReload,
    updateDetail: updateDetailItem,
    broadcast: next => broadcastItemUpdate(next),
    onStart: () => {
      detailBusy(true);
      setDetailStatus('正在刷新状态…');
    },
    onStatusRefreshed: () => setDetailStatus('状态已刷新。', 'ok'),
    onMissing: ({ item, detail }) => {
      // 已不存在:从列表移除并提示。
      const index = page.items.findIndex(entry => itemKey(entry) === itemKey(item));
      if (index >= 0) {
        removeHistoryListItemAt(index);
        renderAll();
      }
      if (page.detail === detail) setDetailStatus('这条历史已不存在(可能已被清理或输出目录已切换),已从列表移除。', 'warn');
    },
    onFailure: ({ detail, error }) => {
      if (page.detail === detail) setDetailStatus(`刷新失败:${error?.message || '未知错误'}`, 'err');
      ui.toastError(error?.message || '刷新状态失败');
    },
    onFinally: () => detailBusy(false),
  });

  function refreshItemStatus(item, options) {
    return statusRefresh.refresh(item, options);
  }

  // -------------------------------------------------------------------------
  // 删除(二次确认 + 三重版本前置)
  // -------------------------------------------------------------------------
  async function confirmDelete(item) {
    const check = deleteCheck(item);
    if (!check.ok) {
      ui.toastWarn(check.reason);
      return;
    }
    const detail = page.detail;
    if (!detail || detail.busy || detail.deleteConfirmPending) return;
    detail.deleteConfirmPending = true;
    detailBusy(true);
    let handedOffToDeleteAction = false;
    try {
      const confirmed = await ui.confirmDialog({
        title: '删除历史记录',
        message: `将删除「${item.group || '未命名群'}」这条历史记录,以及不再被其他记录引用的本地文件,删除后不可恢复。\n\n${item.relative_path || ''}\n\n确定删除?`,
        confirmLabel: '确认删除',
        danger: true,
      });
      if (!confirmed) return;
      if (page.destroyed || page.detail !== detail) return;
      setDetailStatus('正在核对删除目标…');
      const target = await revalidateHistoryActionTarget({
        captured: item,
        getCurrent: () => page.detail?.item || null,
        revalidate: async captured => {
          const result = await refreshItemStatus(captured, { silent: true });
          return result.ok ? result.item : null;
        },
        validate: latest => deleteCheck(latest),
      });
      if (page.destroyed || page.detail !== detail) return;
      if (!target.ok) {
        detailBusy(false);
        const message = target.code === 'missing'
          ? '这条历史已不存在,删除没有执行。'
          : target.code === 'target_changed'
            ? '这条历史在确认期间已变化,删除没有执行;请刷新后重新确认。'
            : (target.reason || '删除目标状态未通过核对,请刷新后重试。');
        setDetailStatus(message, 'warn');
        ui.toastWarn(message);
        return;
      }
      // 状态核验是静默请求;把详情 busy 交给真正的删除动作,中间不让出确认 owner。
      detailBusy(false, { restoreFocus: false });
      handedOffToDeleteAction = true;
      await runDetailAction(
        '删除',
        () => actions.deleteItem(target.item, { signal: detail.controller.signal }),
        { removesItem: true, closesDetail: true },
      );
    } finally {
      detail.deleteConfirmPending = false;
      if (!handedOffToDeleteAction && !page.destroyed && page.detail === detail && detail.busy) {
        detailBusy(false);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 查看原图 / MD(下载前一律 download_check 预检)
  // -------------------------------------------------------------------------
  async function openImageViewer(item) {
    const detail = page.detail;
    if (detail?.busy) return;
    if (detail) {
      detailBusy(true);
      setDetailStatus('正在读取原图…');
    }
    const wrapBox = el('div', 'history-viewer');
    const statusLine = el('p', 'history-viewer-status muted', '正在读取原图…');
    wrapBox.appendChild(ui.spinner(26));
    wrapBox.appendChild(statusLine);
    const controller = new AbortController();
    let objectUrl = '';
    const cleanupObjectUrl = () => {
      if (!objectUrl) return;
      const url = objectUrl;
      objectUrl = '';
      try { URL.revokeObjectURL(url); } catch {}
    };
    let settled = false;
    const isViewerActive = () => !page.destroyed
      && page.detail === detail
      && controller.signal.aborted !== true;
    const settle = () => {
      if (settled) return;
      settled = true;
      if (detail && page.detail === detail) {
        detailBusy(false, { restoreFocus: false });
        setDetailStatus('');
      }
    };
    let disposed = false;
    const pageDisposer = () => {
      if (!disposed) {
        disposed = true;
        controller.abort();
        cleanupObjectUrl();
      }
      settle();
    };
    const detachPageDisposer = () => {
      const index = page.unsubscribers.indexOf(pageDisposer);
      if (index >= 0) page.unsubscribers.splice(index, 1);
    };
    openPageModal({
      title: `${item.group || '历史'} · 原图`,
      content: wrapBox,
      wide: true,
      onClose: () => {
        pageDisposer();
        detachPageDisposer();
        if (detail && page.detail === detail) {
          restoreHistoryDetailActionFocus({
            detail,
            action: 'open-image',
            isActive: () => !page.destroyed && page.detail === detail,
            force: true,
          });
        }
      },
    });
    page.unsubscribers.push(pageDisposer);
    try {
      // 预检:版本不符会 409,先发现先提示。
      await api.get(digestFilePath(item, { downloadCheck: true }), { signal: controller.signal, timeoutMs: 30000 });
      if (!isViewerActive()) return;
      const bytes = await api.get(digestFilePath(item), {
        expect: 'bytes',
        maxBytes: PNG_FETCH_MAX_BYTES,
        signal: controller.signal,
        timeoutMs: 120000,
      });
      if (!isViewerActive()) return;
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      objectUrl = url;
      const img = document.createElement('img');
      img.className = 'history-zoom-img fit';
      img.alt = `${item.group || '历史'} 原图`;
      img.src = url;
      const zoomToggle = createHistoryZoomToggle(img);
      const scrollRegion = createZoomRegion(img, { className: 'history-zoom-scroll' });
      wrapBox.replaceChildren(zoomToggle, scrollRegion);
      settle();
    } catch (error) {
      settle();
      if (!isViewerActive() || error?.name === 'AbortError' || error?.status === 499) return;
      const message = error?.status === 404
        ? '长图文件已不存在,可能已被移动或删除。'
        : (error?.status === 409 ? '历史文件已变化,请关闭后刷新状态再试。' : `读取失败:${error?.message || '未知错误'}`);
      statusLine.textContent = message;
      wrapBox.replaceChildren(statusLine);
    }
  }

  async function openMarkdownViewer(item) {
    const detail = page.detail;
    if (detail?.busy) return;
    if (detail) {
      detailBusy(true);
      setDetailStatus('正在读取 MD…');
    }
    const wrapBox = el('div', 'history-viewer');
    const statusLine = el('p', 'history-viewer-status muted', '正在读取 MD…');
    wrapBox.appendChild(ui.spinner(26));
    wrapBox.appendChild(statusLine);
    const controller = new AbortController();
    let settled = false;
    const isViewerActive = () => !page.destroyed
      && page.detail === detail
      && controller.signal.aborted !== true;
    const settle = () => {
      if (settled) return;
      settled = true;
      if (detail && page.detail === detail) {
        detailBusy(false, { restoreFocus: false });
        setDetailStatus('');
      }
    };
    let disposed = false;
    const pageDisposer = () => {
      if (!disposed) {
        disposed = true;
        controller.abort();
      }
      settle();
    };
    const detachPageDisposer = () => {
      const index = page.unsubscribers.indexOf(pageDisposer);
      if (index >= 0) page.unsubscribers.splice(index, 1);
    };
    openPageModal({
      title: `${item.group || '历史'} · MD`,
      content: wrapBox,
      wide: true,
      onClose: () => {
        pageDisposer();
        detachPageDisposer();
        if (detail && page.detail === detail) {
          restoreHistoryDetailActionFocus({
            detail,
            action: 'view-markdown',
            isActive: () => !page.destroyed && page.detail === detail,
            force: true,
          });
        }
      },
    });
    page.unsubscribers.push(pageDisposer);
    try {
      await api.get(outputFilePath(item, { downloadCheck: true }), { signal: controller.signal, timeoutMs: 30000 });
      if (!isViewerActive()) return;
      const bytes = await api.get(outputFilePath(item), {
        expect: 'bytes',
        maxBytes: MD_FETCH_MAX_BYTES,
        signal: controller.signal,
        timeoutMs: 60000,
      });
      if (!isViewerActive()) return;
      const text = new TextDecoder('utf-8').decode(bytes);
      const pre = makeScrollableRegion(el('pre', 'history-md-view'), {
        label: 'Markdown 内容滚动区域',
      });
      pre.textContent = text;
      wrapBox.replaceChildren(pre);
      settle();
    } catch (error) {
      settle();
      if (!isViewerActive() || error?.name === 'AbortError' || error?.status === 499) return;
      const message = error?.status === 404
        ? '导出的 MD 已不存在,请重新导出。'
        : (error?.status === 409
          ? 'MD 已变化或隐私/输出设置已变化,请刷新状态后重试。'
          : `读取失败:${error?.message || '未知错误'}`);
      statusLine.textContent = message;
      wrapBox.replaceChildren(statusLine);
    }
  }

  // -------------------------------------------------------------------------
  // 下载(浏览器本地下载,先 download_check 预检)
  // -------------------------------------------------------------------------
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    let anchor = null;
    try {
      anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
    } finally {
      if (anchor) {
        try { anchor.remove(); } catch {}
      }
      setTimeout(() => {
        try { URL.revokeObjectURL(url); } catch {}
      }, 5000);
    }
  }

  function safeFilename(item, ext) {
    const group = String(item.group || item.digest_id || '历史').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 60);
    const when = formatDateTime(item.created_at).replace(/[-: ]/g, '').slice(0, 12) || 'unknown';
    return `${group}-${when}.${ext}`;
  }

  function isCurrentDetailDownload(detail) {
    return !page.destroyed
      && page.detail === detail
      && detail?.invalidated !== true
      && detail?.controller?.signal?.aborted !== true;
  }

  function cancelledDownloadOutcome(error = null) {
    return { status: 'cancelled', tone: 'info', message: '', error };
  }

  async function downloadPng(item) {
    const detail = page.detail;
    if (!detail) return;
    if (!browserDownloadCapability({ requireObjectUrl: true }).supported) {
      ui.toastWarn(browserDownloadUnsupportedMessage({ artifactLabel: 'PNG 图片' }));
      return;
    }
    await runDetailAction('下载 PNG', async () => {
      try {
        await api.get(digestFilePath(item, { downloadCheck: true }), {
          signal: detail.controller.signal,
          timeoutMs: 30000,
        });
        if (!isCurrentDetailDownload(detail)) return cancelledDownloadOutcome();
        const bytes = await api.get(digestFilePath(item), {
          expect: 'bytes',
          maxBytes: PNG_FETCH_MAX_BYTES,
          signal: detail.controller.signal,
          timeoutMs: 120000,
        });
        if (!isCurrentDetailDownload(detail)) return cancelledDownloadOutcome();
        downloadBlob(new Blob([bytes], { type: 'image/png' }), safeFilename(item, 'png'));
        return { status: 'verified', tone: 'success', message: `已开始下载 PNG(${safeFilename(item, 'png')})。` };
      } catch (error) {
        if (error?.name === 'AbortError' || error?.status === 499) return cancelledDownloadOutcome(error);
        if (error?.status === 404) return { status: 'failed', tone: 'error', message: '长图文件已不存在,可能已被移动或删除。', error };
        if (error?.status === 409) return { status: 'failed', tone: 'error', message: '历史文件已变化,请刷新状态后再下载。', error };
        return { status: 'failed', tone: 'error', message: `下载失败:${error?.message || '未知错误'}`, error };
      }
    });
  }

  async function downloadMarkdown(item) {
    const detail = page.detail;
    if (!detail) return;
    if (!browserDownloadCapability({ requireObjectUrl: true }).supported) {
      ui.toastWarn(browserDownloadUnsupportedMessage({ artifactLabel: 'Markdown 文件' }));
      return;
    }
    await runDetailAction('下载 MD', async () => {
      try {
        await api.get(outputFilePath(item, { downloadCheck: true }), {
          signal: detail.controller.signal,
          timeoutMs: 30000,
        });
        if (!isCurrentDetailDownload(detail)) return cancelledDownloadOutcome();
        const bytes = await api.get(outputFilePath(item), {
          expect: 'bytes',
          maxBytes: MD_FETCH_MAX_BYTES,
          signal: detail.controller.signal,
          timeoutMs: 60000,
        });
        if (!isCurrentDetailDownload(detail)) return cancelledDownloadOutcome();
        downloadBlob(new Blob([bytes], { type: 'text/markdown;charset=utf-8' }), safeFilename(item, 'md'));
        return { status: 'verified', tone: 'success', message: `已开始下载 MD(${safeFilename(item, 'md')})。` };
      } catch (error) {
        if (error?.name === 'AbortError' || error?.status === 499) return cancelledDownloadOutcome(error);
        if (error?.status === 404) return { status: 'failed', tone: 'error', message: '导出的 MD 已不存在,请重新导出。', error };
        if (error?.status === 428) return { status: 'failed', tone: 'error', message: '缺少可校验的设置状态标识,无法下载该 MD。', error };
        if (error?.status === 409) return { status: 'failed', tone: 'error', message: 'MD 已变化或隐私/输出设置已变化,请刷新状态后重试。', error };
        return { status: 'failed', tone: 'error', message: `下载失败:${error?.message || '未知错误'}`, error };
      }
    });
  }

  // -------------------------------------------------------------------------
  // 导出 MD(PNG 项:读摘要 → 服务端按已验证摘要生成)
  // -------------------------------------------------------------------------
  async function exportMarkdown(item) {
    const detail = page.detail;
    if (!detail || detail.busy) return;
    const actionAccountId = actionAccountIdForItem(item);
    const actionAccountFingerprint = actionAccountFingerprintForItem(item);
    detailBusy(true);
    setDetailStatus('正在读取原摘要…');
    try {
      const saved = await api.get(historyDigestPath(item, { exportFull: true }), {
        signal: detail.controller.signal,
        timeoutMs: 60000,
      });
      if (page.destroyed || page.detail !== detail) return;
      const digest = saved?.digest;
      if (!digest?.digest_id) {
        setDetailStatus('原摘要 JSON 内容不完整,不能导出 MD。', 'err');
        return;
      }
      const markdown = digestMarkdownForDigests([{ ...digest, group: digest.group || item.group }]);
      setDetailStatus('正在导出 MD…');
      const outcome = await actions.exportMarkdown(item, {
        digest,
        markdown,
        signal: detail.controller.signal,
      });
      if (page.destroyed) return;
      if (outcome.status === 'cancelled') return;
      if (page.detail !== detail) {
        if (!actionResultStillApplies(actionAccountId, actionAccountFingerprint)) return;
        if (outcome.status === 'verified') ui.toastSuccess(outcome.message);
        else ui.toast(outcome.message || '导出 MD 结果未知', { type: 'warn', duration: 6000 });
        if (outcome.status === 'verified'
          && outcome.item
          && detail.invalidated !== true
          && actionResultStillApplies(actionAccountId, actionAccountFingerprint)) {
          applyOutcomeItem(outcome, { replacesItem: true });
        }
        return;
      }
      if (outcome.status === 'verified') {
        setDetailStatus(`${outcome.message};新 MD 已加入历史列表。`, 'ok');
        ui.toastSuccess(outcome.message);
        if (outcome.item && actionResultStillApplies(actionAccountId, actionAccountFingerprint)) {
          applyOutcomeItem(outcome, { replacesItem: true });
        }
      } else if (outcome.status === 'unknown' || outcome.status === 'committed_unverified') {
        setDetailStatusWithEvidence(outcome.message, outcome);
        if (outcome.item) applyOutcomeItem(outcome, { replacesItem: true });
      } else {
        setDetailStatus(outcome.message, 'err');
        ui.toastError(outcome.message);
      }
    } catch (error) {
      if (page.destroyed
        || page.detail !== detail
        || detail.controller.signal.aborted
        || error?.name === 'AbortError'
        || error?.status === 499) return;
      const message = error?.status === 428
        ? '缺少原摘要 JSON 校验信息,请刷新列表后重试。'
        : (error?.status === 404 || error?.code === 'digest_json_missing'
          ? '原摘要 JSON 已不存在,不能导出 MD。'
          : `读取原摘要失败:${error?.message || '未知错误'}`);
      if (page.detail === detail) setDetailStatus(message, 'err');
      else ui.toastError(message);
    } finally {
      if (!page.destroyed && page.detail === detail && detail.busy) detailBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // 查看 MD 源(定位生成该 MD 的源摘要并打开其详情)
  // -------------------------------------------------------------------------
  async function viewMarkdownSource(item) {
    const detail = page.detail;
    if (!detail || detail.busy) return;
    detailBusy(true);
    setDetailStatus('正在定位源摘要…');
    try {
      const result = await api.get(historyMarkdownSourcePath(item), {
        signal: detail.controller.signal,
        timeoutMs: 30000,
      });
      if (page.destroyed
        || page.detail !== detail
        || detail.controller.signal.aborted
        || detail.invalidated === true) return;
      const source = result?.item;
      if (!source || isMarkdownItem(source)) {
        if (page.detail === detail) setDetailStatus('本地服务没有返回可定位的源摘要,请刷新后重试。', 'err');
        return;
      }
      reconcileHistoryListItem(source);
      renderAll();
      setDetailStatus('已定位到源摘要。', 'ok');
      openDetail(source);
    } catch (error) {
      if (page.destroyed
        || page.detail !== detail
        || detail.controller.signal.aborted
        || detail.invalidated === true
        || error?.name === 'AbortError'
        || error?.status === 499) return;
      const message = error?.status === 409
        ? '这条 MD 历史记录已更新,请刷新历史页后重新定位源摘要。'
        : (error?.status === 404 ? '源摘要已不存在,可能已被清理或输出目录已切换。' : `定位失败:${error?.message || '未知错误'}`);
      if (page.detail === detail) setDetailStatus(message, 'err');
      ui.toastError(message);
    } finally {
      if (!page.destroyed && page.detail === detail && detail.busy) detailBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // 重新渲染(两阶段:本地按新主题重画 → 上传预览拿凭据 → 提交保存)
  // -------------------------------------------------------------------------
  function openRerenderModal(item) {
    const check = rerenderCheck(item);
    if (!check.ok) {
      ui.toastWarn(check.reason);
      return;
    }
    const restore = restoreToCurrentOutputEligible(item);
    const state = {
      item,
      restore,
      controller: new AbortController(),
      digest: null,
      rerenderInputVersion: '',
      preview: null, // { bytes, cache, renderKey, objectUrl }
      selection: { theme: currentResolvedTheme(), fontSize: 'normal', accentColor: '' },
      busy: false,
    };

    const wrapBox = el('div', 'history-rerender');
    const optionsRow = el('div', 'history-rerender-options');
    const themeSegmented = el('div', 'segmented');
    for (const [value, label] of [['light', '亮色'], ['dark', '暗色']]) {
      const btn = el('button', 'segmented-btn', label);
      btn.type = 'button';
      btn.dataset.rerenderTheme = value;
      themeSegmented.appendChild(btn);
    }
    const fontSegmented = el('div', 'segmented');
    for (const [value, label] of [['normal', '标准字号'], ['large', '大字号']]) {
      const btn = el('button', 'segmented-btn', label);
      btn.type = 'button';
      btn.dataset.rerenderFontsize = value;
      fontSegmented.appendChild(btn);
    }
    const accentLabel = el('label', 'history-rerender-accent muted', '主色 ');
    const accentInput = document.createElement('input');
    accentInput.type = 'color';
    accentInput.value = '#07c160';
    accentInput.setAttribute('aria-label', '主色');
    accentLabel.appendChild(accentInput);
    optionsRow.append(themeSegmented, fontSegmented, accentLabel);

    const previewSlot = makeScrollableRegion(el('div', 'history-rerender-preview'), {
      label: '重渲染预览滚动区域',
    });
    previewSlot.appendChild(el('p', 'muted', '正在读取原摘要…'));
    const statusLine = el('p', 'history-action-status');
    const actionsRow = el('div', 'history-rerender-actions');
    const previewBtn = el('button', 'btn btn-ghost btn-sm', '生成预览');
    previewBtn.type = 'button';
    const saveBtn = el('button', 'btn btn-primary btn-sm', restore ? '确认恢复' : '确认保存');
    saveBtn.type = 'button';
    saveBtn.disabled = true;
    actionsRow.append(previewBtn, saveBtn);
    wrapBox.append(optionsRow, previewSlot, actionsRow, statusLine);

    const modal = openPageModal({
      title: restore ? '恢复到当前目录' : '重新渲染',
      content: wrapBox,
      wide: true,
      onClose: () => {
        state.controller.abort();
        if (state.preview?.objectUrl) URL.revokeObjectURL(state.preview.objectUrl);
      },
    });

    const setStatus = (text, tone = '') => {
      statusLine.className = `history-action-status${tone ? ` ${tone}` : ''}`;
      statusLine.textContent = text || '';
      if (text) {
        revealHistoryDetailStatus(statusLine, {
          isActive: () => !page.destroyed
            && !state.controller.signal.aborted
            && modal.el?.isConnected,
        });
      }
    };
    const setBusy = flag => {
      state.busy = flag;
      previewBtn.disabled = flag || !state.digest;
      saveBtn.disabled = flag || !state.preview || state.preview.cache?.stored !== true;
      for (const btn of optionsRow.querySelectorAll('button, input')) btn.disabled = flag;
    };
    const selectionKey = () => JSON.stringify(state.selection);
    const syncSelectionButtons = () => {
      for (const btn of themeSegmented.querySelectorAll('[data-rerender-theme]')) {
        setSegmentedButtonState(btn, btn.dataset.rerenderTheme === state.selection.theme);
      }
      for (const btn of fontSegmented.querySelectorAll('[data-rerender-fontsize]')) {
        setSegmentedButtonState(btn, btn.dataset.rerenderFontsize === state.selection.fontSize);
      }
    };
    const invalidatePreview = () => {
      if (!state.preview) return;
      if (state.preview.objectUrl) URL.revokeObjectURL(state.preview.objectUrl);
      state.preview = null;
      saveBtn.disabled = true;
      setStatus('渲染选项已变化,请重新生成预览。', 'warn');
    };

    themeSegmented.addEventListener('click', event => {
      const btn = event.target.closest('[data-rerender-theme]');
      if (!btn || state.busy) return;
      state.selection.theme = btn.dataset.rerenderTheme;
      syncSelectionButtons();
      invalidatePreview();
    });
    fontSegmented.addEventListener('click', event => {
      const btn = event.target.closest('[data-rerender-fontsize]');
      if (!btn || state.busy) return;
      state.selection.fontSize = btn.dataset.rerenderFontsize;
      syncSelectionButtons();
      invalidatePreview();
    });
    accentInput.addEventListener('change', () => {
      if (state.busy) return;
      state.selection.accentColor = accentInput.value || '';
      invalidatePreview();
    });

    async function loadDigest() {
      try {
        // export=markdown:拿完整摘要(默认响应会截断 topics 等数组),
        // 否则预览/保存的 PNG 会静默丢内容。
        const payload = await api.get(historyDigestPath(item, { exportFull: true }), {
          signal: state.controller.signal,
          timeoutMs: 60000,
        });
        if (page.destroyed || state.controller.signal.aborted) return;
        state.digest = payload?.digest || null;
        state.rerenderInputVersion = String(payload?.rerender_input_version || '').trim();
        if (!state.digest?.digest_id || !/^[a-f0-9]{64}$/.test(state.rerenderInputVersion)) {
          previewSlot.replaceChildren(el('p', 'muted', '原摘要内容不完整,不能重渲染。'));
          setStatus('原摘要 JSON 内容不完整,不能重渲染。', 'err');
          return;
        }
        // 默认用保存时的渲染设置,没有则用当前主题(重渲染的典型诉求是换新主题)。
        const saved = payload?.render && typeof payload.render === 'object' ? payload.render : {};
        if (saved.theme === 'light' || saved.theme === 'dark') state.selection.theme = saved.theme;
        if (saved.font_size === 'large' || saved.font_size === 'normal') state.selection.fontSize = saved.font_size;
        if (/^#[0-9a-fA-F]{6}$/.test(String(saved.accent_color || ''))) {
          state.selection.accentColor = saved.accent_color;
          accentInput.value = saved.accent_color;
        } else {
          state.selection.accentColor = '#07c160';
        }
        syncSelectionButtons();
        previewSlot.replaceChildren(el('p', 'muted',
          restore
            ? '已读取原摘要。选择样式后点「生成预览」,确认后按原摘要重新生成到当前输出目录。'
            : '已读取原摘要。选择样式后点「生成预览」,确认无误后再保存。'));
        previewBtn.disabled = false;
        setStatus('');
      } catch (error) {
        if (page.destroyed
          || state.controller.signal.aborted
          || error?.name === 'AbortError'
          || error?.status === 499) return;
        const message = error?.status === 428
        ? '缺少原摘要 JSON 校验信息,请关闭后刷新列表重试。'
          : (error?.status === 404 || error?.code === 'digest_json_missing'
            ? '原摘要 JSON 已不存在,不能重渲染。'
            : `读取原摘要失败:${error?.message || '未知错误'}`);
        previewSlot.replaceChildren(el('p', 'muted', '原摘要读取失败。请查看下方错误信息。'));
        setStatus(message, 'err');
      }
    }

    async function generatePreview() {
      if (state.busy || !state.digest) return;
      const focusTarget = captureActionFocus([previewBtn], globalThis.document?.activeElement);
      setBusy(true);
      setStatus('正在本地绘制预览…');
      try {
        const rendered = renderHistoryDigestCanvas(state.digest, state.selection);
        if (rendered.width !== RERENDER_PREVIEW_EXPECTED_WIDTH) {
          throw new Error(`预览宽度 ${rendered.width}px 与服务端要求不符,已停止。`);
        }
        const bytes = await canvasToValidatedPngBytes(rendered.canvas, {
          signal: state.controller.signal,
          invalidMessage: '浏览器导出的 PNG 未通过完整性校验,已停止上传预览。',
        });
        if (state.controller.signal.aborted || page.destroyed) return;
        setStatus('正在上传预览…');
        const metadata = {
          digest_id: String(item.digest_id || ''),
          history_item_key: historyItemStableKey(item),
          render: {
            theme: rendered.theme,
            font_size: rendered.fontSize,
            accent_color: rendered.accentColor || '',
          },
          rerender_input_version: state.rerenderInputVersion,
        };
        const fileVersion = itemRerenderFileVersion(item);
        if (fileVersion) metadata.expected_file_version = fileVersion;
        const digestVersion = String(item.digest_file_version || '').trim();
        if (digestVersion) metadata.expected_digest_file_version = digestVersion;
        if (state.restore) metadata.restore_to_current_output = true;
        const response = await api.postRaw('/api/preview-rerender-history', bytes, {
          'Content-Type': 'image/png',
          'x-wx-rerender-metadata': encodeURIComponent(JSON.stringify(metadata)),
        }, { timeoutMs: RERENDER_HTTP_TIMEOUT_MS, signal: state.controller.signal });
        if (page.destroyed || state.controller.signal.aborted) return;
        const returnedVersion = String(response?.rerender_input_version || '').trim().toLowerCase();
        if (returnedVersion !== state.rerenderInputVersion.toLowerCase()) {
          throw new Error('预览凭据与当前摘要不一致,请重新生成预览。');
        }
        if (state.preview?.objectUrl) URL.revokeObjectURL(state.preview.objectUrl);
        const objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
        state.preview = { bytes, cache: response?.cache || {}, renderKey: selectionKey(), objectUrl };
        const img = document.createElement('img');
        img.className = 'history-rerender-preview-img';
        img.alt = '重渲染预览';
        img.src = objectUrl;
        previewSlot.replaceChildren(img);
        if (state.preview.cache?.stored === true) {
          saveBtn.disabled = false;
          setStatus('预览已就绪;确认后将保存这张预览图。', 'ok');
        } else {
          saveBtn.disabled = true;
          setStatus('预览已生成,但服务端没有可用的保存凭据(预览过大或缓存不可用);本次不能保存。', 'warn');
        }
      } catch (error) {
        if (page.destroyed || error?.name === 'AbortError' || state.controller.signal.aborted) return;
        const code = String(error?.code || '');
        if (code === 'history_rerender_input_changed') {
          setStatus('历史摘要的可见内容或隐私设置已变化;请关闭本窗口,刷新后重新操作。', 'err');
        } else if (code === 'output_dir_changed') {
          setStatus('输出目录已切换;请关闭本窗口,刷新历史页后再操作。', 'err');
        } else if (code === 'history_rerender_preview_width_invalid') {
          setStatus('预览图宽度不符合服务端要求;请刷新页面后重试。', 'err');
        } else if (isMutationOutcomeUnknown(error)) {
          setStatus('上传预览超时,结果未知;为避免重复缓存,请稍后重新生成预览。', 'warn');
        } else {
          setStatus(`预览失败:${error?.message || '未知错误'}`, 'err');
        }
      } finally {
        if (!page.destroyed && !state.controller.signal.aborted) {
          setBusy(false);
          restoreActionFocus(focusTarget, {
            activeElement: globalThis.document?.activeElement,
            body: globalThis.document?.body,
          });
        }
      }
    }

    async function commitSave() {
      if (state.busy || !state.preview) return;
      if (state.preview.renderKey !== selectionKey()) {
        invalidatePreview();
        return;
      }
      const focusTarget = captureActionFocus([saveBtn], globalThis.document?.activeElement);
      setBusy(true);
      page.pendingRerender += 1;
      setStatus(state.restore ? '正在恢复到当前目录…' : '正在保存重渲染结果…');
      try {
        const outcome = await actions.commitRerender(item, {
          render: {
            theme: state.selection.theme,
            font_size: state.selection.fontSize,
            accent_color: state.selection.accentColor || '',
          },
          rerenderInputVersion: state.rerenderInputVersion,
          previewToken: state.preview.cache?.preview_token || '',
          previewSha256: state.preview.cache?.preview_sha256 || '',
          restoreToCurrentOutput: state.restore,
          timeoutMs: RERENDER_HTTP_TIMEOUT_MS,
          signal: state.controller.signal,
        });
        if (page.destroyed || state.controller.signal.aborted) return;
        if (outcome.status === 'cancelled') {
          setBusy(false);
          return;
        }
        if (outcome.status === 'verified') {
          const detailForFocus = page.detail;
          ui.toastSuccess(outcome.message);
          applyOutcomeItem({ ...outcome, item: outcome.item }, { replacesItem: true });
          modal.close();
          restoreHistoryDetailActionFocus({
            detail: detailForFocus,
            action: state.restore ? 'restore-current-output' : 'rerender',
            isActive: () => !page.destroyed && page.detail === detailForFocus,
          });
          if (page.detail) setDetailStatus(outcome.message, 'ok');
          return;
        }
        setBusy(false);
        if (outcome.status === 'unknown' || outcome.status === 'committed_unverified') {
          setStatus(`${outcome.message} `, 'warn');
          const queryBtn = el('button', 'btn btn-ghost btn-sm', '查询结果');
          queryBtn.type = 'button';
          queryBtn.addEventListener('click', () => {
            const detailForFocus = page.detail;
            openEvidenceModal(outcome.actionId, {
              kind: 'history_rerender',
              item,
              onVerified: () => {
                if (page.destroyed
                  || state.controller.signal.aborted
                  || page.detail !== detailForFocus) return;
                const message = state.restore ? '恢复结果已核验。' : '重渲染保存结果已核验。';
                ui.toastSuccess(message);
                applyOutcomeItem({ ...outcome, item: outcome.item }, { replacesItem: true });
                modal.close();
                restoreHistoryDetailActionFocus({
                  detail: detailForFocus,
                  action: state.restore ? 'restore-current-output' : 'rerender',
                  isActive: () => !page.destroyed && page.detail === detailForFocus,
                });
                if (page.detail === detailForFocus) setDetailStatus(message, 'ok');
              },
            });
          });
          statusLine.appendChild(queryBtn);
          return;
        }
        const code = String(outcome.error?.code || '');
        if (code === 'history_rerender_preview_required') {
          setStatus('预览凭据已过期或已使用;请重新生成预览后再保存。', 'err');
        } else if (code === 'history_rerender_input_changed') {
          setStatus('历史摘要已在保存前变化;旧预览没有写入,请关闭后重新操作。', 'err');
        } else if (code === 'history_source_changed') {
          setStatus('历史记录或原摘要已变化;本次没有写入,请刷新后重新操作。', 'err');
        } else if (code === 'output_dir_changed') {
          setStatus('输出目录已切换;本次没有写入,请刷新历史页后重试。', 'err');
        } else {
          setStatus(outcome.message || '保存失败', 'err');
        }
      } finally {
        page.pendingRerender -= 1;
        if (!page.destroyed && !state.controller.signal.aborted && modal.el?.isConnected) {
          setBusy(false);
          restoreActionFocus(focusTarget, {
            activeElement: globalThis.document?.activeElement,
            body: globalThis.document?.body,
          });
        }
      }
    }

    previewBtn.addEventListener('click', () => { void generatePreview(); });
    saveBtn.addEventListener('click', () => { void commitSave(); });
    previewBtn.disabled = true;
    syncSelectionButtons();
    void loadDigest();
  }

  // -------------------------------------------------------------------------
  // 本地动作证据查询(结果未知时的核对入口)
  // -------------------------------------------------------------------------
  function openEvidenceModal(actionId, { kind = '', item = null, onVerified = null } = {}) {
    if (!actionId) {
      ui.toastWarn('本次操作没有可查询的动作标识。');
      return;
    }
    const wrapBox = el('div', 'history-evidence');
    const statusLine = el('p', 'history-action-status');
    const resultSlot = el('div', 'history-evidence-result');
    const queryBtn = el('button', 'btn btn-ghost btn-sm', '重新查询');
    queryBtn.type = 'button';
    wrapBox.append(el('p', 'muted', `动作标识:${actionId}`), resultSlot, statusLine, queryBtn);
    const evidenceController = new AbortController();
    let lifecycle = null;
    const evidenceModal = openPageModal({
      title: '查询操作结果',
      content: wrapBox,
      onClose: () => {
        if (!evidenceController.signal.aborted) {
          evidenceController.abort(new Error('证据查询已关闭'));
        }
        lifecycle?.close();
      },
    });
    lifecycle = createHistoryEvidenceLifecycle({ isPageActive: () => !page.destroyed });

    const run = async () => {
      const operation = lifecycle.begin();
      queryBtn.disabled = true;
      statusLine.textContent = '正在查询证据…';
      statusLine.className = 'history-action-status';
      try {
        const evidence = await actions.fetchEvidence(actionId, {
          kind,
          item,
          signal: evidenceController.signal,
        });
        if (!lifecycle.accepts(operation)) return;
        resultSlot.replaceChildren();
        if (evidence) {
          const list = el('dl', 'history-evidence-list');
          const rows = [
            ['类型', evidence.kind],
            ['状态', evidence.action_state],
            ['已提交', evidence.local_action_committed === true ? '是' : '否'],
            ['已核验', evidence.verified === true || evidence.clipboard_verified === true ? '是' : ''],
            ['目标文件', evidence.relative_path],
            ['提交后说明', evidence.local_action_after_commit_error || evidence.local_action_after_commit_reason],
            ['证据已持久化', evidence.evidence_persisted === true ? '是' : ''],
          ];
          for (const [label, value] of rows) {
            if (!value) continue;
            list.appendChild(kv(label, String(value)));
          }
          resultSlot.appendChild(list);
        }
        const verdict = classifyHistoryEvidence(evidence);
        statusLine.textContent = verdict.text;
        statusLine.className = `history-action-status ${verdict.tone}`;
        if (typeof onVerified === 'function' && lifecycle.claimVerified(operation, evidence)) {
          evidenceModal.close();
          onVerified(evidence);
        }
      } catch (error) {
        if (!lifecycle.accepts(operation)) return;
        statusLine.textContent = `查询失败:${error?.message || '未知错误'}`;
        statusLine.className = 'history-action-status err';
      } finally {
        if (lifecycle.accepts(operation)) queryBtn.disabled = false;
      }
    };
    queryBtn.addEventListener('click', () => { void run(); });
    void run();
  }

  // -------------------------------------------------------------------------
  // 跨标签联动(localStorage 广播;其他标签页操作后本页重新核对)
  // -------------------------------------------------------------------------
  function abortCrossTabListItemRefreshes() {
    for (const controller of page.crossTabRefreshes.values()) controller.abort();
    page.crossTabRefreshes.clear();
  }

  function invalidateCrossTabListRequests() {
    page.listSeq += 1;
    page.listController?.abort();
    page.moreController?.abort();
    abortCrossTabListItemRefreshes();
  }

  function scheduleCrossTabListReload() {
    if (page.destroyed) return;
    if (page.crossTabReloadTimer !== null) clearTimeout(page.crossTabReloadTimer);
    const timer = setTimeout(() => {
      if (page.crossTabReloadTimer !== timer) return;
      page.crossTabReloadTimer = null;
      if (page.destroyed) return;
      void (async () => {
        const loaded = await loadFirstPage({ refresh: true });
        if (!loaded) return;
        if (!page.destroyed && !page.detail) await restorePersistedFocus();
      })();
    }, 180);
    page.crossTabReloadTimer = timer;
  }

  function queueCrossTabListItemRefresh(item) {
    const key = itemKey(item);
    if (!key) return;
    page.crossTabRefreshes.get(key)?.abort();
    const controller = new AbortController();
    page.crossTabRefreshes.set(key, controller);
    void refreshItemStatus(item, { silent: true, signal: controller.signal }).finally(() => {
      if (page.crossTabRefreshes.get(key) === controller) page.crossTabRefreshes.delete(key);
    });
  }

  function refreshCrossTabListItemAt(index) {
    const item = page.items[index];
    if (item) queueCrossTabListItemRefresh(item);
    else scheduleCrossTabListReload();
  }

  function broadcastItemUpdate(item, { deletedKey = '' } = {}) {
    try {
      localStorage.setItem(CROSS_TAB_KEY, JSON.stringify({
        key: item ? itemKey(item) : deletedKey,
        deleted: !item && !!deletedKey,
        at: Date.now(),
      }));
    } catch {}
  }

  function onStorageEvent(event) {
    if (page.destroyed || event.key !== CROSS_TAB_KEY || !event.newValue) return;
    let note = null;
    try { note = JSON.parse(event.newValue); } catch { return; }
    const key = String(note?.key || '').trim();
    if (!key) return;
    const index = page.items.findIndex(entry => itemKey(entry) === key);
    if (note.deleted === true) {
      invalidateCrossTabListRequests();
      const detailDeleted = invalidateHistoryDetailForDeletedItem({
        detail: page.detail,
        deletedKey: key,
        itemKey,
      });
      if (detailDeleted) closeDetail();
      if (index >= 0) {
        removeHistoryListItemAt(index);
        renderAll();
      }
      scheduleCrossTabListReload();
      if (detailDeleted) {
        closeAllModals();
        ui.toastWarn('这条历史已在另一个页面被删除。');
        const schedule = globalThis.requestAnimationFrame || (callback => setTimeout(callback, 0));
        schedule(() => {
          if (!page.destroyed && !page.detail) pageTitle.focus({ preventScroll: true });
        });
      }
      return;
    }
    // 只重新核对该条,失败静默。
    queueHistoryCrossTabItemRefresh({
      detail: page.detail,
      updatedKey: key,
      itemKey,
      refreshListItem: () => refreshCrossTabListItemAt(index),
    });
  }

  async function restorePersistedFocus() {
    const listSeq = page.listSeq;
    const focusKey = page.focusKey;
    const focusAction = page.focusAction;
    const restorationIsCurrent = () => !page.destroyed
      && page.listSeq === listSeq
      && page.focusKey === focusKey
      && page.focusAction === focusAction
      && !page.detail
      && historyInitialFocusCanRestore({ pageTitle });
    if (page.status !== 'ready' || !focusKey || !focusAction || !restorationIsCurrent()) return;
    const result = await restoreHistoryListFocus({
      focusKey,
      focusAction,
      findTarget: (focusKey, focusAction) => findHistoryFocusTarget(grid, focusKey, focusAction),
      canLoadMore: () => page.status === 'ready'
        && (page.searchScanHasMore ? !!page.nextSearchCursor : page.hasMore),
      loadMore,
      isActive: restorationIsCurrent,
      focusHeading: () => pageTitle.focus({ preventScroll: true }),
    });
    if (result.status === 'missing' && restorationIsCurrent()) {
      page.focusKey = '';
      page.focusAction = '';
      saveViewPrefs();
    }
  }

  function startInitialHistoryLoad() {
    void loadFirstPage().then(async loaded => {
      if (!loaded || page.destroyed || !historyInitialFocusCanRestore({ pageTitle })) return;
      await restorePersistedFocus();
    }).catch(error => {
      if (!page.destroyed) console.error('history initial load settlement failed', error);
    });
  }

  // -------------------------------------------------------------------------
  // 事件绑定与生命周期
  // -------------------------------------------------------------------------
  function syncToolbar() {
    for (const btn of filterSegmented.querySelectorAll('[data-filter-value]')) {
      setSegmentedButtonState(btn, btn.dataset.filterValue === page.filter);
    }
    for (const btn of accountSegmented.querySelectorAll('[data-account-value]')) {
      setSegmentedButtonState(btn, btn.dataset.accountValue === page.accountScope);
    }
    if (searchInput.value !== page.q) searchInput.value = page.q;
  }

  function searchDraftPending() {
    return searchInput.value.trim() !== page.q;
  }

  function commitSearchDraft() {
    if (page.searchTimer) {
      clearTimeout(page.searchTimer);
      page.searchTimer = null;
    }
    const next = searchInput.value.trim();
    if (next === page.q) return false;
    page.q = next;
    saveViewPrefs();
    return true;
  }

  function scheduleSearchCommit() {
    if (page.searchTimer) clearTimeout(page.searchTimer);
    const timer = setTimeout(() => {
      if (page.destroyed || page.searchTimer !== timer) return;
      page.searchTimer = null;
      if (commitSearchDraft()) void loadFirstPage({ clearItems: true });
    }, SEARCH_DEBOUNCE_MS);
    page.searchTimer = timer;
  }

  function wireEvents() {
    searchInput.addEventListener('input', () => {
      scheduleSearchCommit();
      renderMore();
    });
    searchInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (commitSearchDraft()) void loadFirstPage({ clearItems: true });
      }
    });
    filterSegmented.addEventListener('click', event => {
      const btn = event.target.closest('[data-filter-value]');
      if (!btn || btn.dataset.filterValue === page.filter) return;
      commitSearchDraft();
      page.filter = btn.dataset.filterValue;
      saveViewPrefs();
      syncToolbar();
      void loadFirstPage({ clearItems: true });
    });
    accountSegmented.addEventListener('click', event => {
      const btn = event.target.closest('[data-account-value]');
      if (!btn || btn.dataset.accountValue === page.accountScope) return;
      commitSearchDraft();
      page.accountScope = btn.dataset.accountValue;
      saveViewPrefs();
      syncToolbar();
      void loadFirstPage({ clearItems: true });
    });
    refreshBtn.addEventListener('click', () => {
      const searchChanged = commitSearchDraft();
      void loadFirstPage({ refresh: true, clearItems: searchChanged });
    });
    moreBtn.addEventListener('click', () => {
      if (commitSearchDraft()) {
        void loadFirstPage({ clearItems: true });
        return;
      }
      void loadMore();
    });
    grid.addEventListener('focusin', () => {
      const snapshot = historyListFocusSnapshot(grid);
      if (!snapshot) return;
      page.focusKey = snapshot.focusKey;
      page.focusAction = snapshot.focusAction;
      saveViewPrefs();
    });

    page.unsubscribers.push(store.subscribe('account', account => {
      if (page.destroyed) return;
      const change = page.accountContext.update(account);
      if (!change.changed) return;
      const nextAccountId = accountIdOf(account);
      page.accountId = nextAccountId;
      if (page.accountScope !== 'current') return;
      closeDetail();
      closeAllModals();
      page.focusKey = '';
      page.focusAction = '';
      saveViewPrefs();
      void loadFirstPage({ clearItems: true });
    }));
    window.addEventListener('storage', onStorageEvent);
    page.unsubscribers.push(() => window.removeEventListener('storage', onStorageEvent));
  }

  return {
    isBusy: () => page.detail?.busy === true || page.pendingRerender > 0,

    async confirmLeaveWhileBusy() {
      const confirmed = await ui.confirmDialog({
        title: '操作仍在进行',
        message: '有本机操作还没返回结果;离开页面后可在历史页重新核对。确定离开?',
        confirmLabel: '离开',
        danger: true,
      });
      return confirmed;
    },

    async init() {
      store.set('accountSwitchGuard', accountSwitchGuard);
      restoreViewPrefs();
      syncToolbar();
      wireEvents();
      renderAll();
      startInitialHistoryLoad();
    },

    async destroy() {
      if (page.destroyed) return;
      commitSearchDraft();
      saveViewPrefs({ captureFocus: true });
      page.destroyed = true;
      page.generation += 1;
      if (!pageAbort.signal.aborted) pageAbort.abort(new Error('页面已卸载'));
      if (store.get('accountSwitchGuard') === accountSwitchGuard) {
        store.set('accountSwitchGuard', null);
      }
      if (page.searchTimer) clearTimeout(page.searchTimer);
      page.searchTimer = null;
      if (page.crossTabReloadTimer !== null) {
        clearTimeout(page.crossTabReloadTimer);
        page.crossTabReloadTimer = null;
      }
      clearAutoDiscoveryTimer();
      if (page.listController) page.listController.abort();
      if (page.moreController) page.moreController.abort();
      abortCrossTabListItemRefreshes();
      page.thumbController.abort();
      thumbnailQueue.dispose();
      page.detail?.controller.abort();
      for (const unsubscribe of page.unsubscribers.splice(0)) {
        try { unsubscribe(); } catch {}
      }
      for (const state of page.thumbs.values()) {
        if (state?.url) {
          try { URL.revokeObjectURL(state.url); } catch {}
        }
      }
      page.thumbs.clear();
      // 关闭详情弹层:先停定时器与核对请求,再关 modal;其余弹层(查看器/重渲染/证据)统一关闭。
      const detail = page.detail;
      page.detail = null;
      if (detail) {
        clearDetailTimers(detail);
        detail.modal.close({ restoreFocus: false });
      }
      closeAllModals({ restoreFocus: false });
    },
  };
}
