import { isMutationOutcomeUnknown } from './mutation-outcome.js';
import { requireSettingsDocument } from './settings-document.js';

const RECORD_VERSION = 1;
const STORAGE_PREFIX = `wx-summary:pending-settings-mutation:${globalThis.location?.origin || 'local'}:`;

function storageUnavailableError(cause = null) {
  const error = new Error('设置恢复记录无法持久化,请求尚未发送;请检查浏览器站点存储后重试。', {
    cause: cause instanceof Error ? cause : undefined,
  });
  error.code = 'settings_recovery_storage_unavailable';
  error.status = 507;
  return error;
}

function getStorage() {
  try {
    if (!globalThis.localStorage
      || typeof globalThis.localStorage.setItem !== 'function'
      || typeof globalThis.localStorage.getItem !== 'function') {
      throw new Error('localStorage unavailable');
    }
    return globalThis.localStorage;
  } catch (error) {
    throw storageUnavailableError(error);
  }
}

function mutationKey(id) {
  return `${STORAGE_PREFIX}${String(id || '').trim()}`;
}

function createPendingSettingsMutationId() {
  const random = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  return `settings-${String(random).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)}`;
}

export function beginPendingSettingsMutation(label = '设置写入') {
  const id = createPendingSettingsMutationId();
  const record = {
    version: RECORD_VERSION,
    id,
    label: String(label || '设置写入').trim().slice(0, 120),
    created_at: Date.now(),
  };
  const serialized = JSON.stringify(record);
  try {
    const storage = getStorage();
    const key = mutationKey(id);
    storage.setItem(key, serialized);
    if (storage.getItem(key) !== serialized) throw new Error('settings recovery marker readback mismatch');
  } catch (error) {
    if (error?.code === 'settings_recovery_storage_unavailable') throw error;
    throw storageUnavailableError(error);
  }
  return id;
}

export function readPendingSettingsMutationRecords() {
  const storage = getStorage();
  const records = [];
  try {
    const keys = [];
    for (let index = 0; index < Number(storage.length || 0); index += 1) {
      const key = storage.key?.(index);
      if (typeof key === 'string' && key.startsWith(STORAGE_PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      const removeInvalidKey = () => {
        try {
          storage.removeItem(key);
        } catch (error) {
          throw storageUnavailableError(error);
        }
      };
      let raw = null;
      try {
        raw = storage.getItem(key);
      } catch (error) {
        throw storageUnavailableError(error);
      }
      let parsed = null;
      try {
        parsed = JSON.parse(raw || 'null');
      } catch {
        removeInvalidKey();
        continue;
      }
      if (Number(parsed?.version || 0) !== RECORD_VERSION) {
        removeInvalidKey();
        continue;
      }
      const id = String(parsed?.id || '').trim();
      if (!id || mutationKey(id) !== key) {
        removeInvalidKey();
        continue;
      }
      records.push({
        version: RECORD_VERSION,
        id,
        label: String(parsed?.label || '设置写入').trim().slice(0, 120),
        created_at: Math.max(0, Number(parsed?.created_at || 0) || 0),
      });
    }
  } catch (error) {
    throw storageUnavailableError(error);
  }
  return records.sort((a, b) => a.created_at - b.created_at);
}

export function forgetPendingSettingsMutation(id = '') {
  const cleanId = String(id || '').trim();
  if (!cleanId) return false;
  try {
    getStorage().removeItem(mutationKey(cleanId));
    return true;
  } catch (error) {
    throw storageUnavailableError(error);
  }
}

export function completePendingSettingsMutationAfterResponse(id = '') {
  return forgetPendingSettingsMutation(id);
}

export function completePendingSettingsMutationAfterError(id = '', error = null) {
  if (isMutationOutcomeUnknown(error)) return false;
  forgetPendingSettingsMutation(id);
  return true;
}

export function clearPendingSettingsMutationRecords(records = null) {
  const targets = Array.isArray(records) ? records : readPendingSettingsMutationRecords();
  for (const record of targets) forgetPendingSettingsMutation(record?.id);
  return targets.length;
}

// 页面/服务重启后,等待服务端已排队的设置写入完成,再读取最终文档并清理 marker。
export async function restorePendingSettingsMutationRecovery({
  api,
  signal = null,
  applySettings = null,
} = {}) {
  const records = readPendingSettingsMutationRecords();
  if (!records.length) return { pending: 0, cleared: 0, settings: null };
  const cancelled = () => ({
    pending: records.length,
    cleared: 0,
    settings: null,
    cancelled: true,
  });
  if (signal?.aborted) return cancelled();
  if (!api || typeof api.get !== 'function') throw new Error('设置恢复 API 无效');
  const response = await api.get('/api/settings?wait_for_writes=1', {
    signal,
    timeoutMs: 60_000,
  });
  // API 实现可能忽略 abort；取消后的晚到响应不能再污染页面状态，
  // 也不能清掉仍需下次启动核对的恢复 marker。
  if (signal?.aborted) return cancelled();
  const settings = requireSettingsDocument(response);
  applySettings?.(settings);
  // 只清理本次恢复开始时看到的 marker。等待权威文档期间，其他标签可能
  // 已登记新的写入；无条件清空全局 marker 会让那次新写入失去崩溃恢复线索。
  const cleared = clearPendingSettingsMutationRecords(records);
  return { pending: records.length, cleared, settings };
}

export const pendingSettingsMutationStoragePrefix = STORAGE_PREFIX;
