function defaultClosingError() {
  return Object.assign(new Error('work registry is closing'), {
    name: 'AbortError',
    code: 'work_registry_closing',
  });
}

export function createAbortableWorkRegistry({ closingError = defaultClosingError } = {}) {
  const entries = new Set();
  let closing = false;
  let closingReason = null;

  const nextClosingError = () => {
    const error = closingError(closingReason);
    return error instanceof Error ? error : defaultClosingError();
  };

  const register = (promise, { controller = null, onSettled = null } = {}) => {
    const entry = { controller, promise: null };
    const tracked = Promise.resolve(promise).finally(() => {
      entries.delete(entry);
      onSettled?.();
    });
    entry.promise = tracked;
    entries.add(entry);
    return tracked;
  };

  const run = (task, { signal = null } = {}) => {
    if (closing) return Promise.reject(nextClosingError());
    if (typeof task !== 'function') return Promise.reject(new TypeError('registered work must be a function'));
    const controller = new AbortController();
    const abortFromParent = () => {
      if (controller.signal.aborted) return;
      const reason = signal?.reason instanceof Error ? signal.reason : nextClosingError();
      controller.abort(reason);
    };
    signal?.addEventListener?.('abort', abortFromParent, { once: true });
    if (signal?.aborted) abortFromParent();
    const promise = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return task(controller.signal);
    });
    return register(promise, {
      controller,
      onSettled: () => signal?.removeEventListener?.('abort', abortFromParent),
    });
  };

  const track = (promise, { controller = null } = {}) => register(promise, { controller });

  const cancel = reason => {
    closing = true;
    if (reason instanceof Error) closingReason = reason;
    let aborted = 0;
    for (const entry of entries) {
      const controller = entry.controller;
      if (!controller || controller.signal.aborted) continue;
      controller.abort(reason instanceof Error ? reason : nextClosingError());
      aborted += 1;
    }
    return { active: entries.size, aborted, closing: true };
  };

  const waitForSettled = async (timeoutMs = 0) => {
    const timeout = Math.max(0, Number(timeoutMs || 0) || 0);
    const deadline = Date.now() + timeout;
    while (entries.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { settled: false, active: entries.size, timed_out: true };
      let timer = null;
      const outcome = await Promise.race([
        Promise.allSettled([...entries].map(entry => entry.promise)).then(() => 'settled'),
        new Promise(resolve => {
          timer = setTimeout(() => resolve('timeout'), remaining);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (outcome === 'timeout') return { settled: false, active: entries.size, timed_out: true };
    }
    return { settled: true, active: 0, timed_out: false };
  };

  const status = () => ({ active: entries.size, closing });

  return Object.freeze({ cancel, run, status, track, waitForSettled });
}
