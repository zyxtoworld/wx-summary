import { createCrossTabTaskRunner } from '/js/shared/cross-tab-task-runner.js';
import {
  beginPendingSettingsMutation,
  completePendingSettingsMutationAfterError,
  completePendingSettingsMutationAfterResponse,
} from './settings-mutation-recovery.js';
import { settingsDocumentRevision } from './settings-document.js';

function settingsNotReadyError() {
  const error = new Error('设置版本尚未加载完成，无法保存。');
  error.code = 'settings_not_ready';
  return error;
}

function settingsOwnerExpiredError() {
  const error = new Error('设置保存动作已失效，未继续提交。');
  error.name = 'AbortError';
  error.status = 499;
  error.code = 'settings_action_stale';
  return error;
}

export function requireSettingsWriteResult(value) {
  const settings = value?.settings;
  const revision = String(value?.settings_revision || '').trim();
  const settingsRevision = settingsDocumentRevision(settings);
  const valid = value
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.ok === true
    && settings
    && typeof settings === 'object'
    && !Array.isArray(settings)
    && revision
    && settingsRevision === revision;
  if (!valid) {
    const error = new Error('设置保存可能已经执行，但返回响应无效；请重新载入设置核对，勿重复提交。');
    error.status = 502;
    error.code = 'settings_write_response_invalid';
    error.outcomeUnknown = true;
    error.mutation_outcome_unknown = true;
    throw error;
  }
  return value;
}

export function createSettingsWriteCoordinator({ locks = globalThis.navigator?.locks || null } = {}) {
  const runner = createCrossTabTaskRunner({ locks, namespace: 'settings-write' });

  return {
    async write({ loadLatest, commit, signal = null } = {}) {
      if (typeof loadLatest !== 'function') throw new TypeError('设置读取函数无效');
      if (typeof commit !== 'function') throw new TypeError('设置提交函数无效');
      const outcome = await runner.run('mutation', async () => {
        const latest = await loadLatest({ signal });
        const revision = settingsDocumentRevision(latest);
        if (!revision) throw settingsNotReadyError();
        if (signal?.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new DOMException('操作已取消', 'AbortError');
        }
        return commit({ latest, revision, signal });
      }, { signal, dedupe: false });
      return outcome.value;
    },
    hasActiveWrite() {
      return runner.has('mutation');
    },
  };
}

const SETTINGS_WRITE_COORDINATOR = createSettingsWriteCoordinator();

export async function writeSettingsPatch({
  api,
  patch,
  signal = null,
  timeoutMs = 180_000,
  readTimeoutMs = 30_000,
  onLatest = null,
  isCurrent = null,
  coordinator = SETTINGS_WRITE_COORDINATOR,
} = {}) {
  if (!api || typeof api.get !== 'function' || typeof api.request !== 'function') {
    throw new TypeError('设置 API 无效');
  }
  if (!coordinator || typeof coordinator.write !== 'function') {
    throw new TypeError('设置写协调器无效');
  }
  const ownerIsCurrent = () => {
    if (typeof isCurrent !== 'function') return true;
    try {
      return isCurrent() === true;
    } catch {
      return false;
    }
  };
  const assertOwner = () => {
    if (!ownerIsCurrent()) throw settingsOwnerExpiredError();
  };
  assertOwner();
  const mutationId = beginPendingSettingsMutation('设置保存');
  try {
    const response = await coordinator.write({
      signal,
      loadLatest: () => api.get('/api/settings?wait_for_writes=1', {
        signal,
        timeoutMs: readTimeoutMs,
      }),
      commit: async ({ latest, revision }) => {
        assertOwner();
        if (typeof onLatest === 'function') await onLatest(latest);
        assertOwner();
        return api.request('/api/settings', {
          method: 'PUT',
          body: { ...(patch || {}), base_settings_revision: revision },
          signal,
          timeoutMs,
        });
      },
    });
    const result = requireSettingsWriteResult(response);
    completePendingSettingsMutationAfterResponse(mutationId);
    return result;
  } catch (error) {
    completePendingSettingsMutationAfterError(mutationId, error);
    throw error;
  }
}

export function runCoordinatedSettingsWrite(options = {}) {
  return SETTINGS_WRITE_COORDINATOR.write(options);
}
