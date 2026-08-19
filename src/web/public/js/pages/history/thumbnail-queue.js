// 历史缩略图的可见性队列。一个页面只创建一个观察器,并把旧代任务隔离在当前队列之外。
export function createHistoryThumbnailQueue({
  concurrency = 3,
  observerFactory = globalThis.IntersectionObserver,
  root = null,
  rootMargin = '240px 0px',
  load,
} = {}) {
  const limit = Math.max(1, Number(concurrency) || 1);
  const entries = new Map();
  const pending = [];
  let active = 0;
  let generation = 0;
  let disposed = false;
  let observer = null;
  const entryMap = entries;

  const canObserve = typeof observerFactory === 'function';

  function current(entry) {
    return !disposed && entries.get(entry.key) === entry && entry.generation === generation;
  }

  function releaseSlot(entry) {
    if (!entry?.slotHeld) return false;
    entry.slotHeld = false;
    active = Math.max(0, active - 1);
    return true;
  }

  function pump() {
    while (!disposed && active < limit && pending.length) {
      const entry = pending.shift();
      if (!entry || entry.status !== 'queued' || !current(entry)) continue;
      entry.status = 'running';
      entry.slotHeld = true;
      active += 1;
      Promise.resolve()
        .then(() => {
          if (typeof load !== 'function') return undefined;
          return load(entry.key, { isCurrent: () => current(entry) });
        })
        .catch(() => {})
        .finally(() => {
          releaseSlot(entry);
          if (current(entry)) entry.status = 'done';
          pump();
        });
    }
  }

  function unobserve(entry) {
    if (!observer || !entry?.element) return;
    try { observer.unobserve(entry.element); } catch {}
  }

  function enqueue(key) {
    const entry = entries.get(String(key));
    if (!entry || entry.status === 'queued' || entry.status === 'running' || entry.status === 'done') return false;
    entry.status = 'queued';
    pending.push(entry);
    pump();
    return true;
  }

  function watch(key, element) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey || disposed) return false;
    let entry = entries.get(normalizedKey);
    if (entry && entry.status !== 'done') {
      if (entry.element && entry.element !== element) unobserve(entry);
      entry.element = element || null;
    } else {
      if (entry) unobserve(entry);
      entry = {
        key: normalizedKey,
        element: element || null,
        status: 'watching',
        generation,
        slotHeld: false,
      };
      entries.set(normalizedKey, entry);
    }
    if (observer && entry.element) {
      try { observer.observe(entry.element); } catch {}
    } else {
      enqueue(normalizedKey);
    }
    return true;
  }

  function request(key) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey || disposed) return false;
    if (!entries.has(normalizedKey)) {
      entries.set(normalizedKey, {
        key: normalizedKey,
        element: null,
        status: 'watching',
        generation,
        slotHeld: false,
      });
    }
    return enqueue(normalizedKey);
  }

  function cancel(key) {
    const normalizedKey = String(key || '').trim();
    const entry = entries.get(normalizedKey);
    if (!entry) return false;
    entries.delete(normalizedKey);
    entry.status = 'cancelled';
    releaseSlot(entry);
    unobserve(entry);
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (pending[index] === entry) pending.splice(index, 1);
    }
    pump();
    return true;
  }

  function clear() {
    generation += 1;
    for (const entry of entries.values()) {
      entry.status = 'cancelled';
      releaseSlot(entry);
      unobserve(entry);
    }
    entries.clear();
    pending.length = 0;
  }

  function refresh() {
    if (!observer || disposed) return;
    for (const entry of entries.values()) {
      if (!entry.element || entry.status === 'done' || entry.status === 'cancelled') continue;
      try { observer.observe(entry.element); } catch {}
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clear();
    try { observer?.disconnect(); } catch {}
    observer = null;
  }

  if (canObserve) {
    try {
      observer = new observerFactory(records => {
        for (const record of records || []) {
          if (!record?.isIntersecting && Number(record?.intersectionRatio || 0) <= 0) continue;
          const target = [...entryMap.values()].find(candidate => candidate.element === record.target);
          if (target) enqueue(target.key);
        }
      }, { root, rootMargin, threshold: 0 });
    } catch {
      observer = null;
    }
  }

  return {
    watch,
    request,
    cancel,
    clear,
    refresh,
    dispose,
    get pendingCount() { return pending.length; },
    get activeCount() { return active; },
    get observedCount() { return entries.size; },
  };
}
