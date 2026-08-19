import { historyStatusResponseIsCurrent } from './cross-tab.js';

function cancelledResult(error = null) {
  return { ok: false, code: 'cancelled', error, item: null };
}

function invalidStatusResponseError() {
  return Object.assign(
    new Error('历史状态响应格式无效，请刷新后重试。'),
    { status: 502, code: 'history_status_invalid_response' },
  );
}

export function createHistoryStatusRefreshController({
  api,
  getStatusPath,
  getDetail = () => null,
  isPageDestroyed = () => false,
  reconcile = () => ({ found: false }),
  render = () => {},
  matchesFilter = () => false,
  scheduleReload = () => {},
  updateDetail = () => {},
  broadcast = () => {},
  onStart = () => {},
  onStatusRefreshed = () => {},
  onMissing = () => {},
  onFailure = () => {},
  onFinally = () => {},
} = {}) {
  // 静默的跨标签刷新可以与用户显式详情刷新并行;忙态收尾只能由
  // 最近一次非静默操作持有,否则旧请求的 finally 会解除新操作的忙态。
  const detailBusyOperations = new WeakMap();

  async function refresh(item, { silent = false, signal = null } = {}) {
    const detail = getDetail(item);
    const requestSignal = signal || detail?.controller?.signal || null;
    const operation = {};
    const currentDetail = () => getDetail(item);
    const detailIsCurrent = () => detail && currentDetail() === detail;
    const responseIsCurrent = () => historyStatusResponseIsCurrent({
      pageDestroyed: isPageDestroyed(),
      signal: requestSignal,
    }) && (!detail || (detail.invalidated !== true && detailIsCurrent()));

    if (!silent && detail) {
      detailBusyOperations.set(detail, operation);
      onStart(detail);
    }
    try {
      const payload = await api.get(getStatusPath(item), {
        signal: requestSignal,
        timeoutMs: 30000,
      });
      if (!responseIsCurrent()) return cancelledResult();

      const next = payload?.item;
      if (next && typeof next === 'object') {
        const reconciliation = reconcile(next, { fallbackItem: item });
        if (reconciliation.found) render();
        else if (matchesFilter(next)) scheduleReload();
        if (detailIsCurrent()) updateDetail(next);
        broadcast(next);
      }
      if (!next || typeof next !== 'object') {
        if (!silent) onFailure({ detail, error: invalidStatusResponseError() });
        return { ok: false, code: 'invalid_response', item: null };
      }
      if (!silent && detailIsCurrent()) onStatusRefreshed(detail);
      return { ok: true, code: '', item: next };
    } catch (error) {
      if (!responseIsCurrent() || error?.name === 'AbortError') {
        return cancelledResult(error);
      }
      if (error?.status === 404) {
        onMissing({ item, detail, error });
        return { ok: false, code: 'missing', error, item: null };
      }
      if (!silent) onFailure({ detail, error });
      return { ok: false, code: 'request_failed', error, item: null };
    } finally {
      if (detail
        && !silent
        && detailBusyOperations.get(detail) === operation) {
        detailBusyOperations.delete(detail);
        if (isPageDestroyed() !== true && detailIsCurrent() && detail.busy) onFinally(detail);
      }
    }
  }

  return { refresh };
}
