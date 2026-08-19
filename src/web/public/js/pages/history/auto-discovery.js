export const HISTORY_AUTO_DISCOVERY_PASS_LIMIT = 2;

const DISCOVERY_REASONS = new Set([
  'history_base_scan_limited',
  'history_base_visit_limited',
  'history_base_unreadable',
  'history_discovery_unreadable',
  'history_search_scan_pending',
]);

function reasonCode(entry) {
  if (typeof entry === 'string') return entry.trim();
  return String(entry?.code || '').trim();
}

export function shouldQueueHistoryAutoDiscovery({
  items = [],
  incompleteReasons = [],
  pass = 0,
  limit = HISTORY_AUTO_DISCOVERY_PASS_LIMIT,
} = {}) {
  if (Array.isArray(items) && items.length) return false;
  if (Math.max(0, Number(pass) || 0) >= Math.max(0, Number(limit) || 0)) return false;
  return incompleteReasons.some(entry => DISCOVERY_REASONS.has(reasonCode(entry)));
}
