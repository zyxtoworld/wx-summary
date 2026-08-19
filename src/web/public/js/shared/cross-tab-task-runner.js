function normalizeTaskPart(value = '', label = '任务标识') {
  const clean = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(clean)) {
    throw new Error(`${label}无效`);
  }
  return clean;
}

function taskAbortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name === 'AbortError' && reason.status === 499) {
    return reason;
  }
  const message = reason instanceof Error
    ? (reason.message || '操作已取消')
    : (typeof reason === 'string' && reason.trim() ? reason : '操作已取消');
  const error = new Error(message);
  error.name = 'AbortError';
  error.status = 499;
  if (reason && typeof reason === 'object' && reason.code) error.code = reason.code;
  return error;
}

function raceTaskWithSignal(promise, signal) {
  if (!signal) return promise;
  let cleanup = () => {};
  const aborted = new Promise((_, reject) => {
    const onAbort = () => {
      cleanup();
      reject(taskAbortError(signal));
    };
    cleanup = () => signal.removeEventListener?.('abort', onAbort);
    if (signal.aborted) onAbort();
    else signal.addEventListener?.('abort', onAbort, { once: true });
  });
  promise.then(cleanup, cleanup);
  return Promise.race([promise, aborted]);
}

export function createCrossTabTaskRunner({ locks = null, namespace = 'task' } = {}) {
  const cleanNamespace = normalizeTaskPart(namespace, '任务命名空间');
  const active = new Map();
  const localTails = new Map();
  const lockManager = locks && typeof locks.request === 'function' ? locks : null;

  const acquire = (taskId, { ifAvailable = true } = {}) => {
    let cleanTaskId;
    try {
      cleanTaskId = normalizeTaskPart(taskId);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!lockManager) {
      return Promise.resolve({
        acquired: false,
        coordinated: false,
        busy: true,
        lockUnavailable: true,
      });
    }

    let resolveAcquisition;
    let rejectAcquisition;
    let settled = false;
    let releaseHeld = null;
    const acquisition = new Promise((resolve, reject) => {
      resolveAcquisition = resolve;
      rejectAcquisition = reject;
    });
    const hold = new Promise(resolve => { releaseHeld = resolve; });
    const release = () => {
      if (!releaseHeld) return false;
      const resolve = releaseHeld;
      releaseHeld = null;
      resolve();
      return true;
    };

    let requestPromise;
    try {
      requestPromise = lockManager.request(
        `wx-summary:${cleanNamespace}:${cleanTaskId}`,
        {
          mode: 'exclusive',
          ...(ifAvailable ? { ifAvailable: true } : {}),
        },
        lock => {
          if (ifAvailable && !lock) {
            settled = true;
            resolveAcquisition({
              acquired: false,
              coordinated: true,
              busy: true,
            });
            return undefined;
          }
          settled = true;
          resolveAcquisition({
            acquired: true,
            coordinated: true,
            release,
          });
          return hold;
        },
      );
    } catch (error) {
      if (!settled) {
        settled = true;
        rejectAcquisition(error);
      }
      return acquisition;
    }
    Promise.resolve(requestPromise).catch(error => {
      if (settled) return;
      settled = true;
      rejectAcquisition(error);
    });
    return acquisition;
  };

  const run = (taskId, task, {
    shouldRun = null,
    ifAvailable = false,
    signal = null,
    dedupe = true,
  } = {}) => {
    let cleanTaskId;
    try {
      cleanTaskId = normalizeTaskPart(taskId);
      if (typeof task !== 'function') throw new Error('任务执行器无效');
    } catch (error) {
      return Promise.reject(error);
    }
    if (dedupe && active.has(cleanTaskId)) {
      const sharedPromise = active.get(cleanTaskId);
      return signal ? raceTaskWithSignal(sharedPromise, signal) : sharedPromise;
    }

    const execute = async (coordinated, lock = true) => {
      if (signal?.aborted) throw taskAbortError(signal);
      if (coordinated && ifAvailable && !lock) {
        return { ran: false, coordinated: true, busy: true, value: undefined };
      }
      if (typeof shouldRun === 'function' && !shouldRun()) {
        return { ran: false, coordinated, value: undefined };
      }
      return { ran: true, coordinated, value: await task() };
    };
    let sharedPromise;
    if (lockManager) {
      sharedPromise = Promise.resolve(lockManager.request(
        `wx-summary:${cleanNamespace}:${cleanTaskId}`,
        {
          mode: 'exclusive',
          ...(ifAvailable ? { ifAvailable: true } : {}),
          ...(signal ? { signal } : {}),
        },
        lock => execute(true, lock),
      ));
    } else if (!dedupe) {
      const previous = localTails.get(cleanTaskId) || Promise.resolve();
      const tail = previous.catch(() => undefined).then(() => execute(false));
      // 返回值可以立即响应调用者取消;尾队列仍保留本任务占位,避免后续任务越过
      // 尚未结束的旧任务并发执行。
      sharedPromise = tail;
      localTails.set(cleanTaskId, tail);
      tail.then(
        () => { if (localTails.get(cleanTaskId) === tail) localTails.delete(cleanTaskId); },
        () => { if (localTails.get(cleanTaskId) === tail) localTails.delete(cleanTaskId); },
      );
    } else {
      sharedPromise = execute(false);
    }
    active.set(cleanTaskId, sharedPromise);
    const cleanup = () => {
      if (active.get(cleanTaskId) === sharedPromise) active.delete(cleanTaskId);
    };
    sharedPromise.then(cleanup, cleanup);
    return signal ? raceTaskWithSignal(sharedPromise, signal) : sharedPromise;
  };

  return {
    run,
    acquire,
    has(taskId = '') {
      const clean = String(taskId || '').trim();
      return !!clean && active.has(clean);
    },
  };
}
