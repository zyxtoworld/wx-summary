import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../lib/paths.js';
import { PRIVATE_FILE_MODE, ensureDir, syncDirectory, writeFileAtomic } from '../lib/json-store.js';
import { readFileHandleBounded } from '../lib/bounded-read.js';
import { atomicProcessLockOwnerIsComplete, publishAtomicProcessLock, reclaimAtomicProcessLockFile, releaseAtomicProcessLockFile } from '../lib/atomic-process-lock.js';
import { protectText, secretProtectionUnavailable, unprotectToText } from './dpapi.js';
import { processOwnerState, processStartIdentity } from '../wxenv/discovery.js';
import { normalizeAccountIdentityShardEvidenceCacheEntry } from '../wxdb/index.js';

export const WXDB_KEY_CACHE_FILE = path.join(DATA_DIR, 'wxdb-keys.bin');

const CACHE_VERSION = 1;
const MAX_ACCOUNTS = 32;
const MAX_KEYS_PER_ACCOUNT = 50;
const MAX_IDENTITY_EVIDENCE_ENTRIES_PER_ACCOUNT = 24;
const MAX_IDENTITY_EVIDENCE_JSON_BYTES_PER_ACCOUNT = 384 * 1024;
export const MAX_WXDB_KEY_CACHE_FILE_BYTES = 1024 * 1024;
const KEY_CACHE_LOCK_WAIT_MS = 15_000;
const KEY_CACHE_LOCK_HEARTBEAT_MS = 500;
const KEY_CACHE_LOCK_STALE_GRACE_MS = 3_000;
const KEY_CACHE_LOCK_RETRY_MS = 50;
let KEY_CACHE_QUEUE = Promise.resolve();
let KEY_CACHE_INVALID_INFO = null;

export function verifiedWxdbKeyCacheInvalidInfo() {
  return KEY_CACHE_INVALID_INFO ? { ...KEY_CACHE_INVALID_INFO } : null;
}

export function createVerifiedWxdbKeyCacheRevocationTransaction({
  scope = 'account_keys',
  account_id = '',
  file = WXDB_KEY_CACHE_FILE,
  on_settled = null,
} = {}) {
  const normalizedScope = String(scope || '').trim();
  const accountId = normalizeAccountId(account_id);
  if (!['account_keys', 'all'].includes(normalizedScope)) {
    throw Object.assign(new Error('automatic wxdb key cache revocation scope is invalid'), {
      code: 'wxdb_key_cache_revocation_scope_invalid',
    });
  }
  if (normalizedScope === 'account_keys' && !accountId) {
    throw Object.assign(new Error('account-scoped automatic wxdb key cache revocation requires an account id'), {
      code: 'wxdb_key_cache_revocation_account_required',
    });
  }
  if (on_settled !== null && typeof on_settled !== 'function') {
    throw Object.assign(new Error('automatic wxdb key cache settlement callback is invalid'), {
      code: 'wxdb_key_cache_revocation_callback_invalid',
    });
  }

  const transaction = {
    result: null,
    async run(action) {
      if (typeof action !== 'function') {
        throw Object.assign(new Error('automatic wxdb key cache transaction action is required'), {
          code: 'wxdb_key_cache_revocation_action_required',
        });
      }
      return withKeyCacheLock(file, async () => {
        let previous;
        let revocation;
        try {
          previous = normalizeCache(await loadKeyCacheUnlocked(file));
          const next = normalizeCache(previous);
          revocation = revokeVerifiedWxdbKeyCache(next, {
            scope: normalizedScope,
            accountId,
          });
          transaction.result = revocation;
          if (revocation.changed) await saveOrRemoveKeyCacheUnlocked(next, file);
        } catch (cause) {
          const failure = new Error('automatic wxdb key cache revocation failed before settings commit');
          failure.code = 'wxdb_key_cache_revocation_failed';
          failure.public_code = failure.code;
          failure.status = 503;
          failure.cause = cause;
          notifyKeyCacheRevocationSettled(on_settled, { committed: false, revocation: null, error: failure });
          throw failure;
        }

        let value;
        try {
          value = await action(revocation);
        } catch (error) {
          try {
            if (revocation.changed) await saveOrRemoveKeyCacheUnlocked(previous, file);
          } catch (rollbackError) {
            const failure = new Error('automatic wxdb key cache revocation rollback failed');
            failure.code = 'wxdb_key_cache_revocation_rollback_failed';
            failure.public_code = failure.code;
            failure.status = 503;
            failure.cause = error;
            failure.rollback_cause = rollbackError;
            notifyKeyCacheRevocationSettled(on_settled, { committed: false, revocation, error: failure });
            throw failure;
          }
          notifyKeyCacheRevocationSettled(on_settled, { committed: false, revocation, error });
          throw error;
        }
        notifyKeyCacheRevocationSettled(on_settled, { committed: true, revocation, error: null });
        return value;
      });
    },
  };
  return transaction;
}

function revokeVerifiedWxdbKeyCache(cache = {}, { scope = '', accountId = '' } = {}) {
  if (scope === 'all') {
    const records = Object.values(cache.accounts || {});
    const keyCount = records.reduce((sum, record) => sum + normalizeKeys(record?.keys).length, 0);
    const accountCount = Object.keys(cache.accounts || {}).length;
    cache.accounts = {};
    return {
      changed: accountCount > 0,
      scope,
      account_count: accountCount,
      key_count: keyCount,
    };
  }

  const record = cache.accounts?.[accountId];
  const keys = normalizeKeys(record?.keys);
  if (!record || !keys.length) {
    return { changed: false, scope: 'account_keys', account_count: 0, key_count: 0 };
  }
  const identityEvidence = normalizeIdentityEvidenceEntries(accountId, record.identity_shard_evidence);
  if (identityEvidence.length) {
    cache.accounts[accountId] = {
      ...record,
      account_fingerprint: '',
      keys: [],
      verified_at: '',
      identity_shard_evidence: identityEvidence,
    };
  } else {
    delete cache.accounts[accountId];
  }
  return { changed: true, scope: 'account_keys', account_count: 1, key_count: keys.length };
}

function notifyKeyCacheRevocationSettled(callback, payload) {
  if (typeof callback !== 'function') return;
  try {
    callback(payload);
  } catch {}
}

export async function verifiedWxdbKeysForAccount({
  account_id = '',
  account_fingerprint = '',
  file = WXDB_KEY_CACHE_FILE,
} = {}) {
  return withKeyCacheLock(file, async () => {
    const accountId = normalizeAccountId(account_id);
    const accountFingerprint = normalizeAccountFingerprint(account_fingerprint);
    if (!accountId || !accountFingerprint) return [];
    const cache = await loadKeyCacheUnlocked(file);
    const record = cache.accounts[accountId];
    if (!record || record.account_fingerprint !== accountFingerprint) return [];
    return [...record.keys];
  });
}

export async function rememberVerifiedWxdbKeysForAccount({
  account_id = '',
  account_fingerprint = '',
  keys = [],
  file = WXDB_KEY_CACHE_FILE,
  write_if = null,
} = {}) {
  return withKeyCacheLock(file, async () => {
    if (!keyCacheWriteAllowed(write_if)) return { changed: false, key_count: 0, skipped: 'stale_generation' };
    const accountId = normalizeAccountId(account_id);
    const accountFingerprint = normalizeAccountFingerprint(account_fingerprint);
    const verifiedKeys = normalizeKeys(keys);
    if (!accountId || !accountFingerprint || !verifiedKeys.length) {
      return { changed: false, key_count: 0 };
    }
    const cache = await loadKeyCacheUnlocked(file);
    const previous = cache.accounts[accountId];
    const previousKeys = previous?.account_fingerprint === accountFingerprint ? previous.keys : [];
    const nextKeys = normalizeKeys([...verifiedKeys, ...previousKeys]);
    if (previous?.account_fingerprint === accountFingerprint && sameStrings(previous.keys, nextKeys)) {
      return { changed: false, key_count: nextKeys.length };
    }
    cache.accounts[accountId] = {
      ...previous,
      account_fingerprint: accountFingerprint,
      keys: nextKeys,
      verified_at: new Date().toISOString(),
    };
    pruneAccounts(cache.accounts, accountId);
    if (!keyCacheWriteAllowed(write_if)) return { changed: false, key_count: 0, skipped: 'stale_generation' };
    await saveKeyCacheUnlocked(cache, file);
    return { changed: true, key_count: nextKeys.length };
  });
}

export async function persistedWxdbIdentityShardEvidenceForAccount({
  account_id = '',
  file = WXDB_KEY_CACHE_FILE,
} = {}) {
  return withKeyCacheLock(file, async () => {
    const accountId = normalizeIdentityEvidenceAccountId(account_id);
    if (!accountId) return [];
    const cache = await loadKeyCacheUnlocked(file);
    return cloneIdentityEvidenceEntries(cache.accounts[accountId]?.identity_shard_evidence);
  });
}

export async function persistedWxdbIdentityShardEvidence({
  file = WXDB_KEY_CACHE_FILE,
} = {}) {
  return withKeyCacheLock(file, async () => {
    const cache = await loadKeyCacheUnlocked(file);
    const entries = [];
    for (const [accountId, record] of Object.entries(cache.accounts)) {
      entries.push(...normalizeIdentityEvidenceEntries(accountId, record?.identity_shard_evidence));
    }
    return cloneIdentityEvidenceEntries(entries);
  });
}

export async function rememberWxdbIdentityShardEvidenceForAccount({
  account_id = '',
  entries = [],
  file = WXDB_KEY_CACHE_FILE,
  write_if = null,
} = {}) {
  return withKeyCacheLock(file, async () => {
    const accountId = normalizeIdentityEvidenceAccountId(account_id);
    const normalized = normalizeIdentityEvidenceEntries(accountId, entries);
    if (!accountId || !normalized.length || !keyCacheWriteAllowed(write_if)) {
      const cache = accountId ? await loadKeyCacheUnlocked(file) : emptyCache();
      return {
        changed: false,
        entry_count: accountId
          ? normalizeIdentityEvidenceEntries(accountId, cache.accounts[accountId]?.identity_shard_evidence).length
          : 0,
      };
    }
    const cache = await loadKeyCacheUnlocked(file);
    const previous = cache.accounts[accountId] || {};
    const merged = new Map(normalizeIdentityEvidenceEntries(accountId, previous.identity_shard_evidence)
      .map(entry => [entry.cache_key, entry]));
    for (const entry of normalized) {
      merged.delete(entry.cache_key);
      merged.set(entry.cache_key, entry);
    }
    const nextEntries = [...merged.values()].slice(-MAX_IDENTITY_EVIDENCE_ENTRIES_PER_ACCOUNT);
    const previousEntries = normalizeIdentityEvidenceEntries(accountId, previous.identity_shard_evidence);
    if (JSON.stringify(previousEntries) === JSON.stringify(nextEntries)) {
      return { changed: false, entry_count: nextEntries.length };
    }
    cache.accounts[accountId] = {
      ...previous,
      account_fingerprint: normalizeAccountFingerprint(previous.account_fingerprint),
      keys: normalizeKeys(previous.keys),
      verified_at: normalizeTimestamp(previous.verified_at),
      identity_shard_evidence: nextEntries,
      identity_evidence_updated_at: new Date().toISOString(),
    };
    pruneAccounts(cache.accounts, accountId);
    if (!keyCacheWriteAllowed(write_if)) return { changed: false, entry_count: 0, skipped: 'stale_generation' };
    await saveKeyCacheUnlocked(cache, file);
    return { changed: true, entry_count: nextEntries.length };
  });
}

function keyCacheWriteAllowed(writeIf = null) {
  return typeof writeIf !== 'function' || writeIf() !== false;
}

export async function forgetVerifiedWxdbKeysForAccount({
  account_id = '',
  file = WXDB_KEY_CACHE_FILE,
} = {}) {
  return withKeyCacheLock(file, async () => {
    const accountId = normalizeAccountId(account_id);
    if (!accountId) return { changed: false, key_count: 0, remaining_account_count: 0 };
    const cache = await loadKeyCacheUnlocked(file);
    const previous = cache.accounts[accountId];
    if (!previous) {
      return {
        changed: false,
        key_count: 0,
        remaining_account_count: Object.keys(cache.accounts).length,
      };
    }
    const keyCount = previous.keys.length;
    delete cache.accounts[accountId];
    await saveOrRemoveKeyCacheUnlocked(cache, file);
    return {
      changed: true,
      key_count: keyCount,
      remaining_account_count: Object.keys(cache.accounts).length,
    };
  });
}

export async function clearVerifiedWxdbKeyCache({ file = WXDB_KEY_CACHE_FILE } = {}) {
  return withKeyCacheLock(file, async () => {
    const cache = await loadKeyCacheUnlocked(file);
    const accountCount = Object.keys(cache.accounts).length;
    const keyCount = Object.values(cache.accounts).reduce((sum, record) => sum + record.keys.length, 0);
    await removeKeyCacheFileUnlocked(file);
    return { changed: accountCount > 0, account_count: accountCount, key_count: keyCount };
  });
}

export async function resetVerifiedWxdbKeyCache({ file = WXDB_KEY_CACHE_FILE } = {}) {
  return withKeyCacheLock(file, async () => {
    const stat = await fsp.lstat(file).catch(error => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) {
      KEY_CACHE_INVALID_INFO = null;
      return { changed: false, bytes: 0 };
    }
    try {
      assertOrdinaryKeyCacheFile(stat);
    } catch (error) {
      rememberKeyCacheReadFailure(file, error, {
        status: 'invalid_file_type',
        resetAvailable: false,
      });
      throw error;
    }
    const bytes = Math.max(0, Number(stat.size || 0) || 0);
    await removeKeyCacheFileUnlocked(file);
    return { changed: true, bytes };
  });
}

async function withKeyCacheLock(file, action) {
  const runLocked = async () => {
    const release = await acquireKeyCacheFileLock(file);
    try {
      return await action();
    } finally {
      await release();
    }
  };
  const run = KEY_CACHE_QUEUE.then(runLocked, runLocked);
  KEY_CACHE_QUEUE = run.catch(() => {});
  return run;
}

async function acquireKeyCacheFileLock(file) {
  const lockFile = `${path.resolve(String(file || WXDB_KEY_CACHE_FILE))}.lock`;
  const token = crypto.randomUUID();
  const startedAt = Date.now();
  const processStartId = await processStartIdentity(process.pid);
  await ensureDir(path.dirname(lockFile));

  while (true) {
    let acquisition = null;
    let handle = null;
    let heartbeat = null;
    try {
      acquisition = await publishAtomicProcessLock({
        lockPath: lockFile,
        mode: PRIVATE_FILE_MODE,
        owner: {
          version: 1,
          pid: process.pid,
          process_start_id: processStartId,
          token,
          created_at: new Date().toISOString(),
        },
      });
      handle = acquisition.handle;
      heartbeat = setInterval(() => {
        const now = new Date();
        void handle?.utimes(now, now).catch(() => {});
      }, KEY_CACHE_LOCK_HEARTBEAT_MS);
      heartbeat.unref?.();
      return async () => {
        clearInterval(heartbeat);
        heartbeat = null;
        await handle?.close().catch(() => {});
        handle = null;
        return releaseKeyCacheFileLock(lockFile, token);
      };
    } catch (error) {
      clearInterval(heartbeat);
      await handle?.close().catch(() => {});
      if (acquisition) await releaseKeyCacheFileLock(lockFile, token).catch(() => {});
      if (error?.code !== 'EEXIST') throw error;
      if (await reclaimStaleKeyCacheFileLock(lockFile)) continue;
      if (Date.now() - startedAt >= KEY_CACHE_LOCK_WAIT_MS) {
        const timeout = new Error('timed out waiting for automatic wxdb key cache lock');
        timeout.code = 'wxdb_key_cache_lock_timeout';
        throw timeout;
      }
      await delay(KEY_CACHE_LOCK_RETRY_MS + Math.floor(Math.random() * KEY_CACHE_LOCK_RETRY_MS));
    }
  }
}

async function readKeyCacheFileLock(lockFile) {
  const stat = await fsp.lstat(lockFile).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    const error = new Error('automatic wxdb key cache lock path must be an ordinary file');
    error.code = 'wxdb_key_cache_lock_invalid_file_type';
    throw error;
  }
  const raw = await fsp.readFile(lockFile, 'utf8').catch(error => {
    if (error?.code === 'ENOENT') return '';
    throw error;
  });
  let owner = null;
  try {
    const parsed = JSON.parse(raw);
    if (plainObject(parsed)) owner = parsed;
  } catch {}
  return { owner, raw, stat };
}

function keyCacheFileLockIsFresh(observed, now = Date.now()) {
  if (!observed?.stat) return false;
  const ageMs = Math.max(0, Number(now || 0) - Number(observed.stat.mtimeMs || 0));
  return ageMs < KEY_CACHE_LOCK_STALE_GRACE_MS;
}

async function keyCacheLockOwnerMatches(observed = null, {
  processAlive = processIsAlive,
  processStartIdentityFn = processStartIdentity,
} = {}) {
  const owner = observed?.owner;
  if (Math.trunc(Number(owner?.pid || 0)) <= 0 || !String(owner?.token || '').trim()) return false;
  const state = await processOwnerState(owner, { processAlive, processStartIdentityFn });
  return state === 'same' || state === 'unknown';
}

async function reclaimStaleKeyCacheFileLock(lockFile) {
  const observed = await readKeyCacheFileLock(lockFile);
  if (!observed) return true;
  if (!atomicProcessLockOwnerIsComplete(observed.owner)) {
    const error = new Error('automatic wxdb key cache lock contains an incomplete owner and will not be age-reclaimed');
    error.code = 'wxdb_key_cache_lock_owner_incomplete';
    throw error;
  }
  const ownerState = await processOwnerState(observed.owner, {
    processAlive: processIsAlive,
    processStartIdentityFn: processStartIdentity,
  });
  if (!['dead', 'different'].includes(ownerState)) return false;
  return reclaimAtomicProcessLockFile(lockFile, observed, {
    ownerState,
    readLock: readKeyCacheFileLock,
  });
}

async function releaseKeyCacheFileLock(lockFile, token) {
  return releaseAtomicProcessLockFile(lockFile, token, { readLock: readKeyCacheFileLock });
}

function processIsAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function loadKeyCacheUnlocked(file) {
  const stat = await fsp.lstat(file).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return emptyCache();
  try {
    assertOrdinaryKeyCacheFile(stat);
  } catch (error) {
    rememberKeyCacheReadFailure(file, error, {
      status: 'invalid_file_type',
      resetAvailable: false,
    });
    throw error;
  }
  if (stat.size > MAX_WXDB_KEY_CACHE_FILE_BYTES) {
    const error = keyCacheTooLargeError(stat.size);
    rememberKeyCacheReadFailure(file, error, {
      status: 'unsafe_size',
      resetAvailable: true,
    });
    throw error;
  }
  let handle = null;
  let encrypted;
  try {
    handle = await fsp.open(file, 'r');
    const handleStat = await handle.stat();
    assertOrdinaryKeyCacheFile(handleStat);
    encrypted = await readFileHandleBounded(handle, MAX_WXDB_KEY_CACHE_FILE_BYTES, {
      createTooLargeError: bytes => keyCacheTooLargeError(bytes),
    });
  } finally {
    await handle?.close?.().catch(() => {});
  }
  try {
    const text = await unprotectToText(encrypted);
    const parsed = parseKeyCacheText(text);
    KEY_CACHE_INVALID_INFO = null;
    return parsed;
  } catch (error) {
    if (secretProtectionUnavailable(error)) {
      rememberKeyCacheReadFailure(file, error, {
        status: 'unreadable',
        resetAvailable: true,
      });
      throw error;
    }
    let backup = '';
    try {
      backup = await backupInvalidCache(file);
    } catch (backupError) {
      const recoveryError = new Error('automatic wxdb key cache is invalid and could not be preserved');
      recoveryError.code = 'wxdb_key_cache_recovery_failed';
      recoveryError.cause = backupError;
      throw recoveryError;
    }
    KEY_CACHE_INVALID_INFO = {
      status: 'backed_up',
      detected_at: new Date().toISOString(),
      backup_relative_path: keyCacheDisplayPath(backup),
      backup_available: true,
      reset_available: true,
      error: 'automatic wxdb key cache could not be decoded or validated',
    };
    return emptyCache();
  }
}

function rememberKeyCacheReadFailure(file, error, { status = 'unreadable', resetAvailable = false } = {}) {
  KEY_CACHE_INVALID_INFO = {
    status,
    detected_at: new Date().toISOString(),
    active_relative_path: keyCacheDisplayPath(file),
    backup_available: false,
    reset_available: resetAvailable === true,
    error_code: String(error?.public_code || error?.code || error?.secret_protection_code || 'wxdb_key_cache_unreadable').trim(),
    error: 'automatic wxdb key cache is unavailable',
  };
}

async function saveKeyCacheUnlocked(cache, file) {
  const normalized = normalizeCache(cache);
  await ensureDir(path.dirname(file));
  const existing = await fsp.lstat(file).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (existing) assertOrdinaryKeyCacheFile(existing);
  const encrypted = await protectText(JSON.stringify(normalized));
  if (encrypted.length > MAX_WXDB_KEY_CACHE_FILE_BYTES) throw keyCacheTooLargeError(encrypted.length);
  await writeFileAtomic(file, encrypted, { mode: PRIVATE_FILE_MODE });
  KEY_CACHE_INVALID_INFO = null;
}

async function saveOrRemoveKeyCacheUnlocked(cache, file) {
  if (Object.keys(normalizeCache(cache).accounts).length) {
    await saveKeyCacheUnlocked(cache, file);
    return;
  }
  await removeKeyCacheFileUnlocked(file);
}

async function removeKeyCacheFileUnlocked(file) {
  const stat = await fsp.lstat(file).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) {
    KEY_CACHE_INVALID_INFO = null;
    return;
  }
  assertOrdinaryKeyCacheFile(stat);
  await fsp.rm(file, { force: true });
  await syncDirectory(path.dirname(file));
  KEY_CACHE_INVALID_INFO = null;
}

async function backupInvalidCache(file) {
  const stat = await fsp.lstat(file).catch(() => null);
  if (!stat) return;
  assertOrdinaryKeyCacheFile(stat);
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const parsed = path.parse(file);
  const backup = path.join(parsed.dir, `${parsed.name}.invalid.${stamp}.${process.pid}${parsed.ext || '.bin'}`);
  await ensureDir(path.dirname(file));
  await fsp.rename(file, backup);
  await syncDirectory(path.dirname(file));
  return backup;
}

function keyCacheDisplayPath(file = '') {
  const resolved = path.resolve(String(file || ''));
  const relative = path.relative(DATA_DIR, resolved).replace(/\\/g, '/');
  if (relative && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative)) {
    return `data/${relative}`;
  }
  return path.basename(resolved);
}

function assertOrdinaryKeyCacheFile(stat) {
  if (stat?.isFile?.() && !stat?.isSymbolicLink?.()) return;
  const error = new Error('automatic wxdb key cache path must be an ordinary file');
  error.code = 'wxdb_key_cache_invalid_file_type';
  throw error;
}

function keyCacheTooLargeError(bytes = 0) {
  const error = new Error('automatic wxdb key cache exceeds the safe file size limit');
  error.code = 'wxdb_key_cache_file_too_large';
  error.public_code = error.code;
  error.status = 413;
  error.bytes = Math.max(0, Number(bytes || 0) || 0);
  error.max_bytes = MAX_WXDB_KEY_CACHE_FILE_BYTES;
  error.preserve_encrypted_file = true;
  return error;
}

function emptyCache() {
  return { version: CACHE_VERSION, accounts: {} };
}

function normalizeCache(value = {}) {
  const accounts = {};
  if (plainObject(value?.accounts)) {
    for (const [rawAccountId, rawRecord] of Object.entries(value.accounts)) {
      const accountId = normalizeAccountId(rawAccountId);
      const record = normalizeRecord(rawRecord, accountId);
      if (!accountId || !record) continue;
      accounts[accountId] = record;
      if (Object.keys(accounts).length >= MAX_ACCOUNTS) break;
    }
  }
  return { version: CACHE_VERSION, accounts };
}

function parseKeyCacheText(text = '') {
  const value = JSON.parse(String(text || ''));
  if (!plainObject(value) || value.version !== CACHE_VERSION || !plainObject(value.accounts)) {
    const error = new Error('automatic wxdb key cache payload is invalid');
    error.code = 'wxdb_key_cache_invalid_payload';
    throw error;
  }
  const normalized = normalizeCache(value);
  if (Object.keys(normalized.accounts).length !== Object.keys(value.accounts).length) {
    const error = new Error('automatic wxdb key cache account records are invalid');
    error.code = 'wxdb_key_cache_invalid_payload';
    throw error;
  }
  return normalized;
}

function normalizeRecord(value = {}, accountId = '') {
  if (!plainObject(value)) return null;
  const accountFingerprint = normalizeAccountFingerprint(value.account_fingerprint);
  const keys = normalizeKeys(value.keys);
  const identityShardEvidence = normalizeIdentityEvidenceEntries(accountId, value.identity_shard_evidence);
  if ((!accountFingerprint || !keys.length) && !identityShardEvidence.length) return null;
  return {
    account_fingerprint: accountFingerprint && keys.length ? accountFingerprint : '',
    keys: accountFingerprint ? keys : [],
    verified_at: accountFingerprint && keys.length ? normalizeTimestamp(value.verified_at) : '',
    identity_shard_evidence: identityShardEvidence,
    identity_evidence_updated_at: identityShardEvidence.length
      ? normalizeTimestamp(value.identity_evidence_updated_at)
      : '',
  };
}

function normalizeIdentityEvidenceAccountId(value = '') {
  const accountId = String(value || '').trim().toLowerCase();
  return /^wxacc_[a-f0-9]{16}$/.test(accountId) ? accountId : '';
}

function normalizeIdentityEvidenceEntries(accountId = '', value = []) {
  const id = normalizeIdentityEvidenceAccountId(accountId);
  if (!id || !Array.isArray(value)) return [];
  const entries = new Map();
  for (const raw of value.slice(0, MAX_IDENTITY_EVIDENCE_ENTRIES_PER_ACCOUNT * 2)) {
    const entry = normalizeAccountIdentityShardEvidenceCacheEntry(raw, id);
    if (!entry) continue;
    entries.delete(entry.cache_key);
    entries.set(entry.cache_key, entry);
  }
  const candidates = [...entries.values()].slice(-MAX_IDENTITY_EVIDENCE_ENTRIES_PER_ACCOUNT);
  const selected = [];
  let bytes = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const entry = candidates[index];
    const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
    if (entryBytes <= 0 || entryBytes > MAX_IDENTITY_EVIDENCE_JSON_BYTES_PER_ACCOUNT) continue;
    if (bytes + entryBytes > MAX_IDENTITY_EVIDENCE_JSON_BYTES_PER_ACCOUNT) continue;
    selected.push(entry);
    bytes += entryBytes;
  }
  return selected.reverse();
}

function cloneIdentityEvidenceEntries(value = []) {
  return (Array.isArray(value) ? value : []).map(entry => ({
    ...entry,
    support: (Array.isArray(entry?.support) ? entry.support : []).map(row => ({
      ...row,
      peer_hashes: Array.isArray(row?.peer_hashes) ? [...row.peer_hashes] : [],
    })),
  }));
}

function normalizeTimestamp(value = '') {
  const text = String(value || '').trim();
  return text && !Number.isNaN(Date.parse(text)) ? new Date(text).toISOString() : '';
}

function normalizeAccountId(value = '') {
  return String(value || '').trim().slice(0, 200);
}

function normalizeAccountFingerprint(value = '') {
  const text = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : '';
}

function normalizeKeys(value = []) {
  const list = Array.isArray(value) ? value : String(value || '').split(/\r?\n/);
  return [...new Set(list
    .map(item => String(item || '').trim().toLowerCase())
    .filter(item => /^(?:[a-f0-9]{64}|[a-f0-9]{96}|[a-f0-9]{128}|[a-f0-9]{160}|[a-f0-9]{192})$/.test(item)))]
    .slice(0, MAX_KEYS_PER_ACCOUNT);
}

function sameStrings(a = [], b = []) {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function accountCacheActivityTimeMs(record = {}) {
  const verifiedAt = Date.parse(String(record?.verified_at || '').trim());
  const identityUpdatedAt = Date.parse(String(record?.identity_evidence_updated_at || '').trim());
  return Math.max(
    Number.isFinite(verifiedAt) ? verifiedAt : 0,
    Number.isFinite(identityUpdatedAt) ? identityUpdatedAt : 0,
  );
}

function pruneAccounts(accounts, keepAccountId, maxAccounts = MAX_ACCOUNTS) {
  const entries = Object.entries(accounts);
  const limit = Math.max(1, Math.trunc(Number(maxAccounts || 0) || MAX_ACCOUNTS));
  if (entries.length <= limit) return;
  entries
    .filter(([accountId]) => accountId !== keepAccountId)
    .sort((a, b) => {
      const timeDiff = accountCacheActivityTimeMs(a[1]) - accountCacheActivityTimeMs(b[1]);
      if (timeDiff) return timeDiff;
      return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0);
    })
    .slice(0, entries.length - limit)
    .forEach(([accountId]) => delete accounts[accountId]);
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export const __wxdbKeyCacheInternals = {
  acquireKeyCacheFileLock,
  assertOrdinaryKeyCacheFile,
  keyCacheFileLockIsFresh,
  keyCacheLockOwnerMatches,
  keyCacheWriteAllowed,
  accountCacheActivityTimeMs,
  pruneAccounts,
  normalizeCache,
  normalizeKeys,
  parseKeyCacheText,
};
