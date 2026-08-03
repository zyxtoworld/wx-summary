export const BROWSER_CLIPBOARD_JOURNAL_STORAGE_KEY = 'wx-summary.browser-clipboard-journal.v1';
export const BROWSER_CLIPBOARD_JOURNAL_TTL_MS = 5 * 60 * 1000;
export const BROWSER_CLIPBOARD_JOURNAL_MAX_ENTRIES = 40;

export const BROWSER_CLIPBOARD_JOURNAL_ERROR_CODES = Object.freeze({
  invalidEntry: 'browser_clipboard_journal_entry_invalid',
  entryNotFound: 'browser_clipboard_journal_entry_not_found',
  targetConflict: 'browser_clipboard_journal_target_conflict',
  clipboardConflict: 'browser_clipboard_journal_clipboard_conflict',
  writePending: 'browser_clipboard_journal_write_pending',
  storageReadFailed: 'browser_clipboard_journal_storage_read_failed',
  storageWriteFailed: 'browser_clipboard_journal_storage_write_failed',
});

const JOURNAL_VERSION = 1;
const JOURNAL_PHASES = new Set(['prepared', 'browser_submitted', 'browser_committed']);
const MAX_ACTION_ID_CHARS = 80;
const MAX_KIND_CHARS = 80;
const MAX_TARGET_FIELDS = 16;
const MAX_TARGET_KEY_CHARS = 64;
const MAX_TARGET_STRING_CHARS = 1024;
const FORBIDDEN_TARGET_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function journalError(message, { name, code, status, cause = null, details = null } = {}) {
  const error = new Error(message);
  error.name = name;
  error.code = code;
  error.status = status;
  if (cause) error.cause = cause;
  if (details && typeof details === 'object') Object.assign(error, details);
  return error;
}

function invalidEntryError(message = '浏览器剪贴板 journal 条目无效。') {
  return journalError(message, {
    name: 'BrowserClipboardJournalEntryError',
    code: BROWSER_CLIPBOARD_JOURNAL_ERROR_CODES.invalidEntry,
    status: 400,
  });
}

function storageError(operation, cause) {
  const writing = operation === 'write';
  return journalError(
    writing ? '浏览器剪贴板 journal 持久化失败。' : '浏览器剪贴板 journal 读取失败。',
    {
      name: 'BrowserClipboardJournalStorageError',
      code: writing
        ? BROWSER_CLIPBOARD_JOURNAL_ERROR_CODES.storageWriteFailed
        : BROWSER_CLIPBOARD_JOURNAL_ERROR_CODES.storageReadFailed,
      status: 500,
      cause,
      details: { operation },
    },
  );
}

function targetConflictError(actionId) {
  return journalError('相同 action_id 已绑定到不同的浏览器剪贴板目标。', {
    name: 'BrowserClipboardJournalConflictError',
    code: BROWSER_CLIPBOARD_JOURNAL_ERROR_CODES.targetConflict,
    status: 409,
    details: { action_id: actionId },
  });
}

function clipboardConflictError(actionId) {
  return journalError('相同 action_id 已绑定到不同的浏览器剪贴板尺寸。', {
    name: 'BrowserClipboardJournalConflictError',
    code: BROWSER_CLIPBOARD_JOURNAL_ERROR_CODES.clipboardConflict,
    status: 409,
    details: { action_id: actionId },
  });
}

function entryNotFoundError(actionId) {
  return journalError('找不到已 prepare 的浏览器剪贴板 journal 条目。', {
    name: 'BrowserClipboardJournalEntryNotFoundError',
    code: BROWSER_CLIPBOARD_JOURNAL_ERROR_CODES.entryNotFound,
    status: 404,
    details: { action_id: actionId },
  });
}

function writePendingError(entry = null) {
  return journalError('另一个页面的浏览器剪贴板写入仍在等待最终结果，已阻止新写入，避免旧内容稍后覆盖当前内容。', {
    name: 'BrowserClipboardJournalWritePendingError',
    code: BROWSER_CLIPBOARD_JOURNAL_ERROR_CODES.writePending,
    status: 409,
    details: { pending_action_id: String(entry?.action_id || '').trim() },
  });
}

function normalizedRequiredString(value, maxChars) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  if (!normalized || normalized.length > maxChars) return '';
  return normalized;
}

function normalizeTargetValue(value) {
  if (typeof value === 'string') {
    if (!value.length) return undefined;
    return value.slice(0, MAX_TARGET_STRING_CHARS);
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function normalizeBrowserClipboardJournalTarget(target) {
  if (typeof target === 'string') {
    const value = normalizeTargetValue(target);
    return typeof value === 'string' ? value : null;
  }
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null;

  const normalized = {};
  let fieldCount = 0;
  const keys = Object.keys(target)
    .filter(key => key.length > 0 && key.length <= MAX_TARGET_KEY_CHARS && !FORBIDDEN_TARGET_KEYS.has(key))
    .sort();
  for (const key of keys) {
    const value = normalizeTargetValue(target[key]);
    if (typeof value === 'undefined') continue;
    normalized[key] = value;
    fieldCount += 1;
    if (fieldCount >= MAX_TARGET_FIELDS) break;
  }
  return fieldCount ? normalized : null;
}

export function normalizeBrowserClipboardSize(value) {
  const width = Number(value?.width);
  const height = Number(value?.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function timestampMs(value) {
  if (typeof value !== 'string' || !value) return NaN;
  return Date.parse(value);
}

function isoTimestamp(value) {
  return new Date(value).toISOString();
}

function normalizedNow(now) {
  const value = typeof now === 'function' ? Number(now()) : Number(now);
  if (!Number.isFinite(value) || value < 0) throw new TypeError('now 必须返回非负有限时间戳');
  return Math.floor(value);
}

function normalizedLimit(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) throw new TypeError(`${label} 必须是正整数`);
  return normalized;
}

function cloneTarget(target) {
  return typeof target === 'string' ? target : { ...target };
}

function cloneEntry(entry) {
  return {
    action_id: entry.action_id,
    kind: entry.kind,
    target: cloneTarget(entry.target),
    clipboard: entry.clipboard ? { ...entry.clipboard } : null,
    phase: entry.phase,
    at: entry.at,
    updated_at: entry.updated_at,
  };
}

function targetFingerprint(target) {
  return JSON.stringify(target);
}

function normalizeStoredEntry(value, nowMs, ttlMs) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const actionId = normalizedRequiredString(value.action_id, MAX_ACTION_ID_CHARS);
  const kind = normalizedRequiredString(value.kind, MAX_KIND_CHARS);
  const target = normalizeBrowserClipboardJournalTarget(value.target);
  const clipboardProvided = value.clipboard !== undefined && value.clipboard !== null;
  const clipboard = normalizeBrowserClipboardSize(value.clipboard);
  const phase = typeof value.phase === 'string' ? value.phase : '';
  const atMs = timestampMs(value.at);
  const updatedAtMs = timestampMs(value.updated_at);
  if (!actionId || !kind || !target || (clipboardProvided && !clipboard) || !JOURNAL_PHASES.has(phase)) return null;
  if (!Number.isFinite(atMs) || !Number.isFinite(updatedAtMs) || atMs > updatedAtMs || updatedAtMs > nowMs) return null;
  if (nowMs - updatedAtMs > ttlMs) return null;
  return {
    action_id: actionId,
    kind,
    target,
    clipboard,
    phase,
    at: isoTimestamp(atMs),
    updated_at: isoTimestamp(updatedAtMs),
  };
}

function compareEntries(left, right) {
  return timestampMs(left.updated_at) - timestampMs(right.updated_at)
    || timestampMs(left.at) - timestampMs(right.at)
    || left.action_id.localeCompare(right.action_id);
}

function boundedEntries(entries, maxEntries) {
  const sorted = [...entries].sort(compareEntries);
  const submitted = sorted.filter(entry => entry.phase === 'browser_submitted');
  const remaining = sorted.filter(entry => entry.phase !== 'browser_submitted');
  return [...remaining.slice(-Math.max(0, maxEntries - submitted.length)), ...submitted.slice(-maxEntries)]
    .sort(compareEntries)
    .slice(-maxEntries);
}

function serializedJournal(entries) {
  return JSON.stringify({ version: JOURNAL_VERSION, entries });
}

export function restoreBrowserClipboardJournalEntries(rawValue, {
  now = Date.now(),
  ttlMs = BROWSER_CLIPBOARD_JOURNAL_TTL_MS,
  maxEntries = BROWSER_CLIPBOARD_JOURNAL_MAX_ENTRIES,
} = {}) {
  const nowMs = normalizedNow(now);
  const ttl = normalizedLimit(ttlMs, 'ttlMs');
  const capacity = normalizedLimit(maxEntries, 'maxEntries');
  let parsed;
  try {
    parsed = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
  } catch {
    return [];
  }
  if (!parsed || parsed.version !== JOURNAL_VERSION || !Array.isArray(parsed.entries)) return [];

  const entriesByActionId = new Map();
  const conflictingActionIds = new Set();
  for (const rawEntry of parsed.entries) {
    const entry = normalizeStoredEntry(rawEntry, nowMs, ttl);
    if (!entry || conflictingActionIds.has(entry.action_id)) continue;
    const previous = entriesByActionId.get(entry.action_id);
    if (previous && (
      previous.kind !== entry.kind
      || targetFingerprint(previous.target) !== targetFingerprint(entry.target)
    )) {
      entriesByActionId.delete(entry.action_id);
      conflictingActionIds.add(entry.action_id);
      continue;
    }
    if (!previous || compareEntries(previous, entry) <= 0) entriesByActionId.set(entry.action_id, entry);
  }
  return boundedEntries(entriesByActionId.values(), capacity).map(cloneEntry);
}

function resolveStorage(providedStorage) {
  let storage = providedStorage;
  if (typeof storage === 'undefined') {
    try {
      storage = globalThis.localStorage;
    } catch (cause) {
      throw storageError('read', cause);
    }
  }
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    throw storageError('read', new TypeError('Storage 必须实现 getItem 和 setItem'));
  }
  return storage;
}

export function createBrowserClipboardJournal({
  storage: providedStorage,
  storageKey = BROWSER_CLIPBOARD_JOURNAL_STORAGE_KEY,
  now = () => Date.now(),
  ttlMs = BROWSER_CLIPBOARD_JOURNAL_TTL_MS,
  maxEntries = BROWSER_CLIPBOARD_JOURNAL_MAX_ENTRIES,
} = {}) {
  const storage = resolveStorage(providedStorage);
  const key = normalizedRequiredString(storageKey, 512);
  if (!key) throw new TypeError('storageKey 必须是非空字符串');
  const ttl = normalizedLimit(ttlMs, 'ttlMs');
  const capacity = normalizedLimit(maxEntries, 'maxEntries');
  let entries = [];

  const persist = nextEntries => {
    try {
      storage.setItem(key, serializedJournal(nextEntries));
    } catch (cause) {
      throw storageError('write', cause);
    }
  };

  const readStoredEntries = () => {
    let rawValue;
    try {
      rawValue = storage.getItem(key);
    } catch (cause) {
      throw storageError('read', cause);
    }
    return {
      rawValue,
      restored: restoreBrowserClipboardJournalEntries(rawValue, {
        now: normalizedNow(now),
        ttlMs: ttl,
        maxEntries: capacity,
      }),
    };
  };

  const restore = () => {
    const { rawValue, restored } = readStoredEntries();
    if (rawValue !== null && rawValue !== serializedJournal(restored)) persist(restored);
    entries = restored;
    return restored.map(cloneEntry);
  };

  const get = actionId => {
    const normalizedActionId = normalizedRequiredString(actionId, MAX_ACTION_ID_CHARS);
    entries = readStoredEntries().restored;
    const entry = entries.find(item => item.action_id === normalizedActionId);
    return entry ? cloneEntry(entry) : null;
  };

  const list = () => {
    entries = readStoredEntries().restored;
    return entries.map(cloneEntry);
  };

  const assertWriteIdle = (actionId = '') => {
    const normalizedActionId = normalizedRequiredString(actionId, MAX_ACTION_ID_CHARS);
    const current = readStoredEntries().restored;
    entries = current;
    const pending = current.find(item => item.phase === 'browser_submitted' && item.action_id !== normalizedActionId);
    if (pending) throw writePendingError(pending);
    return true;
  };

  const prepare = value => {
    const actionId = normalizedRequiredString(value?.action_id, MAX_ACTION_ID_CHARS);
    const kind = normalizedRequiredString(value?.kind, MAX_KIND_CHARS);
    const target = normalizeBrowserClipboardJournalTarget(value?.target);
    const clipboardProvided = value?.clipboard !== undefined && value?.clipboard !== null;
    const clipboard = normalizeBrowserClipboardSize(value?.clipboard);
    if (!actionId || !kind || !target || (clipboardProvided && !clipboard)) throw invalidEntryError();

    const nowMs = normalizedNow(now);
    const current = readStoredEntries().restored.filter(item => nowMs - timestampMs(item.updated_at) <= ttl);
    const existing = current.find(item => item.action_id === actionId);
    if (existing) {
      if (targetFingerprint(existing.target) !== targetFingerprint(target) || existing.kind !== kind) {
        throw targetConflictError(actionId);
      }
      if (existing.clipboard && clipboard && (
        existing.clipboard.width !== clipboard.width
        || existing.clipboard.height !== clipboard.height
      )) {
        throw clipboardConflictError(actionId);
      }
      const prepared = !existing.clipboard && clipboard
        ? { ...existing, clipboard, updated_at: isoTimestamp(Math.max(nowMs, timestampMs(existing.updated_at))) }
        : existing;
      const nextEntries = prepared === existing
        ? current
        : current.map(item => item.action_id === actionId ? prepared : item);
      persist(nextEntries);
      entries = nextEntries;
      return cloneEntry(prepared);
    }

    const timestamp = isoTimestamp(nowMs);
    const entry = {
      action_id: actionId,
      kind,
      target,
      clipboard,
      phase: 'prepared',
      at: timestamp,
      updated_at: timestamp,
    };
    const nextEntries = boundedEntries([...current, entry], capacity);
    persist(nextEntries);
    entries = nextEntries;
    return cloneEntry(entry);
  };

  const markBrowserCommitted = (actionId, { clipboard: clipboardValue = null } = {}) => {
    const normalizedActionId = normalizedRequiredString(actionId, MAX_ACTION_ID_CHARS);
    const clipboardProvided = clipboardValue !== undefined && clipboardValue !== null;
    const clipboard = normalizeBrowserClipboardSize(clipboardValue);
    if (!normalizedActionId || (clipboardProvided && !clipboard)) throw invalidEntryError();
    const nowMs = normalizedNow(now);
    const current = readStoredEntries().restored.filter(item => nowMs - timestampMs(item.updated_at) <= ttl);
    const index = current.findIndex(item => item.action_id === normalizedActionId);
    if (index < 0) {
      entries = current;
      throw entryNotFoundError(normalizedActionId);
    }
    const existing = current[index];
    if (existing.clipboard && clipboard && (
      existing.clipboard.width !== clipboard.width
      || existing.clipboard.height !== clipboard.height
    )) {
      throw clipboardConflictError(normalizedActionId);
    }
    if (existing.phase === 'browser_committed') {
      const committed = !existing.clipboard && clipboard ? { ...existing, clipboard } : existing;
      const nextEntries = committed === existing
        ? current
        : current.map(item => item.action_id === normalizedActionId ? committed : item);
      persist(nextEntries);
      entries = nextEntries;
      return cloneEntry(committed);
    }

    const committed = {
      ...existing,
      clipboard: clipboard || existing.clipboard || null,
      phase: 'browser_committed',
      updated_at: isoTimestamp(Math.max(nowMs, timestampMs(existing.updated_at))),
    };
    const nextEntries = [...current];
    nextEntries[index] = committed;
    const bounded = boundedEntries(nextEntries, capacity);
    persist(bounded);
    entries = bounded;
    return cloneEntry(committed);
  };

  const markBrowserSubmitted = actionId => {
    const normalizedActionId = normalizedRequiredString(actionId, MAX_ACTION_ID_CHARS);
    if (!normalizedActionId) throw invalidEntryError();
    const nowMs = normalizedNow(now);
    const current = readStoredEntries().restored.filter(item => nowMs - timestampMs(item.updated_at) <= ttl);
    const index = current.findIndex(item => item.action_id === normalizedActionId);
    if (index < 0) {
      entries = current;
      throw entryNotFoundError(normalizedActionId);
    }
    const pending = current.find(item => item.phase === 'browser_submitted' && item.action_id !== normalizedActionId);
    if (pending) {
      entries = current;
      throw writePendingError(pending);
    }
    const existing = current[index];
    if (existing.phase === 'browser_submitted') {
      entries = current;
      return cloneEntry(existing);
    }
    if (existing.phase !== 'prepared') throw invalidEntryError('只有已 prepare 的浏览器剪贴板动作可以提交写入。');
    const submitted = {
      ...existing,
      phase: 'browser_submitted',
      updated_at: isoTimestamp(Math.max(nowMs, timestampMs(existing.updated_at))),
    };
    const nextEntries = [...current];
    nextEntries[index] = submitted;
    const bounded = boundedEntries(nextEntries, capacity);
    persist(bounded);
    entries = bounded;
    return cloneEntry(submitted);
  };

  const releaseBrowserSubmitted = actionId => {
    const normalizedActionId = normalizedRequiredString(actionId, MAX_ACTION_ID_CHARS);
    if (!normalizedActionId) throw invalidEntryError();
    const nowMs = normalizedNow(now);
    const current = readStoredEntries().restored.filter(item => nowMs - timestampMs(item.updated_at) <= ttl);
    const index = current.findIndex(item => item.action_id === normalizedActionId);
    if (index < 0) {
      entries = current;
      return false;
    }
    const existing = current[index];
    if (existing.phase !== 'browser_submitted') {
      entries = current;
      return false;
    }
    const prepared = {
      ...existing,
      phase: 'prepared',
      updated_at: isoTimestamp(Math.max(nowMs, timestampMs(existing.updated_at))),
    };
    const nextEntries = [...current];
    nextEntries[index] = prepared;
    persist(nextEntries);
    entries = nextEntries;
    return true;
  };

  const remove = actionId => {
    const normalizedActionId = normalizedRequiredString(actionId, MAX_ACTION_ID_CHARS);
    const current = readStoredEntries().restored;
    const nextEntries = current.filter(item => item.action_id !== normalizedActionId);
    if (nextEntries.length === current.length) {
      entries = current;
      return false;
    }
    persist(nextEntries);
    entries = nextEntries;
    return true;
  };

  restore();
  return Object.freeze({
    prepare,
    assertWriteIdle,
    markBrowserSubmitted,
    releaseBrowserSubmitted,
    markBrowserCommitted,
    markCommitted: markBrowserCommitted,
    remove,
    restore,
    get,
    list,
  });
}

export default createBrowserClipboardJournal;
