function normalizeTaskPart(value = '', label = '任务标识') {
  const clean = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(clean)) {
    throw new Error(`${label}无效`);
  }
  return clean;
}

export function createCrossTabTaskRunner({ locks = null, namespace = 'task' } = {}) {
  const cleanNamespace = normalizeTaskPart(namespace, '任务命名空间');
  const active = new Map();
  const lockManager = locks && typeof locks.request === 'function' ? locks : null;

  const run = (taskId, task, { shouldRun = null, ifAvailable = false } = {}) => {
    let cleanTaskId;
    try {
      cleanTaskId = normalizeTaskPart(taskId);
      if (typeof task !== 'function') throw new Error('任务执行器无效');
    } catch (error) {
      return Promise.reject(error);
    }
    if (active.has(cleanTaskId)) return active.get(cleanTaskId);

    const execute = async (coordinated, lock = true) => {
      if (coordinated && ifAvailable && !lock) {
        return { ran: false, coordinated: true, busy: true, value: undefined };
      }
      if (typeof shouldRun === 'function' && !shouldRun()) {
        return { ran: false, coordinated, value: undefined };
      }
      return { ran: true, coordinated, value: await task() };
    };
    const promise = lockManager
      ? Promise.resolve(lockManager.request(
        `wx-summary:${cleanNamespace}:${cleanTaskId}`,
        { mode: 'exclusive', ...(ifAvailable ? { ifAvailable: true } : {}) },
        lock => execute(true, lock),
      ))
      : execute(false);
    active.set(cleanTaskId, promise);
    const cleanup = () => {
      if (active.get(cleanTaskId) === promise) active.delete(cleanTaskId);
    };
    promise.then(cleanup, cleanup);
    return promise;
  };

  return {
    run,
    has(taskId = '') {
      const clean = String(taskId || '').trim();
      return !!clean && active.has(clean);
    },
  };
}
