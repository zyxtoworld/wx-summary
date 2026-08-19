// 第 3 步:数据库读取密钥(条件步骤)。
// 契约(src/main.js):
// - POST /api/wechat/status:必须明确 manual_only 或 scan_key,二者互斥(400 wechat_status_mode_required/conflict)。
//   手动验证:query/body 带 account、manual_only=true、manual_key=<文本>、expected_settings_revision、
//   expected_account_fingerprint、validation_progress_id;不带 manual_key 时验证“已保存候选”(此时
//   expected_settings_revision 必填,否则 428 settings_revision_required)。
//   自动扫描:scan_key=true(服务端 WECHAT_KEY_SCAN_TIMEOUT_MS 超时)。
//   手动验证服务端超时 180s(WECHAT_MANUAL_KEY_VALIDATION_TIMEOUT_MS),客户端放宽到 190s。
// - GET /api/wechat/status-progress?validation_progress_id=<id> 轮询 { phase,label,detail,status,done }。
// - 保存:PUT /api/settings { wechat:{ manual_key, manual_key_account_id, manual_key_account_aliases },
//   base_settings_revision, _request_context:{ account_id, account_aliases, account_fingerprint,
//   expected_account_fingerprint, manual_key_validation_required:true } }。
//   手动密钥 patch 必须带“全部消息库分片验证通过”的待保存证明(10 分钟有效),否则
//   428 manual_key_full_validation_required;证明过期/工作数据已更新 409 manual_key_validation_stale。
import { isMutationOutcomeUnknown } from '/js/api.js';
import { requireServiceStatePayload } from '/js/shared/service-state.js';
import {
  applyWizardAccountState,
  compactErrorSummary,
  confirmInvalidSecretsReplacement,
  createWechatStatusProgressId,
  manualKeyInvalidMessage,
  manualKeyMessageVerified,
  normalizeManualKeysText,
  accountIdOf,
  accountFingerprintOf,
  findAccountByAnyId,
  stateMatchesAccountContext,
  staleAccountConfirmationKeyFromAccounts,
  saveWizardSettings,
  syncWizardStateFromSettingsResponse,
  wizardAccountRequestContext,
} from './state.js';
import { configureLiveRegion } from '/js/ui/live-region.js';
import {
  beginPendingSettingsMutation,
  completePendingSettingsMutationAfterError,
  completePendingSettingsMutationAfterResponse,
} from '/js/shared/settings-mutation-recovery.js';
import { captureActionFocus, restoreActionFocus } from '/js/shared/action-focus.js';
import {
  clearDbMirrorAutoFailure,
  isDbMirrorFailure,
  rememberDbMirrorAutoFailure,
} from '/js/shared/db-mirror-failure.js';

const MANUAL_KEY_VALIDATION_TIMEOUT_MS = 190_000;
// 后端自动扫描预算为 5 分钟;客户端多留少量收尾时间,避免提前截断合法扫描。
const KEY_SCAN_TIMEOUT_MS = 310_000;
const MANUAL_KEY_SAVE_TIMEOUT_MS = 240_000;
const PROGRESS_POLL_INTERVAL_MS = 800;

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function waitForSetupProgressDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    let timer = null;
    let settled = false;
    let listening = false;
    let onAbort = null;
    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (listening) {
        signal?.removeEventListener?.('abort', onAbort);
        listening = false;
      }
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    onAbort = () => {
      settle(reject, signal?.reason instanceof Error
        ? signal.reason
        : new DOMException('已取消', 'AbortError'));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    if (typeof signal?.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
      listening = true;
    }
    const nextTimer = setTimeout(() => settle(resolve), ms);
    if (settled) clearTimeout(nextTimer);
    else timer = nextTimer;
  });
}

export function createKeyStep(w) {
  const { ctx, wiz } = w;
  const root = el('div', 'setup-section');
  root.append(
    el('h2', 'setup-title', '验证数据库读取'),
    el('p', 'setup-desc',
      '读取群消息需要微信数据库密钥。工具会先从微信进程内存自动扫描;扫描失败时,'
      + '需要你手动提供密钥候选并验证它能解开当前账号的全部消息库分片。'),
  );

  const status = configureLiveRegion(el('div', 'setup-status'));
  const progress = configureLiveRegion(el('div', 'setup-progress-line'));

  // 自动获取/自动扫描区
  const autoSection = el('div', 'setup-section');
  const autoStatus = configureLiveRegion(el('div', 'setup-status'));
  const autoActions = el('div', 'setup-subtle-actions');
  const scanBtn = el('button', 'btn btn-ghost btn-sm', '自动扫描重试');
  scanBtn.type = 'button';
  autoActions.append(scanBtn);
  autoSection.append(autoStatus, autoActions);

  // 手动密钥区
  const manualSection = el('div', 'setup-section');
  const manualLabel = el('label', 'setup-section-title', '手动输入密钥候选');
  const manualHint = el('p', 'muted',
    '可粘贴 64/96/128/160/192 位 hex、all_keys.json 或导出 blob;只会验证并保存当前确认账号的候选。');
  const keyInput = document.createElement('textarea');
  keyInput.id = 'setup-manual-key-candidates';
  manualLabel.htmlFor = keyInput.id;
  keyInput.className = 'input setup-key-input';
  keyInput.placeholder = '粘贴手动密钥候选…';
  keyInput.autocomplete = 'off';
  keyInput.spellcheck = false;
  const manualActions = el('div', 'setup-subtle-actions');
  const validateSaveBtn = el('button', 'btn btn-primary btn-sm', '验证并保存');
  validateSaveBtn.type = 'button';
  const validateSavedBtn = el('button', 'btn btn-ghost btn-sm', '验证已保存候选');
  validateSavedBtn.type = 'button';
  manualActions.append(validateSaveBtn, validateSavedBtn);
  manualSection.append(manualLabel, manualHint, keyInput, manualActions);

  root.append(status, autoSection, manualSection, progress);

  let busy = false;
  let stateRefreshEpoch = 0;
  let stateRefreshRequest = null;
  let activeStatusAction = null;
  let staleAccountRecovery = null;
  let staleAccountSwitchEpoch = 0;

  function abortStateRefresh(message = '状态刷新已取消') {
    const request = stateRefreshRequest;
    stateRefreshRequest = null;
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

  function supersedeStateRefresh(message) {
    stateRefreshEpoch += 1;
    abortStateRefresh(message);
    return stateRefreshEpoch;
  }

  function abortStatusAction(message = '已离开数据库密钥步骤') {
    const action = activeStatusAction;
    if (!action) return false;
    return action.cancel(message);
  }

  function accountContextIdentity(account) {
    const accountId = accountIdOf(account);
    const fingerprint = accountFingerprintOf(account);
    if (accountId) return `id:${accountId}|fingerprint:${fingerprint}`;
    return fingerprint ? `fingerprint:${fingerprint}` : '';
  }

  function currentStaleAccountRecovery() {
    const recovery = staleAccountRecovery;
    if (!recovery || w.destroyed) return null;
    if (recovery.accountIdentity !== accountContextIdentity(wiz.account)) return null;
    const currentKey = staleAccountConfirmationKeyFromAccounts(
      Array.isArray(wiz.accounts) ? wiz.accounts : [],
      accountIdOf(wiz.account),
    );
    return currentKey && currentKey === recovery.key ? recovery : null;
  }

  function staleDiagnosticsFromError(error) {
    const diagnostics = error?.payload?.key_diagnostics
      || error?.key_diagnostics
      || error?.details?.key_diagnostics;
    return diagnostics && typeof diagnostics === 'object' ? diagnostics : null;
  }

  function appendStaleAccountActions(recovery) {
    const switchButton = el('button', 'link-btn', '切换到最近同步账号');
    switchButton.type = 'button';
    switchButton.dataset.manualKeyStaleAction = '1';
    switchButton.addEventListener('click', async () => {
      if (currentStaleAccountRecovery() !== recovery) return;
      const suggestedId = String(recovery.diagnostics?.suggested_account_id || '').trim();
      const suggested = suggestedId
        ? findAccountByAnyId(Array.isArray(wiz.accounts) ? wiz.accounts : [], { id: suggestedId })
        : null;
      if (!suggested || typeof w.switchToAccount !== 'function') {
        setStatus(status, 'warn', '未找到最近同步账号，请回到第 1 步刷新账号列表后再验证。');
        return;
      }
      const switchEpoch = ++staleAccountSwitchEpoch;
      staleAccountRecovery = null;
      setBusy(true);
      try {
        const switched = await w.switchToAccount(suggested);
        if (w.destroyed || switchEpoch !== staleAccountSwitchEpoch) return;
        if (!switched) {
          setStatus(status, 'warn', '切换账号失败，请回到第 1 步刷新账号列表后再验证。');
        } else {
          setStatus(status, 'info', '已切换到最近同步账号，正在重新确认密钥状态…');
        }
      } finally {
        if (!w.destroyed && switchEpoch === staleAccountSwitchEpoch) setBusy(false);
      }
    });

    const confirmButton = el('button', 'link-btn', '仍使用旧目录');
    confirmButton.type = 'button';
    confirmButton.dataset.manualKeyStaleAction = '1';
    confirmButton.addEventListener('click', async () => {
      if (currentStaleAccountRecovery() !== recovery) return;
      const confirmed = await ctx.ui.confirmDialog({
        title: '确认使用旧微信账号目录',
        message: '当前选中的账号数据较旧。确认后将继续使用本次账号快照读取并验证手动密钥。',
        confirmLabel: '仍使用旧目录',
        cancelLabel: '取消',
        tone: 'warn',
      });
      if (!confirmed || w.destroyed || currentStaleAccountRecovery() !== recovery) return;
      recovery.confirmed = true;
      setStatus(status, 'warn', '已确认仍使用旧目录；请再次点击“验证已保存候选”重试。');
    });
    status.append(document.createTextNode(' '), switchButton, document.createTextNode(' '), confirmButton);
  }

  function setStatus(target, kind, text) {
    if (w.destroyed) return;
    target.className = `setup-status${kind ? ` setup-status-${kind}` : ''}`;
    target.replaceChildren();
    if (!text) return;
    const icon = el('span', 'setup-status-icon', { ok: '✓', warn: '⚠', err: '✗', info: '…' }[kind] || '');
    target.append(icon, el('span', 'setup-status-text', text));
  }

  function setProgress(text, detail = '') {
    if (w.destroyed) return;
    progress.replaceChildren();
    if (!text) return;
    progress.append(ctx.ui.spinner(14), el('span', '', text));
    if (detail) progress.append(el('span', 'setup-progress-detail', detail));
  }

  function setBusy(next) {
    busy = next;
    if (w.destroyed) return;
    scanBtn.disabled = next;
    validateSaveBtn.disabled = next;
    validateSavedBtn.disabled = next;
    keyInput.disabled = next;
    status.querySelectorAll?.('[data-manual-key-stale-action]')
      .forEach(button => { button.disabled = next; });
    w.refreshButtons();
  }

  function restoreKeyActionFocus(focusTarget) {
    if (w.destroyed) return;
    restoreActionFocus(focusTarget, {
      activeElement: globalThis.document?.activeElement,
      body: globalThis.document?.body,
    });
  }

  function wechatCapability() {
    return wiz.state?.wechat || {};
  }

  // 当前步骤是否已经满足(自动已验证 / 手动已验证 / 本向导内刚保存)。
  function stepSatisfied() {
    const wechat = wechatCapability();
    return wiz.key.saved === true
      || wechat.manual_key_verified === true
      || (wechat.key_auto_scan_state === 'supported' && wechat.manual_key_required !== true)
      || (wechat.key_auto_scan_state === 'cached' && wechat.manual_key_required !== true
          && wechat.key_setup_recovery_required !== true);
  }

  function paintCapability() {
    const wechat = wechatCapability();
    const scanReason = String(wechat.key_auto_scan_reason || '').trim();
    const autoState = String(wechat.key_auto_scan_state || '').trim();
    if (!accountIdOf(wiz.account)) {
      setStatus(status, 'warn', '请回到第 1 步先确认微信账号,密钥验证只针对当前账号。');
      setStatus(autoStatus, '', '');
      return;
    }
    if (stepSatisfied()) {
      if (wiz.key.saved) setStatus(status, 'ok', '手动密钥已验证并保存到当前账号。');
      else if (wechat.manual_key_verified === true) setStatus(status, 'ok', '当前账号的手动密钥此前已验证通过。');
      else setStatus(status, 'ok', '数据库密钥已自动获取,无需手动输入。');
    } else if (wechat.key_setup_recovery_required === true) {
      setStatus(status, 'warn',
        `自动扫描未能取得可用密钥${scanReason ? `(${scanReason})` : ''};`
        + '请点“自动扫描重试”,或在下方手动输入密钥候选并验证。');
    } else if (wechat.manual_key_required === true) {
      setStatus(status, 'warn',
        `当前平台/账号无法自动获取数据库密钥${scanReason ? `(${scanReason})` : ''};`
        + '必须手动输入密钥候选并通过全部消息库分片验证后才能生成摘要。');
    } else if (autoState === 'unknown') {
      setStatus(status, 'info',
        '尚未确认当前环境能否自动获取数据库密钥;可先点“自动扫描重试”尝试,'
        + '失败后在下方手动输入密钥候选。');
    } else {
      setStatus(status, 'info', '正在确认数据库密钥状态…');
    }
    // 自动区状态
    if (autoState === 'supported') {
      setStatus(autoStatus, 'ok', '自动扫描已获取并验证密钥。');
      scanBtn.hidden = true;
    } else {
      scanBtn.hidden = !(wechat.key_auto_scan_can_attempt === true || wechat.key_auto_scan_retry_after_failure === true);
      if (autoState === 'cached') setStatus(autoStatus, 'ok', '已缓存此前验证过的自动密钥候选。');
      else if (autoState === 'failed') setStatus(autoStatus, 'warn', '最近一次自动扫描失败,可重试。');
      else setStatus(autoStatus, '', '');
    }
    // 已保存但未验证候选的提示
    validateSavedBtn.hidden = !(wechat.manual_key_configured === true && wechat.manual_key_verified !== true);
  }

  // 轮询微信验证进度;返回停止函数。
  function startProgressPolling(progressId, ownerToken) {
    let stopped = false;
    const controller = new AbortController();
    let pageAbortAttached = false;
    const abortFromPage = () => {
      if (controller.signal.aborted) return;
      const reason = w.signal?.reason || Object.assign(new Error('已离开首次配置向导'), {
        name: 'AbortError',
        status: 499,
      });
      controller.abort(reason);
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
    const ownerIsCurrent = () => !stopped && !controller.signal.aborted && w.alive(ownerToken);
    void (async () => {
      try {
        while (ownerIsCurrent()) {
          try {
            const item = await ctx.api.get(
              `/api/wechat/status-progress?validation_progress_id=${encodeURIComponent(progressId)}`,
              { signal: controller.signal, timeoutMs: 15000 },
            );
            if (!ownerIsCurrent()) break;
            const label = String(item?.label || '').trim();
            const detail = String(item?.detail || '').trim();
            if (label) setProgress(label, detail);
            if (item?.done === true) break;
          } catch {
            break; // 进度查询失败不阻塞主请求结果
          }
          if (!ownerIsCurrent()) break;
          try {
            await waitForSetupProgressDelay(PROGRESS_POLL_INTERVAL_MS, controller.signal);
          } catch {
            break;
          }
          if (!ownerIsCurrent()) break;
        }
      } finally {
        stopped = true;
        detachPageAbort();
      }
    })();
    return () => {
      if (stopped) return false;
      stopped = true;
      detachPageAbort();
      if (!controller.signal.aborted) {
        const error = new Error('进度轮询已停止');
        error.name = 'AbortError';
        error.status = 499;
        controller.abort(error);
      }
      return true;
    };
  }

  // 账号上下文在请求中途失效的统一处理。
  function handleAccountContextError(error) {
    if (error?.status === 409 && error?.code === 'wechat_account_stale_selected') {
      const diagnostics = staleDiagnosticsFromError(error);
      const key = staleAccountConfirmationKeyFromAccounts(
        Array.isArray(wiz.accounts) ? wiz.accounts : [],
        accountIdOf(wiz.account),
      );
      staleAccountRecovery = key ? {
        key,
        diagnostics: diagnostics || {},
        accountIdentity: accountContextIdentity(wiz.account),
        confirmed: false,
      } : null;
      setStatus(status, 'warn', compactErrorSummary(error?.message)
        || '当前账号数据较旧，请切换账号或确认仍使用旧目录后重试。');
      if (staleAccountRecovery) appendStaleAccountActions(staleAccountRecovery);
      return true;
    }
    if (error?.status === 409 && [
      'stale_account_confirmation_required',
      'stale_account_confirmation_invalid',
    ].includes(error?.code)) {
      staleAccountRecovery = null;
      setStatus(status, 'warn', '旧目录确认已失效，请刷新账号列表后重新确认再重试。');
      return true;
    }
    if (error?.status === 409 && ['account_context_changed', 'manual_key_account_not_found', 'manual_key_account_mismatch'].includes(error?.code)) {
      staleAccountRecovery = null;
      setStatus(status, 'warn', `${compactErrorSummary(error?.message)} 请回到第 1 步重新确认账号。`);
      return true;
    }
    return false;
  }

  function appendStaleAccountConfirmation(query, body) {
    const recovery = currentStaleAccountRecovery();
    if (!recovery?.confirmed) return false;
    query.set('allow_stale_account', 'true');
    query.set('stale_account_confirmation', recovery.key);
    body.allow_stale_account = true;
    body.stale_account_confirmation = recovery.key;
    return true;
  }

  async function refreshStateQuiet(ownerToken = null) {
    const account = wiz.account;
    const accountId = accountIdOf(account);
    const accountIdentity = accountContextIdentity(account);
    const ownerIsCurrent = () => ownerToken === null || w.alive(ownerToken);
    if (!ownerIsCurrent()) return false;
    const refreshEpoch = supersedeStateRefresh('状态刷新已被新请求取代');
    const controller = new AbortController();
    let pageAbortAttached = false;
    const abortFromPage = () => {
      if (controller.signal.aborted) return;
      const reason = w.signal?.reason || Object.assign(new Error('已离开首次配置向导'), {
        name: 'AbortError',
        status: 499,
      });
      controller.abort(reason);
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
    const requestOwner = { controller, detach: detachPageAbort };
    stateRefreshRequest = requestOwner;
    try {
      const state = requireServiceStatePayload(await ctx.api.get(
        `/api/state?refresh=1${accountId ? `&account=${encodeURIComponent(accountId)}` : ''}`,
        { signal: controller.signal },
      ));
      if (!ownerIsCurrent()
        || w.destroyed
        || refreshEpoch !== stateRefreshEpoch
        || accountContextIdentity(wiz.account) !== accountIdentity
        || !stateMatchesAccountContext(state, account)) return false;
      applyWizardAccountState(ctx.store, wiz, state, account);
      paintCapability();
      w.refreshButtons();
      return true;
    } finally {
      detachPageAbort();
      if (stateRefreshRequest === requestOwner) stateRefreshRequest = null;
    }
  }

  // POST /api/wechat/status 公共执行器;options.mode: 'manual' | 'scan';manualText 可选。
  async function runWechatStatus({ mode, manualText = '', ownerToken = null }) {
    const { accountId, fingerprint } = wizardAccountRequestContext(wiz);
    if (!accountId) {
      setStatus(status, 'warn', '请先回到第 1 步确认微信账号。');
      return null;
    }
    const progressId = createWechatStatusProgressId();
    const query = new URLSearchParams({
      account: accountId,
      validation_progress_id: progressId,
    });
    if (mode === 'manual') query.set('manual_only', 'true');
    else query.set('scan_key', 'true');
    if (wiz.baseRevision) query.set('expected_settings_revision', wiz.baseRevision);
    if (fingerprint) query.set('expected_account_fingerprint', fingerprint);
    const body = {
      validation_progress_id: progressId,
      ...(mode === 'manual' ? { manual_only: true } : { scan_key: true }),
      ...(manualText ? { manual_key: manualText } : {}),
      ...(wiz.baseRevision ? { expected_settings_revision: wiz.baseRevision } : {}),
      ...(fingerprint ? { expected_account_fingerprint: fingerprint } : {}),
    };
    const staleRecoveryAtRequest = currentStaleAccountRecovery();
    const staleConfirmationUsed = appendStaleAccountConfirmation(query, body);
    if (staleConfirmationUsed) staleAccountRecovery = null;
    const pendingMutationId = beginPendingSettingsMutation('微信密钥验证记录');
    const token = ownerToken ?? w.beginAsync();
    if (!w.alive(token)) return null;
    abortStatusAction('新的密钥验证操作已开始');
    supersedeStateRefresh('新的密钥验证操作已开始');
    setBusy(true);
    const stopPolling = startProgressPolling(progressId, token);
    setProgress(mode === 'manual' ? '正在验证手动密钥候选…' : '正在自动扫描微信进程…', '大库解密可能需要几分钟,请保持微信运行');
    const requestController = new AbortController();
    let pageAbortAttached = false;
    const detachPageAbort = () => {
      if (!pageAbortAttached) return;
      pageAbortAttached = false;
      w.signal?.removeEventListener?.('abort', abortFromPage);
    };
    let actionCancelled = false;
    const abortFromPage = () => {
      const reason = w.signal?.reason || Object.assign(new Error('已离开首次配置向导'), {
        name: 'AbortError',
        status: 499,
      });
      action.cancel(reason);
    };
    const action = {
      cancel(reason = new Error('密钥验证已取消')) {
        if (actionCancelled) return false;
        actionCancelled = true;
        stopPolling();
        detachPageAbort();
        if (!requestController.signal.aborted) requestController.abort(reason);
        return true;
      },
    };
    activeStatusAction = action;
    if (w.signal?.aborted) action.cancel(w.signal.reason || new Error('已离开首次配置向导'));
    else {
      w.signal?.addEventListener?.('abort', abortFromPage, { once: true });
      pageAbortAttached = true;
    }
    const actionIsCurrent = () => !actionCancelled && w.alive(token);
    try {
      const result = await ctx.api.post(`/api/wechat/status?${query.toString()}`, body, {
        signal: requestController.signal,
        timeoutMs: mode === 'manual'
          ? MANUAL_KEY_VALIDATION_TIMEOUT_MS
          : KEY_SCAN_TIMEOUT_MS,
      });
      completePendingSettingsMutationAfterResponse(pendingMutationId);
      if (!actionIsCurrent()) return null;
      staleAccountRecovery = null;
      clearDbMirrorAutoFailure({
        accountId,
        accounts: Array.isArray(wiz.accounts) ? wiz.accounts : [],
        accountFingerprint: fingerprint,
      });
      return {
        result,
        token,
        staleAccountConfirmation: staleConfirmationUsed
          ? staleRecoveryAtRequest?.key || ''
          : '',
      };
    } catch (error) {
      completePendingSettingsMutationAfterError(pendingMutationId, error);
      if (!actionIsCurrent()) return null;
      if (isDbMirrorFailure(error)) {
        rememberDbMirrorAutoFailure(error, accountId, {
          accounts: Array.isArray(wiz.accounts) ? wiz.accounts : [],
          accountFingerprint: fingerprint,
        });
      }
      throw error;
    } finally {
      stopPolling();
      detachPageAbort();
      if (activeStatusAction === action) activeStatusAction = null;
      if (actionIsCurrent()) {
        setProgress('');
        setBusy(false);
      }
    }
  }

  // 处理验证响应中的 settings/账号升级;返回 true 表示验证覆盖全部消息库分片。
  async function absorbValidationResult(result, {
    temporaryManualKey = false,
    ownerToken = null,
  } = {}) {
    if (result?.settings) syncWizardStateFromSettingsResponse(wiz, result);
    if (result?.account_identity_upgrade && result?.account) {
      const stateReady = await w.applyAccountIdentityUpgrade(result.account, { ownerToken });
      if (!stateReady || (ownerToken !== null && !w.alive(ownerToken))) return false;
    }
    if (manualKeyMessageVerified(result)) return true;
    // 未完整通过:整理服务端给出的原因。
    const checked = Math.max(0, Number(result?.key?.message_db_checked_count || result?.db?.message_db_checked_count || 0) || 0);
    const total = Math.max(0, Number(result?.key?.message_db_total_count || result?.db?.message_db_total_count || 0) || 0);
    const reason = compactErrorSummary(result?.key?.reason || result?.db?.reason || '');
    const sampleVerified = result?.key?.message_sample_verified === true
      || result?.db?.message_sample_verified === true
      || result?.db?.message_decrypted === true;
    const candidateLabel = temporaryManualKey ? '当前输入的候选' : '已保存的候选';
    if (sampleVerified) {
      setStatus(status, 'warn',
        `${candidateLabel}只能打开部分消息库${total ? `(${checked}/${total} 个分片)` : ''};`
        + '这还不算已验证可用密钥,不能保存。请确认候选与当前账号属于同一个微信账号。');
    } else {
      setStatus(status, 'err',
        `${candidateLabel}未能解开当前账号消息库${reason ? `:${reason}` : '。'}`
        + '请核对候选内容与当前账号后重试。');
    }
    return false;
  }

  // 保存已通过验证的临时候选。
  async function saveValidatedManualKey(normalizedText, { staleAccountConfirmation = '' } = {}) {
    const { accountId, aliases, body: contextBody } = wizardAccountRequestContext(wiz, { manualKeyValidationRequired: true });
    const submittedStaleConfirmation = String(staleAccountConfirmation || '').trim();
    const currentStaleKey = staleAccountConfirmationKeyFromAccounts(
      Array.isArray(wiz.accounts) ? wiz.accounts : [],
      accountId,
    );
    const staleConfirmationIsCurrent = !!submittedStaleConfirmation
      && submittedStaleConfirmation === currentStaleKey;
    const requestContext = {
      ...(contextBody._request_context || {}),
      ...(staleConfirmationIsCurrent ? {
        allow_stale_account: true,
        stale_account_confirmation: submittedStaleConfirmation,
      } : {}),
    };
    const token = w.beginAsync();
    supersedeStateRefresh('新的密钥保存操作已开始');
    setBusy(true);
    setProgress('全部消息库分片验证已通过,正在原子保存候选…');
    try {
      // 密钥库失效时,写新密钥前必须先确认建立新密钥库(服务端 428 闸门)。
      const replacement = await confirmInvalidSecretsReplacement(ctx, wiz);
      if (!w.alive(token)) return false;
      if (replacement.required && !replacement.confirmed) {
        setStatus(status, 'warn', '已取消保存;没有建立新密钥库,候选仍未保存。');
        return false;
      }
      if (replacement.confirmed) {
        contextBody._request_context = {
          ...(contextBody._request_context || {}),
          replace_invalid_secrets: true,
        };
      }
      const patch = {
        wechat: {
          manual_key: normalizedText,
          manual_key_account_id: accountId,
          manual_key_account_aliases: aliases,
        },
        ...contextBody,
        ...(staleConfirmationIsCurrent ? {
          allow_stale_account: true,
          stale_account_confirmation: submittedStaleConfirmation,
        } : {}),
        _request_context: requestContext,
      };
      const response = await saveWizardSettings(ctx, wiz, patch, {
        signal: w.signal,
        timeoutMs: MANUAL_KEY_SAVE_TIMEOUT_MS,
        isCurrent: () => w.alive(token),
      });
      if (!w.alive(token)) return false;
      syncWizardStateFromSettingsResponse(wiz, response);
      if (response?.account_identity_upgrade && response?.account) {
        const stateReady = await w.applyAccountIdentityUpgrade(response.account, { ownerToken: token });
        if (!stateReady || !w.alive(token)) return false;
      }
      const stateReady = await refreshStateQuiet(token).catch(() => false);
      if (!stateReady || !w.alive(token)) {
        if (w.alive(token)) {
          setStatus(status, 'warn', '候选已保存,但当前账号状态尚未重新确认;请稍后重试。');
        }
        return false;
      }
      wiz.key.saved = true;
      wiz.key.savedText = normalizedText;
      wiz.key.draft = '';
      keyInput.value = '';
      const warnings = Array.isArray(response?.warnings)
        ? response.warnings.map(item => item?.message).filter(Boolean)
        : [];
      setStatus(status, 'ok', warnings.length
        ? `已验证并保存当前账号 ${normalizedText.split('\n').length} 条手动密钥候选。注意:${warnings.join(';')}`
        : `已验证并保存当前账号 ${normalizedText.split('\n').length} 条手动密钥候选。`);
      return true;
    } catch (error) {
      if (!w.alive(token) || error?.name === 'AbortError' || error?.status === 499) return false;
      if (isMutationOutcomeUnknown(error)) {
        setStatus(status, 'warn',
          '保存请求超时或断连,结果未知:候选可能已写入也可能没有。请点“重新检测”核对密钥状态后再决定是否重试。');
        await refreshStateQuiet(token).catch(() => false);
        return false;
      }
      if (error?.status === 409 && error?.code === 'manual_key_validation_stale') {
        setStatus(status, 'warn', `${compactErrorSummary(error?.message)} 请重新点“验证并保存”。`);
        wiz.key.validatedText = '';
        return false;
      }
      if (error?.status === 428 && error?.code === 'manual_key_full_validation_required') {
        setStatus(status, 'warn', '验证证明已失效;请重新点“验证并保存”。');
        wiz.key.validatedText = '';
        return false;
      }
      if (error?.status === 428 && error?.code === 'secrets_replacement_confirmation_required') {
        wiz.state = { ...(wiz.state || {}), secrets_invalid: true };
        setStatus(status, 'warn', '本机密钥库已失效,保存密钥需要先确认建立新密钥库;请再点一次“验证并保存”并在弹窗中确认。');
        return false;
      }
      if (error?.status === 409 && error?.code === 'settings_revision_conflict') {
        setStatus(status, 'err', '设置已在别处变化;已重新拉取状态,请再次验证并保存。');
        await refreshStateQuiet(token).catch(() => false);
        return false;
      }
      if (handleAccountContextError(error)) return false;
      setStatus(status, 'err', `保存手动密钥失败:${compactErrorSummary(error?.message)}`);
      return false;
    } finally {
      setProgress('');
      setBusy(false);
    }
  }

  // “验证并保存”:先验证当前输入,全部分片通过后自动保存。
  async function validateAndSave() {
    const normalized = normalizeManualKeysText(keyInput.value);
    if (!normalized.keys.length) {
      keyInput.classList.add('invalid');
      setStatus(status, 'warn', normalized.invalid.length
        ? manualKeyInvalidMessage(normalized)
        : '请先粘贴手动密钥候选。');
      return;
    }
    if (normalized.invalid.length) {
      keyInput.classList.add('invalid');
      setStatus(status, 'warn', manualKeyInvalidMessage(normalized));
      return;
    }
    keyInput.classList.remove('invalid');
    const focusTarget = captureActionFocus([validateSaveBtn], globalThis.document?.activeElement);
    const statusOwnerToken = w.beginAsync();
    let retainedBusyToken = null;
    try {
      const statusRun = await runWechatStatus({
        mode: 'manual',
        manualText: normalized.text,
        ownerToken: statusOwnerToken,
      });
      if (statusRun === null) return;
      const { result, token, staleAccountConfirmation } = statusRun;
      if (!w.alive(token)) return;
      // 主验证返回后,身份升级/state 重读仍属于同一个用户动作。
      // runWechatStatus 的内部 finally 已释放 busy,这里把同一 owner 交给
      // 后处理阶段;旧 owner 失效时不得在 finally 清掉新动作的 busy。
      retainedBusyToken = token;
      setBusy(true);
      if (!(await absorbValidationResult(result, { temporaryManualKey: true, ownerToken: token }))) return;
      if (!w.alive(token)) return;
      wiz.key.validatedText = normalized.text;
      await saveValidatedManualKey(normalized.text, { staleAccountConfirmation });
    } catch (error) {
      if (error?.name === 'AbortError' || error?.status === 499) return;
      if (isMutationOutcomeUnknown(error)) {
        setStatus(status, 'warn',
          '验证请求超时或断连,结果未知:这不证明候选错误。请稍后点“重新检测”核对密钥状态,再决定是否重试。');
        return;
      }
      if (handleAccountContextError(error)) return;
      if (error?.status === 409 && error?.code === 'settings_revision_conflict') {
        setStatus(status, 'err', '设置已在别处变化;已重新拉取状态,请重试。');
        await refreshStateQuiet(statusOwnerToken).catch(() => false);
        return;
      }
      setStatus(status, 'err', `验证失败:${compactErrorSummary(error?.message)}`);
    } finally {
      if (retainedBusyToken !== null && w.alive(retainedBusyToken)) setBusy(false);
      restoreKeyActionFocus(focusTarget);
    }
  }

  // “验证已保存候选”:不带 manual_key,验证服务端已保存的候选。
  async function validateSaved() {
    if (!wiz.baseRevision) {
      setStatus(status, 'warn', '缺少设置版本号,正在重新拉取状态;请稍后重试。');
      await refreshStateQuiet().catch(() => {});
      return;
    }
    const focusTarget = captureActionFocus([validateSavedBtn], globalThis.document?.activeElement);
    let retainedBusyToken = null;
    try {
      const statusRun = await runWechatStatus({ mode: 'manual' });
      if (statusRun === null) return;
      const { result, token } = statusRun;
      if (!w.alive(token)) return;
      // 账号身份升级和精确 state 重读尚未结束前,验证动作仍然拥有按钮。
      // 只允许当前 token 的 finally 释放它,避免迟到旧动作解除新动作 busy。
      retainedBusyToken = token;
      setBusy(true);
      if (await absorbValidationResult(result, { temporaryManualKey: false, ownerToken: token })) {
        if (!w.alive(token)) return;
        const stateReady = await refreshStateQuiet(token).catch(() => false);
        if (!stateReady || !w.alive(token)) return;
        // 主验证证明候选可用,但只有精确匹配当前账号的 state 已采用后才算本步骤就绪。
        wiz.key.saved = true;
        setStatus(status, 'ok', '已保存的候选已通过当前账号全部消息库分片验证。');
      }
    } catch (error) {
      if (error?.name === 'AbortError' || error?.status === 499) return;
      if (isMutationOutcomeUnknown(error)) {
        setStatus(status, 'warn', '验证请求超时或断连,结果未知;请稍后点“重新检测”核对密钥状态。');
        return;
      }
      if (handleAccountContextError(error)) return;
      setStatus(status, 'err', `验证已保存候选失败:${compactErrorSummary(error?.message)}`);
    } finally {
      if (retainedBusyToken !== null && w.alive(retainedBusyToken)) setBusy(false);
      restoreKeyActionFocus(focusTarget);
    }
  }

  // “自动扫描重试”:scan_key 路径。
  async function retryAutoScan() {
    const focusTarget = captureActionFocus([scanBtn], globalThis.document?.activeElement);
    let retainedBusyToken = null;
    try {
      const statusRun = await runWechatStatus({ mode: 'scan' });
      if (statusRun === null) return;
      const { result, token } = statusRun;
      if (!w.alive(token)) return;
      // 主扫描返回后,身份升级和精确 state 重读仍属于同一用户动作。
      // runWechatStatus 的 finally 已释放主请求 busy,这里把同一 owner
      // 交给后处理阶段;旧 owner 失效时不得解除新动作的 busy。
      retainedBusyToken = token;
      setBusy(true);
      if (result?.settings) syncWizardStateFromSettingsResponse(wiz, result);
      if (result?.account_identity_upgrade && result?.account) {
        const stateReady = await w.applyAccountIdentityUpgrade(result.account, { ownerToken: token });
        if (!stateReady || !w.alive(token)) return;
      }
      // 注意:key.ok 恒为 true(服务端基线),不能作为成功依据;
      // 以全量/样本验证标记或刷新后的密钥能力状态为准。
      const verified = manualKeyMessageVerified(result)
        || result?.db?.message_sample_verified === true
        || result?.db?.message_decrypted === true;
      const stateReady = await refreshStateQuiet(token).catch(() => false);
      if (!w.alive(token)) return;
      if (!stateReady) {
        setStatus(status, 'warn', '自动扫描已返回结果,但当前账号状态尚未重新确认;请稍后重试。');
        return;
      }
      if (verified || stepSatisfied()) {
        setStatus(status, 'ok', '自动扫描成功,数据库密钥已可用。');
      } else {
        setStatus(status, 'warn',
          `自动扫描仍未取得可用密钥${compactErrorSummary(result?.key?.reason || result?.db?.reason || '') ? `:${compactErrorSummary(result?.key?.reason || result?.db?.reason || '')}` : ''};`
          + '请改用下方手动输入,或跳过稍后在设置页处理。');
      }
    } catch (error) {
      if (error?.name === 'AbortError' || error?.status === 499) return;
      if (isMutationOutcomeUnknown(error)) {
        setStatus(status, 'warn', '自动扫描请求超时或断连,结果未知;请点“重新检测”核对密钥状态后再决定是否重试。');
        return;
      }
      if (handleAccountContextError(error)) return;
      setStatus(status, 'err', `自动扫描失败:${compactErrorSummary(error?.message)}`);
    } finally {
      if (retainedBusyToken !== null && w.alive(retainedBusyToken)) setBusy(false);
      restoreKeyActionFocus(focusTarget);
    }
  }

  keyInput.addEventListener('input', () => {
    wiz.key.draft = keyInput.value;
  });
  validateSaveBtn.addEventListener('click', () => { void validateAndSave(); });
  validateSavedBtn.addEventListener('click', () => { void validateSaved(); });
  scanBtn.addEventListener('click', () => { void retryAutoScan(); });

  return {
    el: root,
    onExit() {
      staleAccountSwitchEpoch += 1;
      abortStatusAction('已离开数据库密钥步骤');
      supersedeStateRefresh('已离开数据库密钥步骤');
      staleAccountRecovery = null;
      if (busy) setBusy(false);
    },
    onEnter() {
      keyInput.value = wiz.key.draft;
      paintCapability();
      // 静默刷新一次密钥能力状态(不强制微信重检测,避免卡顿)。
      void refreshStateQuiet().catch(() => {});
    },
    isBusy: () => busy,
    canContinue() {
      return stepSatisfied() || wiz.key.skipped === true;
    },
    blockedMessage() {
      const wechat = wechatCapability();
      if (wechat.manual_key_required === true) {
        return '当前账号必须验证手动密钥才能继续;也可以点底部“跳过本步”。';
      }
      return '请先完成密钥验证(或自动扫描),或点底部“跳过本步”。';
    },
  };
}
