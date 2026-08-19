import {
  isAccountContextRefreshError,
  refreshPublicAccountIdentityUpgrade,
  validatePublicAccountIdentityUpgrade,
} from '../../shared/account-context.js';

// 摘要页账号上下文刷新生命周期协调器。
export function createAccountContextRefreshController({
  refreshAccounts = null,
  isCurrent = () => true,
  isBlocked = () => false,
} = {}) {
  let lastRefreshKey = '';
  let refreshing = false;
  let automaticRetrying = false;
  let queuedRetry = null;
  let disposed = false;
  let contextEpoch = 0;

  function alive() {
    if (disposed) return false;
    try { return isCurrent() !== false && isBlocked() !== true; } catch { return false; }
  }

  async function runAutomaticRetry(retry, ownerEpoch = contextEpoch) {
    if (typeof retry !== 'function' || !alive() || ownerEpoch !== contextEpoch) return;
    // 账号刷新直接触发的 retry 延续当前自动刷新预算；刷新期间 subscriber
    // 为同一账号排入的回调由它覆盖，避免双请求。
    queuedRetry = null;
    automaticRetrying = true;
    let result;
    try {
      if (ownerEpoch !== contextEpoch || !alive()) return;
      result = await retry();
    } finally {
      automaticRetrying = false;
    }
    // retry 期间若又切到别的账号，最新账号加载是新的用户上下文，必须
    // 以 fresh chain 执行，不能继承旧账号的 automaticRetrying 预算。
    await runQueuedRetry();
    return result;
  }

  async function runQueuedRetry() {
    const retry = queuedRetry;
    queuedRetry = null;
    if (typeof retry !== 'function' || !alive()) return;
    await retry();
  }

  return {
    isRefreshing: () => refreshing,
    queueRetryWhileBusy(retry) {
      if ((!refreshing && !automaticRetrying) || typeof retry !== 'function' || !alive()) return false;
      queuedRetry = retry;
      return true;
    },
    async handleUpgrade(payload, {
      accountId = '',
      fingerprint = '',
      retry = null,
    } = {}) {
      const validation = validatePublicAccountIdentityUpgrade(payload, { accountId, fingerprint });
      if (validation.status !== 'valid') return validation;
      if (!alive()) return { status: 'stale' };
      const ownerEpoch = contextEpoch;
      if (refreshing || automaticRetrying || typeof refreshAccounts !== 'function') {
        return { status: 'blocked' };
      }
      refreshing = true;
      let result;
      try {
        result = await refreshPublicAccountIdentityUpgrade(payload, {
          accountId,
          fingerprint,
          refreshAccounts,
          isCurrent: () => ownerEpoch === contextEpoch && alive(),
        });
      } finally {
        refreshing = false;
      }
      if (result.status !== 'upgraded') {
        await runQueuedRetry();
        return result;
      }
      if (typeof retry !== 'function') {
        await runQueuedRetry();
        return result;
      }
      return {
        status: 'retried',
        account: result.account,
        result: await runAutomaticRetry(retry, ownerEpoch),
      };
    },
    async handle(error, {
      accountId = '',
      fingerprint = '',
      retry = null,
    } = {}) {
      if (!isAccountContextRefreshError(error)) return { status: 'not_account_context' };
      if (!alive()) return { status: 'stale' };
      const key = `${String(accountId || '').trim()}:${String(fingerprint || '').trim().toLowerCase()}`;
      const ownerEpoch = contextEpoch;
      if (!key || key === ':' || automaticRetrying || key === lastRefreshKey || typeof refreshAccounts !== 'function') {
        return { status: 'blocked', key };
      }
      lastRefreshKey = key;
      refreshing = true;
      let refreshResult = null;
      try {
        await refreshAccounts({ forceDetect: true });
      } catch (refreshError) {
        refreshResult = !alive() || ownerEpoch !== contextEpoch
          ? { status: 'stale' }
          : { status: 'refresh_failed', error: refreshError, key };
      } finally {
        refreshing = false;
      }
      if (refreshResult) {
        await runQueuedRetry();
        return refreshResult;
      }
      if (!alive()) {
        queuedRetry = null;
        return { status: 'stale', key };
      }
      if (ownerEpoch !== contextEpoch) {
        await runQueuedRetry();
        return { status: 'stale', key };
      }
      if (typeof retry !== 'function') {
        await runQueuedRetry();
        return { status: 'blocked', key };
      }
      return { status: 'retried', key, result: await runAutomaticRetry(retry, ownerEpoch) };
    },
    async retryExplicitly(retry) {
      if (!alive()) return { status: 'stale' };
      lastRefreshKey = '';
      return retry?.();
    },
    resetForContext() {
      contextEpoch += 1;
      lastRefreshKey = '';
      queuedRetry = null;
      return contextEpoch;
    },
    dispose() {
      disposed = true;
      contextEpoch += 1;
      refreshing = false;
      automaticRetrying = false;
      queuedRetry = null;
      lastRefreshKey = '';
    },
  };
}
