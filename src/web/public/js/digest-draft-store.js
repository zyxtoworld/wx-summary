export const DIGEST_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const DIGEST_DRAFT_SCHEMA_VERSION = 1;
const DIGEST_DRAFT_MAX_ENTRIES = 24;
const DIGEST_DRAFT_MAX_GROUPS = 200;
const DIGEST_DRAFT_MAX_FILTER_VALUES = 100;
const DIGEST_DRAFT_MAX_MIN_MESSAGES = 9999;
const DIGEST_DRAFT_RANGE_KEYS = new Set([
  'today',
  'yesterday',
  'yesterdayToday',
  'last4h',
  'last12h',
  'last1d',
  'thisweek',
  'custom',
]);
const DIGEST_DRAFT_EXCLUDE_TYPES = new Set(['image', 'voice', 'video', 'file']);

function boundedText(value, maxChars = 320) {
  return String(value || '').trim().slice(0, maxChars);
}

function boundedIdentity(value, maxChars) {
  const text = String(value || '').trim();
  return text && text.length <= maxChars ? text : '';
}

function normalizedDateTime(value) {
  const text = boundedText(value, 32).replace('T', ' ');
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return '';
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0'] = match;
  const parts = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const [year, month, day, hour, minute, second] = parts;
  const date = new Date(year, month - 1, day, hour, minute, second, 0);
  if (date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
    || date.getHours() !== hour
    || date.getMinutes() !== minute
    || date.getSeconds() !== second) return '';
  return secondText === '0' && !match[6]
    ? `${yearText}-${monthText}-${dayText} ${hourText}:${minuteText}`
    : `${yearText}-${monthText}-${dayText} ${hourText}:${minuteText}:${secondText}`;
}

function boundedUniqueList(value, { maxItems, maxChars, allowed = null } = {}) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const clean = boundedText(item, maxChars);
    if (!clean || seen.has(clean) || (allowed && !allowed.has(clean))) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizedDraft(value = {}, { savedAt = Date.now(), accountFingerprint = '' } = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const filters = source.filters && typeof source.filters === 'object' && !Array.isArray(source.filters)
    ? source.filters
    : {};
  const rangeKey = boundedText(source.range_key, 32);
  const minMessages = Math.max(1, Math.min(
    DIGEST_DRAFT_MAX_MIN_MESSAGES,
    Number.parseInt(String(source.min_messages ?? 1), 10) || 1,
  ));
  return {
    version: DIGEST_DRAFT_SCHEMA_VERSION,
    saved_at: Math.max(1, Number(savedAt || Date.now()) || Date.now()),
    account_fingerprint: boundedText(accountFingerprint || source.account_fingerprint, 320).toLowerCase(),
    selected_group_ids: boundedUniqueList(source.selected_group_ids, {
      maxItems: DIGEST_DRAFT_MAX_GROUPS,
      maxChars: 320,
    }),
    range_key: DIGEST_DRAFT_RANGE_KEYS.has(rangeKey) ? rangeKey : 'yesterdayToday',
    custom_since: normalizedDateTime(source.custom_since),
    custom_until: normalizedDateTime(source.custom_until),
    filters: {
      senders: boundedUniqueList(filters.senders, {
        maxItems: DIGEST_DRAFT_MAX_FILTER_VALUES,
        maxChars: 120,
      }),
      keywords: boundedUniqueList(filters.keywords, {
        maxItems: DIGEST_DRAFT_MAX_FILTER_VALUES,
        maxChars: 120,
      }),
      exclude_types: boundedUniqueList(filters.exclude_types, {
        maxItems: DIGEST_DRAFT_EXCLUDE_TYPES.size,
        maxChars: 32,
        allowed: DIGEST_DRAFT_EXCLUDE_TYPES,
      }),
      pending_senders: boundedText(filters.pending_senders, 500),
      pending_keywords: boundedText(filters.pending_keywords, 500),
    },
    min_messages: minMessages,
  };
}

function normalizeStoredDraft(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Number(value.version) !== DIGEST_DRAFT_SCHEMA_VERSION) return null;
  const savedAt = Number(value.saved_at || 0);
  if (!Number.isFinite(savedAt) || savedAt <= 0 || now - savedAt > DIGEST_DRAFT_MAX_AGE_MS) return null;
  return normalizedDraft(value, {
    savedAt,
    accountFingerprint: value.account_fingerprint,
  });
}

function emptyContainer() {
  return { version: DIGEST_DRAFT_SCHEMA_VERSION, entries: {} };
}

function parsedContainer(raw = '') {
  if (!raw) return emptyContainer();
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyContainer();
  if (Number(value.version) !== DIGEST_DRAFT_SCHEMA_VERSION) return emptyContainer();
  const entries = value.entries && typeof value.entries === 'object' && !Array.isArray(value.entries)
    ? value.entries
    : {};
  return { version: DIGEST_DRAFT_SCHEMA_VERSION, entries };
}

export function readDigestDraftSnapshot(storage, storageKey, scopeIdentity, {
  accountFingerprint = '',
  now = Date.now(),
} = {}) {
  const key = boundedIdentity(storageKey, 1024);
  const scope = boundedIdentity(scopeIdentity, 2048);
  if (!storage || !key || !scope) return { ok: true, draft: null };
  try {
    let container;
    try {
      container = parsedContainer(storage.getItem(key) || '');
    } catch (error) {
      if (error instanceof SyntaxError) {
        storage.removeItem(key);
        return { ok: true, draft: null };
      }
      throw error;
    }
    const draft = normalizeStoredDraft(container.entries[scope], now);
    if (!draft) return { ok: true, draft: null };
    const expectedFingerprint = boundedText(accountFingerprint, 320).toLowerCase();
    if (expectedFingerprint
      && draft.account_fingerprint
      && expectedFingerprint !== draft.account_fingerprint) {
      return { ok: true, draft: null };
    }
    return { ok: true, draft };
  } catch {
    return { ok: false, draft: null };
  }
}

export function writeDigestDraftSnapshot(storage, storageKey, scopeIdentity, draft, {
  accountFingerprint = '',
  now = Date.now(),
} = {}) {
  const key = boundedIdentity(storageKey, 1024);
  const scope = boundedIdentity(scopeIdentity, 2048);
  if (!storage || !key || !scope) return false;
  try {
    let container;
    try {
      container = parsedContainer(storage.getItem(key) || '');
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      container = emptyContainer();
    }
    const entries = {};
    const candidates = Object.entries(container.entries)
      .map(([entryScope, entry]) => [boundedIdentity(entryScope, 2048), normalizeStoredDraft(entry, now)])
      .filter(([entryScope, entry]) => !!entryScope && entryScope !== scope && !!entry);
    candidates.push([scope, normalizedDraft(draft, { savedAt: now, accountFingerprint })]);
    candidates
      .sort((left, right) => Number(right[1].saved_at || 0) - Number(left[1].saved_at || 0))
      .forEach(([entryScope, entry]) => {
        if (Object.hasOwn(entries, entryScope) || Object.keys(entries).length >= DIGEST_DRAFT_MAX_ENTRIES) return;
        entries[entryScope] = entry;
      });
    storage.setItem(key, JSON.stringify({ version: DIGEST_DRAFT_SCHEMA_VERSION, entries }));
    return true;
  } catch {
    return false;
  }
}

export function digestDraftHasMeaningfulInput(value = {}) {
  const draft = normalizedDraft(value);
  return draft.selected_group_ids.length > 0
    || draft.range_key !== 'yesterdayToday'
    || draft.filters.senders.length > 0
    || draft.filters.keywords.length > 0
    || draft.filters.exclude_types.length > 0
    || !!draft.filters.pending_senders
    || !!draft.filters.pending_keywords
    || draft.min_messages !== 1;
}
