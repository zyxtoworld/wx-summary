export function createModalStack() {
  const entries = [];
  const notifiedStates = new Map();

  const syncTopmost = () => {
    const top = entries.at(-1) || null;
    for (const entry of entries) {
      const topmost = entry === top;
      if (notifiedStates.has(entry) && notifiedStates.get(entry) === topmost) continue;
      notifiedStates.set(entry, topmost);
      entry?.setTopmost?.(topmost);
    }
  };

  return {
    push(entry) {
      if (!entry) return false;
      const current = entries.indexOf(entry);
      if (current >= 0) entries.splice(current, 1);
      entries.push(entry);
      syncTopmost();
      return true;
    },

    remove(entry) {
      const index = entries.indexOf(entry);
      if (index < 0) return false;
      entries.splice(index, 1);
      notifiedStates.delete(entry);
      syncTopmost();
      return true;
    },

    isTop(entry) {
      return entries.length > 0 && entries[entries.length - 1] === entry;
    },

    size() {
      return entries.length;
    },
  };
}
