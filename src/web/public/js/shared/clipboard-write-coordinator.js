let pendingBrowserWrite = null;
let nextBrowserWriteId = 1;
const BROWSER_CLIPBOARD_LOCK_NAME = 'wx-summary:browser-clipboard-write:v1';

function clipboardWritePendingError(action = '剪贴板写入') {
  const pendingAction = String(pendingBrowserWrite?.action || '上一次浏览器剪贴板写入').trim();
  return Object.assign(new Error(`${pendingAction}仍在等待浏览器最终结果；已阻止${action}，避免较晚完成的旧写入覆盖新内容。请稍后重试，长时间无结果时刷新页面。`), {
    name: 'ClipboardWritePendingError',
    code: 'BROWSER_CLIPBOARD_WRITE_PENDING',
    clipboard_write_pending: true,
  });
}

function crossContextClipboardWritePendingError(action = '新的剪贴板写入') {
  const error = clipboardWritePendingError(action);
  error.message = `另一个页面的浏览器剪贴板写入仍在等待最终结果；已阻止${action}，避免较晚完成的旧写入覆盖新内容。请稍后重试，长时间无结果时刷新占用写入的页面。`;
  error.browser_clipboard_cross_context_pending = true;
  return error;
}

function clipboardWriteLockUnavailableError() {
  return Object.assign(new Error('当前浏览器无法建立跨页面剪贴板写入锁；已停止异步浏览器写入，请改用系统剪贴板或下载文件。'), {
    name: 'ClipboardWriteLockUnavailableError',
    code: 'BROWSER_CLIPBOARD_LOCK_UNAVAILABLE',
  });
}

function clipboardWriteOutcomeUnknownError(action = '浏览器剪贴板写入', reason = 'timeout', cause = null, completion = null) {
  const reasonText = reason === 'abort' ? '页面已取消等待' : '超过等待时间';
  const error = Object.assign(new Error(`${action}${reasonText}，但浏览器已接收写入请求，最终是否成功仍未知；已禁止自动回退，避免旧写入稍后覆盖新内容。请等待后粘贴确认，长时间无结果时刷新页面。`), {
    name: 'ClipboardWriteOutcomeUnknownError',
    code: 'BROWSER_CLIPBOARD_OUTCOME_UNKNOWN',
    clipboard_outcome_unknown: true,
    clipboard_write_submitted: true,
    reason,
    cause,
  });
  if (completion && typeof completion.then === 'function') error.clipboard_write_completion = completion;
  return error;
}

export function browserClipboardWriteOutcomeUnknown(error = null) {
  return error?.clipboard_outcome_unknown === true
    || String(error?.code || '').trim() === 'BROWSER_CLIPBOARD_OUTCOME_UNKNOWN';
}

export function observeBrowserClipboardWriteCompletion(completion, {
  onFulfilled = null,
  onRejected = null,
  onObserverError = null,
} = {}) {
  if (!completion || typeof completion.then !== 'function') return false;
  void Promise.resolve(completion)
    .then(
      value => (typeof onFulfilled === 'function' ? onFulfilled(value) : undefined),
      error => {
        if (typeof onRejected === 'function') return onRejected(error);
        throw error;
      },
    )
    .catch(error => {
      if (typeof onObserverError !== 'function') return;
      try { onObserverError(error); } catch {}
    });
  return true;
}

export function assertClipboardWriteIdle(action = '新的剪贴板写入') {
  if (pendingBrowserWrite) throw clipboardWritePendingError(action);
}

export function browserClipboardWritePending() {
  return !!pendingBrowserWrite;
}

export function browserClipboardWriteLockSupported(lockManager = globalThis.navigator?.locks) {
  return typeof lockManager?.request === 'function';
}

export function submitBrowserClipboardWrite(operation, {
  signal = null,
  timeoutMs = 5000,
  action = '浏览器剪贴板写入',
} = {}) {
  assertClipboardWriteIdle(action);
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : Object.assign(new Error(`${action}已取消。`), { name: 'AbortError', code: 'ABORT_ERR' });
  }

  let actualPromise;
  try {
    actualPromise = Promise.resolve(operation());
  } catch (error) {
    throw error;
  }

  const id = nextBrowserWriteId++;
  pendingBrowserWrite = { id, action, promise: actualPromise };
  const clearPending = () => {
    if (pendingBrowserWrite?.id === id) pendingBrowserWrite = null;
  };
  actualPromise.then(clearPending, clearPending);

  return new Promise((resolve, reject) => {
    let observed = false;
    let timer = null;
    const finish = (callback, value) => {
      if (observed) return;
      observed = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(
      reject,
      clipboardWriteOutcomeUnknownError(action, 'abort', signal?.reason || null, actualPromise),
    );
    timer = setTimeout(
      () => finish(reject, clipboardWriteOutcomeUnknownError(action, 'timeout', null, actualPromise)),
      Math.max(1, Number(timeoutMs || 0) || 5000),
    );
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    actualPromise.then(
      value => finish(resolve, value),
      error => finish(reject, error),
    );
  });
}

export function submitBrowserClipboardWriteLocked(operation, {
  lockManager = globalThis.navigator?.locks || null,
  onLockAcquired = null,
  ...writeOptions
} = {}) {
  if (!browserClipboardWriteLockSupported(lockManager)) {
    return Promise.reject(clipboardWriteLockUnavailableError());
  }

  let startedSettled = false;
  let resolveStarted;
  let rejectStarted;
  const started = new Promise((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  const settleStarted = (callback, value) => {
    if (startedSettled) return;
    startedSettled = true;
    callback(value);
  };

  let lockRequest;
  try {
    lockRequest = lockManager.request(
      BROWSER_CLIPBOARD_LOCK_NAME,
      {
        mode: 'exclusive',
        ifAvailable: true,
        ...(writeOptions.signal ? { signal: writeOptions.signal } : {}),
      },
      async lock => {
        if (!lock) {
          settleStarted(rejectStarted, crossContextClipboardWritePendingError(writeOptions.action));
          return;
        }
        let actualCompletion = null;
        try {
          if (typeof onLockAcquired === 'function') onLockAcquired();
          const observed = submitBrowserClipboardWrite(() => {
            actualCompletion = Promise.resolve(operation());
            return actualCompletion;
          }, writeOptions);
          settleStarted(resolveStarted, observed);
          try {
            await actualCompletion;
          } catch {}
        } catch (error) {
          settleStarted(rejectStarted, error);
        }
      },
    );
  } catch (error) {
    settleStarted(rejectStarted, error);
    return started;
  }
  void Promise.resolve(lockRequest).catch(error => settleStarted(rejectStarted, error));
  return started;
}
