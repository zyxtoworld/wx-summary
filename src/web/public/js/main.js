// 应用壳入口:bootstrap(主题/会话/状态/账号)→ 挂载路由。
// 只做壳层职责;页面逻辑都在 /js/pages/*/index.js。
import { initTheme, getTheme, onThemeChange, setTheme } from './theme.js';
import { createStore } from './store.js';
import { createRouter } from './router.js';
import { createProductionRoutes } from './production-routes.js';
import { createApi } from './api.js';
import { assetReloadGuardKey, createAssetReloadCoordinator } from './asset-reload.js';
import { createFatalNotices } from './fatal-notices.js';
import { accountSwitchLoadingMessage, createAccountSelectionController, focusAccountMenuOption } from './shared/account-selection.js';
import { findPublicAccountByIdentity, requirePublicAccountList } from './shared/account-context.js';
import { createReplaceableNotice } from './shared/replaceable-notice.js';
import { requireServiceStatePayload } from './shared/service-state.js';
import * as ui from './ui/index.js';
import * as session from './session.js';
import { setSegmentedButtonState } from './ui/segmented.js';

const boot = window.__WX_BOOT__ || {};
const ASSET_VERSION = String(boot.assetVersion || '').trim();
const CONFIRMED_ACCOUNT_STORAGE_KEY = 'wx-summary:confirmed-account-id';

initTheme();

// ---------------------------------------------------------------------------
// 版本闸门:409 stale_frontend_asset → 守卫式重载(防重载死循环);
// 409 service_restart_required → 提示重启服务。
// ---------------------------------------------------------------------------
const fatalNotices = createFatalNotices({
  openModal: options => ui.openModal(options),
  reload: () => location.reload(),
  beforeRestartReload: () => {
    try { sessionStorage.removeItem(assetReloadGuardKey(ASSET_VERSION)); } catch {}
  },
});

const requestGuardedAssetReload = createAssetReloadCoordinator({
  assetVersion: ASSET_VERSION,
  // /api/state 不在版本闸门内,用它拿服务端当前版本。
  readState: async () => requireServiceStatePayload(
    await api.get('/api/state', { timeoutMs: 15000 }),
  ),
  storage: sessionStorage,
  showRestartRequiredNotice: () => fatalNotices.showRestartRequiredNotice(),
  showReloadScheduledNotice: () => {
    ui.toast('页面资源已更新,正在刷新…', { type: 'info', duration: 1200 });
  },
  showManualReloadNotice: () => {
    ui.toastError('页面资源需要手动刷新,请刷新页面(Ctrl+R)。', { duration: 0 });
  },
  scheduleReload: () => setTimeout(() => location.reload(), 300),
});

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------
const store = createStore({
  state: null,        // /api/state 响应
  stateAccountContext: null, // 最近一次按账号读取的 /api/state 绑定
  accounts: [],       // /api/accounts 响应
  account: null,      // 当前选中的 publicAccount
  // 路由页面尚未挂载时也要 fail-closed,避免账号菜单抢在页面守卫注册前切换。
  accountSwitchGuard: accountSwitchLoadingMessage(),
});

const api = createApi({
  assetVersion: ASSET_VERSION,
  onStaleAsset(code) {
    if (code === 'service_restart_required') fatalNotices.showRestartRequiredNotice();
    else void requestGuardedAssetReload();
  },
  onSessionInvalid() {
    fatalNotices.showSessionInvalidNotice();
  },
});

const appEl = document.getElementById('app');

function renderBootFailure(error) {
  const message = String(error?.message || error || '未知错误');
  appEl.replaceChildren();
  const section = document.createElement('section');
  section.className = 'boot-failure';
  const title = document.createElement('h2');
  title.textContent = '无法连接本地服务';
  const detail = document.createElement('p');
  detail.textContent = message;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'btn btn-primary';
  retry.textContent = '重新检查';
  retry.addEventListener('click', () => location.reload());
  section.append(title, detail, retry);
  appEl.appendChild(section);
}

// ---------------------------------------------------------------------------
// 账号切换器
// ---------------------------------------------------------------------------
function accountDisplayName(account) {
  return String(account?.display_name || account?.name || account?.wxid || account?.id || '未命名账号');
}

function accountInitial(account) {
  const name = accountDisplayName(account);
  return [...name][0] || '微';
}

function confirmedAccountId() {
  try { return String(localStorage.getItem(CONFIRMED_ACCOUNT_STORAGE_KEY) || '').trim(); } catch { return ''; }
}

function rememberConfirmedAccountId(id) {
  try {
    if (id) localStorage.setItem(CONFIRMED_ACCOUNT_STORAGE_KEY, id);
    else localStorage.removeItem(CONFIRMED_ACCOUNT_STORAGE_KEY);
  } catch {}
}

let accountStateRequestEpoch = 0;
let latestAccountStateRefresh = Promise.resolve(null);
let accountStateRequestController = null;

async function waitForLatestAccountStateRefresh() {
  while (true) {
    const owner = latestAccountStateRefresh;
    const state = await owner;
    if (owner === latestAccountStateRefresh) return state;
  }
}

function shellAccountId(account) {
  return String(account?.id || account?.account_id || '').trim();
}

function shellAccountFingerprint(account) {
  return String(account?.manual_key_account_fingerprint || '').trim().toLowerCase();
}

function shellAccountContextIdentity(account) {
  return `${shellAccountId(account)}|${shellAccountFingerprint(account)}`;
}

function shellStateMatchesAccount(state, account) {
  const accountId = shellAccountId(account);
  if (!accountId) return false;
  const stateAccounts = Array.isArray(state?.wechat?.accounts)
    ? state.wechat.accounts
    : [];
  const stateAccount = stateAccounts.find(candidate => shellAccountId(candidate) === accountId);
  if (!stateAccount) return false;
  const expectedFingerprint = shellAccountFingerprint(account);
  return shellAccountFingerprint(stateAccount) === expectedFingerprint;
}

function shellStoredStateMatchesAccount(account) {
  const accountId = shellAccountId(account);
  const context = store.get('stateAccountContext') || {};
  return !!accountId
    && String(context.accountId || '').trim() === accountId
    && String(context.accountFingerprint || '').trim().toLowerCase()
      === shellAccountFingerprint(account)
    && shellStateMatchesAccount(store.get('state'), account);
}

async function refreshStateForAccount(account, retry = 0) {
  const epoch = ++accountStateRequestEpoch;
  const accountId = shellAccountId(account);
  const accountIdentity = shellAccountContextIdentity(account);
  const exactStoredState = () => {
    const state = store.get('state');
    const context = store.get('stateAccountContext') || {};
    return String(context.accountId || '').trim() === accountId
      && String(context.accountFingerprint || '').trim().toLowerCase()
        === shellAccountFingerprint(account)
      && shellStateMatchesAccount(state, account)
      ? state
      : null;
  };
  const retainedState = retry > 0 ? exactStoredState() : null;
  const previousController = accountStateRequestController;
  accountStateRequestController = null;
  if (previousController && !previousController.signal.aborted) {
    const reason = new Error('账号状态请求已被新账号上下文取代');
    reason.name = 'AbortError';
    reason.status = 499;
    previousController.abort(reason);
  }
  if (!retainedState) {
    store.set('stateAccountContext', null);
    store.set('state', null);
  }
  if (!accountId) return null;
  const requestStateOwner = store.get('state');
  const requestContextOwner = store.get('stateAccountContext');
  const stateAdoptedByNewOwner = () => {
    if (store.get('state') === requestStateOwner
      && store.get('stateAccountContext') === requestContextOwner) return null;
    return exactStoredState();
  };
  const controller = new AbortController();
  accountStateRequestController = controller;
  try {
    const nextState = requireServiceStatePayload(
      await api.get(`/api/state?account=${encodeURIComponent(accountId)}`, {
        signal: controller.signal,
        timeoutMs: 30_000,
      }),
    );
    if (epoch !== accountStateRequestEpoch
      || shellAccountContextIdentity(store.get('account')) !== accountIdentity) return null;
    const adoptedState = stateAdoptedByNewOwner();
    if (adoptedState) return adoptedState;
    if (!shellStateMatchesAccount(nextState, account)) {
      if (retry < 1) return refreshStateForAccount(account, retry + 1);
      return retainedState;
    }
    store.set('stateAccountContext', {
      accountId,
      accountFingerprint: shellAccountFingerprint(account),
    });
    store.set('state', nextState);
    return nextState;
  } catch (error) {
    if (epoch === accountStateRequestEpoch
      && shellAccountContextIdentity(store.get('account')) === accountIdentity) {
      console.warn('selected account state refresh failed', error);
      return stateAdoptedByNewOwner() || retainedState;
    }
    return null;
  } finally {
    if (accountStateRequestController === controller) accountStateRequestController = null;
  }
}

async function refreshStateAfterPageRestore() {
  const account = store.get('account');
  if (!account) return null;
  latestAccountStateRefresh = refreshStateForAccount(account);
  return latestAccountStateRefresh;
}

function handlePageShow(event) {
  if (event?.persisted !== true) return;
  void refreshStateAfterPageRestore().catch(error => {
    console.warn('bfcache 页面状态刷新失败', error);
  });
}

window.addEventListener('pageshow', handlePageShow);

let accountRefreshInFlight = null;
let accountRefreshRevision = 0;

// 页面遇到账号数据身份冲突时,只能刷新账号快照;不能拿旧对象重复请求。
// 这里统一替换 store 中的当前账号对象,让所有页面沿同一账号代际重新加载。
async function refreshAccounts({ forceDetect = false } = {}) {
  const requestedForceDetect = forceDetect === true;
  if (accountRefreshInFlight) {
    if (!requestedForceDetect || accountRefreshInFlight.forceDetect) {
      return accountRefreshInFlight.promise;
    }
    // 普通缓存读取不能满足账号上下文冲突后的强制检测。等待当前请求自然
    // 收敛后再经同一入口排队，多个强调用仍只会共享一个后续请求。
    try { await accountRefreshInFlight.promise; } catch {}
    return refreshAccounts({ forceDetect: true });
  }
  const revision = ++accountRefreshRevision;
  const requestAccountOwner = store.get('account');
  const requestAccountsOwner = store.get('accounts');
  const request = (async () => {
    const query = requestedForceDetect ? '?refresh=true' : '';
    const payload = await api.get(`/api/accounts${query}`, { timeoutMs: 30_000 });
    const accounts = requirePublicAccountList(payload);
    if (revision !== accountRefreshRevision
      || store.get('account') !== requestAccountOwner
      || store.get('accounts') !== requestAccountsOwner) {
      return { accounts, account: store.get('account') || null, changed: false };
    }

    const current = store.get('account') || null;
    const currentId = String(current?.id || current?.account_id || '').trim();
    store.set('accounts', accounts);
    let next = current;
    let changed = false;
    if (currentId) {
      next = findPublicAccountByIdentity(accounts, current);
      if (next !== current) {
        changed = true;
        store.set('account', next);
        if (!next) rememberConfirmedAccountId('');
      }
    }
    renderAccountSwitcher();
      return { accounts, account: next, changed };
    })();
  const tracked = { promise: request, forceDetect: requestedForceDetect };
  accountRefreshInFlight = tracked;
  try {
    return await request;
  } finally {
    if (accountRefreshInFlight === tracked) accountRefreshInFlight = null;
  }
}

function pickDefaultAccount(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  if (!list.length) return null;
  const wanted = confirmedAccountId();
  if (wanted) {
    const matched = list.find(account => String(account?.id || account?.account_id || '') === wanted);
    if (matched) return matched;
  }
  return list[0];
}

const accountSelectionNotice = createReplaceableNotice((message, type) => ui.toast(message, { type }));

const accountSelection = createAccountSelectionController({
  store,
  persistConfirmedAccountId: rememberConfirmedAccountId,
  onBlocked: message => accountSelectionNotice.show(message, 'warn'),
  onSelected: account => accountSelectionNotice.show(
    `已切换到账号「${accountDisplayName(account)}」`,
    'success',
  ),
});

function selectAccount(account, { userInitiated = false } = {}) {
  return accountSelection.select(account, { userInitiated });
}

function renderAccountSwitcher() {
  const wrap = document.getElementById('account-switcher');
  const menu = document.getElementById('account-menu');
  const accounts = store.get('accounts', []);
  const current = store.get('account');
  if (!wrap) return;
  // 单账号时隐藏切换菜单但仍展示当前账号。
  wrap.hidden = !accounts.length;
  document.getElementById('account-avatar').textContent = accountInitial(current);
  document.getElementById('account-name').textContent = current ? accountDisplayName(current) : '未检测到账号';
  document.getElementById('account-sub').textContent = accounts.length > 1
    ? `${accounts.length} 个账号,点击切换`
    : (current?.wxid ? `wxid:${current.wxid}` : '当前账号');
  const btn = document.getElementById('account-btn');
  btn.disabled = accounts.length <= 1;
  if (menu) menu.hidden = true;
  btn.setAttribute('aria-expanded', 'false');
  ui.syncToastViewportOffset();
}

// 页面(尤其首次配置向导)可能直接写入共享 store;壳层必须同步账号展示与状态快照。
store.subscribe('account', (account, previous) => {
  renderAccountSwitcher();
  const identityChanged = shellAccountContextIdentity(previous)
    !== shellAccountContextIdentity(account);
  if (!identityChanged && shellStoredStateMatchesAccount(account)) return;
  latestAccountStateRefresh = refreshStateForAccount(account);
  void latestAccountStateRefresh;
});

function toggleAccountMenu(force) {
  const menu = document.getElementById('account-menu');
  const btn = document.getElementById('account-btn');
  if (!menu || !btn) return;
  const open = typeof force === 'boolean' ? force : menu.hidden;
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  if (!open) {
    ui.syncToastViewportOffset();
    return;
  }
  const accounts = store.get('accounts', []);
  const current = store.get('account');
  menu.replaceChildren();
  for (const account of accounts) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'account-menu-item';
    item.setAttribute('role', 'option');
    const selected = current && String(current?.id) === String(account?.id);
    item.setAttribute('aria-selected', String(!!selected));
    const name = document.createElement('span');
    name.className = 'account-menu-name';
    name.textContent = accountDisplayName(account);
    const sub = document.createElement('span');
    sub.className = 'account-menu-sub';
    sub.textContent = [account?.wxid ? `wxid:${account.wxid}` : '', account?.source_status_label || '']
      .filter(Boolean).join(' · ');
    item.append(name, sub);
    if (selected) item.classList.add('selected');
    item.addEventListener('click', () => {
      toggleAccountMenu(false);
      selectAccount(account, { userInitiated: true });
      btn.focus({ preventScroll: true });
    });
    menu.appendChild(item);
  }
  const options = [...menu.querySelectorAll('[role="option"]')];
  const selectedIndex = Math.max(0, options.findIndex(option => option.getAttribute('aria-selected') === 'true'));
  focusAccountMenuOption(options[selectedIndex], options);
  ui.syncToastViewportOffset();
}

function accountMenuOptions() {
  return [...(document.getElementById('account-menu')?.querySelectorAll('[role="option"]') || [])]
    .filter(option => option.disabled !== true && option.hidden !== true);
}

function moveAccountMenuFocus(delta) {
  const options = accountMenuOptions();
  if (!options.length) return;
  const active = document.activeElement;
  const current = options.indexOf(active);
  const start = current >= 0 ? current : Math.max(0, options.findIndex(option => option.getAttribute('aria-selected') === 'true'));
  const next = (start + delta + options.length) % options.length;
  focusAccountMenuOption(options[next], options);
}

function closeAccountMenuAndRestoreFocus() {
  toggleAccountMenu(false);
  document.getElementById('account-btn')?.focus({ preventScroll: true });
}

function wireAccountSwitcher() {
  const btn = document.getElementById('account-btn');
  const menu = document.getElementById('account-menu');
  btn?.addEventListener('click', () => toggleAccountMenu());
  btn?.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      toggleAccountMenu(true);
      if (event.key === 'ArrowUp') moveAccountMenuFocus(-1);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAccountMenuAndRestoreFocus();
    }
  });
  menu?.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveAccountMenuFocus(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveAccountMenuFocus(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      const options = accountMenuOptions();
      focusAccountMenuOption(options[0], options);
    } else if (event.key === 'End') {
      event.preventDefault();
      const options = accountMenuOptions();
      focusAccountMenuOption(options.at(-1), options);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeAccountMenuAndRestoreFocus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      const option = event.target?.closest?.('[role="option"]');
      if (option) {
        event.preventDefault();
        option.click();
      }
    }
  });
  menu?.addEventListener('focusout', () => {
    // focusout 早于鼠标 click；延后一拍可避免点账号按钮关闭时被再次打开。
    setTimeout(() => {
      if (!menu.hidden && !menu.contains(document.activeElement)) toggleAccountMenu(false);
    }, 0);
  });
  document.addEventListener('click', event => {
    const wrap = document.getElementById('account-switcher');
    if (wrap && !wrap.contains(event.target)) toggleAccountMenu(false);
  });
}

// ---------------------------------------------------------------------------
// 主题切换按钮
// ---------------------------------------------------------------------------
function syncThemeButtons() {
  const current = getTheme();
  for (const btn of document.querySelectorAll('.theme-btn[data-theme-value]')) {
    setSegmentedButtonState(btn, btn.dataset.themeValue === current);
  }
}

function wireThemeSwitch() {
  onThemeChange(syncThemeButtons);
  for (const btn of document.querySelectorAll('.theme-btn[data-theme-value]')) {
    btn.addEventListener('click', () => {
      setTheme(btn.dataset.themeValue);
    });
  }
  syncThemeButtons();
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
async function bootstrap() {
  wireThemeSwitch();
  wireAccountSwitcher();

  try {
    await session.ensureSessionToken({ assetVersion: ASSET_VERSION });
  } catch (error) {
    renderBootFailure(error);
    return;
  }

  const router = createRouter({
    root: appEl,
    ctx: {
      api,
      store,
      ui,
      session,
      refreshAccounts,
      navigate: target => router.navigate(target),
    },
    routes: createProductionRoutes(),
    onRouteLoading: name => {
      store.set('accountSwitchGuard', accountSwitchLoadingMessage(name));
    },
    onRouteLoadingFailure: name => {
      const loadingGuard = accountSwitchLoadingMessage(name);
      if (store.get('accountSwitchGuard') === loadingGuard) {
        store.set('accountSwitchGuard', null);
      }
    },
  });

  // 初始状态:失败不阻塞页面,页面自己处理空态。
  let state = null;
  let selectedAccountStateUnavailable = false;
  try {
    state = requireServiceStatePayload(await api.get('/api/state'));
    store.set('state', state);
  } catch (error) {
    console.error('initial /api/state failed', error);
    ui.toastError(error?.message || '获取服务状态失败');
  }

  try {
    const accounts = requirePublicAccountList(await api.get('/api/accounts'));
    store.set('accounts', accounts);
    const selectedAccount = pickDefaultAccount(store.get('accounts', []));
    selectAccount(selectedAccount);
    if (selectedAccount) {
      state = await waitForLatestAccountStateRefresh();
      selectedAccountStateUnavailable = !state;
      if (selectedAccountStateUnavailable) {
        ui.toastError('无法确认当前账号状态，已进入配置向导重新检测。');
      }
    }
  } catch (error) {
    console.error('initial /api/accounts failed', error);
    store.set('accounts', []);
    renderAccountSwitcher();
    renderBootFailure(error);
    return;
  }

  // 需要首次配置时优先进入向导。
  if (state?.need_setup || selectedAccountStateUnavailable) {
    router.navigate('#/setup', { replace: true });
  }
  router.start();
}

void bootstrap();
