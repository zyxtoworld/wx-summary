import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { LEGACY_MANUAL_KEY_POLICY, collectMessages, dbKeyRuntimeStateVersion, emptyCollectionMirrorRecheckRecentlyVerified, emptyCollectionMirrorRecheckSummary, hasFailedAutoRawKeyScan, hasVerifiedAutoRawKeys, listAccounts, listGroups, messageCollectionTargetLastMessageEvidence, rememberEmptyCollectionMirrorRecheck, shouldRecheckMirrorForEmptyCollection } from '../collector/index.js';
import { MAX_SCHEDULER_INTERVAL_MS, durationToMs, loadSettings, manualKeyAccountFingerprint, manualKeyVerifiedForAccount, saveSettingsPatchInTransaction, withSettingsSaveTransaction } from '../config/settings.js';
import { ensureHistoryArtifactIndexed, outputFileVersion, outputFileVersionMatches, recoverHistoryArtifactByDigestId, saveRenderedPng } from '../renderer/output.js';
import { assertServerPngRenderAvailable, normalizeRenderOptions, renderDigestPngBuffer } from '../renderer/server-png.js';
import { summarizeDigest, sanitizeText } from '../summarizer/llm.js';
import { assertCursorSeenListFits, getAccountGroupCursorState, getGroupCursorState, setAccountGroupCursorState } from '../store/cursors.js';
import { logError, logInfo, logWarn } from '../lib/logger.js';
import { DATA_DIR, OUTPUTS_DIR, OUTPUTS_TMP_DIR, PROJECT_ROOT, isInside, outputDirFromSettings } from '../lib/paths.js';
import { PRIVATE_FILE_MODE, readJson, writeJsonAtomic } from '../lib/json-store.js';
import { preserveInvalidFileBackup } from '../lib/invalid-backup.js';
import { MAX_MESSAGE_SHARD_CURSOR_POSITIONS, isMessageShardCursorKey, normalizeMessageShardCursorPosition } from '../lib/message-shard-cursor.js';
import { currentWxKeyProcessGeneration } from '../wxkey/index.js';
import { releaseWxDbIsolatedBatchSession } from '../wxdb/isolated.js';
import { ensureWxDbMirror, isWxDbMirrorIdentityVerified } from '../wxenv/discovery.js';

const state = {
  enabled: false,
  running: false,
  timer_active: false,
  runtime_state_degraded: false,
  runtime_stopped_reason: '',
  interval_ms: 0,
  next_run_at: '',
  last_started_at: '',
  last_finished_at: '',
  last_error: '',
  last_result: null,
  last_result_stale: false,
  last_request_result: null,
  settings_revision: '',
  scheduler_runtime_revision: '',
  scheduler_schedule_revision: '',
  lifecycle_transition: '',
  active_progress: null,
};

let timer = null;
let activeRunPromise = null;
let activeRunController = null;
let activeTimerCyclePromise = null;
let activeTimerCycleController = null;
let activeRunPartialResult = null;
let activeRunLease = null;
let schedulerGeneration = 0;
let schedulerLifecycleQueue = Promise.resolve();
let schedulerLifecycleTransition = null;
let schedulerTerminalShutdown = false;
let schedulerIdleRestart = null;
let schedulerManualDigestActivityProbe = null;
const SCHEDULER_LATE_SYNC_GRACE_MS = 30 * 60 * 1000;
const SCHEDULER_LATE_SYNC_LOOKBACK_MS = 48 * 60 * 60 * 1000;
const SCHEDULER_PENDING_CURSOR_FILE = path.join(DATA_DIR, 'scheduler-pending-cursors.json');
const SCHEDULER_AUTO_KEY_FAILURE_FILE = path.join(DATA_DIR, 'scheduler-auto-key-failures.json');
const SCHEDULER_RUNTIME_STATE_FILE = path.join(DATA_DIR, 'scheduler-runtime.json');
const MAX_SCHEDULER_PENDING_CURSORS = 100;
const SCHEDULER_PENDING_CURSOR_MAX_BYTES = 16 * 1024 * 1024;
const MAX_SCHEDULER_AUTO_KEY_FAILURES = 500;
const SCHEDULER_AUTO_KEY_FAILURE_MAX_BYTES = 1024 * 1024;
const SCHEDULER_RUNTIME_STATE_MAX_BYTES = 64 * 1024;
const SCHEDULER_AUTO_KEY_FAILURE_TTL_MS = 3 * 60 * 1000;
const SCHEDULER_LAST_REQUEST_RESULT_TTL_MS = 30_000;
const SCHEDULER_MANUAL_DIGEST_BUSY_RETRY_MS = 30_000;
const SCHEDULER_RECOVERY_RETRY_MS = 30_000;
let SCHEDULER_PENDING_CURSOR_STORE_INVALID_INFO = null;
let SCHEDULER_AUTO_KEY_FAILURE_STORE_INVALID_INFO = null;
let SCHEDULER_RUNTIME_STATE_INVALID_INFO = null;
let SCHEDULER_AUTO_KEY_FAILURE_QUEUE = Promise.resolve();
let SCHEDULER_RUNTIME_STATE_QUEUE = Promise.resolve();

function updateActiveSchedulerProgress(patch = {}) {
  if (!state.running) return null;
  const current = state.active_progress && typeof state.active_progress === 'object'
    ? state.active_progress
    : {};
  const textField = (key, limit) => {
    const value = Object.hasOwn(patch, key) ? patch[key] : current[key];
    return sanitizeText(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  };
  const countField = key => {
    const value = Object.hasOwn(patch, key) ? patch[key] : current[key];
    return Math.max(0, Math.floor(Number(value || 0) || 0));
  };
  state.active_progress = {
    phase: textField('phase', 80),
    label: textField('label', 120),
    detail: textField('detail', 240),
    total_targets: countField('total_targets'),
    completed_targets: countField('completed_targets'),
    current_index: countField('current_index'),
    account: textField('account', 80),
    group: textField('group', 120),
    updated_at: new Date().toISOString(),
  };
  return state.active_progress;
}

export function setSchedulerManualDigestActivityProbe(probe = null) {
  if (probe !== null && typeof probe !== 'function') {
    throw new TypeError('scheduler manual digest activity probe must be a function or null');
  }
  schedulerManualDigestActivityProbe = probe;
}

function schedulerManualDigestActivityActive() {
  if (!schedulerManualDigestActivityProbe) return false;
  try {
    return schedulerManualDigestActivityProbe() === true;
  } catch (error) {
    logError('scheduler_manual_digest_activity_probe_failed', {
      error: sanitizeText(error?.message || String(error)),
    });
    return true;
  }
}

function withSchedulerAutoKeyFailureLock(action) {
  const run = SCHEDULER_AUTO_KEY_FAILURE_QUEUE.then(action, action);
  SCHEDULER_AUTO_KEY_FAILURE_QUEUE = run.catch(() => {});
  return run;
}

function withSchedulerRuntimeStateLock(action) {
  const run = SCHEDULER_RUNTIME_STATE_QUEUE.then(action, action);
  SCHEDULER_RUNTIME_STATE_QUEUE = run.catch(() => {});
  return run;
}

function schedulerStoreBackupTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function schedulerProjectRelative(file = '') {
  const resolved = path.resolve(String(file || ''));
  return isInside(PROJECT_ROOT, resolved) ? path.relative(PROJECT_ROOT, resolved) : resolved;
}

function schedulerRuntimeStatePayload(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw Object.assign(new Error('调度运行状态文件格式不是对象。'), { code: 'scheduler_runtime_state_invalid_shape' });
  }
  const version = Number(raw.version || 0) || 0;
  const scheduleRevision = String(raw.schedule_revision || '').trim();
  const nextRunAt = String(raw.next_run_at || '').trim();
  const intervalMs = Math.max(0, Number(raw.interval_ms || 0) || 0);
  const nextRunMs = Date.parse(nextRunAt);
  if (version !== 2 || !scheduleRevision || !Number.isFinite(nextRunMs) || intervalMs < 1000 || intervalMs > MAX_SCHEDULER_INTERVAL_MS) {
    throw Object.assign(new Error('调度运行状态文件缺少有效的时钟版本、到期时间或执行间隔。'), { code: 'scheduler_runtime_state_invalid_entry' });
  }
  return {
    version: 2,
    schedule_revision: scheduleRevision,
    next_run_at: new Date(nextRunMs).toISOString(),
    interval_ms: Math.floor(intervalMs),
    updated_at: String(raw.updated_at || new Date().toISOString()),
  };
}

function schedulerPersistedNextDelay(raw = null, settings = {}, defaultDelayMs = 0, now = Date.now()) {
  const fallback = Math.min(MAX_SCHEDULER_INTERVAL_MS, Math.max(1000, Number(defaultDelayMs || 0)));
  if (!raw) return { delay_ms: fallback, restored: false, reason: 'missing' };
  let saved;
  try {
    saved = schedulerRuntimeStatePayload(raw);
  } catch {
    return { delay_ms: fallback, restored: false, reason: 'invalid' };
  }
  const currentRevision = schedulerScheduleRevision(settings);
  const currentInterval = Math.min(MAX_SCHEDULER_INTERVAL_MS, Math.max(1000, Number(defaultDelayMs || 0)));
  if (!currentRevision || saved.schedule_revision !== currentRevision || saved.interval_ms !== currentInterval) {
    return { delay_ms: fallback, restored: false, reason: 'settings_changed' };
  }
  const remaining = Date.parse(saved.next_run_at) - Number(now || Date.now());
  return {
    delay_ms: Math.min(MAX_SCHEDULER_INTERVAL_MS, Math.max(1000, remaining)),
    restored: true,
    reason: remaining <= 0 ? 'overdue' : 'remaining_interval',
    next_run_at: saved.next_run_at,
  };
}

async function loadSchedulerRuntimeState() {
  try {
    const raw = await readJson(SCHEDULER_RUNTIME_STATE_FILE, null, {
      strict: true,
      maxBytes: SCHEDULER_RUNTIME_STATE_MAX_BYTES,
    });
    if (raw === null) return null;
    return schedulerRuntimeStatePayload(raw);
  } catch (e) {
    const preserved = await preserveInvalidFileBackup(SCHEDULER_RUNTIME_STATE_FILE, {
      maxBytes: SCHEDULER_RUNTIME_STATE_MAX_BYTES,
      mode: PRIVATE_FILE_MODE,
    }).catch(backupError => {
      logWarn('scheduler_runtime_state_invalid_backup_failed', { error: sanitizeText(backupError?.message || String(backupError)) });
      return {
        original_path: SCHEDULER_RUNTIME_STATE_FILE,
        backup_path: '',
        backup_available: false,
        original_preserved: true,
      };
    });
    const evidencePath = preserved.backup_path || preserved.original_path || '';
    SCHEDULER_RUNTIME_STATE_INVALID_INFO = {
      status: 'invalid_rebuilding',
      backup_relative_path: evidencePath ? schedulerProjectRelative(evidencePath) : '',
      backup_available: preserved.backup_available === true,
      original_preserved: preserved.original_preserved === true,
      error: sanitizeText(e?.message || String(e || '')).slice(0, 240),
    };
    logWarn('scheduler_runtime_state_invalid', {
      backup: SCHEDULER_RUNTIME_STATE_INVALID_INFO.backup_relative_path,
      error: SCHEDULER_RUNTIME_STATE_INVALID_INFO.error,
    });
    return null;
  }
}

async function persistSchedulerRuntimeState(settings = {}, nextRunAt = '', intervalMs = 0) {
  return withSchedulerRuntimeStateLock(async () => {
    const payload = schedulerRuntimeStatePayload({
      version: 2,
      schedule_revision: schedulerScheduleRevision(settings),
      next_run_at: nextRunAt,
      interval_ms: intervalMs,
      updated_at: new Date().toISOString(),
    });
    try {
      await writeJsonAtomic(SCHEDULER_RUNTIME_STATE_FILE, payload, {
        mode: PRIVATE_FILE_MODE,
        maxBytes: SCHEDULER_RUNTIME_STATE_MAX_BYTES,
      });
      SCHEDULER_RUNTIME_STATE_INVALID_INFO = null;
      return true;
    } catch (e) {
      SCHEDULER_RUNTIME_STATE_INVALID_INFO = {
        status: 'write_failed',
        backup_relative_path: '',
        backup_available: false,
        original_preserved: true,
        error: sanitizeText(e?.message || String(e || '')).slice(0, 240),
      };
      logWarn('scheduler_runtime_state_write_failed', { error: SCHEDULER_RUNTIME_STATE_INVALID_INFO.error });
      return false;
    }
  });
}

function schedulerBaseSettingsNeedSetup(settings = {}) {
  return !!settings?._secrets_invalid
    || !settings?.llm?.base_url
    || !(settings?.llm?.api_key_set || settings?.llm?.api_key)
    || !settings?.llm?.model;
}

function schedulerSettingsNeedSetup(settings = {}, accounts = []) {
  return schedulerBaseSettingsNeedSetup(settings)
    || schedulerManualKeyTargetReadiness(settings, accounts).all_target_accounts_blocked;
}

async function schedulerSettingsNeedSetupWithRuntime(settings = {}, accounts = [], { signal = null } = {}) {
  return !!await schedulerSettingsPauseReasonWithRuntime(settings, accounts, { signal });
}

async function schedulerSettingsPauseReasonWithRuntime(settings = {}, accounts = [], { signal = null } = {}) {
  if (schedulerBaseSettingsNeedSetup(settings)) return schedulerPersistedDisabledReason('setup_required', settings);
  const preview = await previewScheduledTargets(settings, { signal, accounts });
  return schedulerTargetAutoPauseReason(settings, preview);
}

function settingsRevision(settings = {}) {
  return String(settings?.settings_revision || '').trim();
}

function schedulerRuntimeRevision(settings = {}) {
  return String(settings?.scheduler_runtime_revision || '').trim();
}

function schedulerScheduleRevision(settings = {}) {
  return String(settings?.scheduler_schedule_revision || '').trim();
}

function schedulerResultStaleForRevision(result = null, nextRevision = '', fallbackRevision = '') {
  if (!result || typeof result !== 'object') return false;
  const currentRevision = String(nextRevision || '').trim();
  const resultRevision = String(result.scheduler_runtime_revision_used || fallbackRevision || '').trim();
  return !!currentRevision && !!resultRevision && currentRevision !== resultRevision;
}

function rememberSchedulerSettingsRevision(settings = {}) {
  const nextSettingsRevision = settingsRevision(settings);
  const nextRuntimeRevision = schedulerRuntimeRevision(settings);
  const previousRuntimeRevision = String(state.scheduler_runtime_revision || '').trim();
  if (schedulerResultStaleForRevision(state.last_result, nextRuntimeRevision, previousRuntimeRevision)) state.last_result_stale = true;
  state.settings_revision = nextSettingsRevision;
  state.scheduler_runtime_revision = nextRuntimeRevision;
  state.scheduler_schedule_revision = schedulerScheduleRevision(settings);
  return nextSettingsRevision;
}

function setSchedulerLastResult(result = null) {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const settingsRevisionUsed = String(result.settings_revision_used || state.settings_revision || '').trim();
    const runtimeRevisionUsed = String(result.scheduler_runtime_revision_used || state.scheduler_runtime_revision || '').trim();
    state.last_result = {
      ...result,
      ...(settingsRevisionUsed && !result.settings_revision_used ? { settings_revision_used: settingsRevisionUsed } : {}),
      ...(runtimeRevisionUsed && !result.scheduler_runtime_revision_used
        ? { scheduler_runtime_revision_used: runtimeRevisionUsed }
        : {}),
    };
  } else {
    state.last_result = result;
  }
  state.last_result_stale = false;
  return state.last_result;
}

function schedulerAutoDisabledMeta(settings = {}, previousRevision = '') {
  if (settings?.scheduler?.enabled !== false) return {};
  return {
    scheduler_disabled_after_run: true,
    scheduler_disabled_reason: String(settings.scheduler?.disabled_reason || ''),
    scheduler_disabled_at: String(settings.scheduler?.disabled_at || ''),
    settings_revision_after_disable: settingsRevision(settings) || String(previousRevision || ''),
  };
}

function schedulerPersistentDisableFailureMessage(error = null) {
  const detail = sanitizeText(error?.message || String(error || '')).trim();
  return detail
    ? `后台定时任务需要暂停，但写入设置失败：${detail}。请检查设置文件权限或重启本地服务后再试。`
    : '后台定时任务需要暂停，但写入设置失败。请检查设置文件权限或重启本地服务后再试。';
}

function markSchedulerPersistentDisableFailed(error, { reason = 'setup_required', generation = schedulerGeneration } = {}) {
  const message = schedulerPersistentDisableFailureMessage(error);
  const result = {
    ok: false,
    reason,
    detail: 'scheduler_persistent_disable_failed',
    error: message,
    at: new Date().toISOString(),
  };
  if (!schedulerGenerationCanPublish(generation)) return { message, result, published: false };
  state.enabled = false;
  state.timer_active = false;
  state.runtime_state_degraded = false;
  state.next_run_at = '';
  state.runtime_stopped_reason = 'scheduler_persistent_disable_failed';
  state.last_error = message;
  setSchedulerLastResult(result);
  logWarn('scheduler_persistent_disable_failed', { reason, error: sanitizeText(error?.message || String(error || '')) });
  return { message, result, published: true };
}

function schedulerStaleSettingsError(message = '设置已变化，已停止旧调度任务提交。', detail = 'stale_settings_before_save') {
  const err = new Error(message);
  err.code = 'stale_settings';
  err.detail = detail;
  err.scheduler_no_retry = true;
  return err;
}

function schedulerSettingsRevisionConflictError(expected = '', actual = '') {
  const err = new Error('设置已变化，已停止本次手动检查；请刷新设置页并重新确认后再执行。');
  err.status = 409;
  err.code = 'settings_revision_conflict';
  err.public_code = 'settings_revision_conflict';
  err.expected_settings_revision = String(expected || '').trim();
  err.current_settings_revision = String(actual || '').trim();
  err.scheduler_no_retry = true;
  return err;
}

function assertSchedulerExpectedSettingsRevision(settings = {}, expected = '') {
  const expectedRevision = String(expected || '').trim();
  if (!expectedRevision) return;
  const currentRevision = settingsRevision(settings);
  if (currentRevision && currentRevision !== expectedRevision) {
    throw schedulerSettingsRevisionConflictError(expectedRevision, currentRevision);
  }
}

function schedulerNoRetryError(error, code = '') {
  const err = error instanceof Error ? error : new Error(String(error || '调度检查失败。'));
  if (code && !err.code) err.code = code;
  err.scheduler_no_retry = true;
  return err;
}

async function assertSchedulerServerPngAvailable(signal = null) {
  try {
    await assertServerPngRenderAvailable({ signal });
  } catch (e) {
    if (isSchedulerAbort(e, signal)) throw e;
    throw schedulerNoRetryError(e, 'scheduler_png_render_unavailable');
  }
}

function schedulerFailureDetail(error = {}) {
  const detail = String(error?.detail || '').trim();
  if (detail) return detail;
  const code = String(error?.public_code || error?.code || '').trim();
  if (code === 'wxdb_key_scan_unavailable') return 'wxdb_key_scan_unavailable';
  if (/^server_render_(unsupported|script_missing|process_missing|process_denied|process_failed)$/.test(code)) {
    return 'scheduler_png_render_unavailable';
  }
  return error?.code === 'stale_settings' ? 'stale_settings_before_save' : 'error';
}

function schedulerAccountListUnavailableError(error = null, phase = 'scheduler') {
  const detail = sanitizeText(error?.message || String(error || '')).trim();
  return Object.assign(new Error(detail
    ? `读取微信账号列表失败，后台定时摘要已暂停运行但不会改写定时设置：${detail}`
    : '读取微信账号列表失败，后台定时摘要已暂停运行但不会改写定时设置。'), {
    code: 'scheduler_account_list_unavailable',
    public_code: 'scheduler_account_list_unavailable',
    detail: 'account_list_unavailable',
    scheduler_no_retry: true,
    phase,
    cause: error || undefined,
  });
}

function schedulerSettingsUnavailableError(error = null, phase = 'scheduler') {
  const detail = sanitizeText(error?.message || String(error || '')).trim();
  return Object.assign(new Error(detail
    ? `读取设置失败，后台定时摘要已暂停运行但不会改写定时设置：${detail}`
    : '读取设置失败，后台定时摘要已暂停运行但不会改写定时设置。'), {
    code: 'scheduler_settings_unavailable',
    public_code: 'scheduler_settings_unavailable',
    detail: 'settings_unavailable',
    scheduler_no_retry: true,
    phase,
    cause: error || undefined,
  });
}

async function schedulerAccountsForSetup(settings = {}, { signal = null, phase = 'scheduler' } = {}) {
  if (!schedulerTargetRefs(settings).length) return [];
  try {
    return await listAccounts({ signal });
  } catch (e) {
    if (isSchedulerAbort(e, signal)) throw e;
    throw schedulerAccountListUnavailableError(e, phase);
  }
}

function markSchedulerRuntimeBlocked(error = null, { reason = 'scheduler', retry = false, generation = schedulerGeneration } = {}) {
  if (!schedulerGenerationCanPublish(generation)) return getSchedulerStatus();
  const message = sanitizeText(error?.message || String(error || '后台定时摘要已暂停运行')).trim();
  const detail = schedulerFailureDetail(error);
  const runActive = schedulerActivityActive();
  state.enabled = false;
  state.running = runActive;
  state.timer_active = false;
  state.runtime_state_degraded = false;
  state.next_run_at = '';
  state.runtime_stopped_reason = detail || reason;
  state.last_error = message;
  const blockedResult = {
    ok: false,
    reason,
    detail,
    error: message,
    at: new Date().toISOString(),
  };
  if (runActive) state.last_request_result = blockedResult;
  else setSchedulerLastResult(blockedResult);
  logWarn('scheduler_runtime_blocked', { reason, detail, error: message });
  if (retry) return scheduleSchedulerRecoveryRetry(error, { reason, generation });
  return getSchedulerStatus();
}

function scheduleSchedulerRecoveryRetry(error = null, { reason = 'runtime_recovery', generation = schedulerGeneration, delay_ms = SCHEDULER_RECOVERY_RETRY_MS } = {}) {
  if (schedulerTerminalShutdown || generation !== schedulerGeneration) return getSchedulerStatus();
  const delay = Math.max(1000, Math.min(SCHEDULER_RECOVERY_RETRY_MS, Number(delay_ms || SCHEDULER_RECOVERY_RETRY_MS)));
  const message = sanitizeText(error?.message || String(error || '后台定时摘要暂时不可用')).trim();
  const detail = schedulerFailureDetail(error) || reason;
  if (timer) clearTimeout(timer);
  state.enabled = true;
  state.running = schedulerActivityActive();
  state.timer_active = true;
  state.runtime_state_degraded = false;
  state.next_run_at = new Date(Date.now() + delay).toISOString();
  state.runtime_stopped_reason = detail;
  state.last_error = message;
  timer = setTimeout(() => {
    if (schedulerTerminalShutdown || generation !== schedulerGeneration) return;
    timer = null;
    state.timer_active = false;
    state.runtime_state_degraded = false;
    state.next_run_at = '';
    void startScheduler().catch(retryError => {
      if (isSchedulerAbort(retryError)) return;
      markSchedulerRuntimeBlocked(retryError, {
        reason: 'runtime_recovery_retry',
        retry: true,
        generation: schedulerGeneration,
      });
    });
  }, delay);
  logWarn('scheduler_runtime_recovery_scheduled', {
    reason,
    detail,
    retry_in_ms: delay,
    next_run_at: state.next_run_at,
    error: message,
  });
  return getSchedulerStatus();
}

function stopSchedulerRuntimeAfterPersistedDisable(settings = {}, reason = 'scheduler_auto_disabled', generation = schedulerGeneration) {
  if (!schedulerGenerationCanPublish(generation) || settings?.scheduler?.enabled !== false) return false;
  if (timer) clearTimeout(timer);
  timer = null;
  state.enabled = false;
  state.timer_active = false;
  state.runtime_state_degraded = false;
  state.next_run_at = '';
  state.runtime_stopped_reason = String(settings.scheduler?.disabled_reason || reason || '').trim();
  return true;
}

async function schedulerSettingsChangedSince(settings = {}, signal = null) {
  throwIfSchedulerAborted(signal);
  const latest = await loadSettings({ includeSecrets: true });
  throwIfSchedulerAborted(signal);
  const before = schedulerRuntimeRevision(settings);
  const after = schedulerRuntimeRevision(latest);
  return !!before && !!after && before !== after;
}

async function assertSchedulerSettingsFreshBeforeExternalSideEffect(settings = {}, signal = null) {
  if (!await schedulerSettingsChangedSince(settings, signal)) return;
  throw schedulerStaleSettingsError('设置已变化，已停止按旧设置请求 AI；下次会按新设置重试。', 'stale_settings_before_ai');
}

function queueSchedulerLifecycle(action) {
  const run = schedulerLifecycleQueue.then(action, action);
  schedulerLifecycleQueue = run.catch(() => {});
  return run;
}

function schedulerRunActive() {
  return activeRunLease !== null;
}

function schedulerTimerCycleActive() {
  return activeTimerCyclePromise !== null;
}

function schedulerActivityActive() {
  return schedulerRunActive() || schedulerTimerCycleActive();
}

function schedulerTimerCycleOwnsRun(signal = null) {
  return schedulerTimerCycleActive()
    && !!signal
    && activeTimerCycleController?.signal === signal;
}

function schedulerGenerationCanPublish(generation = schedulerGeneration) {
  return !schedulerTerminalShutdown && generation === schedulerGeneration;
}

function runSchedulerTimerCycle(controller, action) {
  if (!controller?.signal || typeof action !== 'function') {
    throw new TypeError('scheduler timer cycle requires an AbortController and action');
  }
  if (activeTimerCyclePromise) {
    throw Object.assign(new Error('scheduler timer cycle overlap'), {
      code: 'scheduler_timer_cycle_overlap',
    });
  }
  activeTimerCycleController = controller;
  let trackedPromise = null;
  trackedPromise = Promise.resolve()
    .then(() => action(controller.signal))
    .finally(() => {
      if (activeTimerCyclePromise === trackedPromise) activeTimerCyclePromise = null;
      if (activeTimerCycleController === controller) activeTimerCycleController = null;
      state.running = schedulerActivityActive();
    });
  activeTimerCyclePromise = trackedPromise;
  state.running = true;
  return trackedPromise;
}

function tryAcquireSchedulerRunLease(reason = 'scheduler', { timer_cycle_signal = null } = {}) {
  if (
    activeRunLease
    || activeRunPromise
    || (schedulerTimerCycleActive() && !schedulerTimerCycleOwnsRun(timer_cycle_signal))
  ) return null;
  const lease = {
    reason: String(reason || 'scheduler').trim(),
    acquired_at: new Date().toISOString(),
  };
  activeRunLease = lease;
  state.running = true;
  return lease;
}

function releaseSchedulerRunLease(lease) {
  if (!lease || activeRunLease !== lease) return false;
  activeRunLease = null;
  state.running = schedulerActivityActive();
  return true;
}

async function withSchedulerLifecycleTransition(kind = 'lifecycle', action) {
  if (typeof action !== 'function') throw new TypeError('scheduler lifecycle transition action is required');
  if (schedulerLifecycleTransition) {
    throw Object.assign(new Error('scheduler lifecycle transition overlap'), {
      code: 'scheduler_lifecycle_overlap',
    });
  }
  const transition = {
    kind: String(kind || 'lifecycle').trim() || 'lifecycle',
    started_at: new Date().toISOString(),
  };
  schedulerLifecycleTransition = transition;
  state.lifecycle_transition = transition.kind;
  try {
    return await action();
  } finally {
    if (schedulerLifecycleTransition === transition) {
      schedulerLifecycleTransition = null;
      state.lifecycle_transition = '';
    }
  }
}

function throwIfSchedulerStartBlocked(signal = null) {
  throwIfSchedulerAborted(signal);
  if (schedulerTerminalShutdown) throw schedulerAbortError('scheduler_terminal_shutdown');
}

export function startScheduler(options = {}) {
  return queueSchedulerLifecycle(() => withSchedulerLifecycleTransition('start', () => {
    throwIfSchedulerStartBlocked(options?.signal || null);
    return startSchedulerSerialized(options);
  }));
}

async function startSchedulerSerialized({ immediate = false, signal = null } = {}) {
  throwIfSchedulerStartBlocked(signal);
  const stopResult = await stopSchedulerSerialized({ wait: true, timeout_ms: 5000, reason: 'scheduler_restarted' });
  throwIfSchedulerStartBlocked(signal);
  if (stopResult?.timed_out || stopResult?.running) {
    state.enabled = false;
    state.timer_active = false;
    state.runtime_state_degraded = false;
    state.next_run_at = '';
    state.last_error = '旧后台检查仍在退出中，已拒绝启动新的定时器。';
    logWarn('scheduler_start_skipped_previous_run_still_running');
    return getSchedulerStatus();
  }
  const generation = schedulerGeneration;
  let settings;
  try {
    settings = await loadSettings({ includeSecrets: true });
  } catch (e) {
    if (isSchedulerAbort(e, signal)) throw e;
    return markSchedulerRuntimeBlocked(schedulerSettingsUnavailableError(e, 'start'), { reason: 'start', retry: true, generation });
  }
  throwIfSchedulerStartBlocked(signal);
  if (generation !== schedulerGeneration) return getSchedulerStatus();
  rememberSchedulerSettingsRevision(settings);
  state.enabled = !!settings.scheduler.enabled;
  state.interval_ms = durationToMs(settings.scheduler.default_interval);
  state.timer_active = false;
  state.runtime_state_degraded = false;
  state.next_run_at = '';
  state.runtime_stopped_reason = '';
  state.last_error = '';
  if (!state.enabled) {
    logInfo('scheduler_disabled');
    return getSchedulerStatus();
  }
  let accounts;
  try {
    accounts = await schedulerAccountsForSetup(settings, { signal, phase: 'start' });
  } catch (e) {
    if (isSchedulerAbort(e, signal)) throw e;
    return markSchedulerRuntimeBlocked(e, { reason: 'start', retry: true, generation });
  }
  throwIfSchedulerStartBlocked(signal);
  const setupRequired = await schedulerSettingsNeedSetupWithRuntime(settings, accounts, { signal });
  throwIfSchedulerStartBlocked(signal);
  if (setupRequired) {
    try {
      settings = await disablePersistedSchedulerForSetup(settings, { reason: 'start', signal });
    } catch (e) {
      if (isSchedulerAbort(e, signal)) throw e;
      if (generation !== schedulerGeneration) return getSchedulerStatus();
      if (e?.code === 'scheduler_account_list_unavailable') return markSchedulerRuntimeBlocked(e, { reason: 'start', retry: true, generation });
      markSchedulerPersistentDisableFailed(e, { reason: 'start', generation });
      return getSchedulerStatus();
    }
    throwIfSchedulerStartBlocked(signal);
    if (generation !== schedulerGeneration) return getSchedulerStatus();
    rememberSchedulerSettingsRevision(settings);
    state.enabled = !!settings.scheduler?.enabled;
    state.interval_ms = durationToMs(settings.scheduler?.default_interval);
    let latestAccounts = [];
    if (state.enabled) {
      try {
        latestAccounts = await schedulerAccountsForSetup(settings, { signal, phase: 'start_after_disable_check' });
      } catch (e) {
        if (isSchedulerAbort(e, signal)) throw e;
        return markSchedulerRuntimeBlocked(e, { reason: 'start', retry: true, generation });
      }
      throwIfSchedulerStartBlocked(signal);
    }
    const setupStillRequired = state.enabled
      ? await schedulerSettingsNeedSetupWithRuntime(settings, latestAccounts, { signal })
      : false;
    throwIfSchedulerStartBlocked(signal);
    if (!state.enabled || setupStillRequired) {
      state.enabled = false;
      logWarn('scheduler_start_skipped_setup_required', { scheduler_enabled: !!settings.scheduler?.enabled });
      return getSchedulerStatus();
    }
  }
  let initialDelay = immediate ? { delay_ms: 0, restored: false, reason: 'immediate' } : null;
  if (!initialDelay) {
    const savedRuntime = await loadSchedulerRuntimeState();
    throwIfSchedulerStartBlocked(signal);
    if (generation !== schedulerGeneration) return getSchedulerStatus();
    initialDelay = schedulerPersistedNextDelay(savedRuntime, settings, state.interval_ms);
  }
  throwIfSchedulerStartBlocked(signal);
  await scheduleNext(settings, initialDelay.delay_ms, generation);
  throwIfSchedulerStartBlocked(signal);
  logInfo('scheduler_started', {
    interval_ms: state.interval_ms,
    next_run_at: state.next_run_at,
    restored_next_run_at: initialDelay.restored === true,
    restore_reason: initialDelay.reason,
  });
  return getSchedulerStatus();
}

export async function restartScheduler(options = {}) {
  return startScheduler(options);
}

export function scheduleSchedulerRestartWhenIdle({ reason = 'scheduler_idle_restart' } = {}) {
  if (schedulerTerminalShutdown) return false;
  const generation = schedulerGeneration;
  const pendingRun = activeRunPromise;
  if (schedulerIdleRestart?.generation === generation) return true;
  const record = { generation, promise: null };
  record.promise = Promise.resolve(pendingRun).catch(() => null).then(async () => {
    if (schedulerTerminalShutdown) return getSchedulerStatus();
    if (generation !== schedulerGeneration) return getSchedulerStatus();
    logInfo('scheduler_idle_restart_started', { reason });
    return startScheduler();
  }).catch(error => {
    if (isSchedulerAbort(error)) return getSchedulerStatus();
    return markSchedulerRuntimeBlocked(error, {
      reason: 'scheduler_idle_restart_failed',
      retry: true,
      generation: schedulerGeneration,
    });
  }).finally(() => {
    if (schedulerIdleRestart === record) schedulerIdleRestart = null;
  });
  schedulerIdleRestart = record;
  logInfo('scheduler_idle_restart_queued', { reason, waiting_for_active_run: !!pendingRun });
  return true;
}

export function stopScheduler(options = {}) {
  if (options?.terminal === true) schedulerTerminalShutdown = true;
  return queueSchedulerLifecycle(() => withSchedulerLifecycleTransition('stop', () => stopSchedulerSerialized(options)));
}

async function stopSchedulerSerialized({ wait = false, timeout_ms = 30000, reason = 'scheduler_stopped', terminal = false } = {}) {
  schedulerGeneration++;
  const result = { stopped: true, running: false, timed_out: false, reason };
  const hadActiveRuntime = Boolean(
    timer
    || activeRunPromise
    || activeTimerCyclePromise
    || state.enabled
    || state.timer_active
    || state.running
    || state.next_run_at
    || (activeRunController && !activeRunController.signal.aborted)
    || (activeTimerCycleController && !activeTimerCycleController.signal.aborted)
  );
  const controller = activeRunController;
  if (controller && !controller.signal.aborted) {
    controller.abort(schedulerAbortError(reason));
  }
  const timerCycleController = activeTimerCycleController;
  if (timerCycleController && !timerCycleController.signal.aborted) {
    timerCycleController.abort(schedulerAbortError(reason));
  }
  if (timer) clearTimeout(timer);
  timer = null;
  state.enabled = false;
  state.timer_active = false;
  state.runtime_state_degraded = false;
  state.next_run_at = '';
  if (hadActiveRuntime) {
    state.runtime_stopped_reason = reason;
    logInfo('scheduler_stopped', { reason });
  }
  const drainPromises = [...new Set([
    activeRunPromise,
    activeTimerCyclePromise,
    ...(terminal ? [SCHEDULER_RUNTIME_STATE_QUEUE] : []),
  ].filter(Boolean))];
  if (wait && drainPromises.length) {
    await waitForSchedulerRun(Promise.allSettled(drainPromises), timeout_ms).catch(e => {
      result.stopped = false;
      result.running = true;
      result.timed_out = true;
      logWarn('scheduler_stop_wait_failed', { error: sanitizeText(e?.message || String(e)) });
    });
  }
  if (state.running || activeTimerCyclePromise || (!wait && activeRunPromise)) {
    result.running = true;
    result.stopped = false;
  }
  return result;
}

export function getSchedulerStatus() {
  return {
    ...state,
    active_progress: state.active_progress ? { ...state.active_progress } : null,
    last_result: state.last_result ? { ...state.last_result } : null,
    last_request_result: schedulerRecentRequestResult(),
    pending_cursor_store_invalid_info: SCHEDULER_PENDING_CURSOR_STORE_INVALID_INFO,
    auto_key_failures_invalid_info: SCHEDULER_AUTO_KEY_FAILURE_STORE_INVALID_INFO,
    runtime_state_invalid_info: SCHEDULER_RUNTIME_STATE_INVALID_INFO,
  };
}

function schedulerRecentRequestResult(now = Date.now()) {
  if (!state.last_request_result || typeof state.last_request_result !== 'object' || Array.isArray(state.last_request_result)) return null;
  const atMs = Date.parse(String(state.last_request_result.at || ''));
  if (!Number.isFinite(atMs) || now - atMs > SCHEDULER_LAST_REQUEST_RESULT_TTL_MS) return null;
  return { ...state.last_request_result };
}

export function markSchedulerLegacyCursorsCleared(cursorKeys = []) {
  const keys = new Set((Array.isArray(cursorKeys) ? cursorKeys : [])
    .map(key => String(key || '').trim())
    .filter(Boolean));
  if (!keys.size || !state.last_result || !Array.isArray(state.last_result.items)) return 0;
  let cleared = 0;
  for (const item of state.last_result.items) {
    const key = String(item?.legacy_cursor_key || '').trim();
    if (!key || !keys.has(key) || item?.legacy_cursor_unverified !== true) continue;
    item.legacy_cursor_unverified = false;
    item.legacy_cursor_cleared = true;
    if (item.detail === 'cursor_legacy_unverified') item.detail = 'legacy_cursor_cleared';
    cleared++;
  }
  if (cleared > 0) {
    const stillUnverified = state.last_result.items.some(item => item?.legacy_cursor_unverified === true);
    if (!stillUnverified && state.last_result.detail === 'cursor_legacy_unverified') {
      state.last_result.detail = 'legacy_cursor_cleared';
    }
  }
  return cleared;
}

export function recordSchedulerStartFailure(error, { reason = 'startup' } = {}) {
  const message = sanitizeText(error?.message || String(error || 'scheduler start failed'));
  const runActive = schedulerActivityActive();
  state.enabled = false;
  state.running = runActive;
  state.timer_active = false;
  state.runtime_state_degraded = false;
  state.next_run_at = '';
  state.last_error = message;
  const failureResult = {
    ok: false,
    reason,
    detail: 'scheduler_start_failed',
    error: message,
    at: new Date().toISOString(),
  };
  if (runActive) state.last_request_result = failureResult;
  else setSchedulerLastResult(failureResult);
  logError('scheduler_start_failed', { reason, error: message });
  return getSchedulerStatus();
}

export async function runSchedulerOnce({ reason = 'manual', force = false, signal = null, expected_settings_revision = '' } = {}) {
  throwIfSchedulerStartBlocked(signal);
  if (schedulerRunActive() || activeRunPromise || (schedulerTimerCycleActive() && !schedulerTimerCycleOwnsRun(signal))) {
    logWarn('scheduler_skipped', { reason, detail: 'already_running' });
    const result = { ok: false, skipped: 1, reason, detail: 'already_running', at: new Date().toISOString() };
    state.last_request_result = result;
    return result;
  }
  if (schedulerLifecycleTransition) {
    const lifecycleTransition = schedulerLifecycleTransition.kind;
    logInfo('scheduler_skipped', { reason, detail: 'scheduler_lifecycle_active', lifecycle_transition: lifecycleTransition });
    const result = {
      ok: false,
      skipped: 1,
      reason,
      detail: 'scheduler_lifecycle_active',
      lifecycle_transition: lifecycleTransition,
      retry_after_ms: 1000,
      at: new Date().toISOString(),
    };
    state.last_request_result = result;
    return result;
  }
  if (schedulerManualDigestActivityActive()) {
    logInfo('scheduler_skipped', { reason, detail: 'manual_digest_active' });
    const result = {
      ok: false,
      skipped: 1,
      reason,
      detail: 'manual_digest_active',
      retry_after_ms: SCHEDULER_MANUAL_DIGEST_BUSY_RETRY_MS,
      at: new Date().toISOString(),
    };
    state.last_request_result = result;
    return result;
  }
  const runLease = tryAcquireSchedulerRunLease(reason, { timer_cycle_signal: signal });
  if (!runLease) {
    const result = { ok: false, skipped: 1, reason, detail: 'already_running', at: new Date().toISOString() };
    state.last_request_result = result;
    return result;
  }
  let controller = null;
  let abortFromSignal = null;
  let runPromise = null;
  const runGeneration = schedulerGeneration;
  try {
    activeRunPartialResult = null;
    state.active_progress = null;
    updateActiveSchedulerProgress({
      phase: 'starting',
      label: '准备后台检查',
      detail: '正在读取已保存的调度设置',
    });
    controller = new AbortController();
    abortFromSignal = () => {
      if (!controller.signal.aborted) {
        controller.abort(signal?.reason instanceof Error ? signal.reason : schedulerAbortError('scheduler_cancelled'));
      }
    };
    if (signal?.aborted) abortFromSignal();
    else signal?.addEventListener?.('abort', abortFromSignal, { once: true });
    activeRunController = controller;
    runPromise = (async () => {
      state.last_started_at = new Date().toISOString();
      state.last_error = '';
      logInfo('scheduler_run_started', { reason, expected_settings_revision: String(expected_settings_revision || '').slice(0, 32) });
      try {
        const result = await executeSchedulerTick({
          reason,
          force,
          signal: controller.signal,
          expected_settings_revision,
          generation: runGeneration,
        });
        if (schedulerGenerationCanPublish(runGeneration)) setSchedulerLastResult(result);
        logInfo('scheduler_run_finished', {
          reason,
          ok: result.ok,
          accounts: result.accounts || 0,
          checked: result.checked || 0,
          generated: result.generated || 0,
          skipped: result.skipped || 0,
          failed: result.failed || 0,
          detail: result.detail || '',
        });
        return result;
      } catch (e) {
        if (isSchedulerAbort(e, controller.signal)) {
          const result = schedulerCancelledRunResult(activeRunPartialResult, { reason });
          if (schedulerGenerationCanPublish(runGeneration)) {
            state.last_error = '';
            setSchedulerLastResult(result);
          }
          logWarn('scheduler_run_cancelled', {
            reason,
            detail: result.detail,
            checked: result.checked || 0,
            generated: result.generated || 0,
            recovered: result.recovered || 0,
            skipped: result.skipped || 0,
            failed: result.failed || 0,
          });
          return result;
        }
        const message = sanitizeText(e?.message || String(e));
        if (schedulerGenerationCanPublish(runGeneration)) {
          state.last_error = message;
          setSchedulerLastResult({ ok: false, reason, error: message, at: new Date().toISOString() });
        }
        logError('scheduler_run_failed', { reason, error: message });
        throw e;
      }
    })();
    activeRunPromise = runPromise;
    return await runPromise;
  } finally {
    if (abortFromSignal) signal?.removeEventListener?.('abort', abortFromSignal);
    if (runPromise && activeRunPromise === runPromise) activeRunPromise = null;
    if (controller && activeRunController === controller) activeRunController = null;
    if (activeRunLease === runLease) {
      activeRunPartialResult = null;
      state.active_progress = null;
      if (schedulerGenerationCanPublish(runGeneration)) {
        state.last_finished_at = new Date().toISOString();
        if (state.last_request_result?.detail === 'already_running') state.last_request_result = null;
      }
      releaseSchedulerRunLease(runLease);
    }
  }
}

export async function previewScheduledTargets(settings = null, { signal = null, accounts = null } = {}) {
  throwIfSchedulerAborted(signal);
  const saved = settings || await loadSettings({ includeSecrets: true });
  const previewRevision = settingsRevision(saved);
  const withRevision = preview => ({
    ...(preview || {}),
    settings_revision: previewRevision,
  });
  throwIfSchedulerAborted(signal);
  const accountSnapshot = Array.isArray(accounts) ? accounts : await listAccounts({ signal });
  throwIfSchedulerAborted(signal);
  if (!accountSnapshot.length) {
    return withRevision(schedulerTargetPreviewFromEntries(saved, [], { accounts: accountSnapshot, groupLookupComplete: true, failed: 0 }));
  }
  const trustedTargets = schedulerTrustedTargetSettings(saved, accountSnapshot);
  const targetAccounts = schedulerAccountsForTargetRefs(accountSnapshot, trustedTargets.refs);
  const missingManualKeyAccounts = await schedulerMissingManualKeyAccountsWithRuntime(saved, targetAccounts, { signal });
  const missingManualKeyAccountIds = new Set(missingManualKeyAccounts.map(item => item.account_id).filter(Boolean));
  const runnableTargetAccounts = missingManualKeyAccountIds.size
    ? targetAccounts.filter(account => !missingManualKeyAccountIds.has(accountIdentity(account)))
    : targetAccounts;
  const accountEntries = [];
  let groupLookupComplete = true;
  let failed = 0;
  for (const account of runnableTargetAccounts) {
    throwIfSchedulerAborted(signal);
    const accountId = accountIdentity(account);
    try {
      const groups = await listGroups({
        account_id: accountId,
        signal,
        legacy_manual_key_policy: LEGACY_MANUAL_KEY_POLICY.DENY,
      });
      throwIfSchedulerAborted(signal);
      accountEntries.push({ account, groups });
    } catch (e) {
      if (isSchedulerAbort(e, signal)) throw e;
      groupLookupComplete = false;
      failed++;
    }
  }
  return withRevision(schedulerTargetPreviewFromEntries(trustedTargets.settings, accountEntries, {
    accounts: accountSnapshot,
    groupLookupComplete,
    failed,
    missingManualKeyAccounts,
    identityScopeIssues: trustedTargets.issues,
    runnableAccountCount: runnableTargetAccounts.length,
  }));
}

function waitForSchedulerRun(runPromise, timeoutMs) {
  const timeout = Math.max(1000, Number(timeoutMs || 30000));
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };
    timer = setTimeout(
      () => finish(reject, new Error(`scheduler run did not finish within ${timeout}ms`)),
      timeout,
    );
    Promise.resolve(runPromise)
      .catch(() => undefined)
      .then(value => finish(resolve, value));
  });
}

function schedulerAbortError(reason = 'scheduler_cancelled') {
  const message = reason === 'scheduler_restarted' ? '调度已重启，本轮检查已取消。'
    : reason === 'scheduler_stopped' ? '调度已关闭，本轮检查已取消。'
      : reason === 'scheduler_terminal_shutdown' ? '本地服务正在关闭，已拒绝启动后台调度。'
      : '调度检查已取消。';
  return Object.assign(new Error(message), {
    name: 'AbortError',
    status: 499,
    code: reason === 'scheduler_terminal_shutdown' ? 'scheduler_terminal_shutdown' : 'scheduler_cancelled',
    scheduler_cancelled: true,
    reason,
  });
}

function throwIfSchedulerAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw schedulerAbortError(typeof reason === 'string' ? reason : 'scheduler_cancelled');
}

function isSchedulerAbort(error, signal = null) {
  return !!(signal?.aborted || error?.scheduler_cancelled || error?.name === 'AbortError' || error?.status === 499);
}

function schedulerCancelledRunResult(partialResult = null, { reason = 'manual', at = new Date().toISOString() } = {}) {
  const partial = partialResult && typeof partialResult === 'object' && !Array.isArray(partialResult)
    ? partialResult
    : null;
  const items = Array.isArray(partial?.items) ? [...partial.items] : [];
  return {
    ...(partial || {}),
    ok: false,
    reason,
    cancelled: true,
    detail: items.length ? 'cancelled_partial' : 'cancelled',
    at,
    ...(partial ? { items } : {}),
  };
}

function schedulerSaveFailureMayHaveCommittedOutput(error = null) {
  const code = String(error?.public_code || error?.code || '').trim();
  return code === 'output_save_cleanup_failed' || code === 'history_index_rollback_failed';
}

function savedSchedulerOutputHistoryUnbound(saved = {}) {
  const reason = String(saved?.local_action_after_commit_reason || '').trim();
  return saved?.history_commit_failed === true
    || saved?.history_current === false
    || (!!reason && reason !== 'cancelled_after_commit');
}

function savedSchedulerOutputHistoryUnboundMessage(saved = {}) {
  const reason = sanitizeText(saved?.local_action_after_commit_error || '');
  return reason || '摘要文件已写入，但历史索引未绑定；本次不会推进调度游标，已记录待恢复游标，下次会先核对该文件并补提交，避免重复生成。';
}

function schedulerSavedArtifactMeta(saved = {}, digest = {}) {
  return {
    digest_id: String(saved?.digest_id || digest?.digest_id || '').trim(),
    history_item_key: String(saved?.history_item_key || '').trim(),
    relative_path: String(saved?.relative_path || '').trim(),
    output_dir_identity: String(saved?.output_dir_identity || '').trim(),
    file_version: String(saved?.file_version || saved?.saved_file_version || '').trim(),
    digest_file_version: String(saved?.digest_file_version || saved?.saved_digest_file_version || '').trim(),
    history_current: saved?.history_current !== false,
    history_commit_failed: saved?.history_commit_failed === true,
    local_action_after_commit_reason: String(saved?.local_action_after_commit_reason || '').trim(),
    local_action_after_commit_error: sanitizeText(saved?.local_action_after_commit_error || ''),
  };
}

function schedulerPendingHistoryItem(saved = {}, digest = {}) {
  return {
    ...saved,
    digest_id: String(saved?.digest_id || digest?.digest_id || '').trim(),
    file_path: String(saved?.file_path || '').trim(),
    relative_path: String(saved?.relative_path || '').trim(),
    output_dir_identity: String(saved?.output_dir_identity || '').trim(),
    digest_path: String(saved?.digest_path || '').trim(),
    digest_relative_path: String(saved?.digest_relative_path || '').trim(),
    saved_file_version: String(saved?.saved_file_version || saved?.file_version || '').trim(),
    saved_digest_file_version: String(saved?.saved_digest_file_version || saved?.digest_file_version || '').trim(),
  };
}

function schedulerPendingHistoryItemFromEntry(entry = {}) {
  const item = entry?.history_item && typeof entry.history_item === 'object' && !Array.isArray(entry.history_item)
    ? entry.history_item
    : entry;
  return schedulerPendingHistoryItem(item, { digest_id: entry?.digest_id || '' });
}

function schedulerPendingCursorStoreKey(cursorKey = '') {
  const clean = String(cursorKey || '').trim();
  return clean ? crypto.createHash('sha256').update(clean).digest('hex') : '';
}

async function backupInvalidSchedulerPendingCursorFile(file = SCHEDULER_PENDING_CURSOR_FILE) {
  const preserved = await preserveInvalidFileBackup(file, { maxBytes: SCHEDULER_PENDING_CURSOR_MAX_BYTES });
  return preserved.backup_path || preserved.original_path || '';
}

function schedulerPendingCursorStoreInvalidError(error = null, evidence = {}) {
  const evidencePath = evidence?.backup_path || evidence?.original_path || '';
  const evidenceRelative = evidencePath ? schedulerProjectRelative(evidencePath) : '';
  const evidenceText = evidenceRelative
    ? (evidence?.backup_available === true
      ? `原文件已保留，并按内容备份为 ${evidenceRelative}`
      : `原文件已保留在 ${evidenceRelative}`)
    : '';
  const message = evidenceText
    ? `调度待恢复游标文件损坏，${evidenceText}；本次自动检查已停止，避免重复生成上次已保存但未提交游标的摘要。`
    : '调度待恢复游标文件损坏；本次自动检查已停止，避免重复生成上次已保存但未提交游标的摘要。';
  return Object.assign(new Error(message), {
    code: 'scheduler_pending_cursor_store_invalid',
    public_code: 'scheduler_pending_cursor_store_invalid',
    detail: 'pending_cursor_store_invalid',
    scheduler_no_retry: true,
    backup_path: evidencePath,
    backup_relative_path: evidenceRelative,
    backup_available: evidence?.backup_available === true,
    original_preserved: evidence?.original_preserved === true,
    cause: error || undefined,
  });
}

function schedulerPendingCursorStoreFullError(entryCount = 0) {
  return Object.assign(new Error(`调度待恢复记录已有 ${entryCount} 条，达到 ${MAX_SCHEDULER_PENDING_CURSORS} 条安全上限。已拒绝保存新的后台长图，且不会删除任何尚未补提交的旧记录；请先再次运行自动检查，让现有记录完成补提交。`), {
    status: 507,
    code: 'scheduler_pending_cursor_store_full',
    public_code: 'scheduler_pending_cursor_store_full',
    detail: 'pending_cursor_store_full',
    scheduler_no_retry: true,
    pending_cursor_count: entryCount,
    pending_cursor_limit: MAX_SCHEDULER_PENDING_CURSORS,
  });
}

function schedulerPendingCursorStoreTooLargeError(bytes = 0) {
  return Object.assign(new Error(`调度待恢复记录文件将达到 ${Math.ceil(bytes / 1024 / 1024)}MB，超过 16MB 安全上限。已拒绝保存新的后台长图，且不会截断任何旧恢复记录；请先再次运行自动检查，让现有记录完成补提交。`), {
    status: 413,
    code: 'scheduler_pending_cursor_store_too_large',
    public_code: 'scheduler_pending_cursor_store_too_large',
    detail: 'pending_cursor_store_too_large',
    scheduler_no_retry: true,
    pending_cursor_bytes: bytes,
    pending_cursor_limit_bytes: SCHEDULER_PENDING_CURSOR_MAX_BYTES,
  });
}

function schedulerPendingCursorStorePayload(store = {}) {
  if (!store || typeof store !== 'object' || Array.isArray(store)) {
    throw Object.assign(new Error('调度待恢复游标文件格式不是对象。'), { code: 'scheduler_pending_cursor_store_invalid_shape' });
  }
  const entries = Object.entries(store);
  if (entries.length > MAX_SCHEDULER_PENDING_CURSORS) throw schedulerPendingCursorStoreFullError(entries.length);
  for (const [key, item] of entries) {
    if (!String(key || '').trim() || !item || typeof item !== 'object' || Array.isArray(item)) {
      throw Object.assign(new Error('调度待恢复游标文件包含无效记录。'), { code: 'scheduler_pending_cursor_store_invalid_entry' });
    }
  }
  const payload = Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
  const bytes = Buffer.byteLength(JSON.stringify(payload, null, 2), 'utf-8');
  if (bytes > SCHEDULER_PENDING_CURSOR_MAX_BYTES) throw schedulerPendingCursorStoreTooLargeError(bytes);
  return payload;
}

async function loadSchedulerPendingCursors() {
  if (SCHEDULER_PENDING_CURSOR_STORE_INVALID_INFO) {
    throw schedulerPendingCursorStoreInvalidError(
      new Error(SCHEDULER_PENDING_CURSOR_STORE_INVALID_INFO.error || 'pending cursor store invalid'),
      SCHEDULER_PENDING_CURSOR_STORE_INVALID_INFO,
    );
  }
  try {
    const raw = await readJson(SCHEDULER_PENDING_CURSOR_FILE, {}, {
      strict: true,
      maxBytes: SCHEDULER_PENDING_CURSOR_MAX_BYTES,
    });
    return schedulerPendingCursorStorePayload(raw);
  } catch (e) {
    const preserved = await preserveInvalidFileBackup(SCHEDULER_PENDING_CURSOR_FILE, {
      maxBytes: SCHEDULER_PENDING_CURSOR_MAX_BYTES,
    }).catch(backupError => {
      logWarn('scheduler_pending_cursor_invalid_backup_failed', { error: sanitizeText(backupError?.message || String(backupError)) });
      return {
        original_path: SCHEDULER_PENDING_CURSOR_FILE,
        backup_path: '',
        backup_available: false,
        original_preserved: true,
      };
    });
    const evidencePath = preserved.backup_path || preserved.original_path || '';
    SCHEDULER_PENDING_CURSOR_STORE_INVALID_INFO = {
      status: 'invalid_blocked',
      backup_path: evidencePath,
      backup_relative_path: evidencePath ? schedulerProjectRelative(evidencePath) : '',
      backup_available: preserved.backup_available === true,
      original_preserved: preserved.original_preserved === true,
      error: sanitizeText(e?.message || String(e || '')).slice(0, 240),
    };
    const err = schedulerPendingCursorStoreInvalidError(e, SCHEDULER_PENDING_CURSOR_STORE_INVALID_INFO);
    logWarn('scheduler_pending_cursor_store_invalid', {
      backup: err.backup_relative_path || '',
      error: sanitizeText(e?.message || String(e)),
    });
    throw err;
  }
}

export async function revalidateSchedulerPendingCursorStore() {
  if (!SCHEDULER_PENDING_CURSOR_STORE_INVALID_INFO) return { revalidated: false, status: 'already_valid' };
  const previousInvalidInfo = SCHEDULER_PENDING_CURSOR_STORE_INVALID_INFO;
  let stat = null;
  try {
    stat = await fsp.lstat(SCHEDULER_PENDING_CURSOR_FILE);
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw Object.assign(new Error('data/scheduler-pending-cursors.json 尚未恢复为普通文件；为避免丢失已保存但未提交的游标，自动检查仍保持停止。'), {
      status: 409,
      code: 'scheduler_pending_cursor_revalidation_file_missing',
      public_code: 'scheduler_pending_cursor_revalidation_file_missing',
    });
  }
  SCHEDULER_PENDING_CURSOR_STORE_INVALID_INFO = null;
  try {
    const store = await loadSchedulerPendingCursors();
    const afterStat = await fsp.lstat(SCHEDULER_PENDING_CURSOR_FILE).catch(() => null);
    if (!schedulerStoreFileSnapshotMatches(stat, afterStat)) {
      throw Object.assign(new Error('重新检查期间待恢复记录文件又发生变化；为避免按不一致快照恢复，自动检查仍保持停止。'), {
        status: 409,
        code: 'scheduler_pending_cursor_revalidation_changed',
        public_code: 'scheduler_pending_cursor_revalidation_changed',
      });
    }
    return {
      revalidated: true,
      status: 'valid',
      pending_count: Object.keys(store || {}).length,
    };
  } catch (e) {
    if (!SCHEDULER_PENDING_CURSOR_STORE_INVALID_INFO) {
      SCHEDULER_PENDING_CURSOR_STORE_INVALID_INFO = previousInvalidInfo;
    }
    throw e;
  }
}

function schedulerStoreFileSnapshotMatches(before = null, after = null) {
  if (!before?.isFile?.() || before.isSymbolicLink?.() || !after?.isFile?.() || after.isSymbolicLink?.()) return false;
  return Number(before.dev || 0) === Number(after.dev || 0)
    && Number(before.ino || 0) === Number(after.ino || 0)
    && Number(before.size || 0) === Number(after.size || 0)
    && Number(before.mtimeMs || 0) === Number(after.mtimeMs || 0);
}

async function assertSchedulerPendingCursorStoreReadable() {
  await loadSchedulerPendingCursors();
}

async function writeSchedulerPendingCursors(store = {}) {
  await fsp.mkdir(path.dirname(SCHEDULER_PENDING_CURSOR_FILE), { recursive: true });
  await writeJsonAtomic(SCHEDULER_PENDING_CURSOR_FILE, schedulerPendingCursorStorePayload(store));
}

function schedulerAutoKeyFailureKey(account = {}) {
  const accountId = accountIdentity(account);
  if (!accountId) return '';
  const fingerprint = manualKeyAccountFingerprint(account);
  return crypto.createHash('sha256').update([
    accountId,
    fingerprint || 'fingerprint-missing',
  ].join('\n')).digest('hex');
}

async function loadSchedulerAutoKeyFailures() {
  let raw;
  try {
    raw = await readJson(SCHEDULER_AUTO_KEY_FAILURE_FILE, null, {
      strict: true,
      maxBytes: SCHEDULER_AUTO_KEY_FAILURE_MAX_BYTES,
    });
  } catch (e) {
    return schedulerAutoKeyFailureStoreInvalid(e);
  }
  if (raw === null) return {};
  const rawIsObject = raw && typeof raw === 'object' && !Array.isArray(raw);
  const failures = rawIsObject && Object.hasOwn(raw, 'failures')
    ? raw.failures
    : raw;
  if (failures && typeof failures === 'object' && !Array.isArray(failures)) {
    try {
      const payload = schedulerAutoKeyFailureStorePayload(failures);
      SCHEDULER_AUTO_KEY_FAILURE_STORE_INVALID_INFO = null;
      return payload.failures;
    } catch (e) {
      return schedulerAutoKeyFailureStoreInvalid(e);
    }
  }
  return schedulerAutoKeyFailureStoreInvalid(new Error('调度自动密钥失败记录格式不是对象。'));
}

async function schedulerAutoKeyFailureStoreInvalid(error = null) {
  const backup = await backupInvalidSchedulerAutoKeyFailureFile().catch(backupError => {
    logWarn('scheduler_auto_key_failure_store_invalid_backup_failed', { error: sanitizeText(backupError?.message || String(backupError)) });
    return '';
  });
  SCHEDULER_AUTO_KEY_FAILURE_STORE_INVALID_INFO = {
    status: 'invalid_rebuilding',
    backup_relative_path: backup ? schedulerProjectRelative(backup) : '',
    error: sanitizeText(error?.message || String(error || '')).slice(0, 240),
  };
  logWarn('scheduler_auto_key_failure_store_invalid', {
    backup: SCHEDULER_AUTO_KEY_FAILURE_STORE_INVALID_INFO.backup_relative_path,
    error: SCHEDULER_AUTO_KEY_FAILURE_STORE_INVALID_INFO.error,
  });
  return {};
}

async function backupInvalidSchedulerAutoKeyFailureFile() {
  const base = SCHEDULER_AUTO_KEY_FAILURE_FILE.replace(/\.json$/i, `.invalid.${schedulerStoreBackupTimestamp(new Date())}`);
  for (let i = 1; i <= 20; i++) {
    const backup = i === 1 ? `${base}.json` : `${base}.${i}.json`;
    const exists = await fsp.lstat(backup).then(() => true).catch(e => {
      if (e?.code === 'ENOENT') return false;
      throw e;
    });
    if (exists) continue;
    let renamed = false;
    await fsp.rename(SCHEDULER_AUTO_KEY_FAILURE_FILE, backup).then(() => {
      renamed = true;
    }).catch(e => {
      if (e?.code === 'ENOENT') return;
      throw e;
    });
    return renamed ? backup : '';
  }
  return '';
}

async function writeSchedulerAutoKeyFailures(store = {}) {
  await fsp.mkdir(path.dirname(SCHEDULER_AUTO_KEY_FAILURE_FILE), { recursive: true });
  await writeJsonAtomic(SCHEDULER_AUTO_KEY_FAILURE_FILE, schedulerAutoKeyFailureStorePayload(store));
  SCHEDULER_AUTO_KEY_FAILURE_STORE_INVALID_INFO = null;
}

function schedulerAutoKeyFailureStorePayload(store = {}) {
  if (!store || typeof store !== 'object' || Array.isArray(store)) {
    throw Object.assign(new Error('调度自动密钥失败记录格式不是对象。'), { code: 'scheduler_auto_key_failure_store_invalid_shape' });
  }
  const entries = Object.entries(store).map(([key, item]) => {
    if (!String(key || '').trim() || !item || typeof item !== 'object' || Array.isArray(item)) {
      throw Object.assign(new Error('调度自动密钥失败记录包含无效条目。'), { code: 'scheduler_auto_key_failure_store_invalid_entry' });
    }
    const accountId = String(item.account_id || '').trim().slice(0, 120);
    if (!accountId) {
      throw Object.assign(new Error('调度自动密钥失败记录缺少账号标识。'), { code: 'scheduler_auto_key_failure_store_invalid_entry' });
    }
    return [String(key), {
      account_id: accountId,
      account_fingerprint: String(item.account_fingerprint || '').trim().slice(0, 256),
      platform: String(item.platform || '').trim().slice(0, 32),
      code: String(item.code || '').trim().slice(0, 120),
      message: sanitizeText(item.message || '').slice(0, 240),
      failed_at: String(item.failed_at || '').trim().slice(0, 64),
      db_key_runtime_version: Math.max(0, Math.trunc(Number(item.db_key_runtime_version || 0)) || 0),
      process_generation: String(item.process_generation || '').trim().slice(0, 64),
    }];
  }).sort((a, b) => {
    const byTime = String(a[1].failed_at || '').localeCompare(String(b[1].failed_at || ''));
    return byTime || a[0].localeCompare(b[0]);
  });
  const retained = entries.slice(-MAX_SCHEDULER_AUTO_KEY_FAILURES);
  while (true) {
    const payload = {
      version: 1,
      updated_at: new Date().toISOString(),
      failures: Object.fromEntries([...retained].sort(([a], [b]) => a.localeCompare(b))),
    };
    const bytes = Buffer.byteLength(JSON.stringify(payload, null, 2), 'utf-8');
    if (bytes <= SCHEDULER_AUTO_KEY_FAILURE_MAX_BYTES) return payload;
    if (!retained.length) {
      throw Object.assign(new Error('调度自动密钥失败缓存无法收敛到安全大小。'), {
        code: 'scheduler_auto_key_failure_store_too_large',
        max_bytes: SCHEDULER_AUTO_KEY_FAILURE_MAX_BYTES,
      });
    }
    retained.shift();
  }
}

function schedulerAutoKeyFailureMatchesAccount(item = {}, accountId = '', accountAliases = []) {
  const scopes = new Set([
    accountId,
    ...(Array.isArray(accountAliases) ? accountAliases : []),
  ].map(value => String(value || '').trim()).filter(Boolean));
  if (!scopes.size) return false;
  return scopes.has(String(item?.account_id || '').trim());
}

export async function clearSchedulerAutoKeyFailuresAfterWxDbMirrorRefresh({ account_id = '', account_aliases = [], reason = 'wxdb_mirror_refreshed' } = {}) {
  return withSchedulerAutoKeyFailureLock(async () => {
    const store = await loadSchedulerAutoKeyFailures();
    const accountId = String(account_id || '').trim();
    const aliases = Array.isArray(account_aliases) ? account_aliases : [];
    if (!accountId && !aliases.some(value => String(value || '').trim())) {
      logWarn('scheduler_auto_key_failure_cache_clear_skipped_without_account', {
        reason: String(reason || '').slice(0, 120),
      });
      return { ok: true, cleared: 0, skipped: 'account_missing' };
    }
    const nextStore = {};
    let cleared = 0;
    for (const [key, item] of Object.entries(store)) {
      if (schedulerAutoKeyFailureMatchesAccount(item, accountId, aliases)) cleared += 1;
      else nextStore[key] = item;
    }
    if (!cleared) return { ok: true, cleared: 0 };
    await writeSchedulerAutoKeyFailures(nextStore);
    SCHEDULER_AUTO_KEY_FAILURE_STORE_INVALID_INFO = null;
    logInfo('scheduler_auto_key_failure_cache_cleared_after_wxdb_mirror_refresh', {
      reason: String(reason || '').slice(0, 120),
      account_id: accountId.slice(0, 120),
      cleared,
      remaining: Object.keys(nextStore).length,
    });
    return { ok: true, cleared, remaining: Object.keys(nextStore).length };
  });
}

async function rememberSchedulerAutoKeyFailure(account = {}, error = null, { signal = null, expected_db_key_runtime_version = null } = {}) {
  throwIfSchedulerAborted(signal);
  const expectedVersion = Number(expected_db_key_runtime_version);
  if (Number.isFinite(expectedVersion) && expectedVersion !== dbKeyRuntimeStateVersion()) return false;
  let processGeneration = String(error?.key_diagnostics?.memory_process_generation || '').trim();
  if (!processGeneration) {
    processGeneration = await currentWxKeyProcessGeneration({ signal })
      .then(state => String(state?.process_generation || '').trim())
      .catch(e => {
        if (isSchedulerAbort(e, signal)) throw e;
        return '';
      });
  }
  if (!processGeneration) return false;
  return withSchedulerAutoKeyFailureLock(async () => {
    throwIfSchedulerAborted(signal);
    if (Number.isFinite(expectedVersion) && expectedVersion !== dbKeyRuntimeStateVersion()) return false;
    const key = schedulerAutoKeyFailureKey(account);
    if (!key) return false;
    const store = await loadSchedulerAutoKeyFailures();
    throwIfSchedulerAborted(signal);
    if (Number.isFinite(expectedVersion) && expectedVersion !== dbKeyRuntimeStateVersion()) return false;
    store[key] = {
      account_id: accountIdentity(account).slice(0, 120),
      account_fingerprint: manualKeyAccountFingerprint(account),
      platform: process.platform,
      code: String(error?.public_code || error?.code || '').trim().slice(0, 120),
      message: sanitizeText(error?.message || String(error || '')).slice(0, 240),
      failed_at: new Date().toISOString(),
      db_key_runtime_version: Number.isFinite(expectedVersion) ? expectedVersion : dbKeyRuntimeStateVersion(),
      process_generation: processGeneration,
    };
    await writeSchedulerAutoKeyFailures(store);
    return true;
  });
}

async function clearSchedulerAutoKeyFailure(account = {}, { signal = null } = {}) {
  throwIfSchedulerAborted(signal);
  return withSchedulerAutoKeyFailureLock(async () => {
    throwIfSchedulerAborted(signal);
    const key = schedulerAutoKeyFailureKey(account);
    if (!key) return false;
    const store = await loadSchedulerAutoKeyFailures();
    if (!Object.hasOwn(store, key)) return false;
    delete store[key];
    await writeSchedulerAutoKeyFailures(store);
    return true;
  });
}

async function hasSchedulerAutoKeyFailure(account = {}, { signal = null } = {}) {
  return (await schedulerAutoKeyFailureStatus(account, { signal })).active;
}

function schedulerAutoKeyFailureCooldownState(item = {}, { process_generation = '', now = Date.now() } = {}) {
  const failedAt = Date.parse(String(item?.failed_at || ''));
  const failedAtValid = Number.isFinite(failedAt) && failedAt <= now + 60_000;
  const ageMs = failedAtValid ? Math.max(0, now - failedAt) : Number.POSITIVE_INFINITY;
  const retryAfterMs = Math.max(0, SCHEDULER_AUTO_KEY_FAILURE_TTL_MS - ageMs);
  const active = item?.platform === process.platform
    && !!String(process_generation || '').trim()
    && String(item?.process_generation || '').trim() === String(process_generation || '').trim()
    && retryAfterMs > 0;
  return {
    active,
    retry_after_ms: active ? retryAfterMs : 0,
    reason: active
      ? 'cooldown_active'
      : (!failedAtValid
        ? 'invalid_failed_at'
        : (ageMs >= SCHEDULER_AUTO_KEY_FAILURE_TTL_MS
          ? 'cooldown_expired'
          : (!String(process_generation || '').trim()
            ? 'process_generation_unavailable'
            : (String(item?.process_generation || '').trim() !== String(process_generation || '').trim()
              ? 'process_generation_changed'
              : 'platform_changed')))),
  };
}

async function schedulerAutoKeyFailureStatus(account = {}, { signal = null, process_generation = null } = {}) {
  throwIfSchedulerAborted(signal);
  const key = schedulerAutoKeyFailureKey(account);
  if (!key) return { active: false, retry_after_ms: 0, reason: 'account_missing' };
  let processGeneration = process_generation === null
    ? ''
    : String(process_generation || '').trim();
  if (process_generation === null) {
    processGeneration = await currentWxKeyProcessGeneration({ signal })
      .then(state => String(state?.process_generation || '').trim())
      .catch(e => {
        if (isSchedulerAbort(e, signal)) throw e;
        return '';
      });
  }
  return withSchedulerAutoKeyFailureLock(async () => {
    throwIfSchedulerAborted(signal);
    const store = await loadSchedulerAutoKeyFailures();
    const item = store[key];
    if (!item) return { active: false, retry_after_ms: 0, reason: 'not_recorded' };
    const status = schedulerAutoKeyFailureCooldownState(item, { process_generation: processGeneration });
    if (status.active) return status;
    delete store[key];
    await writeSchedulerAutoKeyFailures(store);
    logInfo('scheduler_auto_key_failure_cooldown_cleared', {
      account_id: accountIdentity(account),
      reason: status.reason,
    });
    return status;
  });
}

function schedulerErrorLooksAutoKeyFailure(error = {}) {
  const code = String(error?.public_code || error?.code || '').trim();
  const message = String(error?.message || error || '').toLowerCase();
  if (code === 'wxdb_key_scan_unavailable') return false;
  if (['wxdb_partial_shards_unreadable', 'wxdb_all_shards_unreadable'].includes(code)) {
    const cause = String(error?.wxdb_diagnostics?.shard_open_failure_cause || '').trim();
    if (cause === 'key' || error?.key_diagnostics?.shard_open_failure === true) return true;
    return false;
  }
  if (/^(?:wxdb_mirror_|wxdb_source_|wxdb_temp_copy_|db_copy_required|wxdb_account_not_found)/.test(code)) return false;
  if (/wxdb_temp_copy_|wxdb_mirror_|wxdb_source_|db_copy_required|路径越界|源数据库|项目副本|临时副本|permission denied|access is denied|unable to open database file/.test(message)) return false;
  if (code === 'wxdb_key_verification_failed') return true;
  return /no raw key matched|no candidate key opened|weixin v4 page hmac mismatch|page hmac|hmac mismatch|sqlcipher key validation failure|wrong key|invalid key/.test(message);
}

function schedulerOutputPathForPending(filePath = '') {
  const resolved = path.resolve(String(filePath || ''));
  if (!resolved || !isInside(OUTPUTS_DIR, resolved) || isInside(OUTPUTS_TMP_DIR, resolved)) return '';
  return resolved;
}

function schedulerPendingOutputBase(settings = {}, entry = {}) {
  const explicit = String(
    entry?.output_base_relative
      || entry?.history_item?.output_base_relative
      || entry?.output_dir_identity
      || entry?.history_item?.output_dir_identity
      || '',
  ).trim();
  if (explicit) {
    const candidate = path.isAbsolute(explicit)
      ? path.resolve(explicit)
      : path.resolve(PROJECT_ROOT, explicit);
    if (!isInside(OUTPUTS_DIR, candidate)
      || path.resolve(candidate) === path.resolve(OUTPUTS_DIR)
      || isInside(OUTPUTS_TMP_DIR, candidate)) return '';
    return candidate;
  }
  try {
    return outputDirFromSettings(settings);
  } catch {
    return '';
  }
}

function schedulerPendingOutputBaseError(entry = {}) {
  const recorded = sanitizeText(entry?.output_base_relative || entry?.output_dir_identity || '').trim();
  return Object.assign(new Error(recorded
    ? `调度待恢复记录的原输出目录无效（${recorded}）；本次不会删除待恢复游标，也不会在新输出目录重复生成。`
    : '调度待恢复记录缺少可验证的原输出目录；本次不会删除待恢复游标，也不会重复生成。'), {
    code: 'scheduler_pending_output_base_invalid',
    public_code: 'scheduler_pending_output_base_invalid',
    detail: 'pending_output_base_invalid',
  });
}

function isMissingSchedulerOutputError(error = null) {
  return ['ENOENT', 'ENOTDIR'].includes(String(error?.code || '').trim());
}

function schedulerPendingOutputCheckError(error = null, filePath = '', stage = 'version') {
  const detail = sanitizeText(error?.message || String(error || '')).trim();
  const target = schedulerProjectRelative(filePath);
  const message = detail
    ? `调度待恢复游标对应的已保存文件无法校验（${target}）：${detail}。本次不会删除待恢复游标，也不会重复生成同一批摘要。`
    : `调度待恢复游标对应的已保存文件无法校验（${target}）。本次不会删除待恢复游标，也不会重复生成同一批摘要。`;
  return Object.assign(new Error(message), {
    code: 'scheduler_pending_output_check_failed',
    public_code: 'scheduler_pending_output_check_failed',
    detail: 'pending_output_check_failed',
    stage,
    file_path: filePath,
    relative_path: target,
    cause: error || undefined,
  });
}

async function rememberPendingSchedulerCursorCommit({ settings = {}, cursorKey = '', cursorState = {}, saved = {}, digest = {}, account = {}, group = {}, reason = '' } = {}) {
  const storeKey = schedulerPendingCursorStoreKey(cursorKey);
  const state = normalizeSchedulerCursorState(cursorState);
  const filePath = schedulerOutputPathForPending(saved?.file_path || '');
  const fileVersion = String(saved?.file_version || saved?.saved_file_version || '').trim();
  const digestId = String(saved?.digest_id || digest?.digest_id || '').trim();
  const outputBase = schedulerPendingOutputBase(settings);
  if (!storeKey || !state.last_seq || !digestId || !outputBase) return false;
  const digestPath = schedulerOutputPathForPending(saved?.digest_path || '');
  const now = new Date().toISOString();
  const store = await loadSchedulerPendingCursors();
  store[storeKey] = {
    cursor_key: String(cursorKey || '').trim(),
    cursor_state: state,
    settings_revision: settingsRevision(settings),
    rule_fingerprint: String(state.rule_fingerprint || '').trim(),
    account_id: accountIdentity(account),
    account_identity_id: accountCursorIdentity(account),
    group_id: String(group?.id || group?.group_id || '').trim(),
    group: String(group?.name || group?.group_name || '').trim(),
    phase: filePath && fileVersion ? 'saved' : 'prepared',
    digest_id: digestId,
    output_base_relative: schedulerProjectRelative(outputBase),
    file_path: filePath,
    relative_path: String(saved?.relative_path || '').trim(),
    file_version: fileVersion,
    digest_path: digestPath,
    digest_relative_path: String(saved?.digest_relative_path || '').trim(),
    digest_file_version: String(saved?.digest_file_version || saved?.saved_digest_file_version || '').trim(),
    history_item: schedulerPendingHistoryItem(saved, digest),
    history_item_key: String(saved?.history_item_key || '').trim(),
    reason: sanitizeText(reason || saved?.local_action_after_commit_reason || ''),
    created_at: String(store[storeKey]?.created_at || now),
    updated_at: now,
  };
  await writeSchedulerPendingCursors(store);
  return true;
}

async function forgetPendingSchedulerCursorCommit(cursorKey = '') {
  const storeKey = schedulerPendingCursorStoreKey(cursorKey);
  if (!storeKey) return false;
  const store = await loadSchedulerPendingCursors();
  if (!Object.hasOwn(store, storeKey)) return false;
  delete store[storeKey];
  await writeSchedulerPendingCursors(store);
  return true;
}

async function tryForgetPendingSchedulerCursorCommit(cursorKey = '') {
  try {
    await forgetPendingSchedulerCursorCommit(cursorKey);
    return { ok: true, error: '' };
  } catch (e) {
    const error = sanitizeText(e?.message || String(e));
    logWarn('scheduler_pending_cursor_clear_failed', { cursor_key: cursorKey, error });
    return { ok: false, error };
  }
}

async function pendingSchedulerFileStillMatches(entry = {}, signal = null) {
  const filePath = schedulerOutputPathForPending(entry.file_path || '');
  if (!filePath) return false;
  let stat = null;
  try {
    stat = await fsp.stat(filePath);
  } catch (e) {
    if (isMissingSchedulerOutputError(e)) return false;
    if (isSchedulerAbort(e, signal)) throw e;
    throw schedulerPendingOutputCheckError(e, filePath, 'stat');
  }
  if (!stat?.isFile?.()) return false;
  const expected = String(entry.file_version || '').trim();
  if (!expected) return false;
  let current = '';
  try {
    current = await outputFileVersion(filePath, { signal });
  } catch (e) {
    if (isSchedulerAbort(e, signal)) throw e;
    throw schedulerPendingOutputCheckError(e, filePath, 'version');
  }
  if (!current) throw schedulerPendingOutputCheckError(new Error('file version is empty'), filePath, 'version_empty');
  return !!current && outputFileVersionMatches(expected, current);
}

async function recoverPendingSchedulerCursorCommit({ settings = {}, cursorKey = '', currentCursorState = {}, account = {}, group = {}, ruleFingerprint = '', signal = null } = {}) {
  const storeKey = schedulerPendingCursorStoreKey(cursorKey);
  if (!storeKey) return null;
  const store = await loadSchedulerPendingCursors();
  let entry = store[storeKey];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const sameRule = !entry.rule_fingerprint || !ruleFingerprint || entry.rule_fingerprint === ruleFingerprint;
  const currentAccountIdentityId = accountCursorIdentity(account);
  const sameAccountIdentity = !!currentAccountIdentityId
    && String(entry.account_identity_id || '').trim().toLowerCase() === currentAccountIdentityId;
  const groupId = String(group?.id || group?.group_id || '').trim();
  const sameGroup = !entry.group_id || !groupId || entry.group_id === groupId;
  const cursorState = normalizeSchedulerCursorState(entry.cursor_state || {});
  if (!sameGroup) {
    await forgetPendingSchedulerCursorCommit(cursorKey).catch(e => logWarn('scheduler_pending_cursor_clear_failed', { cursor_key: cursorKey, error: sanitizeText(e?.message || String(e)) }));
    return null;
  }
  if (!sameAccountIdentity) {
    const message = entry.account_identity_id
      ? '待恢复游标属于另一个微信本人账号，已隔离且不会推进当前账号游标。'
      : '待恢复游标缺少微信本人身份，已隔离且不会自动绑定到当前账号。';
    return {
      recovery_failed: true,
      recovery_error: message,
      cursor_state: cursorState,
      entry,
      identity_unverified: true,
    };
  }
  if (!cursorState.last_seq) {
    await forgetPendingSchedulerCursorCommit(cursorKey).catch(() => {});
    return null;
  }
  let indexedHistoryItem = null;
  try {
    const outputBase = schedulerPendingOutputBase(settings, entry);
    if (!outputBase) throw schedulerPendingOutputBaseError(entry);
    if (entry.file_path && entry.file_version) {
      const fileMatches = await pendingSchedulerFileStillMatches(entry, signal);
      if (!fileMatches) {
        await forgetPendingSchedulerCursorCommit(cursorKey).catch(e => logWarn('scheduler_pending_cursor_clear_failed', { cursor_key: cursorKey, error: sanitizeText(e?.message || String(e)) }));
        return null;
      }
      indexedHistoryItem = await ensureHistoryArtifactIndexed(settings, schedulerPendingHistoryItemFromEntry(entry), { signal, base: outputBase });
    } else {
      indexedHistoryItem = await recoverHistoryArtifactByDigestId(settings, entry.digest_id, { signal, base: outputBase });
      if (!indexedHistoryItem) {
        await forgetPendingSchedulerCursorCommit(cursorKey).catch(e => logWarn('scheduler_pending_cursor_clear_failed', { cursor_key: cursorKey, error: sanitizeText(e?.message || String(e)) }));
        return null;
      }
      entry = {
        ...entry,
        ...schedulerSavedArtifactMeta(indexedHistoryItem, { digest_id: entry.digest_id || '' }),
        ...schedulerPendingHistoryItem(indexedHistoryItem, { digest_id: entry.digest_id || '' }),
        phase: 'saved',
        history_item: indexedHistoryItem,
      };
    }
  } catch (e) {
    if (isSchedulerAbort(e, signal)) throw e;
    const message = sanitizeText(e?.message || String(e));
    const logPayload = {
      account_id: accountIdentity(account),
      group_id: groupId,
      digest_id: entry.digest_id || '',
      cursor_key: cursorKey,
      error: message,
    };
    if (e?.code === 'scheduler_pending_output_check_failed') logWarn('scheduler_pending_output_check_failed', logPayload);
    else logWarn('scheduler_pending_history_recovery_failed', logPayload);
    return {
      recovery_failed: true,
      recovery_error: message,
      cursor_state: cursorState,
      entry,
    };
  }
  if (!sameRule) {
    await forgetPendingSchedulerCursorCommit(cursorKey).catch(e => logWarn('scheduler_pending_cursor_clear_failed', { cursor_key: cursorKey, error: sanitizeText(e?.message || String(e)) }));
    logWarn('scheduler_pending_history_recovered_rule_changed', {
      account_id: accountIdentity(account),
      group_id: groupId,
      digest_id: entry.digest_id || '',
      cursor_key: cursorKey,
    });
    return {
      cursor_state: cursorState,
      entry,
      history_item: indexedHistoryItem,
      history_recovered_rule_changed: true,
    };
  }
  if (schedulerCursorStatesEqual(currentCursorState, cursorState)) {
    const pendingCleanup = await tryForgetPendingSchedulerCursorCommit(cursorKey);
    logInfo('scheduler_pending_cursor_already_committed', {
      account_id: accountIdentity(account),
      group_id: groupId,
      digest_id: entry.digest_id || '',
      cursor_key: cursorKey,
      cleanup_failed: pendingCleanup.ok !== true,
    });
    return {
      cursor_state: cursorState,
      entry,
      history_item: indexedHistoryItem,
      already_committed: true,
      pending_cursor_cleanup_failed: pendingCleanup.ok !== true,
      pending_cursor_cleanup_error: pendingCleanup.error,
    };
  }
  const cursorCommit = await commitSchedulerCursorState(cursorKey, cursorState, signal, {
    account,
    group,
    digestId: entry.digest_id || '',
    cursorKey,
    cursor: cursorState.last_seq,
    settings,
  });
  const pendingCleanup = await tryForgetPendingSchedulerCursorCommit(cursorKey);
  logWarn('scheduler_pending_cursor_recovered', {
    account_id: accountIdentity(account),
    group_id: groupId,
    digest_id: entry.digest_id || '',
    cursor_key: cursorKey,
    cursor: cursorState.last_seq,
  });
  return {
    cursor_state: cursorState,
    cursor_commit: cursorCommit,
    entry,
    history_item: indexedHistoryItem,
    pending_cursor_cleanup_failed: pendingCleanup.ok !== true,
    pending_cursor_cleanup_error: pendingCleanup.error,
  };
}

async function disablePersistedSchedulerForSetup(settings = {}, { reason = 'setup_required', force = false, signal = null } = {}) {
  throwIfSchedulerAborted(signal);
  if (!settings?.scheduler?.enabled) return settings;
  return withSettingsSaveTransaction(async () => {
    throwIfSchedulerAborted(signal);
    const latest = await loadSettings({ includeSecrets: true });
    throwIfSchedulerAborted(signal);
    const accounts = await schedulerAccountsForSetup(latest, { signal, phase: `disable_${reason}` });
    const pauseReason = await schedulerSettingsPauseReasonWithRuntime(latest, accounts, { signal });
    throwIfSchedulerAborted(signal);
    if (!latest.scheduler?.enabled || (!force && !pauseReason)) return latest;
    const disableReason = pauseReason || schedulerPersistedDisabledReason(reason, latest);
    const saved = await saveSettingsPatchInTransaction({
      scheduler: {
        enabled: false,
        disabled_reason: schedulerPersistedDisabledReason(disableReason, latest),
        disabled_at: new Date().toISOString(),
      },
    });
    logWarn('scheduler_persistently_disabled_setup_required', { reason: disableReason });
    return saved;
  });
}

function schedulerPersistedDisabledReason(reason = 'setup_required', settings = {}) {
  const text = String(reason || '').trim();
  if (settings?._secrets_invalid) return 'secrets_invalid';
  if (!settings?.llm?.base_url) return 'llm_base_url_missing';
  if (!(settings?.llm?.api_key_set || settings?.llm?.api_key)) return 'llm_api_key_missing';
  if (!settings?.llm?.model) return 'llm_model_missing';
  if (text === 'manual_key_unverified') return 'manual_key_unverified';
  if (text === 'scheduler_no_targets') return 'scheduler_no_targets';
  if (text === 'scheduler_unscoped_targets') return 'scheduler_unscoped_targets';
  if (text === 'scheduler_targets_need_review') return 'scheduler_targets_need_review';
  if (text === 'reschedule') return 'reschedule_setup_required';
  return 'setup_required';
}

function schedulerResultRetryAfterMs(result = null) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return 0;
  const candidates = [Number(result.retry_after_ms || 0)];
  if (Array.isArray(result.items)) {
    for (const item of result.items) candidates.push(Number(item?.retry_after_ms || 0));
  }
  const positive = candidates.filter(value => Number.isFinite(value) && value > 0);
  return positive.length ? Math.floor(Math.min(...positive)) : 0;
}

function schedulerNextDelayAfterResult(result = null, configuredIntervalMs = 0) {
  const configured = Math.min(MAX_SCHEDULER_INTERVAL_MS, Math.max(1000, Number(configuredIntervalMs || 0)));
  const retryAfterMs = schedulerResultRetryAfterMs(result);
  return retryAfterMs > 0 ? Math.max(1000, Math.min(configured, retryAfterMs)) : configured;
}

function applySchedulerRuntimePersistenceResult(persisted, generation = schedulerGeneration) {
  if (schedulerTerminalShutdown || generation !== schedulerGeneration) return false;
  state.runtime_state_degraded = persisted !== true;
  return true;
}

async function scheduleNext(settings, delayMs, generation = schedulerGeneration) {
  if (schedulerTerminalShutdown || generation !== schedulerGeneration) return;
  const delay = Math.min(MAX_SCHEDULER_INTERVAL_MS, Math.max(1000, Number(delayMs || 0)));
  if (timer) clearTimeout(timer);
  state.timer_active = true;
  state.next_run_at = new Date(Date.now() + delay).toISOString();
  const runtimeStatePersisted = await persistSchedulerRuntimeState(
    settings,
    state.next_run_at,
    durationToMs(settings.scheduler.default_interval),
  );
  if (!applySchedulerRuntimePersistenceResult(runtimeStatePersisted, generation)) return;
  timer = setTimeout(() => {
    if (schedulerTerminalShutdown || generation !== schedulerGeneration) return;
    timer = null;
    state.timer_active = false;
    state.runtime_state_degraded = false;
    state.next_run_at = '';
    const cycleController = new AbortController();
    const cyclePromise = runSchedulerTimerCycle(cycleController, async () => {
      let runResult = null;
      try {
        runResult = await runSchedulerOnce({ reason: 'timer', signal: cycleController.signal });
      } catch {
        // Keep the daemon alive; status carries the sanitized failure.
      }
      if (schedulerTerminalShutdown || generation !== schedulerGeneration || cycleController.signal.aborted) return;
      let latest;
      try {
        latest = await loadSettings({ includeSecrets: true });
      } catch (e) {
        markSchedulerRuntimeBlocked(schedulerSettingsUnavailableError(e, 'reschedule'), { reason: 'reschedule', retry: true, generation });
        return;
      }
      if (schedulerTerminalShutdown || generation !== schedulerGeneration || cycleController.signal.aborted) return;
      let latestAccounts;
      try {
        latestAccounts = await schedulerAccountsForSetup(latest, { signal: cycleController.signal, phase: 'reschedule' });
      } catch (e) {
        if (isSchedulerAbort(e, cycleController.signal)) return;
        markSchedulerRuntimeBlocked(e, { reason: 'reschedule', retry: true, generation });
        return;
      }
      if (latest.scheduler?.enabled && !await schedulerSettingsNeedSetupWithRuntime(latest, latestAccounts, { signal: cycleController.signal })) {
        await scheduleNext(latest, schedulerNextDelayAfterResult(runResult, durationToMs(latest.scheduler.default_interval)), generation);
      } else {
        if (latest.scheduler?.enabled) {
          try {
            latest = await disablePersistedSchedulerForSetup(latest, { reason: 'reschedule', signal: cycleController.signal });
          } catch (e) {
            if (isSchedulerAbort(e, cycleController.signal) || schedulerTerminalShutdown || generation !== schedulerGeneration) return;
            if (e?.code === 'scheduler_account_list_unavailable') {
              markSchedulerRuntimeBlocked(e, { reason: 'reschedule', retry: true, generation });
              return;
            }
            markSchedulerPersistentDisableFailed(e, { reason: 'reschedule', generation });
            return;
          }
          if (schedulerTerminalShutdown || generation !== schedulerGeneration || cycleController.signal.aborted) return;
          let retryAccounts;
          try {
            retryAccounts = await schedulerAccountsForSetup(latest, { signal: cycleController.signal, phase: 'reschedule_after_disable_check' });
          } catch (e) {
            if (isSchedulerAbort(e, cycleController.signal)) return;
            markSchedulerRuntimeBlocked(e, { reason: 'reschedule', retry: true, generation });
            return;
          }
          if (latest.scheduler?.enabled && !await schedulerSettingsNeedSetupWithRuntime(latest, retryAccounts, { signal: cycleController.signal })) {
            await scheduleNext(latest, schedulerNextDelayAfterResult(runResult, durationToMs(latest.scheduler.default_interval)), generation);
            return;
          }
          logWarn('scheduler_reschedule_skipped_setup_required');
        }
        if (schedulerTerminalShutdown || generation !== schedulerGeneration || cycleController.signal.aborted) return;
        state.enabled = false;
        state.timer_active = false;
        state.runtime_state_degraded = false;
        state.next_run_at = '';
      }
    });
    void cyclePromise.catch(e => {
      if (isSchedulerAbort(e, cycleController.signal)) return;
      logError('scheduler_timer_cycle_failed', { error: sanitizeText(e?.message || String(e)) });
    });
  }, delay);
}

async function executeSchedulerTick({ reason, force = false, signal = null, expected_settings_revision = '', generation = schedulerGeneration }) {
  throwIfSchedulerAborted(signal);
  updateActiveSchedulerProgress({
    phase: 'settings',
    label: '读取调度设置',
    detail: '正在核对设置版本和执行条件',
  });
  let settings = await loadSettings({ includeSecrets: true });
  throwIfSchedulerAborted(signal);
  assertSchedulerExpectedSettingsRevision(settings, expected_settings_revision);
  rememberSchedulerSettingsRevision(settings);
  const settingsRevisionUsed = settingsRevision(settings);
  const schedulerRuntimeRevisionUsed = schedulerRuntimeRevision(settings);
  state.interval_ms = durationToMs(settings.scheduler.default_interval);
  if (!settings.scheduler.enabled && !force) return {
    ok: true,
    reason,
    skipped: 0,
    detail: 'scheduler_disabled',
    at: new Date().toISOString(),
    settings_revision_used: settingsRevisionUsed,
    scheduler_runtime_revision_used: schedulerRuntimeRevisionUsed,
  };
  if (!schedulerTargetRefs(settings).length) {
    if (settings.scheduler.enabled) {
      try {
        settings = await disablePersistedSchedulerForSetup(settings, { reason: 'scheduler_no_targets', signal });
      } catch (e) {
        if (isSchedulerAbort(e, signal)) throw e;
        const failure = markSchedulerPersistentDisableFailed(e, { reason: reason || 'scheduler_no_targets', generation });
        return {
          ...failure.result,
          settings_revision_used: settingsRevisionUsed,
          scheduler_runtime_revision_used: schedulerRuntimeRevisionUsed,
        };
      }
      throwIfSchedulerAborted(signal);
      state.interval_ms = durationToMs(settings.scheduler?.default_interval);
      stopSchedulerRuntimeAfterPersistedDisable(settings, 'scheduler_no_targets', generation);
    }
    logWarn('scheduler_skipped', { reason, detail: 'no_whitelisted_groups' });
    return {
      ok: false,
      reason,
      skipped: 0,
      detail: 'no_whitelisted_groups',
      at: new Date().toISOString(),
      settings_revision_used: settingsRevisionUsed,
      scheduler_runtime_revision_used: schedulerRuntimeRevisionUsed,
      ...schedulerAutoDisabledMeta(settings, settingsRevisionUsed),
    };
  }
  if (schedulerBaseSettingsNeedSetup(settings)) {
    if (settings.scheduler.enabled) {
      try {
        settings = await disablePersistedSchedulerForSetup(settings, { reason: reason || 'run', signal });
      } catch (e) {
        if (isSchedulerAbort(e, signal)) throw e;
        const failure = markSchedulerPersistentDisableFailed(e, { reason: reason || 'run', generation });
        return {
          ...failure.result,
          settings_revision_used: settingsRevisionUsed,
          scheduler_runtime_revision_used: schedulerRuntimeRevisionUsed,
        };
      }
      throwIfSchedulerAborted(signal);
      state.interval_ms = durationToMs(settings.scheduler?.default_interval);
      stopSchedulerRuntimeAfterPersistedDisable(settings, reason || 'run', generation);
    }
    logWarn('scheduler_skipped', { reason, detail: 'llm_not_configured' });
    return {
      ok: false,
      reason,
      skipped: 0,
      detail: 'llm_not_configured',
      at: new Date().toISOString(),
      settings_revision_used: settingsRevisionUsed,
      scheduler_runtime_revision_used: schedulerRuntimeRevisionUsed,
      ...schedulerAutoDisabledMeta(settings, settingsRevisionUsed),
    };
  }

  const window = schedulerWindow(settings.scheduler.digest_window);
  const result = {
    ok: true,
    reason,
    at: new Date().toISOString(),
    since: window.since,
    until: window.until,
    accounts: 0,
    checked: 0,
    generated: 0,
    recovered: 0,
    skipped: 0,
    failed: 0,
    items: [],
    settings_revision_used: settingsRevisionUsed,
    scheduler_runtime_revision_used: schedulerRuntimeRevisionUsed,
  };
  activeRunPartialResult = result;
  updateActiveSchedulerProgress({
    phase: 'prepare',
    label: '准备检查目标',
    detail: '正在核对游标和本地恢复记录',
  });
  try {
    await assertSchedulerPendingCursorStoreReadable();
  } catch (e) {
    if (isSchedulerAbort(e, signal)) throw e;
    const message = sanitizeText(e?.message || String(e));
    logWarn('scheduler_pending_cursor_store_invalid_run_blocked', {
      reason,
      backup: sanitizeText(e?.backup_relative_path || ''),
      error: message,
    });
    return {
      ...result,
      ok: false,
      detail: schedulerFailureDetail(e),
      error: message,
      pending_cursor_store_invalid: true,
      pending_cursor_backup: sanitizeText(e?.backup_relative_path || ''),
    };
  }

  updateActiveSchedulerProgress({
    phase: 'accounts',
    label: '读取微信账号',
    detail: '正在定位已保存目标所属的微信账号',
  });
  const accounts = await listAccounts({ signal });
  throwIfSchedulerAborted(signal);
  if (!accounts.length) {
    logWarn('scheduler_skipped', { reason, detail: 'no_accounts' });
    return { ...result, ok: false, detail: 'no_accounts' };
  }
  result.accounts = accounts.length;
  const trustedTargets = schedulerTrustedTargetSettings(settings, accounts);
  const runtimeSettings = trustedTargets.settings;
  const schedulerRefs = trustedTargets.refs;
  const accountEntries = [];
  let groupLookupComplete = true;
  if (trustedTargets.issues.length) {
    result.ok = false;
    result.detail = 'account_identity_scope_required';
    result.identity_scope_issue_count = trustedTargets.issues.length;
    result.identity_scope_issues = trustedTargets.issues.slice(0, 12);
    result.failed += trustedTargets.issues.length;
    result.items.push(...trustedTargets.issues.slice(0, 50).map(item => schedulerBlockedTargetItem({
      detail: item.detail,
      account_id: item.account_id,
      account: item.account,
      group: item.group,
      error: item.detail === 'account_identity_unverified'
        ? '该微信账号尚未通过消息库确认本人身份，已停止自动检查；请先在总结页读取一次该账号消息，再重新保存调度规则。'
        : '该规则仍绑定旧存储目录，已停止把它自动继承给当前微信本人账号；请在设置页确认后重新保存。',
    })));
  }
  const targetAccounts = schedulerAccountsForTargetRefs(accounts, schedulerRefs);
  updateActiveSchedulerProgress({
    phase: 'keys',
    label: '核对本地数据密钥',
    detail: `正在检查 ${targetAccounts.length} 个目标账号`,
  });
  const unverifiedManualKeyAccounts = await schedulerMissingManualKeyAccountsWithRuntime(settings, targetAccounts, {
    signal,
    ignore_auto_key_cooldown: force,
  });
  let runnableTargetAccounts = targetAccounts;
  if (unverifiedManualKeyAccounts.length) {
    const unverifiedAccountIds = new Set(unverifiedManualKeyAccounts.map(item => item.account_id).filter(Boolean));
    const retryableAutoKeyAccounts = unverifiedManualKeyAccounts.filter(item => item?.retryable_auto_scan === true);
    const setupBlockedKeyAccounts = unverifiedManualKeyAccounts.filter(item => item?.retryable_auto_scan !== true);
    runnableTargetAccounts = targetAccounts.filter(account => !unverifiedAccountIds.has(accountIdentity(account)));
    result.skipped += retryableAutoKeyAccounts.length;
    result.failed += setupBlockedKeyAccounts.length;
    result.items.push(...unverifiedManualKeyAccounts.map(item => ({
      account_id: item.account_id,
      account: item.account,
      generated: false,
      detail: item.retryable_auto_scan === true ? 'auto_scan_cooldown' : 'manual_key_unverified',
      retryable_auto_scan: item.retryable_auto_scan === true,
      retry_after_ms: Math.max(0, Number(item.retry_after_ms || 0) || 0),
      error: item.retryable_auto_scan === true
        ? '自动密钥扫描刚刚失败；已进入短暂冷却，后台定时任务保持启用并会自动重试'
        : '目标微信账号没有已保存并验证通过的手动数据库密钥',
    })));
    if (!runnableTargetAccounts.length && !retryableAutoKeyAccounts.length && settings.scheduler.enabled) {
      try {
        settings = await disablePersistedSchedulerForSetup(settings, { reason: reason || 'manual_key_unverified', signal });
      } catch (e) {
        if (isSchedulerAbort(e, signal)) throw e;
        const failure = markSchedulerPersistentDisableFailed(e, { reason: reason || 'manual_key_unverified', generation });
        result.ok = false;
        result.detail = 'scheduler_persistent_disable_failed';
        result.error = failure.message;
        result.missing_manual_key_account_count = unverifiedManualKeyAccounts.length;
        result.missing_manual_key_accounts = unverifiedManualKeyAccounts.slice(0, 12);
        return result;
      }
      throwIfSchedulerAborted(signal);
      state.interval_ms = durationToMs(settings.scheduler?.default_interval);
      stopSchedulerRuntimeAfterPersistedDisable(settings, reason || 'manual_key_unverified', generation);
    }
    const keyBlockDetail = retryableAutoKeyAccounts.length ? 'auto_scan_cooldown' : 'manual_key_unverified';
    logWarn('scheduler_skipped', { reason, detail: keyBlockDetail, accounts: unverifiedManualKeyAccounts.map(item => item.account_id).slice(0, 12) });
    result.ok = false;
    result.detail = keyBlockDetail;
    result.missing_manual_key_account_count = unverifiedManualKeyAccounts.length;
    result.missing_manual_key_accounts = unverifiedManualKeyAccounts.slice(0, 12);
    result.retryable_auto_key_account_count = retryableAutoKeyAccounts.length;
    if (!runnableTargetAccounts.length) return { ...result, ...schedulerAutoDisabledMeta(settings, settingsRevisionUsed) };
  }
  for (const account of runnableTargetAccounts) {
    throwIfSchedulerAborted(signal);
    const accountId = accountIdentity(account);
    let groups = [];
    try {
      updateActiveSchedulerProgress({
        phase: 'groups',
        label: '读取群列表',
        detail: '正在匹配该账号下已保存的目标群',
        account: account.name || '当前微信账号',
        group: '',
      });
      groups = await listGroups({
        account_id: accountId,
        signal,
        legacy_manual_key_policy: LEGACY_MANUAL_KEY_POLICY.DENY,
      });
      throwIfSchedulerAborted(signal);
      const verifiedAccount = await assertSchedulerAccountIdentityCurrent(account, signal, '群列表读取后');
      accountEntries.push({ account: verifiedAccount, groups });
    } catch (e) {
      if (isSchedulerAbort(e, signal)) throw e;
      groupLookupComplete = false;
      const message = sanitizeText(e?.message || String(e));
      result.failed++;
      result.items.push({ account_id: accountId, account: account.name || accountId, generated: false, detail: 'account_groups_failed', error: message });
      logError('scheduler_account_failed', { account_id: accountId, error: message });
      continue;
    }
  }
  throwIfSchedulerAborted(signal);
  const allGroups = schedulerGroupUniverse(accountEntries);
  const allowUnscopedRefs = false;
  const unscopedRefCount = schedulerUnscopedRefCount(schedulerRefs);
  const unscopedRefsIgnored = !allowUnscopedRefs && unscopedRefCount > 0;
  const missingAccountRefs = schedulerMissingAccountRefs(schedulerRefs, accounts);
  const ambiguousAccountRefs = schedulerAmbiguousAccountRefs(schedulerRefs, accounts);
  const ambiguousRefs = ambiguousSchedulerRefs(schedulerRefs, allGroups);
  let unresolvedTargetCount = 0;
  if (ambiguousAccountRefs.length) {
    unresolvedTargetCount += ambiguousAccountRefs.length;
    result.ambiguous_account_ref_count = ambiguousAccountRefs.length;
    result.ambiguous_account_refs = ambiguousAccountRefs.slice(0, 12);
    result.detail = 'ambiguous_account_refs';
    result.items.push(...ambiguousAccountRefs.slice(0, 50).map(ref => schedulerBlockedTargetItem({
      detail: 'ambiguous_account_refs',
      account_id: ref.account_id || '',
      account: ref.account_id || '',
      group: ref.group || '',
      error: '自动检查规则的账号标识命中多个微信账号，已停止按旧别名猜测目标；请重新保存为当前账号的群规则。',
    })));
    logWarn('scheduler_ambiguous_account_refs', { count: ambiguousAccountRefs.length });
  }
  if (ambiguousRefs.length) {
    unresolvedTargetCount += ambiguousRefs.length;
    result.ambiguous_refs = ambiguousRefs;
    if (!result.detail) result.detail = 'ambiguous_group_refs';
    result.items.push(...ambiguousRefs.slice(0, 50).map(ref => schedulerBlockedTargetItem({
      detail: 'ambiguous_group_refs',
      account_id: ref.account_id || '',
      group: ref.ref || '',
      label: `重名自动检查规则：${ref.ref || '未命名群'}`,
      error: '自动检查规则匹配到多个群，已停止按群名或旧 ID 猜测；请重新保存为带账号范围的群规则。',
    })));
    logWarn('scheduler_ambiguous_group_refs', { refs: ambiguousRefs });
  }
  if (missingAccountRefs.length) {
    unresolvedTargetCount += missingAccountRefs.length;
    result.missing_account_ref_count = missingAccountRefs.length;
    result.missing_account_refs = missingAccountRefs.slice(0, 12);
    if (!result.detail) result.detail = 'missing_account_refs';
    result.items.push(...missingAccountRefs.slice(0, 50).map(ref => schedulerBlockedTargetItem({
      detail: 'missing_account_refs',
      account_id: ref.account_id || '',
      account: ref.account_id || '',
      group: ref.group || '',
      error: '自动检查规则属于当前未检测到的微信账号，已停止把它当作成功跳过。',
    })));
    logWarn('scheduler_missing_account_refs', { count: missingAccountRefs.length });
  }
  if (unscopedRefsIgnored) {
    unresolvedTargetCount += unscopedRefCount;
    result.unscoped_ref_count = unscopedRefCount;
    if (!result.detail) result.detail = 'unscoped_group_refs_ignored';
    const unscopedRefs = schedulerRefs.filter(schedulerRefIsUnscoped);
    result.items.push(...unscopedRefs.slice(0, 50).map(ref => schedulerBlockedTargetItem({
      detail: 'unscoped_group_refs_ignored',
      group: schedulerRefLabel(ref),
      label: `未绑定账号的旧规则：${schedulerRefLabel(ref) || '未命名群'}`,
      error: '旧规则没有账号范围，已停止在多账号/项目副本环境中猜测目标；请重新保存白名单或每群规则。',
    })));
    logWarn('scheduler_unscoped_group_refs_ignored', { count: unscopedRefCount });
  }
  if (unresolvedTargetCount > 0) {
    result.unresolved_target_count = unresolvedTargetCount;
    result.failed += unresolvedTargetCount;
  }
  const targetEntries = accountEntries.map(({ account, groups }) => ({
    account,
    groups,
    targets: selectScheduledGroups(groups, schedulerRefs, account, { allGroups, allowUnscopedRefs }),
  }));
  const totalTargets = targetEntries.reduce((sum, entry) => sum + entry.targets.length, 0);
  let completedTargets = 0;
  updateActiveSchedulerProgress({
    phase: 'targets',
    label: '已确定检查目标',
    detail: totalTargets > 0 ? `共 ${totalTargets} 个群，准备逐个检查` : '没有匹配到可执行目标',
    total_targets: totalTargets,
    completed_targets: 0,
    current_index: 0,
    account: '',
    group: '',
  });
  for (const { account, groups, targets } of targetEntries) {
    throwIfSchedulerAborted(signal);
    const accountId = accountIdentity(account);
    // All target groups for one scheduled account must read one published
    // project-mirror snapshot. A forced refresh below replaces this context.
    const mirrorContext = schedulerMirrorReadinessContext();
    const databaseReadBatchId = `scheduler:${crypto.randomUUID()}`;
    let accountAutoKeyRetryAfterMs = 0;
    try {
      for (const group of targets) {
        throwIfSchedulerAborted(signal);
        const currentIndex = completedTargets + 1;
        const reportTargetProgress = progress => updateActiveSchedulerProgress({
          ...(progress && typeof progress === 'object' ? progress : {}),
          total_targets: totalTargets,
          completed_targets: completedTargets,
          current_index: currentIndex,
          account: account.name || '当前微信账号',
          group: group.name || '未命名群',
        });
        reportTargetProgress({
          phase: 'target_prepare',
          label: '准备群消息',
          detail: '正在核对游标和本地工作数据',
        });
        if (accountAutoKeyRetryAfterMs > 0) {
          result.skipped++;
          result.items.push({
            ...schedulerItemIdentity(account, group),
            account_id: accountId,
            generated: false,
            detail: 'auto_scan_cooldown',
            retryable_auto_scan: true,
            retry_after_ms: accountAutoKeyRetryAfterMs,
            error: '同一微信账号刚刚发生自动密钥扫描失败，本轮剩余群已跳过并等待冷却后自动重试',
          });
          completedTargets++;
          updateActiveSchedulerProgress({
            phase: 'target_skipped',
            label: '已跳过当前目标',
            detail: '同一账号的本地数据密钥正在冷却，稍后会自动重试',
            total_targets: totalTargets,
            completed_targets: completedTargets,
            current_index: currentIndex,
            account: account.name || '当前微信账号',
            group: group.name || '未命名群',
          });
          continue;
        }
        result.checked++;
        const rawItem = await runGroupDigestWithRetry({ settings: runtimeSettings, account, group, window, attempts: 2, accounts, allGroups, groupLookupComplete, allowUnscopedRefs, mirrorContext, database_read_batch_id: databaseReadBatchId, signal, onProgress: reportTargetProgress });
        const item = signal?.aborted && rawItem.generated
          ? { ...rawItem, cancelled_after_commit: true }
          : rawItem;
        result.items.push(item);
        if (item.auto_scan_failed) accountAutoKeyRetryAfterMs = Math.max(1000, Number(item.retry_after_ms || SCHEDULER_AUTO_KEY_FAILURE_TTL_MS));
        if (item.error) result.failed++;
        else if (item.recovered_pending_cursor) result.recovered++;
        else if (item.generated) result.generated++;
        else result.skipped++;
        if (item.generated) logInfo('scheduler_group_generated', { account_id: accountId, group_id: group.id, group: group.name, digest_id: item.digest_id, message_count: item.message_count });
        else if (item.recovered_pending_cursor) logInfo('scheduler_group_recovered_pending_cursor', { account_id: accountId, group_id: group.id, group: group.name, digest_id: item.digest_id, message_count: item.message_count });
        else if (item.error) logError('scheduler_group_failed', { account_id: accountId, group_id: group.id, group: group.name, error: item.error, attempts: item.attempts });
        else logInfo('scheduler_group_skipped', { account_id: accountId, group_id: group.id, group: group.name, detail: item.detail, message_count: item.message_count });
        completedTargets++;
        updateActiveSchedulerProgress({
          phase: 'target_complete',
          label: item.error ? '当前目标检查失败' : (item.generated ? '当前目标已生成并保存' : '当前目标检查完成'),
          detail: item.error ? '已记录失败原因，继续检查剩余目标' : `已完成 ${completedTargets}/${totalTargets} 个目标`,
          total_targets: totalTargets,
          completed_targets: completedTargets,
          current_index: currentIndex,
          account: account.name || '当前微信账号',
          group: group.name || '未命名群',
        });
        if (signal?.aborted) {
          if (item.generated || item.cancelled_after_commit) {
            result.ok = false;
            result.cancelled = true;
            result.detail = 'cancelled_after_commit';
            return result;
          }
          throwIfSchedulerAborted(signal);
        }
      }
    } finally {
      await releaseWxDbIsolatedBatchSession(databaseReadBatchId).catch(error => {
        logError('scheduler_database_read_session_close_failed', {
          reason,
          account_id: accountId,
          error: sanitizeText(error?.message || String(error)),
          error_code: String(error?.public_code || error?.code || '').trim(),
        });
      });
    }
  }
  updateActiveSchedulerProgress({
    phase: 'finishing',
    label: '汇总检查结果',
    detail: `已完成 ${completedTargets}/${totalTargets} 个目标`,
    total_targets: totalTargets,
    completed_targets: completedTargets,
    current_index: 0,
    account: '',
    group: '',
  });
  if (!result.checked && !result.failed) {
    return {
      ...result,
      ok: false,
      skipped: 0,
      detail: ambiguousAccountRefs.length
        ? 'ambiguous_account_refs'
        : (ambiguousRefs.length
          ? 'ambiguous_group_refs'
          : (missingAccountRefs.length ? 'missing_account_refs' : (unscopedRefsIgnored ? 'unscoped_group_refs_ignored' : 'no_whitelisted_groups'))),
    };
  }
  result.ok = result.failed === 0;
  return result;
}

async function runGroupDigestWithRetry({ attempts = 2, ...args }) {
  let lastError;
  let usedAttempts = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    throwIfSchedulerAborted(args.signal);
    usedAttempts = attempt;
    try {
      const item = await runGroupDigest(args);
      if (!item?.error && !item?.recovered_pending_cursor && item?.detail !== 'recovered_saved_cursor') {
        await clearSchedulerAutoKeyFailure(args.account, { signal: args.signal }).catch(e => {
          if (isSchedulerAbort(e, args.signal)) throw e;
          logWarn('scheduler_auto_key_failure_clear_failed', {
            account_id: accountIdentity(args.account),
            error: sanitizeText(e?.message || String(e)),
          });
        });
      }
      return { ...item, attempts: attempt };
    } catch (e) {
      if (isSchedulerAbort(e, args.signal)) throw e;
      const mirrorChanged = String(e?.code || '') === 'wxdb_mirror_readiness_changed';
      const mirrorInvalidated = clearSchedulerMirrorReadinessForError(args.mirrorContext, e);
      lastError = mirrorChanged
        ? (mirrorInvalidated ? args.mirrorContext?.invalidated_error : null) || schedulerMirrorReadinessChangedError()
        : e;
      if (lastError?.scheduler_no_retry) break;
      if (attempt < attempts) await sleep(1000 * attempt, args.signal);
    }
  }
  const accountId = accountIdentity(args.account);
  const itemBase = schedulerItemIdentity(args.account, args.group);
  const staleSettings = lastError?.code === 'stale_settings';
  const autoKeyFailure = schedulerErrorLooksAutoKeyFailure(lastError);
  if (autoKeyFailure) {
    const keyRuntimeStateVersionAtFailure = dbKeyRuntimeStateVersion();
    await rememberSchedulerAutoKeyFailure(args.account, lastError, { signal: args.signal, expected_db_key_runtime_version: keyRuntimeStateVersionAtFailure }).catch(e => {
      if (isSchedulerAbort(e, args.signal)) throw e;
      logWarn('scheduler_auto_key_failure_record_failed', {
        account_id: accountId,
        error: sanitizeText(e?.message || String(e)),
      });
    });
  }
  return {
    ...itemBase,
    account_id: accountId,
    generated: false,
    detail: autoKeyFailure ? 'auto_scan_failed' : schedulerFailureDetail(lastError),
    attempts: usedAttempts || attempts,
    stale_settings: staleSettings,
    auto_scan_failed: autoKeyFailure,
    retryable_auto_scan: autoKeyFailure,
    retry_after_ms: autoKeyFailure ? SCHEDULER_AUTO_KEY_FAILURE_TTL_MS : 0,
    error_code: String(lastError?.public_code || lastError?.code || '').trim(),
    error: sanitizeText(lastError?.message || String(lastError)),
  };
}

function schedulerCollectionRecheckMeta(collection = {}) {
  const targetEvidence = messageCollectionTargetLastMessageEvidence(collection);
  return {
    mirror_recheck_attempted: collection?.mirror_recheck_attempted === true,
    mirror_recheck_refreshed: collection?.mirror_recheck_refreshed === true,
    mirror_recheck_reason: sanitizeText(collection?.mirror_recheck_reason || '').slice(0, 80),
    mirror_recheck_label: sanitizeText(collection?.mirror_recheck_label || '').slice(0, 160),
    mirror_recheck_detail: sanitizeText(collection?.mirror_recheck_detail || '').slice(0, 240),
    target_last_msg_at: Math.max(0, Number(collection?.target_last_msg_at || 0) || 0),
    target_last_msg_relation: sanitizeText(targetEvidence.relation || 'unknown').slice(0, 40),
    target_last_msg_status: sanitizeText(collection?.target_last_msg_status || '').slice(0, 80),
  };
}

function schedulerEmptyCollectionDiagnostics(collection = {}) {
  const tableRange = collection?.message_table_time_range || {};
  return {
    since: sanitizeText(collection?.since || '').slice(0, 40),
    until: sanitizeText(collection?.until || '').slice(0, 40),
    target_last_msg_at: Math.max(0, Number(collection?.target_last_msg_at || 0) || 0),
    target_last_msg_status: sanitizeText(collection?.target_last_msg_status || '').slice(0, 80),
    searched_shard_count: Math.max(0, Number(collection?.searched_shard_count || 0) || 0),
    matching_shard_count: Math.max(0, Number(collection?.matching_shard_count || tableRange.shard_count || 0) || 0),
    range_hit_count: Math.max(0, Number(collection?.window_hit_count || tableRange.hit_count || 0) || 0),
    table_row_count: Math.max(0, Number(collection?.table_row_count || tableRange.row_count || 0) || 0),
    message_shards_last_write_time: sanitizeText(collection?.message_shards_last_write_time || '').slice(0, 80),
  };
}

function schedulerEmptyCollectionStillUnsafeAfterMirrorRecheck(collection = {}, { recentlyVerified = false } = {}) {
  if (!collection || (collection.mirror_recheck_attempted !== true && recentlyVerified !== true)) return false;
  if (collection.no_matching_filters) return false;
  if (Number(collection.message_count || 0) > 0) return false;
  if (Array.isArray(collection.messages) && collection.messages.length > 0) return false;
  const targetEvidence = messageCollectionTargetLastMessageEvidence(collection);
  if (targetEvidence.in_range) return true;
  const tableRange = collection?.message_table_time_range || {};
  const searched = Math.max(0, Number(collection?.searched_shard_count || 0) || 0);
  const matching = Math.max(0, Number(collection?.matching_shard_count || tableRange.shard_count || 0) || 0);
  const tableRows = Math.max(0, Number(collection?.table_row_count || tableRange.row_count || 0) || 0);
  const rangeHits = Math.max(0, Number(collection?.window_hit_count || tableRange.hit_count || 0) || 0);
  const hasTrustedTargetWindowEvidence = targetEvidence.before_range === true;
  const hasDbRangeEvidence = searched > 0 && matching > 0 && tableRows > 0 && rangeHits === 0 && !collection.all_message_shards_before_range;
  return !hasTrustedTargetWindowEvidence && !hasDbRangeEvidence;
}

function schedulerUnsafeEmptyCollectionDetail(collection = {}) {
  const targetEvidence = messageCollectionTargetLastMessageEvidence(collection);
  if (targetEvidence.status === 'session_unavailable') return 'wxdb_session_evidence_unavailable';
  return 'wxdb_time_or_table_mismatch';
}

function schedulerMirrorReadinessContext(initialReadiness = null) {
  return {
    mirror_readiness: initialReadiness && typeof initialReadiness === 'object' && !Array.isArray(initialReadiness)
      ? initialReadiness
      : null,
    empty_recheck_outcome: null,
    invalidated_error: null,
  };
}

function schedulerMirrorReadinessIdentity(readiness = null) {
  if (!readiness || typeof readiness !== 'object' || Array.isArray(readiness)) return '';
  const accountId = String(readiness.account_id || '').trim();
  const scope = String(readiness.scope || readiness.mirror_scope || '').trim().toLowerCase();
  const snapshotHash = String(readiness.source_snapshot_meta_hash || '').trim().toLowerCase();
  if (!accountId || !scope || !/^[a-f0-9]{64}$/.test(snapshotHash)) return '';
  return `${accountId}\0${scope}\0${snapshotHash}`;
}

function schedulerMirrorReadinessChangedError(message = '') {
  const error = Object.assign(new Error(message || '定时任务复核时发现本地工作数据已切换到新快照；本轮剩余群已停止，避免混用新旧数据。下次运行会从同一个最新快照重新开始。'), {
    status: 409,
    code: 'wxdb_mirror_readiness_changed',
    public_code: 'wxdb_mirror_readiness_changed',
    scheduler_no_retry: true,
  });
  return error;
}

async function recheckSchedulerMirrorForEmptyCollection(account, context = null, { signal = null } = {}) {
  if (!context) throw schedulerMirrorReadinessChangedError('定时任务缺少账号级本地数据快照上下文，已停止本轮生成。');
  if (context.invalidated_error) throw context.invalidated_error;
  if (context.empty_recheck_outcome) return context.empty_recheck_outcome;
  const expectedIdentity = schedulerMirrorReadinessIdentity(context.mirror_readiness);
  if (!expectedIdentity) throw schedulerMirrorReadinessChangedError('定时任务空结果复核前缺少完整本地数据快照证据，已停止本轮生成。');
  const result = await ensureWxDbMirror({
    account_id: accountIdentity(account),
    reason: 'digest',
    force: false,
    signal,
  });
  throwIfSchedulerAborted(signal);
  const nextReadiness = result?.mirror_readiness;
  const nextIdentity = schedulerMirrorReadinessIdentity(nextReadiness);
  if (!nextIdentity || nextIdentity !== expectedIdentity) {
    const error = schedulerMirrorReadinessChangedError();
    context.invalidated_error = error;
    throw error;
  }
  const outcome = {
    readiness: nextReadiness,
    reused: result?.reused === true,
    refreshed: result?.refreshed === true,
  };
  context.mirror_readiness = nextReadiness;
  context.empty_recheck_outcome = outcome;
  return outcome;
}

function rememberSchedulerMirrorReadiness(context = null, collection = {}) {
  const readiness = collection?.mirror_readiness;
  if (!context || context.invalidated_error || !readiness || typeof readiness !== 'object' || Array.isArray(readiness)) return false;
  context.mirror_readiness = readiness;
  return true;
}

function clearSchedulerMirrorReadinessForError(context = null, error = null) {
  if (!context || String(error?.code || '') !== 'wxdb_mirror_readiness_changed') return false;
  if (!context.invalidated_error) context.invalidated_error = schedulerMirrorReadinessChangedError();
  context.mirror_readiness = null;
  context.empty_recheck_outcome = null;
  return true;
}

async function runGroupDigest({ settings, account, group, window, accounts = [], allGroups = [], groupLookupComplete = true, allowUnscopedRefs = false, mirrorContext = null, database_read_batch_id = '', signal = null, onProgress = null }) {
  throwIfSchedulerAborted(signal);
  if (mirrorContext?.invalidated_error) throw mirrorContext.invalidated_error;
  try {
    onProgress?.({ phase: 'cursor', label: '核对群检查游标', detail: '正在确认本次需要处理的新消息范围' });
  } catch {}
  let itemBase = schedulerItemIdentity(account, group);
  const override = schedulerOverrideForGroup(settings.scheduler?.per_group, group, account, {
    allGroups,
    allowUnscopedRefs: groupLookupComplete && allowUnscopedRefs,
  });
  const minMessages = override?.min_messages || settings.scheduler.min_messages_per_digest;
  const ruleFingerprint = schedulerRuleFingerprint({
    digest_window: settings.scheduler?.digest_window,
    keywords: override?.keywords || [],
    min_messages: minMessages,
  });
  const cursorInfo = await schedulerCursorStateForGroup({
    account,
    group,
    accounts,
    allGroups,
    groupLookupComplete,
    allowUnscopedCursorMigration: groupLookupComplete && allowUnscopedRefs,
  });
  const { cursorKey, cursorState, legacyCursorKey, legacyCursorUnverified } = cursorInfo;
  const ruleFingerprintChanged = schedulerCursorRuleFingerprintChanged(cursorState, ruleFingerprint);
  const ruleFingerprintUnknown = !!cursorState.last_seq && !String(cursorState.rule_fingerprint || '').trim();
  const activeCursorState = schedulerCursorStateForCurrentRule(cursorState, ruleFingerprintChanged);
  const previousCursor = cursorState.last_seq;
  const recoveredPendingCursor = await recoverPendingSchedulerCursorCommit({
    settings,
    cursorKey,
    currentCursorState: cursorState,
    account,
    group,
    ruleFingerprint,
    signal,
  });
  if (recoveredPendingCursor?.already_committed) {
    if (recoveredPendingCursor.pending_cursor_cleanup_failed) {
      itemBase = {
        ...itemBase,
        pending_cursor_cleanup_failed: true,
        pending_cursor_cleanup_error: recoveredPendingCursor.pending_cursor_cleanup_error || '',
      };
    }
  } else if (recoveredPendingCursor?.history_recovered_rule_changed) {
    logInfo('scheduler_group_history_recovered_for_previous_rule', {
      account_id: accountIdentity(account),
      group_id: group.id,
      digest_id: recoveredPendingCursor.entry?.digest_id || '',
    });
  } else if (recoveredPendingCursor) {
    const entry = recoveredPendingCursor.history_item || recoveredPendingCursor.entry || {};
    if (recoveredPendingCursor.recovery_failed) {
      const message = recoveredPendingCursor.recovery_error || '历史索引补提交失败，本次不会推进调度游标。';
      return {
        ...itemBase,
        generated: false,
        saved_without_cursor: true,
        pending_history_recovery_failed: true,
        message_count: Math.max(0, Number(recoveredPendingCursor.cursor_state?.message_count || 0) || 0),
        ...schedulerSavedArtifactMeta(entry, { digest_id: entry.digest_id || '' }),
        file_path: entry.file_path || '',
        cursor: cursorState.last_seq || '',
        pending_cursor: recoveredPendingCursor.cursor_state?.last_seq || '',
        error: message,
        error_summary: message,
        detail: 'pending_history_recovery_failed',
      };
    }
    return {
      ...itemBase,
      generated: false,
      recovered: true,
      recovered_pending_cursor: true,
      message_count: Math.max(0, Number(recoveredPendingCursor.cursor_state?.message_count || 0) || 0),
      ...schedulerSavedArtifactMeta(entry, { digest_id: entry.digest_id || '' }),
      file_path: entry.file_path || '',
      cursor: recoveredPendingCursor.cursor_state?.last_seq || '',
      detail: 'recovered_saved_cursor',
      cancelled_after_commit: !!recoveredPendingCursor.cursor_commit?.cancelled_after_commit,
      pending_cursor_cleanup_failed: !!recoveredPendingCursor.pending_cursor_cleanup_failed,
      pending_cursor_cleanup_error: recoveredPendingCursor.pending_cursor_cleanup_error || '',
    };
  }
  if (legacyCursorKey) {
    logInfo('scheduler_cursor_legacy_fallback', {
      account_id: accountIdentity(account),
      group_id: group.id,
      cursor_key: cursorKey,
      legacy_cursor_key_type: legacyCursorKey === String(group.id || group.group_id || '').trim() ? 'unscoped' : 'account_alias',
      verified: !legacyCursorUnverified,
    });
  }
  const cursorIdentityMeta = {
    cursor_key: cursorKey,
    legacy_cursor_recovered: !!legacyCursorKey,
    legacy_cursor_key: legacyCursorKey || '',
    legacy_cursor_unverified: !!legacyCursorUnverified,
    rule_fingerprint_changed: ruleFingerprintChanged,
    rule_fingerprint_unknown: ruleFingerprintUnknown,
  };
  if (legacyCursorUnverified) {
    return {
      ...itemBase,
      ...cursorIdentityMeta,
      generated: false,
      message_count: 0,
      window_message_count: 0,
      cursor_message_count: 0,
      pre_filter_message_count: 0,
      detail: 'cursor_legacy_unverified',
      cursor: previousCursor,
      min_messages: minMessages,
      keyword_override: override?.keywords || [],
    };
  }
  const collectionWindow = schedulerWindowWithLateSyncGrace(window, activeCursorState);
  const collectSchedulerMessages = () => collectMessages({
    batch_id: database_read_batch_id,
    account_id: accountIdentity(account),
    group_id: group.id,
    group_name: group.name,
    since: collectionWindow.since,
    until: collectionWindow.until,
    filters: override?.keywords?.length ? { keywords: override.keywords } : {},
    min_messages: minMessages,
    target_group: group,
    force_mirror: false,
    mirror_readiness: mirrorContext?.mirror_readiness || null,
    skip_media_enrichment: settings.privacy?.attach_media_content !== true,
    media_enrichment_skip_reason: settings.privacy?.attach_media_content === true ? '' : 'privacy_media_disabled',
    shard_row_positions: activeCursorState.shard_row_positions,
    shard_row_positions_initialized: activeCursorState.shard_row_positions_initialized === true,
    legacy_manual_key_policy: LEGACY_MANUAL_KEY_POLICY.DENY,
    signal,
    onProgress,
  });
  let collection = await collectSchedulerMessages();
  rememberSchedulerMirrorReadiness(mirrorContext, collection);
  throwIfSchedulerAborted(signal);
  const emptyMirrorRecheckRecentlyVerified = emptyCollectionMirrorRecheckRecentlyVerified(collection);
  if (shouldRecheckMirrorForEmptyCollection(collection)) {
    const firstDiagnostics = schedulerEmptyCollectionDiagnostics(collection);
    const mirrorRecheck = emptyCollectionMirrorRecheckSummary(collection);
    logWarn('scheduler_empty_collection_mirror_recheck', {
      account_id: accountIdentity(account),
      group_id: group.id,
      group: group.name,
      mirror_recheck_reason: mirrorRecheck.reason,
      initial_message_count: Math.max(0, Number(collection.message_count || 0) || 0),
      initial_below_minimum: collection.below_minimum === true,
      ...firstDiagnostics,
    });
    const originalCollection = collection;
    const recheck = await recheckSchedulerMirrorForEmptyCollection(account, mirrorContext, { signal });
    if (recheck.refreshed === true || recheck.reused !== true) {
      collection = await collectSchedulerMessages();
      rememberSchedulerMirrorReadiness(mirrorContext, collection);
    } else {
      collection = { ...originalCollection, mirror_readiness: recheck.readiness };
    }
    collection.mirror_recheck_attempted = true;
    collection.mirror_recheck_refreshed = recheck.refreshed === true;
    collection.mirror_recheck_reason = mirrorRecheck.reason;
    collection.mirror_recheck_label = recheck.refreshed === true
      ? '源库确有变化，已更新本地工作数据并重读'
      : '源库快照与本地工作数据一致，未复制整库';
    collection.mirror_recheck_detail = recheck.refreshed === true
      ? '源库元数据确有变化，已更新项目内本地工作数据，并重新读取当前群消息。'
      : '已核对源库文件元数据与本地工作数据清单，快照未变化；直接沿用首次读取结果，没有复制整库或重复解密消息。';
    collection.first_empty_collection_diagnostics = firstDiagnostics;
    rememberEmptyCollectionMirrorRecheck(collection);
  }
  throwIfSchedulerAborted(signal);
  await assertSchedulerAccountIdentityCurrent(account, signal, '消息读取后');
  const cursorMessages = Array.isArray(collection.cursor_messages)
    ? collection.cursor_messages
    : (Array.isArray(collection.messages) ? collection.messages : []);
  const cursorMessageCount = Math.max(0, Number(
    collection.cursor_message_count
    || cursorMessages.length
    || collection.message_count
    || 0
  ) || 0);
  const preFilterMessageCount = Math.max(0, Number(
    collection.window_message_count
    || collection.pre_filter_message_count
    || collection.scanned_message_count
    || cursorMessageCount
  ) || 0);
  const windowMessageCount = preFilterMessageCount || cursorMessageCount;
  const windowMessages = cursorMessages;
  const latestWindowCursor = latestMessageCursor(windowMessages);
  throwIfSchedulerAborted(signal);
  const activePreviousCursor = activeCursorState.last_seq || '';
  const cursorResultMeta = {
    ...cursorIdentityMeta,
    late_sync_grace_minutes: Math.round(SCHEDULER_LATE_SYNC_GRACE_MS / 60000),
    late_sync_lookback_hours: Math.round(SCHEDULER_LATE_SYNC_LOOKBACK_MS / 3600000),
    late_sync_window_extended: collectionWindow.since !== window.since,
    late_sync_incremental_message_count: Math.max(0, Number(collection.late_sync_incremental_message_count || 0) || 0),
    ...schedulerCollectionRecheckMeta(collection),
  };
  const cursorFilterState = schedulerCursorStateWithCollectionWindow(activeCursorState, collectionWindow);
  const activeSeen = Array.isArray(cursorFilterState.seen) ? cursorFilterState.seen : [];
  const previousSeen = new Set(activeSeen);
  let cursorFilteredOutNewMessages = false;
  if (activeSeen.length || activePreviousCursor) {
    const newCursorMessages = newMessagesForCursorState(windowMessages, cursorFilterState);
    const newDigestMessages = newMessagesForCursorState(collection.messages, cursorFilterState);
    if (!newCursorMessages.length && cursorMessageCount) {
      const cursor = latestWindowCursor || previousCursor;
      const cursorCommit = await commitSchedulerCursorState(cursorKey, schedulerCursorState({
        cursor: latestWindowCursor || previousCursor,
        messages: windowMessages,
        previousState: activeCursorState,
        window: collectionWindow,
        scheduledWindow: window,
        ruleFingerprint,
        replaceSeenWindow: true,
        shardRowPositions: collection.shard_row_positions,
        shardRowPositionsInitialized: collection.shard_row_positions_initialized === true,
      }), signal, { account, group, cursorKey, cursor, settings });
      return {
        ...itemBase,
        ...cursorResultMeta,
        generated: false,
        message_count: 0,
        window_message_count: windowMessageCount,
        cursor_message_count: cursorMessageCount,
        pre_filter_message_count: preFilterMessageCount,
        detail: 'no_new_messages_after_cursor',
        cursor,
        cancelled_after_commit: !!cursorCommit.cancelled_after_commit,
      };
    }
    cursorFilteredOutNewMessages = newCursorMessages.length > 0
      && newDigestMessages.length === 0
      && collection.filter_active === true;
    collection = {
      ...collection,
      messages: newDigestMessages,
      message_count: newDigestMessages.length,
      window_message_count: windowMessageCount,
      since: newDigestMessages[0]?.time || collection.since,
    };
  }
  if (!collection.message_count || collection.message_count < Number(minMessages || 0)) {
    const detail = collection.no_matching_filters || cursorFilteredOutNewMessages
      ? 'no_matching_filters'
      : (windowMessageCount <= 0 ? 'no_messages_in_window' : 'below_minimum');
    if (detail === 'no_messages_in_window') {
      if (schedulerEmptyCollectionStillUnsafeAfterMirrorRecheck(collection, { recentlyVerified: emptyMirrorRecheckRecentlyVerified })) {
        logWarn('scheduler_empty_collection_uncommitted_after_mirror_recheck', {
          account_id: accountIdentity(account),
          group_id: group.id,
          group: group.name,
          cursor_key: cursorKey,
          ...schedulerEmptyCollectionDiagnostics(collection),
        });
        return {
          ...itemBase,
          ...cursorResultMeta,
          generated: false,
          message_count: 0,
          window_message_count: windowMessageCount,
          cursor_message_count: cursorMessageCount,
          pre_filter_message_count: preFilterMessageCount,
          detail: schedulerUnsafeEmptyCollectionDetail(collection),
          cursor: previousCursor,
          checked_window_committed: false,
          cursor_advanced_without_digest: false,
          retryable_empty_window: true,
          min_messages: minMessages,
          keyword_override: override?.keywords || [],
        };
      }
      const cursorCommit = await commitSchedulerCursorState(cursorKey, schedulerCheckedWindowState({
        cursorState: activeCursorState,
        window: collectionWindow,
        scheduledWindow: window,
        ruleFingerprint,
        shardRowPositions: collection.shard_row_positions,
        shardRowPositionsInitialized: collection.shard_row_positions_initialized === true,
      }), signal, { account, group, cursorKey, cursor: activePreviousCursor || previousCursor || '', settings });
      return {
        ...itemBase,
        ...cursorResultMeta,
        generated: false,
        message_count: 0,
        window_message_count: windowMessageCount,
        cursor_message_count: cursorMessageCount,
        pre_filter_message_count: preFilterMessageCount,
        detail,
        cursor: activePreviousCursor || previousCursor || '',
        checked_window_committed: true,
        cancelled_after_commit: !!cursorCommit.cancelled_after_commit,
        min_messages: minMessages,
        keyword_override: override?.keywords || [],
      };
    }
    return {
      ...itemBase,
      ...cursorResultMeta,
      generated: false,
      message_count: collection.message_count || 0,
      window_message_count: windowMessageCount,
      cursor_message_count: cursorMessageCount,
      pre_filter_message_count: preFilterMessageCount,
      detail,
      cursor: previousCursor,
      cursor_advanced_without_digest: false,
      min_messages: minMessages,
      keyword_override: override?.keywords || [],
    };
  }
  const latestCursor = latestMessageCursor(collection.messages);
  if (!previousSeen.size && shouldSkipUnchangedCursor(activePreviousCursor, latestWindowCursor)) {
    return {
      ...itemBase,
      ...cursorResultMeta,
      generated: false,
      message_count: collection.message_count,
      window_message_count: windowMessageCount,
      cursor_message_count: cursorMessageCount,
      pre_filter_message_count: preFilterMessageCount,
      detail: 'no_new_messages',
      cursor: latestWindowCursor,
    };
  }
  const cursorWindowSeen = messageIdentityList(windowMessages);
  await assertSchedulerServerPngAvailable(signal);
  await assertSchedulerSettingsFreshBeforeExternalSideEffect(settings, signal);
  const digest = await summarizeDigest({
    settings,
    accountId: accountIdentity(account),
    groupId: String(group?.id || group?.group_id || collection.source_snapshot?.group_id || '').trim(),
    groupName: collection.group_name,
    since: collection.since,
    until: collection.until,
    messages: collection.messages,
    signal,
    onProgress,
  });
  throwIfSchedulerAborted(signal);
  await assertSchedulerAccountIdentityCurrent(account, signal, 'AI 摘要返回后');
  digest.input_message_count = collection.message_count;
  digest.scanned_message_count = collection.scanned_message_count || collection.message_count;
  digest.pre_filter_message_count = Math.max(0, Number(collection.pre_filter_message_count || 0) || 0);
  digest.filter_active = !!collection.filter_active;
  digest.filtered_out_message_count = Math.max(0, Number(digest.pre_filter_message_count || 0) - Number(collection.message_count || 0));
  digest.message_table_time_range = collection.message_table_time_range || null;
  digest.truncated = !!collection.truncated;
  digest.source_label = collection.source_label;
  digest.source_snapshot = collection.source_snapshot || null;
  digest.media_status = collection.media_status || null;
  digest.account_id = accountIdentity(account);
  digest.account_identity_id = accountCursorIdentity(account);
  digest.group_id = String(group?.id || group?.group_id || collection.source_snapshot?.group_id || '').trim();
  if (await schedulerSettingsChangedSince(settings, signal)) {
    const message = '设置已变化，已停止按旧设置保存调度摘要。';
    return {
      ...itemBase,
      ...cursorResultMeta,
      generated: false,
      message_count: collection.message_count,
      window_message_count: windowMessageCount,
      cursor_message_count: cursorMessageCount,
      pre_filter_message_count: preFilterMessageCount,
      digest_id: digest.digest_id,
      cursor: previousCursor,
      pending_cursor: latestWindowCursor || latestCursor || '',
      min_messages: minMessages,
      keyword_override: override?.keywords || [],
      stale_settings: true,
      error: message,
      error_summary: message,
      detail: 'stale_settings_before_save',
    };
  }
  const renderOptions = normalizeRenderOptions(settings.render);
  const renderedDigest = { ...digest, __render: renderOptions };
  let pngBuffer;
  try {
    try { onProgress?.({ phase: 'render', label: '生成长图', detail: '正在排版并绘制 PNG' }); } catch {}
    pngBuffer = await renderDigestPngBuffer(renderedDigest, renderOptions, { signal });
  } catch (e) {
    if (isSchedulerAbort(e, signal)) throw e;
    throw schedulerNoRetryError(e, e?.code || 'scheduler_render_after_digest_failed');
  }
  throwIfSchedulerAborted(signal);
  if (await schedulerSettingsChangedSince(settings, signal)) {
    const message = '设置已变化，已拒绝保存旧调度长图。';
    return {
      ...itemBase,
      ...cursorResultMeta,
      generated: false,
      message_count: collection.message_count,
      window_message_count: windowMessageCount,
      cursor_message_count: cursorMessageCount,
      pre_filter_message_count: preFilterMessageCount,
      digest_id: digest.digest_id,
      cursor: previousCursor,
      pending_cursor: latestWindowCursor || latestCursor || '',
      min_messages: minMessages,
      keyword_override: override?.keywords || [],
      stale_settings: true,
      error: message,
      error_summary: message,
      detail: 'stale_settings_before_save',
    };
  }
  const cursor = latestWindowCursor || latestCursor || String(Date.now());
  const cursorStateForCommit = schedulerCursorState({
    cursor,
    messages: windowMessages,
    previousState: activeCursorState,
    window: collectionWindow,
    scheduledWindow: window,
    ruleFingerprint,
    shardRowPositions: collection.shard_row_positions,
    shardRowPositionsInitialized: collection.shard_row_positions_initialized === true,
    replaceSeenWindow: true,
    seenWindow: cursorWindowSeen,
  });
  try {
    const prepared = await rememberPendingSchedulerCursorCommit({
      settings,
      cursorKey,
      cursorState: cursorStateForCommit,
      saved: { digest_id: digest.digest_id },
      digest,
      account,
      group,
      reason: 'before_output_commit',
    });
    if (!prepared) {
      throw Object.assign(new Error('无法建立调度输出写前恢复记录，已拒绝保存长图，避免崩溃后重复生成。'), {
        code: 'scheduler_pending_cursor_prepare_failed',
        detail: 'pending_cursor_prepare_failed',
      });
    }
  } catch (e) {
    if (isSchedulerAbort(e, signal)) throw e;
    throw schedulerNoRetryError(e, e?.code || 'scheduler_pending_cursor_prepare_failed');
  }
  let saved;
  try {
    try { onProgress?.({ phase: 'save', label: '保存长图和历史', detail: '正在提交文件、摘要数据和历史索引' }); } catch {}
    saved = await saveRenderedPng({
      settings,
      digest: renderedDigest,
      png_buffer: pngBuffer,
      save_operation_id: `scheduler:${crypto.createHash('sha256').update(`${cursorKey}\0${digest.digest_id}`).digest('hex')}`,
      signal,
      commitBarrier: async () => {
        if (await schedulerSettingsChangedSince(settings, signal)) {
          throw schedulerStaleSettingsError('设置已变化，已拒绝提交旧调度长图；下次会按新设置重试。');
        }
        await assertSchedulerAccountIdentityCurrent(account, signal, '长图提交前');
      },
      postArtifactCommitBarrier: async () => {
        await assertSchedulerAccountIdentityCurrent(account, signal, '长图输出提交后');
      },
    });
  } catch (e) {
    if (!schedulerSaveFailureMayHaveCommittedOutput(e)) {
      await forgetPendingSchedulerCursorCommit(cursorKey).catch(clearError => logWarn('scheduler_pending_cursor_clear_failed', {
        cursor_key: cursorKey,
        error: sanitizeText(clearError?.message || String(clearError)),
      }));
    }
    if (isSchedulerAbort(e, signal)) throw e;
    throw schedulerNoRetryError(e, e?.code || 'scheduler_save_after_digest_failed');
  }
  try {
    const recorded = await rememberPendingSchedulerCursorCommit({
      settings,
      cursorKey,
      cursorState: cursorStateForCommit,
      saved,
      digest,
      account,
      group,
      reason: savedSchedulerOutputHistoryUnbound(saved) ? 'saved_history_commit_failed' : 'before_cursor_commit',
    });
    if (!recorded) throw new Error('已保存调度长图，但无法把文件版本写入待恢复游标。');
  } catch (e) {
    const message = sanitizeText(e?.message || String(e));
    logError('scheduler_pending_cursor_record_failed_after_save', {
      account_id: accountIdentity(account),
      group_id: group.id,
      group: group.name,
      digest_id: digest.digest_id,
      cursor_key: cursorKey,
      error: message,
    });
    return {
      ...itemBase,
      ...cursorResultMeta,
      generated: false,
      saved_without_cursor: true,
      message_count: collection.message_count,
      window_message_count: windowMessageCount,
      cursor_message_count: cursorMessageCount,
      pre_filter_message_count: preFilterMessageCount,
      ...schedulerSavedArtifactMeta(saved, digest),
      file_path: saved.file_path,
      cursor: previousCursor,
      pending_cursor: cursor,
      min_messages: minMessages,
      keyword_override: override?.keywords || [],
      cursor_commit_failed: true,
      cursor_commit_error: message,
      error: message,
      error_summary: message,
      detail: 'saved_pending_cursor_record_failed',
    };
  }
  if (savedSchedulerOutputHistoryUnbound(saved)) {
    const message = savedSchedulerOutputHistoryUnboundMessage(saved);
    logError('scheduler_history_commit_failed_after_save', {
      account_id: accountIdentity(account),
      group_id: group.id,
      group: group.name,
      digest_id: digest.digest_id,
      cursor_key: cursorKey,
      error: message,
    });
    await rememberPendingSchedulerCursorCommit({
      settings,
      cursorKey,
      cursorState: cursorStateForCommit,
      saved,
      digest,
      account,
      group,
      reason: 'saved_history_commit_failed',
    }).catch(e => logWarn('scheduler_pending_cursor_record_failed', { cursor_key: cursorKey, error: sanitizeText(e?.message || String(e)) }));
    return {
      ...itemBase,
      ...cursorResultMeta,
      generated: false,
      saved_unindexed: true,
      message_count: collection.message_count,
      window_message_count: windowMessageCount,
      cursor_message_count: cursorMessageCount,
      pre_filter_message_count: preFilterMessageCount,
      ...schedulerSavedArtifactMeta(saved, digest),
      file_path: saved.file_path,
      cursor: previousCursor,
      pending_cursor: cursor,
      min_messages: minMessages,
      keyword_override: override?.keywords || [],
      local_action_after_commit_reason: saved.local_action_after_commit_reason || 'history_failed_after_commit',
      local_action_after_commit_error: message,
      error: message,
      error_summary: message,
      detail: 'saved_history_commit_failed',
    };
  }
  let cursorCommit = null;
  try {
    cursorCommit = await commitSchedulerCursorState(cursorKey, cursorStateForCommit, signal, {
      account,
      group,
      digestId: digest.digest_id,
      cursorKey,
      cursor,
      settings,
      outputCommitted: true,
    });
  } catch (e) {
    const message = sanitizeText(e?.message || String(e));
    if (isSchedulerAbort(e, signal)) {
      logWarn('scheduler_cursor_commit_cancelled_after_save', {
        account_id: accountIdentity(account),
        group_id: group.id,
        group: group.name,
        digest_id: digest.digest_id,
        cursor_key: cursorKey,
        error: message,
      });
      await rememberPendingSchedulerCursorCommit({
        settings,
        cursorKey,
        cursorState: cursorStateForCommit,
        saved,
        digest,
        account,
        group,
        reason: 'saved_cursor_commit_cancelled',
      }).catch(err => logWarn('scheduler_pending_cursor_record_failed', { cursor_key: cursorKey, error: sanitizeText(err?.message || String(err)) }));
      return {
        ...itemBase,
        ...cursorResultMeta,
        generated: false,
        saved_without_cursor: true,
        message_count: collection.message_count,
        window_message_count: windowMessageCount,
        cursor_message_count: cursorMessageCount,
        pre_filter_message_count: preFilterMessageCount,
        ...schedulerSavedArtifactMeta(saved, digest),
        file_path: saved.file_path,
        cursor: previousCursor,
        pending_cursor: cursor,
        min_messages: minMessages,
        keyword_override: override?.keywords || [],
        cancelled_after_commit: true,
        cursor_commit_failed: true,
        cursor_commit_error: message,
        detail: 'saved_cursor_commit_cancelled',
      };
    }
    logError('scheduler_cursor_commit_failed_after_save', {
      account_id: accountIdentity(account),
      group_id: group.id,
      group: group.name,
      digest_id: digest.digest_id,
      cursor_key: cursorKey,
      error: message,
    });
    if (e?.code !== 'stale_settings') {
      await rememberPendingSchedulerCursorCommit({
        settings,
        cursorKey,
        cursorState: cursorStateForCommit,
        saved,
        digest,
        account,
        group,
        reason: 'saved_cursor_commit_failed',
      }).catch(err => logWarn('scheduler_pending_cursor_record_failed', { cursor_key: cursorKey, error: sanitizeText(err?.message || String(err)) }));
    }
    return {
      ...itemBase,
      ...cursorResultMeta,
      generated: false,
      saved_without_cursor: true,
      message_count: collection.message_count,
      window_message_count: windowMessageCount,
      cursor_message_count: cursorMessageCount,
      pre_filter_message_count: preFilterMessageCount,
      ...schedulerSavedArtifactMeta(saved, digest),
      file_path: saved.file_path,
      cursor: previousCursor,
      pending_cursor: cursor,
      min_messages: minMessages,
      keyword_override: override?.keywords || [],
      cursor_commit_failed: true,
      cursor_commit_error: message,
      stale_settings: e?.code === 'stale_settings',
      error: message,
      error_summary: message,
      detail: 'saved_cursor_commit_failed',
    };
  }
  const pendingCleanup = await tryForgetPendingSchedulerCursorCommit(cursorKey);
  return {
    ...itemBase,
    ...cursorResultMeta,
    generated: true,
    message_count: collection.message_count,
    window_message_count: windowMessageCount,
    cursor_message_count: cursorMessageCount,
    pre_filter_message_count: preFilterMessageCount,
    ...schedulerSavedArtifactMeta(saved, digest),
    file_path: saved.file_path,
    cursor,
    min_messages: minMessages,
    keyword_override: override?.keywords || [],
    cancelled_after_commit: !!cursorCommit?.cancelled_after_commit,
    pending_cursor_cleanup_failed: pendingCleanup.ok !== true,
    pending_cursor_cleanup_error: pendingCleanup.error,
  };
}

async function commitSchedulerCursorState(cursorKey, state, signal = null, meta = {}) {
  throwIfSchedulerAborted(signal);
  await assertSchedulerAccountIdentityCurrent(meta.account || {}, signal, '游标提交前');
  const accountIdentityId = accountCursorIdentity(meta.account || {});
  const groupId = String(meta.group?.id || meta.group?.group_id || '').trim();
  if (!accountIdentityId || !groupId) {
    throw Object.assign(new Error('调度游标缺少已验证的微信本人身份或群标识，已拒绝写入。'), {
      code: 'scheduler_cursor_identity_required',
      public_code: 'scheduler_cursor_identity_required',
      scheduler_no_retry: true,
    });
  }
  const cursor = await withSettingsSaveTransaction(async () => {
    throwIfSchedulerAborted(signal);
    if (!meta?.outputCommitted && meta?.settings && await schedulerSettingsChangedSince(meta.settings, signal)) {
      throw schedulerStaleSettingsError('设置已变化，已拒绝推进旧调度游标；下次会按新设置重试。');
    }
    return setAccountGroupCursorState(accountIdentityId, groupId, state);
  });
  const cancelledAfterCommit = !!signal?.aborted;
  if (cancelledAfterCommit) {
    logWarn('scheduler_cancel_after_cursor_commit', {
      account_id: accountIdentity(meta.account || {}),
      group_id: meta.group?.id || '',
      group: meta.group?.name || '',
      digest_id: meta.digestId || '',
      cursor_key: meta.cursorKey || cursorKey,
      cursor: meta.cursor || cursor?.last_seq || '',
    });
  }
  return { cursor, cancelled_after_commit: cancelledAfterCommit };
}

function accountIdentity(account = {}) {
  return String(account.account_id || account.id || account.wxid || account.account || '').trim();
}

function accountCursorIdentity(account = {}) {
  const mirror = account?.mirror && typeof account.mirror === 'object' ? account.mirror : {};
  const identityId = String(account?.identity_id || mirror.identity_id || '').trim().toLowerCase();
  if (isWxDbMirrorIdentityVerified(account)) return identityId;
  return '';
}

function schedulerAccountReadIdentity(account = {}) {
  return {
    account_id: accountIdentity(account),
    identity_id: accountCursorIdentity(account),
    account_fingerprint: manualKeyAccountFingerprint(account),
  };
}

function schedulerAccountReadIdentityMatches(expectedAccount = {}, currentAccount = {}) {
  const expected = schedulerAccountReadIdentity(expectedAccount);
  const current = schedulerAccountReadIdentity(currentAccount);
  return !!expected.account_id
    && !!expected.identity_id
    && !!expected.account_fingerprint
    && expected.account_id === current.account_id
    && expected.identity_id === current.identity_id
    && expected.account_fingerprint === current.account_fingerprint;
}

async function assertSchedulerAccountIdentityCurrent(expectedAccount = {}, signal = null, phase = '调度读取') {
  throwIfSchedulerAborted(signal);
  const expected = schedulerAccountReadIdentity(expectedAccount);
  const accounts = await listAccounts({ force: true, signal });
  throwIfSchedulerAborted(signal);
  const matches = accounts.filter(account => accountIdentity(account) === expected.account_id);
  if (matches.length === 1 && schedulerAccountReadIdentityMatches(expectedAccount, matches[0])) return matches[0];
  throw Object.assign(new Error(`${phase}检测到微信账号身份已变化；已停止本轮 AI、文件保存和游标提交，请确认当前账号后重试。`), {
    code: 'scheduler_account_identity_changed',
    public_code: 'scheduler_account_identity_changed',
    scheduler_no_retry: true,
  });
}

function accountLegacyIdentities(account = {}) {
  return [...new Set([
    account.account_id,
    account.id,
    account.legacy_id,
    account.wxid,
    account.account,
    ...(Array.isArray(account.account_aliases) ? account.account_aliases : []),
  ].map(value => String(value || '').trim()).filter(Boolean))];
}

function accountCursorLegacyIdentities(account = {}) {
  const cursorIdentity = accountCursorIdentity(account);
  if (cursorIdentity !== accountIdentity(account)) {
    return [...new Set([
      account.wxid,
      account.verified_self_wxid,
    ].map(value => String(value || '').trim()).filter(value => value && value !== cursorIdentity))];
  }
  return accountLegacyIdentities(account).filter(value => value !== cursorIdentity);
}

function accountCursorLegacyStorageIdentities(account = {}) {
  const cursorIdentity = accountCursorIdentity(account);
  const trustedAliases = new Set(accountCursorLegacyIdentities(account));
  return accountLegacyIdentities(account)
    .filter(value => value !== cursorIdentity && !trustedAliases.has(value));
}

function uniqueAccounts(accounts = []) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(accounts) ? accounts : []) {
    const account = item?.account || item || {};
    const id = accountIdentity(account);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(account);
  }
  return out;
}

function schedulerAccountsFromGroups(allGroups = [], fallbackAccount = null) {
  const accounts = [];
  if (fallbackAccount && accountIdentity(fallbackAccount)) accounts.push(fallbackAccount);
  for (const entry of Array.isArray(allGroups) ? allGroups : []) {
    const account = entry?.account || {};
    if (accountIdentity(account)) accounts.push(account);
  }
  return uniqueAccounts(accounts);
}

function resolveSchedulerAccountScope(scope = '', accounts = []) {
  const clean = String(scope || '').trim();
  if (!clean) return { status: 'unscoped', scope: clean, account: null, account_id: '' };
  const list = uniqueAccounts(accounts);
  const exact = list.filter(account => accountIdentity(account) === clean);
  if (exact.length === 1) {
    return { status: 'matched', scope: clean, account: exact[0], account_id: accountIdentity(exact[0]), exact: true };
  }
  if (exact.length > 1) {
    return { status: 'ambiguous', scope: clean, accounts: exact, account_ids: exact.map(accountIdentity).filter(Boolean) };
  }
  const aliasMatches = list.filter(account => accountLegacyIdentities(account).includes(clean));
  const uniqueMatches = uniqueAccounts(aliasMatches);
  if (uniqueMatches.length === 1) {
    return { status: 'matched', scope: clean, account: uniqueMatches[0], account_id: accountIdentity(uniqueMatches[0]), exact: false };
  }
  if (uniqueMatches.length > 1) {
    return { status: 'ambiguous', scope: clean, accounts: uniqueMatches, account_ids: uniqueMatches.map(accountIdentity).filter(Boolean) };
  }
  return { status: 'missing', scope: clean, account: null, account_id: '' };
}

function schedulerItemIdentity(account = {}, group = {}) {
  const accountId = accountIdentity(account);
  const accountLabel = String(account.name || account.display_name || accountId || '').trim();
  const groupId = String(group.id || group.group_id || '').trim();
  const groupLabel = String(group.name || group.group_name || groupId || '').trim();
  return {
    account_id: accountId,
    account: accountLabel,
    group_id: groupId,
    group: groupLabel,
    label: [groupLabel, accountLabel && groupLabel !== accountLabel ? accountLabel : ''].filter(Boolean).join(' / ') || '未命名目标',
  };
}

function schedulerBlockedTargetItem({ detail = 'blocked', account_id = '', account = '', group = '', label = '', error = '' } = {}) {
  const cleanAccountId = String(account_id || '').trim().slice(0, 120);
  const cleanAccount = String(account || cleanAccountId || '').trim().slice(0, 120);
  const cleanGroup = String(group || '').trim().slice(0, 120);
  const cleanLabel = String(label || [cleanGroup, cleanAccount && cleanAccount !== cleanGroup ? cleanAccount : ''].filter(Boolean).join(' / ') || cleanAccount || cleanGroup || '未解析目标').trim().slice(0, 160);
  return {
    account_id: cleanAccountId,
    account: cleanAccount,
    group: cleanGroup,
    label: cleanLabel,
    generated: false,
    detail,
    error,
  };
}

function schedulerRefLabel(ref = {}) {
  if (typeof ref === 'string') return ref.trim();
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return '';
  return String(ref.group_name || ref.name || ref.group || ref.group_id || ref.id || '').trim();
}

function groupCursorKey(account = {}, group = {}) {
  const accountId = accountCursorIdentity(account);
  const groupId = String(group.id || group.group_id || '').trim();
  return accountId && groupId ? `${accountId}::${groupId}` : '';
}

function shouldSkipUnchangedCursor(previousCursor, latestCursor) {
  return !!previousCursor && !!latestCursor && previousCursor === latestCursor;
}

function schedulerCursorStateForCurrentRule(cursorState = {}, ruleFingerprintChanged = false) {
  if (!ruleFingerprintChanged) return cursorState || {};
  return {
    ...cursorState,
    last_seq: '',
    seen: [],
  };
}

function schedulerCursorRuleFingerprintChanged(cursorState = {}, ruleFingerprint = '') {
  if (cursorStateEmpty(cursorState)) return false;
  const previous = String(cursorState.rule_fingerprint || '').trim();
  if (!previous) return true;
  return previous !== String(ruleFingerprint || '').trim();
}

function schedulerRuleFingerprint({ digest_window = '', keywords = [], min_messages = 0 } = {}) {
  const normalized = {
    digest_window: String(digest_window || '').trim(),
    keywords: [...new Set((Array.isArray(keywords) ? keywords : [])
      .map(value => String(value || '').trim())
      .filter(Boolean))]
      .sort((a, b) => a.localeCompare(b)),
    min_messages: Math.max(0, Math.trunc(Number(min_messages || 0)) || 0),
  };
  return `r.${crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16)}`;
}

async function schedulerCursorStateForGroup({ account = {}, group = {}, accounts = [], allGroups = [], groupLookupComplete = true, allowUnscopedCursorMigration = false, cursor_file = '' } = {}) {
  const cursorOptions = cursor_file ? { file: cursor_file } : {};
  const cursorKey = groupCursorKey(account, group);
  const currentAccountId = accountCursorIdentity(account);
  const groupId = String(group.id || group.group_id || '').trim();
  const cursorState = await getAccountGroupCursorState(currentAccountId, groupId, cursorOptions);
  if (!cursorStateEmpty(cursorState)) return { cursorKey, cursorState, legacyCursorKey: '' };
  if (!groupId) {
    return { cursorKey, cursorState, legacyCursorKey: '' };
  }
  const trustedLegacyAliases = new Set(accountCursorLegacyIdentities(account));
  const accountAliasKeys = [...new Set([
    ...trustedLegacyAliases,
    ...accountCursorLegacyStorageIdentities(account),
  ])]
    .map(alias => `${alias}::${groupId}`)
    .filter(key => key && key !== cursorKey);
  const scopeAccounts = uniqueAccounts([
    ...(Array.isArray(accounts) ? accounts : []),
    ...schedulerAccountsFromGroups(allGroups, account),
  ]);
  for (const legacyCursorKey of accountAliasKeys) {
    const legacyCursorState = await getGroupCursorState(legacyCursorKey, cursorOptions);
    if (cursorStateEmpty(legacyCursorState)) continue;
    const alias = legacyCursorKey.slice(0, -(`::${groupId}`).length);
    const resolved = resolveSchedulerAccountScope(alias, scopeAccounts);
    if (
      trustedLegacyAliases.has(alias)
      && resolved.status === 'matched'
      && accountCursorIdentity(resolved.account) === currentAccountId
    ) {
      return { cursorKey, cursorState: legacyCursorState, legacyCursorKey };
    }
    return {
      cursorKey,
      cursorState: legacyCursorState,
      legacyCursorKey,
      legacyCursorUnverified: true,
      legacyCursorAmbiguous: resolved.status === 'ambiguous',
    };
  }
  const unscopedCursorState = await getGroupCursorState(groupId, cursorOptions);
  if (cursorStateEmpty(unscopedCursorState)) return { cursorKey, cursorState, legacyCursorKey: '' };
  if (groupLookupComplete && allowUnscopedCursorMigration && legacyCursorSafeForGroup(group, account, allGroups)) {
    return { cursorKey, cursorState: unscopedCursorState, legacyCursorKey: groupId };
  }
  return { cursorKey, cursorState: unscopedCursorState, legacyCursorKey: groupId, legacyCursorUnverified: true };
}

function cursorStateEmpty(state = {}) {
  return !state?.last_seq
    && !(Array.isArray(state?.seen) && state.seen.length)
    && !String(state?.scheduled_window_until || state?.window_until || '').trim();
}

function legacyCursorSafeForGroup(group = {}, account = {}, allGroups = []) {
  const groupId = String(group.id || group.group_id || '').trim();
  if (!groupId || !Array.isArray(allGroups) || !allGroups.length) return false;
  const accountId = accountIdentity(account);
  const matches = allGroups.filter(entry => {
    const candidateGroup = entry?.group || entry || {};
    return String(candidateGroup.id || candidateGroup.group_id || '').trim() === groupId;
  });
  return matches.length === 1 && accountIdentity(matches[0]?.account || {}) === accountId;
}

function selectScheduledGroups(groups, whitelist, account = {}, { allGroups = [], allowUnscopedRefs = false } = {}) {
  const refs = Array.isArray(whitelist) ? whitelist : [];
  if (!refs.length) return [];
  return (groups || []).filter(group => refs.some(ref => groupRefMatches(ref, group, account, { allGroups, allowUnscopedRefs })));
}

function schedulerTargetRefKey(ref = {}, accounts = []) {
  const scope = schedulerRefAccountScope(ref);
  const resolved = scope ? resolveSchedulerAccountScope(scope, accounts) : null;
  const accountKey = resolved?.status === 'matched'
    ? (accountCursorIdentity(resolved.account) || accountIdentity(resolved.account) || scope)
    : (scope || '*');
  const groupKey = typeof ref === 'string'
    ? ref.trim()
    : String(ref?.group_id || ref?.id || ref?.group_name || ref?.name || ref?.group || '').trim();
  if (!groupKey) return '';
  return `${accountKey}::${groupKey}`;
}

function schedulerTargetRefs(settings = {}, accounts = []) {
  const refs = [
    ...(Array.isArray(settings.groups?.whitelist) ? settings.groups.whitelist : []),
    ...(Array.isArray(settings.scheduler?.per_group) ? settings.scheduler.per_group : []),
  ];
  const seen = new Set();
  return refs.filter(ref => {
    const key = schedulerTargetRefKey(ref, accounts);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function schedulerTrustedTargetSettings(settings = {}, accounts = []) {
  const whitelist = schedulerIdentityScopePartition(settings.groups?.whitelist, accounts);
  const perGroup = schedulerIdentityScopePartition(settings.scheduler?.per_group, accounts);
  const trustedSettings = {
    ...settings,
    groups: {
      ...(settings.groups || {}),
      whitelist: whitelist.trusted,
    },
    scheduler: {
      ...(settings.scheduler || {}),
      per_group: perGroup.trusted,
    },
  };
  return {
    settings: trustedSettings,
    refs: schedulerTargetRefs(trustedSettings, accounts),
    issues: schedulerTargetRefs({
      groups: { whitelist: whitelist.issues },
      scheduler: { per_group: perGroup.issues },
    }, accounts),
  };
}

function schedulerManualKeyReadinessFromTargets(targetAccounts = [], missingManualKeyAccounts = []) {
  const missingAccounts = Array.isArray(missingManualKeyAccounts) ? missingManualKeyAccounts : [];
  const missingIds = new Set(missingAccounts
    .map(item => String(item?.account_id || '').trim())
    .filter(Boolean));
  const retryableIds = new Set(missingAccounts
    .filter(item => item?.retryable_auto_scan === true)
    .map(item => String(item?.account_id || '').trim())
    .filter(Boolean));
  const runnableTargetAccounts = (Array.isArray(targetAccounts) ? targetAccounts : [])
    .filter(account => !missingIds.has(accountIdentity(account)));
  return {
    target_accounts: targetAccounts,
    runnable_target_accounts: runnableTargetAccounts,
    missing_manual_key_accounts: missingManualKeyAccounts,
    retryable_auto_key_account_count: retryableIds.size,
    all_target_accounts_blocked: targetAccounts.length > 0
      && runnableTargetAccounts.length === 0
      && missingIds.size > 0,
    all_target_accounts_retryable: targetAccounts.length > 0
      && runnableTargetAccounts.length === 0
      && missingIds.size > 0
      && retryableIds.size === missingIds.size,
  };
}

function schedulerManualKeyTargetReadiness(settings = {}, accounts = []) {
  const trustedTargets = schedulerTrustedTargetSettings(settings, accounts);
  const targetAccounts = schedulerAccountsForTargetRefs(accounts, trustedTargets.refs);
  const missingManualKeyAccounts = schedulerMissingManualKeyAccounts(settings, targetAccounts);
  return {
    ...schedulerManualKeyReadinessFromTargets(targetAccounts, missingManualKeyAccounts),
    trusted_targets: trustedTargets,
  };
}

async function schedulerManualKeyTargetReadinessWithRuntime(settings = {}, accounts = [], { signal = null } = {}) {
  const trustedTargets = schedulerTrustedTargetSettings(settings, accounts);
  const targetAccounts = schedulerAccountsForTargetRefs(accounts, trustedTargets.refs);
  const missingManualKeyAccounts = await schedulerMissingManualKeyAccountsWithRuntime(settings, targetAccounts, { signal });
  return {
    ...schedulerManualKeyReadinessFromTargets(targetAccounts, missingManualKeyAccounts),
    trusted_targets: trustedTargets,
  };
}

function schedulerRefAccountScope(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return '';
  return String(ref.account_id || ref.account || '').trim();
}

function schedulerAccountsForTargetRefs(accounts = [], refs = []) {
  const list = Array.isArray(accounts) ? accounts : [];
  const targets = Array.isArray(refs) ? refs : [];
  if (!list.length || !targets.length) return [];
  const scopedAliases = new Set(targets.map(schedulerRefAccountScope).filter(Boolean));
  const out = [];
  const seen = new Set();
  const add = account => {
    const id = accountIdentity(account);
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(account);
  };
  if (scopedAliases.size) {
    for (const alias of scopedAliases) {
      const resolved = resolveSchedulerAccountScope(alias, list);
      if (resolved.status === 'matched') add(resolved.account);
    }
  }
  return out;
}

export function schedulerMissingManualKeyTargetAccounts(settings = {}, accounts = []) {
  return schedulerManualKeyTargetReadiness(settings, accounts).missing_manual_key_accounts;
}

export function schedulerAllTargetAccountsMissingManualKey(settings = {}, accounts = []) {
  return schedulerManualKeyTargetReadiness(settings, accounts).all_target_accounts_blocked;
}

function schedulerMissingManualKeyAccounts(settings = {}, accounts = []) {
  const autoScanCanAttempt = schedulerAutoScanCanAttempt(settings);
  if (autoScanCanAttempt) return [];
  const out = [];
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const accountId = accountIdentity(account);
    if (!accountId) continue;
    if (manualKeyVerifiedForAccount(settings, accountId, accountLegacyIdentities(account), manualKeyAccountFingerprint(account))) continue;
    out.push({
      account_id: accountId.slice(0, 120),
      account: String(account.name || account.display_name || account.wxid || accountId).trim().slice(0, 120),
    });
  }
  return out;
}

async function schedulerMissingManualKeyAccountsWithRuntime(settings = {}, accounts = [], { signal = null, ignore_auto_key_cooldown = false } = {}) {
  if (!schedulerAutoScanCanAttempt(settings)) return schedulerMissingManualKeyAccounts(settings, accounts);
  if (ignore_auto_key_cooldown) return [];
  const out = [];
  const processGeneration = await currentWxKeyProcessGeneration({ signal })
    .then(state => String(state?.process_generation || '').trim())
    .catch(e => {
      if (isSchedulerAbort(e, signal)) throw e;
      return '';
    });
  for (const account of Array.isArray(accounts) ? accounts : []) {
    throwIfSchedulerAborted(signal);
    const accountId = accountIdentity(account);
    if (!accountId) continue;
    if (manualKeyVerifiedForAccount(settings, accountId, accountLegacyIdentities(account), manualKeyAccountFingerprint(account))) {
      await clearSchedulerAutoKeyFailure(account, { signal }).catch(e => {
        if (isSchedulerAbort(e, signal)) throw e;
      });
      continue;
    }
    const autoScanVerified = await hasVerifiedAutoRawKeys(accountId, signal).catch(e => {
      if (isSchedulerAbort(e, signal)) throw e;
      return false;
    });
    if (autoScanVerified) {
      await clearSchedulerAutoKeyFailure(account, { signal }).catch(e => {
        if (isSchedulerAbort(e, signal)) throw e;
      });
      continue;
    }
    const schedulerAutoScanFailure = await schedulerAutoKeyFailureStatus(account, { signal, process_generation: processGeneration }).catch(e => {
      if (isSchedulerAbort(e, signal)) throw e;
      return { active: false, retry_after_ms: 0, reason: 'status_unavailable' };
    });
    const runtimeAutoScanFailed = schedulerAutoScanFailure.active ? false : await hasFailedAutoRawKeyScan(accountId, signal).catch(e => {
      if (isSchedulerAbort(e, signal)) throw e;
      return false;
    });
    if (schedulerAutoScanFailure.active || runtimeAutoScanFailed) {
      out.push({
        account_id: accountId.slice(0, 120),
        account: String(account.name || account.display_name || account.wxid || accountId).trim().slice(0, 120),
        retryable_auto_scan: true,
        block_reason: schedulerAutoScanFailure.active ? 'scheduler_auto_scan_cooldown' : 'runtime_auto_scan_cooldown',
        retry_after_ms: schedulerAutoScanFailure.active
          ? Math.max(0, Number(schedulerAutoScanFailure.retry_after_ms || 0) || 0)
          : SCHEDULER_AUTO_KEY_FAILURE_TTL_MS,
      });
    }
  }
  return out;
}

function schedulerAutoScanCanAttempt(settings = {}, platform = process.platform) {
  const currentPlatform = String(platform || process.platform || '');
  if (currentPlatform === 'win32') return true;
  const autoScanState = String(settings?.wechat?.key_auto_scan_state || '').trim().toLowerCase();
  return autoScanState === 'supported';
}

function schedulerOverrideForGroup(overrides = [], group = {}, account = {}, { allGroups = [], allowUnscopedRefs = false } = {}) {
  let best = null;
  let bestScore = 0;
  for (const item of Array.isArray(overrides) ? overrides : []) {
    const score = groupRefMatchScore(item, group, account, {
      legacyKeys: [item?.group, item?.group_id, item?.group_name, item?.name],
      allGroups,
      allowUnscopedRefs,
    });
    if (score >= bestScore && score > 0) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

function groupRefMatches(ref, group = {}, account = {}, { legacyKeys = [], allGroups = [], allowUnscopedRefs = false } = {}) {
  return groupRefMatchScore(ref, group, account, { legacyKeys, allGroups, allowUnscopedRefs }) > 0;
}

function groupRefMatchScore(ref, group = {}, account = {}, { legacyKeys = [], allGroups = [], allowUnscopedRefs = false } = {}) {
  const accountId = accountIdentity(account);
  const groupId = String(group.id || group.group_id || '').trim();
  const groupName = String(group.name || group.group_name || '').trim();
  if (typeof ref === 'string') {
    const legacy = ref.trim();
    if (!allowUnscopedRefs) return 0;
    if (!legacy || (legacy !== groupId && legacy !== groupName)) return 0;
    return groupRefAmbiguousInScope(legacy, group, account, allGroups) ? 0 : 1;
  }
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return 0;
  const refAccountId = String(ref.account_id || ref.account || '').trim();
  if (refAccountId) {
    const resolved = resolveSchedulerAccountScope(refAccountId, schedulerAccountsFromGroups(allGroups, account));
    if (resolved.status !== 'matched' || resolved.account_id !== accountId) return 0;
  }
  const refGroupId = String(ref.group_id || ref.id || '').trim();
  if (refGroupId) {
    if (!refAccountId && !allowUnscopedRefs) return 0;
    if (refGroupId !== groupId) return 0;
    if (!refAccountId && groupRefAmbiguousAcrossAccounts(refGroupId, group, account, allGroups)) return 0;
    return refAccountId ? 4 : 3;
  }
  const refGroupName = String(ref.group_name || ref.name || '').trim();
  if (refGroupName) {
    if (!refAccountId && !allowUnscopedRefs) return 0;
    if (refGroupName !== groupName) return 0;
    if (groupRefAmbiguousInScope(refGroupName, group, account, allGroups, { accountScoped: !!refAccountId })) return 0;
    return refAccountId ? 2 : 1;
  }
  const refLegacyGroup = String(ref.group || '').trim();
  if (refLegacyGroup) {
    if (!refAccountId && !allowUnscopedRefs) return 0;
    if (refLegacyGroup === groupId) {
      if (!refAccountId && groupRefAmbiguousAcrossAccounts(refLegacyGroup, group, account, allGroups)) return 0;
      return refAccountId ? 4 : 3;
    }
    if (refLegacyGroup === groupName) {
      if (groupRefAmbiguousInScope(refLegacyGroup, group, account, allGroups, { accountScoped: !!refAccountId })) return 0;
      return refAccountId ? 2 : 1;
    }
    return 0;
  }
  const legacy = legacyKeys.map(key => String(key || '').trim()).filter(Boolean);
  const matched = legacy.find(key => key === groupId || key === groupName);
  if (!matched) return 0;
  if (!allowUnscopedRefs) return 0;
  return groupRefAmbiguousInScope(matched, group, account, allGroups) ? 0 : 1;
}

function schedulerGroupUniverse(accountEntries = []) {
  return (Array.isArray(accountEntries) ? accountEntries : []).flatMap(entry => {
    const account = entry?.account || {};
    return (Array.isArray(entry?.groups) ? entry.groups : []).map(group => ({ account, group }));
  });
}

function schedulerHasMultipleAccounts(accountsOrEntries = []) {
  const ids = new Set();
  for (const entry of Array.isArray(accountsOrEntries) ? accountsOrEntries : []) {
    const id = accountIdentity(entry?.account || entry || {});
    if (id) ids.add(id);
  }
  return ids.size > 1;
}

function schedulerUnscopedRefCount(refs = []) {
  return (Array.isArray(refs) ? refs : []).filter(schedulerRefIsUnscoped).length;
}

function schedulerMissingAccountRefs(refs = [], accounts = []) {
  const list = uniqueAccounts(accounts);
  if (!list.length) return [];
  const out = [];
  for (const ref of Array.isArray(refs) ? refs : []) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) continue;
    const accountScope = String(ref.account_id || ref.account || '').trim();
    if (!accountScope) continue;
    const resolved = resolveSchedulerAccountScope(accountScope, list);
    if (resolved.status !== 'missing') continue;
    const group = String(ref.group_name || ref.name || ref.group || ref.group_id || ref.id || '').trim();
    out.push({
      account_id: accountScope.slice(0, 80),
      group: group.slice(0, 120),
    });
  }
  return out;
}

export function schedulerMissingAccountCleanupPlan(settings = {}, accounts = []) {
  const list = uniqueAccounts(accounts);
  const revision = settingsRevision(settings);
  if (!list.length) {
    return {
      scopes: [],
      refs: [],
      ref_count: 0,
      token: crypto.createHash('sha256').update(JSON.stringify({ revision, scopes: [], ref_count: 0 })).digest('hex'),
    };
  }
  const refs = [
    ...(Array.isArray(settings.groups?.whitelist) ? settings.groups.whitelist : []),
    ...(Array.isArray(settings.scheduler?.per_group) ? settings.scheduler.per_group : []),
  ].filter(ref => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return false;
    const scope = String(ref.account_id || ref.account || '').trim();
    return !!scope && resolveSchedulerAccountScope(scope, list).status === 'missing';
  });
  const scopes = [...new Set(refs
    .map(ref => String(ref.account_id || ref.account || '').trim())
    .filter(Boolean))].sort();
  const refCount = refs.length;
  const token = crypto.createHash('sha256').update(JSON.stringify({ revision, scopes, ref_count: refCount })).digest('hex');
  return {
    scopes,
    refs: refs.map(ref => ({
      account_id: String(ref.account_id || ref.account || '').trim().slice(0, 80),
      group: String(ref.group_name || ref.name || ref.group || ref.group_id || ref.id || '').trim().slice(0, 120),
    })),
    ref_count: refCount,
    token,
  };
}

function schedulerAmbiguousAccountRefs(refs = [], accounts = []) {
  const list = uniqueAccounts(accounts);
  if (!list.length) return [];
  const out = [];
  const seen = new Set();
  for (const ref of Array.isArray(refs) ? refs : []) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) continue;
    const accountScope = String(ref.account_id || ref.account || '').trim();
    if (!accountScope) continue;
    const resolved = resolveSchedulerAccountScope(accountScope, list);
    if (resolved.status !== 'ambiguous') continue;
    const group = String(ref.group_name || ref.name || ref.group || ref.group_id || ref.id || '').trim();
    const accountIds = (resolved.account_ids || []).filter(Boolean).sort();
    const key = `${accountScope}:${group}:${accountIds.join('|')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      account_id: accountScope.slice(0, 80),
      group: group.slice(0, 120),
      matches: accountIds.slice(0, 12),
    });
  }
  return out;
}

function schedulerRefIsUnscoped(ref) {
  if (typeof ref === 'string') return !!ref.trim();
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return false;
  if (String(ref.account_id || ref.account || '').trim()) return false;
  return !!String(ref.group_id || ref.id || ref.group_name || ref.name || ref.group || '').trim();
}

function schedulerIdentityScopePartition(refs = [], accounts = []) {
  const trusted = [];
  const issues = [];
  for (const ref of Array.isArray(refs) ? refs : []) {
    const scope = schedulerRefAccountScope(ref);
    if (!scope) {
      trusted.push(ref);
      continue;
    }
    const resolved = resolveSchedulerAccountScope(scope, accounts);
    if (resolved.status !== 'matched') {
      trusted.push(ref);
      continue;
    }
    const identityId = accountCursorIdentity(resolved.account);
    if (identityId && scope === identityId) {
      trusted.push(ref);
      continue;
    }
    issues.push({
      account_id: scope,
      account: String(resolved.account?.name || resolved.account?.display_name || accountIdentity(resolved.account) || scope).trim(),
      group: schedulerRefLabel(ref),
      detail: identityId ? 'legacy_account_scope' : 'account_identity_unverified',
      expected_identity_id: identityId,
    });
  }
  return { trusted, issues };
}

export function schedulerTargetAutoPauseReason(settings = {}, preview = {}) {
  const refs = schedulerTargetRefs(settings);
  const targetCount = Math.max(0, Number(preview?.target_count || 0) || 0);
  if (targetCount > 0) return '';
  if (preview?.group_lookup_complete === false || Math.max(0, Number(preview?.failed || 0) || 0) > 0) return '';

  const missingManualKeyCount = Math.max(0, Number(preview?.missing_manual_key_account_count || 0) || 0);
  const retryableAutoKeyCount = Math.max(0, Number(preview?.retryable_auto_key_account_count || 0) || 0);
  const runnableAccountCount = Math.max(0, Number(preview?.runnable_account_count || 0) || 0);
  if (missingManualKeyCount > 0 && retryableAutoKeyCount === 0 && runnableAccountCount === 0) return 'manual_key_unverified';
  if (!refs.length) return 'scheduler_no_targets';
  if (refs.every(schedulerRefIsUnscoped)) return 'scheduler_unscoped_targets';

  switch (String(preview?.detail || '').trim()) {
    case 'account_identity_scope_required':
    case 'ambiguous_account_refs':
    case 'ambiguous_group_refs':
      return 'scheduler_targets_need_review';
    case 'no_whitelisted_groups':
      return 'scheduler_no_targets';
    default:
      return '';
  }
}

function schedulerTargetPreviewFromEntries(settings = {}, accountEntries = [], { accounts = null, groupLookupComplete = true, failed = 0, missingManualKeyAccounts = [], identityScopeIssues = [], runnableAccountCount = null } = {}) {
  const allGroups = schedulerGroupUniverse(accountEntries);
  const accountUniverse = Array.isArray(accounts) && accounts.length ? accounts : accountEntries;
  const refs = schedulerTargetRefs(settings, accountUniverse);
  const accountCount = Array.isArray(accounts) ? accounts.length : (Array.isArray(accountEntries) ? accountEntries.length : 0);
  const allowUnscopedRefs = false;
  const unscopedRefCount = schedulerUnscopedRefCount(refs);
  const unscopedRefsIgnored = !allowUnscopedRefs && unscopedRefCount > 0;
  const missingAccountRefs = schedulerMissingAccountRefs(refs, accountUniverse);
  const missingAccountCleanup = schedulerMissingAccountCleanupPlan(settings, accountUniverse);
  const ambiguousAccountRefs = schedulerAmbiguousAccountRefs(refs, accountUniverse);
  const missingManualKeys = Array.isArray(missingManualKeyAccounts) ? missingManualKeyAccounts : [];
  const retryableAutoKeyCount = missingManualKeys.filter(item => item?.retryable_auto_scan === true).length;
  const identityIssues = Array.isArray(identityScopeIssues) ? identityScopeIssues : [];
  const ambiguousRefs = ambiguousSchedulerRefs(refs, allGroups);
  const targets = [];
  for (const { account, groups } of Array.isArray(accountEntries) ? accountEntries : []) {
    for (const group of selectScheduledGroups(groups, refs, account, { allGroups, allowUnscopedRefs })) {
      targets.push(schedulerItemIdentity(account, group));
    }
  }
  return {
    account_count: accountCount,
    readable_account_count: Array.isArray(accountEntries) ? accountEntries.length : 0,
    runnable_account_count: runnableAccountCount === null
      ? (Array.isArray(accountEntries) ? accountEntries.length : 0)
      : Math.max(0, Number(runnableAccountCount || 0) || 0),
    failed,
    group_lookup_complete: !!groupLookupComplete,
    ambiguous_refs: ambiguousRefs,
    ...(ambiguousAccountRefs.length ? {
      ambiguous_account_ref_count: ambiguousAccountRefs.length,
      ambiguous_account_refs: ambiguousAccountRefs.slice(0, 12),
    } : {}),
    ...(missingAccountRefs.length ? {
      missing_account_ref_count: missingAccountRefs.length,
      missing_account_refs: missingAccountRefs.slice(0, 12),
      missing_account_cleanup_ref_count: missingAccountCleanup.ref_count,
      missing_account_cleanup_scope_count: missingAccountCleanup.scopes.length,
      missing_account_cleanup_scopes: missingAccountCleanup.scopes.slice(0, 12),
      missing_account_cleanup_token: missingAccountCleanup.token,
    } : {}),
    ...(missingManualKeys.length ? {
      missing_manual_key_account_count: missingManualKeys.length,
      missing_manual_key_accounts: missingManualKeys.slice(0, 12),
      retryable_auto_key_account_count: retryableAutoKeyCount,
    } : {}),
    ...(identityIssues.length ? {
      identity_scope_issue_count: identityIssues.length,
      identity_scope_issues: identityIssues.slice(0, 12),
    } : {}),
    unscoped_ref_count: unscopedRefCount,
    unscoped_refs_ignored: unscopedRefsIgnored,
    target_count: targets.length,
    targets,
    detail: targets.length
      ? (identityIssues.length ? 'account_identity_scope_required' : (missingManualKeys.length ? (retryableAutoKeyCount ? 'auto_scan_cooldown' : 'manual_key_unverified') : (ambiguousAccountRefs.length ? 'ambiguous_account_refs' : (missingAccountRefs.length ? 'missing_account_refs' : (unscopedRefsIgnored ? 'unscoped_group_refs_ignored' : '')))))
      : (accountCount <= 0 ? 'no_accounts' : (identityIssues.length ? 'account_identity_scope_required' : (missingManualKeys.length ? (retryableAutoKeyCount ? 'auto_scan_cooldown' : 'manual_key_unverified') : (ambiguousAccountRefs.length ? 'ambiguous_account_refs' : (ambiguousRefs.length ? 'ambiguous_group_refs' : (missingAccountRefs.length ? 'missing_account_refs' : (unscopedRefsIgnored ? 'unscoped_group_refs_ignored' : failed ? 'group_lookup_failed' : 'no_whitelisted_groups'))))))),
  };
}

function groupRefAmbiguousAcrossAccounts(value, group = {}, account = {}, allGroups = []) {
  return groupRefAmbiguousInScope(value, group, account, allGroups);
}

function groupRefAmbiguousInScope(value, group = {}, account = {}, allGroups = [], { accountScoped = false } = {}) {
  const needle = String(value || '').trim();
  if (!needle || !Array.isArray(allGroups) || allGroups.length <= 1) return false;
  const matches = new Set();
  const currentAccountId = accountIdentity(account);
  for (const entry of allGroups) {
    const candidateAccount = entry?.account || {};
    const candidateGroup = entry?.group || entry || {};
    const candidateAccountId = accountIdentity(candidateAccount);
    if (accountScoped && candidateAccountId !== currentAccountId) continue;
    const candidateGroupId = String(candidateGroup.id || candidateGroup.group_id || '').trim();
    const candidateGroupName = String(candidateGroup.name || candidateGroup.group_name || '').trim();
    if (needle !== candidateGroupId && needle !== candidateGroupName) continue;
    matches.add(`${candidateAccountId}::${candidateGroupId || candidateGroupName}`);
  }
  if (matches.size <= 1) return false;
  const current = `${currentAccountId}::${String(group.id || group.group_id || group.name || group.group_name || '').trim()}`;
  return matches.has(current) || matches.size > 1;
}

function ambiguousSchedulerRefs(refs = [], allGroups = []) {
  if (!Array.isArray(refs) || !Array.isArray(allGroups) || allGroups.length <= 1) return [];
  const out = [];
  const seen = new Set();
  for (const ref of refs) {
    for (const candidate of schedulerRefAmbiguityCandidates(ref)) {
      const matches = matchingSchedulerGroupKeys(candidate.value, allGroups, { account_id: candidate.account_id });
      if (matches.length <= 1) continue;
      const key = `${candidate.account_id || '*'}:${candidate.value}:${matches.join('|')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ref: candidate.value, account_id: candidate.account_id || '', matches });
    }
  }
  return out.slice(0, 50);
}

function schedulerRefAmbiguityCandidates(ref) {
  if (typeof ref === 'string') {
    const value = ref.trim();
    return value ? [{ value, account_id: '' }] : [];
  }
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return [];
  const accountId = String(ref.account_id || ref.account || '').trim();
  const groupId = String(ref.group_id || ref.id || '').trim();
  if (groupId) return accountId ? [] : [{ value: groupId, account_id: '' }];
  return [ref.group_name, ref.name, ref.group]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .map(value => ({ value, account_id: accountId }));
}

function matchingSchedulerGroupKeys(value, allGroups = [], { account_id = '' } = {}) {
  const needle = String(value || '').trim();
  const accountScope = String(account_id || '').trim();
  if (!needle) return [];
  const scopedResolution = accountScope
    ? resolveSchedulerAccountScope(accountScope, schedulerAccountsFromGroups(allGroups))
    : null;
  if (accountScope && scopedResolution?.status !== 'matched') return [];
  const matches = new Set();
  for (const entry of allGroups) {
    const account = entry?.account || {};
    const group = entry?.group || entry || {};
    const candidateAccountId = accountIdentity(account);
    if (accountScope && candidateAccountId !== scopedResolution.account_id) continue;
    const groupId = String(group.id || group.group_id || '').trim();
    const groupName = String(group.name || group.group_name || '').trim();
    if (needle !== groupId && needle !== groupName) continue;
    matches.add(`${candidateAccountId}::${groupId || groupName}`);
  }
  return [...matches].sort();
}

function schedulerWindow(value, now = new Date()) {
  const ms = durationToMs(value) || durationToMs('4h');
  return {
    since: formatLocalDateTime(new Date(now.getTime() - ms), { includeSeconds: true }),
    until: formatLocalDateTime(now, { includeSeconds: true }),
  };
}

function schedulerWindowWithLateSyncGrace(window = {}, cursorState = {}) {
  const since = parseCursorWindowTime(window.since);
  if (!since) return window;
  const hasBaseline = !!String(cursorState.last_seq || '').trim()
    || (Array.isArray(cursorState.seen) && cursorState.seen.length > 0)
    || !!String(cursorState.scheduled_window_until || cursorState.window_until || '').trim();
  if (!hasBaseline) return window;
  const previousUntil = parseCursorWindowTime(cursorState.scheduled_window_until || cursorState.window_until);
  const coverageAnchorMs = previousUntil
    ? Math.min(since.getTime(), previousUntil.getTime())
    : since.getTime();
  const nextSince = coverageAnchorMs - SCHEDULER_LATE_SYNC_LOOKBACK_MS;
  return {
    ...window,
    since: formatLocalDateTime(new Date(nextSince), { includeSeconds: true }),
    scheduled_since: window.since || '',
    late_sync_grace_minutes: Math.round(SCHEDULER_LATE_SYNC_GRACE_MS / 60000),
    late_sync_lookback_hours: Math.round(SCHEDULER_LATE_SYNC_LOOKBACK_MS / 3600000),
  };
}

function latestMessageCursor(messages = []) {
  const latest = [...messages].sort((a, b) => compareMessageCursor(b, a))[0];
  return latest ? messageCursor(latest) : '';
}

function messageCursor(message = {}) {
  const timestamp = normalizeCursorNumber(message.timestamp);
  const sortSeq = normalizeCursorIntegerText(message.sort_seq);
  const localId = normalizeCursorNumber(message.local_id);
  const serverId = cursorComponent(message.server_id);
  const messageId = cursorComponent(message.id);
  const parts = [
    timestamp ? `ts.${timestamp}` : '',
    sortSeq ? `seq.${sortSeq}` : '',
    localId ? `lid.${localId}` : '',
    serverId ? `sid.${serverId}` : '',
    messageId ? `id.${messageId}` : '',
  ].filter(Boolean);
  return parts.join(':') || cursorComponent(message.server_id || message.local_id || message.timestamp);
}

function messagesAfterCursor(messages = [], previousCursor = '') {
  const text = String(previousCursor || '').trim();
  if (!text) return Array.isArray(messages) ? messages : [];
  const cursor = cursorObjectFromValue(text);
  // Older cursor stores and manual edits may contain small local ids such as
  // "300". Treat an unparseable cursor as missing instead of silently skipping
  // every message in the current window.
  if (!cursor) return Array.isArray(messages) ? messages : [];
  return (Array.isArray(messages) ? messages : []).filter(message => {
    const current = messageCursor(message);
    if (current && current === text) return false;
    if (cursorHasOnlyTimestamp(cursor)) return normalizeCursorNumber(message.timestamp) > cursor.timestamp;
    return compareMessageCursor(message, cursor) > 0;
  });
}

function cursorHasOnlyTimestamp(cursor = {}) {
  return !!cursor.timestamp && !cursor.sort_seq && !cursor.local_id && !cursor.server_id && !cursor.id;
}

function messagesNotSeen(messages = [], seen = new Set()) {
  return (Array.isArray(messages) ? messages : []).filter(message => !seen.has(messageIdentity(message)));
}

function newMessagesForCursorState(messages = [], cursorState = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const previousCursor = cursorState.last_seq || '';
  const previousSeen = new Set(Array.isArray(cursorState.seen) ? cursorState.seen : []);
  const incremental = messagesNotSeen(list.filter(message => message?.late_sync_incremental === true), previousSeen);
  const incrementalKeys = new Set(incremental.map(messageIdentity).filter(Boolean));
  const afterCursor = messagesAfterCursor(list, previousCursor).filter(message => !incrementalKeys.has(messageIdentity(message)));
  if (!previousSeen.size) return [...incremental, ...afterCursor].sort(compareMessageCursor);
  const fresh = messagesNotSeen(afterCursor, previousSeen);
  const freshKeys = new Set(fresh.map(messageIdentity).filter(Boolean));
  const late = messagesNotSeen(messagesWithinCursorWindow(list, cursorState), previousSeen)
    .filter(message => {
      const key = messageIdentity(message);
      return key && !freshKeys.has(key) && !incrementalKeys.has(key);
    });
  return [...incremental, ...late, ...fresh].sort(compareMessageCursor);
}

function messagesWithinCursorWindow(messages = [], cursorState = {}) {
  const since = parseCursorWindowTime(cursorState.window_since);
  const until = parseCursorWindowTime(cursorState.window_until);
  if (!since && !until) return Array.isArray(messages) ? messages : [];
  return (Array.isArray(messages) ? messages : []).filter(message => {
    const time = normalizeCursorNumber(message.timestamp);
    if (!time) return false;
    if (since && time < since.getTime()) return false;
    if (until && time > until.getTime()) return false;
    return true;
  });
}

function schedulerCursorStateWithCollectionWindow(cursorState = {}, window = {}) {
  const state = normalizeSchedulerCursorState(cursorState);
  const stateSince = parseCursorWindowTime(state.window_since);
  const stateUntil = parseCursorWindowTime(state.window_until);
  const collectionSince = parseCursorWindowTime(window.since);
  const collectionUntil = parseCursorWindowTime(window.until);
  const sinceValues = [stateSince, collectionSince]
    .filter(Boolean)
    .map(date => date.getTime());
  const untilValues = [stateUntil, collectionUntil]
    .filter(Boolean)
    .map(date => date.getTime());
  return {
    ...state,
    window_since: sinceValues.length
      ? formatLocalDateTime(new Date(Math.min(...sinceValues)), { includeSeconds: true })
      : state.window_since,
    window_until: untilValues.length
      ? formatLocalDateTime(new Date(Math.max(...untilValues)), { includeSeconds: true })
      : state.window_until,
  };
}

function schedulerCursorState({ cursor, messages = [], previousState = {}, window = {}, scheduledWindow = null, ruleFingerprint = '', replaceSeenWindow = false, seenWindow = null, shardRowPositions = null, shardRowPositionsInitialized = false } = {}) {
  const previous = normalizeSchedulerCursorState(previousState);
  const candidateCursor = cursor || latestMessageCursor(messages);
  const currentSeen = Array.isArray(seenWindow) ? normalizeSchedulerSeenList(seenWindow) : messageIdentityList(messages);
  const nextSeen = replaceSeenWindow
    ? currentSeen
    : normalizeSchedulerSeenList([...previous.seen, ...currentSeen]);
  return {
    last_seq: laterCursorValue(previous.last_seq, candidateCursor),
    seen: nextSeen,
    window_since: replaceSeenWindow ? (window.since || '') : earliestCursorWindowValue(previous.window_since, window.since),
    window_until: replaceSeenWindow ? (window.until || '') : latestCursorWindowValue(previous.window_until, window.until),
    scheduled_window_since: scheduledWindow?.since || window.scheduled_since || window.since || '',
    scheduled_window_until: scheduledWindow?.until || window.until || '',
    late_sync_grace_minutes: Math.round(SCHEDULER_LATE_SYNC_GRACE_MS / 60000),
    late_sync_lookback_hours: Math.round(SCHEDULER_LATE_SYNC_LOOKBACK_MS / 3600000),
    shard_row_positions_initialized: shardRowPositionsInitialized === true || previous.shard_row_positions_initialized === true,
    shard_row_positions: shardRowPositions && typeof shardRowPositions === 'object'
      ? normalizeSchedulerShardRowPositions(shardRowPositions)
      : previous.shard_row_positions,
    rule_fingerprint: ruleFingerprint,
    message_count: Array.isArray(messages) ? messages.length : 0,
  };
}

function laterCursorValue(previousValue = '', candidateValue = '') {
  const previous = String(previousValue || '').trim();
  const candidate = String(candidateValue || '').trim();
  if (!previous) return candidate;
  if (!candidate) return previous;
  const previousCursor = cursorObjectFromValue(previous);
  const candidateCursor = cursorObjectFromValue(candidate);
  if (!previousCursor) return candidate;
  if (!candidateCursor) return previous;
  return compareMessageCursor(candidateCursor, previousCursor) > 0 ? candidate : previous;
}

function earliestCursorWindowValue(previousValue = '', candidateValue = '') {
  const previous = parseCursorWindowTime(previousValue);
  const candidate = parseCursorWindowTime(candidateValue);
  if (!previous) return candidateValue || '';
  if (!candidate) return previousValue || '';
  return previous.getTime() <= candidate.getTime() ? previousValue : candidateValue;
}

function latestCursorWindowValue(previousValue = '', candidateValue = '') {
  const previous = parseCursorWindowTime(previousValue);
  const candidate = parseCursorWindowTime(candidateValue);
  if (!previous) return candidateValue || '';
  if (!candidate) return previousValue || '';
  return previous.getTime() >= candidate.getTime() ? previousValue : candidateValue;
}

function schedulerCheckedWindowState({ cursorState = {}, window = {}, scheduledWindow = null, ruleFingerprint = '', shardRowPositions = null, shardRowPositionsInitialized = false } = {}) {
  const previous = normalizeSchedulerCursorState(cursorState);
  const keepCursorWindow = !!previous.last_seq
    && previous.seen.length > 0
    && !!(previous.window_since || previous.window_until);
  return {
    ...previous,
    window_since: keepCursorWindow ? previous.window_since : (window.since || ''),
    window_until: keepCursorWindow ? previous.window_until : (window.until || ''),
    scheduled_window_since: scheduledWindow?.since || window.scheduled_since || window.since || '',
    scheduled_window_until: scheduledWindow?.until || window.until || '',
    late_sync_grace_minutes: Math.round(SCHEDULER_LATE_SYNC_GRACE_MS / 60000),
    late_sync_lookback_hours: Math.round(SCHEDULER_LATE_SYNC_LOOKBACK_MS / 3600000),
    shard_row_positions_initialized: shardRowPositionsInitialized === true || previous.shard_row_positions_initialized === true,
    shard_row_positions: shardRowPositions && typeof shardRowPositions === 'object'
      ? normalizeSchedulerShardRowPositions(shardRowPositions)
      : previous.shard_row_positions,
    rule_fingerprint: ruleFingerprint,
    message_count: 0,
  };
}

function normalizeSchedulerCursorState(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    last_seq: String(source.last_seq || source.lastSeq || source.cursor || source.latest_cursor || '').trim(),
    seen: normalizeSchedulerSeenList(source.seen),
    window_since: String(source.window_since || '').trim(),
    window_until: String(source.window_until || '').trim(),
    scheduled_window_since: String(source.scheduled_window_since || '').trim(),
    scheduled_window_until: String(source.scheduled_window_until || '').trim(),
    late_sync_grace_minutes: Math.max(0, Math.trunc(Number(source.late_sync_grace_minutes || 0)) || 0),
    late_sync_lookback_hours: Math.max(0, Math.trunc(Number(source.late_sync_lookback_hours || 0)) || 0),
    shard_row_positions_initialized: source.shard_row_positions_initialized === true,
    shard_row_positions: normalizeSchedulerShardRowPositions(source.shard_row_positions),
    rule_fingerprint: String(source.rule_fingerprint || '').trim(),
    message_count: Math.max(0, Math.trunc(Number(source.message_count || 0)) || 0),
  };
}

function schedulerCursorStatesEqual(left = {}, right = {}) {
  const comparable = value => {
    const state = normalizeSchedulerCursorState(value);
    return {
      ...state,
      seen: [...state.seen].sort(),
      shard_row_positions: Object.fromEntries(Object.entries(state.shard_row_positions).sort(([a], [b]) => a.localeCompare(b))),
    };
  };
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

function normalizeSchedulerShardRowPositions(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value);
  if (entries.length > MAX_MESSAGE_SHARD_CURSOR_POSITIONS) {
    throw Object.assign(new Error(`发现 ${entries.length} 个微信消息分片，超过当前可完整持久化增量游标的 ${MAX_MESSAGE_SHARD_CURSOR_POSITIONS} 个上限。已停止推进游标，避免静默漏掉后续分片。`), {
      status: 409,
      code: 'wxdb_message_shard_limit_exceeded',
      public_code: 'wxdb_message_shard_limit_exceeded',
      wxdb_diagnostics: {
        message_shard_count: entries.length,
        message_shard_limit: MAX_MESSAGE_SHARD_CURSOR_POSITIONS,
      },
    });
  }
  const out = {};
  for (const [name, position] of entries) {
    const key = String(name || '').trim().toLowerCase();
    const normalized = normalizeMessageShardCursorPosition(position);
    if (!isMessageShardCursorKey(key) || normalized === null) {
      throw Object.assign(new Error(`${key || '消息分片'} 的增量水位格式无效，已停止推进调度游标。`), {
        status: 409,
        code: 'wxdb_message_shard_position_invalid',
        public_code: 'wxdb_message_shard_position_invalid',
      });
    }
    if (Object.hasOwn(out, key)) {
      throw Object.assign(new Error(`${key} 的增量水位重复，已停止推进调度游标。`), {
        status: 409,
        code: 'wxdb_message_shard_position_invalid',
        public_code: 'wxdb_message_shard_position_invalid',
      });
    }
    out[key] = normalized;
  }
  return out;
}

function messageIdentityList(messages = []) {
  const ordered = [...(Array.isArray(messages) ? messages : [])].sort(compareMessageCursor);
  return normalizeSchedulerSeenList(ordered.map(messageIdentity));
}

function normalizeSchedulerSeenList(values = []) {
  const seen = [...new Set((Array.isArray(values) ? values : []).map(item => String(item || '').trim()).filter(Boolean))];
  assertCursorSeenListFits(seen);
  return seen;
}

function messageIdentity(message = {}) {
  const raw = JSON.stringify([
    normalizeCursorNumber(message.timestamp),
    normalizeCursorIntegerText(message.sort_seq),
    normalizeCursorNumber(message.local_id),
    String(message.server_id || ''),
    String(message.id || ''),
    String(message.sender || ''),
    String(message.type || ''),
    String(message.content || '').slice(0, 500),
  ]);
  return `m.${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24)}`;
}

function cursorObjectFromValue(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const n = normalizeCursorNumber(text);
    if (n >= 946684800000) return { timestamp: n };
    if (n >= 946684800) return { timestamp: n * 1000 };
    return null;
  }
  const out = {};
  const partPattern = /(?:^|:)(ts|seq|lid|sid|id)\.([\s\S]*?)(?=:(?:ts|seq|lid|sid|id)\.|$)/g;
  for (const match of text.matchAll(partPattern)) {
    const [, key, raw] = match;
    if (!key || !raw) continue;
    if (key === 'ts') out.timestamp = normalizeCursorNumber(raw);
    else if (key === 'seq') out.sort_seq = normalizeCursorIntegerText(raw);
    else if (key === 'lid') out.local_id = normalizeCursorNumber(raw);
    else if (key === 'sid') out.server_id = decodeCursorComponent(raw);
    else if (key === 'id') out.id = decodeCursorComponent(raw);
  }
  return Object.keys(out).length ? out : null;
}

function compareMessageCursor(a = {}, b = {}) {
  return normalizeCursorNumber(a.timestamp) - normalizeCursorNumber(b.timestamp)
    || compareCursorIntegers(a.sort_seq, b.sort_seq)
    || normalizeCursorNumber(a.local_id) - normalizeCursorNumber(b.local_id)
    || String(a.id || a.server_id || '').localeCompare(String(b.id || b.server_id || ''));
}

function normalizeCursorIntegerText(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return '';
  try { return BigInt(text).toString(); } catch { return ''; }
}

function compareCursorIntegers(left, right) {
  const a = normalizeCursorIntegerText(left) || '0';
  const b = normalizeCursorIntegerText(right) || '0';
  try {
    const leftValue = BigInt(a);
    const rightValue = BigInt(b);
    return leftValue < rightValue ? -1 : (leftValue > rightValue ? 1 : 0);
  } catch {
    return a.localeCompare(b);
  }
}

function normalizeCursorNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function cursorComponent(value) {
  const text = String(value || '')
    .trim()
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 120);
  return text ? encodeURIComponent(text) : '';
}

function decodeCursorComponent(value) {
  const text = String(value || '');
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function sleep(ms, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : schedulerAbortError());
      return;
    }
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, signal.reason instanceof Error ? signal.reason : schedulerAbortError());
    timer = setTimeout(() => finish(resolve), Math.max(0, Number(ms || 0)));
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function formatLocalDateTime(date, { includeSeconds = false } = {}) {
  const p = n => String(n).padStart(2, '0');
  const base = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
  return includeSeconds ? `${base}:${p(date.getSeconds())}` : base;
}

function parseCursorWindowTime(value = '') {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s = '0'] = match;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), 0);
  const valid = !Number.isNaN(date.getTime())
    && date.getFullYear() === Number(y)
    && date.getMonth() === Number(mo) - 1
    && date.getDate() === Number(d)
    && date.getHours() === Number(h)
    && date.getMinutes() === Number(mi)
    && date.getSeconds() === Number(s);
  return valid ? date : null;
}

export const __schedulerInternals = {
  queueSchedulerLifecycle,
  withSchedulerLifecycleTransition,
  runSchedulerTimerCycle,
  withSchedulerRuntimeStateLock,
  tryAcquireSchedulerRunLease,
  releaseSchedulerRunLease,
  schedulerGenerationValue: () => schedulerGeneration,
  applySchedulerRuntimePersistenceResult,
  markSchedulerRuntimeBlocked,
  schedulerTerminalShutdownActive: () => schedulerTerminalShutdown,
  schedulerCancelledRunResult,
  schedulerSaveFailureMayHaveCommittedOutput,
  schedulerCursorStatesEqual,
  schedulerWindow,
  schedulerWindowWithLateSyncGrace,
  selectScheduledGroups,
  latestMessageCursor,
  messagesAfterCursor,
  messagesNotSeen,
  messagesWithinCursorWindow,
  newMessagesForCursorState,
  schedulerErrorLooksAutoKeyFailure,
  normalizeSchedulerShardRowPositions,
  messageIdentity,
  schedulerCursorState,
  schedulerCursorStateWithCollectionWindow,
  schedulerCheckedWindowState,
  accountIdentity,
  accountCursorIdentity,
  schedulerAccountReadIdentity,
  schedulerAccountReadIdentityMatches,
  accountCursorLegacyIdentities,
  accountCursorLegacyStorageIdentities,
  resolveSchedulerAccountScope,
  schedulerItemIdentity,
  groupCursorKey,
  schedulerRuleFingerprint,
  schedulerCursorRuleFingerprintChanged,
  schedulerCursorStateForCurrentRule,
  backupInvalidSchedulerPendingCursorFile,
  schedulerPendingCursorStorePayload,
  schedulerPendingOutputBase,
  schedulerPendingCursorStoreMaxBytes: SCHEDULER_PENDING_CURSOR_MAX_BYTES,
  schedulerIdentityScopePartition,
  schedulerTrustedTargetSettings,
  schedulerManualKeyReadinessFromTargets,
  schedulerManualKeyTargetReadiness,
  shouldSkipUnchangedCursor,
  schedulerOverrideForGroup,
  schedulerAccountsForTargetRefs,
  schedulerTargetRefKey,
  schedulerTargetRefs,
  schedulerAutoScanCanAttempt,
  schedulerAutoKeyFailureStorePayload,
  schedulerAutoKeyFailureStoreMaxBytes: SCHEDULER_AUTO_KEY_FAILURE_MAX_BYTES,
  schedulerAutoKeyFailureCooldownState,
  schedulerAutoKeyFailureTtlMs: SCHEDULER_AUTO_KEY_FAILURE_TTL_MS,
  schedulerRuntimeStatePayload,
  schedulerPersistedNextDelay,
  schedulerRuntimeRevision,
  schedulerRuntimeStateMaxBytes: SCHEDULER_RUNTIME_STATE_MAX_BYTES,
  schedulerResultRetryAfterMs,
  schedulerNextDelayAfterResult,
  schedulerAutoKeyFailureMatchesAccount,
  schedulerMissingManualKeyTargetAccounts,
  schedulerAmbiguousAccountRefs,
  schedulerMissingAccountCleanupPlan,
  groupRefMatches,
  groupRefMatchScore,
  ambiguousSchedulerRefs,
  matchingSchedulerGroupKeys,
  schedulerCursorStateForGroup,
  legacyCursorSafeForGroup,
  schedulerTargetAutoPauseReason,
  schedulerTargetPreviewFromEntries,
  schedulerResultStaleForRevision,
  schedulerMirrorReadinessContext,
  rememberSchedulerMirrorReadiness,
  clearSchedulerMirrorReadinessForError,
  schedulerEmptyCollectionStillUnsafeAfterMirrorRecheck,
  schedulerAbortError,
  throwIfSchedulerAborted,
};
