function normalizedKey(value) {
  return String(value || '').trim();
}

export function createSettingsDraftState({ onDirtyChange = () => {} } = {}) {
  const dirtySections = new Set();
  const accountScopedDrafts = new Set();

  function mark(target, sectionId, dirty, notify = false) {
    const key = normalizedKey(sectionId);
    if (!key) return false;
    const had = target.has(key);
    if (dirty) target.add(key);
    else target.delete(key);
    if (notify && had !== !!dirty) onDirtyChange(key);
    return had !== !!dirty;
  }

  return {
    markDirty(sectionId, dirty) {
      return mark(dirtySections, sectionId, dirty, true);
    },
    markAccountScoped(sectionId, dirty) {
      return mark(accountScopedDrafts, sectionId, dirty, false);
    },
    isDirty(sectionId) {
      return dirtySections.has(normalizedKey(sectionId));
    },
    hasUnsaved() {
      return dirtySections.size > 0 || accountScopedDrafts.size > 0;
    },
    dirtyCount() {
      return dirtySections.size;
    },
    accountScopedCount() {
      return accountScopedDrafts.size;
    },
    clear({ notify = true } = {}) {
      const dirtyKeys = [...dirtySections];
      dirtySections.clear();
      accountScopedDrafts.clear();
      if (notify) {
        for (const key of dirtyKeys) onDirtyChange(key);
      }
    },
  };
}
