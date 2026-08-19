export function historyStorageKeys(origin = globalThis.location?.origin || '') {
  const scope = String(origin || '').trim();
  return {
    view: `wx-summary:history-view:${scope}`,
    itemUpdated: `wx-summary:history-item-updated:${scope}`,
  };
}
