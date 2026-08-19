export function createPageTaskScope() {
  let active = true;
  let generation = 0;

  const capture = () => generation;
  const isCurrent = token => active && token === generation;

  return {
    capture,
    isCurrent,
    isActive: () => active,

    invalidate() {
      if (!active) return false;
      generation += 1;
      return true;
    },

    async run(task, { onSuccess = null, onError = null } = {}) {
      if (typeof task !== 'function') throw new Error('页面任务无效');
      const token = capture();
      let value;
      try {
        value = await task();
      } catch (error) {
        if (!isCurrent(token)) return { status: 'stale' };
        if (typeof onError === 'function') onError(error);
        return { status: 'failed', error };
      }
      if (!isCurrent(token)) return { status: 'stale' };
      if (typeof onSuccess === 'function') onSuccess(value);
      return { status: 'applied', value };
    },

    dispose() {
      if (!active) return;
      active = false;
      generation += 1;
    },
  };
}
