import { fork } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WXDB_TMP_DIR, assertSafeTmpPath } from '../lib/paths.js';
import { terminateWindowsProcessTree } from '../renderer/windows-process-tree.js';
import { logWarn } from '../lib/logger.js';
import { persistedWxdbIdentityShardEvidence, persistedWxdbIdentityShardEvidenceForAccount, rememberWxdbIdentityShardEvidenceForAccount } from '../config/wxdb-key-cache.js';
import { cleanupWxDbWorkerPlaintextCaches, normalizeAccountIdentityShardEvidenceCacheEntry } from './index.js';

const MESSAGE_WORKER_FILE = fileURLToPath(new URL('./message-worker.js', import.meta.url));
const WORKER_STDERR_MAX_BYTES = 64 * 1024;
const WXDB_WORKER_TIMEOUT_MS = Object.freeze({
  collect: 4 * 60 * 1000,
  groups: 3 * 60 * 1000,
  probe: 3 * 60 * 1000,
  identity: 3 * 60 * 1000,
});
const DB_COPY_ROOT = path.join(WXDB_TMP_DIR, 'db');
const MEDIA_COPY_ROOT = path.join(WXDB_TMP_DIR, 'media');
const WORKER_CANCEL_GRACE_MS = 750;
const PERSISTENT_COLLECT_WORKER_IDLE_MS = 30 * 60 * 1000;
const PERSISTENT_COLLECT_WORKER_MAX_LIFETIME_MS = 60 * 60 * 1000;
const PERSISTENT_COLLECT_WORKER_CLOSE_GRACE_MS = 3000;
const PERSISTENT_COLLECT_WORKER_FORCE_EXIT_MS = 5000;
const MAX_PERSISTENT_COLLECT_WORKERS = 4;
const PERSISTENT_COLLECT_WORKERS = new Map();
const CLOSING_PERSISTENT_COLLECT_WORKERS = new Map();
const ONE_SHOT_WXDB_WORKERS = new Map();
let NEXT_ONE_SHOT_WXDB_WORKER_ID = 1;
let WXDB_ISOLATED_WORKER_ADMISSION_CLOSED = false;
let WXDB_ISOLATED_WORKER_SHUTDOWN_MESSAGE = '';
const ACCOUNT_IDENTITY_SHARD_EVIDENCE_CACHE = new Map();
const ACCOUNT_IDENTITY_SHARD_EVIDENCE_CACHE_LIMIT = 48;
const ACCOUNT_IDENTITY_SHARD_EVIDENCE_PER_ACCOUNT_LIMIT = 24;
let wxDbIsolatedIdentityChangeListener = null;

function accountIdentityShardEvidenceCacheEntriesForWorker(accountId = '') {
  const id = String(accountId || '').trim().toLowerCase();
  const scoped = /^wxacc_[a-f0-9]{16}$/.test(id);
  return [...ACCOUNT_IDENTITY_SHARD_EVIDENCE_CACHE.values()]
    .filter(entry => !scoped || entry.account_id === id)
    .slice(-ACCOUNT_IDENTITY_SHARD_EVIDENCE_PER_ACCOUNT_LIMIT);
}

function trimAccountIdentityShardEvidenceCache() {
  const accounts = new Map();
  for (const [key, entry] of ACCOUNT_IDENTITY_SHARD_EVIDENCE_CACHE) {
    if (!accounts.has(entry.account_id)) accounts.set(entry.account_id, []);
    accounts.get(entry.account_id).push(key);
  }
  for (const keys of accounts.values()) {
    while (keys.length > ACCOUNT_IDENTITY_SHARD_EVIDENCE_PER_ACCOUNT_LIMIT) {
      ACCOUNT_IDENTITY_SHARD_EVIDENCE_CACHE.delete(keys.shift());
    }
  }
  while (ACCOUNT_IDENTITY_SHARD_EVIDENCE_CACHE.size > ACCOUNT_IDENTITY_SHARD_EVIDENCE_CACHE_LIMIT) {
    const oldest = ACCOUNT_IDENTITY_SHARD_EVIDENCE_CACHE.keys().next().value;
    if (!oldest) break;
    ACCOUNT_IDENTITY_SHARD_EVIDENCE_CACHE.delete(oldest);
  }
}

function rememberAccountIdentityShardEvidenceCacheEntries(accountId = '', rawEntries = []) {
  const id = String(accountId || '').trim().toLowerCase();
  const scoped = /^wxacc_[a-f0-9]{16}$/.test(id);
  let remembered = 0;
  for (const raw of (Array.isArray(rawEntries) ? rawEntries : []).slice(0, ACCOUNT_IDENTITY_SHARD_EVIDENCE_PER_ACCOUNT_LIMIT)) {
    const rawAccountId = String(raw?.account_id || '').trim().toLowerCase();
    const expectedAccountId = scoped ? id : rawAccountId;
    if (!/^wxacc_[a-f0-9]{16}$/.test(expectedAccountId)) continue;
    const entry = normalizeAccountIdentityShardEvidenceCacheEntry(raw, expectedAccountId);
    if (!entry) continue;
    ACCOUNT_IDENTITY_SHARD_EVIDENCE_CACHE.delete(entry.cache_key);
    ACCOUNT_IDENTITY_SHARD_EVIDENCE_CACHE.set(entry.cache_key, entry);
    remembered += 1;
  }
  trimAccountIdentityShardEvidenceCache();
  return remembered;
}

function rememberWorkerAccountIdentityShardEvidence(payload = {}, message = {}) {
  const selector = String(payload?.account_id || message?.verified_account?.account_id || '').trim();
  return rememberAccountIdentityShardEvidenceCacheEntries(
    selector,
    message?.identity_shard_evidence_cache_entries,
  );
}

function clearAccountIdentityShardEvidenceCache(accountId = '') {
  const id = String(accountId || '').trim().toLowerCase();
  let removed = 0;
  for (const [key, entry] of ACCOUNT_IDENTITY_SHARD_EVIDENCE_CACHE) {
    if (id && entry.account_id !== id) continue;
    ACCOUNT_IDENTITY_SHARD_EVIDENCE_CACHE.delete(key);
    removed += 1;
  }
  return removed;
}

export function clearWxDbIsolatedIdentityEvidenceCache(accountId = '') {
  return clearAccountIdentityShardEvidenceCache(accountId);
}

async function hydrateAccountIdentityShardEvidenceCache(accountId = '', { file = undefined } = {}) {
  const id = String(accountId || '').trim().toLowerCase();
  if (!/^wxacc_[a-f0-9]{16}$/.test(id)) return 0;
  try {
    const entries = await persistedWxdbIdentityShardEvidenceForAccount({
      account_id: id,
      ...(file ? { file } : {}),
    });
    clearAccountIdentityShardEvidenceCache(id);
    return rememberAccountIdentityShardEvidenceCacheEntries(id, entries);
  } catch (error) {
    logWarn('wxdb_identity_evidence_cache_hydration_failed', {
      account_id: '[redacted]',
      error: String(error?.message || error).slice(0, 240),
    });
    return 0;
  }
}

export async function hydrateWxDbIsolatedIdentityEvidenceCache({ file = undefined } = {}) {
  try {
    const entries = await persistedWxdbIdentityShardEvidence({ ...(file ? { file } : {}) });
    clearAccountIdentityShardEvidenceCache();
    return rememberAccountIdentityShardEvidenceCacheEntries('', entries);
  } catch (error) {
    logWarn('wxdb_identity_evidence_cache_startup_hydration_failed', {
      error: String(error?.message || error).slice(0, 240),
    });
    return 0;
  }
}

async function persistWorkerAccountIdentityShardEvidence(payload = {}, message = {}, { file = undefined } = {}) {
  const rawEntries = Array.isArray(message?.identity_shard_evidence_cache_entries)
    ? message.identity_shard_evidence_cache_entries
    : [];
  if (!rawEntries.length) return 0;
  const requestedId = String(payload?.account_id || message?.verified_account?.account_id || '').trim().toLowerCase();
  const accountIds = /^wxacc_[a-f0-9]{16}$/.test(requestedId)
    ? [requestedId]
    : [...new Set(rawEntries
        .map(entry => String(entry?.account_id || '').trim().toLowerCase())
        .filter(accountId => /^wxacc_[a-f0-9]{16}$/.test(accountId)))];
  let persisted = 0;
  for (const accountId of accountIds) {
    try {
      const result = await rememberWxdbIdentityShardEvidenceForAccount({
        account_id: accountId,
        entries: rawEntries,
        ...(file ? { file } : {}),
      });
      persisted += Math.max(0, Number(result?.entry_count || 0) || 0);
    } catch (error) {
      logWarn('wxdb_identity_evidence_cache_persist_failed', {
        account_id: '[redacted]',
        error: String(error?.message || error).slice(0, 240),
      });
    }
  }
  return persisted;
}

function accountIdentityShardEvidenceCacheStatus() {
  return {
    entries: ACCOUNT_IDENTITY_SHARD_EVIDENCE_CACHE.size,
    accounts: new Set([...ACCOUNT_IDENTITY_SHARD_EVIDENCE_CACHE.values()].map(entry => entry.account_id)).size,
  };
}

function normalizeWxDbIsolatedIdentityChange(change = null) {
  const value = change && typeof change === 'object' && !Array.isArray(change) ? change : {};
  const storageId = String(value.storage_id || '').trim().toLowerCase();
  const previousIdentityId = String(value.previous_identity_id || '').trim().toLowerCase();
  const identityId = String(value.identity_id || '').trim().toLowerCase();
  if (value.identity_switched !== true
    || !/^wxacc_[a-f0-9]{16}$/.test(storageId)
    || !/^wxacct_[a-f0-9]{24}$/.test(identityId)
    || (previousIdentityId && !/^wxacct_[a-f0-9]{24}$/.test(previousIdentityId))) {
    return null;
  }
  return {
    storage_id: storageId,
    previous_identity_id: previousIdentityId,
    identity_id: identityId,
    identity_switched: true,
  };
}

export function setWxDbIsolatedIdentityChangeListener(listener = null) {
  wxDbIsolatedIdentityChangeListener = typeof listener === 'function' ? listener : null;
}

async function notifyWxDbIsolatedIdentityChanged(change = null) {
  const normalized = normalizeWxDbIsolatedIdentityChange(change);
  if (!normalized || typeof wxDbIsolatedIdentityChangeListener !== 'function') return false;
  try {
    await wxDbIsolatedIdentityChangeListener(normalized);
    return true;
  } catch {
    return false;
  }
}

function isolatedAbortError(signal = null, fallback = '数据库读取已取消') {
  if (signal?.reason instanceof Error) return signal.reason;
  return Object.assign(new Error(fallback), { name: 'AbortError', status: 499 });
}

function isolatedWorkerError(payload = {}) {
  const error = new Error(String(payload.message || '独立数据库读取进程失败。'));
  for (const key of [
    'name',
    'status',
    'code',
    'public_code',
    'wxdb_diagnostics',
    'key_diagnostics',
    'key_scan_diagnostics',
    'digest_diagnostics',
    'min_messages',
  ]) {
    if (payload[key] !== undefined) error[key] = payload[key];
  }
  return error;
}

function isolatedWorkerTimeoutError(workerType, timeoutMs) {
  const labels = { collect: '消息读取', groups: '群列表读取', probe: '数据库密钥验证', identity: '微信账号确认' };
  return Object.assign(new Error(`${labels[workerType] || '数据库读取'}超过 ${Math.ceil(timeoutMs / 1000)} 秒仍未完成，已停止独立读取进程；请重新检查本地数据后再试。`), {
    status: 504,
    code: 'wxdb_worker_timeout',
    public_code: 'wxdb_worker_timeout',
  });
}

function workerCopyDirectoryOwner(name = '') {
  const match = String(name || '').match(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(\d+)-([a-f0-9]{16})-[a-f0-9]{8}$/i);
  return {
    pid: match ? Math.trunc(Number(match[1] || 0)) : 0,
    token: String(match?.[2] || '').toLowerCase(),
  };
}

async function cleanupWorkerCopyDirectoriesOnce(pid, token) {
  const cleanPid = Math.trunc(Number(pid || 0));
  const cleanToken = String(token || '').trim().toLowerCase();
  if (cleanPid <= 0 || !/^[a-f0-9]{16}$/.test(cleanToken)) return 0;
  let failed = 0;
  failed += await cleanupWorkerOwnedDirectories(DB_COPY_ROOT, cleanPid, cleanToken, { skipPlainCache: true, label: 'isolated wxdb worker copy' });
  failed += await cleanupWorkerOwnedDirectories(MEDIA_COPY_ROOT, cleanPid, cleanToken, { label: 'isolated wxdb worker media copy' });
  failed += await cleanupWorkerPlainCacheTemps(path.join(DB_COPY_ROOT, 'plain-cache'), cleanPid, cleanToken);
  return failed;
}

async function cleanupWorkerOwnedDirectories(root, cleanPid, cleanToken, { skipPlainCache = false, label = 'isolated worker copy' } = {}) {
  let rootStat;
  try {
    rootStat = await fsp.lstat(root);
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink?.()) return 0;
  let failed = 0;
  let accountEntries;
  try {
    accountEntries = await fsp.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
  for (const accountEntry of accountEntries) {
    if (!accountEntry.isDirectory() || (skipPlainCache && accountEntry.name === 'plain-cache')) continue;
    const accountDir = path.join(root, accountEntry.name);
    let copies;
    try {
      copies = await fsp.readdir(accountDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const copy of copies) {
      const owner = workerCopyDirectoryOwner(copy.name);
      if (!copy.isDirectory() || owner.pid !== cleanPid || owner.token !== cleanToken) continue;
      const candidate = path.join(accountDir, copy.name);
      try {
        const safe = await assertSafeTmpPath(candidate, { label, allowMissing: true });
        if (safe.exists) await fsp.rm(safe.resolved, { recursive: true, force: true });
      } catch {
        failed += 1;
      }
    }
  }
  return failed;
}

async function cleanupWorkerPlainCacheTemps(_dir, pid, token) {
  const result = await cleanupWxDbWorkerPlaintextCaches(pid, token).catch(() => ({ failed: 1 }));
  return Math.max(0, Number(result?.failed || 0) || 0);
}

async function cleanupWorkerCopiesAfterExit(pid, token) {
  const cleanPid = Math.trunc(Number(pid || 0));
  const cleanToken = String(token || '').trim().toLowerCase();
  if (cleanPid <= 0 || !/^[a-f0-9]{16}$/.test(cleanToken)) return true;
  let failed = 0;
  let lastError = null;
  for (const delayMs of [0, 100, 500, 1500]) {
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    try {
      failed = await cleanupWorkerCopyDirectoriesOnce(cleanPid, cleanToken);
      lastError = null;
    } catch (error) {
      failed = 1;
      lastError = error;
    }
    if (failed === 0) return true;
  }
  throw Object.assign(new Error('数据库读取进程已退出，但它的项目工作副本尚未完全删除。'), {
    status: 500,
    code: 'wxdb_worker_copy_cleanup_incomplete',
    public_code: 'wxdb_worker_copy_cleanup_incomplete',
    worker_pid: cleanPid,
    cause: lastError || undefined,
  });
}

function persistentCollectWorkerDescriptor(workerType, payload = {}) {
  if (workerType !== 'collect') return null;
  const batchId = String(payload?.batch_id || '').trim();
  const accountId = String(payload?.account_id || '').trim();
  const readiness = payload?.mirror_readiness && typeof payload.mirror_readiness === 'object' && !Array.isArray(payload.mirror_readiness)
    ? payload.mirror_readiness
    : null;
  const snapshotHash = String(readiness?.source_snapshot_meta_hash || '').trim().toLowerCase();
  const publishedManifestHash = String(readiness?.published_manifest_hash || '').trim().toLowerCase();
  if (!/^[a-zA-Z0-9_.:-]{8,80}$/.test(batchId)
    || !accountId
    || accountId.length > 512
    || !/^[a-f0-9]{64}$/.test(snapshotHash)
    || !/^[a-f0-9]{64}$/.test(publishedManifestHash)) return null;
  return {
    key: crypto.createHash('sha256').update(`${batchId}\0${accountId}\0${snapshotHash}\0${publishedManifestHash}`).digest('hex'),
    batch_id: batchId,
    account_id: accountId,
    snapshot_hash: snapshotHash,
    published_manifest_hash: publishedManifestHash,
  };
}

function persistentCollectWorkerRecords() {
  return [...new Set([
    ...PERSISTENT_COLLECT_WORKERS.values(),
    ...CLOSING_PERSISTENT_COLLECT_WORKERS.values(),
  ])];
}

function oneShotWxDbWorkerRecords() {
  return [...ONE_SHOT_WXDB_WORKERS.values()];
}

function wxDbIsolatedWorkerShutdownError(message = '') {
  return Object.assign(new Error(message || WXDB_ISOLATED_WORKER_SHUTDOWN_MESSAGE || '服务正在关闭，数据库读取任务未开始。'), {
    name: 'AbortError',
    status: 503,
    code: 'wxdb_worker_shutdown',
    public_code: 'wxdb_worker_shutdown',
  });
}

export function activeWxDbIsolatedWorkerStatus() {
  const persistentRecords = persistentCollectWorkerRecords();
  const oneShotRecords = oneShotWxDbWorkerRecords();
  const allRecords = [...persistentRecords, ...oneShotRecords];
  return {
    active: allRecords.length,
    persistent: persistentRecords.length,
    one_shot: oneShotRecords.length,
    cleanup_failed: allRecords.filter(record => !!record?.cleanup_error).length,
    closing: WXDB_ISOLATED_WORKER_ADMISSION_CLOSED,
  };
}

function registerOneShotWxDbWorker(child, workerToken, workerType) {
  let resolveLifecycle = () => {};
  const id = NEXT_ONE_SHOT_WXDB_WORKER_ID++;
  const record = {
    id,
    child,
    worker_token: workerToken,
    worker_type: String(workerType || '').trim(),
    started_at: Date.now(),
    closing: false,
    termination_started: false,
    cleanup_promise: null,
    cleanup_error: null,
    close_promise: null,
    stop: null,
    lifecycle_promise: new Promise(resolve => { resolveLifecycle = resolve; }),
    resolve_lifecycle: () => resolveLifecycle(),
  };
  ONE_SHOT_WXDB_WORKERS.set(id, record);
  return record;
}

function finalizeOneShotWxDbWorker(record) {
  if (!record || record.termination_started) return record?.lifecycle_promise || Promise.resolve(false);
  record.termination_started = true;
  record.closing = true;
  record.cleanup_promise = cleanupWorkerCopiesAfterExit(record.child?.pid, record.worker_token)
    .then(() => {
      record.cleanup_error = null;
      ONE_SHOT_WXDB_WORKERS.delete(record.id);
      return true;
    })
    .catch(error => {
      record.cleanup_error = error;
      logWarn('wxdb_worker_copy_cleanup_failed', {
        worker_pid: record.child?.pid,
        error: String(error?.message || error).slice(0, 240),
      });
      return false;
    })
    .finally(() => record.resolve_lifecycle());
  return record.lifecycle_promise;
}

async function ensureOneShotWxDbWorkerCleanup(record) {
  if (!record) return false;
  await record.lifecycle_promise;
  if (!record.cleanup_error) {
    ONE_SHOT_WXDB_WORKERS.delete(record.id);
    return true;
  }
  try {
    record.cleanup_promise = cleanupWorkerCopiesAfterExit(record.child?.pid, record.worker_token);
    await record.cleanup_promise;
    record.cleanup_error = null;
    ONE_SHOT_WXDB_WORKERS.delete(record.id);
    return true;
  } catch (error) {
    record.cleanup_error = error;
    throw error;
  }
}

function waitForOneShotWxDbWorkerLifecycle(record, timeoutMs) {
  if (!record || (record.termination_started && !record.cleanup_error && !ONE_SHOT_WXDB_WORKERS.has(record.id))) {
    return Promise.resolve(true);
  }
  const timeout = Math.max(1, Number(timeoutMs || 0) || 1);
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeout);
    timer.unref?.();
    record.lifecycle_promise.then(() => finish(true), () => finish(false));
  });
}

function oneShotWxDbWorkerCloseTimeoutError(record) {
  return Object.assign(new Error('一次性数据库读取进程未能在限定时间内退出。'), {
    status: 500,
    code: 'wxdb_worker_close_timeout',
    public_code: 'wxdb_worker_close_timeout',
    worker_pid: Math.max(0, Number(record?.child?.pid || 0) || 0),
  });
}

async function closeOneShotWxDbWorker(record, reason = 'service_shutdown') {
  if (!record) return false;
  if (record.close_promise) return record.close_promise;
  const closePromise = (async () => {
    record.closing = true;
    const error = wxDbIsolatedWorkerShutdownError(reason === 'service_shutdown' ? '' : String(reason || ''));
    if (record.child?.exitCode !== null && !record.termination_started) finalizeOneShotWxDbWorker(record);
    if (!record.termination_started) {
      if (typeof record.stop === 'function') record.stop(error);
      else forceStopWxDbChild(record.child);
    }
    if (await waitForOneShotWxDbWorkerLifecycle(record, PERSISTENT_COLLECT_WORKER_CLOSE_GRACE_MS)) {
      return ensureOneShotWxDbWorkerCleanup(record);
    }
    forceStopWxDbChild(record.child);
    if (await waitForOneShotWxDbWorkerLifecycle(record, PERSISTENT_COLLECT_WORKER_FORCE_EXIT_MS)) {
      return ensureOneShotWxDbWorkerCleanup(record);
    }
    throw oneShotWxDbWorkerCloseTimeoutError(record);
  })();
  record.close_promise = closePromise.finally(() => {
    if (ONE_SHOT_WXDB_WORKERS.get(record.id) === record) record.close_promise = null;
  });
  return record.close_promise;
}

export function closeWxDbIsolatedWorkerAdmission(message = '服务正在关闭，数据库读取任务已取消。') {
  WXDB_ISOLATED_WORKER_ADMISSION_CLOSED = true;
  WXDB_ISOLATED_WORKER_SHUTDOWN_MESSAGE = String(message || '').trim();
  const error = wxDbIsolatedWorkerShutdownError();
  let cancelled = 0;
  for (const record of oneShotWxDbWorkerRecords()) {
    if (record.closing) continue;
    record.closing = true;
    if (typeof record.stop === 'function') record.stop(error);
    else forceStopWxDbChild(record.child);
    cancelled += 1;
  }
  for (const record of persistentCollectWorkerRecords()) {
    if (record.closing) continue;
    record.retire_after_request = true;
    void closePersistentCollectWorker(record, 'service_shutdown').catch(closeError => {
      logWarn('wxdb_worker_shutdown_close_failed', {
        worker_pid: record.child?.pid,
        error: String(closeError?.message || closeError).slice(0, 240),
      });
    });
    cancelled += 1;
  }
  return { ...activeWxDbIsolatedWorkerStatus(), cancelled };
}

function markPersistentCollectWorkerClosing(record) {
  if (!record) return;
  record.closing = true;
  if (PERSISTENT_COLLECT_WORKERS.get(record.key) === record) {
    PERSISTENT_COLLECT_WORKERS.delete(record.key);
  }
  CLOSING_PERSISTENT_COLLECT_WORKERS.set(record.registry_id, record);
}

function forgetPersistentCollectWorker(record) {
  if (!record) return;
  if (PERSISTENT_COLLECT_WORKERS.get(record.key) === record) {
    PERSISTENT_COLLECT_WORKERS.delete(record.key);
  }
  if (CLOSING_PERSISTENT_COLLECT_WORKERS.get(record.registry_id) === record) {
    CLOSING_PERSISTENT_COLLECT_WORKERS.delete(record.registry_id);
  }
}

function retirePersistentCollectWorkersForIdentityChange(change, currentRecord = null) {
  const normalized = normalizeWxDbIsolatedIdentityChange(change);
  if (!normalized) return false;
  clearAccountIdentityShardEvidenceCache(normalized.storage_id);
  if (currentRecord) currentRecord.retire_after_request = true;
  for (const record of PERSISTENT_COLLECT_WORKERS.values()) {
    if (record === currentRecord) continue;
    void closePersistentCollectWorker(record, 'account_identity_changed').catch(() => {});
  }
  return true;
}

function forceStopWxDbChild(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    void terminateWindowsProcessTree(child, {
      isClosed: () => child.exitCode !== null,
      responseWaitMs: 250,
    }).catch(() => {
      try { child.kill('SIGKILL'); } catch {}
    });
    return;
  }
  try { child.kill('SIGKILL'); } catch {}
}

function waitForPersistentCollectWorkerExit(record, timeoutMs) {
  if (!record || record.child?.exitCode !== null) return Promise.resolve(true);
  const timeout = Math.max(1, Number(timeoutMs || 0) || 1);
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeout);
    timer.unref?.();
    record.exit_promise.then(() => finish(true), () => finish(false));
  });
}

function persistentCollectWorkerCloseTimeoutError(record) {
  return Object.assign(new Error('数据库读取会话未能在限定时间内退出。'), {
    status: 500,
    code: 'wxdb_worker_close_timeout',
    public_code: 'wxdb_worker_close_timeout',
    worker_pid: Math.max(0, Number(record?.child?.pid || 0) || 0),
  });
}

function schedulePersistentCollectWorkerIdleClose(record) {
  if (!record || record.closing || record.busy || record.child?.exitCode !== null) return;
  if (record.idle_timer) clearTimeout(record.idle_timer);
  const lifetimeRemaining = Math.max(1, Number(record.created_at || 0) + PERSISTENT_COLLECT_WORKER_MAX_LIFETIME_MS - Date.now());
  record.idle_timer = setTimeout(() => {
    record.idle_timer = null;
    void closePersistentCollectWorker(record, lifetimeRemaining <= PERSISTENT_COLLECT_WORKER_IDLE_MS ? 'session_lifetime' : 'idle_timeout').catch(() => {});
  }, Math.min(PERSISTENT_COLLECT_WORKER_IDLE_MS, lifetimeRemaining));
  record.idle_timer.unref?.();
}

function spawnPersistentCollectWorker(descriptor) {
  const workerToken = crypto.randomBytes(8).toString('hex');
  const child = fork(MESSAGE_WORKER_FILE, [], {
    windowsHide: true,
    execArgv: [],
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: {
      ...process.env,
      WX_SUMMARY_WXDB_MESSAGE_WORKER: '1',
      WX_SUMMARY_WXDB_WORKER_TOKEN: workerToken,
      WX_SUMMARY_WXDB_PERSISTENT_WORKER: '1',
    },
  });
  let resolveExit = () => {};
  const record = {
    ...descriptor,
    child,
    worker_token: workerToken,
    registry_id: `${descriptor.key}:${Math.max(0, Number(child.pid || 0) || 0)}:${workerToken}`,
    busy: false,
    closing: false,
    retire_after_request: false,
    idle_timer: null,
    created_at: Date.now(),
    last_used_at: Date.now(),
    stderr: '',
    terminated: false,
    termination_started: false,
    cleanup_promise: null,
    cleanup_error: null,
    exit_promise: new Promise(resolve => { resolveExit = resolve; }),
  };
  PERSISTENT_COLLECT_WORKERS.set(record.key, record);
  child.stderr?.setEncoding?.('utf8');
  child.stderr?.on('data', chunk => {
    if (record.stderr.length >= WORKER_STDERR_MAX_BYTES) return;
    record.stderr = `${record.stderr}${String(chunk || '')}`.slice(0, WORKER_STDERR_MAX_BYTES);
  });
  child.on('error', error => {
    record.stderr = `${record.stderr}\n${String(error?.message || error || '')}`.slice(-WORKER_STDERR_MAX_BYTES);
    markPersistentCollectWorkerClosing(record);
    forceStopWxDbChild(child);
  });
  const finalizeWorkerLifecycle = () => {
    if (record.termination_started) return;
    record.termination_started = true;
    record.terminated = true;
    if (record.idle_timer) clearTimeout(record.idle_timer);
    record.idle_timer = null;
    markPersistentCollectWorkerClosing(record);
    record.cleanup_promise = cleanupWorkerCopiesAfterExit(child.pid, workerToken)
      .then(() => {
        record.cleanup_error = null;
        forgetPersistentCollectWorker(record);
        return true;
      })
      .catch(error => {
        record.cleanup_error = error;
        logWarn('wxdb_worker_copy_cleanup_failed', {
          worker_pid: record.child?.pid,
          error: String(error?.message || error).slice(0, 240),
        });
        return false;
      })
      .finally(() => resolveExit());
  };
  child.once('exit', finalizeWorkerLifecycle);
  child.once('close', finalizeWorkerLifecycle);
  return record;
}

async function ensurePersistentCollectWorkerCleanup(record) {
  if (!record) return false;
  await record.exit_promise;
  if (!record.cleanup_error) {
    forgetPersistentCollectWorker(record);
    return true;
  }
  try {
    record.cleanup_promise = cleanupWorkerCopiesAfterExit(record.child?.pid, record.worker_token);
    await record.cleanup_promise;
    record.cleanup_error = null;
    forgetPersistentCollectWorker(record);
    return true;
  } catch (error) {
    record.cleanup_error = error;
    markPersistentCollectWorkerClosing(record);
    throw error;
  }
}

async function closePersistentCollectWorker(record, reason = 'batch_finished') {
  if (!record) return false;
  if (record.closing) {
    if (await waitForPersistentCollectWorkerExit(record, PERSISTENT_COLLECT_WORKER_FORCE_EXIT_MS)) {
      return ensurePersistentCollectWorkerCleanup(record);
    }
    forceStopWxDbChild(record.child);
    if (await waitForPersistentCollectWorkerExit(record, PERSISTENT_COLLECT_WORKER_FORCE_EXIT_MS)) {
      return ensurePersistentCollectWorkerCleanup(record);
    }
    throw persistentCollectWorkerCloseTimeoutError(record);
  }
  if (record.idle_timer) clearTimeout(record.idle_timer);
  record.idle_timer = null;
  if (record.child.exitCode !== null) {
    return ensurePersistentCollectWorkerCleanup(record);
  }
  markPersistentCollectWorkerClosing(record);
  try {
    if (record.child.connected) record.child.send({ type: 'close', reason }, () => {});
  } catch {}
  if (await waitForPersistentCollectWorkerExit(record, PERSISTENT_COLLECT_WORKER_CLOSE_GRACE_MS)) {
    return ensurePersistentCollectWorkerCleanup(record);
  }
  forceStopWxDbChild(record.child);
  if (await waitForPersistentCollectWorkerExit(record, PERSISTENT_COLLECT_WORKER_FORCE_EXIT_MS)) {
    return ensurePersistentCollectWorkerCleanup(record);
  }
  throw persistentCollectWorkerCloseTimeoutError(record);
}

export async function releaseWxDbIsolatedBatchSession(batchId) {
  const id = String(batchId || '').trim();
  if (!id) return 0;
  const matches = persistentCollectWorkerRecords().filter(record => record.batch_id === id);
  const settled = await Promise.allSettled(matches.map(record => closePersistentCollectWorker(record, 'batch_finished')));
  const failed = settled.find(item => item.status === 'rejected');
  if (failed) throw failed.reason;
  return matches.length;
}

export async function releaseAllWxDbIsolatedBatchSessions(reason = 'service_shutdown') {
  const records = persistentCollectWorkerRecords();
  const oneShotRecords = oneShotWxDbWorkerRecords();
  const settled = await Promise.allSettled([
    ...records.map(record => closePersistentCollectWorker(record, reason)),
    ...oneShotRecords.map(record => closeOneShotWxDbWorker(record, reason)),
  ]);
  const failed = settled.find(item => item.status === 'rejected');
  if (failed) throw failed.reason;
  return {
    persistent: records.length,
    one_shot: oneShotRecords.length,
    ...activeWxDbIsolatedWorkerStatus(),
  };
}

function runWxDbIsolated(workerType = 'collect', options = {}) {
  const { signal = null, onProgress = null, pre_media_filter = null, timeout_ms = 0, ...rawPayload } = options || {};
  if (WXDB_ISOLATED_WORKER_ADMISSION_CLOSED) {
    return Promise.reject(wxDbIsolatedWorkerShutdownError());
  }
  if (typeof pre_media_filter === 'function') {
    throw Object.assign(new Error('独立消息读取不接受不可序列化筛选函数，请传 pre_media_filter_spec。'), {
      status: 500,
      code: 'wxdb_worker_filter_not_serializable',
    });
  }
  if (signal?.aborted) return Promise.reject(isolatedAbortError(signal));
  const payload = ['collect', 'groups', 'identity'].includes(workerType) ? {
    ...rawPayload,
    identity_shard_evidence_cache_entries: accountIdentityShardEvidenceCacheEntriesForWorker(rawPayload.account_id),
  } : rawPayload;
  return runWxDbIsolatedLocked(workerType, { signal, onProgress, timeout_ms, payload });
}

function runWxDbIsolatedLocked(workerType, { signal = null, onProgress = null, timeout_ms = 0, payload = {} } = {}) {
  const workerProgress = {
    collect: {
      started: { phase: 'fetch_worker_started', label: '拉取消息 · 启动可取消读取' },
      done: { phase: 'fetch_worker_done', label: '拉取消息 · 独立读取完成' },
      resultDetail: result => `${Array.isArray(result.messages) ? result.messages.length : 0} 条消息已返回主服务，继续筛选和总结`,
    },
    groups: {
      started: { phase: 'groups_worker_started', label: '读取群列表 · 启动可取消读取' },
      done: { phase: 'groups_worker_done', label: '读取群列表 · 独立读取完成' },
      resultDetail: result => `${Array.isArray(result) ? result.length : 0} 个群已返回主服务，继续整理列表`,
    },
    probe: {
      started: { phase: 'fetch_key_probe_worker_started', label: '验证数据库密钥 · 启动可取消探测' },
      done: { phase: 'fetch_key_probe_worker_done', label: '验证数据库密钥 · 独立探测完成' },
      resultDetail: result => `${Array.isArray(result.db_checks) ? result.db_checks.length : 0} 个数据库样本已返回主服务，继续选择可用密钥`,
    },
    identity: {
      started: { phase: 'account_identity_worker_started', label: '确认微信账号 · 启动可取消验证' },
      done: { phase: 'account_identity_worker_done', label: '确认微信账号 · 独立验证完成' },
      resultDetail: () => '账号身份验证结果已返回主服务，继续刷新账号信息',
    },
  }[workerType] || null;
  if (!workerProgress) {
    return Promise.reject(Object.assign(new Error(`未知的独立数据库任务：${workerType}`), {
      status: 500,
      code: 'wxdb_worker_type_invalid',
    }));
  }
  try {
    onProgress?.({
      ...workerProgress.started,
      detail: '本机数据库查询在独立任务中运行；取消、超时和页面心跳不会被同步查询阻塞',
    });
  } catch {}
  if (signal?.aborted) return Promise.reject(isolatedAbortError(signal));
  const sessionDescriptor = persistentCollectWorkerDescriptor(workerType, payload);
  let persistentRecord = null;
  let persistentSessionReused = false;
  if (sessionDescriptor) {
    const existing = PERSISTENT_COLLECT_WORKERS.get(sessionDescriptor.key) || null;
    if (existing && existing.child?.exitCode === null && !existing.closing && !existing.busy) {
      persistentRecord = existing;
      persistentSessionReused = true;
    } else if ((!existing || existing.child?.exitCode !== null || existing.closing)
      && persistentCollectWorkerRecords().length < MAX_PERSISTENT_COLLECT_WORKERS) {
      persistentRecord = spawnPersistentCollectWorker(sessionDescriptor);
    } else if (!existing || existing.child?.exitCode !== null || existing.closing) {
      const oldest = [...PERSISTENT_COLLECT_WORKERS.values()]
        .filter(item => !item.busy && !item.closing)
        .sort((a, b) => Number(a.last_used_at || 0) - Number(b.last_used_at || 0))[0];
      if (oldest) void closePersistentCollectWorker(oldest, 'session_limit').catch(() => {});
    }
  }
  if (persistentRecord) {
    persistentRecord.busy = true;
    persistentRecord.last_used_at = Date.now();
    if (persistentRecord.idle_timer) clearTimeout(persistentRecord.idle_timer);
    persistentRecord.idle_timer = null;
    try {
      onProgress?.({
        phase: persistentSessionReused ? 'fetch_worker_session_reused' : 'fetch_worker_session_started',
        label: persistentSessionReused ? '拉取消息 · 复用本批读取会话' : '拉取消息 · 建立本批读取会话',
        detail: persistentSessionReused
          ? '继续使用同一账号和本地数据快照的独立读取进程；已解密临时读取数据可直接复用'
          : '本批后续群会复用这个可取消读取进程和已解密临时读取数据；批次结束后立即释放',
      });
    } catch {}
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let terminalMessageReceived = false;
    let stderr = '';
    let timer = null;
    const requestId = crypto.randomUUID();
    const workerToken = persistentRecord?.worker_token || crypto.randomBytes(8).toString('hex');
    const timeoutMs = Math.max(1000, Math.min(10 * 60 * 1000, Number(timeout_ms || 0) || WXDB_WORKER_TIMEOUT_MS[workerType]));
    const child = persistentRecord?.child || fork(MESSAGE_WORKER_FILE, [], {
        windowsHide: true,
        execArgv: [],
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { ...process.env, WX_SUMMARY_WXDB_MESSAGE_WORKER: '1', WX_SUMMARY_WXDB_WORKER_TOKEN: workerToken },
      });
    const oneShotRecord = persistentRecord ? null : registerOneShotWxDbWorker(child, workerToken, workerType);
    const cleanupOneShotWorkerAfterExit = () => {
      if (!oneShotRecord) return;
      void finalizeOneShotWxDbWorker(oneShotRecord);
    };
    if (!persistentRecord) {
      child.once('exit', cleanupOneShotWorkerAfterExit);
      child.once('close', cleanupOneShotWorkerAfterExit);
    }
    if (!persistentRecord) {
      child.stderr?.setEncoding?.('utf8');
      child.stderr?.on('data', chunk => {
        if (stderr.length >= WORKER_STDERR_MAX_BYTES) return;
        stderr = `${stderr}${String(chunk || '')}`.slice(0, WORKER_STDERR_MAX_BYTES);
      });
    }
    const invalidatePersistentRecord = () => {
      if (!persistentRecord) return;
      persistentRecord.busy = false;
      if (persistentRecord.idle_timer) clearTimeout(persistentRecord.idle_timer);
      persistentRecord.idle_timer = null;
      markPersistentCollectWorkerClosing(persistentRecord);
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      child.removeListener('message', onMessage);
      child.removeListener('error', onChildError);
      child.removeListener('exit', onChildExit);
    };
    const stopChild = ({ cooperative = false } = {}) => {
      if (child.exitCode !== null) return;
      invalidatePersistentRecord();
      if (cooperative && child.connected) {
        const messageType = persistentRecord ? 'close' : 'cancel';
        try { child.send({ type: messageType, request_id: requestId }, () => {}); } catch {}
        const forceAfterMs = persistentRecord ? PERSISTENT_COLLECT_WORKER_CLOSE_GRACE_MS : WORKER_CANCEL_GRACE_MS;
        const forceTimer = setTimeout(() => forceStopWxDbChild(child), forceAfterMs);
        forceTimer.unref?.();
        const clearForceTimer = () => clearTimeout(forceTimer);
        child.once('exit', clearForceTimer);
        child.once('close', clearForceTimer);
        return;
      }
      forceStopWxDbChild(child);
    };
    const finish = (fn, value, { cooperativeStop = false, keepPersistentWorker = false } = {}) => {
      if (settled) return;
      settled = true;
      cleanup();
      const keepWorker = !!persistentRecord
        && keepPersistentWorker
        && !persistentRecord.retire_after_request
        && !persistentRecord.closing
        && child.exitCode === null
        && child.connected;
      if (keepWorker) {
        persistentRecord.busy = false;
        persistentRecord.last_used_at = Date.now();
        schedulePersistentCollectWorkerIdleClose(persistentRecord);
      } else if (persistentRecord?.closing && !cooperativeStop && child.exitCode === null) {
        persistentRecord.busy = false;
      } else {
        stopChild({ cooperative: cooperativeStop || persistentRecord?.retire_after_request === true });
      }
      fn(value);
    };
    if (oneShotRecord) {
      oneShotRecord.stop = error => {
        if (!settled) {
          finish(reject, error || wxDbIsolatedWorkerShutdownError(), { cooperativeStop: true });
          return;
        }
        stopChild({ cooperative: true });
      };
    }
    const onAbort = () => finish(reject, isolatedAbortError(signal), { cooperativeStop: true });
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(() => finish(reject, isolatedWorkerTimeoutError(workerType, timeoutMs), { cooperativeStop: true }), timeoutMs);
    timer.unref?.();
    let identityChangeChain = Promise.resolve();
    const onMessage = message => {
      if (!message || typeof message !== 'object') return;
      if (String(message.request_id || '').trim() !== requestId) return;
      const terminalMessage = message.type === 'result' || message.type === 'error';
      if (terminalMessage) terminalMessageReceived = true;
      if (message.type === 'progress') {
        try { onProgress?.(message.progress || {}); } catch {}
        return;
      }
      if (message.type === 'identity_change') {
        retirePersistentCollectWorkersForIdentityChange(message.change, persistentRecord);
        identityChangeChain = identityChangeChain.then(() => notifyWxDbIsolatedIdentityChanged(message.change));
        return;
      }
      if (message.type === 'result') {
        void (async () => {
          await identityChangeChain;
          if (settled) return;
          if (['collect', 'groups', 'identity'].includes(workerType)) {
            rememberWorkerAccountIdentityShardEvidence(payload, message);
            if (Array.isArray(message?.identity_shard_evidence_cache_entries)
              && message.identity_shard_evidence_cache_entries.length) {
              try {
                onProgress?.({
                  phase: 'account_identity_evidence_persist',
                  label: '确认账号身份 · 保存复核结果',
                  detail: '正在加密保存已完成的消息分片复核证据；下次服务重启后会先验证内容指纹再复用',
                });
              } catch {}
            }
            await persistWorkerAccountIdentityShardEvidence(payload, message);
          }
          const result = message.result && typeof message.result === 'object' ? message.result : {};
          Object.defineProperty(result, '__verified_raw_keys', {
            value: Array.isArray(message.verified_raw_keys) ? message.verified_raw_keys : [],
            enumerable: false,
          });
          if (!result.account && message.verified_account && typeof message.verified_account === 'object' && !Array.isArray(message.verified_account)) {
            Object.defineProperty(result, 'account', {
              value: message.verified_account,
              enumerable: !Array.isArray(result),
            });
          }
          try {
            onProgress?.({
              ...workerProgress.done,
              detail: workerProgress.resultDetail(result),
            });
          } catch {}
          finish(resolve, result, { keepPersistentWorker: true });
        })().catch(error => finish(reject, error, { keepPersistentWorker: true }));
        return;
      }
      if (message.type === 'error') {
        void (async () => {
          await identityChangeChain;
          if (settled) return;
          if (['collect', 'groups', 'identity'].includes(workerType)) {
            rememberWorkerAccountIdentityShardEvidence(payload, message);
            if (Array.isArray(message?.identity_shard_evidence_cache_entries)
              && message.identity_shard_evidence_cache_entries.length) {
              try {
                onProgress?.({
                  phase: 'account_identity_evidence_persist',
                  label: '确认账号身份 · 保留已完成进度',
                  detail: '本次未完成账号确认；正在加密保存已经核对过的消息分片证据，重试时会先验证内容指纹再复用',
                });
              } catch {}
            }
            await persistWorkerAccountIdentityShardEvidence(payload, message);
          }
          finish(reject, isolatedWorkerError(message.error || {}), { keepPersistentWorker: true });
        })().catch(error => finish(reject, error, { keepPersistentWorker: true }));
      }
    };
    const onChildError = error => finish(reject, error);
    const onChildExit = (code, exitSignal) => {
      if (settled || terminalMessageReceived) return;
      const detail = String(persistentRecord?.stderr || stderr).trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 300);
      finish(reject, Object.assign(new Error(`独立数据库读取进程异常退出（${exitSignal || code || 'unknown'}）${detail ? `：${detail}` : ''}`), {
        status: 502,
        code: 'wxdb_worker_exited',
        public_code: 'wxdb_worker_exited',
      }));
    };
    child.on('message', onMessage);
    child.once('error', onChildError);
    child.once('exit', onChildExit);
    try {
      child.send({ type: workerType, request_id: requestId, payload }, error => {
        if (error) finish(reject, error);
      });
    } catch (error) {
      finish(reject, error);
    }
  });
}

export function collectMessagesFromWxDbIsolated(options = {}) {
  return runWxDbIsolated('collect', options);
}

export function listChatroomsFromWxDbIsolated(options = {}) {
  return runWxDbIsolated('groups', options);
}

export function probeWxDbIsolated(options = {}) {
  return runWxDbIsolated('probe', options);
}

export function extractSelfWxidFromProjectCopyIsolated(options = {}) {
  return runWxDbIsolated('identity', options);
}

export const __wxdbIsolatedInternals = {
  accountIdentityShardEvidenceCacheEntriesForWorker,
  accountIdentityShardEvidenceCacheStatus,
  clearAccountIdentityShardEvidenceCache,
  hydrateAccountIdentityShardEvidenceCache,
  cleanupWorkerCopyDirectoriesOnce,
  cleanupWorkerCopiesAfterExit,
  workerCopyDirectoryOwner,
  normalizeWxDbIsolatedIdentityChange,
  notifyWxDbIsolatedIdentityChanged,
  rememberAccountIdentityShardEvidenceCacheEntries,
  persistWorkerAccountIdentityShardEvidence,
  rememberWorkerAccountIdentityShardEvidence,
  retirePersistentCollectWorkersForIdentityChange,
  persistentCollectWorkerDescriptor,
  persistentCollectWorkerStatus: () => persistentCollectWorkerRecords().map(record => ({
    batch_id: record.batch_id,
    account_id: record.account_id,
    snapshot_hash: record.snapshot_hash,
    pid: Math.max(0, Number(record.child?.pid || 0) || 0),
    busy: record.busy === true,
    closing: record.closing === true,
  })),
};
