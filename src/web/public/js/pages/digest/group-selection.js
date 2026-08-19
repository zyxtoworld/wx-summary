// 用权威群列表协调草稿选择；刷新中的旧快照不得提前删除用户选择。
export function reconcileDigestGroupSelection({
  selectedIds = new Set(),
  groups = [],
  authoritative = false,
} = {}) {
  const current = new Set();
  if (selectedIds && typeof selectedIds[Symbol.iterator] === 'function') {
    for (const value of selectedIds) {
      const id = String(value || '').trim();
      if (id) current.add(id);
    }
  }
  if (!authoritative) {
    return { selectedIds: current, removedIds: [], changed: false };
  }

  const available = new Set(
    (Array.isArray(groups) ? groups : [])
      .map(group => String(group?.id || '').trim())
      .filter(Boolean),
  );
  const next = new Set();
  const removedIds = [];
  for (const id of current) {
    if (available.has(id)) next.add(id);
    else removedIds.push(id);
  }
  return {
    selectedIds: next,
    removedIds,
    changed: removedIds.length > 0,
  };
}
