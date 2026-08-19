import { publicAccountAliases, publicAccountId } from './account-context.js';

export const DB_MIRROR_AUTO_FAILURE_STORAGE_KEY = 'wx-summary:db-mirror-auto-failure';
export const DB_MIRROR_AUTO_FAILURE_VISIBLE_MS = 7 * 24 * 60 * 60 * 1000;
export const DB_MIRROR_DIAGNOSTICS_FAILURE_COUNT = 2;

const MIRROR_FAILURE_CODES = new Set([
  'wxdb_prepare_timeout',
  'db_key_runtime_state_changed',
  'db_copy_required',
  'manual_key_account_mirror_not_ready',
  'manual_key_account_mirror_not_ready_after_validation',
]);

function clean(value) {
  return String(value || '').trim();
}

function cleanFingerprint(value) {
  return clean(value).toLowerCase();
}

function accountAliasesForValue(value, accounts = []) {
  const reference = clean(value);
  if (!reference) return [];
  const matched = (Array.isArray(accounts) ? accounts : []).find(account =>
    publicAccountAliases(account).includes(reference));
  return matched ? publicAccountAliases(matched) : [reference];
}

export function dbMirrorFailureAccountIdFromError(error = {}, accounts = []) {
  const accountReference = error?.account && typeof error.account === 'object'
    ? (error.account.id || error.account.account_id || error.account.wxid || '')
    : error?.account;
  const reference = error?.account_id
    || error?.selected_account_id
    || error?.requested_account_id
    || accountReference
    || error?.wxid
    || '';
  const aliases = accountAliasesForValue(reference, accounts);
  const matched = (Array.isArray(accounts) ? accounts : []).find(account =>
    publicAccountAliases(account).some(alias => aliases.includes(alias)));
  return publicAccountId(matched) || clean(reference);
}

export function isDbMirrorFailure(error = {}) {
  const code = clean(error?.code || error?.public_code);
  if (code === 'wxdb_source_account_missing' || code === 'wxdb_source_account_ambiguous') return false;
  return MIRROR_FAILURE_CODES.has(code)
    || code.startsWith('wxdb_mirror_')
    || code.startsWith('wxdb_source_')
    || code.startsWith('wxdb_temp_copy_');
}

function canonicalAccountId(value, accounts = []) {
  const reference = clean(value);
  if (!reference) return '';
  const matched = (Array.isArray(accounts) ? accounts : []).find(account =>
    publicAccountAliases(account).includes(reference));
  return publicAccountId(matched) || reference;
}

export function dbMirrorFailureStorageKey(
  accountId = '',
  { accounts = [], accountFingerprint = '' } = {},
) {
  const canonical = canonicalAccountId(accountId, accounts);
  if (!canonical) return '';
  const fingerprint = cleanFingerprint(accountFingerprint);
  return fingerprint
    ? `${DB_MIRROR_AUTO_FAILURE_STORAGE_KEY}:${canonical}:${encodeURIComponent(fingerprint)}`
    : `${DB_MIRROR_AUTO_FAILURE_STORAGE_KEY}:${canonical}`;
}

function accountMatches(record = {}, accountId = '', accounts = [], accountFingerprint = '') {
  const saved = clean(record.account_id);
  const current = clean(accountId);
  if (!saved || !current) return false;
  if (cleanFingerprint(record.account_fingerprint) !== cleanFingerprint(accountFingerprint)) return false;
  const savedAliases = new Set(accountAliasesForValue(saved, accounts));
  return accountAliasesForValue(current, accounts).some(alias => savedAliases.has(alias));
}

function storageOrNull(storage) {
  if (storage && typeof storage.getItem === 'function'
    && typeof storage.setItem === 'function'
    && typeof storage.removeItem === 'function') return storage;
  return null;
}

function safeMessage(error) {
  return clean(error?.message || '').replace(/[\r\n\t]+/g, ' ').slice(0, 240);
}

export function readDbMirrorAutoFailure({
  storage = globalThis.localStorage,
  accountId = '',
  accounts = [],
  accountFingerprint = '',
  now = Date.now(),
} = {}) {
  const target = storageOrNull(storage);
  const key = dbMirrorFailureStorageKey(accountId, { accounts, accountFingerprint });
  if (!target || !key) return null;
  try {
    const raw = target.getItem(key);
    if (!raw) return null;
    const record = JSON.parse(raw);
    const timestamp = Number(record?.ts || 0) || 0;
    if (!timestamp || Number(now) - timestamp > DB_MIRROR_AUTO_FAILURE_VISIBLE_MS) {
      target.removeItem(key);
      return null;
    }
    return accountMatches(record, accountId, accounts, accountFingerprint) ? record : null;
  } catch {
    return null;
  }
}

export function rememberDbMirrorAutoFailure(
  error = {},
  accountId = '',
  {
    storage = globalThis.localStorage,
    accounts = [],
    accountFingerprint = '',
    now = Date.now(),
  } = {},
) {
  if (!isDbMirrorFailure(error)) return null;
  const explicitAccount = clean(accountId) || dbMirrorFailureAccountIdFromError(error, accounts);
  const fingerprint = cleanFingerprint(accountFingerprint);
  const key = dbMirrorFailureStorageKey(explicitAccount, { accounts, accountFingerprint: fingerprint });
  const canonical = canonicalAccountId(explicitAccount, accounts);
  const target = storageOrNull(storage);
  if (!target || !key || !canonical) return null;
  try {
    const previous = readDbMirrorAutoFailure({
      storage: target,
      accountId: canonical,
      accounts,
      accountFingerprint: fingerprint,
      now,
    });
    const timestamp = Number(now) || Date.now();
    const record = {
      ts: timestamp,
      first_ts: Number(previous?.first_ts || 0) || timestamp,
      count: Number(previous?.count || 0) + 1,
      account_id: canonical,
      account_fingerprint: fingerprint,
      code: clean(error?.code || error?.public_code),
      message: safeMessage(error),
    };
    target.setItem(key, JSON.stringify(record));
    return record;
  } catch {
    return null;
  }
}

export function clearDbMirrorAutoFailure({
  storage = globalThis.localStorage,
  accountId = '',
  accounts = [],
  accountFingerprint = '',
} = {}) {
  const target = storageOrNull(storage);
  const key = dbMirrorFailureStorageKey(accountId, { accounts, accountFingerprint });
  if (!target || !key) return false;
  try {
    target.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function dbMirrorDiagnosticsReady(record = null) {
  return !!record && Number(record.count || 0) >= DB_MIRROR_DIAGNOSTICS_FAILURE_COUNT;
}
