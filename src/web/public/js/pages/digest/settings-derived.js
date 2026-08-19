// 摘要页按账号上下文读取设置派生数据;每次重载都有自己的代次,避免旧账号响应回写。
import { requireSettingsDocument } from '../../shared/settings-document.js';

export function createDigestSettingsDerivedLoader({
  api,
  signal = null,
  isActive = () => true,
  apply = () => {},
} = {}) {
  if (!api || typeof api.get !== 'function') throw new TypeError('摘要设置派生数据 API 无效');
  let disposed = false;
  let revision = 0;
  let activeRequest = null;

  const active = () => !disposed && !signal?.aborted && isActive() !== false;
  const abortActiveRequest = (message) => {
    const request = activeRequest;
    if (!request) return;
    activeRequest = null;
    request.detach?.();
    if (!request.controller.signal.aborted) {
      request.controller.abort(new DOMException(message, 'AbortError'));
    }
  };

  return {
    async load({ isCurrent = () => true } = {}) {
      if (!active()) return false;
      const requestRevision = ++revision;
      abortActiveRequest('设置派生数据请求已被取代');
      const controller = new AbortController();
      let detach = null;
      if (signal) {
        const abortFromParent = () => {
          if (!controller.signal.aborted) {
            controller.abort(signal.reason || new DOMException('页面已卸载', 'AbortError'));
          }
        };
        if (signal.aborted) abortFromParent();
        else {
          signal.addEventListener('abort', abortFromParent, { once: true });
          detach = () => signal.removeEventListener('abort', abortFromParent);
        }
      }
      const request = { controller, detach };
      activeRequest = request;
      const current = () => {
        if (!active() || requestRevision !== revision) return false;
        try { return isCurrent() !== false; } catch { return false; }
      };
      let settings;
      try {
        const response = await api.get('/api/settings', { signal: controller.signal });
        if (!current()) return false;
        settings = requireSettingsDocument(response);
      } catch {
        return false;
      } finally {
        detach?.();
        if (activeRequest === request) activeRequest = null;
      }
      const groups = settings?.groups && typeof settings.groups === 'object'
        ? settings.groups
        : {};
      apply({
        whitelistRefs: Array.isArray(groups.whitelist) ? groups.whitelist : [],
        recentRefs: Array.isArray(groups.recent) ? groups.recent : [],
      });
      return true;
    },

    invalidate() {
      revision += 1;
      abortActiveRequest('设置派生数据请求已失效');
    },

    dispose() {
      disposed = true;
      revision += 1;
      abortActiveRequest('摘要页已卸载');
    },
  };
}
