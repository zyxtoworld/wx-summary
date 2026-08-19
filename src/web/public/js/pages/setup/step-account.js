// 第 1 步:欢迎 + 确认微信账号。
// 契约(src/main.js):
// - GET /api/accounts 返回 publicAccount 裸数组;?refresh=true 强制重新检测。
// - GET /api/state(?refresh=1&account=<id>):单账号自动选中;多账号未带 account 时
//   wechat.account_selection_required === true,必须让用户明确选择。
// - 确认账号只写 localStorage wx-summary:confirmed-account-id + 更新 store,不发 POST。
import {
  applyWizardAccountState,
  accountIdOf,
  accountFingerprintOf,
  accountDisplayName,
  bindWizardAccountContext,
  findAccountByAnyId,
  stateMatchesAccountContext,
} from './state.js';
import { configureLiveRegion } from '/js/ui/live-region.js';
import { requirePublicAccountList } from '/js/shared/account-context.js';
import { requireServiceStatePayload } from '/js/shared/service-state.js';
import { configureSetupAccountRadioGroup } from './account-radio-group.js';

const CONFIRMED_ACCOUNT_STORAGE_KEY = 'wx-summary:confirmed-account-id';

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function rememberConfirmedAccountId(id) {
  try {
    if (id) localStorage.setItem(CONFIRMED_ACCOUNT_STORAGE_KEY, id);
    else localStorage.removeItem(CONFIRMED_ACCOUNT_STORAGE_KEY);
  } catch {}
}

function accountContextIdentity(account) {
  return `${accountIdOf(account)}|${accountFingerprintOf(account)}`;
}

export function createAccountStep(w) {
  const { ctx } = w;
  const root = el('div', 'setup-section');
  root.append(
    el('h2', 'setup-title', '欢迎使用微信群总结'),
    el('p', 'setup-desc',
      '这个工具在本机读取你的微信群消息,交给 AI 生成重点摘要,全部数据保存在本机。'
      + '首次使用需要四步:确认微信账号、接入 AI、验证数据库读取、浏览群列表。'),
  );

  // 微信运行状态区
  const wechatBox = el('div', 'setup-section');
  const wechatStatus = configureLiveRegion(el('div', 'setup-status'));
  wechatBox.append(wechatStatus);

  // 账号选择区
  const accountSection = el('div', 'setup-section');
  accountSection.append(el('div', 'setup-section-title', '选择要总结的微信账号'));
  const accountList = el('div', 'setup-account-list');
  const accountRadioGroup = configureSetupAccountRadioGroup(accountList);
  const accountHint = el('p', 'muted', '');
  const accountActions = el('div', 'setup-subtle-actions');
  const refreshAccountsBtn = el('button', 'btn btn-ghost btn-sm', '刷新账号列表');
  refreshAccountsBtn.type = 'button';
  accountActions.append(refreshAccountsBtn);
  accountSection.append(accountList, accountActions, accountHint);
  root.append(wechatBox, accountSection);

  let selectedId = accountIdOf(w.wiz.account);
  const initialStateReady = Boolean(w.wiz.stateAccountId)
    && accountIdOf(w.wiz.account) === String(w.wiz.stateAccountId || '').trim()
    && stateMatchesAccountContext(w.wiz.state, w.wiz.account);
  let stateReadyIdentity = initialStateReady
    ? accountContextIdentity(w.wiz.account)
    : '';
  let loading = false;
  let loadEpoch = 0;
  let stateLoadError = '';
  let activeLoad = null;

  function setStatus(kind, text) {
    wechatStatus.className = `setup-status${kind ? ` setup-status-${kind}` : ''}`;
    wechatStatus.replaceChildren();
    if (!text) return;
    const icon = el('span', 'setup-status-icon', { ok: '✓', warn: '⚠', err: '✗', info: '…' }[kind] || '');
    wechatStatus.append(icon, el('span', 'setup-status-text', text));
  }

  function abortActiveLoad(message = '账号步骤刷新已取消') {
    const operation = activeLoad;
    if (!operation) return false;
    activeLoad = null;
    operation.detachPageAbort?.();
    if (!operation.controller.signal.aborted) {
      operation.controller.abort(Object.assign(new Error(message), {
        name: 'AbortError',
        status: 499,
      }));
    }
    return true;
  }

  function beginLoad() {
    abortActiveLoad('账号步骤刷新已被新一代替换');
    loading = true;
    loadEpoch += 1;
    refreshAccountsBtn.disabled = true;
    paintAccounts();
    w.refreshButtons();
    const controller = new AbortController();
    const operation = {
      epoch: loadEpoch,
      token: w.beginAsync(),
      controller,
      detachPageAbort: null,
    };
    const onPageAbort = () => {
      if (controller.signal.aborted) return;
      controller.abort(w.signal?.reason || Object.assign(new Error('向导页面已卸载'), {
        name: 'AbortError',
        status: 499,
      }));
    };
    if (w.signal?.aborted) onPageAbort();
    else if (typeof w.signal?.addEventListener === 'function') {
      w.signal.addEventListener('abort', onPageAbort, { once: true });
      operation.detachPageAbort = () => w.signal.removeEventListener('abort', onPageAbort);
    } else {
      operation.detachPageAbort = () => {};
    }
    activeLoad = operation;
    return operation;
  }

  function loadIsCurrent(operation, accountId = selectedId, expectedAccount = null) {
    return !operation.controller.signal.aborted
      && w.alive(operation.token)
      && operation.epoch === loadEpoch
      && String(accountId || '') === selectedId
      && (!expectedAccount
        || accountContextIdentity(w.wiz.account) === accountContextIdentity(expectedAccount));
  }

  function finishLoad(operation, { restoreSelectedFocus = false } = {}) {
    operation.detachPageAbort?.();
    if (activeLoad === operation) activeLoad = null;
    if (operation.epoch !== loadEpoch || w.destroyed) return;
    loading = false;
    refreshAccountsBtn.disabled = false;
    paintAccounts();
    paintSelectionHint();
    w.refreshButtons();
    if (restoreSelectedFocus
      && (!document.activeElement?.isConnected || document.activeElement === document.body)) {
      accountList.querySelector('[role="radio"][aria-checked="true"]')?.focus({ preventScroll: false });
    }
  }

  function paintAccounts() {
    accountList.replaceChildren();
    const accounts = Array.isArray(w.wiz.accounts) ? w.wiz.accounts : [];
    if (!accounts.length) {
      accountList.append(el('p', 'muted', '暂未检测到本机微信账号。'));
      accountRadioGroup.syncTabStops();
      return;
    }
    for (const account of accounts) {
      const id = accountIdOf(account);
      const option = el('button', 'setup-account-option');
      option.type = 'button';
      option.disabled = loading;
      option.setAttribute('role', 'radio');
      const selected = !!selectedId && id === selectedId;
      option.classList.toggle('selected', selected);
      option.setAttribute('aria-checked', String(selected));
      const name = accountDisplayName(account);
      const avatar = el('span', 'setup-account-avatar', [...name][0] || '微');
      const meta = el('span', 'setup-account-meta');
      meta.append(el('span', 'setup-account-name', name));
      const sub = [
        account?.wxid ? `wxid:${account.wxid}` : '',
        account?.source_status_label || '',
      ].filter(Boolean).join(' · ');
      meta.append(el('span', 'setup-account-sub', sub || '当前账号'));
      const check = el('span', 'setup-account-check', '✓');
      option.append(avatar, meta, check);
      option.addEventListener('click', () => {
        void selectAccount(account, { restoreSelectedFocus: true });
      });
      accountList.appendChild(option);
    }
    accountRadioGroup.syncTabStops();
  }

  function paintSelectionHint() {
    const selectionRequired = w.wiz.state?.wechat?.account_selection_required === true;
    const accounts = Array.isArray(w.wiz.accounts) ? w.wiz.accounts : [];
    if (selectedId) {
      if (loading || stateReadyIdentity !== accountContextIdentity(w.wiz.account)) {
        accountHint.textContent = stateLoadError
          ? '所选账号状态读取失败;请点击“刷新账号列表”后重试。'
          : '正在读取所选账号状态,完成后才能继续。';
        return;
      }
      accountHint.textContent = selectionRequired
        ? '已确认当前账号;服务端检测到多个可读账号,后续操作都会使用这个账号。'
        : '';
      return;
    }
    accountHint.textContent = accounts.length > 1 || selectionRequired
      ? '检测到多个微信账号,请选择一个后再继续。'
      : '';
  }

  async function refreshSelectedAccountState(account, { restoreSelectedFocus = false } = {}) {
    const accountId = accountIdOf(account);
    if (!accountId) return false;
    stateLoadError = '';
    const operation = beginLoad();
    setStatus('info', '正在读取所选账号状态…');
    try {
      const state = requireServiceStatePayload(await ctx.api.get(
        `/api/state?refresh=1&account=${encodeURIComponent(accountId)}`,
        { signal: operation.controller.signal },
      ));
      if (!loadIsCurrent(operation, accountId, account)) return false;
      if (!stateMatchesAccountContext(state, account)) {
        stateReadyIdentity = '';
        w.wiz.stateAccountId = '';
        stateLoadError = '账号状态已变化,请刷新账号列表后重试。';
        setStatus('err', stateLoadError);
        return false;
      }
      applyWizardAccountState(ctx.store, w.wiz, state, account);
      stateReadyIdentity = accountContextIdentity(account);
      paintWechatStatus();
      stateLoadError = '';
      return true;
    } catch (error) {
      if (!loadIsCurrent(operation, accountId, account)
        || error?.name === 'AbortError'
        || error?.status === 499) return false;
      stateReadyIdentity = '';
      w.wiz.stateAccountId = '';
      stateLoadError = error?.message || '读取所选账号状态失败。';
      setStatus('err', `${stateLoadError} 请刷新账号列表后重试。`);
      return false;
    } finally {
      finishLoad(operation, { restoreSelectedFocus });
    }
  }

  async function selectAccount(account, { restoreSelectedFocus = false } = {}) {
    if (loading || !account) return false;
    const id = accountIdOf(account);
    if (!id) return false;
    const changed = bindWizardAccountContext(w.wiz, account, ctx.store);
    selectedId = id;
    if (stateReadyIdentity !== accountContextIdentity(w.wiz.account)) {
      stateReadyIdentity = '';
      w.wiz.state = null;
      w.wiz.stateAccountId = '';
    }
    rememberConfirmedAccountId(id);
    ctx.store.set('account', w.wiz.account);
    paintAccounts();
    w.refreshButtons();
    paintSelectionHint();
    if (changed || stateReadyIdentity !== accountContextIdentity(w.wiz.account)) {
      return await refreshSelectedAccountState(account, { restoreSelectedFocus }) === true;
    }
    return true;
  }

  function paintWechatStatus() {
    const wechat = w.wiz.state?.wechat || null;
    if (!wechat) {
      setStatus('warn', '尚未获取到微信检测状态;请确认本机微信已启动并登录,然后点“重新检测”。');
      return;
    }
    if (wechat.running === true && Number(wechat.account_count || 0) > 0) {
      const warnings = [];
      if (wechat.source_ambiguous_count) warnings.push(`${wechat.source_ambiguous_count} 个账号数据源待确认`);
      if (wechat.source_unreadable_count) warnings.push(`${wechat.source_unreadable_count} 个账号数据源不可读`);
      setStatus(warnings.length ? 'warn' : 'ok',
        `检测到微信正在运行,本机可读账号 ${wechat.account_count} 个。`
        + (warnings.length ? `${warnings.join(';')};可在下一步前刷新账号列表核对。` : ''));
      return;
    }
    const message = String(wechat.message || '').trim();
    setStatus('warn',
      `${message || '未检测到正在运行的微信,或本机还没有可读的微信数据。'}`
      + ' 请先启动微信并登录,稍等消息同步后点“重新检测”。');
  }

  async function refreshAll({ forceDetect = false } = {}) {
    if (loading) return;
    stateLoadError = '';
    const requestAccountId = selectedId;
    const requestAccount = w.wiz.account || null;
    const operation = beginLoad();
    try {
      const accountQuery = requestAccountId ? `&account=${encodeURIComponent(requestAccountId)}` : '';
      const [accounts, statePayload] = await Promise.all([
        ctx.api.get(`/api/accounts${forceDetect ? '?refresh=true' : ''}`, {
          signal: operation.controller.signal,
        }),
        ctx.api.get(`/api/state?refresh=1${accountQuery}`, {
          signal: operation.controller.signal,
        }),
      ]);
      if (!loadIsCurrent(operation, requestAccountId, requestAccount)) return;
      const state = requireServiceStatePayload(statePayload);
      w.wiz.accounts = requirePublicAccountList(accounts);
      ctx.store.set('accounts', w.wiz.accounts);
      // 已选账号可能因重新检测而消失或刷新;存在则用最新对象替换。
      if (requestAccountId) {
        const fresh = findAccountByAnyId(w.wiz.accounts, w.wiz.account)
          || w.wiz.accounts.find(account => accountIdOf(account) === requestAccountId)
          || null;
        bindWizardAccountContext(w.wiz, fresh, ctx.store);
        ctx.store.set('account', w.wiz.account);
        rememberConfirmedAccountId(accountIdOf(fresh));
        selectedId = accountIdOf(fresh);
      } else if (w.wiz.accounts.length === 1) {
        selectedId = accountIdOf(w.wiz.accounts[0]);
        bindWizardAccountContext(w.wiz, w.wiz.accounts[0], ctx.store);
        ctx.store.set('account', w.wiz.account);
        rememberConfirmedAccountId(selectedId);
      }
      const boundAccount = selectedId
        ? findAccountByAnyId(w.wiz.accounts, w.wiz.account)
        : null;
      if (requestAccountId && !stateMatchesAccountContext(state, boundAccount)) {
        stateReadyIdentity = '';
        applyWizardAccountState(ctx.store, w.wiz, null, null);
        paintAccounts();
        paintSelectionHint();
        w.refreshButtons();
        if (boundAccount) {
          void refreshSelectedAccountState(boundAccount);
        } else {
          stateLoadError = '当前账号状态已变化,请刷新账号列表后重试。';
          setStatus('err', stateLoadError);
          paintSelectionHint();
          w.refreshButtons();
        }
        return;
      }
      if (!boundAccount || !stateMatchesAccountContext(state, boundAccount)) {
        stateReadyIdentity = '';
        applyWizardAccountState(ctx.store, w.wiz, null, null);
        paintAccounts();
        paintSelectionHint();
        w.refreshButtons();
        if (boundAccount) {
          void refreshSelectedAccountState(boundAccount);
        } else {
          stateLoadError = '当前账号状态尚未绑定,请刷新账号列表后重试。';
          setStatus('err', stateLoadError);
          paintSelectionHint();
          w.refreshButtons();
        }
        return;
      }
      applyWizardAccountState(ctx.store, w.wiz, state, boundAccount);
      stateReadyIdentity = accountContextIdentity(boundAccount);
      paintWechatStatus();
      paintAccounts();
      paintSelectionHint();
      w.refreshButtons();
    } catch (error) {
      if (!loadIsCurrent(operation, requestAccountId, requestAccount)) return;
      if (error?.name === 'AbortError' || error?.status === 499) return;
      // 账号上下文失效(409 account_context_changed):清空选择,提示重新选择。
      if (error?.status === 409 && error?.code === 'account_context_changed') {
        selectedId = '';
        stateReadyIdentity = '';
        bindWizardAccountContext(w.wiz, null, ctx.store);
        w.wiz.stateAccountId = '';
        ctx.store.set('account', null);
        rememberConfirmedAccountId('');
        setStatus('warn', error.message || '当前微信账号已变化,请刷新账号列表后重新选择。');
        paintAccounts();
        paintSelectionHint();
        w.refreshButtons();
        return;
      }
      stateReadyIdentity = '';
      w.wiz.stateAccountId = '';
      stateLoadError = error?.message || '检测微信状态失败,请稍后重试。';
      setStatus('err', stateLoadError);
    } finally {
      finishLoad(operation);
    }
  }

  refreshAccountsBtn.addEventListener('click', () => {
    void refreshAll({ forceDetect: true });
  });

  // “重新检测”与“刷新账号列表”是同一个动作:强制重新检测 + 拉状态。
  function paint() {
    paintWechatStatus();
    paintAccounts();
    paintSelectionHint();
    // 状态里明确提示微信未运行时,把刷新按钮文案改成“重新检测”。
    const wechat = w.wiz.state?.wechat || null;
    const notRunning = !wechat || wechat.running !== true || !Number(wechat.account_count || 0);
    refreshAccountsBtn.textContent = notRunning ? '重新检测' : '刷新账号列表';
  }

  return {
    el: root,
    selectAccount,
    refreshAccounts: refreshAll,
    // 进入步骤时后台静默刷新一次(不阻塞渲染)。
    onEnter() {
      paint();
      void refreshAll({ forceDetect: false });
    },
    onExit() {
      loadEpoch += 1;
      abortActiveLoad('已离开账号确认步骤');
      loading = false;
      refreshAccountsBtn.disabled = false;
      w.refreshButtons();
    },
    isBusy: () => loading,
    // 下一步门槛:必须有确认账号,且 /api/state 明确绑定这个账号。
    canContinue() {
      return !!accountIdOf(w.wiz.account)
        && stateReadyIdentity === accountContextIdentity(w.wiz.account);
    },
    blockedMessage() {
      const accounts = Array.isArray(w.wiz.accounts) ? w.wiz.accounts : [];
      if (!accounts.length) return '尚未检测到微信账号;请先启动微信并登录,然后点“重新检测”。';
      if (selectedId && stateReadyIdentity !== accountContextIdentity(w.wiz.account)) {
        return stateLoadError || '所选账号状态尚未读取完成,请刷新账号列表后重试。';
      }
      return '请先选择一个微信账号再继续。';
    },
  };
}
