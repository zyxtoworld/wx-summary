import crypto from 'node:crypto';
import path from 'node:path';
import { discoverWeixinEnvironment, ensureWxDbMirror, hasWxDbMirrorIdentityAnchor, isWxDbMirrorIdentityVerified, pickAccount, readWxDbMirrorAccount, withWxDbMirrorReadLock, wxDbMirrorScopeRecordsForRead } from '../wxenv/discovery.js';
import { clearLocalWeixinKeyScanCache, currentWxKeyProcessGeneration, probeWxKey, scanLocalWeixinKeyCandidates, STANDARD_WEIXIN_KEY_SCAN_MAX_MS } from '../wxkey/index.js';
import { collectMessagesFromWxDbIsolated, listChatroomsFromWxDbIsolated, probeWxDbIsolated } from '../wxdb/isolated.js';
import { loadSettings, manualKeyAccountFingerprint, manualKeysForAccount, splitManualKeys } from '../config/settings.js';
import { rememberVerifiedWxdbKeysForAccount, verifiedWxdbKeyCacheInvalidInfo, verifiedWxdbKeysForAccount } from '../config/wxdb-key-cache.js';
import { redactSecrets } from '../summarizer/llm.js';

let REAL_GROUP_CACHE = null;
let DB_KEY_CANDIDATE_CACHE = null;
let DB_KEY_CANDIDATE_CACHE_GENERATION = 0;
let WEIXIN_ENV_CACHE = { at: 0, result: null, promise: null };
let WEIXIN_ENV_CACHE_GENERATION = 0;
let VERIFIED_RAW_KEY_CACHE = new Map();
let VERIFIED_AUTO_RAW_KEY_CACHE = new Map();
let FAILED_AUTO_RAW_KEY_SCAN_CACHE = new Map();
const VERIFIED_RAW_KEY_WRITE_QUEUES = new Map();
let DB_KEY_RUNTIME_STATE_VERSION = 0;
const CLEARED_MIRROR_RUNTIME_RESULTS = new WeakSet();
const DB_KEY_CANDIDATE_CACHE_MS = 2 * 60 * 1000;
const WEIXIN_ENV_CACHE_MS = 30 * 1000;
const FAILED_AUTO_RAW_KEY_SCAN_CACHE_MS = 3 * 60 * 1000;
const MAX_DB_KEY_ACCOUNT_RUNTIME_CACHE_ENTRIES = 32;
const EMPTY_COLLECTION_MIRROR_RETRY_TTL_MS = 15 * 60 * 1000;
const MAX_EMPTY_COLLECTION_MIRROR_RETRY_CACHE = 200;
const EMPTY_COLLECTION_MIRROR_RETRY_CACHE = new Map();
const GROUP_LIST_CACHE_MS = 5 * 60 * 1000;
const DEGRADED_GROUP_LIST_CACHE_MS = 30 * 1000;
const STALE_ACCOUNT_WARN_DAYS = 30;
const NEWER_ACCOUNT_DELTA_MS = 7 * 24 * 60 * 60 * 1000;
export const LEGACY_MANUAL_KEY_POLICY = Object.freeze({
  DENY: 'deny',
  ALLOW_VERIFIED_MIGRATION: 'allow_verified_migration',
});
const STANDARD_MEMORY_KEY_SCAN_MODE = {
  scan_writable_only: false,
  scan_include_mapped: true,
  scan_max_bytes: 1024 * 1024 * 1024,
  scan_max_region_bytes: 512 * 1024 * 1024,
  // Share one bounded budget fairly across the main and helper processes.
  scan_max_ms: STANDARD_WEIXIN_KEY_SCAN_MAX_MS,
};
const MESSAGE_SEARCH_FIELDS = ['time', 'sender', 'sender_username', 'sender_display_name', 'type', 'content'];
const MEDIA_SEARCH_FIELDS = ['kind', 'file_name', 'ext', 'size', 'width', 'height', 'duration_ms', 'duration_s', 'format', 'url', 'title', 'desc'];
const QUOTE_SEARCH_FIELDS = ['from', 'content', 'type'];
const LINK_PREVIEW_SEARCH_FIELDS = ['url', 'final_url', 'title', 'description', 'summary', 'excerpt', 'site_name', 'status', 'error', 'ai_summary'];

function setBoundedMapEntry(map, key, value, maxEntries) {
  if (!(map instanceof Map) || !key || !Number.isSafeInteger(maxEntries) || maxEntries < 1) return false;
  map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
  return true;
}

function getBoundedMapEntry(map, key) {
  if (!(map instanceof Map) || !map.has(key)) return undefined;
  const value = map.get(key);
  map.delete(key);
  map.set(key, value);
  return value;
}

async function withVerifiedRawKeyWriteLock(cacheKey, action) {
  const key = String(cacheKey || '').trim();
  if (!key) return action();
  const previous = VERIFIED_RAW_KEY_WRITE_QUEUES.get(key) || Promise.resolve();
  let release;
  const turn = new Promise(resolve => { release = resolve; });
  const queued = previous.catch(() => {}).then(() => turn);
  VERIFIED_RAW_KEY_WRITE_QUEUES.set(key, queued);
  await previous.catch(() => {});
  try {
    return await action();
  } finally {
    release();
    if (VERIFIED_RAW_KEY_WRITE_QUEUES.get(key) === queued) {
      VERIFIED_RAW_KEY_WRITE_QUEUES.delete(key);
    }
  }
}

function dbKeyRuntimeCacheState() {
  return {
    max_account_entries: MAX_DB_KEY_ACCOUNT_RUNTIME_CACHE_ENTRIES,
    verified_raw_key_accounts: VERIFIED_RAW_KEY_CACHE.size,
    verified_auto_raw_key_accounts: VERIFIED_AUTO_RAW_KEY_CACHE.size,
    failed_auto_raw_key_scan_accounts: FAILED_AUTO_RAW_KEY_SCAN_CACHE.size,
  };
}

function abortError(message = '请求已取消') {
  return Object.assign(new Error(message), { name: 'AbortError', status: 499 });
}

function abortSignalError(signal, fallbackMessage = '请求已取消') {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    if (reason.name === 'AbortError' && /aborted/i.test(reason.message || '')) return abortError(fallbackMessage);
    try {
      reason.status = reason.status || 499;
      if (!reason.name) reason.name = 'AbortError';
    } catch {}
    return reason;
  }
  return abortError(typeof reason === 'string' ? reason : fallbackMessage);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortSignalError(signal);
}

function rethrowIfAborted(error, signal, fallbackMessage = '请求已取消') {
  if (error?.status === 499) throw error;
  if (error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR'
    || error?.code === 'ERR_ABORTED'
    || signal?.aborted) {
    throw abortSignalError(signal, fallbackMessage);
  }
}

function notifyProgress(onProgress, data) {
  if (typeof onProgress !== 'function') return;
  try { onProgress(data); } catch {}
}

function waitForWeixinEnvironmentScan(promise, signal = null) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortSignalError(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener?.('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortSignalError(signal));
    signal.addEventListener?.('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      result => finish(resolve, result),
      error => finish(reject, error),
    );
  });
}

function startWeixinEnvironmentScan() {
  if (WEIXIN_ENV_CACHE.promise) return WEIXIN_ENV_CACHE.promise;
  const generation = ++WEIXIN_ENV_CACHE_GENERATION;
  // Discovery is shared across callers. A cancelled HTTP request must stop
  // waiting without aborting the machine-wide scan or spawning a duplicate.
  const promise = discoverWeixinEnvironment();
  WEIXIN_ENV_CACHE = { ...WEIXIN_ENV_CACHE, promise };
  void promise.then(
    result => {
      if (generation === WEIXIN_ENV_CACHE_GENERATION) {
        WEIXIN_ENV_CACHE = { at: Date.now(), result, promise: null };
      }
    },
    () => {
      if (generation === WEIXIN_ENV_CACHE_GENERATION && WEIXIN_ENV_CACHE.promise === promise) {
        WEIXIN_ENV_CACHE = { ...WEIXIN_ENV_CACHE, promise: null };
      }
    },
  );
  return promise;
}

export async function detectWeixin({ force = false, signal = null } = {}) {
  throwIfAborted(signal);
  if (!force && WEIXIN_ENV_CACHE.result && Date.now() - WEIXIN_ENV_CACHE.at < WEIXIN_ENV_CACHE_MS) {
    return WEIXIN_ENV_CACHE.result;
  }
  const result = await waitForWeixinEnvironmentScan(startWeixinEnvironmentScan(), signal);
  throwIfAborted(signal);
  return result;
}

export async function listAccounts({ force = false, signal = null } = {}) {
  throwIfAborted(signal);
  const env = await detectWeixin({ force, signal });
  throwIfAborted(signal);
  if (env.accounts?.length) {
    return env.accounts.map(account => accountListProjection(account, env));
  }
  return [];
}

function accountListProjection(account = {}, env = {}) {
  const source = account.source || 'wxdb-detected';
  const sourceStatus = String(account.source_status || account.mirror?.source_status || (account.source_available === false ? 'missing' : 'available')).trim();
  return {
    account_id: account.account_id || account.id || account.wxid,
    id: account.account_id || account.id || account.wxid,
    legacy_id: account.legacy_id || account.id,
    wxid: account.wxid,
    account_aliases: account.account_aliases || [account.id, account.wxid].filter(Boolean),
    name: account.display_name,
    display_name: account.display_name,
    wechat_version: '4.x',
    source,
    source_available: source === 'project-mirror'
      ? account.mirror?.source_available === true
      : account.source_available !== false,
    source_status: sourceStatus,
    source_status_label: String(account.source_status_label || account.mirror?.source_status_label || '').trim(),
    source_last_write_time: accountSourceLastWriteTime(account),
    mirror_last_write_time: accountMirrorLastWriteTime(account),
    last_write_time: accountDisplayLastWriteTime(account),
    db_storage: account.db_storage,
    source_account_root: account.source_account_root || '',
    source_db_storage: account.source_db_storage || '',
    account_root: account.account_root || '',
    mirror: account.mirror || null,
    mirror_index_status: account.mirror_index_status || '',
    mirror_index_backup_relative_path: account.mirror_index_backup_relative_path || '',
    mirror_index_error: account.mirror_index_error || '',
    note: source === 'project-mirror'
      ? '正在使用自动准备的本地工作数据；源数据库只在自动准备或重试刷新时用于复制。'
      : (source === 'source-unreadable'
        ? '微信数据目录或配置暂时不可读，且尚无可验证的项目工作副本；恢复访问后会自动重试准备。'
        : `${env.message || '已检测到微信数据目录。'} 选择此账号后，刷新群列表、生成摘要或验证数据库时会自动准备、复用或更新本地工作数据，不需要设置数据库路径。`),
  };
}

export function clearDbKeyRuntimeCache({
  clearVerified = true,
  clearVerifiedAuto = clearVerified,
  clearCandidates = true,
  clearFailed = true,
  invalidateActiveReads = true,
} = {}) {
  REAL_GROUP_CACHE = null;
  WEIXIN_ENV_CACHE_GENERATION++;
  WEIXIN_ENV_CACHE = { at: 0, result: null, promise: null };
  if (invalidateActiveReads) DB_KEY_RUNTIME_STATE_VERSION++;
  if (clearCandidates) {
    DB_KEY_CANDIDATE_CACHE_GENERATION++;
    DB_KEY_CANDIDATE_CACHE = null;
    clearLocalWeixinKeyScanCache();
  }
  if (clearVerified) {
    VERIFIED_RAW_KEY_CACHE = new Map();
  }
  if (clearVerified || clearVerifiedAuto) {
    VERIFIED_AUTO_RAW_KEY_CACHE = new Map();
  }
  if (clearFailed) {
    FAILED_AUTO_RAW_KEY_SCAN_CACHE = new Map();
  }
}

function runtimeCacheKeyBelongsToAccount(cacheKey = '', accountIds = []) {
  const first = String(cacheKey || '').split('|', 1)[0].trim();
  return !!first && accountIds.includes(first);
}

export function clearDbKeyRuntimeCacheForAccount({ account_id = '', account_aliases = [], invalidateActiveReads = true } = {}) {
  const accountIds = [...new Set([account_id, ...(Array.isArray(account_aliases) ? account_aliases : [])]
    .map(value => String(value || '').trim())
    .filter(Boolean))];
  if (!accountIds.length) {
    return { cleared: false, reason: 'account_required', removed_verified: 0, removed_auto: 0, removed_failed: 0 };
  }
  REAL_GROUP_CACHE = null;
  clearLocalWeixinKeyScanCache();
  let removedVerified = 0;
  let removedAuto = 0;
  let removedFailed = 0;
  for (const key of VERIFIED_RAW_KEY_CACHE.keys()) {
    if (runtimeCacheKeyBelongsToAccount(key, accountIds)) {
      VERIFIED_RAW_KEY_CACHE.delete(key);
      removedVerified += 1;
    }
  }
  for (const key of VERIFIED_AUTO_RAW_KEY_CACHE.keys()) {
    if (runtimeCacheKeyBelongsToAccount(key, accountIds)) {
      VERIFIED_AUTO_RAW_KEY_CACHE.delete(key);
      removedAuto += 1;
    }
  }
  for (const key of FAILED_AUTO_RAW_KEY_SCAN_CACHE.keys()) {
    if (runtimeCacheKeyBelongsToAccount(key, accountIds)) {
      FAILED_AUTO_RAW_KEY_SCAN_CACHE.delete(key);
      removedFailed += 1;
    }
  }
  let candidateCleared = false;
  if (DB_KEY_CANDIDATE_CACHE && runtimeCacheKeyBelongsToAccount(DB_KEY_CANDIDATE_CACHE.accountSignature, accountIds)) {
    DB_KEY_CANDIDATE_CACHE_GENERATION++;
    DB_KEY_CANDIDATE_CACHE = null;
    candidateCleared = true;
  }
  const changed = !!(removedVerified || removedAuto || removedFailed || candidateCleared);
  if (invalidateActiveReads) DB_KEY_RUNTIME_STATE_VERSION++;
  return {
    cleared: changed,
    reason: 'account_scoped',
    removed_verified: removedVerified,
    removed_auto: removedAuto,
    removed_failed: removedFailed,
    candidate_cleared: candidateCleared,
    active_reads_invalidated: invalidateActiveReads === true,
  };
}

export function mirrorRefreshPreservesDbKeyRuntimeState(mirror = null) {
  if (!mirror?.refreshed || mirror?.identity_anchor_current !== true) return false;
  const scope = String(mirror?.mirror_scope || mirror?.mirror_readiness?.scope || '').trim().toLowerCase();
  return scope === 'groups';
}

export function clearDbKeyRuntimeCacheAfterMirrorRefresh(mirror = null) {
  if (!mirror?.refreshed) return { cleared: false, reason: 'not_refreshed' };
  if (typeof mirror === 'object' && CLEARED_MIRROR_RUNTIME_RESULTS.has(mirror)) {
    return { cleared: false, reason: 'already_cleared' };
  }
  if (typeof mirror === 'object') CLEARED_MIRROR_RUNTIME_RESULTS.add(mirror);
  if (mirrorRefreshPreservesDbKeyRuntimeState(mirror)) {
    return {
      cleared: false,
      reason: 'groups_identity_anchor_current',
      verified_key_cache_cleared: false,
      verified_key_cache_preserved: true,
      verified_key_cache_retained_as_candidates: false,
      verified_auto_key_cache_cleared: false,
      candidate_cache_cleared: false,
      failed_auto_scan_cooldown_preserved: true,
      active_reads_invalidated: false,
    };
  }
  const refreshReason = String(mirror.refresh_reason || '').trim();
  clearDbKeyRuntimeCache({
    // A refreshed project copy must be decrypted and bound to the current account
    // again. Keep prior raw keys only as candidates for that revalidation so a
    // normal WeChat write does not force another process-memory scan.
    clearVerified: false,
    clearVerifiedAuto: true,
    clearCandidates: true,
    // A changed database snapshot does not prove that a failed process-memory
    // scan can succeed. Keep its cooldown until the WeChat process/account
    // identity changes, a verification succeeds, or the user retries.
    clearFailed: false,
    // A mirror refresh publishes a new immutable read snapshot. Reads that
    // already hold their own snapshot can finish without being invalidated.
    invalidateActiveReads: false,
  });
  return {
    cleared: true,
    reason: refreshReason || 'mirror_refreshed',
    verified_key_cache_cleared: false,
    verified_key_cache_retained_as_candidates: true,
    verified_auto_key_cache_cleared: true,
    candidate_cache_cleared: true,
    failed_auto_scan_cooldown_preserved: true,
    active_reads_invalidated: false,
  };
}

export function dbKeyRuntimeStateVersion() {
  return DB_KEY_RUNTIME_STATE_VERSION;
}

function expectedDbKeyRuntimeStateVersion(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function dbKeyRuntimeStateVersionMatches(expectedVersion = null) {
  const expected = expectedDbKeyRuntimeStateVersion(expectedVersion);
  return expected === null || expected === DB_KEY_RUNTIME_STATE_VERSION;
}

function assertDbKeyRuntimeStateVersion(expectedVersion, context = '数据库读取') {
  if (dbKeyRuntimeStateVersionMatches(expectedVersion)) return;
  throw Object.assign(new Error(`${context}期间数据库密钥或本地工作数据状态已变化；已丢弃旧请求结果，请重试。`), {
    status: 409,
    code: 'db_key_runtime_state_changed',
    public_code: 'db_key_runtime_state_changed',
  });
}

export async function listGroups({ account_id = '', signal = null, onProgress = null, allow_stale_account = false, force_mirror = false, mirror_readiness = null, bypass_cache = false, legacy_manual_key_policy = LEGACY_MANUAL_KEY_POLICY.DENY } = {}) {
  const legacyManualKeyPolicy = normalizeLegacyManualKeyPolicy(legacy_manual_key_policy);
  const initialOptions = {
    account_id,
    signal,
    onProgress,
    allow_stale_account,
    force_mirror,
    mirror_readiness,
    bypass_cache,
    legacy_manual_key_policy: legacyManualKeyPolicy,
  };
  try {
    return await listGroupsOnce(initialOptions);
  } catch (error) {
    const code = String(error?.public_code || error?.code || '').trim();
    if (signal?.aborted || code !== 'wxdb_mirror_readiness_changed') throw error;
    notifyProgress(onProgress, {
      phase: 'groups_mirror_snapshot_retry',
      label: '读取群列表 · 本地数据刚更新，自动重试',
      detail: '前一次未返回任何群列表结果，已丢弃；正在使用最新已发布的本地工作数据重新确认账号和群列表',
    });
    // A group-list request has no committed partial result, so retrying once on
    // the newest published snapshot is safe and avoids surfacing a refresh race.
    return await listGroupsOnce({
      ...initialOptions,
      force_mirror: false,
      mirror_readiness: null,
    });
  }
}

async function listGroupsOnce({ account_id = '', signal = null, onProgress = null, allow_stale_account = false, force_mirror = false, mirror_readiness = null, bypass_cache = false, legacy_manual_key_policy = LEGACY_MANUAL_KEY_POLICY.DENY } = {}) {
  throwIfAborted(signal);
  const legacyManualKeyPolicy = normalizeLegacyManualKeyPolicy(legacy_manual_key_policy);
  const groupProgress = data => notifyProgress(onProgress, {
    ...data,
    label: String(data?.label || '').replace(/^拉取消息/, '读取群列表'),
  });
  let groupEnv = await detectWeixin({ force: !String(account_id || '').trim(), signal });
  throwIfAborted(signal);
  let groupAccount = pickAccount(groupEnv.accounts || [], account_id);
  if (!groupAccount && String(account_id || '').trim()) {
    groupEnv = await detectWeixin({ force: true, signal });
    throwIfAborted(signal);
    groupAccount = pickAccount(groupEnv.accounts || [], account_id);
  }
  const groupsOnlyMirror = hasWxDbMirrorIdentityAnchor(groupAccount);
  let groupMirrorReason = groupsOnlyMirror ? 'groups' : 'identity';
  let ready = await ensureProjectMirrorAccountSelected({
    account_id,
    signal,
    onProgress: groupProgress,
    reason: groupMirrorReason,
    source_busy_reuse_purpose: 'groups',
    force_mirror,
    mirror_readiness,
    allow_stale_account,
    dbName: 'contact.db',
  });
  const preparedMirrorScope = String(ready?.mirror?.mirror_readiness?.scope || '').trim().toLowerCase();
  if (preparedMirrorScope === 'identity') groupMirrorReason = 'identity';
  if (preparedMirrorScope === 'digest' || preparedMirrorScope === 'full') groupMirrorReason = 'digest';
  if (groupsOnlyMirror && !accountIdentityVerified(ready?.account) && groupMirrorReason === 'groups') {
    groupProgress({
      phase: 'groups_identity_recheck',
      label: '读取群列表 · 重新确认当前账号',
      detail: '群列表工作副本未带账号身份验证范围，正在补齐最小消息样本；不会返回未确认账号的群列表',
    });
    groupMirrorReason = 'identity';
    ready = await ensureProjectMirrorAccountSelected({
      account_id,
      signal,
      onProgress: groupProgress,
      reason: 'identity',
      source_busy_reuse_purpose: 'groups',
      force_mirror,
      mirror_readiness: null,
      allow_stale_account,
      dbName: 'contact.db',
    });
  }
  if (!ready?.account) {
    throw Object.assign(new Error('当前微信账号不可用，请重新选择右上角账号后再读取群列表。'), { status: 400, code: 'account_missing' });
  }
  const selectedAccountId = ready.account.account_id || ready.account.id || ready.account.wxid || account_id;
  if (!allow_stale_account) {
    const staleError = staleAccountSelectedError(ready.env, ready.account, 'contact.db');
    if (staleError) throw staleError;
  }

  try {
    const cacheKey = groupCacheKey(ready.env, selectedAccountId, legacyManualKeyPolicy);
    if (!force_mirror
      && !bypass_cache
      && REAL_GROUP_CACHE?.key === cacheKey
      && groupCacheEntryFresh(REAL_GROUP_CACHE)
      && (!REAL_GROUP_CACHE.allow_stale_account || allow_stale_account)) {
      groupProgress({
        phase: 'groups_cache',
        label: '读取群列表 · 命中缓存',
        detail: `复用 ${Array.isArray(REAL_GROUP_CACHE.groups) ? REAL_GROUP_CACHE.groups.length : 0} 个群`,
      });
      return REAL_GROUP_CACHE.groups;
    }
    groupProgress({
      phase: 'groups_key_prepare',
      label: '读取群列表 · 准备 contact.db 密钥',
      detail: '先试缓存、上次验证通过候选、手动密钥和本地密钥文件',
    });
  const keyRuntimeStateVersionAtStart = DB_KEY_RUNTIME_STATE_VERSION;
    const readChatrooms = keyBundle => {
      const payload = { account_id: selectedAccountId, raw_keys: keyBundle.rawKeys, signal, mirror_scope: groupMirrorReason, mirror_readiness: ready.mirror?.mirror_readiness || null, onProgress: groupProgress, allow_key_scan: false };
      return allow_stale_account && ready.account?.source === 'project-mirror' && ready.account?.mirror?.source_status !== 'available'
        ? listChatroomsFromWxDbIsolated({ ...payload, allow_stale_account: true })
        : listChatroomsFromWxDbIsolated(payload);
    };
    const groups = await runWithDbKeys({
      dbName: 'contact.db',
      account_id: selectedAccountId,
      allow_stale_account,
      progress_context: 'groups',
      standard_probe_scope: groupMirrorReason,
      standard_mirror_readiness: ready.mirror?.mirror_readiness || null,
      standard_mirror_reason: groupMirrorReason,
      account_fingerprint: manualKeyAccountFingerprint(ready.account),
      source_account_unavailable: allow_stale_account && ready.account?.source === 'project-mirror' && ready.account?.mirror?.source_status !== 'available',
      legacy_manual_key_policy: legacyManualKeyPolicy,
      signal,
      onProgress: groupProgress,
      action: readChatrooms,
    });
    throwIfAborted(signal);
    assertDbKeyRuntimeStateVersion(keyRuntimeStateVersionAtStart, '群列表读取');
    if (Array.isArray(groups)) {
      const verifiedRawKeys = verifiedRawKeysFromResult(groups);
      const verifiedAccount = verifiedAccountFromResult(groups);
      const verifiedCacheStatus = await rememberVerifiedRawKeys(selectedAccountId, verifiedRawKeys, {
        account: verifiedAccount,
        expected_state_version: keyRuntimeStateVersionAtStart,
        signal,
      });
      if (verifiedCacheStatus?.persistence?.skipped === 'stale_runtime_state') {
        assertDbKeyRuntimeStateVersion(keyRuntimeStateVersionAtStart, '群列表读取');
      }
      const keyCachePersistence = notifyVerifiedKeyCachePersistence(groupProgress, verifiedCacheStatus, '读取群列表');
      if (keyCachePersistence) {
        Object.defineProperty(groups, '__key_cache_persistence', {
          value: keyCachePersistence,
          enumerable: false,
          configurable: true,
        });
      }
      const cacheTtlMs = groupListCacheTtlMs(groups);
      const resultCacheKey = groupCacheKey(ready.env, selectedAccountId, legacyManualKeyPolicy);
      if (cacheTtlMs > 0) {
        REAL_GROUP_CACHE = {
          key: resultCacheKey,
          at: Date.now(),
          ttl_ms: cacheTtlMs,
          groups,
          allow_stale_account: !!allow_stale_account,
        };
      } else if (REAL_GROUP_CACHE?.key === cacheKey || REAL_GROUP_CACHE?.key === resultCacheKey) {
        REAL_GROUP_CACHE = null;
      }
      groupProgress({
        phase: 'groups_done',
        label: '读取群列表 · 已整理',
        detail: `已读取 ${groups.length} 个群`,
      });
      return groups;
    }
    throw Object.assign(new Error('未能从本机微信数据库读取群列表。'), { status: 502 });
  } catch (e) {
    rethrowIfAborted(e, signal, '群列表读取已取消');
    const msg = e?.message ? `读取本机微信群列表失败：${e.message}` : '读取本机微信群列表失败。';
    const keyDiagnostics = e?.key_diagnostics || shardOpenKeyDiagnostics(e);
    throw Object.assign(new Error(msg), {
      status: e?.status || 502,
      code: e?.code,
      public_code: e?.public_code || e?.code,
      key_diagnostics: keyDiagnostics || null,
      wxdb_diagnostics: e?.wxdb_diagnostics || null,
    });
  }
}

function groupCacheKey(env = {}, accountId = '', legacyManualKeyPolicy = LEGACY_MANUAL_KEY_POLICY.DENY) {
  const accounts = Array.isArray(env.accounts) ? env.accounts : [];
  const requested = String(accountId || '').trim();
  const account = pickAccount(accounts, requested);
  const mirror = account?.mirror && typeof account.mirror === 'object' ? account.mirror : {};
  return JSON.stringify({
    requested: requested || 'default',
    account_id: account?.account_id || account?.id || account?.wxid || '',
    legacy_id: account?.legacy_id || account?.id || '',
    wxid: account?.wxid || '',
    db_storage: account?.db_storage || '',
    last_write_time: accountDisplayLastWriteTime(account || {}),
    source_last_write_time: accountSourceLastWriteTime(account || {}),
    mirror_last_write_time: accountMirrorLastWriteTime(account || {}),
    mirror_root: mirror.relative_root || '',
    mirror_refreshed_at: mirror.refreshed_at || mirror.imported_at || '',
    mirror_refresh_reason: mirror.refresh_reason || '',
    mirror_refresh_action: mirror.refresh_action || '',
    mirror_groups_snapshot_hash: mirror.source_scopes?.groups?.source_snapshot_meta_hash || '',
    mirror_digest_snapshot_hash: mirror.source_scopes?.digest?.source_snapshot_meta_hash || '',
    mirror_full_snapshot_hash: mirror.source_snapshot_meta_hash || mirror.source_scopes?.full?.source_snapshot_meta_hash || '',
    mirror_db_count: Number(mirror.db_count || 0) || 0,
    mirror_bytes: Number(mirror.bytes || 0) || 0,
    account_count: accounts.length,
    db_key_runtime_state_version: DB_KEY_RUNTIME_STATE_VERSION,
    legacy_manual_key_policy: legacyManualKeyPolicy,
  });
}

function groupCacheEntryFresh(entry = {}) {
  const ttlMs = Math.max(1, Number(entry?.ttl_ms || GROUP_LIST_CACHE_MS) || GROUP_LIST_CACHE_MS);
  return Date.now() - Number(entry?.at || 0) < ttlMs;
}

function groupListCacheTtlMs(groups = []) {
  if (!Array.isArray(groups) || !groups.length) return 0;
  const sessionUnavailable = groups.some(group => String(group?.last_msg_status || '').trim() === 'session_unavailable');
  return sessionUnavailable ? DEGRADED_GROUP_LIST_CACHE_MS : GROUP_LIST_CACHE_MS;
}

function missingWeixinDataMessage() {
  return process.platform === 'darwin'
    ? '未检测到 Mac 微信，也未找到可读取的微信 v4 数据目录；请先登录微信，或确认 xwechat_files 数据目录可访问。'
    : '未检测到 Weixin.exe，请先登录 Windows 微信后重试。';
}

function projectMirrorRequiredError() {
  return Object.assign(new Error('微信本地工作数据尚未准备好。程序会先自动从源数据库准备项目副本后再读取；后续重试会重新按源库文件元数据判断复用或更新，不需要手动配置路径。'), {
    status: 428,
    code: 'wxdb_mirror_required',
    public_code: 'wxdb_mirror_required',
  });
}

function mirrorReadinessMatchesExpected(expected = null, actual = null, accountAliases = new Set()) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return false;
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const expectedAccountId = String(expected.account_id || '').trim();
  const actualAccountId = String(actual.account_id || '').trim();
  const expectedScope = String(expected.scope || expected.mirror_scope || '').trim().toLowerCase();
  const actualScope = String(actual.scope || actual.mirror_scope || '').trim().toLowerCase();
  const expectedManifestScope = String(expected.manifest_scope || expectedScope).trim().toLowerCase();
  const actualManifestScope = String(actual.manifest_scope || actualScope).trim().toLowerCase();
  const expectedHash = String(expected.source_snapshot_meta_hash || '').trim();
  const actualHash = String(actual.source_snapshot_meta_hash || '').trim();
  const expectedManifestHash = String(expected.published_manifest_hash || '').trim().toLowerCase();
  const actualManifestHash = String(actual.published_manifest_hash || '').trim().toLowerCase();
  const accountMatches = !!expectedAccountId
    && !!actualAccountId
    && (expectedAccountId === actualAccountId
      || (accountAliases.has(expectedAccountId) && accountAliases.has(actualAccountId)));
  return accountMatches
    && !!expectedScope
    && expectedScope === actualScope
    && !!expectedManifestScope
    && expectedManifestScope === actualManifestScope
    && !!expectedHash
    && expectedHash === actualHash
    && !!expectedManifestHash
    && expectedManifestHash === actualManifestHash;
}

function mirrorReadinessMatchesAccount(readiness = null, account = null) {
  if (!readiness || typeof readiness !== 'object' || Array.isArray(readiness) || !account) return false;
  const scope = String(readiness.scope || readiness.mirror_scope || '').trim().toLowerCase();
  const manifestScope = String(readiness.manifest_scope || scope).trim().toLowerCase();
  if (!scope
    || !manifestScope
    || !mirrorReadinessCoversRequiredScope(scope, { scope: manifestScope })) return false;
  const scoped = wxDbMirrorScopeRecordsForRead(account.mirror || {}, manifestScope)
    .find(candidate => String(candidate?.key || '').trim().toLowerCase() === manifestScope
      && String(candidate?.record?.source_snapshot_meta_hash || '').trim());
  const actual = {
    account_id: String(account.account_id || account.id || account.wxid || '').trim(),
    scope,
    manifest_scope: manifestScope,
    source_snapshot_meta_hash: String(scoped?.record?.source_snapshot_meta_hash || '').trim(),
    published_manifest_hash: String(account.mirror?.published_manifest_hash || '').trim().toLowerCase(),
  };
  return mirrorReadinessMatchesExpected(readiness, actual, new Set(accountAliases(account)));
}

function mirrorReadinessCoversRequiredScope(requiredScope = '', readiness = null) {
  const requested = String(requiredScope || '').trim().toLowerCase();
  const required = requested === 'groups' ? 'groups' : (requested === 'identity' ? 'identity' : 'digest');
  const ready = String(readiness?.scope || readiness?.mirror_scope || '').trim().toLowerCase();
  if (required === 'groups') return ['groups', 'identity', 'digest', 'full'].includes(ready);
  if (required === 'identity') return ['identity', 'digest', 'full'].includes(ready);
  return ['digest', 'full'].includes(ready);
}

function mirrorReadinessChangedError() {
  return Object.assign(new Error('本次读取开始后，微信本地数据已更新为另一个快照。为避免同一批长图或文本混用不同时间点的数据，系统已停止本批生成；请重新点击生成。'), {
    status: 409,
    code: 'wxdb_mirror_readiness_changed',
    public_code: 'wxdb_mirror_readiness_changed',
  });
}

async function assertDigestMirrorReadGenerationStillCurrent(accountId = '', readiness = null, { signal = null, onProgress = null } = {}) {
  throwIfAborted(signal);
  const lockAccountId = String(readiness?.account_id || accountId || '').trim();
  notifyProgress(onProgress, {
    phase: 'fetch_snapshot_commit_check',
    label: '拉取消息 · 复核读取快照',
    detail: '确认消息读取期间项目工作副本没有换代',
  });
  await withWxDbMirrorReadLock(lockAccountId, async () => {
    throwIfAborted(signal);
    const currentAccount = await readWxDbMirrorAccount(lockAccountId, { signal });
    throwIfAborted(signal);
    if (!mirrorReadinessMatchesAccount(readiness, currentAccount)) throw mirrorReadinessChangedError();
  }, { signal });
  notifyProgress(onProgress, {
    phase: 'fetch_snapshot_commit_ready',
    label: '拉取消息 · 快照复核完成',
    detail: '本次读取使用的源快照和发布文件清单均未变化',
  });
  return true;
}

function wxdbAccountNotFoundError(accountId = '', phase = 'detect') {
  const requested = String(accountId || '').trim();
  return Object.assign(new Error(requested
    ? '当前选择的微信账号不在最新可读取账号列表中；已停止返回空群或空消息。请刷新账号列表后重新选择。'
    : '未找到可读取的微信账号；已停止返回空群或空消息。请确认微信已登录后刷新账号列表。'), {
    status: 409,
    code: 'wxdb_account_not_found',
    public_code: 'wxdb_account_not_found',
    account_id: requested,
    phase,
  });
}

async function ensureProjectMirrorAccountSelected({ account_id = '', signal = null, onProgress = null, reason = 'read', source_busy_reuse_purpose = '', force_mirror = false, mirror_readiness = null, allow_stale_account = false, required_through_ms = 0, dbName = '' } = {}) {
  throwIfAborted(signal);
  const explicitAccountId = !!String(account_id || '').trim();
  let env = await detectWeixin({ force: !explicitAccountId, signal });
  throwIfAborted(signal);
  if (!env.accounts?.length) {
    throw Object.assign(new Error(env.running === false
      ? missingWeixinDataMessage()
      : `未找到可读取的微信 v4 数据目录：${env.message || '请确认微信已登录并完成初始化。'}`), { status: 503 });
  }
  let selected = pickAccount(env.accounts || [], account_id);
  if (!selected && explicitAccountId) {
    env = await detectWeixin({ force: true, signal });
    throwIfAborted(signal);
    selected = pickAccount(env.accounts || [], account_id);
  }
  if (!selected) throw wxdbAccountNotFoundError(account_id, 'before_mirror_refresh');
  const selectedId = account_id || selected.account_id || selected.id || selected.wxid || '';
  const readiness = mirror_readiness && typeof mirror_readiness === 'object' && !Array.isArray(mirror_readiness)
    ? mirror_readiness
    : null;
  const requestedScope = String(reason || '').trim().toLowerCase();
  const requiredMirrorScope = requestedScope === 'groups' ? 'groups' : (requestedScope === 'identity' ? 'identity' : 'digest');
  const reusableReadiness = mirrorReadinessCoversRequiredScope(requiredMirrorScope, readiness) ? readiness : null;
  const readinessAccountId = String(readiness?.account_id || '').trim();
  const selectedAliases = new Set([
    selected.account_id,
    selected.id,
    selected.legacy_id,
    selected.wxid,
    ...(Array.isArray(selected.account_aliases) ? selected.account_aliases : []),
    selectedId,
  ].map(value => String(value || '').trim()).filter(Boolean));
  const reusePreparedMirror = !force_mirror && !!reusableReadiness && !!readinessAccountId && selectedAliases.has(readinessAccountId);
  if (readiness && !reusableReadiness) {
    notifyProgress(onProgress, {
      phase: 'fetch_mirror_scope_upgrade',
      label: '读取群列表 · 补齐身份验证数据',
      detail: requiredMirrorScope === 'identity'
        ? '已准备的群列表副本不含当前账号验证所需的消息证据；正在自动准备最小身份样本后继续读取'
        : '已准备的本地数据不含本次摘要所需的完整消息范围；正在自动补齐后继续读取',
    });
  }
  notifyProgress(onProgress, {
    phase: reusePreparedMirror ? 'fetch_mirror_batch_reuse' : 'fetch_mirror',
    label: '拉取消息 · 检查本地数据',
    detail: reusePreparedMirror
      ? '本批已完成源库文件元数据检查，复用同一项目工作副本'
      : (selected.source === 'project-mirror'
          ? '检查本地工作数据是否需要更新'
          : '首次读取前自动准备本地工作数据'),
  });
  const mirror = reusePreparedMirror
    ? {
        account_id: readinessAccountId,
        mirror_readiness: reusableReadiness,
        reused: true,
        refreshed: false,
        stale: readiness.stale === true,
        source_busy: readiness.source_busy === true,
        offline: readiness.offline === true,
        source_access: String(readiness.source_access || 'copy_only_batch_reuse').trim(),
        refreshed_at: String(readiness.refreshed_at || '').trim(),
        captured_at: String(readiness.captured_at || readiness.refreshed_at || '').trim(),
        source_snapshot_meta_hash: String(readiness.source_snapshot_meta_hash || '').trim(),
        refresh_reason: String(readiness.refresh_reason || 'batch_snapshot_reused').trim(),
        source_busy_reuse_mode: String(readiness.source_busy_reuse_mode || '').trim(),
        required_through_ms: Math.max(0, Number(readiness.required_through_ms || 0) || 0),
        requested_range_covered: readiness.requested_range_covered === true,
        refresh_reason_label: readiness.stale === true
          ? '复用本批已校验的上次稳定副本'
          : '复用本批已准备的本地工作数据',
        refresh_action: 'reuse',
      }
    : await ensureWxDbMirror({
        account_id: selectedId,
        signal,
        onProgress,
        reason,
        source_busy_reuse_purpose,
        force: force_mirror,
        allow_stale_account,
        required_through_ms,
      });
  throwIfAborted(signal);
  // A forced refresh intentionally creates a new snapshot. The old batch token
  // may identify the stale snapshot that triggered the retry, so it must not
  // reject the freshly published mirror.
  if (!force_mirror && reusableReadiness && !mirrorReadinessMatchesExpected(reusableReadiness, mirror?.mirror_readiness, selectedAliases)) {
    throw mirrorReadinessChangedError();
  }
  if (mirror?.refreshed) {
    clearDbKeyRuntimeCacheAfterMirrorRefresh(mirror);
  }
  const shouldReload = mirror?.refreshed || mirror?.stale || selected.source !== 'project-mirror';
  if (shouldReload) {
    env = await detectWeixin({ force: true, signal });
    throwIfAborted(signal);
  }
  const account = pickAccount(env.accounts || [], mirror?.account_id || selectedId);
  if (!account) throw wxdbAccountNotFoundError(mirror?.account_id || selectedId, 'after_mirror_refresh');
  if (account.source !== 'project-mirror') throw projectMirrorRequiredError();
  if (!allow_stale_account) {
    const staleError = staleAccountSelectedError(env, account, dbName || '数据库');
    if (staleError) throw staleError;
  }
  notifyProgress(onProgress, {
    phase: 'fetch_mirror_done',
    label: '拉取消息 · 本地数据就绪',
    detail: mirror?.stale
      ? (mirror?.source_busy
          ? `${mirror?.requested_range_covered ? '微信仍在写入；已自动使用覆盖所选结束时间的稳定副本' : '微信仍在写入；已自动使用最近一次稳定副本'}${mirror?.captured_at || mirror?.refreshed_at ? `（截点 ${new Date(mirror.captured_at || mirror.refreshed_at).toLocaleString('zh-CN', { hour12: false })}）` : ''}`
          : '已按你的显式选择使用上次稳定副本；该副本可能不含刚收到的消息，结果不会作为最新数据结论')
      : mirror?.reused
        ? '本地工作数据已是最新，继续读取'
      : `已更新 ${mirror?.refreshed_db_count ?? mirror?.db_count ?? 0} 个摘要所需本地数据文件`,
  });
  return { env, account, mirror };
}

export async function collectMessages({ account_id = '', group_id, group_name, since, until, since_ms = undefined, until_ms = undefined, filters = {}, min_messages = 1, signal, onProgress = null, allow_stale_account = false, target_group = null, skip_media_enrichment = false, media_enrichment_skip_reason = '', batch_id = '', force_mirror = false, mirror_readiness = null, shard_row_positions = {}, shard_row_positions_initialized = false, legacy_manual_key_policy = LEGACY_MANUAL_KEY_POLICY.DENY } = {}) {
  throwIfAborted(signal);
  const legacyManualKeyPolicy = normalizeLegacyManualKeyPolicy(legacy_manual_key_policy);
  if (!group_id) {
    throw Object.assign(new Error('请先选择一个本机微信会话。'), { status: 400 });
  }
  if (!since) {
    throw Object.assign(new Error('请先选择要总结的起始时间，避免误读全部历史消息。'), { status: 400 });
  }
  const requestedRange = validateMessageTimeRange(since, until, { since_ms, until_ms });

  try {
    throwIfAborted(signal);
    notifyProgress(onProgress, {
      phase: 'fetch_mirror',
      label: '拉取消息 · 检查本地数据',
      detail: '检查源库是否需要更新本地工作数据',
    });
    const ready = await ensureProjectMirrorAccountSelected({
      account_id,
      signal,
      onProgress,
      reason: 'digest',
      source_busy_reuse_purpose: 'digest',
      force_mirror,
      mirror_readiness,
      allow_stale_account,
      required_through_ms: requestedRange.end?.getTime() || 0,
      dbName: '微信消息库',
    });
    if (!ready?.account) {
      throw Object.assign(new Error('当前微信账号不可用，请重新选择右上角账号后再生成摘要。'), { status: 400, code: 'account_missing' });
    }
    const selectedAccountId = ready.account.account_id || ready.account.id || ready.account.wxid || account_id;
    if (!allow_stale_account) {
      const staleError = staleAccountSelectedError(ready.env, ready.account, '微信消息库');
      if (staleError) throw staleError;
    }
    notifyProgress(onProgress, {
      phase: 'fetch_key',
      label: '拉取消息 · 准备数据库密钥',
      detail: '优先使用缓存/手动密钥，必要时只读扫描',
    });
    const keyRuntimeStateVersionAtStart = DB_KEY_RUNTIME_STATE_VERSION;
    const real = await runWithDbKeys({
      dbName: '微信消息库',
      account_id: selectedAccountId,
      allow_stale_account,
      progress_context: 'digest',
      standard_probe_scope: 'message',
      standard_mirror_readiness: ready.mirror?.mirror_readiness || null,
      standard_mirror_reason: 'digest',
      account_fingerprint: manualKeyAccountFingerprint(ready.account),
      source_account_unavailable: allow_stale_account && ready.account?.source === 'project-mirror' && ready.account?.mirror?.source_status !== 'available',
      legacy_manual_key_policy: legacyManualKeyPolicy,
      onProgress,
      signal,
      action: bundle => collectMessagesFromWxDbIsolated({
        batch_id,
        account_id: selectedAccountId,
        group_id,
        since,
        until,
        since_ms,
        until_ms,
        shard_row_positions,
        shard_row_positions_initialized,
        mirror_readiness: ready.mirror?.mirror_readiness || null,
        raw_keys: bundle.rawKeys,
        min_messages,
        signal,
        onProgress,
        allow_key_scan: false,
        pre_media_filter_spec: {
          senders: filters.senders || [],
          exclude_types: filters.exclude_types || filters.excludeTypes || [],
        },
        sender_filter_active: senderFilterActive(filters),
        sender_filter_terms: filters.senders || [],
        fallback_sensitive_filter_active: sortSeqFallbackSensitiveFilterActive(filters),
        skip_media_enrichment,
        media_enrichment_skip_reason,
        allow_stale_account: allow_stale_account && ready.account?.source === 'project-mirror' && ready.account?.mirror?.source_status !== 'available',
      }),
    });
    throwIfAborted(signal);
    assertDbKeyRuntimeStateVersion(keyRuntimeStateVersionAtStart, '消息读取');
    await assertDigestMirrorReadGenerationStillCurrent(selectedAccountId, ready.mirror?.mirror_readiness || null, {
      signal,
      onProgress,
    });
    throwIfAborted(signal);
    assertDbKeyRuntimeStateVersion(keyRuntimeStateVersionAtStart, '消息读取');
    if (real) {
      const verifiedRawKeys = verifiedRawKeysFromResult(real);
      const verifiedCacheStatus = await rememberVerifiedRawKeys(selectedAccountId, verifiedRawKeys, {
        account: real.account,
        expected_state_version: keyRuntimeStateVersionAtStart,
        signal,
      });
      if (verifiedCacheStatus?.persistence?.skipped === 'stale_runtime_state') {
        assertDbKeyRuntimeStateVersion(keyRuntimeStateVersionAtStart, '消息读取');
      }
      const keyCachePersistence = notifyVerifiedKeyCachePersistence(onProgress, verifiedCacheStatus, '拉取消息');
      if (verifiedRawKeys.length) {
        const rememberedCurrentKey = await rememberVerifiedAutoRawKeys(selectedAccountId, verifiedRawKeys, {
          expected_state_version: keyRuntimeStateVersionAtStart,
          verified_scope: 'message_sample',
          account: real.account,
          signal,
        });
        if (!rememberedCurrentKey) assertDbKeyRuntimeStateVersion(keyRuntimeStateVersionAtStart, '消息读取');
      }
      const rawMessages = Array.isArray(real.messages) ? real.messages : [];
      const filterActive = filtersAreActive(filters);
      const preFilterCount = Number(real.pre_filter_message_count || real.scanned_message_count || rawMessages.length) || rawMessages.length;
      const senderHydration = real.sender_hydration || null;
      notifyProgress(onProgress, {
        phase: 'fetch_filter',
        label: filterActive ? '拉取消息 · 应用筛选' : '拉取消息 · 整理消息',
        detail: filterActive ? `筛选前 ${preFilterCount} 条` : `读取到 ${rawMessages.length} 条`,
      });
      const filtered = applyFilters(rawMessages, filters).map(redactMessageSecrets);
      const cursorMessages = rawMessages.map(redactMessageSecrets);
      const mediaStatus = summarizeMediaStatus(filtered);
      notifyProgress(onProgress, {
        phase: 'fetch_ready',
        label: '拉取消息 · 准备送入 AI',
        detail: [
          `${filtered.length} 条可总结消息`,
          filterActive ? `筛选前 ${preFilterCount} 条` : '',
          senderHydration?.ok === false ? '发送人昵称未补全，已使用原始 ID' : '',
          real.media_skipped_reason === 'privacy_media_disabled' ? '隐私设置未允许媒体内容附给 AI，已跳过本地媒体解码' : '',
          mediaStatus ? `${mediaStatus.attached}/${mediaStatus.media_messages} 条媒体已附加` : '',
        ].filter(Boolean).join(' · '),
      });
      throwIfAborted(signal);
      const sourceSnapshot = digestSourceSnapshot({
        account: real.account || ready.account,
        mirror: real.mirror_snapshot || ready.mirror || real.account?.mirror,
        group_id,
        since,
        until,
        since_ms,
        until_ms,
      });
      const collected = {
        source: 'wxdb',
        source_label: real.account?.source === 'project-mirror'
          ? '项目内本地工作数据（只读）'
          : '微信本机工作数据（只读）',
        source_snapshot: sourceSnapshot,
        empty_collection_retry_key: emptyCollectionMirrorRetryKey({
          account_id: sourceSnapshot.account_id || selectedAccountId,
          group_id,
          since,
          until,
          since_ms,
          until_ms,
          source_snapshot: sourceSnapshot,
          filters,
          min_messages,
        }),
        mirror_readiness: ready.mirror?.mirror_readiness || null,
        group_name: group_name || group_id,
        target_last_msg_at: Math.max(0, Number(target_group?.last_msg_at || 0) || 0),
        target_last_msg_status: String(target_group?.last_msg_status || '').trim(),
        since,
        until,
        since_ms: Number.isSafeInteger(Number(since_ms)) ? Number(since_ms) : null,
        until_ms: Number.isSafeInteger(Number(until_ms)) ? Number(until_ms) : null,
        min_messages: Math.max(0, Number(min_messages || 0) || 0),
        messages: filtered,
        message_count: filtered.length,
        cursor_messages: cursorMessages,
        cursor_message_count: cursorMessages.length,
        pre_filter_message_count: preFilterCount,
        scanned_message_count: real.scanned_message_count,
        duplicate_message_count: Math.max(0, Number(real.duplicate_message_count || 0) || 0),
        shard_row_positions_initialized: real.shard_row_positions_initialized === true,
        shard_row_positions: real.shard_row_positions && typeof real.shard_row_positions === 'object'
          ? real.shard_row_positions
          : {},
        late_sync_incremental_message_count: Math.max(0, Number(real.late_sync_incremental_message_count || 0) || 0),
        table: real.table || '',
        searched_shard_count: real.searched_shard_count,
        candidate_shard_count: real.candidate_shard_count,
        skipped_before_range_shard_count: real.skipped_before_range_shard_count,
        mtime_before_range_shard_count: real.mtime_before_range_shard_count,
        mtime_after_range_shard_count: real.mtime_after_range_shard_count,
        readable_shard_count: real.readable_shard_count,
        matching_shard_count: real.matching_shard_count,
        table_row_count: Math.max(0, Number(real.table_row_count || real.message_table_time_range?.row_count || 0) || 0),
        window_hit_count: Math.max(0, Number(real.window_hit_count || real.message_table_time_range?.hit_count || 0) || 0),
        query_time_bounds: real.query_time_bounds || null,
        message_table_time_range: real.message_table_time_range || null,
        message_shards_last_write_time: real.message_shards_last_write_time || '',
        all_message_shards_before_range: !!real.all_message_shards_before_range,
        truncated: !!real.truncated,
        media_status: mediaStatus,
        media_skipped_reason: real.media_skipped_reason || '',
        sender_hydration: senderHydration,
        filter_active: filterActive,
        no_matching_filters: filterActive && preFilterCount > 0 && filtered.length === 0,
        below_minimum: Number(min_messages || 0) > 0 && filtered.length < Number(min_messages || 0),
        key_cache_persistence: keyCachePersistence,
      };
      attachLegacyManualKeyBinding(collected, legacyManualKeyBindingFromResult(real));
      return collected;
    }
    throw Object.assign(new Error('未能从本机微信数据库读取该会话消息。'), { status: 502 });
  } catch (e) {
    rethrowIfAborted(e, signal, '消息读取已取消');
    const msg = e?.message ? `读取本机微信数据库失败：${e.message}` : '读取本机微信数据库失败。';
    const keyDiagnostics = e?.key_diagnostics || shardOpenKeyDiagnostics(e);
    throw Object.assign(new Error(msg), {
      status: e?.status || 502,
      code: e?.code,
      public_code: e?.public_code || e?.code,
      wxdb_diagnostics: e?.wxdb_diagnostics || null,
      key_diagnostics: keyDiagnostics || null,
    });
  }
}

function senderFilterActive(filters = {}) {
  return normalizeFilterTerms(filters.senders || []).length > 0;
}

function sortSeqFallbackSensitiveFilterActive(filters = {}) {
  return senderFilterActive(filters) || normalizeFilterTerms(filters.keywords || []).length > 0;
}

export function validateMessageTimeRange(since, until, { rejectFutureStart = false, since_ms = undefined, until_ms = undefined } = {}) {
  const hasSinceEpoch = since_ms !== undefined && since_ms !== null && since_ms !== '';
  const hasUntilEpoch = until_ms !== undefined && until_ms !== null && until_ms !== '';
  if (hasSinceEpoch !== hasUntilEpoch) {
    throw Object.assign(new Error('时间范围必须同时包含起止时间戳。'), {
      status: 400,
      code: 'digest_range_epoch_incomplete',
      public_code: 'digest_range_epoch_incomplete',
    });
  }
  const start = hasSinceEpoch ? parseMessageEpochMs(since_ms, '起始时间') : parseMessageDateTime(since, '起始时间');
  const end = hasUntilEpoch
    ? parseMessageEpochMs(until_ms, '结束时间')
    : parseMessageDateTime(until || 'now', '结束时间', {
      allowNow: true,
      endOfMinuteWhenSecondsMissing: true,
      endOfSecond: true,
    });
  if (start && end && start > end) {
    throw Object.assign(new Error('起始时间不能晚于结束时间。'), {
      status: 400,
      code: 'digest_range_reversed',
      public_code: 'digest_range_reversed',
    });
  }
  if (rejectFutureStart && start && start.getTime() > Date.now() + 60_000) {
    throw Object.assign(new Error('起始时间晚于当前时间；这个时间窗还没有本机微信消息，请选择当前时间之前的范围。'), {
      status: 400,
      code: 'digest_range_starts_in_future',
      public_code: 'digest_range_starts_in_future',
    });
  }
  return { start, end };
}

function parseMessageEpochMs(value, label) {
  const epochMs = Number(value);
  if (!Number.isSafeInteger(epochMs) || epochMs < Date.UTC(2000, 0, 1) || epochMs > Date.UTC(2200, 0, 1)) {
    throw Object.assign(new Error(`${label}时间戳无效。`), {
      status: 400,
      code: 'digest_range_epoch_invalid',
      public_code: 'digest_range_epoch_invalid',
    });
  }
  return new Date(epochMs);
}

export function messageCollectionTargetLastMessageEvidence(collection = {}) {
  const timestamp = Math.max(0, Number(collection?.target_last_msg_at || 0) || 0);
  const status = String(collection?.target_last_msg_status || '').trim().slice(0, 80);
  if (!Number.isFinite(timestamp) || timestamp < 946684800000) {
    return { timestamp: 0, relation: 'unknown', before_range: false, in_range: false, after_range: false, status };
  }
  const explicitSinceMs = Number(collection?.since_ms);
  const explicitUntilMs = Number(collection?.until_ms);
  const sinceMs = Number.isSafeInteger(explicitSinceMs)
    ? explicitSinceMs
    : safeMessageDateTimeMs(collection?.since);
  const untilMs = Number.isSafeInteger(explicitUntilMs)
    ? explicitUntilMs
    : safeMessageDateTimeMs(collection?.until || 'now', {
        allowNow: true,
        endOfMinuteWhenSecondsMissing: true,
        endOfSecond: true,
      });
  const trustedTime = status !== 'untrusted_time';
  const bounded = trustedTime && Number.isFinite(sinceMs) && Number.isFinite(untilMs);
  const relation = !bounded
    ? 'unknown'
    : (timestamp < sinceMs ? 'before_range' : (timestamp > untilMs ? 'after_range' : 'in_range'));
  return {
    timestamp,
    relation,
    before_range: relation === 'before_range',
    in_range: relation === 'in_range',
    after_range: relation === 'after_range',
    status,
  };
}

export function shouldRecheckMirrorForEmptyCollection(collection = {}) {
  if (!collection
    || collection.mirror_recheck_attempted === true
    || collection.force_mirror_retry_attempted === true) return false;
  // Only a proven filter miss can explain an empty result without rechecking
  // the project copy. A zero-row database read remains suspicious even when
  // filters are enabled: no message reached the filter stage at all.
  if (collection.no_matching_filters) return false;
  const messageCount = Math.max(0, Number(collection.message_count || 0) || 0);
  const empty = messageCount === 0 && (!Array.isArray(collection.messages) || collection.messages.length === 0);
  // "Below the user's threshold" is still a successful physical read. The
  // threshold is a presentation policy, not evidence that the copied database
  // is stale. Rebuilding a large mirror here both delays the result and makes
  // a normal low-volume group vulnerable to a concurrent WeChat write.
  if (!empty) return false;
  const targetEvidence = messageCollectionTargetLastMessageEvidence(collection);
  const targetContradictsProjectCopy = targetEvidence.in_range
    || (targetEvidence.after_range && collection.all_message_shards_before_range === true);
  // A trusted recent-message timestamp is positive evidence from the same
  // account snapshot. It must win over old rows or shard boundaries from a
  // potentially stale project copy, but only triggers one metadata recheck.
  if (targetContradictsProjectCopy) return !emptyCollectionMirrorRecheckRecentlyVerified(collection);
  const tableRange = collection.message_table_time_range || {};
  const matchingShards = Math.max(0, Number(collection.matching_shard_count || tableRange.shard_count || 0) || 0);
  const tableRows = Math.max(0, Number(collection.table_row_count || tableRange.row_count || 0) || 0);
  const rangeHits = Math.max(0, Number(collection.window_hit_count || tableRange.hit_count || 0) || 0);
  const hasRangeBoundaryEvidence = [
    tableRange.first_time,
    tableRange.last_time,
    tableRange.sort_first_time,
    tableRange.sort_last_time,
    tableRange.nearest_before_time,
    tableRange.nearest_after_time,
  ].some(value => !!String(value || '').trim());
  // A readable matching table with rows and concrete timestamps outside the
  // requested window is direct DB evidence, not a suspicious physical zero.
  // Re-copying the entire account cannot change that query result unless the
  // source generation itself changes, which the batch readiness guard already
  // checks periodically.
  if (matchingShards > 0 && tableRows > 0 && rangeHits === 0 && hasRangeBoundaryEvidence) return false;
  if (collection.all_message_shards_before_range === true) return false;
  return !emptyCollectionMirrorRecheckRecentlyVerified(collection);
}

export function rememberEmptyCollectionMirrorRecheck(collection = {}) {
  if (!collection || collection.no_matching_filters) return false;
  const messageCount = Math.max(0, Number(collection.message_count || 0) || 0);
  const empty = messageCount === 0 && (!Array.isArray(collection.messages) || collection.messages.length === 0);
  if (!empty) return false;
  const key = emptyCollectionMirrorRetryKey(collection);
  if (!key) return false;
  pruneEmptyCollectionMirrorRetryCache();
  EMPTY_COLLECTION_MIRROR_RETRY_CACHE.set(key, Date.now());
  while (EMPTY_COLLECTION_MIRROR_RETRY_CACHE.size > MAX_EMPTY_COLLECTION_MIRROR_RETRY_CACHE) {
    const oldest = EMPTY_COLLECTION_MIRROR_RETRY_CACHE.keys().next().value;
    if (!oldest) break;
    EMPTY_COLLECTION_MIRROR_RETRY_CACHE.delete(oldest);
  }
  return true;
}

export function emptyCollectionMirrorRecheckRecentlyVerified(collection = {}) {
  const key = emptyCollectionMirrorRetryKey(collection);
  if (!key) return false;
  pruneEmptyCollectionMirrorRetryCache();
  return EMPTY_COLLECTION_MIRROR_RETRY_CACHE.has(key);
}

function pruneEmptyCollectionMirrorRetryCache(now = Date.now()) {
  for (const [key, verifiedAt] of EMPTY_COLLECTION_MIRROR_RETRY_CACHE.entries()) {
    if (now - Number(verifiedAt || 0) > EMPTY_COLLECTION_MIRROR_RETRY_TTL_MS) {
      EMPTY_COLLECTION_MIRROR_RETRY_CACHE.delete(key);
    }
  }
}

function emptyCollectionMirrorRetryKey(collection = {}) {
  const explicit = String(collection?.empty_collection_retry_key || '').trim();
  if (explicit) return explicit;
  const sourceSnapshot = collection?.source_snapshot && typeof collection.source_snapshot === 'object'
    ? collection.source_snapshot
    : {};
  const accountId = String(sourceSnapshot.account_id || collection.account_id || '').trim();
  const groupId = String(sourceSnapshot.group_id || collection.group_id || '').trim();
  const since = String(sourceSnapshot.since || collection.since || '').trim();
  const until = String(sourceSnapshot.until || collection.until || '').trim();
  const snapshotRef = String(sourceSnapshot.snapshot_ref || collection.source_snapshot_meta_hash || '').trim();
  if (!accountId || !groupId || !since || !until || !snapshotRef) return '';
  const sinceMs = Number.isSafeInteger(Number(sourceSnapshot.since_ms ?? collection.since_ms))
    ? Number(sourceSnapshot.since_ms ?? collection.since_ms)
    : null;
  const untilMs = Number.isSafeInteger(Number(sourceSnapshot.until_ms ?? collection.until_ms))
    ? Number(sourceSnapshot.until_ms ?? collection.until_ms)
    : null;
  return crypto.createHash('sha256').update(JSON.stringify({
    account_id: accountId,
    group_id: groupId,
    since,
    until,
    since_ms: sinceMs,
    until_ms: untilMs,
    snapshot_ref: snapshotRef,
    filters: emptyCollectionRetryFilters(collection.filters || {}),
    min_messages: Math.max(0, Number(collection.min_messages || 0) || 0),
  })).digest('hex').slice(0, 32);
}

function emptyCollectionRetryFilters(filters = {}) {
  return {
    senders: normalizeFilterTerms(filters.senders || []),
    keywords: normalizeFilterTerms(filters.keywords || []),
    exclude_types: [...new Set(filters.exclude_types || filters.excludeTypes || [])].map(value => String(value || '').trim()).filter(Boolean).sort(),
  };
}

export function emptyCollectionMirrorRecheckReason(collection = {}) {
  return emptyCollectionMirrorRecheckSummary(collection).reason;
}

export function emptyCollectionMirrorRecheckSummary(collection = {}) {
  const evidence = messageCollectionTargetLastMessageEvidence(collection);
  if (evidence.in_range) {
    return {
      reason: 'target_last_message_in_range_empty',
      label: '群列表显示本次范围内有消息，正在复核本地数据',
      detail: '群列表最后消息落在本次范围内，但首次读取为空；正在核对微信源库元数据与本地工作数据，只有源数据确有变化时才更新并重读。',
    };
  }
  if (evidence.after_range) {
    return {
      reason: 'target_last_message_after_range_empty',
      label: '群列表显示范围后还有新消息，正在复核本地数据',
      detail: '群列表最后消息晚于本次范围，不能证明本次范围为空；正在核对源库元数据与本地工作数据是否仍为同一快照。',
    };
  }
  if (evidence.before_range) {
    return {
      reason: 'target_last_message_before_range_empty',
      label: '会话列表只显示范围前消息，正在复核本地数据',
      detail: '会话列表最后消息早于本次范围，但会话表可能落后于消息分片；正在核对源库元数据与本地工作数据，不会仅因空结果强制覆盖整库。',
    };
  }
  return {
    reason: 'first_empty_collection',
    label: '首次读取为空，正在复核本地数据',
    detail: '首次读取没有拿到可总结消息；正在复核源库快照是否变化，快照一致时直接接受结果，避免无意义地复制和重复解密整库。',
  };
}

function safeMessageDateTimeMs(value = '', options = {}) {
  try {
    const date = parseMessageDateTime(value, '时间', options);
    return date?.getTime?.() ?? NaN;
  } catch {
    return NaN;
  }
}

function parseMessageDateTime(value, label, { allowNow = false, endOfMinuteWhenSecondsMissing = false, endOfSecond = false } = {}) {
  const text = String(value || '').trim();
  if (allowNow && (!text || text === 'now')) return new Date();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    throw Object.assign(new Error(`${label}格式无效，请使用 YYYY-MM-DD HH:mm 或 YYYY-MM-DD HH:mm:ss。`), {
      status: 400,
      code: 'digest_range_invalid_format',
      public_code: 'digest_range_invalid_format',
    });
  }
  const [, y, mo, d, h, mi, rawSeconds] = match;
  const s = rawSeconds ?? (endOfMinuteWhenSecondsMissing ? '59' : '0');
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), endOfSecond ? 999 : 0);
  const valid = date.getFullYear() === Number(y)
    && date.getMonth() === Number(mo) - 1
    && date.getDate() === Number(d)
    && date.getHours() === Number(h)
    && date.getMinutes() === Number(mi)
    && date.getSeconds() === Number(s);
  if (!valid) {
    throw Object.assign(new Error(`${label}格式无效，请使用真实存在的日期时间。`), {
      status: 400,
      code: 'digest_range_invalid_date',
      public_code: 'digest_range_invalid_date',
    });
  }
  return date;
}

function filtersAreActive(filters = {}) {
  return normalizeFilterTerms(filters.senders || []).length > 0
    || normalizeFilterTerms(filters.keywords || []).length > 0
    || new Set(filters.exclude_types || filters.excludeTypes || []).size > 0;
}

function redactMessageSecrets(message) {
  const {
    sender_username,
    sender_display_name,
    ...publicMessage
  } = message || {};
  return {
    ...publicMessage,
    content: redactSecrets(message?.content),
  };
}

function summarizeMediaStatus(messages = []) {
  const status = {
    media_messages: 0,
    attached: 0,
    metadata_only: 0,
    omitted: 0,
  };
  for (const msg of Array.isArray(messages) ? messages : []) {
    const media = msg?.media || {};
    if (!media || typeof media !== 'object') continue;
    const isVisual = msg.type === 'image' || msg.type === 'video' || isVideoLikeMedia(media);
    const isAudio = msg.type === 'voice' || isAudioLikeMedia(media);
    if (!isVisual && !isAudio) continue;
    status.media_messages++;
    const attached = !!(media.data_url || media.frame_data_url || media.audio_data_url);
    if (attached) status.attached++;
    else status.metadata_only++;
    if (media.payload_omitted_reason || !attached) status.omitted++;
  }
  return status.media_messages ? status : null;
}

function isVideoLikeMedia(media = {}) {
  const ext = String(media.ext || '').toLowerCase();
  const name = String(media.file_name || '').toLowerCase();
  return ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm'].includes(ext) || /\.(mp4|mov|m4v|avi|mkv|webm)$/i.test(name);
}

function isAudioLikeMedia(media = {}) {
  const ext = String(media.ext || '').toLowerCase();
  const name = String(media.file_name || '').toLowerCase();
  return ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'webm', 'flac', 'amr', 'silk', 'aud'].includes(ext)
    || /\.(mp3|wav|m4a|aac|ogg|oga|webm|flac|amr|silk|aud)$/i.test(name);
}

function applyFilters(messages, filters = {}) {
  let result = messages;
  const senders = normalizeFilterTerms(filters.senders || []);
  const keywords = normalizeFilterTerms(filters.keywords || []);
  const excluded = new Set(filters.exclude_types || filters.excludeTypes || []);
  if (senders.length) result = result.filter(m => {
    return senderMatchesTerms(m, senders);
  });
  if (keywords.length) result = result.filter(m => {
    const text = messageSearchText(m);
    return keywords.some(k => text.includes(k));
  });
  if (excluded.size) result = result.filter(m => !excluded.has(m.type));
  return result;
}

function senderMatchesTerms(message = {}, terms = []) {
  const values = [
    message?.sender,
    message?.sender_username,
    message?.sender_display_name,
  ].map(normalizeSearchText).filter(Boolean);
  if (!values.length) return false;
  return terms.some(term => values.some(value => value === term || value.includes(term)));
}

function messageSearchText(message = {}) {
  const values = [];
  collectNamedFields(message, MESSAGE_SEARCH_FIELDS, values);
  collectNamedFields(message.media, MEDIA_SEARCH_FIELDS, values);
  collectNamedFields(message.media?.quote, QUOTE_SEARCH_FIELDS, values);
  collectLinkPreviewValues(message.link_previews, values);
  return normalizeSearchText(values.join(' '));
}

function collectNamedFields(obj, fields, out) {
  if (!obj || typeof obj !== 'object') return;
  for (const field of fields) {
    appendSearchValue(obj[field], out);
  }
}

function collectLinkPreviewValues(previews, out) {
  if (!Array.isArray(previews)) return;
  for (const preview of previews) collectLinkPreviewValue(preview, out);
}

function collectLinkPreviewValue(preview, out) {
  if (!preview || typeof preview !== 'object') return;
  collectNamedFields(preview, LINK_PREVIEW_SEARCH_FIELDS, out);
  for (const value of Object.values(preview)) {
    if (Array.isArray(value)) {
      for (const item of value) collectLinkPreviewValue(item, out);
    } else if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
      collectLinkPreviewValue(value, out);
    }
  }
}

function appendSearchValue(value, out) {
  if (value === null || value === undefined || Buffer.isBuffer(value)) return;
  if (typeof value === 'string') {
    if (/^data:(?:image|audio|video)\//i.test(value)) return;
    out.push(value);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') out.push(String(value));
}

function normalizeFilterTerms(values) {
  return [...new Set((values || []).map(normalizeSearchText).filter(Boolean))];
}

function normalizeSearchText(value) {
  return String(value || '').normalize('NFKC').toLowerCase().trim();
}

function automaticKeyScanIncomplete(diagnostics = {}, platform = process.platform) {
  const d = diagnostics || {};
  const validationBudgetIncomplete = Number(d.validation_budget_exhausted_count || 0) > 0
    || Number(d.validation_omitted_candidate_count || 0) > 0;
  if (d.candidate_sources_incomplete === true || validationBudgetIncomplete) return true;
  if (String(platform || '') !== 'win32') return false;
  const standardUnavailable = d.standard_scan_unavailable === true || d.standard_scan_process_enumeration_failed === true;
  const standardIncomplete = d.standard_scan_incomplete === true || d.standard_scan_timed_out === true;
  const memoryCompleted = d.memory_scan_attempted === true
    && d.memory_scan_unavailable !== true
    && d.read_only_handle_ok === true
    && Number(d.memory_scan_scanned_bytes || 0) > 0;
  return standardIncomplete || d.memory_scan_unavailable === true || d.memory_scan_incomplete === true || (standardUnavailable && !memoryCompleted);
}

function keyScanUnavailableDetail(diagnostics = {}) {
  const d = diagnostics || {};
  const standardTimeoutDetail = d.standard_scan_timed_out === true || d.standard_scan_incomplete === true
    ? `本地工作数据标准扫描达到 ${Math.max(1, Math.ceil(Number(d.standard_scan_timeout_ms || 0) / 1000) || 45)} 秒时间上限`
    : '';
  return String(
    d.memory_scan_unavailable_error
    || standardTimeoutDetail
    || d.standard_scan_unavailable_error
    || d.standard_scan_process_enumeration_error
    || d.settings_load_error
    || d.persistent_verified_key_cache_error
    || d.local_scan_error
    || d.local_scan_warning
    || '',
  ).trim();
}

function enrichDbKeyFailure(error, diagnostics, dbName, { allow_stale_account = false } = {}) {
  if (!isDbKeyFailure(error)) return error;
  const d = diagnostics || {};
  if (!allow_stale_account && d.account_stale_days >= STALE_ACCOUNT_WARN_DAYS && d.newer_account_available) {
    return staleAccountKeyFailure(d, dbName, error);
  }
  const total = Number(d.total_candidate_count || 0);
  const memory = Number(d.memory_candidate_count || 0);
  const local = Number(d.local_candidate_count || 0);
  const manual = Number(d.manual_key_count || 0);
  const processes = Number(d.scan_process_count || 0);
  const standard = Number(d.standard_scan_candidate_count || 0);
  const validationOmitted = Number(d.validation_omitted_candidate_count || 0) || 0;
  const validationBudgetExhausted = Number(d.validation_budget_exhausted_count || 0) || 0;
  const readonly = d.read_only_handle_ok === true ? '只读句柄正常' : '只读句柄未确认';
  const staleLiveMemoryScanSkipped = d.stale_account_live_memory_scan_skipped === true;
  if (staleLiveMemoryScanSkipped) {
    const sourceUnavailable = d.source_account_unavailable === true;
    const message = [
      sourceUnavailable
        ? `已确认只读取项目内工作副本，但已保存/本地候选没有打开 ${dbName || '数据库'}`
        : `已确认读取旧微信账号目录，但已保存/本地候选没有打开 ${dbName || '数据库'}`,
      !sourceUnavailable && Number(d.account_stale_days || 0) > 0 ? `这个目录约 ${Number(d.account_stale_days || 0) || 0} 天未同步` : '',
      sourceUnavailable
        ? '微信源目录当前不可用，已跳过当前运行微信进程标准扫描和内存扫描，避免把另一个账号的密钥用于项目副本'
        : '已跳过当前运行微信进程标准扫描和内存扫描，因为这些密钥通常属于最近同步账号，不能用来打开旧目录',
      `候选 ${total} 个（本地 ${local}、手动 ${manual}）`,
      sourceUnavailable ? '请填写这个账号对应的手动数据库密钥，或恢复微信源目录后重试' : '请填写这个旧账号对应的手动数据库密钥，或切换到最近同步账号后重试',
      '这不代表消息数据库已损坏',
    ].filter(Boolean).join('；');
    return Object.assign(new Error(message), {
      status: error?.status || 502,
      code: 'wxdb_key_verification_failed',
      public_code: 'wxdb_key_verification_failed',
      key_diagnostics: d,
    });
  }
  const detail = [
    d.account_stale_days >= 30
      ? `当前选中的微信账号目录约 ${d.account_stale_days} 天未同步，可能不是正在登录的账号`
      : '',
    process.platform === 'darwin'
      ? 'Mac 微信内存自动密钥扫描尚未适配，已尝试读取本地密钥缓存'
      : (staleLiveMemoryScanSkipped
        ? '已确认读取旧账号目录，已跳过当前运行微信进程标准扫描和内存扫描；这些密钥通常属于最近同步账号，不能拿来打开旧目录'
        : (d.memory_scan_unavailable
          ? `自动密钥扫描没有完整执行（${keyScanUnavailableDetail(d) || '没有成功读取微信进程内存'}）`
          : (d.memory_scan_attempted
          ? `自动密钥扫描已执行（${readonly}，扫描 ${processes || 0} 个微信进程）`
          : '本次未执行微信进程内存扫描，已验证缓存、手动候选、本地密钥文件和本地工作数据'))),
    process.platform === 'win32'
      ? (staleLiveMemoryScanSkipped
        ? 'Windows 已停止使用当前运行微信进程密钥验证旧账号目录；请提供这个旧账号自己的密钥候选'
        : 'Windows 会继续尝试已验证缓存、本地候选、只读进程扫描和本地工作数据验证；这些自动验证都失败时才需要有效手动密钥或本地导出的密钥候选兜底')
      : '',
    process.platform === 'win32' && processes > 1
      ? '当前检测到多个微信进程或多账号场景，自动候选可能属于另一个账号；请先确认页面右上角账号正确'
      : '',
    `共得到 ${total} 个候选：内存 ${memory}、本地配置 ${local}、手动 ${manual}`,
    d.standard_scan_unavailable ? `本地工作数据标准扫描不可用：${d.standard_scan_unavailable_error || d.standard_scan_process_enumeration_error || '没有成功读取微信进程内存'}` : '',
    d.standard_scan_timed_out || d.standard_scan_incomplete ? `本地工作数据标准扫描未完成：${keyScanUnavailableDetail(d)}` : '',
    d.standard_scan_attempted ? `本地工作数据验证已执行：已检查 ${standard} 条候选` : '',
    validationBudgetExhausted && validationOmitted
      ? `额外兼容模式验证为控制组合数量，省略了 ${validationOmitted} 个低优先级候选组合；这不等于数据库损坏，仍需继续自动扫描或提供该账号手动密钥`
      : '',
    `但这些候选都没有匹配 ${dbName}`,
    keyVerificationFailureCause(error),
    ...(process.platform === 'darwin'
      ? ['如已用外部工具导出密钥，可放到 ~/.wx-cli/all_keys.json、data/all_keys.json 或 data/wechat-keys.json，或在设置页填写 64/96/128/160/192 位 hex 手动密钥，也可粘贴 all_keys.json、导出 blob、x\'...\' 或 0x... 片段']
      : []),
    d.account_stale_days >= 30
      ? (allow_stale_account
        ? '你已确认继续读取这个旧账号目录；如果仍打不开，请填写这个旧账号对应的手动数据库密钥'
        : '请优先切换到页面右上角最近同步的微信账号后重试')
      : '',
  ].filter(Boolean).join('；');
  if (automaticKeyScanIncomplete(d)) {
    const unavailableDetail = keyScanUnavailableDetail(d);
    const unavailableClause = unavailableDetail.replace(/[。；;]+$/u, '');
    const candidateSourcesIncomplete = d.candidate_sources_incomplete === true;
    const validationBudgetIncomplete = validationBudgetExhausted > 0 || validationOmitted > 0;
    const message = [
      candidateSourcesIncomplete
        ? `${dbName || '数据库'} 的密钥候选来源没有完整读取，不能把本次结果当成“0 个候选”或“密钥一定错误”`
        : (validationBudgetIncomplete
          ? `${dbName || '数据库'} 的密钥候选验证达到时间或组合上限，仍有候选组合没有完成验证，不能把本次结果当成“密钥一定错误”`
          : (d.standard_scan_timed_out || d.standard_scan_incomplete
          ? `${dbName || '数据库'} 的本地工作数据标准扫描没有完整执行，不能把本次结果当成“0 个候选”或“密钥一定错误”`
          : `${dbName || '数据库'} 自动密钥扫描没有完整执行：本次没有成功读取可用微信进程内存，不能把结果当成“0 个候选”或“密钥一定错误”`)),
      unavailableClause ? `扫描错误：${unavailableClause}` : '',
      validationBudgetIncomplete
        ? [
            total ? `已取得 ${total} 个候选` : '',
            validationOmitted ? `省略了 ${validationOmitted} 个低优先级兼容组合` : '验证预算已用完',
          ].filter(Boolean).join('，')
        : (total ? `已检查当前可读的缓存/本地/手动候选 ${total} 个，但候选来源仍不完整` : '候选来源证据不完整'),
      candidateSourcesIncomplete
        ? '请先重试读取设置、加密密钥缓存或本地密钥文件；程序不会缓存这次不完整的未命中结果'
        : (validationBudgetIncomplete
          ? '请重试扫描；仍失败时，在设置页为当前账号保存有效手动密钥候选以提高验证优先级。程序不会缓存这次不完整的未命中结果'
          : '请确认微信正在运行，稍后重试扫描；如果安全软件拦截进程读取，请放行后再试'),
    ].filter(Boolean).join('；');
    return Object.assign(new Error(message), {
      status: error?.status || 502,
      code: 'wxdb_key_scan_unavailable',
      public_code: 'wxdb_key_scan_unavailable',
      key_diagnostics: d,
    });
  }
  const finalAction = staleLiveMemoryScanSkipped
    ? '请填写或粘贴这个旧账号对应的有效手动密钥候选；如果你不是故意读旧目录，请切换到最近同步账号'
    : '请先确认右上角微信账号，再点“扫描并验证密钥”重试，仍失败再填写或粘贴该账号的有效手动密钥候选';
  const finalMessage = staleLiveMemoryScanSkipped
    ? `${detail}。自动验证未找到旧账号目录可用密钥；${finalAction}。这不代表消息数据库已损坏。`
    : `${detail}。自动验证未找到当前账号可用密钥；${finalAction}。这不代表消息数据库已损坏。`;
  const enriched = Object.assign(new Error(finalMessage), {
    status: error?.status || 502,
    code: 'wxdb_key_verification_failed',
    public_code: 'wxdb_key_verification_failed',
    key_diagnostics: d,
  });
  return enriched;
}

function staleAccountKeyFailure(diagnostics = {}, dbName = '', cause = null) {
  const days = Number(diagnostics.account_stale_days || 0) || 0;
  const suggested = diagnostics.suggested_account_label || diagnostics.suggested_account_id || '最近同步的账号';
  const selected = diagnostics.selected_account_label || '当前选中的账号';
  const message = [
    `当前选中的是旧微信账号目录「${selected}」，约 ${days} 天未同步`,
    `它不是当前正在同步的微信数据目录，通常不能用正在运行微信进程里的数据库密钥打开 ${dbName || '数据库'}`,
    `请切换页面右上角到最近同步的账号「${suggested}」后重试`,
    cause ? keyVerificationFailureCause(cause) : '',
  ].filter(Boolean).join('；');
  return Object.assign(new Error(message), {
    status: 409,
    code: 'wechat_account_stale_selected',
    public_code: 'wechat_account_stale_selected',
    key_diagnostics: diagnostics,
  });
}

function staleAccountSelectedError(env = {}, account = {}, dbName = '') {
  const lastWriteTime = accountStaleLastWriteTime(account);
  const selectedTime = safeAccountTimeMs(lastWriteTime);
  const days = accountStaleDays(lastWriteTime);
  const suggested = suggestedFreshAccount(env?.accounts || [], account);
  if (!(suggested && days >= STALE_ACCOUNT_WARN_DAYS && Number.isFinite(selectedTime))) return null;
  return staleAccountKeyFailure({
    account_stale_days: days,
    selected_account_label: accountLabel(account),
    account_last_write_time: lastWriteTime,
    newer_account_available: true,
    suggested_account_id: suggested.account_id || suggested.id || suggested.wxid || '',
    suggested_account_label: accountLabel(suggested),
    suggested_account_last_write_time: accountStaleLastWriteTime(suggested),
  }, dbName);
}

function rejectStaleSelectedAccount(env = {}, account = {}, dbName = '') {
  const staleError = staleAccountSelectedError(env, account, dbName);
  if (staleError) throw staleError;
}

function keyVerificationFailureCause(error = {}) {
  const message = String(error?.message || '');
  if (/database file changed while decrypting|正在写入|changed/i.test(message)) {
    return '微信数据库仍在写入或同步中，临时读取数据没有稳定通过验证';
  }
  if (/unable to open database file/i.test(message)) {
    return '数据库临时读取数据无法打开，可能是微信正在写入或本机文件权限暂时不可用';
  }
  if (/file is not a database|database disk image is malformed/i.test(message)) {
    return '数据库临时读取数据结构未通过校验，可能是源库正在同步或本地工作数据需要重新自动刷新';
  }
  if (/validation_budget_exhausted/i.test(message)) {
    return '兼容模式验证达到候选预算上限，当前候选没有通过数据库校验';
  }
  if (/no raw key matched|no candidate key opened|SQLCipher|hmac mismatch|page hmac/i.test(message)) {
    return '候选密钥没有通过数据库校验';
  }
  return '数据库密钥验证未通过';
}

function dbFailureCode(error = {}) {
  return String(error?.public_code || error?.code || '').trim();
}

function isDbInfrastructureFailure(error) {
  const code = dbFailureCode(error);
  if (isWxdbShardOpenFailure(error)) return shardOpenFailureCause(error) !== 'key';
  return /^(?:SQLITE_CORRUPT|SQLITE_FORMAT)$/i.test(code)
    || /database disk image is malformed|malformed database schema|database corruption|sqlite_corrupt/i.test(String(error?.message || ''))
    || code === 'wechat_account_stale_selected'
    || code === 'account_selection_ambiguous'
    || code === 'db_copy_required'
    || code === 'wxdb_account_not_found'
    || code.startsWith('wxdb_mirror_')
    || code.startsWith('wxdb_source_')
    || code.startsWith('wxdb_temp_copy_');
}

function isDbKeyFailure(error) {
  if (isDbInfrastructureFailure(error)) return false;
  if (isWxdbShardOpenFailure(error)) return shardOpenFailureCause(error) === 'key' || !!shardOpenKeyDiagnostics(error);
  return /no raw key matched|no candidate key opened|validation_budget_exhausted|Weixin v4 page hmac mismatch|page hmac|hmac mismatch|SQLCipher key validation failure|SQLITE_NOTADB|SQLITE_AUTH/i.test(`${dbFailureCode(error)} ${String(error?.message || '')}`);
}

function isDbKeyRecoveryProbeFailure(error) {
  if (isDbInfrastructureFailure(error)) return false;
  return isDbKeyFailure(error);
}

function isWxdbShardOpenFailure(error) {
  const code = String(error?.public_code || error?.code || '').trim();
  return code === 'wxdb_all_shards_unreadable' || code === 'wxdb_partial_shards_unreadable';
}

function shardOpenFailureCause(error = {}) {
  if (!isWxdbShardOpenFailure(error)) return '';
  const wxdb = error?.wxdb_diagnostics && typeof error.wxdb_diagnostics === 'object' ? error.wxdb_diagnostics : {};
  const explicit = String(wxdb.shard_open_failure_cause || '').trim();
  if (explicit) return explicit;
  const counts = wxdb.error_category_counts && typeof wxdb.error_category_counts === 'object'
    ? wxdb.error_category_counts
    : {};
  const categories = ['mirror', 'key', 'other'].filter(category => Number(counts[category] || 0) > 0);
  if (categories.length > 1) return 'mixed';
  if (categories.length === 1) return categories[0] === 'other' ? 'wxdb' : categories[0];
  const samples = Array.isArray(wxdb.sample_errors) ? wxdb.sample_errors : [];
  const text = [
    error?.message || '',
    ...samples.map(item => item?.error || ''),
  ].join(' ');
  if (/wxdb_temp_copy_|wxdb_mirror_|wxdb_source_|db_copy_required|路径越界|源数据库|临时副本复制失败|unable to open database file|permission denied|access is denied|SQLITE_CORRUPT|SQLITE_FORMAT|database disk image is malformed|malformed database schema/i.test(text)) return 'mirror';
  if (/no raw key matched|no candidate key opened|validation_budget_exhausted|Weixin v4 page hmac mismatch|page hmac|hmac mismatch|SQLCipher key validation failure|SQLITE_NOTADB|SQLITE_AUTH/i.test(text)) return 'key';
  return '';
}

function shardOpenKeyDiagnostics(error = {}) {
  if (!isWxdbShardOpenFailure(error)) return null;
  const cause = shardOpenFailureCause(error);
  if (cause && cause !== 'key') return null;
  const wxdb = error?.wxdb_diagnostics && typeof error.wxdb_diagnostics === 'object' ? error.wxdb_diagnostics : {};
  const summary = wxdb.key_scan_summary && typeof wxdb.key_scan_summary === 'object' ? wxdb.key_scan_summary : null;
  if (!summary) return null;
  const samples = Array.isArray(wxdb.sample_errors) ? wxdb.sample_errors : [];
  const sampleText = [
    error?.message || '',
    ...samples.map(item => item?.error || ''),
  ].join(' ');
  if (!/no raw key matched|no candidate key opened|validation_budget_exhausted|Weixin v4 page hmac mismatch|page hmac|hmac mismatch|SQLCipher key validation failure|SQLITE_NOTADB|SQLITE_AUTH/i.test(sampleText)) {
    return null;
  }
  if (/wxdb_temp_copy_|wxdb_mirror_|wxdb_source_|db_copy_required|路径越界|源数据库|临时副本复制失败|unable to open database file|permission denied|access is denied/i.test(sampleText)) {
    return null;
  }
  const count = value => {
    const n = Number(value || 0);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  };
  const scanProcessTotal = count(summary.scan_process_count_total) + count(summary.codec_context_scan_process_count_total);
  const scannedBytesTotal = count(summary.scanned_bytes_total) + count(summary.codec_context_scanned_bytes_total);
  const scanUnavailable = count(summary.scan_unavailable_shard_count) > 0;
  const out = {
    shard_open_failure: true,
    shard_open_code: String(error?.public_code || error?.code || '').trim(),
    shard_count: count(summary.shard_count),
    failed_shard_count: count(wxdb.failed_shard_count),
    readable_shard_count: count(wxdb.readable_shard_count),
    total_candidate_count: count(summary.initial_candidate_count_max),
    scan_process_count: scanProcessTotal,
    memory_scan_attempted: count(summary.targeted_scan_shard_count) > 0 || count(summary.codec_context_scan_shard_count) > 0,
    memory_scan_unavailable: scanUnavailable,
    memory_scan_unavailable_reason: scanUnavailable ? String(summary.scan_unavailable_reason || '').trim() : '',
    memory_scan_unavailable_error: scanUnavailable ? String(summary.scan_unavailable_error || '').trim() : '',
    memory_scan_scanned_bytes: scannedBytesTotal,
    read_only_handle_ok: scanProcessTotal > 0 && scannedBytesTotal > 0,
    memory_candidate_count: count(summary.targeted_raw_key_hit_shard_count),
    matched_salt_count: count(summary.matched_salt_count_total),
    passphrase_derive_attempts: count(summary.passphrase_derive_attempts_total),
    passphrase_derived_match_count: count(summary.passphrase_derived_match_count_total),
    standard_scan_codec_context_attempted: count(summary.codec_context_scan_shard_count) > 0,
    standard_scan_codec_context_candidate_count: count(summary.codec_context_unique_candidate_count_total),
    standard_scan_codec_context_page_key_match_count: count(summary.codec_context_page_key_match_count_total),
    shard_key_scan_summary: summary,
  };
  return Object.fromEntries(Object.entries(out).filter(([, value]) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return !!String(value || '').trim();
  }));
}

function attachShardOpenKeyDiagnostics(error = {}, bundleDiagnostics = null) {
  const shardDiagnostics = shardOpenKeyDiagnostics(error);
  if (!shardDiagnostics) return false;
  if (!error.key_diagnostics) {
    error.key_diagnostics = {
      ...(bundleDiagnostics && typeof bundleDiagnostics === 'object' ? bundleDiagnostics : {}),
      ...shardDiagnostics,
    };
  }
  return true;
}

function keyProgressLabel(progressContext = 'digest', text = '') {
  const prefix = progressContext === 'groups' ? '读取群列表' : '拉取消息';
  return `${prefix} · ${text || '数据库密钥'}`;
}

function shouldSkipLiveMemoryScanForConfirmedStaleAccount(diagnostics = {}, allowStaleAccount = false) {
  const d = diagnostics || {};
  return allowStaleAccount === true
    && (d.source_account_unavailable === true
      || (Number(d.account_stale_days || 0) >= STALE_ACCOUNT_WARN_DAYS && d.newer_account_available === true));
}

function markStaleAccountLiveMemoryScanSkipped(diagnostics = {}) {
  const d = diagnostics || {};
  return {
    ...d,
    stale_account_live_memory_scan_skipped: true,
    memory_scan_attempted: false,
    memory_candidate_count: 0,
    scan_process_count: 0,
    total_candidate_count: Number(d.total_candidate_count || 0) || 0,
  };
}

async function runWithDbKeys({
  dbName,
  action,
  onProgress = null,
  signal = null,
  account_id = '',
  allow_stale_account = false,
  progress_context = 'digest',
  standard_probe_scope = 'message',
  standard_mirror_readiness = null,
  standard_mirror_reason = 'wxdb_refresh',
  account_fingerprint = '',
  source_account_unavailable = false,
  legacy_manual_key_policy = LEGACY_MANUAL_KEY_POLICY.DENY,
} = {}) {
  throwIfAborted(signal);
  const legacyManualKeyPolicy = normalizeLegacyManualKeyPolicy(legacy_manual_key_policy);
  const keyRuntimeStateVersionAtStart = DB_KEY_RUNTIME_STATE_VERSION;
  notifyProgress(onProgress, {
    phase: 'fetch_key_quick',
    label: keyProgressLabel(progress_context, '校验数据库密钥'),
    detail: `${dbName || '数据库'}：先试缓存和手动密钥`,
  });
  const quick = await dbRawKeyCandidateBundle({
    memoryScan: false,
    onProgress,
    signal,
    account_id,
    legacy_manual_key_policy: legacyManualKeyPolicy,
  });
  if (source_account_unavailable) {
    quick.diagnostics = { ...(quick.diagnostics || {}), source_account_unavailable: true };
  }
  throwIfAborted(signal);
  notifyProgress(onProgress, {
    phase: 'fetch_key_verify',
    label: keyProgressLabel(progress_context, '验证数据库密钥'),
    detail: keyCandidateProgressDetail(quick.diagnostics, dbName),
  });
  try {
    throwIfAborted(signal);
    const result = await action(quick);
    const binding = await legacyManualKeyBindingAfterVerifiedUse(quick, result, { account_id, signal, onProgress, progress_context });
    attachLegacyManualKeyBinding(result, binding);
    return result;
  } catch (e) {
    throwIfAborted(signal);
    if (!isDbKeyFailure(e) || quick.diagnostics?.memory_scan_attempted) {
      throw enrichDbKeyFailure(e, quick.diagnostics, dbName, { allow_stale_account });
    }
    let lastKeyFailure = e;
    if (shouldSkipLiveMemoryScanForConfirmedStaleAccount(quick.diagnostics, allow_stale_account)) {
      notifyProgress(onProgress, {
        phase: 'fetch_key_stale_memory_skipped',
        label: keyProgressLabel(progress_context, '旧账号密钥未命中'),
        detail: `${dbName || '数据库'}：已确认读取旧账号目录，已跳过当前运行微信进程标准扫描和内存扫描；请使用这个旧账号对应的手动数据库密钥`,
      });
      throw enrichDbKeyFailure(lastKeyFailure, markStaleAccountLiveMemoryScanSkipped(quick.diagnostics), dbName, { allow_stale_account });
    }
    const standard = await verifyKeysWithStandardDbScan({
      account_id,
      dbName,
      keyBundle: quick,
      onProgress,
      signal,
      progress_context,
      probe_scope: standard_probe_scope,
      mirror_readiness: standard_mirror_readiness,
      mirror_reason: standard_mirror_reason,
      allow_stale_account,
    });
    if (standard?.rawKeys?.length) {
      notifyProgress(onProgress, {
        phase: 'fetch_key_verify_standard',
        label: keyProgressLabel(progress_context, '验证标准扫描候选'),
        detail: keyCandidateProgressDetail(standard.diagnostics, dbName),
      });
      try {
        throwIfAborted(signal);
        const result = await action(standard);
        const binding = await legacyManualKeyBindingAfterVerifiedUse(standard, result, { account_id, signal, onProgress, progress_context });
        attachLegacyManualKeyBinding(result, binding);
        return result;
      } catch (standardError) {
        throwIfAborted(signal);
        if (standardError?.public_code === 'wxdb_partial_shards_unreadable' || standardError?.public_code === 'wxdb_all_shards_unreadable') {
          attachShardOpenKeyDiagnostics(standardError, standard.diagnostics);
          if (!isDbKeyFailure(standardError)) throw standardError;
        }
        if (!isDbKeyFailure(standardError)) throw standardError;
        lastKeyFailure = standardError;
      }
    }
    const staleDiagnostics = standard?.diagnostics || quick.diagnostics;
    if (shouldSkipLiveMemoryScanForConfirmedStaleAccount(staleDiagnostics, allow_stale_account)) {
      notifyProgress(onProgress, {
        phase: 'fetch_key_stale_memory_skipped',
        label: keyProgressLabel(progress_context, '旧账号密钥未命中'),
        detail: `${dbName || '数据库'}：已确认读取旧账号目录，已跳过当前运行微信进程标准扫描和内存扫描；请使用这个旧账号对应的手动数据库密钥`,
      });
      throw enrichDbKeyFailure(lastKeyFailure, markStaleAccountLiveMemoryScanSkipped(staleDiagnostics), dbName, { allow_stale_account });
    }
    const memoryScanFallbackDiagnostics = standard?.diagnostics || quick.diagnostics || {};
    const memoryScanFallbackReason = keyMemoryScanFallbackReason(memoryScanFallbackDiagnostics);
    const memoryScanFallbackDetail = memoryScanProgressDetail({
      fallbackReason: memoryScanFallbackReason,
      verifiedCandidateCount: Number(memoryScanFallbackDiagnostics.verified_key_count || 0) || 0,
      manualCandidateCount: Number(memoryScanFallbackDiagnostics.manual_key_count || 0) || 0,
      localCandidateCount: Number(memoryScanFallbackDiagnostics.local_candidate_count || 0) || 0,
    });
    notifyProgress(onProgress, {
      phase: 'fetch_key_scan',
      label: keyProgressLabel(progress_context, '扫描数据库密钥'),
      detail: `${dbName || '数据库'}：${memoryScanFallbackDetail}`,
    });
    const full = await dbRawKeyCandidateBundle({
      memoryScan: true,
      memoryScanFallbackReason,
      onProgress,
      signal,
      account_id,
      legacy_manual_key_policy: legacyManualKeyPolicy,
    });
    const fullWithStandardDiagnostics = standard?.diagnostics
      ? dbKeyBundle(full.rawKeys, { ...standard.diagnostics, ...full.diagnostics }, dbKeyBundleMetadata(full))
      : full;
    throwIfAborted(signal);
    notifyProgress(onProgress, {
      phase: 'fetch_key_verify_full',
      label: keyProgressLabel(progress_context, '验证扫描候选'),
      detail: keyCandidateProgressDetail(fullWithStandardDiagnostics.diagnostics, dbName),
    });
    try {
      throwIfAborted(signal);
      const result = await action(fullWithStandardDiagnostics);
      const binding = await legacyManualKeyBindingAfterVerifiedUse(fullWithStandardDiagnostics, result, { account_id, signal, onProgress, progress_context });
      attachLegacyManualKeyBinding(result, binding);
      return result;
    } catch (fallbackError) {
      throwIfAborted(signal);
      if (fallbackError?.public_code === 'wxdb_partial_shards_unreadable' || fallbackError?.public_code === 'wxdb_all_shards_unreadable') {
        attachShardOpenKeyDiagnostics(fallbackError, fullWithStandardDiagnostics.diagnostics);
        if (isDbKeyFailure(fallbackError) && automaticKeyScanIncomplete(fallbackError.key_diagnostics || fullWithStandardDiagnostics.diagnostics)) {
          throw enrichDbKeyFailure(fallbackError, fallbackError.key_diagnostics || fullWithStandardDiagnostics.diagnostics, dbName, { allow_stale_account });
        }
        if (isDbKeyFailure(fallbackError) && progress_context !== 'groups') {
          await rememberFailedAutoRawKeyScan(account_id, fallbackError.key_diagnostics || fullWithStandardDiagnostics.diagnostics, signal, { expected_state_version: keyRuntimeStateVersionAtStart });
        }
        throw fallbackError;
      }
      if (!isDbKeyFailure(fallbackError)) throw fallbackError;
      if (progress_context !== 'groups') {
        await rememberFailedAutoRawKeyScan(account_id, fullWithStandardDiagnostics.diagnostics, signal, { expected_state_version: keyRuntimeStateVersionAtStart });
      }
      throw enrichDbKeyFailure(fallbackError, fullWithStandardDiagnostics.diagnostics, dbName, { allow_stale_account });
    }
  }
}

async function verifyKeysWithStandardDbScan({
  account_id = '',
  dbName = '',
  keyBundle = null,
  onProgress = null,
  signal = null,
  progress_context = 'digest',
  probe_scope = 'message',
  mirror_readiness = null,
  mirror_reason = 'wxdb_refresh',
  allow_stale_account = false,
} = {}) {
  throwIfAborted(signal);
  const groupsOnly = probe_scope === 'groups';
  notifyProgress(onProgress, {
    phase: 'fetch_key_standard_scan',
    label: keyProgressLabel(progress_context, '标准扫描验证密钥'),
    detail: groupsOnly
      ? `${dbName || '数据库'}：只用群列表所需的本地工作数据样本做标准扫描和验证`
      : `${dbName || '数据库'}：用本地工作数据样本做标准扫描和验证`,
  });
  const dbStatus = await probeWxDbIsolated({
    account_id,
    raw_keys: Array.isArray(keyBundle?.rawKeys) ? keyBundle.rawKeys : [],
    standard_scan: true,
    standard_scan_all_processes: true,
    standard_scan_include_mapped: true,
    standard_scan_include_bare_hex: !groupsOnly,
    standard_scan_derive_passphrase: false,
    stop_after_message_sample: !groupsOnly,
    probe_scope,
    mirror_readiness,
    mirror_reason,
    allow_stale_account,
    signal,
    onProgress,
  }).catch(e => {
    if (e?.status === 499 || signal?.aborted) throw e;
    if (!isDbKeyRecoveryProbeFailure(e)) throw e;
    return { ok: false, error: e?.message || String(e) };
  });
  throwIfAborted(signal);
  const verified = Array.isArray(dbStatus?.__verified_raw_keys)
    ? uniqueStrings(dbStatus.__verified_raw_keys)
    : [];
  const rawKeys = uniqueStrings([
    ...verified,
    ...(Array.isArray(keyBundle?.rawKeys) ? keyBundle.rawKeys : []),
  ]);
  const dbChecks = Array.isArray(dbStatus?.db_checks) ? dbStatus.db_checks : [];
  const standardScanTotals = dbChecks.reduce((out, check) => {
    const scan = check?.standard_scan || {};
    out.candidate_count += Number(scan.unique_candidate_count || 0) || 0;
    out.pointer_candidate_count += Number(scan.v4_pointer_pattern_candidate_count || 0) || 0;
    out.pointer_verified_candidate_count += Number(scan.v4_pointer_verified_candidate_count || 0) || 0;
    out.pointer_passphrase_derive_attempts += Number(scan.pointer_passphrase_derive_attempts || 0) || 0;
    out.pointer_passphrase_derived_match_count += Number(scan.pointer_passphrase_derived_match_count || 0) || 0;
    out.passphrase_derive_attempts += Number(scan.passphrase_derive_attempts || 0) || 0;
    out.passphrase_derived_match_count += Number(scan.passphrase_derived_match_count || 0) || 0;
    out.codec_context_attempted = out.codec_context_attempted || scan.codec_context_attempted === true;
    out.codec_context_scan_process_count += Number(scan.codec_context_scan_process_count || 0) || 0;
    out.codec_context_unique_candidate_count += Number(scan.codec_context_unique_candidate_count || 0) || 0;
    out.codec_context_page_key_match_count += Number(scan.codec_context_page_key_match_count || 0) || 0;
    if (String(scan.source_category || '').trim() === 'message') {
      out.message_shard_requested_count = Math.max(out.message_shard_requested_count, Number(scan.requested_salt_count || 0) || 0);
      out.message_shard_matched_count = Math.max(out.message_shard_matched_count, Number(scan.matched_salt_count || 0) || 0);
    }
    out.process_enumeration_failed = out.process_enumeration_failed || scan.process_enumeration_failed === true;
    out.scan_unavailable = out.scan_unavailable || scan.scan_unavailable === true;
    out.timed_out = out.timed_out || scan.timed_out === true || scan.scan_incomplete === true;
    out.timeout_ms = Math.max(out.timeout_ms, Number(scan.scan_timeout_ms || 0) || 0);
    if (!out.process_enumeration_error && scan.process_enumeration_error) out.process_enumeration_error = String(scan.process_enumeration_error || '').slice(0, 180);
    if (!out.scan_unavailable_reason && scan.scan_unavailable_reason) out.scan_unavailable_reason = String(scan.scan_unavailable_reason || '').slice(0, 80);
    if (!out.scan_unavailable_error && scan.scan_unavailable_error) out.scan_unavailable_error = String(scan.scan_unavailable_error || '').slice(0, 180);
    return out;
  }, {
    candidate_count: 0,
    pointer_candidate_count: 0,
    pointer_verified_candidate_count: 0,
    pointer_passphrase_derive_attempts: 0,
    pointer_passphrase_derived_match_count: 0,
    passphrase_derive_attempts: 0,
    passphrase_derived_match_count: 0,
    codec_context_attempted: false,
    codec_context_scan_process_count: 0,
    codec_context_unique_candidate_count: 0,
    codec_context_page_key_match_count: 0,
    message_shard_requested_count: 0,
    message_shard_matched_count: 0,
    process_enumeration_failed: false,
    process_enumeration_error: '',
    scan_unavailable: false,
    scan_unavailable_reason: '',
    scan_unavailable_error: '',
    timed_out: false,
    timeout_ms: 0,
  });
  const diagnostics = {
    ...(keyBundle?.diagnostics || {}),
    standard_scan_attempted: true,
    standard_scan_probe_scope: groupsOnly ? 'groups' : 'message',
    standard_scan_mirror_ready: !!mirror_readiness,
    standard_scan_mirror_scope: mirror_readiness?.scope || '',
    standard_scan_db_verified: dbStatus?.decrypted === true,
    standard_scan_message_sample_verified: dbStatus?.message_sample_verified === true || dbStatus?.message_decrypted === true,
    standard_scan_message_db_verified: dbStatus?.message_db_verified === true,
    standard_scan_verified_key_count: verified.length,
    standard_scan_candidate_count: standardScanTotals.candidate_count,
    standard_scan_pointer_candidate_count: standardScanTotals.pointer_candidate_count,
    standard_scan_pointer_verified_candidate_count: standardScanTotals.pointer_verified_candidate_count,
    standard_scan_pointer_passphrase_derive_attempts: standardScanTotals.pointer_passphrase_derive_attempts,
    standard_scan_pointer_passphrase_derived_match_count: standardScanTotals.pointer_passphrase_derived_match_count,
    standard_scan_passphrase_derive_attempts: standardScanTotals.passphrase_derive_attempts,
    standard_scan_passphrase_derived_match_count: standardScanTotals.passphrase_derived_match_count,
    standard_scan_codec_context_attempted: standardScanTotals.codec_context_attempted,
    standard_scan_codec_context_scan_process_count: standardScanTotals.codec_context_scan_process_count,
    standard_scan_codec_context_candidate_count: standardScanTotals.codec_context_unique_candidate_count,
    standard_scan_codec_context_page_key_match_count: standardScanTotals.codec_context_page_key_match_count,
    standard_scan_message_shard_requested_count: standardScanTotals.message_shard_requested_count,
    standard_scan_message_shard_matched_count: standardScanTotals.message_shard_matched_count,
    validation_budget_exhausted_count: Number(dbStatus?.validation_budget_exhausted_count || 0) || 0,
    validation_omitted_candidate_count: Number(dbStatus?.validation_omitted_candidate_count || 0) || 0,
    standard_scan_process_enumeration_failed: standardScanTotals.process_enumeration_failed,
    standard_scan_process_enumeration_error: standardScanTotals.process_enumeration_error,
    standard_scan_unavailable: standardScanTotals.scan_unavailable,
    standard_scan_unavailable_reason: standardScanTotals.scan_unavailable_reason,
    standard_scan_unavailable_error: standardScanTotals.scan_unavailable_error,
    standard_scan_timed_out: standardScanTotals.timed_out,
    standard_scan_incomplete: standardScanTotals.timed_out,
    standard_scan_timeout_ms: standardScanTotals.timeout_ms,
    verified_key_count: Math.max(Number(keyBundle?.diagnostics?.verified_key_count || 0) || 0, verified.length),
    total_candidate_count: rawKeys.length,
  };
  notifyProgress(onProgress, {
    phase: 'fetch_key_standard_done',
    label: keyProgressLabel(progress_context, '本地访问验证已完成'),
    detail: [
      verified.length ? `已确认 ${verified.length} 条本地访问候选` : '未命中可用本地访问候选',
      diagnostics.standard_scan_pointer_candidate_count ? `指针候选 ${diagnostics.standard_scan_pointer_candidate_count} 条` : '',
      diagnostics.standard_scan_candidate_count ? `已检查 ${diagnostics.standard_scan_candidate_count} 条候选` : '',
      diagnostics.standard_scan_unavailable ? `自动扫描不可用：${diagnostics.standard_scan_unavailable_error || '没有成功读取微信进程内存'}` : '',
      diagnostics.standard_scan_timed_out ? `标准扫描达到 ${Math.max(1, Math.ceil(Number(diagnostics.standard_scan_timeout_ms || 0) / 1000) || 45)} 秒上限，未命中不能当作没有密钥` : '',
      diagnostics.standard_scan_message_shard_requested_count
        ? `消息库分片 ${Math.min(diagnostics.standard_scan_message_shard_matched_count, diagnostics.standard_scan_message_shard_requested_count)}/${diagnostics.standard_scan_message_shard_requested_count} 已验证`
        : '',
      diagnostics.standard_scan_message_sample_verified ? '消息库样本已验证' : '',
      diagnostics.validation_budget_exhausted_count && diagnostics.validation_omitted_candidate_count
        ? `兼容模式省略 ${diagnostics.validation_omitted_candidate_count} 个低优先级候选组合`
        : '',
      groupsOnly ? '仅检查群列表数据库样本' : '',
      dbStatus?.error ? `扫描失败：${redactSecrets(dbStatus.error).slice(0, 80)}` : '',
    ].filter(Boolean).join(' · ') || '未命中可用本地访问候选',
  });
  if (!verified.length) return dbKeyBundle([], diagnostics, dbKeyBundleMetadata(keyBundle));
  return dbKeyBundle(rawKeys, diagnostics, dbKeyBundleMetadata(keyBundle));
}

function dbKeyBundle(rawKeys = [], diagnostics = {}, metadata = {}) {
  const bundle = { rawKeys, diagnostics };
  Object.defineProperty(bundle, '__legacy_manual_keys', {
    value: uniqueStrings(metadata.legacy_manual_keys || []),
    enumerable: false,
  });
  Object.defineProperty(bundle, '__legacy_manual_text', {
    value: String(metadata.legacy_manual_text || '').trim(),
    enumerable: false,
  });
  Object.defineProperty(bundle, '__account_aliases', {
    value: uniqueStrings(metadata.account_aliases || []),
    enumerable: false,
  });
  return bundle;
}

function dbKeyBundleMetadata(bundle = null) {
  return {
    legacy_manual_keys: Array.isArray(bundle?.__legacy_manual_keys) ? bundle.__legacy_manual_keys : [],
    legacy_manual_text: String(bundle?.__legacy_manual_text || '').trim(),
    account_aliases: Array.isArray(bundle?.__account_aliases) ? bundle.__account_aliases : [],
  };
}

async function legacyManualKeyBindingAfterVerifiedUse(bundle = null, result = null, { account_id = '', signal = null, onProgress = null, progress_context = 'digest' } = {}) {
  throwIfAborted(signal);
  if (progress_context === 'groups') return null;
  const metadata = dbKeyBundleMetadata(bundle);
  if (!account_id || !metadata.legacy_manual_keys.length || !metadata.legacy_manual_text) return null;
  const verified = verifiedRawKeysFromResult(result);
  if (!verified.length || !legacyManualKeyVerifiedByResult(metadata.legacy_manual_keys, verified)) return null;
  const binding = await authoritativeVerifiedKeyAccountBinding(account_id, verifiedAccountFromResult(result), signal).catch(() => null);
  if (!binding) {
    notifyProgress(onProgress, {
      phase: 'fetch_key_legacy_migrate_skipped',
      label: keyProgressLabel(progress_context, '密钥未自动绑定'),
      detail: '本次读取已成功，但项目副本中的当前账号身份已变化或暂不可确认；已保留未绑定候选且未写入错误账号',
    });
    return null;
  }
  notifyProgress(onProgress, {
    phase: 'fetch_key_legacy_binding_ready',
    label: keyProgressLabel(progress_context, '待绑定密钥已验证'),
    detail: '未绑定的全局手动密钥已通过当前账号本地工作数据验证；本批输出收尾后会自动绑定到当前账号',
  });
  return {
    account_id: binding.account_id,
    account_aliases: uniqueStrings([...metadata.account_aliases, ...binding.account_aliases]),
    account_fingerprint: binding.account_fingerprint,
    expected_manual_key_text: metadata.legacy_manual_text,
    message_db_verified: result?.message_db_verified === true,
    message_db_checked_count: Math.max(0, Number(result?.message_db_checked_count || 0) || 0),
    message_db_total_count: Math.max(0, Number(result?.message_db_total_count || 0) || 0),
  };
}

function attachLegacyManualKeyBinding(result = null, binding = null) {
  if (!result || typeof result !== 'object' || !binding) return result;
  Object.defineProperty(result, '__legacy_manual_key_binding', {
    value: binding,
    enumerable: false,
    configurable: true,
  });
  return result;
}

export function legacyManualKeyBindingFromResult(result = null) {
  const binding = result?.__legacy_manual_key_binding;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return null;
  return {
    account_id: String(binding.account_id || '').trim(),
    account_aliases: uniqueStrings(binding.account_aliases || []),
    account_fingerprint: String(binding.account_fingerprint || '').trim().toLowerCase(),
    expected_manual_key_text: String(binding.expected_manual_key_text || '').trim(),
    message_db_verified: binding.message_db_verified === true,
    message_db_checked_count: Math.max(0, Number(binding.message_db_checked_count || 0) || 0),
    message_db_total_count: Math.max(0, Number(binding.message_db_total_count || 0) || 0),
  };
}

function accountIdentityVerified(account = {}) {
  return isWxDbMirrorIdentityVerified(account);
}

function resultAccountMatchesExpected(account = null, expectedAccountId = '') {
  const expected = String(expectedAccountId || '').trim().toLowerCase();
  if (!expected || !account || typeof account !== 'object') return false;
  return uniqueStrings([
    account.account_id,
    account.id,
    account.storage_id,
    account.identity_id,
    account.legacy_id,
    account.wxid,
    ...(Array.isArray(account.account_aliases) ? account.account_aliases : []),
  ]).some(value => value.toLowerCase() === expected);
}

function verifiedResultAccountFingerprint(result = null, fallback = '', expectedAccountId = '') {
  const account = verifiedAccountFromResult(result);
  if (accountIdentityVerified(account)) {
    if (!resultAccountMatchesExpected(account, expectedAccountId)) return '';
    return manualKeyAccountFingerprint(account);
  }
  if (account) return '';
  return String(fallback || '').trim();
}

function verifiedAccountFromResult(result = null) {
  const account = result?.account || result?.__verified_account || null;
  return account && typeof account === 'object' && !Array.isArray(account) ? account : null;
}

function verifiedKeyAccountBindingFromAccounts(proofAccount = null, authoritativeAccount = null, expectedAccountId = '') {
  if (!accountIdentityVerified(proofAccount) || !accountIdentityVerified(authoritativeAccount)) return null;
  if (!resultAccountMatchesExpected(proofAccount, expectedAccountId)
    || !resultAccountMatchesExpected(authoritativeAccount, expectedAccountId)) return null;
  const proofIdentityId = String(proofAccount.identity_id || proofAccount.mirror?.identity_id || '').trim().toLowerCase();
  const authoritativeIdentityId = String(authoritativeAccount.identity_id || authoritativeAccount.mirror?.identity_id || '').trim().toLowerCase();
  const proofSelfWxid = String(proofAccount.verified_self_wxid || proofAccount.mirror?.verified_self_wxid || '').trim();
  const authoritativeSelfWxid = String(authoritativeAccount.verified_self_wxid || authoritativeAccount.mirror?.verified_self_wxid || '').trim();
  if (!proofIdentityId || proofIdentityId !== authoritativeIdentityId
    || !proofSelfWxid || proofSelfWxid !== authoritativeSelfWxid) return null;
  if (!dbKeyAccountCandidateBindingComplete(authoritativeAccount)) return null;
  const accountFingerprint = manualKeyAccountFingerprint(authoritativeAccount);
  const accountSignature = dbKeyAccountRuntimeSignature(authoritativeAccount);
  if (!/^[a-f0-9]{64}$/.test(accountFingerprint) || !accountSignature) return null;
  return {
    account: authoritativeAccount,
    account_id: String(authoritativeAccount.account_id || authoritativeAccount.id || expectedAccountId).trim(),
    account_aliases: accountAliases(authoritativeAccount),
    account_fingerprint: accountFingerprint,
    account_signature: accountSignature,
  };
}

async function authoritativeVerifiedKeyAccountBinding(accountId = '', proofAccount = null, signal = null) {
  throwIfAborted(signal);
  if (!proofAccount || !accountIdentityVerified(proofAccount) || !resultAccountMatchesExpected(proofAccount, accountId)) return null;
  const authoritativeAccount = await readWxDbMirrorAccount(accountId, { signal });
  throwIfAborted(signal);
  return verifiedKeyAccountBindingFromAccounts(proofAccount, authoritativeAccount, accountId);
}

function verifiedRawKeysFromResult(result = null) {
  return uniqueStrings([
    ...(Array.isArray(result?.__verified_raw_keys) ? result.__verified_raw_keys : []),
    ...(result?.__verified_raw_key ? [result.__verified_raw_key] : []),
  ]);
}

function legacyManualKeyVerifiedByResult(legacyKeys = [], verifiedKeys = []) {
  const verifiedPageKeys = new Set(uniqueStrings(verifiedKeys).flatMap(raw => manualKeyPageKeyCandidates(raw)));
  if (!verifiedPageKeys.size) return false;
  return uniqueStrings(legacyKeys).some(raw => manualKeyPageKeyCandidates(raw).some(key => verifiedPageKeys.has(key)));
}

export function manualKeyTextMatchesVerifiedRawKeys(manualKeyText = '', verifiedKeys = []) {
  return legacyManualKeyVerifiedByResult(splitManualKeys(manualKeyText), verifiedKeys);
}

function manualKeyPageKeyCandidates(raw = '') {
  const text = String(raw || '').trim().toLowerCase();
  if (!/^[a-f0-9]+$/.test(text) || ![64, 96, 128, 160, 192].includes(text.length)) return [];
  return uniqueStrings([
    text.slice(0, 64),
    text.length >= 128 ? text.slice(64, 128) : '',
  ].filter(value => /^[a-f0-9]{64}$/.test(value)));
}

function keyCandidateProgressDetail(diagnostics = {}, dbName = '') {
  const d = diagnostics || {};
  return [
    dbName || '数据库',
    d.cache_hit ? '命中候选缓存' : '',
    d.settings_load_error ? '设置读取失败' : '',
    `候选 ${Number(d.total_candidate_count || 0) || 0} 条`,
    Number(d.manual_key_count || 0) ? `手动 ${Number(d.manual_key_count || 0)}` : '',
    Number(d.verified_key_count || 0) ? `上次验证 ${Number(d.verified_key_count || 0)}` : '',
    d.verified_key_candidate_revalidation_required ? '将重新核验' : '',
    Number(d.local_candidate_count || 0) ? `本地 ${Number(d.local_candidate_count || 0)}` : '',
    d.standard_scan_unavailable ? '自动验证不可用' : '',
    d.standard_scan_attempted ? `自动验证 ${Number(d.standard_scan_verified_key_count || 0) || 0}` : '',
    Number(d.validation_omitted_candidate_count || 0) ? `兼容模式省略 ${Number(d.validation_omitted_candidate_count || 0)}` : '',
    d.memory_scan_attempted ? `内存 ${Number(d.memory_candidate_count || 0) || 0}` : '',
    d.memory_scan_attempted && Number(d.scan_process_count || 0) ? `进程 ${Number(d.scan_process_count || 0)}` : '',
  ].filter(Boolean).join(' · ');
}

function dbKeySettingsUnavailableError(error) {
  const detail = redactSecrets(error?.message || String(error || '')).slice(0, 200);
  const err = new Error(`读取本机设置失败，无法加载已保存手动数据库密钥候选${detail ? `：${detail}` : ''}`);
  err.status = 500;
  err.code = 'manual_key_settings_unavailable';
  err.public_code = 'manual_key_settings_unavailable';
  return err;
}

function normalizeLegacyManualKeyPolicy(value = LEGACY_MANUAL_KEY_POLICY.DENY) {
  const policy = String(value || '').trim();
  if (policy === LEGACY_MANUAL_KEY_POLICY.DENY
    || policy === LEGACY_MANUAL_KEY_POLICY.ALLOW_VERIFIED_MIGRATION) return policy;
  throw Object.assign(new Error('数据库密钥候选策略无效，已拒绝继续读取。'), {
    status: 400,
    code: 'legacy_manual_key_policy_invalid',
    public_code: 'legacy_manual_key_policy_invalid',
  });
}

function legacyManualKeysForPolicy({
  policy = LEGACY_MANUAL_KEY_POLICY.DENY,
  configuredText = '',
  requestedText = null,
  hasTemporaryManualKey = false,
} = {}) {
  const normalizedPolicy = normalizeLegacyManualKeyPolicy(policy);
  const requested = splitManualKeys(requestedText);
  if (normalizedPolicy === LEGACY_MANUAL_KEY_POLICY.DENY && requested.length) {
    throw Object.assign(new Error('当前服务端读取路径不允许使用未绑定账号的全局数据库密钥。'), {
      status: 400,
      code: 'legacy_manual_key_policy_forbidden',
      public_code: 'legacy_manual_key_policy_forbidden',
    });
  }
  if (hasTemporaryManualKey
    || normalizedPolicy !== LEGACY_MANUAL_KEY_POLICY.ALLOW_VERIFIED_MIGRATION) return [];
  return uniqueStrings([...splitManualKeys(configuredText), ...requested]);
}

async function dbRawKeyCandidates() {
  return (await dbRawKeyCandidateBundle()).rawKeys;
}

function memoryKeyScanAvailability(scan = null, { attempted = false, platform = process.platform } = {}) {
  if (!attempted || String(platform || '') !== 'win32') {
    return { unavailable: false, incomplete: false, reason: '', error: '', scanned_bytes: Number(scan?.scanned_bytes || 0) || 0 };
  }
  const stage = String(scan?.stage || '').trim();
  const scannedBytes = Number(scan?.scanned_bytes || 0) || 0;
  const unavailable = !scan
    || ['process', 'open_process'].includes(stage)
    || scan.read_only_handle_ok !== true
    || (stage === 'scan' && scannedBytes <= 0);
  const reason = !scan
    ? 'scan_failed'
    : (stage === 'process'
      ? 'process_not_running'
      : (stage === 'open_process'
        ? 'process_open_failed'
        : (stage === 'scan' && scannedBytes <= 0 ? 'process_memory_unreadable' : '')));
  const incomplete = scan?.scan_incomplete === true || scan?.scan_timed_out === true;
  return {
    unavailable,
    incomplete,
    reason,
    error: unavailable || incomplete
      ? (scan?.scan_timed_out === true
        ? `自动扫描达到 ${Math.max(1, Math.round(Number(scan?.scan_timeout_ms || 0) / 1000))} 秒时间上限，已停止继续扫描。`
        : redactSecrets(scan?.scan_errors?.[0]?.error || scan?.reason || '没有成功读取微信进程内存').slice(0, 180))
      : '',
    scanned_bytes: scannedBytes,
  };
}

function keyMemoryScanFallbackReason(diagnostics = {}) {
  const d = diagnostics || {};
  if (Number(d.standard_scan_verified_key_count || 0) > 0) return 'standard_verified_candidates_unusable';
  if (Number(d.verified_key_count || 0) > 0) return 'verified_candidates_unusable';
  if (Number(d.manual_key_count || 0) > 0) return 'manual_candidates_unusable';
  if (Number(d.local_candidate_count || 0) > 0) return 'local_candidates_unusable';
  return 'no_quick_candidates';
}

function memoryScanProgressDetail({
  fallbackReason = '',
  verifiedCandidateCount = 0,
  manualCandidateCount = 0,
  localCandidateCount = 0,
} = {}) {
  if (fallbackReason === 'standard_verified_candidates_unusable') {
    return '已验证候选尚未通过当前本地工作数据读取，正在只读扫描微信进程补充候选';
  }
  if (fallbackReason === 'verified_candidates_unusable') {
    return '上次验证候选尚未通过当前本地工作数据读取，正在只读扫描微信进程补充候选';
  }
  if (fallbackReason === 'manual_candidates_unusable') {
    return '已保存手动候选尚未通过当前本地工作数据读取，正在只读扫描微信进程补充候选';
  }
  if (fallbackReason === 'local_candidates_unusable') {
    return '本地候选尚未通过当前本地工作数据读取，正在只读扫描微信进程补充候选';
  }
  if (verifiedCandidateCount > 0) {
    return `保留上次验证候选 ${verifiedCandidateCount} 条，同时只读扫描微信进程补充候选`;
  }
  if (manualCandidateCount > 0) {
    return `保留手动候选 ${manualCandidateCount} 条，同时只读扫描微信进程补充候选`;
  }
  if (localCandidateCount > 0) {
    return `保留本地候选 ${localCandidateCount} 条，同时只读扫描微信进程补充候选`;
  }
  return '未找到可用候选，正在只读扫描微信进程补充候选';
}

function composeDbRawKeyCandidates({ manual = [], verified = [], memory_pointer = [], local = [], memory = [] } = {}) {
  const sourceOrder = ['manual', 'verified', 'memory_pointer', 'local', 'memory'];
  const sourceValues = { manual, verified, memory_pointer, local, memory };
  const normalizedSourceValues = Object.fromEntries(sourceOrder.map(source => [
    source,
    uniqueStrings(Array.isArray(sourceValues[source]) ? sourceValues[source] : []),
  ]));
  const records = new Map();
  for (const source of sourceOrder) {
    normalizedSourceValues[source].forEach(value => {
      let record = records.get(value);
      if (!record) {
        record = { value, sources: new Set() };
        records.set(value, record);
      }
      record.sources.add(source);
    });
  }
  const lanes = Object.fromEntries(sourceOrder.map(source => [source, []]));
  for (const record of records.values()) {
    const owner = sourceOrder.find(source => record.sources.has(source));
    if (owner) lanes[owner].push(record);
  }
  const rawKeys = [];
  const owners = [];
  const consumed = Object.fromEntries(sourceOrder.map(source => [source, 0]));
  const appendFromLane = (source, count) => {
    const lane = lanes[source];
    const end = Math.min(lane.length, consumed[source] + count);
    while (consumed[source] < end) {
      const record = lane[consumed[source]];
      consumed[source] += 1;
      rawKeys.push(record.value);
      owners.push(source);
    }
  };
  // Compatibility profiles inspect only a bounded prefix. Reserve that prefix
  // for explicit/cached keys and one candidate from each live-memory lane.
  appendFromLane('manual', 3);
  appendFromLane('verified', 3);
  appendFromLane('memory_pointer', 1);
  appendFromLane('memory', 1);
  while (rawKeys.length < records.size) {
    let appended = false;
    for (const source of sourceOrder) {
      const record = lanes[source][consumed[source]];
      if (!record) continue;
      consumed[source] += 1;
      rawKeys.push(record.value);
      owners.push(source);
      appended = true;
    }
    if (!appended) break;
  }
  const countOwners = values => Object.fromEntries(sourceOrder.map(source => [
    source,
    values.reduce((count, value) => count + (value === source ? 1 : 0), 0),
  ]));
  return {
    rawKeys,
    diagnostics: {
      source_counts: Object.fromEntries(sourceOrder.map(source => [source, normalizedSourceValues[source].length])),
      owned_counts: countOwners(owners),
      prefix_4_counts: countOwners(owners.slice(0, 4)),
      prefix_8_counts: countOwners(owners.slice(0, 8)),
      prefix_28_counts: countOwners(owners.slice(0, 28)),
      prefix_96_counts: countOwners(owners.slice(0, 96)),
    },
  };
}

export async function dbRawKeyCandidateBundle({ memoryScan = true, memoryScanFallbackReason = '', onProgress = null, signal = null, account_id = '', manualOnly = false, manual_key_text = null, legacy_manual_key_text = null, legacy_manual_key_policy = LEGACY_MANUAL_KEY_POLICY.DENY } = {}) {
  throwIfAborted(signal);
  const legacyManualKeyPolicy = normalizeLegacyManualKeyPolicy(legacy_manual_key_policy);
  const hasTemporaryManualKey = manual_key_text !== null && manual_key_text !== undefined;
  let settings = null;
  let settingsLoadError = null;
  try {
    settings = await loadSettings({ includeSecrets: true });
  } catch (e) {
    settingsLoadError = e;
    if (manualOnly && !hasTemporaryManualKey) throw dbKeySettingsUnavailableError(e);
  }
  if (!settingsLoadError && settings?._secrets_invalid === true) {
    const recoveryDetail = String(settings?._secrets_invalid_info?.error || '').trim();
    settingsLoadError = Object.assign(new Error(`加密设置密钥暂不可读${recoveryDetail ? `：${recoveryDetail}` : ''}`), {
      code: 'settings_secrets_invalid',
    });
    if (manualOnly && !hasTemporaryManualKey) throw dbKeySettingsUnavailableError(settingsLoadError);
  }
  throwIfAborted(signal);
  const accountContext = await dbKeyAccountContext(account_id, signal);
  const candidateCacheGenerationAtStart = DB_KEY_CANDIDATE_CACHE_GENERATION;
  const savedManualText = manualKeysForAccount(settings, account_id, accountContext.aliases, accountContext.account_fingerprint);
  const scopedManual = splitManualKeys(hasTemporaryManualKey ? manual_key_text : savedManualText);
  const legacyManual = legacyManualKeysForPolicy({
    policy: legacyManualKeyPolicy,
    configuredText: settings?.wechat?.manual_key_legacy || settings?.wechat?.manual_key || '',
    requestedText: legacy_manual_key_text,
    hasTemporaryManualKey,
  });
  const legacyManualText = legacyManual.join('\n');
  const manual = uniqueStrings([...scopedManual, ...legacyManual]);
  const legacyManualCandidateCount = legacyManual.length;
  const legacyManualKeyUnscoped = legacyManual.length > 0;
  const manualKeySource = [
    scopedManual.length ? (hasTemporaryManualKey ? 'temporary' : 'saved') : '',
    legacyManual.length ? 'legacy' : '',
  ].filter(Boolean).join('+');
  const manualKeyAccountScoped = !hasTemporaryManualKey && scopedManual.length > 0;
  const manualKeyLegacyMigratable = legacyManual.length > 0 && !!String(account_id || '').trim();
  const hasRequestScopedManualKey = hasTemporaryManualKey || legacyManual.length > 0;
  const accountSignature = accountContext.signature;
  let persistentVerifiedCacheError = null;
  const persistentVerifiedCacheAttempted = !manualOnly && accountContext.key_candidate_reuse_allowed;
  const persistentVerifiedCache = !persistentVerifiedCacheAttempted ? [] : await verifiedWxdbKeysForAccount({
    account_id: persistentVerifiedKeyCacheAccountId(accountContext, account_id),
    account_fingerprint: accountContext.account_fingerprint,
  }).catch(error => {
    persistentVerifiedCacheError = error;
    return [];
  });
  const persistentVerifiedCacheRecovery = persistentVerifiedCacheAttempted ? verifiedWxdbKeyCacheInvalidInfo() : null;
  if (persistentVerifiedCacheRecovery && !persistentVerifiedCacheError) {
    persistentVerifiedCacheError = Object.assign(new Error(
      persistentVerifiedCacheRecovery.status === 'backed_up'
        ? '自动密钥缓存损坏，原文件已备份并忽略'
        : '自动密钥缓存暂不可用',
    ), { code: 'wxdb_key_cache_recovered' });
  }
  // Keep the in-memory cache under the same account-anchor gate as the
  // encrypted cache. A matching path/signature alone is not sufficient when
  // the refreshed project copy has not yet been bound back to a stable account.
  const runtimeVerifiedCache = manualOnly || !accountContext.key_candidate_reuse_allowed
    ? []
    : verifiedRawKeyCacheForAccount(accountSignature);
  const verifiedCache = uniqueStrings([...runtimeVerifiedCache, ...persistentVerifiedCache]);
  // 已有手动候选时，快速阶段直接验证它；只有进入自动补候选阶段才扫描本地文件。
  const shouldScanLocal = !manualOnly && (!manual.length || memoryScan);
  const shouldScanMemory = !manualOnly && !!memoryScan;
  notifyProgress(onProgress, {
    phase: 'fetch_key_local',
    label: '拉取消息 · 搜索本地密钥候选',
    detail: [
      manualOnly ? (hasTemporaryManualKey ? '只验证本次输入的手动候选' : '只验证已保存手动候选') : '',
      settingsLoadError ? '设置读取失败，已跳过已保存手动候选' : '',
      runtimeVerifiedCache.length ? `本次运行候选 ${runtimeVerifiedCache.length} 条${accountContext.key_candidate_revalidation_required ? '（将重新核验）' : ''}` : '',
      persistentVerifiedCache.length ? `加密缓存候选 ${persistentVerifiedCache.length} 条${accountContext.key_candidate_revalidation_required ? '（将重新核验）' : ''}` : '',
      persistentVerifiedCacheError ? '加密密钥缓存暂不可读' : '',
      manual.length ? `手动 ${manual.length} 条` : '',
      shouldScanLocal ? (shouldScanMemory ? '重新扫描本地密钥文件' : '检查本地密钥缓存') : '',
    ].filter(Boolean).join(' · ') || '检查本地密钥缓存',
  });
  let localScanError = null;
  const local = shouldScanLocal
    ? await scanLocalWeixinKeyCandidates({ include_raw: true, account_id, cache: !memoryScan, signal }).catch(e => {
      if (e?.status === 499 || signal?.aborted) throw e;
      localScanError = e;
      return null;
    })
    : null;
  throwIfAborted(signal);
  const localScanIncomplete = local?.incomplete === true
    || Number(local?.warning_count || 0) > 0
    || Number(local?.file_stats?.read_errors || 0) > 0
    || Number(local?.file_stats?.stat_errors || 0) > 0
    || Number(local?.file_stats?.dir_errors || 0) > 0;
  const candidateSourcesIncomplete = !!settingsLoadError
    || !!persistentVerifiedCacheError
    || !!localScanError
    || localScanIncomplete;
  notifyProgress(onProgress, {
    phase: 'fetch_key_local_done',
    label: '拉取消息 · 本地候选已整理',
    detail: [
      manual.length ? `手动 ${manual.length}` : '',
      runtimeVerifiedCache.length ? `本次运行候选 ${runtimeVerifiedCache.length}${accountContext.key_candidate_revalidation_required ? '（待核验）' : ''}` : '',
      persistentVerifiedCache.length ? `加密缓存候选 ${persistentVerifiedCache.length}${accountContext.key_candidate_revalidation_required ? '（待核验）' : ''}` : '',
      persistentVerifiedCacheError ? `加密密钥缓存读取失败：${redactSecrets(persistentVerifiedCacheError?.message || String(persistentVerifiedCacheError)).slice(0, 80)}` : '',
      settingsLoadError ? `设置读取失败：${redactSecrets(settingsLoadError?.message || String(settingsLoadError)).slice(0, 80)}` : '',
      localScanError ? `本地扫描失败：${redactSecrets(localScanError?.message || String(localScanError)).slice(0, 80)}` : '',
      !localScanError && Number(local?.warning_count || 0) ? `本地扫描警告 ${Number(local.warning_count || 0)}` : '',
      shouldScanLocal && !localScanError ? `本地候选 ${Number(local?.unique_candidate_count || local?.candidate_count || 0) || 0}` : '',
      shouldScanLocal && Number(local?.file_stats?.scanned || 0) ? `文件 ${Number(local.file_stats.scanned || 0)}` : '',
    ].filter(Boolean).join(' · ') || '暂无本地候选',
  });
  let processGenerationLookupError = null;
  const processState = shouldScanMemory
    ? await currentWxKeyProcessGeneration({ signal }).catch(error => {
        if (error?.status === 499 || signal?.aborted) throw error;
        processGenerationLookupError = error;
        return { process_generation: '', process_count: 0, main_process_present: false };
      })
    : { process_generation: '', process_count: 0, main_process_present: false };
  throwIfAborted(signal);
  const cacheKeyForProcessGeneration = processGeneration => JSON.stringify({
    platform: process.platform,
    account: accountSignature,
    manualOnly,
    memoryScan: shouldScanMemory,
    memory_scan_mode: shouldScanMemory ? STANDARD_MEMORY_KEY_SCAN_MODE : null,
    memory_process_generation: shouldScanMemory ? String(processGeneration || '') : null,
    legacy_manual_key_policy: legacyManualKeyPolicy,
    manual_key_source: manualKeySource,
    manual_key_text: manual.join('\n'),
    legacy_manual_text: legacyManualText,
    verified_key_cache_hash: cryptoHashStrings(verifiedCache),
    local_fingerprint: local?.cache_fingerprint?.hash_12 || '',
    local_file_count: Number(local?.file_stats?.scanned || 0),
  });
  const cacheLookupKey = cacheKeyForProcessGeneration(processState.process_generation);
  const canCacheKeyBundle = !hasRequestScopedManualKey
    && !settingsLoadError
    && !persistentVerifiedCacheError
    && !localScanError
    && !localScanIncomplete;
  const canReadKeyBundleCache = canCacheKeyBundle
    && accountContext.key_candidate_reuse_allowed === true
    && (!shouldScanMemory || (!processGenerationLookupError && !!processState.process_generation));
  if (canReadKeyBundleCache
    && DB_KEY_CANDIDATE_CACHE
    && DB_KEY_CANDIDATE_CACHE.key === cacheLookupKey
    && Date.now() - DB_KEY_CANDIDATE_CACHE.at < DB_KEY_CANDIDATE_CACHE_MS) {
    throwIfAborted(signal);
    notifyProgress(onProgress, {
      phase: 'fetch_key_cache',
      label: '拉取消息 · 命中密钥候选缓存',
      detail: `候选 ${Number(DB_KEY_CANDIDATE_CACHE.rawKeys?.length || 0) || 0} 条`,
    });
    return dbKeyBundle(
      DB_KEY_CANDIDATE_CACHE.rawKeys,
      { ...DB_KEY_CANDIDATE_CACHE.diagnostics, cache_hit: true },
      DB_KEY_CANDIDATE_CACHE.metadata || {},
    );
  }
  if (shouldScanMemory) {
    throwIfAborted(signal);
    notifyProgress(onProgress, {
      phase: 'fetch_key_memory',
      label: '拉取消息 · 只读扫描微信进程',
      detail: memoryScanProgressDetail({
        fallbackReason: memoryScanFallbackReason,
        verifiedCandidateCount: verifiedCache.length,
        manualCandidateCount: manual.length,
        localCandidateCount: Number(local?.unique_candidate_count || local?.candidate_count || 0) || 0,
      }),
    });
  }
  const scan = shouldScanMemory
    ? await probeWxKey({
        scan: true,
        include_raw: true,
        scan_all_processes: true,
        scan_writable_only: STANDARD_MEMORY_KEY_SCAN_MODE.scan_writable_only,
        scan_include_mapped: STANDARD_MEMORY_KEY_SCAN_MODE.scan_include_mapped,
        scan_max_bytes: STANDARD_MEMORY_KEY_SCAN_MODE.scan_max_bytes,
        scan_max_region_bytes: STANDARD_MEMORY_KEY_SCAN_MODE.scan_max_region_bytes,
        scan_max_ms: STANDARD_MEMORY_KEY_SCAN_MODE.scan_max_ms,
        signal,
      })
    : null;
  throwIfAborted(signal);
  const memoryAvailability = memoryKeyScanAvailability(scan, { attempted: shouldScanMemory });
  const memoryProcessGeneration = String(scan?.process_generation || processState.process_generation || '');
  const memoryProcessGenerationChanged = shouldScanMemory
    && !!processState.process_generation
    && !!scan?.process_generation
    && processState.process_generation !== scan.process_generation;
  if (shouldScanMemory) {
    notifyProgress(onProgress, {
      phase: 'fetch_key_memory_done',
      label: '拉取消息 · 内存候选已整理',
      detail: memoryAvailability.unavailable
        ? `自动扫描不可用：${memoryAvailability.error || '没有成功读取微信进程内存'}；本次不会把结果记成“0 个候选”`
        : (memoryAvailability.incomplete
          ? (scan?.scan_timed_out === true
            ? `自动扫描达到 ${Math.max(1, Math.round(Number(scan?.scan_timeout_ms || 0) / 1000))} 秒时间上限；已保留 ${Number(scan?.unique_candidate_count || scan?.candidate_count || 0) || 0} 条候选，本次不缓存不完整结果`
            : `已保留可读进程找到的 ${Number(scan?.unique_candidate_count || scan?.candidate_count || 0) || 0} 条候选；另有 ${Number(scan?.scan_error_count || 0) || 0} 个进程扫描失败，本次不缓存不完整结果`)
        : [
            `内存候选 ${Number(scan?.unique_candidate_count || scan?.candidate_count || 0) || 0} 条`,
            `扫描进程 ${Number(scan?.scan_process_count || 0) || 0} 个`,
          ].join(' · ')),
    });
  }
  const memoryPointerCandidates = scan?._raw_v4_pointer_candidates || [];
  const candidateComposition = composeDbRawKeyCandidates({
    manual,
    verified: verifiedCache,
    memory_pointer: memoryPointerCandidates,
    local: local?.raw_candidates || [],
    memory: scan?._raw_candidates || [],
  });
  const rawKeys = candidateComposition.rawKeys;
  const diagnostics = {
    cache_hit: false,
    account_scoped_cache: !!accountSignature,
    account_alias_count: Array.isArray(accountContext.aliases) ? accountContext.aliases.length : 0,
    account_last_write_time: accountContext.last_write_time || '',
    account_stale_days: accountContext.stale_days || 0,
    selected_account_label: accountContext.selected_account_label || '',
    newer_account_available: !!accountContext.newer_account_available,
    suggested_account_id: accountContext.suggested_account_id || '',
    suggested_account_label: accountContext.suggested_account_label || '',
    suggested_account_last_write_time: accountContext.suggested_account_last_write_time || '',
    manual_only: !!manualOnly,
    legacy_manual_key_policy: legacyManualKeyPolicy,
    candidate_sources_incomplete: candidateSourcesIncomplete,
    candidate_source_settings_incomplete: !!settingsLoadError,
    candidate_source_verified_cache_incomplete: !!persistentVerifiedCacheError,
    candidate_source_local_scan_incomplete: !!localScanError || localScanIncomplete,
    manual_key_source: manualKeySource,
    manual_key_account_id: manualKeyAccountScoped ? String(account_id || '').trim() : '',
    manual_key_account_scoped: manualKeyAccountScoped,
    manual_key_legacy_unscoped: legacyManualKeyUnscoped,
    manual_key_legacy_candidate_count: legacyManualCandidateCount,
    manual_key_legacy_migratable: manualKeyLegacyMigratable,
    temporary_manual_key: !!hasTemporaryManualKey,
    memory_scan_attempted: !!shouldScanMemory,
    memory_scan_fallback_reason: shouldScanMemory ? String(memoryScanFallbackReason || '').trim() : '',
    memory_scan_unavailable: memoryAvailability.unavailable,
    memory_scan_incomplete: memoryAvailability.incomplete,
    memory_scan_unavailable_reason: memoryAvailability.reason,
    memory_scan_unavailable_error: memoryAvailability.error,
    memory_scan_scanned_bytes: memoryAvailability.scanned_bytes,
    memory_process_generation: memoryProcessGeneration,
    memory_process_generation_changed: memoryProcessGenerationChanged,
    memory_process_generation_lookup_error: processGenerationLookupError
      ? redactSecrets(processGenerationLookupError?.message || String(processGenerationLookupError)).slice(0, 200)
      : '',
    memory_scan_target_count: Number(scan?.process_count || 0) || 0,
    memory_scan_process_attempt_count: Number(scan?.scan_process_attempt_count || 0) || 0,
    memory_scan_error_count: Number(scan?.scan_error_count || 0) || 0,
    memory_scan_timed_out: scan?.scan_timed_out === true,
    memory_scan_timeout_ms: Number(scan?.scan_timeout_ms || 0) || 0,
    memory_scan_writable_only: scan?.scan_mode?.writable_only ?? null,
    memory_scan_include_mapped: scan?.scan_mode?.include_mapped ?? null,
    manual_key_count: manual.length,
    verified_key_count: verifiedCache.length,
    verified_key_candidate_revalidation_required: accountContext.key_candidate_revalidation_required === true && verifiedCache.length > 0,
    verified_key_candidate_identity_recovery_required: accountContext.key_candidate_identity_recovery_required === true && verifiedCache.length > 0,
    runtime_verified_key_count: runtimeVerifiedCache.length,
    persistent_verified_key_count: persistentVerifiedCache.length,
    persistent_verified_key_cache_error: persistentVerifiedCacheError
      ? redactSecrets(persistentVerifiedCacheError?.message || String(persistentVerifiedCacheError)).slice(0, 200)
      : '',
    persistent_verified_key_cache_recovery_status: String(persistentVerifiedCacheRecovery?.status || '').trim().slice(0, 40),
    persistent_verified_key_cache_backup_relative_path: String(persistentVerifiedCacheRecovery?.backup_relative_path || '').trim().slice(0, 240),
    persistent_verified_key_cache_backup_available: persistentVerifiedCacheRecovery?.backup_available === true,
    local_candidate_count: Number(local?.unique_candidate_count || local?.candidate_count || 0),
    local_file_count: Number(local?.file_stats?.scanned || 0),
    settings_load_error: settingsLoadError ? redactSecrets(settingsLoadError?.message || String(settingsLoadError)).slice(0, 200) : '',
    manual_key_settings_unavailable: !!settingsLoadError,
    local_scan_error: localScanError ? redactSecrets(localScanError?.message || String(localScanError)).slice(0, 200) : '',
    local_scan_warning_count: Number(local?.warning_count || 0) || 0,
    local_scan_warning: local?.first_warning ? redactSecrets(local.first_warning).slice(0, 200) : '',
    local_scan_dir_errors: Number(local?.file_stats?.dir_errors || 0) || 0,
    local_scan_stat_errors: Number(local?.file_stats?.stat_errors || 0) || 0,
    memory_candidate_count: Number(scan?.unique_candidate_count || scan?.candidate_count || 0),
    memory_pointer_candidate_count: memoryPointerCandidates.length,
    scan_process_count: Number(scan?.scan_process_count || 0),
    read_only_handle_ok: scan?.read_only_handle_ok === true,
    total_candidate_count: rawKeys.length,
    candidate_priority: candidateComposition.diagnostics,
  };
  const canWriteKeyBundleCache = canCacheKeyBundle
    && accountContext.key_candidate_reuse_allowed === true
    && candidateCacheGenerationAtStart === DB_KEY_CANDIDATE_CACHE_GENERATION
    && (!shouldScanMemory || (!memoryAvailability.unavailable && !memoryAvailability.incomplete && !!memoryProcessGeneration));
  if (canWriteKeyBundleCache) {
    DB_KEY_CANDIDATE_CACHE = {
      key: cacheKeyForProcessGeneration(memoryProcessGeneration),
      accountSignature,
      at: Date.now(),
      rawKeys,
      diagnostics,
      metadata: {
        legacy_manual_keys: legacyManual,
        legacy_manual_text: legacyManualText,
        account_aliases: accountContext.aliases,
      },
    };
  }
  return dbKeyBundle(rawKeys, diagnostics, {
    legacy_manual_keys: legacyManual,
    legacy_manual_text: legacyManualText,
    account_aliases: accountContext.aliases,
  });
}

export async function rememberVerifiedRawKeys(accountId = '', keys = [], options = {}) {
  const verified = uniqueStrings(keys).filter(isPersistableManualKey);
  if (!verified.length) return { memory_key_count: 0, persistence: { ok: true, changed: false, key_count: 0, skipped: 'no_verified_keys' } };
  const signal = options?.signal || null;
  throwIfAborted(signal);
  const expectedVersion = expectedDbKeyRuntimeStateVersion(options?.expected_state_version);
  if (!dbKeyRuntimeStateVersionMatches(expectedVersion)) {
    return { memory_key_count: 0, persistence: { ok: true, changed: false, key_count: 0, skipped: 'stale_runtime_state' } };
  }
  const proofAccount = options?.account && typeof options.account === 'object' ? options.account : null;
  let binding = null;
  try {
    binding = await authoritativeVerifiedKeyAccountBinding(accountId, proofAccount, options?.signal || null);
  } catch {
    return {
      memory_key_count: 0,
      persistence: {
        ok: false,
        changed: false,
        key_count: 0,
        skipped: 'account_identity_refresh_failed',
        error: '无法重新读取当前项目副本账号身份',
      },
    };
  }
  if (!dbKeyRuntimeStateVersionMatches(expectedVersion)) {
    return { memory_key_count: 0, persistence: { ok: true, changed: false, key_count: 0, skipped: 'stale_runtime_state' } };
  }
  if (!binding) {
    return {
      memory_key_count: 0,
      persistence: {
        ok: false,
        changed: false,
        key_count: 0,
        skipped: 'account_identity_unverified',
        error: '当前项目副本账号身份已变化或尚未验证',
      },
    };
  }
  throwIfAborted(signal);
  const accountFingerprint = binding.account_fingerprint;
  const accountSignature = binding.account_signature;
  const cacheKey = accountSignature;
  return withVerifiedRawKeyWriteLock(cacheKey, async () => {
    throwIfAborted(signal);
    if (!dbKeyRuntimeStateVersionMatches(expectedVersion)) {
      return { memory_key_count: 0, persistence: { ok: true, changed: false, key_count: 0, skipped: 'stale_runtime_state' } };
    }
    const current = verifiedRawKeyCacheForAccount(cacheKey);
    const next = uniqueStrings([...verified, ...current])
      .filter(isPersistableManualKey)
      .slice(0, 50);
    if (!dbKeyRuntimeStateVersionMatches(expectedVersion)) {
      return { memory_key_count: 0, persistence: { ok: true, changed: false, key_count: 0, skipped: 'stale_runtime_state' } };
    }
    throwIfAborted(signal);
    let persistence = { ok: true, changed: false, key_count: 0, skipped: '' };
    if (!accountFingerprint) {
      persistence = { ok: false, changed: false, key_count: 0, skipped: 'account_identity_unverified', error: '当前微信账号身份尚未通过消息库验证' };
    } else {
      try {
        persistence = {
          ok: true,
          ...(await rememberVerifiedWxdbKeysForAccount({
            account_id: binding.account_id,
            account_fingerprint: accountFingerprint,
            keys: verified,
            write_if: () => dbKeyRuntimeStateVersionMatches(expectedVersion) && !signal?.aborted,
          })),
        };
      } catch (error) {
        persistence = {
          ok: false,
          changed: false,
          key_count: 0,
          skipped: 'write_failed',
          error: redactSecrets(error?.message || String(error)).slice(0, 180),
        };
      }
    }
    throwIfAborted(signal);
    if (!dbKeyRuntimeStateVersionMatches(expectedVersion)) {
      return { memory_key_count: 0, persistence: { ok: true, changed: false, key_count: 0, skipped: 'stale_runtime_state' } };
    }
    setBoundedMapEntry(VERIFIED_RAW_KEY_CACHE, cacheKey, next, MAX_DB_KEY_ACCOUNT_RUNTIME_CACHE_ENTRIES);
    if (!DB_KEY_CANDIDATE_CACHE) {
      DB_KEY_CANDIDATE_CACHE = {
        key: `verified:${cacheKey}:${Date.now()}`,
        accountSignature: cacheKey,
        at: Date.now(),
        rawKeys: next,
        diagnostics: {
          cache_hit: false,
          account_scoped_cache: !!accountSignature,
          memory_scan_attempted: false,
          manual_key_count: 0,
          local_candidate_count: next.length,
          verified_key_count: next.length,
          total_candidate_count: next.length,
        },
      };
      return { memory_key_count: next.length, persistence };
    }
    if (DB_KEY_CANDIDATE_CACHE.accountSignature && DB_KEY_CANDIDATE_CACHE.accountSignature !== cacheKey) {
      return { memory_key_count: next.length, persistence };
    }
    DB_KEY_CANDIDATE_CACHE.rawKeys = uniqueStrings([...next, ...(DB_KEY_CANDIDATE_CACHE.rawKeys || [])])
      .filter(isPersistableManualKey)
      .slice(0, 50);
    DB_KEY_CANDIDATE_CACHE.at = Date.now();
    DB_KEY_CANDIDATE_CACHE.diagnostics = {
      ...(DB_KEY_CANDIDATE_CACHE.diagnostics || {}),
      verified_key_count: next.length,
      total_candidate_count: Math.max(Number(DB_KEY_CANDIDATE_CACHE.diagnostics?.total_candidate_count || 0), DB_KEY_CANDIDATE_CACHE.rawKeys.length),
    };
    return { memory_key_count: next.length, persistence };
  });
}

function verifiedKeyCachePersistenceNotice(status = null, contextLabel = '读取数据库') {
  if (status?.persistence?.ok !== false) return null;
  const reason = redactSecrets(status.persistence.error || status.persistence.skipped || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  return {
    ok: false,
    code: 'wxdb_key_cache_persist_failed',
    message: `本次${contextLabel}已成功，但验证通过的数据库密钥没有写入本机加密缓存；当前结果可继续使用，下次重启可能需要重新验证${reason ? `（${reason}）` : ''}`,
    reason,
  };
}

function notifyVerifiedKeyCachePersistence(onProgress, status = null, contextLabel = '读取数据库') {
  const notice = verifiedKeyCachePersistenceNotice(status, contextLabel);
  if (notice && typeof onProgress === 'function') {
    notifyProgress(onProgress, {
      phase: 'fetch_key_persist_warning',
      label: `${contextLabel} · 自动密钥缓存未保存`,
      detail: notice.message,
    });
  }
  return notice;
}

function verifiedRawKeyCacheForAccount(accountSignature = '') {
  const key = accountSignature || '__default__';
  return getBoundedMapEntry(VERIFIED_RAW_KEY_CACHE, key) || [];
}

function rememberVerifiedAutoRawKeysForBinding(binding = null, keys = [], { expected_state_version = null, verified_scope = '', signal = null } = {}) {
  if (String(verified_scope || '').trim().toLowerCase() !== 'message_sample') return false;
  const verified = uniqueStrings(keys).filter(isPersistableManualKey);
  if (!verified.length) return false;
  throwIfAborted(signal);
  const expectedVersion = expectedDbKeyRuntimeStateVersion(expected_state_version);
  if (!dbKeyRuntimeStateVersionMatches(expectedVersion)) return false;
  const cacheKey = String(binding?.account_signature || '').trim();
  if (!cacheKey) return false;
  const current = getBoundedMapEntry(VERIFIED_AUTO_RAW_KEY_CACHE, cacheKey) || [];
  const next = uniqueStrings([...verified, ...current]).slice(0, 50);
  FAILED_AUTO_RAW_KEY_SCAN_CACHE.delete(cacheKey);
  setBoundedMapEntry(VERIFIED_AUTO_RAW_KEY_CACHE, cacheKey, next, MAX_DB_KEY_ACCOUNT_RUNTIME_CACHE_ENTRIES);
  return true;
}

export async function rememberVerifiedAutoRawKeys(accountId = '', keys = [], { expected_state_version = null, verified_scope = '', account = null, signal = null } = {}) {
  if (String(verified_scope || '').trim().toLowerCase() !== 'message_sample') return false;
  const expectedVersion = expectedDbKeyRuntimeStateVersion(expected_state_version);
  if (!dbKeyRuntimeStateVersionMatches(expectedVersion)) return false;
  const binding = await authoritativeVerifiedKeyAccountBinding(accountId, account, signal).catch(() => null);
  if (!dbKeyRuntimeStateVersionMatches(expectedVersion) || !binding) return false;
  throwIfAborted(signal);
  return rememberVerifiedAutoRawKeysForBinding(binding, keys, {
    expected_state_version: expectedVersion,
    verified_scope,
    signal,
  });
}

export async function clearFailedAutoRawKeyScan(accountId = '', signal = null, { expected_state_version = null } = {}) {
  throwIfAborted(signal);
  const expectedVersion = expectedDbKeyRuntimeStateVersion(expected_state_version);
  if (!dbKeyRuntimeStateVersionMatches(expectedVersion)) return false;
  const accountSignature = await dbKeyAccountSignature(accountId, signal).catch(() => normalizeAccountIdForCache(accountId));
  throwIfAborted(signal);
  if (!dbKeyRuntimeStateVersionMatches(expectedVersion)) return false;
  const cacheKey = accountSignature || '__default__';
  if (!FAILED_AUTO_RAW_KEY_SCAN_CACHE.delete(cacheKey)) return false;
  return true;
}

export async function hasVerifiedAutoRawKeys(accountId = '', signal = null) {
  throwIfAborted(signal);
  const stateVersion = DB_KEY_RUNTIME_STATE_VERSION;
  const accountSignature = await dbKeyAccountSignature(accountId, signal).catch(() => normalizeAccountIdForCache(accountId));
  throwIfAborted(signal);
  if (stateVersion !== DB_KEY_RUNTIME_STATE_VERSION) return false;
  const cacheKey = accountSignature || '__default__';
  return (getBoundedMapEntry(VERIFIED_AUTO_RAW_KEY_CACHE, cacheKey) || []).length > 0;
}

export async function hasPersistedVerifiedRawKeyCandidates(accountId = '', signal = null) {
  throwIfAborted(signal);
  const stateVersion = DB_KEY_RUNTIME_STATE_VERSION;
  const accountContext = await dbKeyAccountContext(accountId, signal).catch(() => ({
    account_id: normalizeAccountIdForCache(accountId),
    account_fingerprint: '',
    identity_verified: false,
    key_candidate_reuse_allowed: false,
  }));
  throwIfAborted(signal);
  const accountFingerprint = accountContext.key_candidate_reuse_allowed === true
    ? String(accountContext.account_fingerprint || '').trim().toLowerCase()
    : '';
  if (!/^[a-f0-9]{64}$/.test(accountFingerprint)) return false;
  const persisted = (await verifiedWxdbKeysForAccount({
    account_id: accountContext.account_id || accountId,
    account_fingerprint: accountFingerprint,
  })).filter(isPersistableManualKey);
  throwIfAborted(signal);
  return stateVersion === DB_KEY_RUNTIME_STATE_VERSION && persisted.length > 0;
}

export async function rememberFailedAutoRawKeyScan(accountId = '', diagnostics = {}, signal = null, { expected_state_version = null } = {}) {
  throwIfAborted(signal);
  const expectedVersion = expectedDbKeyRuntimeStateVersion(expected_state_version);
  if (!dbKeyRuntimeStateVersionMatches(expectedVersion)) return false;
  if (automaticKeyScanIncomplete(diagnostics)) return;
  const accountSignature = await dbKeyAccountSignature(accountId, signal).catch(() => normalizeAccountIdForCache(accountId));
  throwIfAborted(signal);
  if (!dbKeyRuntimeStateVersionMatches(expectedVersion)) return false;
  const cacheKey = accountSignature || '__default__';
  if ((getBoundedMapEntry(VERIFIED_AUTO_RAW_KEY_CACHE, cacheKey) || []).length > 0) return false;
  pruneFailedAutoRawKeyScanCache();
  setBoundedMapEntry(FAILED_AUTO_RAW_KEY_SCAN_CACHE, cacheKey, {
    at: Date.now(),
    candidate_count: Number(diagnostics?.standard_scan_candidate_count || diagnostics?.candidate_count || 0) || 0,
    message_sample_verified: diagnostics?.standard_scan_message_sample_verified === true,
    memory_process_generation: String(diagnostics?.memory_process_generation || '').trim(),
  }, MAX_DB_KEY_ACCOUNT_RUNTIME_CACHE_ENTRIES);
  return true;
}

export async function hasFailedAutoRawKeyScan(accountId = '', signal = null) {
  throwIfAborted(signal);
  const accountSignature = await dbKeyAccountSignature(accountId, signal).catch(() => normalizeAccountIdForCache(accountId));
  throwIfAborted(signal);
  const cacheKey = accountSignature || '__default__';
  pruneFailedAutoRawKeyScanCache();
  const cached = getBoundedMapEntry(FAILED_AUTO_RAW_KEY_SCAN_CACHE, cacheKey);
  if (!cached) return false;
  const processState = await currentWxKeyProcessGeneration({ signal }).catch(error => {
    if (error?.status === 499 || signal?.aborted) throw error;
    return { process_generation: '', process_enumeration_failed: true };
  });
  throwIfAborted(signal);
  const latest = FAILED_AUTO_RAW_KEY_SCAN_CACHE.get(cacheKey);
  if (!latest) return false;
  if (latest !== cached || failedAutoRawKeyScanMatchesProcessGeneration(latest, processState)) return true;
  FAILED_AUTO_RAW_KEY_SCAN_CACHE.delete(cacheKey);
  return false;
}

function failedAutoRawKeyScanMatchesProcessGeneration(cached = {}, processState = {}) {
  if (processState?.process_enumeration_failed === true) return true;
  const currentGeneration = String(processState?.process_generation || '').trim();
  if (!currentGeneration) return true;
  const cachedGeneration = String(cached?.memory_process_generation || '').trim();
  return !!cachedGeneration && cachedGeneration === currentGeneration;
}

function pruneFailedAutoRawKeyScanCache(now = Date.now()) {
  for (const [key, item] of FAILED_AUTO_RAW_KEY_SCAN_CACHE.entries()) {
    if (now - Number(item?.at || 0) > FAILED_AUTO_RAW_KEY_SCAN_CACHE_MS) {
      FAILED_AUTO_RAW_KEY_SCAN_CACHE.delete(key);
    }
  }
}

async function dbKeyAccountSignature(accountId = '', signal = null) {
  return (await dbKeyAccountContext(accountId, signal)).signature;
}

function persistentVerifiedKeyCacheAccountId(accountContext = {}, requestedAccountId = '') {
  return String(accountContext?.account_id || requestedAccountId || '').trim();
}

async function dbKeyAccountContext(accountId = '', signal = null) {
  throwIfAborted(signal);
  const env = await detectWeixin({ signal });
  throwIfAborted(signal);
  const discoveredAccount = pickAccount(env.accounts || [], accountId);
  const canonicalAccountId = String(discoveredAccount?.account_id || discoveredAccount?.id || accountId || '').trim();
  const authoritativeMirrorAccount = await readWxDbMirrorAccount(canonicalAccountId, { signal });
  throwIfAborted(signal);
  const account = authoritativeMirrorAccount || discoveredAccount;
  if (!account) return { signature: normalizeAccountIdForCache(accountId), last_write_time: '', stale_days: 0 };
  const statusAccount = discoveredAccount || account;
  const lastWriteTime = accountStaleLastWriteTime(statusAccount);
  const selectedTime = safeAccountTimeMs(lastWriteTime);
  const staleDays = accountStaleDays(lastWriteTime);
  const suggested = suggestedFreshAccount(env.accounts || [], statusAccount);
  const identityVerified = accountIdentityVerified(account);
  const identityAnchorPresent = hasWxDbMirrorIdentityAnchor(account);
  const keyCandidateRevalidationAllowed = dbKeyAccountCandidateRevalidationAllowed(account, identityVerified);
  const keyCandidateReuseAllowed = identityVerified || keyCandidateRevalidationAllowed;
  return {
    account_id: account.account_id || account.id || account.wxid || accountId,
    aliases: accountAliases(account),
    account_fingerprint: manualKeyAccountFingerprint(account),
    identity_verified: identityVerified,
    key_candidate_reuse_allowed: keyCandidateReuseAllowed,
    key_candidate_revalidation_required: keyCandidateRevalidationAllowed,
    key_candidate_identity_anchor_present: identityAnchorPresent,
    key_candidate_identity_recovery_required: keyCandidateRevalidationAllowed && !identityAnchorPresent,
    signature: dbKeyAccountRuntimeSignature(account),
    last_write_time: lastWriteTime,
    stale_days: staleDays,
    selected_account_label: accountLabel(statusAccount),
    newer_account_available: !!(suggested && staleDays >= STALE_ACCOUNT_WARN_DAYS && Number.isFinite(selectedTime)),
    suggested_account_id: suggested ? (suggested.account_id || suggested.id || suggested.wxid || '') : '',
    suggested_account_label: suggested ? accountLabel(suggested) : '',
    suggested_account_last_write_time: suggested ? accountStaleLastWriteTime(suggested) : '',
  };
}

function dbKeyAccountCandidateBindingComplete(account = {}) {
  const accountId = String(account.account_id || account.id || account.wxid || '').trim();
  const sourceDbStorage = accountPathSignature(account.source_db_storage || account.mirror?.source_db_storage || '');
  return !!accountId && !!sourceDbStorage && !!accountMirrorRelativeRoot(account);
}

function dbKeyAccountCandidateRevalidationAllowed(account = {}, identityVerified = accountIdentityVerified(account)) {
  // These keys are candidates only. Both group and message reads prove the
  // current account from digest-scope message data before returning anything.
  return !identityVerified && dbKeyAccountCandidateBindingComplete(account);
}

function dbKeyAccountRuntimeSignature(account = {}) {
  // This is the stable account/source binding. A mirror generation change only
  // makes cached keys candidates again; it is not a different account identity.
  return [
    account.account_id || account.id || account.wxid || '',
    account.identity_id || account.mirror?.identity_id || '',
    account.legacy_id || account.id || '',
    account.wxid || '',
    account.source || '',
    accountPathSignature(account.source_db_storage || account.mirror?.source_db_storage || ''),
    accountPathSignature(account.source_account_root || account.mirror?.source_account_root || ''),
    accountMirrorRelativeRoot(account),
  ].map(value => String(value || '').trim()).join('|');
}

function platformPathIdentity(value = '') {
  const text = String(value || '').trim();
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

function accountPathSignature(value = '') {
  const text = String(value || '').trim();
  return text ? platformPathIdentity(path.resolve(text)) : '';
}

function accountMirrorRelativeRoot(account = {}) {
  return String(account?.mirror?.relative_root || account?.mirror_relative_root || '').trim();
}

function accountAliases(account = {}) {
  return [...new Set([
    account.account_id,
    account.id,
    account.legacy_id,
    account.wxid,
    account.account,
    ...(Array.isArray(account.account_aliases) ? account.account_aliases : []),
  ].map(value => String(value || '').trim()).filter(Boolean))];
}

function suggestedFreshAccount(accounts = [], selected = {}) {
  const selectedTime = safeAccountTimeMs(accountStaleLastWriteTime(selected));
  if (!Number.isFinite(selectedTime)) return null;
  const selectedIds = new Set([
    selected.account_id,
    selected.id,
    selected.legacy_id,
    selected.wxid,
    ...(Array.isArray(selected.account_aliases) ? selected.account_aliases : []),
  ].map(value => String(value || '').trim()).filter(Boolean));
  const candidates = (Array.isArray(accounts) ? accounts : [])
    .filter(account => ![
      account.account_id,
      account.id,
      account.legacy_id,
      account.wxid,
      ...(Array.isArray(account.account_aliases) ? account.account_aliases : []),
    ].map(value => String(value || '').trim()).some(value => value && selectedIds.has(value)))
    .map(account => ({
      account,
      time: safeAccountTimeMs(accountStaleLastWriteTime(account)),
    }))
    .filter(item => Number.isFinite(item.time) && item.time - selectedTime >= NEWER_ACCOUNT_DELTA_MS)
    .sort((a, b) => b.time - a.time || accountLabel(a.account).localeCompare(accountLabel(b.account)));
  return candidates[0]?.account || null;
}

function accountLabel(account = {}) {
  return String(account.display_name || account.name || account.wxid || account.id || account.account_id || '微信账号').trim();
}

function normalizeAccountIdForCache(accountId = '') {
  return String(accountId || '').trim() || '__default__';
}

function accountStaleDays(lastWriteTime = '') {
  const time = safeAccountTimeMs(lastWriteTime);
  if (!Number.isFinite(time) || time <= 0) return 0;
  return Math.max(0, Math.floor((Date.now() - time) / 86400000));
}

function safeAccountTimeMs(value = '') {
  const text = String(value || '').trim();
  if (!text) return NaN;
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z)?$/i);
  if (!match) return NaN;
  const [, y, mo, d, h, mi, rawSeconds, rawMs, z] = match;
  const s = rawSeconds ?? '0';
  const ms = rawMs ? Number(rawMs.padEnd(3, '0').slice(0, 3)) : 0;
  const date = z
    ? new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms))
    : new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms);
  const valid = z
    ? date.getUTCFullYear() === Number(y)
      && date.getUTCMonth() === Number(mo) - 1
      && date.getUTCDate() === Number(d)
      && date.getUTCHours() === Number(h)
      && date.getUTCMinutes() === Number(mi)
      && date.getUTCSeconds() === Number(s)
      && date.getUTCMilliseconds() === ms
    : date.getFullYear() === Number(y)
      && date.getMonth() === Number(mo) - 1
      && date.getDate() === Number(d)
      && date.getHours() === Number(h)
      && date.getMinutes() === Number(mi)
      && date.getSeconds() === Number(s)
      && date.getMilliseconds() === ms;
  return valid ? date.getTime() : NaN;
}

function digestSourceSnapshot({ account = {}, mirror = {}, group_id = '', since = '', until = '', since_ms = undefined, until_ms = undefined } = {}) {
  const accountMirror = account?.mirror && typeof account.mirror === 'object' ? account.mirror : {};
  const scope = String(mirror?.scope || '').trim();
  const sourceHash = String(mirror?.source_snapshot_meta_hash || accountMirror.source_snapshot_meta_hash || '').trim();
  return {
    source: 'wxdb_project_mirror',
    scope,
    account_id: String(account.account_id || account.id || account.wxid || '').trim(),
    group_id: String(group_id || '').trim(),
    since: String(since || '').trim(),
    until: String(until || '').trim(),
    since_ms: Number.isSafeInteger(Number(since_ms)) ? Number(since_ms) : null,
    until_ms: Number.isSafeInteger(Number(until_ms)) ? Number(until_ms) : null,
    snapshot_ref: sourceHash ? `meta-sha256:${sourceHash.slice(0, 16)}` : '',
    mirror_root: String(mirror?.mirror_relative_root || accountMirror.relative_root || '').trim(),
    source_last_write_time: String(mirror?.source_last_write_time || accountSourceLastWriteTime(account)).trim(),
    mirror_last_write_time: String(mirror?.mirror_last_write_time || accountMirrorLastWriteTime(account)).trim(),
    mirror_refreshed_at: String(mirror?.refreshed_at || accountMirror.refreshed_at || accountMirror.imported_at || '').trim(),
    captured_at: String(mirror?.captured_at || mirror?.refreshed_at || accountMirror.refreshed_at || accountMirror.imported_at || '').trim(),
    stale: mirror?.stale === true,
    source_busy: mirror?.source_busy === true,
    offline: mirror?.offline === true,
    source_access: String(mirror?.source_access || '').trim(),
    mirror_refresh_reason: String(mirror?.refresh_reason || accountMirror.refresh_reason || '').trim(),
    mirror_refresh_action: String(mirror?.refresh_action || accountMirror.refresh_action || '').trim(),
    db_count: Math.max(0, Number(mirror?.db_count || accountMirror.db_count || account.summary?.db_count || 0) || 0),
    bytes: Math.max(0, Number(mirror?.bytes || accountMirror.bytes || account.summary?.bytes || 0) || 0),
  };
}

function accountSourceLastWriteTime(account = {}) {
  return String(account.source_last_write_time || account.mirror?.source_last_write_time || '').trim();
}

function accountMirrorLastWriteTime(account = {}) {
  return String(account.mirror_last_write_time || account.mirror?.mirror_last_write_time || '').trim();
}

function accountDisplayLastWriteTime(account = {}) {
  return String(
    accountSourceLastWriteTime(account)
      || account.last_write_time
      || account.summary?.last_write_time
      || accountMirrorLastWriteTime(account),
  ).trim();
}

function accountStaleLastWriteTime(account = {}) {
  const sourceTime = accountSourceLastWriteTime(account);
  if (sourceTime) return sourceTime;
  if (account.source === 'project-mirror') return '';
  return String(account.last_write_time || account.summary?.last_write_time || '').trim();
}

function isPersistableManualKey(key) {
  return /^(?:[a-f0-9]{64}|[a-f0-9]{96}|[a-f0-9]{128}|[a-f0-9]{160}|[a-f0-9]{192})$/.test(String(key || '').trim().toLowerCase());
}

function uniqueStrings(items) {
  return [...new Set(items.map(item => String(item || '').trim()).filter(Boolean))];
}

function cryptoHashStrings(items = []) {
  const text = uniqueStrings(Array.isArray(items) ? items : []).join('\n');
  if (!text) return '';
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export const __collectorInternals = {
  accountListProjection,
  attachLegacyManualKeyBinding,
  applyFilters,
  automaticKeyScanIncomplete,
  clearDbKeyRuntimeCache,
  clearDbKeyRuntimeCacheForAccount,
  composeDbRawKeyCandidates,
  dbKeyRuntimeCacheState,
  dbKeyAccountCandidateBindingComplete,
  dbKeyAccountCandidateRevalidationAllowed,
  dbRawKeyCandidateBundle,
  dbRawKeyCandidates,
  emptyCollectionMirrorRecheckSummary,
  emptyCollectionMirrorRecheckRecentlyVerified,
  failedAutoRawKeyScanMatchesProcessGeneration,
  isDbKeyFailure,
  isPersistableManualKey,
  isWxdbShardOpenFailure,
  legacyManualKeysForPolicy,
  messageCollectionTargetLastMessageEvidence,
  shardOpenFailureCause,
  shardOpenKeyDiagnostics,
  legacyManualKeyVerifiedByResult,
  manualKeyTextMatchesVerifiedRawKeys,
  manualKeyPageKeyCandidates,
  memoryKeyScanAvailability,
  messageSearchText,
  mirrorReadinessCoversRequiredScope,
  mirrorReadinessMatchesAccount,
  mirrorReadinessMatchesExpected,
  notifyVerifiedKeyCachePersistence,
  normalizeSearchText,
  parseMessageDateTime,
  persistentVerifiedKeyCacheAccountId,
  rememberEmptyCollectionMirrorRecheck,
  resultAccountMatchesExpected,
  rethrowIfAborted,
  safeAccountTimeMs,
  getBoundedMapEntry,
  setBoundedMapEntry,
  shouldRecheckMirrorForEmptyCollection,
  throwIfAborted,
  validateMessageTimeRange,
  verifiedAccountFromResult,
  rememberVerifiedAutoRawKeysForBinding,
  verifiedKeyAccountBindingFromAccounts,
  verifiedResultAccountFingerprint,
};
