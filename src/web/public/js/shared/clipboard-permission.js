export const BROWSER_CLIPBOARD_PERMISSION_UPDATED_EVENT = 'wx-summary:clipboard-permission-updated';

export function normalizeClipboardPermissionState(value) {
  const state = String(value || '').trim().toLowerCase();
  return ['granted', 'prompt', 'denied'].includes(state) ? state : 'unknown';
}

export function clipboardPermissionDenied(state) {
  return normalizeClipboardPermissionState(state) === 'denied';
}

function clipboardPermissionAbortError(reason = null) {
  if (reason instanceof Error) return reason;
  const error = new Error('剪贴板权限查询已取消。');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  if (reason !== null && typeof reason !== 'undefined') error.cause = reason;
  return error;
}

export function createClipboardPermissionController({
  navigatorTarget = globalThis.navigator,
  windowTarget = globalThis.window,
  documentTarget = globalThis.document,
  eventTarget = windowTarget,
} = {}) {
  let writeState = 'unknown';
  let readState = 'unknown';
  let disposed = false;
  let refreshRevision = 0;
  const listeners = new Set();

  const reportNotificationError = (label, error) => {
    const consoleTarget = globalThis.console;
    try {
      if (typeof consoleTarget?.error === 'function') {
        consoleTarget.error(label, error);
        return;
      }
    } catch {}
    try {
      if (typeof consoleTarget?.warn === 'function') {
        consoleTarget.warn(label, error);
        return;
      }
    } catch {}
    try { globalThis.reportError?.(error); } catch {}
  };

  const notify = () => {
    if (disposed) return;
    const snapshot = { write: writeState, read: readState };
    for (const listener of [...listeners]) {
      try { listener(snapshot); } catch (error) {
        reportNotificationError('clipboard permission listener failed', error);
      }
    }
    try {
      eventTarget?.dispatchEvent?.(new Event(BROWSER_CLIPBOARD_PERMISSION_UPDATED_EVENT));
    } catch (error) {
      reportNotificationError('clipboard permission event dispatch failed', error);
    }
  };

  async function query(name) {
    try {
      const permission = await navigatorTarget?.permissions?.query?.({ name });
      return normalizeClipboardPermissionState(permission?.state);
    } catch {
      return 'unknown';
    }
  }

  async function refresh({ signal = null } = {}) {
    if (disposed) return { write: writeState, read: readState };
    if (signal?.aborted) throw clipboardPermissionAbortError(signal.reason);
    const revision = ++refreshRevision;
    const refreshPromise = Promise.all([
      query('clipboard-write'),
      query('clipboard-read'),
    ]).then(([nextWrite, nextRead]) => {
      if (disposed || revision !== refreshRevision || signal?.aborted) {
        return { write: writeState, read: readState };
      }
      writeState = nextWrite;
      readState = nextRead;
      notify();
      return { write: writeState, read: readState };
    });
    if (!signal) return refreshPromise;

    let onAbort = null;
    const abortPromise = new Promise((_, reject) => {
      onAbort = () => reject(clipboardPermissionAbortError(signal.reason));
      signal.addEventListener?.('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      return await Promise.race([refreshPromise, abortPromise]);
    } finally {
      signal.removeEventListener?.('abort', onAbort);
    }
  }

  const refreshPermission = () => { void refresh(); };
  const onVisibilityChange = () => {
    if (documentTarget?.visibilityState === 'hidden') return;
    refreshPermission();
  };
  windowTarget?.addEventListener?.('focus', refreshPermission);
  documentTarget?.addEventListener?.('visibilitychange', onVisibilityChange);

  return {
    refresh,
    state: () => ({ write: writeState, read: readState }),
    isWriteDenied: () => clipboardPermissionDenied(writeState),
    isReadGranted: () => readState === 'granted',
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      refreshRevision += 1;
      listeners.clear();
      windowTarget?.removeEventListener?.('focus', refreshPermission);
      documentTarget?.removeEventListener?.('visibilitychange', onVisibilityChange);
    },
  };
}

export async function readBrowserTextClipboardIfAlreadyPermitted({
  navigatorTarget = globalThis.navigator,
  permission = null,
} = {}) {
  if (normalizeClipboardPermissionState(permission) !== 'granted') {
    const error = new Error('未主动申请额外的剪贴板读取权限。');
    error.code = 'BROWSER_CLIPBOARD_READBACK_NOT_PREAUTHORIZED';
    return { value: '', skipped: true, error };
  }
  if (typeof navigatorTarget?.clipboard?.readText !== 'function') {
    const error = new Error('当前浏览器不支持读取剪贴板。');
    error.code = 'BROWSER_CLIPBOARD_READBACK_UNAVAILABLE';
    return { value: '', skipped: true, error };
  }
  try {
    return { value: await navigatorTarget.clipboard.readText(), skipped: false, error: null };
  } catch (error) {
    return { value: '', skipped: false, error };
  }
}
