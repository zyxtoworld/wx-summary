export function createHistoryReturnRevalidator({
  request,
  signal = null,
  isActive = () => true,
  isBusy = () => false,
  onResult = null,
  onError = null,
  windowTarget = globalThis.window,
  documentTarget = globalThis.document,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
} = {}) {
  if (typeof request !== 'function') throw new Error('历史重验请求无效');

  let disposed = false;
  let timer = null;
  let inFlight = null;
  let rerun = false;
  let rerunDelay = null;
  let revision = 0;

  const active = () => !disposed
    && !signal?.aborted
    && (typeof isActive !== 'function' || isActive());

  function schedule(delay = 180) {
    if (!active()) return;
    revision += 1;
    if (timer !== null) clearTimeoutFn(timer);
    timer = setTimeoutFn(() => {
      timer = null;
      void run();
    }, Math.max(0, Number(delay || 0) || 0));
  }

  async function run() {
    if (!active()) return false;
    if (typeof isBusy === 'function' && isBusy()) {
      rerun = true;
      rerunDelay = 250;
      schedule(250);
      return false;
    }
    if (inFlight) {
      revision += 1;
      rerun = true;
      return inFlight;
    }
    rerun = false;
    const requestRevision = revision;
    const requestPromise = (async () => {
      try {
        const result = await request({ signal });
        if (!active()) return false;
        if (requestRevision !== revision) return false;
        if (typeof isBusy === 'function' && isBusy()) {
          rerun = true;
          rerunDelay = 250;
          schedule(250);
          return false;
        }
        if (typeof onResult === 'function') onResult(result);
        return true;
      } catch (error) {
        if (!active() || error?.name === 'AbortError') return false;
        if (requestRevision !== revision) return false;
        try { onError?.(error); } catch {}
        return false;
      } finally {
        inFlight = null;
        if (rerun && active()) {
          const delay = rerunDelay === null ? 0 : rerunDelay;
          rerun = false;
          rerunDelay = null;
          schedule(delay);
        } else {
          rerunDelay = null;
        }
      }
    })();
    inFlight = requestPromise;
    return requestPromise;
  }

  const onFocus = () => schedule();
  const onVisibilityChange = () => {
    if (documentTarget?.visibilityState === 'visible') schedule();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    revision += 1;
    if (timer !== null) clearTimeoutFn(timer);
    timer = null;
    windowTarget?.removeEventListener?.('focus', onFocus);
    documentTarget?.removeEventListener?.('visibilitychange', onVisibilityChange);
    signal?.removeEventListener?.('abort', dispose);
  };

  windowTarget?.addEventListener?.('focus', onFocus);
  documentTarget?.addEventListener?.('visibilitychange', onVisibilityChange);
  signal?.addEventListener?.('abort', dispose, { once: true });

  return { run, schedule, dispose };
}
