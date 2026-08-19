export function historyActionResultTarget({ actionItem = null, outcomeItem = null, itemKey }) {
  if (typeof itemKey !== 'function') return null;
  for (const candidate of [actionItem, outcomeItem]) {
    if (!candidate || typeof candidate !== 'object') continue;
    if (String(itemKey(candidate) || '').trim()) return candidate;
  }
  return null;
}
