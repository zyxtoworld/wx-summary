// 设置页 · 隐私与安全分区:脱敏开关、手动数据库密钥(验证→保存→清除)、
// 自动密钥缓存重置、诊断导出、运行日志。
import {
  assertBrowserDownloadSupported,
  browserDownloadCapability,
  browserDownloadUnsupportedMessage,
} from '/js/shared/browser-download-capability.js';
import { syncFormControlsDisabled } from '/js/shared/form-busy-controls.js';
import { makeScrollableRegion } from '/js/shared/scroll-region.js';
import { requireSettingsDiagnosticsResult } from '/js/shared/diagnostics-contract.js';
import { createSettingsLogViewLifecycle } from './log-view-lifecycle.js';
import {
  clearDbMirrorAutoFailure,
  dbMirrorDiagnosticsReady,
  isDbMirrorFailure,
  readDbMirrorAutoFailure,
  rememberDbMirrorAutoFailure,
} from '/js/shared/db-mirror-failure.js';
import {
  el,
  createStatusLine,
  errorText,
  isAbortError,
  createWechatStatusProgressId,
  downloadTextFile,
  fmtDateTime,
} from './core.js';

const REDACT_ITEMS = Object.freeze([
  ['redact_phone', '手机号', '总结前把手机号替换为占位符'],
  ['redact_id_card', '身份证号', '总结前把身份证号替换为占位符'],
  ['redact_bank_card', '银行卡号', '总结前把银行卡号替换为占位符'],
  ['redact_email', '邮箱地址', '总结前把邮箱地址替换为占位符'],
  ['attach_media_content', '附带媒体文字', '允许把图片 OCR / 语音转写等文字一并送入 AI'],
]);

const KEY_SCAN_STATE_LABELS = Object.freeze({
  supported: '自动密钥可用',
  cached: '有已缓存密钥候选',
  unknown: '尚未确认自动密钥可用',
  failed: '最近自动扫描未通过',
  unsupported: '当前平台不支持自动扫描',
});

// 手动密钥验证请求的超时:略大于服务端 180 秒上限。
const MANUAL_VALIDATION_TIMEOUT_MS = 200_000;
const KEY_SCAN_TIMEOUT_MS = 610_000;

const TERMINAL_PROGRESS_ERROR_CODES = new Set([
  'invalid_token',
  'session_invalid',
  'stale_frontend_asset',
  'service_restart_required',
]);

function isTerminalProgressError(error = {}) {
  return [
    error?.code,
    error?.public_code,
    error?.type,
    error?.payload?.code,
    error?.payload?.public_code,
    error?.payload?.error?.code,
  ].some(code => TERMINAL_PROGRESS_ERROR_CODES.has(
    String(code || '').trim().toLowerCase().replace(/-/g, '_'),
  ));
}

export function createSettingsProgressPoller({
  fetchProgress,
  applyProgress,
  signal,
  intervalMs = 900,
} = {}) {
  const pollState = { stopped: false, timer: null };
  const controller = new AbortController();
  let ownerAbortAttached = false;

  const detachOwnerAbort = () => {
    if (!ownerAbortAttached) return;
    ownerAbortAttached = false;
    signal?.removeEventListener?.('abort', onOwnerAbort);
  };

  const stop = (reason = null) => {
    if (pollState.timer !== null) clearTimeout(pollState.timer);
    pollState.timer = null;
    pollState.stopped = true;
    detachOwnerAbort();
    if (!controller.signal.aborted) {
      const error = reason instanceof Error ? reason : Object.assign(new Error('进度轮询已停止'), {
        name: 'AbortError',
        status: 499,
      });
      controller.abort(error);
    }
  };

  function onOwnerAbort() {
    stop(signal?.reason);
  }

  if (signal?.aborted) onOwnerAbort();
  else if (typeof signal?.addEventListener === 'function') {
    signal.addEventListener('abort', onOwnerAbort, { once: true });
    ownerAbortAttached = true;
  }

  const poll = async () => {
    if (pollState.stopped || controller.signal.aborted) return;
    try {
      const progress = await fetchProgress({ signal: controller.signal });
      if (pollState.stopped || controller.signal.aborted) return;
      applyProgress(progress);
      if (progress?.done === true) {
        stop();
        return;
      }
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        stop();
        return;
      }
      if (isTerminalProgressError(error)) {
        stop(error);
        return;
      }
      // 进度读取失败不打断主请求,继续下一轮。
    }
    if (pollState.stopped || controller.signal.aborted) return;
    const nextTimer = setTimeout(() => {
      pollState.timer = null;
      void poll();
    }, intervalMs);
    if (pollState.stopped || controller.signal.aborted) clearTimeout(nextTimer);
    else pollState.timer = nextTimer;
  };

  return {
    start() {
      void poll();
    },
    stop,
    state: pollState,
  };
}

export function requireWxdbKeyCacheResetResult(value) {
  const reset = value?.reset;
  const valid = value
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.ok === true
    && reset
    && typeof reset === 'object'
    && !Array.isArray(reset)
    && typeof reset.changed === 'boolean'
    && Number.isSafeInteger(reset.bytes)
    && reset.bytes >= 0;
  if (!valid) {
    const error = new Error('自动密钥缓存重置响应无效，请重新打开设置页确认结果。');
    error.status = 502;
    error.code = 'wxdb_key_cache_reset_response_invalid';
    throw error;
  }
  return reset;
}

export function requireSettingsLogResult(value, view) {
  const summary = view === 'summary';
  const valid = value
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.ok === true
    && Array.isArray(value.log_tail)
    && value.log_tail.every(line => typeof line === 'string')
    && (!summary || (
      Array.isArray(value.entries)
      && value.entries.every(entry => entry && typeof entry === 'object' && !Array.isArray(entry))
      && typeof value.service_started_at === 'string'
      && value.service_started_at.trim().length > 0
    ));
  if (!valid) {
    const error = new Error('日志读取响应无效，请重试。');
    error.status = 502;
    error.code = 'settings_logs_response_invalid';
    throw error;
  }
  return value;
}

export function createPrivacySection(page) {
  const { api, ui } = page;
  const status = createStatusLine();
  const keyStatus = createStatusLine();
  const scanStatus = createStatusLine();
  const toolStatus = createStatusLine();
  const logStatus = createStatusLine();

  // ---- 脱敏开关 ----------------------------------------------------------------
  const toggles = new Map();
  const toggleList = el('div', { class: 'settings-check-list' });
  for (const [key, label, hint] of REDACT_ITEMS) {
    const input = el('input', { type: 'checkbox' });
    input.addEventListener('change', markDirty);
    toggles.set(key, input);
    toggleList.append(el('label', { class: 'settings-check' },
      input,
      el('span', null, el('strong', { text: label }), el('span', { class: 'muted', text: ` — ${hint}` })),
    ));
  }
  const savePrivacyBtn = el('button', { class: 'btn btn-primary', type: 'button', text: '保存隐私设置' });

  // ---- 手动密钥 ----------------------------------------------------------------
  const keyStateGrid = el('div', { class: 'settings-scheduler-grid' });
  const keyInput = el('textarea', {
    class: 'settings-key-input',
    placeholder: "粘贴 64/96/128/160/192 位 hex 密钥,或 all_keys.json / x'...' / 0x... 片段",
    'aria-label': '手动数据库密钥',
    spellcheck: 'false',
  });
  const validateKeyBtn = el('button', { class: 'btn btn-ghost', type: 'button', text: '验证手动密钥' });
  const saveKeyBtn = el('button', { class: 'btn btn-primary', type: 'button', text: '保存手动密钥' });
  const clearKeyBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '清除当前账号密钥' });
  const clearOrphanedBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '清理孤立候选', hidden: true });
  const validationBox = el('div', { class: 'settings-validation', hidden: true });
  const validationText = el('div', { class: 'settings-progress-text' });
  const validationBar = el('div', { class: 'progress-track' }, el('div', { class: 'progress-fill' }));
  validationBox.append(validationText, validationBar);

  // ---- 自动扫描 / 缓存 -----------------------------------------------------------
  const scanKeyBtn = el('button', { class: 'btn btn-ghost', type: 'button', text: '自动扫描密钥' });
  const resetCacheBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '重置自动密钥缓存' });

  // ---- 诊断 / 日志 ----------------------------------------------------------------
  const diagLightBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '下载轻量诊断 JSON' });
  const diagFullBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '下载完整诊断 JSON' });
  const downloadSupported = browserDownloadCapability({ requireObjectUrl: true }).supported;
  if (!downloadSupported) {
    const reason = browserDownloadUnsupportedMessage({ artifactLabel: '诊断文件' });
    diagLightBtn.title = reason;
    diagFullBtn.title = reason;
    diagLightBtn.disabled = true;
    diagFullBtn.disabled = true;
  }
  const logView = el('select', { class: 'select', 'aria-label': '日志视图' },
    el('option', { value: 'raw', text: '原始日志(200 行)' }),
    el('option', { value: 'summary', text: '结构化摘要' }),
  );
  const logRefreshBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '刷新日志' });
  const logPanel = makeScrollableRegion(el('div', { class: 'settings-log' }), {
    label: '应用运行日志',
    role: 'log',
  });
  const logViewLifecycle = createSettingsLogViewLifecycle();

  const draft = {
    dirty: false,
    validatedKey: null, // { text, accountId, fingerprint, messageDbVerified }
  };

  function privacy() { return page.getSettings()?.privacy || {}; }
  function wechat() { return page.getSettings()?.wechat || {}; }

  function currentAccount() { return page.getAccount(); }

  function currentAccountId() {
    const account = currentAccount();
    return String(account?.id || account?.account_id || '').trim();
  }

  function currentAccountFingerprint() {
    return String(currentAccount()?.manual_key_account_fingerprint || '').trim().toLowerCase();
  }

  function syncManualKeyDraftState() {
    page.markAccountScopedDraft?.('manual-key', !!keyInput.value.trim() || !!draft.validatedKey);
  }

  // ---------------------------------------------------------------------------
  // 脱敏开关
  // ---------------------------------------------------------------------------
  function computeDirty() {
    const saved = privacy();
    for (const [key, input] of toggles) {
      if (input.checked !== !!saved[key]) return true;
    }
    return false;
  }

  function markDirty() {
    draft.dirty = computeDirty();
    page.markDirty('privacy', draft.dirty);
    savePrivacyBtn.disabled = !draft.dirty || page.isBusy();
  }

  function discardManualKeyDraft() {
    keyInput.value = '';
    draft.validatedKey = null;
    validationBox.hidden = true;
    validationText.textContent = '';
    keyStatus.clear();
    saveKeyBtn.disabled = true;
    page.markAccountScopedDraft?.('manual-key', false);
  }

  function applySettings(settings, { preserveDirty = true } = {}) {
    if (!preserveDirty) discardManualKeyDraft();
    const saved = settings?.privacy || {};
    if (!preserveDirty || !draft.dirty) {
      for (const [key, input] of toggles) input.checked = !!saved[key];
      draft.dirty = false;
      page.markDirty('privacy', false);
    }
    savePrivacyBtn.disabled = !draft.dirty || page.isBusy();
    paintKeyState();
  }

  // ---------------------------------------------------------------------------
  // 手动密钥状态展示
  // ---------------------------------------------------------------------------
  // 密钥记录按“权威账号 ID + 别名”匹配;展示时把存储 ID 翻译为可读账号名。
  function resolveAccountLabel(storedId) {
    const id = String(storedId || '').trim();
    if (!id) return '';
    const accounts = page.getAccounts() || [];
    const matched = accounts.find(account => {
      const ids = [account?.id, account?.account_id, account?.wxid, account?.legacy_id,
        ...(Array.isArray(account?.account_aliases) ? account.account_aliases : [])];
      return ids.map(value => String(value || '').trim()).filter(Boolean).includes(id);
    });
    return String(matched?.display_name || matched?.name || matched?.wxid || '').trim();
  }

  function idListLabel(ids) {
    const labels = (Array.isArray(ids) ? ids : []).map(id => resolveAccountLabel(id) || id);
    if (!labels.length) return '—';
    if (labels.length <= 2) return labels.join('、');
    return `${labels.slice(0, 2).join('、')} 等 ${labels.length} 个`;
  }

  function accountKeyState(w, accountId, configuredIds, verifiedIds) {
    if (!accountId) return '未选择';
    const account = currentAccount();
    const aliases = [accountId, ...(Array.isArray(account?.account_aliases) ? account.account_aliases : [])]
      .map(value => String(value || '').trim()).filter(Boolean);
    const hit = list => aliases.some(alias => list.includes(alias));
    if (hit(verifiedIds)) return '已验证';
    if (hit(configuredIds)) return '已保存未验证';
    return '未配置';
  }

  function paintKeyState() {
    const w = wechat();
    const state = page.getState();
    const stateWechat = state?.wechat || {};
    const accountId = currentAccountId();
    const configuredIds = Array.isArray(w.manual_key_account_ids) ? w.manual_key_account_ids : [];
    const verifiedIds = Array.isArray(w.manual_key_verified_account_ids) ? w.manual_key_verified_account_ids : [];
    const scanState = String(stateWechat.key_auto_scan_state || '').trim();
    const kv = (k, v) => el('div', { class: 'settings-kv' },
      el('span', { class: 'settings-kv-k', text: k }),
      el('span', { class: 'settings-kv-v', text: v || '—', title: v || '' }));
    keyStateGrid.replaceChildren(
      kv('手动密钥', w.manual_key_set ? `已保存(${configuredIds.length} 个账号)` : '未保存'),
      kv('当前账号', accountKeyState(w, accountId, configuredIds, verifiedIds)),
      kv('已验证账号', verifiedIds.length ? `${verifiedIds.length} 个(${idListLabel(verifiedIds)})` : '—'),
      kv('自动扫描', KEY_SCAN_STATE_LABELS[scanState] || (scanState || '—')),
    );
    const orphanedCount = Math.max(0, Number(w.manual_key_orphaned_account_count || 0) || 0);
    clearOrphanedBtn.hidden = orphanedCount <= 0;
    if (orphanedCount > 0) {
      keyStateGrid.append(kv('孤立候选', `${orphanedCount} 个(绑定的账号已失效,可清理)`));
    }
    if (w._secrets_invalid || page.getSettings()?._secrets_invalid) {
      keyStateGrid.append(kv('密钥库', '不可读(需要重建,请按向导处理)'));
    }
    const mirrorFailure = readDbMirrorAutoFailure({
      accountId,
      accounts: page.getAccounts?.() || [],
      accountFingerprint: currentAccountFingerprint(),
    });
    if (dbMirrorDiagnosticsReady(mirrorFailure)) {
      keyStateGrid.append(kv('本地数据', `最近 ${Number(mirrorFailure.count || 0)} 次检查未完成,请重试`));
    }
  }

  // ---------------------------------------------------------------------------
  // 微信验证(手动/自动)+ 进度轮询
  // ---------------------------------------------------------------------------
  function paintValidation(progress) {
    validationBox.hidden = false;
    const label = String(progress?.label || '正在验证').trim();
    const detail = String(progress?.detail || '').trim();
    validationText.textContent = detail && !label.includes(detail) ? `${label}:${detail}` : label;
    const bar = validationBar.firstChild;
    if (progress?.done) bar.style.width = '100%';
    else bar.style.width = '34%';
  }

  function stopProgressPolling(pollState) {
    pollState?.stop?.();
  }

  function startProgressPolling(progressId, signal) {
    const pollState = createSettingsProgressPoller({
      signal,
      fetchProgress: ({ signal: requestSignal }) => api.get(
        `/api/wechat/status-progress?validation_progress_id=${encodeURIComponent(progressId)}`,
        { signal: requestSignal, timeoutMs: 15_000 },
      ),
      applyProgress: paintValidation,
    });
    paintValidation({ label: '正在等待本地服务返回验证进度', done: false });
    pollState.start();
    return pollState;
  }

  function validationAccountContext() {
    const account = currentAccount();
    const accountId = currentAccountId();
    if (!accountId) return null;
    const fingerprint = String(account?.manual_key_account_fingerprint || '').trim().toLowerCase();
    return { accountId, fingerprint };
  }

  // 手动密钥:先验证(服务端记住“已验证待保存”),验证通过后再 PUT 保存。
  async function validateManualKey() {
    const text = keyInput.value.trim();
    if (!text) {
      keyStatus.set('请先粘贴手动数据库密钥。', 'warn');
      return;
    }
    const context = validationAccountContext();
    if (!context) {
      keyStatus.set('请先在左下角选择微信账号。', 'err');
      return;
    }
    const progressId = createWechatStatusProgressId();
    const token = page.beginAction('验证手动密钥', [validateKeyBtn, saveKeyBtn, scanKeyBtn]);
    const pollState = startProgressPolling(progressId, token.signal);
    keyStatus.set('正在验证手动密钥(逐个消息库分片验证,可能需要几分钟)…');
    saveKeyBtn.disabled = true;
    try {
      const query = new URLSearchParams({ account: context.accountId, manual_only: 'true', validation_progress_id: progressId });
      if (page.getBaseRevision()) query.set('expected_settings_revision', page.getBaseRevision());
      if (context.fingerprint) query.set('expected_account_fingerprint', context.fingerprint);
      const result = await api.post(`/api/wechat/status?${query.toString()}`, {
        manual_only: true,
        manual_key: text,
        validation_progress_id: progressId,
        expected_settings_revision: page.getBaseRevision() || '',
        ...(context.fingerprint ? { expected_account_fingerprint: context.fingerprint } : {}),
      }, { signal: token.signal, timeoutMs: MANUAL_VALIDATION_TIMEOUT_MS });
      if (!page.alive(token)) return;
      clearDbMirrorAutoFailure({
        accountId: context.accountId,
        accounts: page.getAccounts?.() || [],
        accountFingerprint: context.fingerprint,
      });
      const verified = result?.validation_ok === true
        && (result?.key?.message_db_verified === true || result?.db?.message_db_verified === true);
      const sampleOnly = !verified && (result?.key?.ok === true || result?.key?.message_sample_verified === true);
      if (verified) {
        if (result?.account_identity_upgrade) {
          const queued = page.queueAccountIdentityUpgrade(result, token, {
            successMessage: '当前微信账号身份已更新,手动密钥验证结果已绑定新身份。',
            failureMessage: '手动密钥已验证,但账号身份刷新尚未完成;请刷新账号后重新验证。',
            onUpgraded(account) {
              if (!page.isActive()) return false;
              const upgradedContext = validationAccountContext();
              const upgradedAccountId = String(account?.id || account?.account_id || '').trim();
              const upgradedFingerprint = String(account?.manual_key_account_fingerprint || '').trim().toLowerCase();
              if (!upgradedContext
                || upgradedContext.accountId !== upgradedAccountId
                || upgradedContext.fingerprint !== upgradedFingerprint) return false;
              page.applySettingsPayload(result?.settings || null, {
                revision: result?.settings_revision,
              });
              keyInput.value = text;
              draft.validatedKey = {
                text,
                accountId: upgradedContext.accountId,
                fingerprint: upgradedContext.fingerprint,
              };
              syncManualKeyDraftState();
              keyStatus.set('验证通过(全部消息库分片)。请点击“保存手动密钥”写入本机密钥库。', 'ok');
              saveKeyBtn.disabled = page.isBusy();
              validationBox.hidden = true;
              return true;
            },
            onIncomplete() {
              if (!page.isActive()) return;
              draft.validatedKey = null;
              syncManualKeyDraftState();
              saveKeyBtn.disabled = true;
              keyStatus.set('手动密钥已验证,但账号身份刷新尚未完成;请刷新账号后重新验证。', 'warn');
              validationBox.hidden = true;
            },
          });
          draft.validatedKey = null;
          syncManualKeyDraftState();
          saveKeyBtn.disabled = true;
          keyStatus.set(queued
            ? '手动密钥已验证,正在刷新账号身份…'
            : '手动密钥已验证,但账号身份升级无法继续;请刷新账号后重新验证。',
          queued ? 'warn' : 'err');
        } else {
          page.applySettingsPayload(result?.settings || null, { revision: result?.settings_revision });
          draft.validatedKey = { text, accountId: context.accountId, fingerprint: context.fingerprint };
          syncManualKeyDraftState();
          keyStatus.set('验证通过(全部消息库分片)。请点击“保存手动密钥”写入本机密钥库。', 'ok');
          saveKeyBtn.disabled = page.isBusy();
        }
      } else if (sampleOnly) {
        draft.validatedKey = null;
        const reason = String(result?.key?.reason || '').trim();
        keyStatus.set(`样本验证通过,但未覆盖全部消息库分片,暂时不能保存。${reason}`, 'warn');
      } else {
        draft.validatedKey = null;
        syncManualKeyDraftState();
        const reason = String(result?.key?.reason || result?.db?.reason || '').trim();
        keyStatus.set(`验证未通过。${reason || '请确认密钥与当前账号匹配。'}`, 'err');
      }
      validationBox.hidden = true;
    } catch (error) {
      if (!page.alive(token) || isAbortError(error)) return;
      if (isDbMirrorFailure(error)) {
        rememberDbMirrorAutoFailure(error, context.accountId, {
          accounts: page.getAccounts?.() || [],
          accountFingerprint: context.fingerprint,
        });
      }
      draft.validatedKey = null;
      syncManualKeyDraftState();
      if (error?.status === 428 && error?.code === 'settings_revision_required') {
        keyStatus.set('设置版本缺失,请重新载入设置页后再验证。', 'err');
        page.markStale();
      } else if (error?.status === 409 && error?.code === 'settings_revision_conflict') {
        keyStatus.set('设置已在别处更新,请重新载入后再验证。', 'err');
        page.markStale();
      } else {
        keyStatus.set(errorText(error, '验证手动密钥失败'), 'err');
      }
      validationBox.hidden = true;
    } finally {
      stopProgressPolling(pollState);
      page.endAction(token);
    }
  }

  async function saveManualKey() {
    const validated = draft.validatedKey;
    if (!validated || validated.text !== keyInput.value.trim()) {
      keyStatus.set('请先通过“验证手动密钥”,再保存;密钥内容改动后需要重新验证。', 'warn');
      return;
    }
    const context = page.requestContext(currentAccount());
    if (!context) {
      keyStatus.set('保存手动密钥需要当前微信账号,请先在左下角选择账号。', 'err');
      return;
    }
    const token = page.beginAction('保存手动密钥', [saveKeyBtn, validateKeyBtn, clearKeyBtn]);
    keyStatus.set('正在保存手动密钥…');
    try {
      const result = await page.saveSection({
        wechat: { manual_key: validated.text },
        _request_context: context,
      }, { signal: token.signal, ownerToken: token });
      if (!page.alive(token)) return;
      keyInput.value = '';
      draft.validatedKey = null;
      syncManualKeyDraftState();
      keyStatus.set(page.saveSummaryText(result, '手动密钥已保存。'), page.saveHasWarnings(result) ? 'warn' : 'ok');
      saveKeyBtn.disabled = true;
      paintKeyState();
    } catch (error) {
      if (!page.alive(token) || isAbortError(error)) return;
      if (error?.status === 428 && error?.code === 'manual_key_full_validation_required') {
        keyStatus.set('验证状态已过期,请重新“验证手动密钥”后再保存。', 'err');
        draft.validatedKey = null;
      } else {
        keyStatus.set(errorText(error, '保存手动密钥失败'), 'err');
      }
    } finally {
      page.endAction(token);
    }
  }

  async function clearManualKey() {
    const w = wechat();
    const accountId = currentAccountId();
    const configuredIds = Array.isArray(w.manual_key_account_ids) ? w.manual_key_account_ids : [];
    const account = currentAccount();
    const aliases = [accountId, ...(Array.isArray(account?.account_aliases) ? account.account_aliases : [])]
      .map(value => String(value || '').trim()).filter(Boolean);
    if (!accountId || !aliases.some(alias => configuredIds.includes(alias))) {
      keyStatus.set('当前账号没有已保存的手动密钥。', 'warn');
      return;
    }
    const context = page.requestContext(currentAccount());
    if (!context) {
      keyStatus.set('清除手动密钥需要当前账号指纹,请刷新账号列表后重试。', 'err');
      return;
    }
    const confirmed = await ui.confirmDialog({
      title: '清除当前账号手动密钥',
      message: '将删除当前账号已保存的手动数据库密钥候选与验证记录;不影响其他账号。确认继续?',
      confirmLabel: '清除',
      danger: true,
    });
    if (!confirmed) return;
    const currentContext = page.requestContext(currentAccount());
    if (!currentContext
      || currentContext.account_id !== context.account_id
      || String(currentContext.expected_account_fingerprint || '')
        !== String(context.expected_account_fingerprint || '')) {
      keyStatus.set('账号已变化,请重新确认清除当前账号手动密钥。', 'warn');
      return;
    }
    const token = page.beginAction('清除手动密钥', [clearKeyBtn, saveKeyBtn, validateKeyBtn]);
    keyStatus.set('正在清除手动密钥…');
    try {
      const result = await page.saveSection({
        wechat: {
          clear_manual_key: true,
          clear_manual_key_account_id: context.account_id,
          clear_manual_key_account_aliases: context.account_aliases,
        },
        _request_context: context,
      }, { signal: token.signal, ownerToken: token });
      if (!page.alive(token)) return;
      draft.validatedKey = null;
      keyStatus.set(page.saveSummaryText(result, '当前账号手动密钥已清除。'), page.saveHasWarnings(result) ? 'warn' : 'ok');
      paintKeyState();
    } catch (error) {
      if (!page.alive(token) || isAbortError(error)) return;
      keyStatus.set(errorText(error, '清除手动密钥失败'), 'err');
    } finally {
      page.endAction(token);
    }
  }

  // 孤立候选(绑定的账号身份已失效):逐个按服务端专用清除通道删除。
  async function clearOrphanedKeys() {
    const ids = (Array.isArray(wechat().manual_key_orphaned_account_ids) ? wechat().manual_key_orphaned_account_ids : [])
      .map(value => String(value || '').trim()).filter(Boolean);
    if (!ids.length) return;
    const confirmed = await ui.confirmDialog({
      title: '清理孤立手动密钥候选',
      message: `将删除 ${ids.length} 个绑定已失效账号的手动密钥候选(不影响当前账号的密钥)。确认继续?`,
      confirmLabel: '清理',
      danger: true,
    });
    if (!confirmed) return;
    const token = page.beginAction('清理孤立手动密钥候选', [clearOrphanedBtn]);
    keyStatus.set('正在清理孤立候选…');
    try {
      let done = 0;
      for (const id of ids) {
        await page.saveSection({
          wechat: { clear_orphaned_manual_key: true, clear_orphaned_manual_key_account_id: id },
        }, { signal: token.signal, ownerToken: token });
        if (!page.alive(token)) return;
        done += 1;
      }
      keyStatus.set(`已清理 ${done} 个孤立候选。`, 'ok');
      paintKeyState();
    } catch (error) {
      if (!page.alive(token) || isAbortError(error)) return;
      keyStatus.set(errorText(error, '清理孤立候选失败'), 'err');
      paintKeyState();
    } finally {
      page.endAction(token);
    }
  }

  async function scanKey() {
    const context = validationAccountContext();
    if (!context) {
      scanStatus.set('请先在左下角选择微信账号。', 'err');
      return;
    }
    const progressId = createWechatStatusProgressId();
    const token = page.beginAction('自动扫描密钥', [scanKeyBtn, validateKeyBtn]);
    const pollState = startProgressPolling(progressId, token.signal);
    scanStatus.set('正在自动扫描密钥(只读检查本机微信数据,可能需要几分钟)…');
    try {
      const query = new URLSearchParams({ account: context.accountId, scan_key: 'true', validation_progress_id: progressId });
      if (context.fingerprint) query.set('expected_account_fingerprint', context.fingerprint);
      const result = await api.post(`/api/wechat/status?${query.toString()}`, {
        scan_key: true,
        validation_progress_id: progressId,
        ...(context.fingerprint ? { expected_account_fingerprint: context.fingerprint } : {}),
      }, { signal: token.signal, timeoutMs: KEY_SCAN_TIMEOUT_MS });
      if (!page.alive(token)) return;
      clearDbMirrorAutoFailure({
        accountId: context.accountId,
        accounts: page.getAccounts?.() || [],
        accountFingerprint: context.fingerprint,
      });
      page.applySettingsPayload(result?.settings || null, { revision: result?.settings_revision });
      const ok = result?.validation_ok === true || result?.key?.ok === true;
      const reason = String(result?.key?.reason || '').trim();
      scanStatus.set(ok ? '自动扫描成功,当前账号可以直接读取本地数据。' : `自动扫描未通过。${reason || '请改用手动密钥。'}`,
        ok ? 'ok' : 'warn');
      validationBox.hidden = true;
      paintKeyState();
    } catch (error) {
      if (!page.alive(token) || isAbortError(error)) return;
      if (isDbMirrorFailure(error)) {
        rememberDbMirrorAutoFailure(error, context.accountId, {
          accounts: page.getAccounts?.() || [],
          accountFingerprint: context.fingerprint,
        });
      }
      scanStatus.set(errorText(error, '自动扫描失败'), 'err');
      validationBox.hidden = true;
    } finally {
      stopProgressPolling(pollState);
      page.endAction(token);
    }
  }

  async function resetKeyCache() {
    const confirmed = await ui.confirmDialog({
      title: '重置自动密钥缓存',
      message: '将清除本机已缓存的自动数据库密钥,并停止当前摘要读取;下次读取会重新扫描验证。确认继续?',
      confirmLabel: '重置',
      danger: true,
    });
    if (!confirmed) return;
    const token = page.beginAction('重置自动密钥缓存', [resetCacheBtn]);
    toolStatus.set('正在重置自动密钥缓存…');
    try {
      const result = await api.post('/api/wxdb-key-cache/reset', { confirm_reset: true }, {
        signal: token.signal,
        timeoutMs: 60_000,
      });
      if (!page.alive(token)) return;
      const reset = requireWxdbKeyCacheResetResult(result);
      toolStatus.set(reset.changed === false ? '缓存已重置(原本就没有已验证缓存)。' : '自动密钥缓存已重置。', 'ok');
      paintKeyState();
    } catch (error) {
      if (!page.alive(token) || isAbortError(error)) return;
      if (error?.status === 428) {
        toolStatus.set('重置需要明确确认,请重试。', 'err');
      } else if (error?.code === 'wxdb_key_cache_reset_response_invalid') {
        toolStatus.set('缓存重置请求可能已经执行，但返回响应无效；请重新打开设置页确认，勿重复点击。', 'warn');
      } else {
        toolStatus.set(errorText(error, '重置失败'), 'err');
      }
    } finally {
      page.endAction(token);
    }
  }

  // ---------------------------------------------------------------------------
  // 诊断导出
  // ---------------------------------------------------------------------------
  async function downloadDiagnostics(scope) {
    const label = scope === 'full' ? '完整诊断' : '轻量诊断';
    const token = page.beginAction(`导出${label}`, [diagLightBtn, diagFullBtn]);
    toolStatus.set(`正在采集${label}…`);
    try {
      assertBrowserDownloadSupported({ requireObjectUrl: true });
      const query = scope === 'full' ? 'scope=full' : 'light=1';
      const response = await api.get(`/api/diagnostics?${query}`, {
        signal: token.signal,
        timeoutMs: scope === 'full' ? 300_000 : 120_000,
      });
      if (!page.alive(token)) return;
      const data = requireSettingsDiagnosticsResult(response, scope);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      downloadTextFile(`wx-summary-diagnostics-${scope}-${stamp}.json`, JSON.stringify(data, null, 2));
      toolStatus.set(`${label}已下载为 JSON 文件。`, 'ok');
    } catch (error) {
      if (!page.alive(token) || isAbortError(error)) return;
      toolStatus.set(errorText(error, `导出${label}失败`), 'err');
    } finally {
      page.endAction(token);
    }
  }

  // ---------------------------------------------------------------------------
  // 运行日志
  // ---------------------------------------------------------------------------
  function replaceLogPanelMessage(text) {
    logPanel.replaceChildren(el('div', { class: 'settings-log-line', text }));
  }

  async function refreshLogs() {
    const request = logViewLifecycle.begin(logView.value);
    const summary = request.view === 'summary';
    const viewLabel = summary ? '结构化摘要' : '原始日志';
    if (request.replaceContent) replaceLogPanelMessage(`(正在读取${viewLabel}…)`);
    const token = page.beginAction('读取日志', [logRefreshBtn], { focusCandidates: [logRefreshBtn, logView] });
    logStatus.set('正在读取日志…');
    try {
      const response = await api.get(`/api/logs?limit=200${summary ? '&view=summary' : ''}`, {
        signal: token.signal,
        timeoutMs: 30_000,
      });
      if (!page.alive(token) || !logViewLifecycle.isCurrent(request)) return;
      const data = requireSettingsLogResult(response, request.view);
      if (summary && Array.isArray(data?.entries) && data.entries.length) {
        logPanel.replaceChildren(...data.entries.map(entry => el('div', {
          class: 'settings-log-line',
          'data-level': String(entry?.level || ''),
          text: `${entry?.at || ''} [${String(entry?.level || '').toUpperCase()}] ${entry?.event || ''} ${entry?.fields ? JSON.stringify(entry.fields) : ''}`.trim(),
        })));
      } else {
        const lines = Array.isArray(data?.log_tail) ? data.log_tail : [];
        logPanel.replaceChildren(...(lines.length
          ? lines.map(line => {
            const level = /\bERROR\b/.test(line) ? 'error' : (/\bWARN\b/.test(line) ? 'warn' : '');
            return el('div', { class: 'settings-log-line', 'data-level': level, text: line });
          })
          : [el('div', { class: 'settings-log-line', text: '(暂无日志)' })]));
      }
      if (!logViewLifecycle.commit(request)) return;
      logStatus.set(`已更新(${fmtDateTime(new Date().toISOString())})。`, 'ok');
    } catch (error) {
      if (!page.alive(token) || !logViewLifecycle.isCurrent(request) || isAbortError(error)) return;
      if (logViewLifecycle.shouldReplaceAfterFailure(request)) {
        replaceLogPanelMessage(`(${viewLabel}读取失败，请重试。)`);
      }
      logStatus.set(errorText(error, '读取日志失败'), 'err');
    } finally {
      page.endAction(token);
    }
  }

  // ---- 事件 ------------------------------------------------------------------
  async function savePrivacy() {
    const patch = {};
    for (const [key, input] of toggles) patch[key] = input.checked;
    const token = page.beginAction('保存隐私设置', [savePrivacyBtn]);
    status.set('正在保存隐私设置…');
    try {
      const result = await page.saveSection({ privacy: patch }, { signal: token.signal, ownerToken: token });
      if (!page.alive(token)) return;
      draft.dirty = false;
      page.markDirty('privacy', false);
      status.set(page.saveSummaryText(result, '隐私设置已保存。'), page.saveHasWarnings(result) ? 'warn' : 'ok');
    } catch (error) {
      if (!page.alive(token) || isAbortError(error)) return;
      status.set(errorText(error, '保存隐私设置失败'), 'err');
    } finally {
      page.endAction(token);
    }
  }
  savePrivacyBtn.addEventListener('click', () => { void savePrivacy(); });
  keyInput.addEventListener('input', () => {
    if (draft.validatedKey && draft.validatedKey.text !== keyInput.value.trim()) {
      draft.validatedKey = null;
      keyStatus.set('密钥内容已修改,请重新验证后再保存。', 'warn');
    }
    saveKeyBtn.disabled = true;
    syncManualKeyDraftState();
  });
  validateKeyBtn.addEventListener('click', () => { void validateManualKey(); });
  saveKeyBtn.addEventListener('click', () => { void saveManualKey(); });
  clearKeyBtn.addEventListener('click', () => { void clearManualKey(); });
  clearOrphanedBtn.addEventListener('click', () => { void clearOrphanedKeys(); });
  scanKeyBtn.addEventListener('click', () => { void scanKey(); });
  resetCacheBtn.addEventListener('click', () => { void resetKeyCache(); });
  diagLightBtn.addEventListener('click', () => { void downloadDiagnostics('light'); });
  diagFullBtn.addEventListener('click', () => { void downloadDiagnostics('full'); });
  logRefreshBtn.addEventListener('click', () => { void refreshLogs(); });
  logView.addEventListener('change', () => { void refreshLogs(); });

  // ---- 装配 ------------------------------------------------------------------
  const section = el('section', { class: 'settings-section', 'data-section': 'privacy' },
    el('div', { class: 'settings-section-head' },
      el('h2', { class: 'settings-section-title', text: '隐私与安全' }),
      el('p', { class: 'muted', text: '发给 AI 前的脱敏规则、数据库密钥与诊断导出。' }),
    ),
    el('div', { class: 'card card-pad settings-card' },
      el('h3', { class: 'card-title', text: '发送给 AI 前的处理' }),
      toggleList,
      el('div', { class: 'settings-actions' }, savePrivacyBtn, status.el),
    ),
    el('div', { class: 'card card-pad settings-card' },
      el('h3', { class: 'card-title', text: '数据库密钥(按账号)' }),
      keyStateGrid,
      el('div', { class: 'settings-field' },
        el('label', { class: 'field-label', text: '手动数据库密钥' }),
        keyInput,
        el('div', { class: 'settings-hint', text: '密钥只写入本机密钥库,不会回显;先验证(覆盖全部消息库分片)通过后才能保存。' }),
      ),
      validationBox,
      el('div', { class: 'settings-actions' }, validateKeyBtn, saveKeyBtn, clearKeyBtn, clearOrphanedBtn, keyStatus.el),
      el('div', { class: 'settings-actions' }, scanKeyBtn, resetCacheBtn, scanStatus.el),
    ),
    el('div', { class: 'card card-pad settings-card' },
      el('h3', { class: 'card-title', text: '诊断导出' }),
      el('p', { class: 'muted', text: '诊断包已脱敏(不含 API Key / 手动密钥);完整诊断包含更详细的本机探测。' }),
      el('div', { class: 'settings-actions' }, diagLightBtn, diagFullBtn, toolStatus.el),
    ),
    el('div', { class: 'card card-pad settings-card' },
      el('h3', { class: 'card-title', text: '运行日志' }),
      el('div', { class: 'settings-inline' }, logView, logRefreshBtn, logStatus.el),
      logPanel,
    ),
  );

  return {
    id: 'privacy',
    el: section,
    applySettings,
    async saveDraft() {
      if (draft.dirty) await savePrivacy();
    },
    onAccountChanged() {
      discardManualKeyDraft();
      scanStatus.clear();
      paintKeyState();
    },
    onStateChanged() {
      paintKeyState();
    },
    setBusy(busy) {
      syncFormControlsDisabled([
        ...toggles.values(),
        keyInput,
        logView,
      ], busy);
      savePrivacyBtn.disabled = busy || !draft.dirty;
      validateKeyBtn.disabled = busy;
      scanKeyBtn.disabled = busy;
      resetCacheBtn.disabled = busy;
      clearKeyBtn.disabled = busy;
      clearOrphanedBtn.disabled = busy;
      diagLightBtn.disabled = busy || !downloadSupported;
      diagFullBtn.disabled = busy || !downloadSupported;
      logRefreshBtn.disabled = busy;
      if (busy) saveKeyBtn.disabled = true;
      else saveKeyBtn.disabled = !draft.validatedKey;
    },
  };
}
