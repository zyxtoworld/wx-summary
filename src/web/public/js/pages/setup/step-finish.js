// 第 4 步:浏览群列表 + 完成向导。
// 契约(src/main.js):
// - GET /api/groups?account=<id>&expected_account_fingerprint=<fingerprint>
//   (在版本闸门内,api.js 自动带 X-WX-Asset-Version;读取可能很久,
//   客户端给 600s)→ { ok, groups:[{id,name,...}], account_id, account_fingerprint,
//   account_identity_upgrade, account, ... }。
// - 完成:GET /api/state?refresh=1(&account=<id>) 复核 need_setup;仍为 true 时按
//   need_setup_reason 展示原因并回到对应步骤。
// - state.scheduler.setup_required / disabled_reason(_label):提示可稍后在设置页配置定时摘要。
import {
  applyWizardAccountState,
  accountIdOf,
  accountFingerprintOf,
  compactErrorSummary,
  saveWizardSettings,
  stateMatchesAccountContext,
  syncWizardStateFromSettingsResponse,
  wizardAccountRequestContext,
} from './state.js';
import { configureLiveRegion } from '/js/ui/live-region.js';
import { captureActionFocus, restoreActionFocus } from '/js/shared/action-focus.js';
import { requireGroupList } from '/js/shared/group-list-contract.js';
import { requireServiceStatePayload } from '/js/shared/service-state.js';
import { requireSettingsDocument } from '/js/shared/settings-document.js';
import {
  canonicalWhitelistRef,
  groupDisplayName,
  groupRefFromGroup,
  whitelistRefKey,
} from '/js/shared/whitelist-contract.js';

const GROUPS_TIMEOUT_MS = 600_000;
const GROUP_PREVIEW_COUNT = 5;
const GROUP_WHITELIST_LIMIT_FALLBACK = 500;

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function accountContextIdentity(account) {
  return `${accountIdOf(account)}|${accountFingerprintOf(account)}`;
}

function groupPayloadMatchesAccountContext(payload, account) {
  return String(payload?.account_id || '').trim() === accountIdOf(account)
    && String(payload?.account_fingerprint || '').trim().toLowerCase() === accountFingerprintOf(account);
}

// need_setup_reason → 向导步骤(1 起)。
export function stepForNeedSetupReason(reason = '') {
  switch (String(reason || '').trim()) {
    case 'secrets_invalid':
    case 'llm_base_url_missing':
    case 'llm_api_key_missing':
    case 'llm_model_missing':
      return 2;
    case 'wechat_manual_key_required':
    case 'wechat_auto_key_scan_failed':
      return 3;
    default:
      return 2;
  }
}

export function needSetupReasonText(reason = '') {
  switch (String(reason || '').trim()) {
    case 'secrets_invalid': return '本机密钥文件无法解密,需要重新保存 AI 设置。';
    case 'llm_base_url_missing': return 'AI Base URL 未配置。';
    case 'llm_api_key_missing': return 'AI API Key 未配置。';
    case 'llm_model_missing': return 'AI 模型未配置。';
    case 'wechat_manual_key_required': return '当前账号尚未配置并验证手动数据库密钥。';
    case 'wechat_auto_key_scan_failed': return '自动扫描数据库密钥失败,需要重试或手动验证。';
    default: return reason ? `仍需完成配置(${reason})。` : '仍需完成配置。';
  }
}

export function createFinishStep(w) {
  const { ctx, wiz } = w;
  const root = el('div', 'setup-section');
  root.append(
    el('h2', 'setup-title', '群列表与完成'),
    el('p', 'setup-desc',
      '最后确认工具能读到你的群。读取大库需要一些时间,请保持微信运行。'),
  );

  const groupSection = el('div', 'setup-section');
  groupSection.append(el('div', 'setup-section-title', '本机微信群'));
  const groupStatus = configureLiveRegion(el('div', 'setup-status'));
  const groupProgress = configureLiveRegion(el('div', 'setup-progress-line'));
  const groupPreview = el('div', 'setup-group-preview');
  const groupActions = el('div', 'setup-subtle-actions');
  const reloadGroupsBtn = el('button', 'btn btn-ghost btn-sm', '重新加载群列表');
  reloadGroupsBtn.type = 'button';
  groupActions.append(reloadGroupsBtn);
  groupSection.append(groupStatus, groupProgress, groupPreview, groupActions);

  const whitelistSection = el('div', 'setup-section');
  whitelistSection.append(el('div', 'setup-section-title', '选择群白名单'));
  whitelistSection.append(el('p', 'muted small', '勾选常看的群加入白名单；未勾选的群仍可在总结页临时选择。'));
  const whitelistTools = el('div', 'setup-subtle-actions');
  const whitelistSearch = el('input', 'input');
  whitelistSearch.type = 'search';
  whitelistSearch.placeholder = '搜索群名 / ID';
  whitelistSearch.setAttribute('aria-label', '搜索群名或 ID');
  const whitelistAllBtn = el('button', 'btn btn-sm', '全选当前');
  whitelistAllBtn.type = 'button';
  const whitelistClearBtn = el('button', 'btn btn-ghost btn-sm', '清空当前显示');
  whitelistClearBtn.type = 'button';
  whitelistTools.append(whitelistSearch, whitelistAllBtn, whitelistClearBtn);
  const whitelistStatus = configureLiveRegion(el('div', 'setup-status'));
  const whitelistList = el('div', 'setup-whitelist-list');
  whitelistList.setAttribute('role', 'group');
  whitelistList.setAttribute('aria-label', '首次设置白名单群');
  const whitelistCount = el('p', 'muted small');
  whitelistSection.append(whitelistTools, whitelistStatus, whitelistList, whitelistCount);

  const schedulerNote = el('div', 'alert-bar alert-info');
  schedulerNote.hidden = true;
  const schedulerNoteText = el('span', 'alert-text', '');
  schedulerNote.append(schedulerNoteText);

  const finishStatus = configureLiveRegion(el('div', 'setup-status'));

  root.append(groupSection, whitelistSection, schedulerNote, finishStatus);

  let loading = false;
  let loadingAccountIdentity = '';
  let groupGeneration = 0;
  let loadingRequest = null;
  let finishInFlight = false;
  let whitelistSettingsLoad = null;
  let whitelistSettingsAccountIdentity = wiz.settings
    ? accountContextIdentity(wiz.account)
    : '';

  function whitelistAccountIdentity() {
    return accountContextIdentity(wiz.account);
  }

  function whitelistLimit() {
    const value = wiz.state?.settings_limits?.group_whitelist_refs
      ?? wiz.settings?.settings_limits?.group_whitelist_refs;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0
      ? parsed
      : GROUP_WHITELIST_LIMIT_FALLBACK;
  }

  function sameWhitelist(left = [], right = []) {
    const a = new Set((Array.isArray(left) ? left : []).map(whitelistRefKey));
    const b = new Set((Array.isArray(right) ? right : []).map(whitelistRefKey));
    if (a.size !== b.size) return false;
    for (const key of a) if (!b.has(key)) return false;
    return true;
  }

  function currentAccountWhitelistScopes() {
    const account = wiz.account || {};
    return new Set([
      accountIdOf(account),
      ...(Array.isArray(account.account_aliases) ? account.account_aliases : []),
    ].map(value => String(value || '').trim()).filter(Boolean));
  }

  function ensureWhitelistContext() {
    const identity = whitelistAccountIdentity();
    if (wiz.whitelistAccountIdentity === identity) return;
    if (whitelistSettingsAccountIdentity && whitelistSettingsAccountIdentity !== identity) {
      wiz.settings = null;
      wiz.baseRevision = '';
      whitelistSettingsAccountIdentity = '';
    }
    const scopes = currentAccountWhitelistScopes();
    const saved = Array.isArray(wiz.settings?.groups?.whitelist)
      ? wiz.settings.groups.whitelist
        .map(ref => canonicalWhitelistRef(ref, ''))
        .filter(ref => ref && scopes.has(String(ref.account_id || '').trim()))
      : [];
    const unique = [];
    const seen = new Set();
    for (const ref of saved) {
      const key = whitelistRefKey(ref);
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(ref);
      }
    }
    wiz.whitelist = unique;
    wiz.whitelistBaseline = [...unique];
    wiz.whitelistDirty = false;
    wiz.whitelistAccountIdentity = identity;
  }

  function markWhitelistDirty() {
    wiz.whitelistDirty = !sameWhitelist(wiz.whitelist, wiz.whitelistBaseline);
  }

  function whitelistRefsForSave() {
    const scopes = currentAccountWhitelistScopes();
    const hidden = Array.isArray(wiz.settings?.groups?.whitelist)
      ? wiz.settings.groups.whitelist.filter(ref => typeof ref === 'string'
        || !scopes.has(String(ref?.account_id || '').trim()))
      : [];
    const result = [];
    const seen = new Set();
    for (const ref of [...hidden, ...(Array.isArray(wiz.whitelist) ? wiz.whitelist : [])]) {
      const key = whitelistRefKey(ref);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(ref);
      }
    }
    return result;
  }

  function abortWhitelistSettingsLoad(message = '已离开完成步骤') {
    const load = whitelistSettingsLoad;
    if (!load) return false;
    // 先撤销共享 owner，再触发 abort。底层可能忽略 signal 或永久 pending；
    // 旧 promise 的 finally 只能清理自身，不能继续占住新一代入口。
    whitelistSettingsLoad = null;
    if (!load.controller.signal.aborted) {
      load.controller.abort(Object.assign(new Error(message), {
        name: 'AbortError',
        status: 499,
      }));
    }
    return true;
  }

  async function loadWhitelistSettingsIfNeeded() {
    const ownerIdentity = whitelistAccountIdentity();
    if (!ownerIdentity || !ctx.api?.get) return;
    if (wiz.settings && whitelistSettingsAccountIdentity === ownerIdentity) return;
    if (whitelistSettingsLoad?.identity === ownerIdentity
      && !whitelistSettingsLoad.controller.signal.aborted) {
      await whitelistSettingsLoad.promise;
      return;
    }
    abortWhitelistSettingsLoad('白名单设置读取已被账号切换取消');
    const requestController = new AbortController();
    let pageAbortAttached = false;
    const abortFromPage = () => {
      if (requestController.signal.aborted) return;
      const reason = w.signal?.reason || Object.assign(new Error('已离开首次配置向导'), {
        name: 'AbortError',
        status: 499,
      });
      requestController.abort(reason);
    };
    const detachPageAbort = () => {
      if (!pageAbortAttached) return;
      pageAbortAttached = false;
      w.signal?.removeEventListener?.('abort', abortFromPage);
    };
    if (w.signal?.aborted) abortFromPage();
    else {
      w.signal?.addEventListener?.('abort', abortFromPage, { once: true });
      pageAbortAttached = true;
    }
    const load = {
      identity: ownerIdentity,
      controller: requestController,
      promise: null,
    };
    whitelistSettingsLoad = load;
    load.promise = (async () => {
      try {
        const response = await ctx.api.get('/api/settings', { signal: requestController.signal });
        if (w.destroyed || whitelistSettingsLoad !== load
          || requestController.signal.aborted
          || accountContextIdentity(wiz.account) !== ownerIdentity
          ) return;
        const settings = requireSettingsDocument(response);
        const draft = wiz.whitelistDirty ? [...wiz.whitelist] : [];
        wiz.settings = settings;
        whitelistSettingsAccountIdentity = ownerIdentity;
        wiz.baseRevision = String(settings.settings_revision || '').trim();
        wiz.whitelistAccountIdentity = '';
        ensureWhitelistContext();
        if (draft.length) {
          const merged = [...wiz.whitelist];
          const seen = new Set(merged.map(whitelistRefKey));
          for (const ref of draft) {
            const key = whitelistRefKey(ref);
            if (!seen.has(key)) {
              seen.add(key);
              merged.push(ref);
            }
          }
          wiz.whitelist = merged;
          markWhitelistDirty();
        }
        paintWhitelist();
      } catch {
        // 设置信息是白名单编辑的前置条件;失败留给完成动作的可操作提示处理。
      } finally {
        detachPageAbort();
        if (whitelistSettingsLoad === load) whitelistSettingsLoad = null;
      }
    })();
    await load.promise;
  }

  function visibleGroups() {
    const groups = Array.isArray(wiz.groups?.groups) ? wiz.groups.groups : [];
    const keyword = String(whitelistSearch.value || '').trim().toLowerCase();
    if (!keyword) return groups;
    return groups.filter(group => `${groupDisplayName(group)} ${group?.id || ''}`
      .toLowerCase().includes(keyword));
  }

  function paintWhitelist() {
    ensureWhitelistContext();
    const groups = visibleGroups();
    const selected = new Set((Array.isArray(wiz.whitelist) ? wiz.whitelist : []).map(whitelistRefKey));
    whitelistList.replaceChildren();
    for (const group of groups.slice(0, 200)) {
      const ref = groupRefFromGroup(group, accountIdOf(wiz.account));
      const key = ref ? whitelistRefKey(ref) : '';
      const checkbox = el('input');
      checkbox.type = 'checkbox';
      checkbox.value = key;
      checkbox.checked = Boolean(key && selected.has(key));
      checkbox.disabled = !ref;
      checkbox.addEventListener('change', () => {
        if (!ref || accountContextIdentity(wiz.account) !== wiz.whitelistAccountIdentity) {
          paintWhitelist();
          return;
        }
        const current = new Set((Array.isArray(wiz.whitelist) ? wiz.whitelist : []).map(whitelistRefKey));
        if (checkbox.checked) {
          if (!current.has(key) && current.size >= whitelistLimit()) {
            checkbox.checked = false;
            setStatus(whitelistStatus, 'warn',
              `白名单最多 ${whitelistLimit()} 条；该群未加入，已有选择保持不变。`);
            return;
          }
          if (!current.has(key)) wiz.whitelist = [...wiz.whitelist, ref];
        } else {
          wiz.whitelist = wiz.whitelist.filter(item => whitelistRefKey(item) !== key);
        }
        markWhitelistDirty();
        paintWhitelist();
      });
      const label = el('label', 'setup-whitelist-row');
      label.append(checkbox, el('span', '', groupDisplayName(group)));
      whitelistList.appendChild(label);
    }
    const total = Array.isArray(wiz.whitelist) ? wiz.whitelist.length : 0;
    const visibleSelected = groups.filter(group => {
      const ref = groupRefFromGroup(group, accountIdOf(wiz.account));
      return ref && selected.has(whitelistRefKey(ref));
    }).length;
    whitelistCount.textContent = `白名单已选 ${total}/${whitelistLimit()} 条；当前显示已选 ${visibleSelected} 个群。`;
  }

  whitelistSearch.addEventListener('input', () => paintWhitelist());
  whitelistAllBtn.addEventListener('click', () => {
    ensureWhitelistContext();
    let rejected = 0;
    const selected = new Set(wiz.whitelist.map(whitelistRefKey));
    for (const group of visibleGroups()) {
      const ref = groupRefFromGroup(group, accountIdOf(wiz.account));
      if (!ref) continue;
      const key = whitelistRefKey(ref);
      if (selected.has(key)) continue;
      if (selected.size >= whitelistLimit()) {
        rejected += 1;
        continue;
      }
      selected.add(key);
      wiz.whitelist.push(ref);
    }
    markWhitelistDirty();
    paintWhitelist();
    if (rejected) setStatus(whitelistStatus, 'warn',
      `白名单最多 ${whitelistLimit()} 条；有 ${rejected} 个群未加入，已有选择保持不变。`);
  });
  whitelistClearBtn.addEventListener('click', () => {
    ensureWhitelistContext();
    const keys = new Set(visibleGroups()
      .map(group => groupRefFromGroup(group, accountIdOf(wiz.account)))
      .filter(Boolean)
      .map(whitelistRefKey));
    wiz.whitelist = wiz.whitelist.filter(ref => !keys.has(whitelistRefKey(ref)));
    markWhitelistDirty();
    paintWhitelist();
  });

  function syncReloadGroupsButton() {
    reloadGroupsBtn.disabled = loading || finishInFlight;
  }

  function abortGroupLoad(message = '群列表读取已取消') {
    const request = loadingRequest;
    loadingRequest = null;
    if (!request) return false;
    request.detach();
    const { controller } = request;
    if (controller.signal.aborted) return false;
    const error = new Error(message);
    error.name = 'AbortError';
    error.status = 499;
    controller.abort(error);
    return true;
  }

  function groupLoadIsCurrent(token, accountId, accountIdentity) {
    return !w.destroyed
      && token === groupGeneration
      && accountIdOf(wiz.account) === accountId
      && accountContextIdentity(wiz.account) === accountIdentity;
  }

  function setStatus(target, kind, text) {
    target.className = `setup-status${kind ? ` setup-status-${kind}` : ''}`;
    target.replaceChildren();
    if (!text) return;
    const icon = el('span', 'setup-status-icon', { ok: '✓', warn: '⚠', err: '✗', info: '…' }[kind] || '');
    target.append(icon, el('span', 'setup-status-text', text));
  }

  function setProgress(text, detail = '') {
    groupProgress.replaceChildren();
    if (!text) return;
    groupProgress.append(ctx.ui.spinner(14), el('span', '', text));
    if (detail) groupProgress.append(el('span', 'setup-progress-detail', detail));
  }

  function paintGroups(payload) {
    groupPreview.replaceChildren();
    const groups = requireGroupList(payload);
    wiz.groups = {
      account_id: accountIdOf(wiz.account),
      account_fingerprint: accountFingerprintOf(wiz.account),
      count: groups.length,
      preview: groups.slice(0, GROUP_PREVIEW_COUNT),
      groups,
      error: '',
    };
    ensureWhitelistContext();
    paintWhitelist();
    if (!groups.length) {
      setStatus(groupStatus, 'warn',
        '没有读到任何群。请确认当前账号选择正确、微信已登录并同步过消息;也可以稍后到总结页重试。');
      return;
    }
    setStatus(groupStatus, 'ok', `共读到 ${groups.length} 个群${groups.length > GROUP_PREVIEW_COUNT ? `,下面列出前 ${GROUP_PREVIEW_COUNT} 个` : ''}。`);
    for (const group of groups.slice(0, GROUP_PREVIEW_COUNT)) {
      const item = el('div', 'setup-group-item');
      item.append(el('span', '', String(group?.name || group?.id || '未命名群')));
      const count = Number(group?.message_count || group?.messages || 0) || 0;
      if (count) item.append(el('span', 'muted', `${count} 条消息`));
      groupPreview.appendChild(item);
    }
  }

  function paintSchedulerNote() {
    const scheduler = wiz.state?.scheduler || null;
    if (scheduler && (scheduler.setup_required === true || String(scheduler.disabled_reason || '').trim())) {
      schedulerNote.hidden = false;
      const label = String(scheduler.disabled_reason_label || '').trim();
      schedulerNoteText.textContent = `后台定时摘要当前未启用${label ? `(${label})` : ''};`
        + '完成首次配置后,可稍后在设置页配置定时摘要规则。';
    } else {
      schedulerNote.hidden = false;
      schedulerNoteText.textContent = '如需每天自动检查并生成摘要,可稍后在设置页开启后台定时摘要。';
    }
  }

  async function loadGroups({ focusCandidates = [] } = {}) {
    let ownerAccountId = accountIdOf(wiz.account);
    let ownerAccountIdentity = accountContextIdentity(wiz.account);
    if (!ownerAccountId) {
      setStatus(groupStatus, 'warn', '请先回到第 1 步确认微信账号。');
      return;
    }
    if (loading) return;
    const focusTarget = captureActionFocus(focusCandidates, globalThis.document?.activeElement);
    const ownerToken = w.beginAsync();
    abortGroupLoad('群列表读取已被新请求取代');
    const requestController = new AbortController();
    let pageAbortAttached = false;
    const abortFromPage = () => {
      if (requestController.signal.aborted) return;
      const reason = w.signal?.reason || Object.assign(new Error('已离开首次配置向导'), {
        name: 'AbortError',
        status: 499,
      });
      requestController.abort(reason);
    };
    const detachPageAbort = () => {
      if (!pageAbortAttached) return;
      pageAbortAttached = false;
      w.signal?.removeEventListener?.('abort', abortFromPage);
    };
    if (w.signal?.aborted) abortFromPage();
    else {
      w.signal?.addEventListener?.('abort', abortFromPage, { once: true });
      pageAbortAttached = true;
    }
    const requestOwner = { controller: requestController, detach: detachPageAbort };
    loadingRequest = requestOwner;
    loading = true;
    loadingAccountIdentity = ownerAccountIdentity;
    groupGeneration += 1;
    const token = groupGeneration;
    syncReloadGroupsButton();
    setProgress('正在读取群列表…', '首次读取需要准备本地工作数据,可能需要几分钟');
    try {
      const params = new URLSearchParams();
      params.set('account', ownerAccountId);
      params.set('expected_account_fingerprint', accountFingerprintOf(wiz.account));
      const payload = await ctx.api.get(`/api/groups?${params.toString()}`, {
        signal: requestController.signal,
        timeoutMs: GROUPS_TIMEOUT_MS,
      });
      if (!w.alive(ownerToken)
        || !groupLoadIsCurrent(token, ownerAccountId, ownerAccountIdentity)) return;
      // 账号身份升级:用响应里的最新账号刷新本地指纹。
      if (payload?.account_identity_upgrade && payload?.account) {
        // 完成复核会换 async generation,但同一群列表响应仍可能携带
        // 服务端确认的账号身份升级。先同步上下文,再禁止旧 owner
        // 继续绘制普通群列表。
        const stateReady = await w.applyAccountIdentityUpgrade(payload.account, { ownerToken });
        if (w.destroyed || token !== groupGeneration || !w.alive(ownerToken)) return;
        const upgradeTargetIdentity = accountContextIdentity(payload.account);
        if (accountContextIdentity(wiz.account) === upgradeTargetIdentity) {
          ownerAccountId = accountIdOf(wiz.account);
          ownerAccountIdentity = upgradeTargetIdentity;
          loadingAccountIdentity = ownerAccountIdentity;
        }
        if (!groupLoadIsCurrent(token, ownerAccountId, ownerAccountIdentity)) return;
        if (!stateReady) return;
      }
      if (!groupLoadIsCurrent(token, ownerAccountId, ownerAccountIdentity)
        || !w.alive(ownerToken)) return;
      if (!groupPayloadMatchesAccountContext(payload, wiz.account)) {
        setStatus(groupStatus, 'warn',
          '群列表响应的账号身份与当前选择不一致。请回到第 1 步重新确认账号后再试。');
        return;
      }
      paintGroups(payload);
    } catch (error) {
      if (!groupLoadIsCurrent(token, ownerAccountId, ownerAccountIdentity)
        || !w.alive(ownerToken)
        || error?.name === 'AbortError' || error?.status === 499) return;
      if (error?.status === 409 && error?.code === 'account_context_changed') {
        setStatus(groupStatus, 'warn', `${compactErrorSummary(error?.message)} 请回到第 1 步重新确认账号。`);
        return;
      }
      if (error?.status === 428) {
        setStatus(groupStatus, 'warn', `${compactErrorSummary(error?.message)} 请先完成前面的配置步骤。`);
        return;
      }
      setStatus(groupStatus, 'err',
          `${compactErrorSummary(error?.message || '读取群列表失败')} 可以点“重新加载群列表”重试,或先完成向导后到总结页读取。`);
    } finally {
      detachPageAbort();
      if (loadingRequest === requestOwner) loadingRequest = null;
      if (token === groupGeneration && w.alive(ownerToken)) {
        loading = false;
        loadingAccountIdentity = '';
      }
      if (!w.destroyed
        && token === groupGeneration
        && w.alive(ownerToken)
        && accountContextIdentity(wiz.account) === ownerAccountIdentity) {
        setProgress('');
        syncReloadGroupsButton();
      }
      if (!w.destroyed && token === groupGeneration && w.alive(ownerToken)) {
        restoreActionFocus(focusTarget, {
          activeElement: globalThis.document?.activeElement,
          body: globalThis.document?.body,
        });
      }
    }
  }

  reloadGroupsBtn.addEventListener('click', () => { void loadGroups({ focusCandidates: [reloadGroupsBtn] }); });

  return {
    el: root,
    onEnter() {
      paintSchedulerNote();
      ensureWhitelistContext();
      paintWhitelist();
      void loadWhitelistSettingsIfNeeded();
      const accountId = accountIdOf(wiz.account);
      const accountIdentity = accountContextIdentity(wiz.account);
      if (loading && loadingAccountIdentity !== accountIdentity) {
        groupGeneration += 1;
        abortGroupLoad('账号上下文已变化');
        loading = false;
        loadingAccountIdentity = '';
      }
      const cachedIdentity = wiz.groups
        ? accountContextIdentity({
          id: wiz.groups.account_id,
          manual_key_account_fingerprint: wiz.groups.account_fingerprint,
        })
        : '';
      if (cachedIdentity !== accountIdentity) wiz.groups = null;
      if (!wiz.groups) void loadGroups();
      else if (wiz.groups.error) setStatus(groupStatus, 'err', wiz.groups.error);
      else {
        // 已有缓存结果:直接重画。
        const cached = wiz.groups;
        setStatus(groupStatus, cached.count ? 'ok' : 'warn',
          cached.count
            ? `共读到 ${cached.count} 个群${cached.count > GROUP_PREVIEW_COUNT ? `,下面列出前 ${GROUP_PREVIEW_COUNT} 个` : ''}。`
            : '没有读到任何群。');
        groupPreview.replaceChildren();
        for (const group of cached.preview || []) {
          const item = el('div', 'setup-group-item');
          item.append(el('span', '', String(group?.name || group?.id || '未命名群')));
          groupPreview.appendChild(item);
        }
        paintWhitelist();
      }
    },
    onExit() {
      groupGeneration += 1;
      abortGroupLoad('已离开完成步骤');
      abortWhitelistSettingsLoad('已离开完成步骤');
      loading = false;
      loadingAccountIdentity = '';
      syncReloadGroupsButton();
    },
    // 完成按钮:复核 /api/state;need_setup 解除则跳总结页,否则展示原因并回到对应步骤。
    async finish() {
      if (finishInFlight) return false;
      finishInFlight = true;
      syncReloadGroupsButton();
      const account = wiz.account;
      const accountId = accountIdOf(account);
      const accountIdentity = accountContextIdentity(account);
      const token = w.beginAsync();
      // 完成复核已取得新的 async owner,旧群列表请求不再有可用投影;
      // 立即释放它持有的独立网络资源,晚到响应仍由原 owner 检查丢弃。
      abortGroupLoad('完成复核已接管群列表请求');
      if (loading) {
        loading = false;
        loadingAccountIdentity = '';
        setProgress('');
        syncReloadGroupsButton();
      }
      setStatus(finishStatus, 'info', '正在复核配置状态…');
      try {
        ensureWhitelistContext();
        if (wiz.whitelistDirty) {
          if (!wiz.settings || accountContextIdentity(wiz.account) !== wiz.whitelistAccountIdentity) {
            setStatus(finishStatus, 'warn', '白名单设置尚未完成当前账号绑定;请重新读取群列表后再试。');
            return false;
          }
          if (wiz.whitelist.length > whitelistLimit()) {
            setStatus(finishStatus, 'warn',
              `白名单共有 ${wiz.whitelist.length} 条，超过上限 ${whitelistLimit()} 条;请先移除不再使用的群。`);
            return false;
          }
          const requestContext = wizardAccountRequestContext(wiz);
          const response = await saveWizardSettings(ctx, wiz, {
            groups: {
              whitelist: whitelistRefsForSave().map(ref => typeof ref === 'string' ? ref : ({ ...ref })),
            },
            ...requestContext.body,
          }, {
            signal: w.signal,
            timeoutMs: 240_000,
            isCurrent: () => w.alive(token)
              && accountContextIdentity(wiz.account) === accountIdentity,
          });
          if (!w.alive(token) || accountContextIdentity(wiz.account) !== accountIdentity) return false;
          syncWizardStateFromSettingsResponse(wiz, response);
          wiz.whitelistBaseline = wiz.whitelist.map(ref => ({ ...ref }));
          wiz.whitelistDirty = false;
        }
        const state = requireServiceStatePayload(await ctx.api.get(
          `/api/state?refresh=1${accountId ? `&account=${encodeURIComponent(accountId)}` : ''}`,
          { signal: w.signal },
        ));
        if (!w.alive(token) || accountContextIdentity(wiz.account) !== accountIdentity) return false;
        if (!stateMatchesAccountContext(state, account)) {
          setStatus(finishStatus, 'warn',
            '配置状态响应无效或与当前账号不一致;请稍后重试。');
          return false;
        }
        applyWizardAccountState(ctx.store, wiz, state, account);
        if (state?.need_setup === false) {
          wiz.done = true;
          setStatus(finishStatus, 'ok', '配置已完成,正在进入总结页…');
          ctx.store.set('accounts', wiz.accounts);
          ctx.navigate('#/digest');
          return true;
        }
        const reason = String(state?.need_setup_reason || '').trim();
        setStatus(finishStatus, 'warn',
          `${needSetupReasonText(reason)} 已回到对应步骤,请完成后再次点“完成”。`);
        w.gotoStep(stepForNeedSetupReason(reason));
        return false;
      } catch (error) {
        if (!w.alive(token) || error?.name === 'AbortError' || error?.status === 499) return false;
        setStatus(finishStatus, 'err', `复核配置状态失败:${compactErrorSummary(error?.message)} 请稍后重试。`);
        return false;
      } finally {
        finishInFlight = false;
        if (!w.destroyed) syncReloadGroupsButton();
      }
    },
  };
}
