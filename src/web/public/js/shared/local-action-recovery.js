// 本机副作用的浏览器侧恢复日志。
// 发送前先写入并回读记录；结果未知时保留，只有明确终态或明确拒绝才清理。
import { isMutationOutcomeUnknown } from './mutation-outcome.js';

export const LOCAL_ACTION_PENDING_STORAGE_LIMIT = 200;
export const LOCAL_ACTION_PENDING_RECORD_MAX_CHARS = 64 * 1024;
export const LOCAL_ACTION_EXPECTED_TARGET_TTL_MS = 10 * 60 * 1000;
export const LOCAL_ACTION_RECOVERY_TIMEOUT_MS = 38 * 1000;

const LOCAL_ACTION_RECOVERY_TERMINAL_CODES = new Set([
  'local_action_evidence_target_mismatch',
]);

export const LOCAL_ACTION_PENDING_KINDS = Object.freeze(new Set([
  'reveal',
  'open_output',
  'save_render',
  'export_preview',
  'history_rerender',
  'history_copy_current_output',
  'history_delete',
  'clipboard_copy',
  'preview_clipboard_copy',
  'text_clipboard_copy',
]));

const LOCAL_WINDOW_ACTION_KINDS = new Set(['reveal', 'open_output']);
const ACTION_ID_RE = /^[a-z0-9][a-z0-9_-]{5,80}$/i;

function localActionRecoveryTerminalError(error = null) {
  const code = String(error?.code || error?.public_code || '').trim();
  return LOCAL_ACTION_RECOVERY_TERMINAL_CODES.has(code) ? error : null;
}

export function localActionPendingStoragePrefix(origin = globalThis.location?.origin || '') {
  return `wx-summary:pending-local-actions:${String(origin || '').trim()}:v2:`;
}

export function pendingLocalActionStorageKey(actionId = '', origin = globalThis.location?.origin || '') {
  const cleanId = String(actionId || '').trim();
  return ACTION_ID_RE.test(cleanId)
    ? `${localActionPendingStoragePrefix(origin)}${cleanId}`
    : '';
}

export function localActionKindFromRequest(path = '', actionId = '', body = null) {
  const cleanPath = String(path || '').split('?')[0];
  if (cleanPath === '/api/reveal' || cleanPath === '/api/reveal-output') return 'reveal';
  if (cleanPath === '/api/open-output') return 'open_output';
  if (cleanPath === '/api/save-render') return 'save_render';
  if (cleanPath === '/api/export-preview') return 'export_preview';
  if (cleanPath === '/api/history-copy-current-output') return 'history_copy_current_output';
  if (cleanPath === '/api/history-delete') return 'history_delete';
  if (cleanPath.includes('rerender')) return 'history_rerender';
  if (cleanPath === '/api/copy-text' || cleanPath === '/api/copy-path') return 'text_clipboard_copy';
  if (cleanPath === '/api/browser-clipboard-action') {
    return String(body?.kind || '').trim() || 'preview_clipboard_copy';
  }
  if (cleanPath.includes('preview') && cleanPath.includes('clipboard')) {
    return String(body?.kind || '').trim() || 'preview_clipboard_copy';
  }
  if (cleanPath.includes('copy-image') || cleanPath.includes('clipboard')) return 'clipboard_copy';
  const prefix = String(actionId || '').split('_')[0].replace(/-/g, '_');
  return LOCAL_ACTION_PENDING_KINDS.has(prefix) ? prefix : '';
}

export function localActionRecoveryStorageUnavailableError(cause = null) {
  const error = new Error('浏览器无法保存本地操作恢复记录，操作尚未发送；请允许本站使用本地存储后重试。');
  error.status = 503;
  error.code = 'local_action_recovery_storage_unavailable';
  error.userMessage = error.message;
  if (cause instanceof Error) error.cause = cause;
  return error;
}

function localActionRecoveryCleanupUnavailableError(cause = null) {
  const error = new Error('浏览器无法清理本地操作恢复记录，操作结果仍需核对；请允许本站使用本地存储后重试。');
  error.status = 503;
  error.code = 'local_action_recovery_cleanup_unavailable';
  error.userMessage = error.message;
  if (cause instanceof Error) error.cause = cause;
  return error;
}

export function pendingLocalActionCapacityError(count = LOCAL_ACTION_PENDING_STORAGE_LIMIT) {
  const currentCount = Math.max(LOCAL_ACTION_PENDING_STORAGE_LIMIT, Number(count || 0) || 0);
  const error = new Error(`已有 ${currentCount} 个本地操作等待确认，已暂停发送新操作，避免丢失恢复记录。请等待当前操作完成，或刷新页面恢复状态后重试。`);
  error.status = 429;
  error.code = 'local_action_recovery_capacity_reached';
  error.userMessage = error.message;
  return error;
}

function storageOrThrow(storage = globalThis.localStorage) {
  if (!storage || typeof storage.getItem !== 'function'
      || typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') {
    throw localActionRecoveryStorageUnavailableError(new Error('localStorage unavailable'));
  }
  return storage;
}

function compactTarget(value = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value;
  const aliases = {
    digest_id: source.digest_id,
    history_item_key: source.history_item_key,
    relative_path: source.relative_path,
    expected_file_version: source.expected_file_version || source.file_version,
    expected_digest_file_version: source.expected_digest_file_version || source.digest_file_version,
    output_dir_identity: source.output_dir_identity || source.expected_output_dir_identity,
    settings_revision: source.settings_revision
      || source.expected_settings_revision
      || source.export_policy_revision
      || source.export_settings_revision,
  };
  const target = {};
  for (const [key, valueForKey] of Object.entries(aliases)) {
    const text = String(valueForKey || '').trim();
    if (text) target[key] = text.slice(0, 512);
  }
  return Object.keys(target).length ? target : null;
}

export function normalizePendingLocalActionRecord(value = {}, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const actionId = String(value.action_id || '').trim();
  const kind = String(value.kind || '').trim();
  const at = Number(value.at || 0) || 0;
  if (!ACTION_ID_RE.test(actionId)
      || !LOCAL_ACTION_PENDING_KINDS.has(kind)
      || !at
      || at > now + 60_000
      || now - at > LOCAL_ACTION_EXPECTED_TARGET_TTL_MS) return null;
  return {
    action_id: actionId,
    kind,
    target: compactTarget(value.target),
    at,
  };
}

function storageKeys(storage, prefix) {
  const keys = [];
  if (typeof storage.length !== 'number' || typeof storage.key !== 'function') return keys;
  for (let index = 0; index < storage.length; index += 1) {
    const key = String(storage.key(index) || '');
    if (key.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

export function readPendingLocalActionRecords({
  storage = globalThis.localStorage,
  origin = globalThis.location?.origin || '',
  now = Date.now(),
} = {}) {
  const target = storageOrThrow(storage);
  const prefix = localActionPendingStoragePrefix(origin);
  const records = [];
  for (const key of storageKeys(target, prefix)) {
    let serialized = null;
    try {
      serialized = target.getItem(key);
    } catch (error) {
      throw localActionRecoveryStorageUnavailableError(error);
    }
    let record = null;
    try { record = normalizePendingLocalActionRecord(JSON.parse(serialized || 'null'), now); } catch {}
    if (!record || key !== pendingLocalActionStorageKey(record.action_id, origin)) {
      try {
        target.removeItem(key);
      } catch (error) {
        throw localActionRecoveryCleanupUnavailableError(error);
      }
      continue;
    }
    records.push(record);
  }
  return records.sort((left, right) => left.at - right.at);
}

export function assertPendingLocalActionCapacity(actionId = '', records = [], {
  recordAlreadyPersisted = false,
} = {}) {
  const cleanId = String(actionId || '').trim();
  const validRecords = Array.isArray(records) ? records : [];
  const alreadyRecorded = !!cleanId && validRecords.some(record => record?.action_id === cleanId);
  const reached = recordAlreadyPersisted
    ? validRecords.length > LOCAL_ACTION_PENDING_STORAGE_LIMIT
    : !alreadyRecorded && validRecords.length >= LOCAL_ACTION_PENDING_STORAGE_LIMIT;
  if (reached) throw pendingLocalActionCapacityError(validRecords.length);
  return validRecords;
}

export function localWindowActionInFlight(excludeActionId = '', {
  records = null,
  now = Date.now(),
} = {}) {
  const excluded = String(excludeActionId || '').trim();
  return (records || []).some(record => LOCAL_WINDOW_ACTION_KINDS.has(record?.kind)
    && record.action_id !== excluded
    && now - Number(record.at || 0) <= LOCAL_ACTION_RECOVERY_TIMEOUT_MS);
}

export function localWindowActionConflictError() {
  const error = new Error('已有文件管理器操作正在等待最终确认；请等当前操作完成后再试。');
  error.status = 409;
  error.code = 'local_window_action_in_progress';
  error.userMessage = error.message;
  return error;
}

function targetFromRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const digest = body.digest && typeof body.digest === 'object' ? body.digest : {};
  const history = body.history && typeof body.history === 'object' ? body.history : {};
  const source = { ...digest, ...history, ...body };
  return compactTarget({
    digest_id: source.digest_id,
    history_item_key: source.history_item_key,
    relative_path: source.relative_path,
    expected_file_version: source.expected_file_version || source.file_version,
    expected_digest_file_version: source.expected_digest_file_version || source.digest_file_version,
    output_dir_identity: source.expected_output_dir_identity || source.output_dir_identity,
    settings_revision: source.expected_settings_revision || source.settings_revision,
  });
}

export function beginLocalActionRecovery({
  actionId,
  kind,
  target = null,
  storage = globalThis.localStorage,
  origin = globalThis.location?.origin || '',
  now = Date.now(),
} = {}) {
  const cleanId = String(actionId || '').trim();
  const cleanKind = String(kind || '').trim();
  if (!ACTION_ID_RE.test(cleanId) || !LOCAL_ACTION_PENDING_KINDS.has(cleanKind)) {
    const error = new Error('本地操作恢复记录缺少可识别的动作类型，操作尚未发送；请刷新页面后重试。');
    error.status = 500;
    error.code = 'local_action_recovery_binding_invalid';
    throw error;
  }
  const targetStorage = storageOrThrow(storage);
  const records = readPendingLocalActionRecords({ storage: targetStorage, origin, now });
  if (LOCAL_WINDOW_ACTION_KINDS.has(cleanKind)
      && localWindowActionInFlight(cleanId, { records, now })) {
    throw localWindowActionConflictError();
  }
  assertPendingLocalActionCapacity(cleanId, records);
  const record = normalizePendingLocalActionRecord({
    action_id: cleanId,
    kind: cleanKind,
    target,
    at: now,
  }, now);
  if (!record) throw localActionRecoveryStorageUnavailableError(new Error('本地操作恢复记录格式无效'));
  const key = pendingLocalActionStorageKey(cleanId, origin);
  const serialized = JSON.stringify(record);
  if (serialized.length > LOCAL_ACTION_PENDING_RECORD_MAX_CHARS) {
    throw localActionRecoveryStorageUnavailableError(new Error('本地操作恢复记录过大'));
  }
  try {
    targetStorage.setItem(key, serialized);
    if (targetStorage.getItem(key) !== serialized) throw new Error('本地存储写入后校验失败');
    const after = readPendingLocalActionRecords({ storage: targetStorage, origin, now });
    assertPendingLocalActionCapacity(cleanId, after, { recordAlreadyPersisted: true });
    if (targetStorage.getItem(key) === null) throw new Error('本地操作恢复记录在容量整理后丢失');
    return record;
  } catch (error) {
    try { targetStorage.removeItem(key); } catch {}
    if (error?.code === 'local_action_recovery_capacity_reached') throw error;
    throw localActionRecoveryStorageUnavailableError(error);
  }
}

export function forgetLocalActionRecovery(actionId = '', {
  storage = globalThis.localStorage,
  origin = globalThis.location?.origin || '',
} = {}) {
  const key = pendingLocalActionStorageKey(actionId, origin);
  if (!key) return false;
  const target = storageOrThrow(storage);
  try {
    target.removeItem(key);
  } catch (error) {
    throw localActionRecoveryCleanupUnavailableError(error);
  }
  return true;
}

function committed(result = {}) {
  return result?.local_action_committed === true
    || result?.item?.local_action_committed === true
    || result?.reveal?.local_action_committed === true
    || result?.opener?.local_action_committed === true;
}

function verified(result = {}) {
  return result?.verified === true
    || result?.clipboard_verified === true
    || result?.evidence_verified === true
    || String(result?.status || '').trim() === 'verified'
    || String(result?.verification_status || '').trim() === 'verified'
    || String(result?.reveal?.verification_status || '').trim() === 'verified'
    || String(result?.opener?.verification_status || '').trim() === 'verified';
}

export function localActionEvidenceSettled(kind = '', result = null) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  if (result.local_action_recovery_cleanup_failed === true) return false;
  const cleanKind = String(kind || result.kind || '').trim();
  if (result.evidence_persisted === false) return false;
  if (cleanKind === 'history_delete' && result.local_action_recovery_failed === true) {
    return result.evidence_persisted === true;
  }
  // 能力探测明确失败且尚未尝试系统动作，服务端已确认本次副作用未执行。
  if (result.clipboard_supported === false && result.clipboard_attempted !== true) return true;
  const phase = String(result.phase || result.browser_clipboard_phase || '').trim();
  if (phase === 'prepared') return false;
  if (cleanKind === 'text_clipboard_copy') {
    if (result.action_state === 'outcome_unknown') return result.evidence_persisted === true;
    return committed(result) && result.evidence_persisted === true
      && (result.clipboard_verified === true || result.evidence_verified === true || verified(result));
  }
  if (cleanKind === 'preview_clipboard_copy') {
    return result.evidence_persisted === true
      && ['browser_committed', 'browser_rejected', 'outcome_unknown'].includes(phase);
  }
  if (!committed(result)) return false;
  const pending = result.local_action_recovery_pending === true
    || result.verification_pending === true
    || result.reveal?.verification_pending === true
    || result.opener?.verification_pending === true;
  return !pending && (verified(result) || !!result.item || !!result.relative_path);
}

export function completeLocalActionRecoveryAfterResponse(actionId, response, options = {}) {
  const kind = String(options.kind || '').trim();
  if (!localActionEvidenceSettled(kind, response)) return false;
  return forgetLocalActionRecovery(actionId, options);
}

export function completeLocalActionRecoveryAfterError(actionId, error, options = {}) {
  if (isMutationOutcomeUnknown(error)) return false;
  return forgetLocalActionRecovery(actionId, options);
}

export function localActionTargetFromRequest(body) {
  return targetFromRequest(body);
}

export function localActionEvidenceQuery(kind = '', actionId = '', target = null) {
  const params = new URLSearchParams({
    kind: String(kind || '').trim(),
    action_id: String(actionId || '').trim(),
  });
  for (const [key, value] of Object.entries(compactTarget(target) || {})) {
    if (value) params.set(key, value);
  }
  return `/api/local-action-evidence?${params.toString()}`;
}

// 页面销毁后仍可短暂核对已发出的本机副作用,但绝不重放请求。
export async function settleLocalActionInBackground({
  api,
  actionId,
  kind,
  target = null,
  signal = null,
  intervalMs = 1000,
  maxWaitMs = LOCAL_ACTION_RECOVERY_TIMEOUT_MS,
  onSettled = null,
} = {}) {
  if (!api?.get || !String(actionId || '').trim() || !String(kind || '').trim()) {
    return { settled: false, skipped: true };
  }
  const startedAt = Date.now();
  const path = localActionEvidenceQuery(kind, actionId, target);
  while (Date.now() - startedAt <= Math.max(0, Number(maxWaitMs) || 0)) {
    if (signal?.aborted) return { settled: false, cancelled: true };
    const remaining = Math.max(0, Number(maxWaitMs) || 0) - (Date.now() - startedAt);
    if (!remaining) break;
    const requestController = new AbortController();
    let removeAbortListener = () => {};
    const abortRequest = () => {
      try {
        requestController.abort(signal?.reason || new Error('本地动作核对已取消'));
      } catch {}
    };
    if (signal?.addEventListener) {
      signal.addEventListener('abort', abortRequest, { once: true });
      removeAbortListener = () => signal.removeEventListener?.('abort', abortRequest);
      if (signal.aborted) {
        abortRequest();
        removeAbortListener();
        return { settled: false, cancelled: true };
      }
    }
    let requestTimedOut = false;
    let terminalError = null;
    let timeoutId = null;
    const request = Promise.resolve().then(() => api.get(path, {
      signal: requestController.signal,
      timeoutMs: Math.max(1, Number(intervalMs) || 1) * 4,
    }));
    // API 实现可能忽略 abort;即使本次请求晚到/拒绝,也不能形成未处理拒绝。
    request.catch(() => {});
    let payload;
    try {
      payload = await Promise.race([
        request,
        new Promise(resolve => {
          timeoutId = setTimeout(() => {
            requestTimedOut = true;
            abortRequest();
            resolve(null);
          }, remaining);
        }),
      ]);
    } catch (error) {
      terminalError = localActionRecoveryTerminalError(error);
      payload = null;
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
      removeAbortListener();
    }
    if (requestTimedOut) break;
    if (signal?.aborted) return { settled: false, cancelled: true };
    if (terminalError) {
      let cleanupError = null;
      try { forgetLocalActionRecovery(actionId); } catch (error) { cleanupError = error; }
      if (cleanupError) {
        return {
          settled: false,
          terminal: true,
          cleanup_failed: true,
          error: terminalError,
          cleanup_error: cleanupError,
        };
      }
      return { settled: false, terminal: true, error: terminalError };
    }
    const evidence = payload?.evidence || payload;
    if (localActionEvidenceSettled(kind, evidence)) {
      let cleanupError = null;
      try { forgetLocalActionRecovery(actionId); } catch (error) { cleanupError = error; }
      if (cleanupError) {
        return {
          settled: false,
          cleanup_failed: true,
          evidence,
          cleanup_error: cleanupError,
        };
      }
      try { onSettled?.(evidence); } catch {}
      return { settled: true, evidence };
    }
    const nextRemaining = Math.max(0, Number(maxWaitMs) || 0) - (Date.now() - startedAt);
    if (!nextRemaining) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(Math.max(0, Number(intervalMs) || 0), nextRemaining)));
  }
  return { settled: false };
}
