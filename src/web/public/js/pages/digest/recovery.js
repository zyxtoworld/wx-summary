// 中断批次恢复:使用 version 5 持久化记录(localStorage),
// 跨标签页用 Web Locks(navigator.locks)防止重复恢复。
import { isMutationOutcomeUnknown } from '/js/api.js';
import { createCrossTabTaskRunner } from '/js/shared/cross-tab-task-runner.js';
import {
  digestRenderSelectionFromSaved,
  normalizeDigestFontSize,
  normalizeDigestTheme,
  normalizeDigestAccentColor,
} from './render-selection.js';

export function interruptedDigestBatchStorageKey(origin = globalThis.location?.origin || '') {
  return `wx-summary:interrupted-digest-batch:${String(origin || '').trim()}`;
}

const STORAGE_KEY = interruptedDigestBatchStorageKey();
const RECORD_VERSION = 5;
const MAX_RECORDS = 8;
const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 与服务端 DIGEST_BATCH_RECOVERY_TTL_MS 对齐
export const DIGEST_RECOVERY_CLAIM_TTL_MS = 2 * 60 * 1000;
const RECOVERY_CLAIM_VERSION = 1;

function recoveryStorageUnavailableError(cause = null) {
  const error = new Error('本地摘要恢复记录无法读取或清理;请允许本站使用本地存储后重试。', {
    cause: cause instanceof Error ? cause : undefined,
  });
  error.code = 'digest_recovery_storage_unavailable';
  error.status = 507;
  return error;
}

function recordStoragePrefix(storageKey = STORAGE_KEY) {
  return `${storageKey}:record:`;
}

function recordStorageKey(batchId, storageKey = STORAGE_KEY) {
  const cleanBatchId = String(batchId || '').trim();
  return cleanBatchId ? `${recordStoragePrefix(storageKey)}${encodeURIComponent(cleanBatchId)}` : '';
}

function recoveryClaimStorageKey(batchId, storageKey = STORAGE_KEY) {
  const cleanBatchId = String(batchId || '').trim();
  return cleanBatchId ? `${storageKey}:claim:${encodeURIComponent(cleanBatchId)}` : '';
}

function createRecoveryClaimId() {
  const bytes = new Uint8Array(12);
  try { globalThis.crypto?.getRandomValues?.(bytes); } catch {}
  const random = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `recovery_${Date.now().toString(36)}_${random || Math.random().toString(36).slice(2, 18)}`;
}

function readRecoveryClaim(storage, key, now, ttlMs) {
  if (typeof storage?.getItem !== 'function') {
    throw recoveryStorageUnavailableError(new Error('localStorage unavailable'));
  }
  let raw = null;
  try { raw = storage.getItem(key) || null; }
  catch (error) { throw recoveryStorageUnavailableError(error); }
  if (!raw) return null;
  let parsed = null;
  try { parsed = JSON.parse(raw); }
  catch (error) {
    if (typeof storage?.removeItem !== 'function') {
      throw recoveryStorageUnavailableError(new Error('localStorage unavailable'));
    }
    try { storage.removeItem(key); }
    catch (removeError) { throw recoveryStorageUnavailableError(removeError); }
    return null;
  }
  const updatedAt = Number(parsed?.updated_at);
  const ownerId = String(parsed?.owner_id || '').trim();
  const batchId = String(parsed?.batch_id || '').trim();
  if (Number(parsed?.version) !== RECOVERY_CLAIM_VERSION
      || !batchId
      || !ownerId
      || !Number.isFinite(updatedAt)
      || updatedAt <= 0) {
    if (typeof storage?.removeItem !== 'function') {
      throw recoveryStorageUnavailableError(new Error('localStorage unavailable'));
    }
    try { storage.removeItem(key); }
    catch (error) { throw recoveryStorageUnavailableError(error); }
    return null;
  }
  if (now - updatedAt > ttlMs) return null;
  return { version: RECOVERY_CLAIM_VERSION, batch_id: batchId, owner_id: ownerId, updated_at: updatedAt };
}

function writeRecoveryClaim(storage, key, batchId, ownerId, now) {
  if (typeof storage?.setItem !== 'function') {
    throw recoveryStorageUnavailableError(new Error('localStorage unavailable'));
  }
  try {
    storage.setItem(key, JSON.stringify({
      version: RECOVERY_CLAIM_VERSION,
      batch_id: String(batchId || '').trim(),
      owner_id: ownerId,
      updated_at: now,
    }));
  } catch (error) {
    throw recoveryStorageUnavailableError(error);
  }
}

function removeRecoveryClaimIfOwned(storage, key, ownerId) {
  if (typeof storage?.removeItem !== 'function') return false;
  try {
    const current = readRecoveryClaim(storage, key, Date.now(), Number.POSITIVE_INFINITY);
    if (current?.owner_id !== ownerId) return false;
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function normalizeServiceInstanceId(value = '') {
  const id = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{16,128}$/.test(id) ? id : '';
}

function normalizeTargets(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const groupId = String(item?.group_id || item?.id || '').trim();
    if (!groupId) continue;
    out.push({
      group_id: groupId,
      group_name: String(item?.group_name || item?.name || '').trim().slice(0, 240),
      since: String(item?.since || '').trim().slice(0, 32),
      until: String(item?.until || '').trim().slice(0, 32),
    });
    if (out.length >= 200) break;
  }
  return out;
}

function normalizeResultRange(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const key = String(value.key || '').trim().slice(0, 40);
  const since = String(value.since || '').trim().slice(0, 80);
  const until = String(value.until || '').trim().slice(0, 80);
  if (!key || !since || !until) return null;
  return { key, since, until, dynamic: value.dynamic === true };
}

function normalizeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const batchId = String(value.batch_id || '').trim();
  const batchToken = String(value.batch_token || '').trim();
  const accountId = String(value.account_id || '').trim();
  const accountFingerprint = String(value.account_fingerprint || '').trim().toLowerCase();
  const startedAt = Math.max(0, Number(value.started_at || 0) || 0);
  const updatedAt = Math.max(startedAt, Number(value.updated_at || 0) || startedAt);
  if (!/^[a-zA-Z0-9_.:-]{8,80}$/.test(batchId)
      || !/^[a-zA-Z0-9_.:-]{16,256}$/.test(batchToken)
      || !accountId
      || !startedAt
      || !/^[a-f0-9]{64}$/.test(accountFingerprint)
      || Date.now() - updatedAt > MAX_AGE_MS) return null;
  const targets = normalizeTargets(value.targets);
  const rawRender = value.render && typeof value.render === 'object' && !Array.isArray(value.render)
    ? value.render
    : {};
  const resultInputKey = typeof value.result_input_key === 'string'
    ? value.result_input_key.slice(0, 2048)
    : '';
  const resultRuntimeVersion = value.result_runtime_version === null || value.result_runtime_version === undefined
    ? null
    : Number.isSafeInteger(Number(value.result_runtime_version)) && Number(value.result_runtime_version) >= 0
      ? Number(value.result_runtime_version)
      : null;
  return {
    version: RECORD_VERSION,
    batch_id: batchId,
    batch_token: batchToken,
    service_instance_id: normalizeServiceInstanceId(value.service_instance_id || ''),
    account_id: accountId,
    account_fingerprint: accountFingerprint,
    preview_text: value.preview_text === true,
    batch_total: Math.max(0, Math.trunc(Number(value.batch_total || 0)) || targets.length),
    batch_index: Math.max(-1, Math.trunc(Number(value.batch_index ?? -1))),
    current_group: String(value.current_group || '').trim().slice(0, 240),
    current_group_id: String(value.current_group_id || '').trim().slice(0, 240),
    phase: String(value.phase || '').trim().slice(0, 80),
    targets,
    render: {
      theme: normalizeDigestTheme(rawRender.theme),
      fontSize: normalizeDigestFontSize(rawRender.fontSize || rawRender.font_size || rawRender.fontsize),
      accentColor: normalizeDigestAccentColor(rawRender.accentColor || rawRender.accent_color),
    },
    result_input_key: resultInputKey,
    result_range: normalizeResultRange(value.result_range),
    result_runtime_version: resultRuntimeVersion,
    started_at: startedAt,
    updated_at: updatedAt,
  };
}

export function interruptedDigestBatchMatchesAccount(record, identity = {}) {
  const accountId = String(identity?.accountId || identity?.account_id || '').trim();
  const accountFingerprint = String(
    identity?.accountFingerprint || identity?.account_fingerprint || '',
  ).trim().toLowerCase();
  if (!accountId || !/^[a-f0-9]{64}$/.test(accountFingerprint)) return false;
  return String(record?.account_id || '').trim() === accountId
    && String(record?.account_fingerprint || '').trim().toLowerCase() === accountFingerprint;
}

// 恢复请求可能跨越账号上下文变化;只有原 action、页面和记录身份都仍匹配时才能提交结果。
export function createDigestRecoveryOwner({
  action = null,
  isCurrentAction = () => false,
  getIdentity = () => null,
  record = null,
  isDestroyed = () => false,
} = {}) {
  return {
    isCurrent() {
      try {
        return !!action
          && !isDestroyed()
          && isCurrentAction(action)
          && interruptedDigestBatchMatchesAccount(record, getIdentity());
      } catch {
        return false;
      }
    },
  };
}

export function selectInterruptedDigestBatchRecord(records, identity, batchId = '') {
  const expectedBatchId = String(batchId || '').trim();
  return (Array.isArray(records) ? records : []).find(record => {
    if (expectedBatchId && String(record?.batch_id || '').trim() !== expectedBatchId) return false;
    return interruptedDigestBatchMatchesAccount(record, identity);
  }) || null;
}

export function digestTerminalResultRequest(record = {}, item = {}) {
  const source = record && typeof record === 'object' ? record : {};
  const terminal = item && typeof item === 'object' ? item : {};
  return {
    batch_id: String(source.batch_id || '').trim(),
    batch_token: String(source.batch_token || '').trim(),
    service_instance_id: String(source.service_instance_id || '').trim(),
    batch_index: Math.max(0, Math.trunc(Number(terminal.batch_index ?? 0)) || 0),
    batch_total: Math.max(0, Math.trunc(Number(terminal.batch_total || source.batch_total || 0)) || 0),
    account_id: String(terminal.account_id || source.account_id || '').trim(),
    expected_account_fingerprint: String(source.account_fingerprint || '').trim().toLowerCase(),
    group_id: String(terminal.group_id || '').trim(),
  };
}

export function requireDigestTerminalResult(payload) {
  const validPayload = payload && typeof payload === 'object' && !Array.isArray(payload);
  const status = validPayload ? String(payload.status || '').trim() : '';
  let valid = status === 'pending' || status === 'missing';
  if (status === 'done') {
    valid = payload.digest
      && typeof payload.digest === 'object'
      && !Array.isArray(payload.digest)
      && String(payload.digest.digest_id || '').trim();
  } else if (status === 'saved') {
    valid = payload.item
      && typeof payload.item === 'object'
      && !Array.isArray(payload.item)
      && String(payload.item.digest_id || '').trim();
  } else if (status === 'error' || status === 'skipped') {
    valid = payload.error && typeof payload.error === 'object' && !Array.isArray(payload.error);
  }
  if (!valid) {
    const error = new Error('摘要终态响应格式无效，请稍后重试恢复。');
    error.status = 502;
    error.code = 'digest_terminal_result_response_invalid';
    throw error;
  }
  return payload;
}

export function digestTerminalRecoveryMetadata(value = {}) {
  if (value?.terminal_recovery_persisted !== false) return {};
  return {
    terminal_recovery_persisted: false,
    ...(value.terminal_recovery_code ? { terminal_recovery_code: value.terminal_recovery_code } : {}),
    ...(value.terminal_recovery_message ? { terminal_recovery_message: value.terminal_recovery_message } : {}),
  };
}

export function interruptedDigestRenderSelection(record = {}, fallback = {}) {
  return digestRenderSelectionFromSaved(record?.render, fallback);
}

export function subscribeInterruptedDigestRecoveryChanges({
  storageTarget = globalThis.window,
  storageKey = interruptedDigestBatchStorageKey(),
  subscribeAccount = null,
  onChange,
} = {}) {
  if (typeof onChange !== 'function') throw new Error('摘要恢复变化处理器无效');
  let disposed = false;
  const recordPrefix = recordStoragePrefix(storageKey);
  const claimPrefix = `${storageKey}:claim:`;
  const notify = source => {
    if (!disposed) onChange(source);
  };
  const onStorage = event => {
    if (event?.key === null
      || event?.key === storageKey
      || String(event?.key || '').startsWith(recordPrefix)
      || String(event?.key || '').startsWith(claimPrefix)) notify('storage');
  };
  storageTarget?.addEventListener?.('storage', onStorage);
  const unsubscribeAccount = typeof subscribeAccount === 'function'
    ? subscribeAccount(() => notify('account'))
    : null;

  return () => {
    if (disposed) return;
    disposed = true;
    storageTarget?.removeEventListener?.('storage', onStorage);
    try { unsubscribeAccount?.(); } catch {}
  };
}

function readLegacyRecords(storage) {
  let raw = '';
  try { raw = storage?.getItem?.(STORAGE_KEY) || ''; }
  catch (error) { throw recoveryStorageUnavailableError(error); }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Number(parsed?.version || 0) !== RECORD_VERSION) throw new Error('stale schema');
    const values = Array.isArray(parsed?.records) ? parsed.records : [];
    return values.map(normalizeRecord).filter(Boolean);
  } catch {
    try { storage?.removeItem?.(STORAGE_KEY); }
    catch (error) { throw recoveryStorageUnavailableError(error); }
    return [];
  }
}

function readRecordOverrides(storage, overrides) {
  const prefix = recordStoragePrefix();
  let keys = [];
  try {
    if (typeof storage?.length !== 'number' || typeof storage?.key !== 'function') return;
    for (let index = 0; index < storage.length; index += 1) {
      const key = String(storage.key(index) || '');
      if (key.startsWith(prefix)) keys.push(key);
    }
  } catch {
    throw recoveryStorageUnavailableError();
  }
  for (const key of keys) {
    const removeKey = () => {
      try { storage?.removeItem?.(key); }
      catch (error) { throw recoveryStorageUnavailableError(error); }
    };
    let raw = null;
    try { raw = storage.getItem(key); }
    catch (error) { throw recoveryStorageUnavailableError(error); }
    let parsed = null;
    try { parsed = JSON.parse(raw || 'null'); }
    catch {
      removeKey();
      continue;
    }
    if (Number(parsed?.version) !== RECORD_VERSION) {
      removeKey();
      continue;
    }
    const deletedBatchId = String(parsed?.batch_id || '').trim();
    if (parsed?.deleted === true && deletedBatchId) {
      const deletedAt = Number(parsed?.updated_at);
      if (!Number.isFinite(deletedAt)
        || deletedAt <= 0
        || Date.now() - deletedAt > MAX_AGE_MS) {
        removeKey();
        continue;
      }
      overrides.set(deletedBatchId, { deleted: true });
      continue;
    }
    const record = normalizeRecord(parsed?.record);
    if (!record) {
      removeKey();
      continue;
    }
    overrides.set(record.batch_id, { record });
  }
}

export function readInterruptedDigestBatchRecords() {
  const byBatchId = new Map();
  for (const record of readLegacyRecords(localStorage)) byBatchId.set(record.batch_id, record);
  if (!byBatchId.size) {
    for (const record of readLegacyRecords(sessionStorage)) byBatchId.set(record.batch_id, record);
  }

  // 新写入按 batch 独立占有 key; sessionStorage 先读, localStorage 覆盖它。
  const overrides = new Map();
  readRecordOverrides(sessionStorage, overrides);
  readRecordOverrides(localStorage, overrides);
  for (const [batchId, override] of overrides) {
    if (override.deleted) byBatchId.delete(batchId);
    else if (override.record) byBatchId.set(batchId, override.record);
  }
  return [...byBatchId.values()]
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, MAX_RECORDS);
}

function writeRecordOverride(record) {
  const key = recordStorageKey(record?.batch_id);
  if (!key) return false;
  try {
    localStorage.setItem(key, JSON.stringify({ version: RECORD_VERSION, record }));
    try { sessionStorage.removeItem(recordStorageKey(record.batch_id)); }
    catch { return false; }
    return true;
  } catch {
    return false;
  }
}

function writeRecordTombstone(batchId) {
  const key = recordStorageKey(batchId);
  if (!key) return false;
  try {
    localStorage.setItem(key, JSON.stringify({
      version: RECORD_VERSION,
      batch_id: String(batchId).trim(),
      deleted: true,
      updated_at: Date.now(),
    }));
    try { sessionStorage.removeItem(key); }
    catch { return false; }
    return true;
  } catch {
    return false;
  }
}

function clearRecordOverrides(storage) {
  const prefix = recordStoragePrefix();
  let keys = [];
  try {
    if (typeof storage?.length !== 'number' || typeof storage?.key !== 'function') return;
    for (let index = 0; index < storage.length; index += 1) {
      const key = String(storage.key(index) || '');
      if (key.startsWith(prefix)) keys.push(key);
    }
  } catch {
    return;
  }
  for (const key of keys) {
    try { storage.removeItem(key); } catch {}
  }
}

// 生成开始时登记;进行中用 updateInterruptedDigestBatch 刷新进度。
export function rememberInterruptedDigestBatch(value = {}) {
  const batchId = String(value?.batch_id || '').trim();
  const existing = readInterruptedDigestBatchRecords().find(record => record.batch_id === batchId) || null;
  const record = normalizeRecord({
    ...(existing || {}),
    ...value,
    started_at: Number(existing?.started_at || value.started_at || Date.now()) || Date.now(),
    updated_at: Date.now(),
  });
  if (!record) return false;
  return writeRecordOverride(record);
}

export function forgetInterruptedDigestBatch(batchId = '', { claimOwnerId = '' } = {}) {
  const expected = String(batchId || '').trim();
  if (expected) {
    try {
      const claim = readRecoveryClaim(
        localStorage,
        recoveryClaimStorageKey(expected),
        Date.now(),
        DIGEST_RECOVERY_CLAIM_TTL_MS,
      );
      if (claim?.owner_id && claim.owner_id !== String(claimOwnerId || '').trim()) return false;
    } catch {
      return false;
    }
    return writeRecordTombstone(expected);
  }
  try {
    localStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY);
    clearRecordOverrides(localStorage);
    clearRecordOverrides(sessionStorage);
    return true;
  } catch {
    return false;
  }
}

export function finalizeInterruptedDigestBatchRecord(error, {
  batchId = '',
  currentGroup = '',
} = {}) {
  const expectedBatchId = String(batchId || '').trim();
  if (!expectedBatchId) return { retained: false, forgotten: false, phase: '' };

  const cancelled = error?.name === 'AbortError' || error?.status === 499;
  if (!cancelled && isMutationOutcomeUnknown(error)) {
    const recovery = error?.digestRecovery || {};
    const phase = recovery.phase === 'terminal_results_pending_recovery'
      ? 'terminal_results_pending_recovery'
      : 'starting_outcome_unknown';
    const rawIndex = Number(recovery.batch_index);
    const batchIndex = Number.isInteger(rawIndex) && rawIndex >= -1 ? rawIndex : -1;
    const retained = rememberInterruptedDigestBatch({
      batch_id: expectedBatchId,
      batch_index: batchIndex,
      current_group: String(currentGroup || '').trim(),
      phase,
    });
    return { retained, forgotten: false, phase };
  }

  return {
    retained: false,
    forgotten: forgetInterruptedDigestBatch(expectedBatchId),
    phase: '',
  };
}

export function createInterruptedDigestRecoveryRunner({
  locks = globalThis.navigator?.locks || null,
  readRecords = readInterruptedDigestBatchRecords,
  storage = globalThis.localStorage,
  now = () => Date.now(),
  claimTtlMs = DIGEST_RECOVERY_CLAIM_TTL_MS,
} = {}) {
  const taskRunner = createCrossTabTaskRunner({ locks, namespace: 'digest-recovery' });
  const hasCrossTabLock = !!locks && typeof locks.request === 'function';
  return {
    run(taskId, { getIdentity, recover, signal = null } = {}) {
      if (typeof getIdentity !== 'function' || typeof recover !== 'function') {
        return Promise.reject(new Error('摘要恢复执行器参数无效'));
      }
      // localStorage claim 是读改写序列，不能在没有 Web Locks 时充当
      // 跨标签原子锁。宁可保留 marker 让用户重试，也不能让两个页面
      // 同时读取/清理同一批次。
      if (!hasCrossTabLock) {
        return Promise.resolve({
          ran: false,
          coordinated: false,
          busy: true,
          lockUnavailable: true,
          value: undefined,
        });
      }
      let lockedRecord = null;
      let claimBusy = false;
      let claim = null;
      const cleanTaskId = String(taskId || '').trim();
      const claimKey = recoveryClaimStorageKey(cleanTaskId);
      const ownerId = createRecoveryClaimId();
      const claimStorage = storage;
      const claimNow = () => Math.max(0, Number(now?.() || 0) || 0);
      const claimCurrent = () => {
        if (!claim || claim.released) return false;
        try {
          const current = readRecoveryClaim(claimStorage, claimKey, claimNow(), claimTtlMs);
          return current?.owner_id === ownerId;
        } catch {
          return false;
        }
      };
      const releaseClaim = () => {
        if (!claim || claim.released) return false;
        claim.released = true;
        return removeRecoveryClaimIfOwned(claimStorage, claimKey, ownerId);
      };
      const commitClaim = async callback => {
        // recover() 在 createCrossTabTaskRunner 的同名任务锁内执行。这里
        // 只需在该临界区内再次确认 claim；重新申请同名 Web Lock 会因
        // Web Locks 不可重入而与外层 recover callback 互相等待。
        if (!claimCurrent() || typeof callback !== 'function') return false;
        let current = null;
        try {
          current = readRecoveryClaim(claimStorage, claimKey, claimNow(), claimTtlMs);
        } catch {
          return false;
        }
        if (current?.owner_id !== ownerId) return false;
        let committed = false;
        try { committed = (await callback()) === true; }
        catch { committed = false; }
        if (!committed) return false;
        if (!removeRecoveryClaimIfOwned(claimStorage, claimKey, ownerId)) return false;
        claim.released = true;
        return true;
      };
      const task = taskRunner.run(taskId, async () => {
        const record = lockedRecord;
        lockedRecord = null;
        try {
          return await recover(record, claim);
        } catch (error) {
          releaseClaim();
          throw error;
        }
      }, {
        ifAvailable: true,
        signal,
        shouldRun: () => {
          lockedRecord = selectInterruptedDigestBatchRecord(
            readRecords(),
            getIdentity(),
            taskId,
          );
          if (!lockedRecord) return false;
          claimBusy = false;
          const existing = readRecoveryClaim(
            claimStorage,
            claimKey,
            claimNow(),
            claimTtlMs,
          );
          if (existing?.owner_id && existing.owner_id !== ownerId) {
            claimBusy = true;
            lockedRecord = null;
            return false;
          }
          writeRecoveryClaim(claimStorage, claimKey, cleanTaskId, ownerId, claimNow());
          claim = {
            ownerId,
            isCurrent: claimCurrent,
            release: releaseClaim,
            commit: commitClaim,
            get released() { return this._released === true; },
            set released(value) { this._released = value === true; },
          };
          return true;
        },
      });
      return task.then(result => {
        if (claimBusy && result?.ran !== true) {
          return { ...result, busy: true };
        }
        return result;
      }, error => {
        releaseClaim();
        throw error;
      });
    },
  };
}

const recoveryRunner = createInterruptedDigestRecoveryRunner();

// 跨标签页防重复恢复；记录和账号身份在拿到锁后重新读取。
export function runRecoveryOnce(taskId, fn, { getIdentity, signal = null } = {}) {
  return recoveryRunner.run(taskId, { getIdentity, signal, recover: fn });
}

export function digestBatchRecoveryList(payload) {
  const validPayload = payload && typeof payload === 'object' && !Array.isArray(payload);
  const items = validPayload ? payload.items : null;
  const validItems = Array.isArray(items)
    && items.every(item => item && typeof item === 'object' && !Array.isArray(item));
  if (!validItems) {
    const error = new Error('摘要批次恢复清单响应格式无效，请重试。');
    error.status = 502;
    error.code = 'digest_batch_recovery_list_invalid';
    throw error;
  }
  const status = String(payload.status || '').trim().toLowerCase();
  return {
    pending: payload.pending === true || status === 'pending',
    items,
  };
}

export function digestBatchPreviewRecovery(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    const error = new Error('文本预览恢复响应格式无效，请重试。');
    error.status = 502;
    error.code = 'digest_batch_preview_recovery_invalid';
    throw error;
  }
  const status = String(payload.status || '').trim().toLowerCase();
  if (payload.pending === true || status === 'pending') {
    return { status: 'pending', digests: [] };
  }
  if (status === 'missing') return { status: 'missing', digests: [] };
  const digests = payload.digests;
  const validDigests = status === 'done'
    && Array.isArray(digests)
    && digests.length > 0
    && digests.every(digest => digest && typeof digest === 'object' && !Array.isArray(digest));
  if (!validDigests) {
    const error = new Error('文本预览恢复响应格式无效，请重试。');
    error.status = 502;
    error.code = 'digest_batch_preview_recovery_invalid';
    throw error;
  }
  return {
    status: 'ready',
    digests,
    ...digestTerminalRecoveryMetadata(payload),
  };
}

function recoveryAbortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('已取消');
}

function waitForDigestRecoveryDelay(delayMs, signal) {
  return new Promise((resolve, reject) => {
    let timer = null;
    let settled = false;
    let onAbort = null;
    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      signal?.removeEventListener?.('abort', onAbort);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    onAbort = () => settle(reject, recoveryAbortError(signal));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    timer = setTimeout(() => settle(resolve), delayMs);
  });
}

// ---------------------------------------------------------------------------
// 断流后的确定性终态恢复:轮询 POST /api/digest-result。
// onPending(statusPayload) 每次 pending 时回调,可用于更新“仍在处理”提示。
// ---------------------------------------------------------------------------
export async function pollDigestTerminalResult(api, body, {
  signal = null,
  intervalMs = 1500,
  maxWaitMs = 90 * 1000,
  onPending = null,
} = {}) {
  const startedAt = Date.now();
  // 断流后先等服务端把断连判定为恢复窗口内,再开始轮询。
  await waitForDigestRecoveryDelay(1200, signal);
  while (true) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('已取消');
    }
    const payload = await api.post('/api/digest-result', body, { signal });
    // API 实现可能忽略 abort 并晚到返回；取消必须先于响应校验和任何 UI 投影。
    if (signal?.aborted) throw recoveryAbortError(signal);
    const result = requireDigestTerminalResult(payload);
    const status = result.status;
    if (['saved', 'done', 'error', 'skipped', 'missing'].includes(status)) return result;
    try { onPending?.(result); } catch {}
    if (Date.now() - startedAt > maxWaitMs) {
      const error = new Error('等待服务端终态超时;该群结果可能仍在生成,请稍后刷新重试。');
      error.code = 'digest_result_recovery_timeout';
      throw error;
    }
    await waitForDigestRecoveryDelay(intervalMs, signal);
  }
}
