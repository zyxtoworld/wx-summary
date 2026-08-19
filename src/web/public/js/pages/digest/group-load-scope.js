export { formatGroupProgressText } from './group-progress-text.js';

function groupLoadAbortError(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  error.status = 499;
  return error;
}

const GROUP_PROGRESS_TERMINAL_STATUSES = new Set([
  'cancelled',
  'canceled',
  'complete',
  'completed',
  'done',
  'error',
  'failed',
]);

function progressElapsedMs(value) {
  const elapsed = Number(value);
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
}

function normalizedErrorCode(value) {
  return String(value || '').trim().toLowerCase().replace(/-/g, '_');
}

export function isTerminalGroupProgressError(error = {}) {
  return [
    error?.code,
    error?.public_code,
    error?.type,
    error?.payload?.code,
    error?.payload?.public_code,
    error?.payload?.error?.code,
  ].some(code => [
    'invalid_token',
    'session_invalid',
    'stale_frontend_asset',
    'service_restart_required',
  ].includes(normalizedErrorCode(code)));
}

function isTerminalGroupProgress(progress = {}) {
  const status = String(progress?.status || '').trim().toLowerCase();
  return progress?.done === true || GROUP_PROGRESS_TERMINAL_STATUSES.has(status);
}

export function createGroupProgressPoller({
  signal = null,
  isCurrent = () => true,
  poll,
  onProgress = () => {},
  onError = () => {},
  intervalMs = 900,
  elapsedIntervalMs = 1_000,
  maxErrorRetries = 20,
  now = () => Date.now(),
  setIntervalFn = globalThis.setInterval,
  clearIntervalFn = globalThis.clearInterval,
} = {}) {
  if (typeof poll !== 'function') throw new TypeError('群列表进度协调器需要 poll 回调');
  let stopped = signal?.aborted === true;
  let timer = null;
  let elapsedTimer = null;
  let pollInFlight = false;
  let transientErrorCount = 0;
  let latestRunningProgress = null;
  let elapsedBaseMs = 0;
  let elapsedBaseAt = 0;
  const errorRetryLimit = Number.isFinite(Number(maxErrorRetries))
    ? Math.max(0, Number(maxErrorRetries))
    : 20;

  function currentTime() {
    try {
      const value = Number(now());
      return Number.isFinite(value) ? value : Date.now();
    } catch {
      return Date.now();
    }
  }

  function isLive() {
    if (stopped || signal?.aborted === true) return false;
    try { return isCurrent() === true; } catch { return false; }
  }

  const onAbort = () => stop();

  function clearElapsedTimer() {
    if (elapsedTimer !== null) {
      clearIntervalFn(elapsedTimer);
      elapsedTimer = null;
    }
    latestRunningProgress = null;
  }

  function elapsedAt(time) {
    return Math.max(elapsedBaseMs, elapsedBaseMs + Math.max(0, time - elapsedBaseAt));
  }

  function projectRunning(progress, elapsedMs) {
    if (!isLive()) {
      stop();
      return false;
    }
    onProgress({
      ...(progress && typeof progress === 'object' && !Array.isArray(progress) ? progress : {}),
      status: 'running',
      elapsed_ms: Math.max(0, Math.round(elapsedMs)),
    });
    return true;
  }

  function startElapsedTimer() {
    if (elapsedTimer !== null || !latestRunningProgress) return;
    elapsedTimer = setIntervalFn(() => {
      if (!isLive() || !latestRunningProgress) {
        stop();
        return;
      }
      projectRunning(latestRunningProgress, elapsedAt(currentTime()));
    }, Math.max(50, Number(elapsedIntervalMs) || 1_000));
  }

  function projectServerProgress(progress) {
    const receivedAt = currentTime();
    const serverElapsed = progressElapsedMs(progress?.elapsed_ms);
    const localElapsed = latestRunningProgress ? elapsedAt(receivedAt) : 0;
    const elapsedMs = Math.max(serverElapsed, localElapsed);
    elapsedBaseMs = elapsedMs;
    elapsedBaseAt = receivedAt;
    latestRunningProgress = progress && typeof progress === 'object' && !Array.isArray(progress)
      ? { ...progress, status: 'running' }
      : { status: 'running' };
    startElapsedTimer();
    return projectRunning(latestRunningProgress, elapsedMs);
  }

  function stop() {
    if (stopped) return false;
    stopped = true;
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
    }
    clearElapsedTimer();
    signal?.removeEventListener?.('abort', onAbort);
    return true;
  }

  async function tick() {
    if (!isLive()) {
      stop();
      return;
    }
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      const progress = await poll();
      if (!isLive()) return;
      transientErrorCount = 0;
      if (isTerminalGroupProgress(progress)) {
        stop();
        return;
      }
      if (String(progress?.status || '').trim().toLowerCase() === 'running') {
        projectServerProgress(progress);
      }
    } catch (error) {
      if (!isLive()) return;
      const terminal = isTerminalGroupProgressError(error);
      if (terminal) stop();
      else {
        transientErrorCount += 1;
        if (transientErrorCount > errorRetryLimit) stop();
      }
      onError(error);
    } finally {
      pollInFlight = false;
    }
  }

  if (!stopped) {
    signal?.addEventListener?.('abort', onAbort, { once: true });
    timer = setIntervalFn(() => { void tick(); }, intervalMs);
  }

  return {
    stop,
    isStopped: () => stopped,
  };
}

export function createGroupLoadScope() {
  let disposed = false;
  let revision = 0;
  let current = null;

  function abortOperation(operation, message) {
    if (!operation || operation.controller.signal.aborted) return;
    operation.controller.abort(groupLoadAbortError(message));
  }

  return {
    begin() {
      if (disposed) throw new Error('群列表加载作用域已销毁');

      const previous = current;
      current = null;
      abortOperation(previous, '群列表加载已被新请求取代');

      const id = ++revision;
      const controller = new AbortController();
      const operation = { id, controller };
      current = operation;

      return {
        signal: controller.signal,
        isCurrent: () => !disposed
          && current?.id === id
          && !controller.signal.aborted,
        finish() {
          if (current?.id !== id) return;
          current = null;
          abortOperation(operation, '群列表加载已结束');
        },
      };
    },

    invalidate(message = '群列表加载已失效') {
      if (disposed) return;
      const operation = current;
      current = null;
      revision += 1;
      abortOperation(operation, message);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      revision += 1;
      const operation = current;
      current = null;
      abortOperation(operation, '群列表页面已卸载');
    },
  };
}
