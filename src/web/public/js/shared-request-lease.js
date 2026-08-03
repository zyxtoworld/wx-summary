function sharedRequestAbortError(message = '共享请求已取消') {
  return Object.assign(new Error(String(message || '共享请求已取消')), { name: 'AbortError', status: 499 });
}

function sharedRequestAbortReason(reason, fallbackMessage = '共享请求已取消') {
  if (reason instanceof Error) return reason;
  const message = typeof reason === 'string' && reason.trim() ? reason.trim() : fallbackMessage;
  return sharedRequestAbortError(message);
}

function waitForSharedPromise(promise, signal = null, fallbackMessage = '共享请求已取消') {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(sharedRequestAbortReason(signal.reason, fallbackMessage));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(sharedRequestAbortReason(signal.reason, fallbackMessage));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    Promise.resolve(promise).then(
      value => {
        cleanup();
        resolve(value);
      },
      error => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function createSharedRequestLease({ abortMessage = '共享请求已取消' } = {}) {
  const controller = new AbortController();
  let consumers = 0;
  let settled = false;

  const abort = reason => {
    if (settled || controller.signal.aborted) return false;
    controller.abort(sharedRequestAbortReason(reason, abortMessage));
    return true;
  };

  const wait = (promise, signal = null) => {
    if (signal?.aborted) return Promise.reject(sharedRequestAbortReason(signal.reason, abortMessage));
    consumers += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      consumers = Math.max(0, consumers - 1);
      if (!settled && consumers === 0) abort(abortMessage);
    };
    return waitForSharedPromise(promise, signal, abortMessage).finally(release);
  };

  return {
    signal: controller.signal,
    wait,
    abort,
    settle() {
      settled = true;
    },
    get consumerCount() {
      return consumers;
    },
    get settled() {
      return settled;
    },
  };
}
