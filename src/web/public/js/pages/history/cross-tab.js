export function invalidateHistoryDetailForDeletedItem({ detail, deletedKey, itemKey }) {
  const key = String(deletedKey || '').trim();
  if (!detail || !key || typeof itemKey !== 'function') return false;
  if (String(itemKey(detail.item) || '').trim() !== key) return false;
  detail.invalidated = true;
  detail.suppressLateActionOutcome = true;
  return true;
}

export function historyStatusResponseIsCurrent({ pageDestroyed = false, signal = null } = {}) {
  return pageDestroyed !== true && signal?.aborted !== true;
}

export function queueHistoryCrossTabItemRefresh({
  detail,
  updatedKey,
  itemKey,
  refreshListItem,
}) {
  const key = String(updatedKey || '').trim();
  if (!key || typeof itemKey !== 'function') return 'ignored';
  if (detail
    && String(itemKey(detail.item) || '').trim() === key
    && typeof detail.revalidator?.schedule === 'function') {
    detail.revalidator.schedule(0);
    return 'detail';
  }
  if (typeof refreshListItem !== 'function') return 'ignored';
  refreshListItem();
  return 'list';
}
