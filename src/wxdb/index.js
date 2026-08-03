import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR, PROJECT_ROOT, WXDB_TMP_DIR, assertAvailableDiskSpace, assertSafeTmpPath, isDiskSpaceError, isInside } from '../lib/paths.js';
import { ensureDir, renameAtomicWithRetry } from '../lib/json-store.js';
import { logInfo, logWarn } from '../lib/logger.js';
import { atomicProcessLockOwnerIsComplete, publishAtomicProcessLock, reclaimAtomicProcessLockFile, releaseAtomicProcessLockFile } from '../lib/atomic-process-lock.js';
import { MAX_MESSAGE_SHARD_CURSOR_POSITIONS, isMessageShardCursorKey, normalizeMessageShardCursorPosition } from '../lib/message-shard-cursor.js';
import { discoverWxAccounts, ensureWxDbMirror, getWeixinModuleEvidence, getWeixinProcesses, isWxDbMirrorIdentityVerified, listDbFiles, pickAccount, processOwnerState, processStartIdentity, recordWxDbMirrorAccountIdentity, withWxDbMirrorReadLock, wxDbMirrorScopeRecordsForRead } from '../wxenv/discovery.js';
import { allocateSharedProcessScanMs, orderWeixinProcessesForKeyScan, probeWxKey, scanProcessForCodecContextKeyCandidates, scanProcessForVerifiedWeixinV4DbKeys, shouldPrioritizeWeixinProcessScan, STANDARD_WEIXIN_KEY_SCAN_MAX_MS } from '../wxkey/index.js';
import { extractPlainImage, validateImageKeyCandidate, weChatV4ValidationSample } from './image-dat.js';
import { decodeWxgfToImage, extractVideoFrameToImage, transcodeAudioToWav } from './wxgf.js';
import { ACCOUNT_IDENTITY_MAX_MESSAGE_SHARDS, accountIdentityMessageShardCandidates } from './identity-scope.js';

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'ascii');
let SqlCipherDatabase = null;
let sqlcipherLoggerSet = false;
let imageKeyCache = { at: 0, sampleHash: '', keys: [] };
const weixinV4PlaintextCacheRefs = new Map();
const weixinV4PlaintextCacheLeaseHeartbeats = new Map();
const weixinV4WorkerSessionPlaintextLeases = new Map();
const WEIXIN_V4_PLAINTEXT_CACHE_PROCESS_TOKEN = /^[a-f0-9]{16}$/i.test(String(process.env.WX_SUMMARY_WXDB_WORKER_TOKEN || ''))
  ? String(process.env.WX_SUMMARY_WXDB_WORKER_TOKEN).toLowerCase()
  : crypto.randomBytes(8).toString('hex');
const WXDB_PERSISTENT_WORKER_SESSION = process.env.WX_SUMMARY_WXDB_PERSISTENT_WORKER === '1';
let wxDbPersistentWorkerSessionClosing = false;
const accountIdentityEvidenceCache = new Map();
const ACCOUNT_IDENTITY_EVIDENCE_CACHE_LIMIT = 16;
const IMAGE_KEY_CACHE_MS = 10 * 60 * 1000;
const LOCAL_IMAGE_INDEX_MAX_ENTRIES = 50000;
const LOCAL_IMAGE_INDEX_MAX_MS = 5000;
const LOCAL_VOICE_INDEX_MAX_ENTRIES = 20000;
const LOCAL_VOICE_INDEX_MAX_MS = 3000;
const SORT_SEQ_PACKED_MS_FACTORS = [65_536, 1_048_576, 4_194_304];
const SORT_SEQ_PACKED_SECOND_FACTORS = [4_294_967_296];
const PLAUSIBLE_WX_TIMESTAMP_MIN_MS = Date.UTC(2000, 0, 1);
const PLAUSIBLE_WX_TIMESTAMP_FUTURE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const IMAGE_KEY_SCAN_MAX_MS = 12000;
const IMAGE_KEY_WIDE_SCAN_MAX_MS = 15000;
const MEDIA_ENRICHMENT_MAX_MS = 45000;
const MEDIA_DECODE_MAX_ITEMS_PER_KIND = 16;
const MESSAGE_ZSTD_MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MESSAGE_ZSTD_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGE_ROWS_PER_DIGEST = 20_000;
const MAX_MESSAGE_SHARDS_WITH_CURSOR = MAX_MESSAGE_SHARD_CURSOR_POSITIONS;
const MAX_MESSAGE_RAW_PAYLOAD_BYTES_PER_ROW = 2 * 1024 * 1024;
const MAX_MESSAGE_RAW_PAYLOAD_BYTES_PER_SHARD = 32 * 1024 * 1024;
const MAX_MESSAGE_NORMALIZED_PAYLOAD_BYTES_PER_DIGEST = 32 * 1024 * 1024;
const ACCOUNT_IDENTITY_MAX_DIRECT_PEERS = 5_000;
const ACCOUNT_IDENTITY_MAX_MATCHED_PEER_TABLES = 256;
const ACCOUNT_IDENTITY_MAX_CANDIDATES_PER_PEER = 32;
const ACCOUNT_IDENTITY_SHARD_CACHE_VERSION = 'wxdb-identity-shard-evidence-v2';
const ACCOUNT_IDENTITY_MAX_SHARD_CACHE_ASSOCIATIONS = ACCOUNT_IDENTITY_MAX_MATCHED_PEER_TABLES * ACCOUNT_IDENTITY_MAX_CANDIDATES_PER_PEER;
const ACCOUNT_IDENTITY_INCOMING_SHARD_CACHE_LIMIT = 24;
const MEDIA_COPY_STABLE_ATTEMPTS = 2;
const VOICE_FILE_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.webm', '.flac', '.amr', '.silk', '.aud', '.dat'];
const PINYIN_ANCHORS = Array.from('阿八嚓哒妸发旮哈讥咔垃妈拿噢啪期然撒塌挖昔压匝');
const PINYIN_INITIALS = Array.from('ABCDEFGHJKLMNOPQRSTWXYZ');
const SQLCIPHER_DEFAULT_PROFILE_MAX_KEYS = 32;
const SQLCIPHER_PROFILE_FALLBACK_PRIORITY_MAX_KEYS = 8;
const SQLCIPHER_VALIDATION_MAX_ATTEMPTS = 96;
const SQLCIPHER_VALIDATION_MAX_MS = 15 * 1000;
const DB_COPY_ROOT = path.join(WXDB_TMP_DIR, 'db');
const DB_COPY_ROOT_RELATIVE = 'outputs/.tmp/db';
const DB_PLAINTEXT_CACHE_ROOT = path.join(DB_COPY_ROOT, 'plain-cache');
const SQLITE_PERSISTED_SIDECAR_SUFFIXES = ['-wal', '-journal'];
const SQLITE_PERSISTED_COPY_SUFFIXES = ['', ...SQLITE_PERSISTED_SIDECAR_SUFFIXES];
const SQLITE_ROLLBACK_JOURNAL_MAGIC = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);
const SQLITE_ROLLBACK_JOURNAL_MIN_HOT_BYTES = 512;
const DB_PLAINTEXT_CACHE_VERSION = 'weixin-v4-plain-cache-v1';
const DB_PLAINTEXT_CACHE_TTL_MS = 60 * 60 * 1000;
const DB_PLAINTEXT_CACHE_PRUNE_INTERVAL_MS = 10 * 60 * 1000;
const DB_PLAINTEXT_CACHE_MAX_ENTRIES = 12;
const DB_PLAINTEXT_CACHE_MAX_BYTES = 3 * 1024 * 1024 * 1024;
const DB_PLAINTEXT_CACHE_LOCK_WAIT_MS = 5 * 60 * 1000;
const DB_PLAINTEXT_CACHE_HEARTBEAT_MS = 1_000;
const DB_PLAINTEXT_CACHE_STALE_GRACE_MS = 10_000;
const DB_PLAINTEXT_CACHE_LEASE_HARD_MAX_MS = 6 * 60 * 60 * 1000;
const PROJECT_MIRROR_CONTENT_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const SENDER_HYDRATION_FAILURE_CACHE_MS = 2 * 60 * 1000;
const SENDER_HYDRATION_FAILURE_CACHE_LIMIT = 32;
const senderHydrationFailureCache = new Map();
const verifiedProjectMirrorManifestByAccount = new WeakMap();
const MEDIA_COPY_ROOT = path.join(WXDB_TMP_DIR, 'media');
const MEDIA_COPY_ROOT_RELATIVE = 'outputs/.tmp/media';
const WXDB_MIRROR_ROOT = path.join(DATA_DIR, 'wxdb-mirror');
const WXDB_MIRROR_ROOT_RELATIVE = 'data/wxdb-mirror';
const WEIXIN_V4_PAGE_SIZE = 4096;
const WEIXIN_V4_KEY_BYTES = 32;
const WEIXIN_V4_SALT_BYTES = 16;
const WEIXIN_V4_IV_BYTES = 16;
const WEIXIN_V4_HMAC_BYTES = 64;
const WEIXIN_V4_RESERVED_BYTES = 80;
const WEIXIN_V4_KDF_ITER = 256000;
const WEIXIN_V4_PASSPHRASE_DERIVE_CANDIDATE_LIMIT = 96;
const WEIXIN_V4_STANDARD_SCAN_MAX_MS = STANDARD_WEIXIN_KEY_SCAN_MAX_MS;
const WEIXIN_V4_STANDARD_SCAN_MAX_MS_HARD_LIMIT = STANDARD_WEIXIN_KEY_SCAN_MAX_MS;
const WEIXIN_V4_DECRYPT_PROGRESS_BYTES = 4 * 1024 * 1024;
const WEIXIN_V4_DECRYPT_CHUNK_BYTES = WEIXIN_V4_DECRYPT_PROGRESS_BYTES;
const WEIXIN_V4_ZERO_PAGE = Buffer.alloc(WEIXIN_V4_PAGE_SIZE);
const KEY_VALIDATION_YIELD_EVERY = 16;
const WEIXIN_V4_PAGE_HMAC_YIELD_EVERY = 64;
const WEIXIN_V4_PASSPHRASE_YIELD_EVERY = 1;
const WEIXIN_V4_MANUAL_PROFILE = { id: 'weixin_v4_page_hmac_sha512' };
const pbkdf2Async = promisify(crypto.pbkdf2);
const execFileAsync = promisify(execFile);
let plaintextCacheSecurityPromise = null;
const SQLCIPHER_KEY_PROFILES = [
  { id: 'default', before_key: [], after_key: [] },
  { id: 'compat3', before_key: ['cipher_compatibility = 3'], after_key: [] },
  { id: 'compat4', before_key: ['cipher_compatibility = 4'], after_key: [] },
  {
    id: 'wcdb_legacy_sha1_page4096',
    before_key: [],
    after_key: [
      'cipher_page_size = 4096',
      'kdf_iter = 64000',
      'cipher_hmac_algorithm = HMAC_SHA1',
      'cipher_kdf_algorithm = PBKDF2_HMAC_SHA1',
    ],
  },
  {
    id: 'sqlcipher4_sha512_page4096',
    before_key: [],
    after_key: [
      'cipher_page_size = 4096',
      'kdf_iter = 256000',
      'cipher_hmac_algorithm = HMAC_SHA512',
      'cipher_kdf_algorithm = PBKDF2_HMAC_SHA512',
    ],
  },
  {
    id: 'wcdb_sha256_page4096',
    fallback_key_priority: 512,
    before_key: [],
    after_key: [
      'cipher_page_size = 4096',
      'kdf_iter = 64000',
      'cipher_hmac_algorithm = HMAC_SHA256',
      'cipher_kdf_algorithm = PBKDF2_HMAC_SHA256',
    ],
  },
  {
    id: 'sqlcipher4_sha256_page4096',
    fallback_key_priority: 512,
    before_key: [],
    after_key: [
      'cipher_page_size = 4096',
      'kdf_iter = 256000',
      'cipher_hmac_algorithm = HMAC_SHA256',
      'cipher_kdf_algorithm = PBKDF2_HMAC_SHA256',
    ],
  },
  {
    id: 'wcdb_legacy_sha1_no_hmac_page4096',
    fallback_key_priority: 512,
    before_key: [],
    after_key: [
      'cipher_page_size = 4096',
      'kdf_iter = 64000',
      'cipher_use_hmac = OFF',
      'cipher_hmac_algorithm = HMAC_SHA1',
      'cipher_kdf_algorithm = PBKDF2_HMAC_SHA1',
    ],
  },
  {
    id: 'wcdb_sha256_no_hmac_page4096',
    fallback_key_priority: 256,
    before_key: [],
    after_key: [
      'cipher_page_size = 4096',
      'kdf_iter = 64000',
      'cipher_use_hmac = OFF',
      'cipher_hmac_algorithm = HMAC_SHA256',
      'cipher_kdf_algorithm = PBKDF2_HMAC_SHA256',
    ],
  },
  {
    id: 'sqlcipher3_sha1_page1024',
    before_key: [],
    after_key: [
      'cipher_page_size = 1024',
      'kdf_iter = 64000',
      'cipher_hmac_algorithm = HMAC_SHA1',
      'cipher_kdf_algorithm = PBKDF2_HMAC_SHA1',
    ],
  },
];

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

function normalizeMirrorReadinessScope(scope = '') {
  const text = String(scope || '').trim().toLowerCase();
  if (text === 'full') return 'full';
  if (['digest', 'message', 'messages'].includes(text)) return 'digest';
  if (['identity', 'account_identity'].includes(text)) return 'identity';
  if (['groups', 'group', 'contact', 'contacts', 'chatrooms', 'chatroom'].includes(text)) return 'groups';
  return '';
}

function mirrorReadinessCovers(requiredScope = '', readyScope = '') {
  const required = normalizeMirrorReadinessScope(requiredScope) || 'full';
  const ready = normalizeMirrorReadinessScope(readyScope);
  if (!ready) return false;
  if (required === 'groups') return ready === 'groups' || ready === 'identity' || ready === 'digest' || ready === 'full';
  if (required === 'identity') return ready === 'identity' || ready === 'digest' || ready === 'full';
  if (required === 'digest') return ready === 'digest' || ready === 'full';
  return ready === 'full';
}

function mirrorReadinessTokenForInput(input = {}) {
  const token = input?.mirror_readiness || input?.mirrorReadiness || null;
  return token && typeof token === 'object' && !Array.isArray(token) ? token : null;
}

function accountMirrorScopeHash(account = {}, scope = '') {
  const wanted = normalizeMirrorReadinessScope(scope) || 'full';
  const mirror = account?.mirror || {};
  if (wanted === 'full') return String(mirror.source_snapshot_meta_hash || mirror.source_scopes?.full?.source_snapshot_meta_hash || '').trim();
  return String(mirror.source_scopes?.[wanted]?.source_snapshot_meta_hash || '').trim();
}

function accountMirrorPublishedManifestHash(account = {}) {
  return String(account?.mirror?.published_manifest_hash || '').trim().toLowerCase();
}

function accountMirrorScopeMetadata(account = {}, scope = '') {
  const wanted = normalizeMirrorReadinessScope(scope) || 'full';
  const mirror = account?.mirror || {};
  const scoped = wxDbMirrorScopeRecordsForRead(mirror, wanted)
    .find(candidate => candidate?.record?.source_snapshot_meta_hash)?.record || {};
  const sourceSnapshot = scoped.source_snapshot && typeof scoped.source_snapshot === 'object' && !Array.isArray(scoped.source_snapshot)
    ? scoped.source_snapshot
    : {};
  const sourceHash = String(scoped.source_snapshot_meta_hash || (wanted === 'full' ? mirror.source_snapshot_meta_hash : '') || '').trim();
  return compactObject({
    scope: wanted,
    label: String(scoped.label || '').trim(),
    source_snapshot_meta_hash: sourceHash,
    identity_generation_status: String(account.identity_generation_status || mirror.identity_generation_status || '').trim(),
    mirror_relative_root: String(mirror.relative_root || '').trim(),
    source_last_write_time: String(mirror.source_last_write_time || '').trim(),
    mirror_last_write_time: String(mirror.mirror_last_write_time || '').trim(),
    refreshed_at: String(scoped.refreshed_at || mirror.refreshed_at || mirror.imported_at || '').trim(),
    refresh_reason: String(scoped.refresh_reason || mirror.refresh_reason || '').trim(),
    refresh_reason_label: String(scoped.refresh_reason_label || mirror.refresh_reason_label || '').trim(),
    refresh_action: String(scoped.refresh_action || mirror.refresh_action || '').trim(),
    db_count: Math.max(0, Number(sourceSnapshot.db_count || 0) || 0),
    bytes: Math.max(0, Number(sourceSnapshot.bytes || 0) || 0),
    eligible_message_count: Math.max(0, Number(sourceSnapshot.eligible_message_count || 0) || 0),
    selected_message_count: Math.max(0, Number(sourceSnapshot.selected_message_count || 0) || 0),
    selection_limit: Math.max(0, Number(sourceSnapshot.selection_limit || 0) || 0),
    selection_strategy: String(sourceSnapshot.selection_strategy || '').trim(),
  });
}

function normalizeProjectMirrorRelative(value = '') {
  const parts = String(value || '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length || parts.some(part => part === '.' || part === '..' || part.includes('\0'))) return '';
  return parts.join('/');
}

function projectMirrorScopeSnapshot(account = {}, scope = '') {
  const wanted = normalizeMirrorReadinessScope(scope) || 'full';
  const record = wxDbMirrorScopeRecordsForRead(account?.mirror || {}, wanted)
    .find(candidate => candidate?.record?.source_snapshot)?.record;
  const snapshot = record?.source_snapshot;
  return snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : null;
}

function projectMirrorManifestMap(account = {}, scope = '') {
  const snapshot = projectMirrorScopeSnapshot(account, scope);
  if (!snapshot || String(snapshot.target_content_hash_alg || '').trim().toLowerCase() !== 'sha256') return null;
  const files = Array.isArray(snapshot.files) ? snapshot.files : [];
  const out = new Map();
  for (const file of files) {
    const relative = normalizeProjectMirrorRelative(file?.relative || '');
    const sha256 = String(file?.sha256 || '').trim().toLowerCase();
    const kind = String(file?.kind || '').trim().toLowerCase();
    if (!relative || !['db', 'sidecar'].includes(kind) || !/^[a-f0-9]{64}$/.test(sha256) || out.has(relative)) return null;
    out.set(relative, {
      relative,
      kind,
      bytes: Math.max(0, Number(file?.bytes || 0) || 0),
      mtimeMs: Number(file?.mtimeMs || 0) || 0,
      ctimeMs: Number(file?.ctimeMs || 0) || 0,
      birthtimeMs: Number(file?.birthtimeMs || 0) || 0,
      dev: Number(file?.dev || 0) || 0,
      ino: Number(file?.ino || 0) || 0,
      target_ctimeMs: Number(file?.target_ctimeMs || 0) || 0,
      target_birthtimeMs: Number(file?.target_birthtimeMs || 0) || 0,
      target_dev: Number(file?.target_dev || 0) || 0,
      target_ino: Number(file?.target_ino || 0) || 0,
      sha256,
    });
  }
  Object.defineProperties(out, {
    target_content_verified_at: {
      value: String(snapshot.target_content_verified_at || '').trim(),
    },
    target_identity_current: {
      value: false,
      writable: true,
    },
  });
  return out.size ? out : null;
}

function projectMirrorDbFilesFromManifest(account = {}, manifest = null, category = '') {
  if (!(manifest instanceof Map) || !manifest.size) return [];
  const root = path.resolve(String(account?.db_storage || ''));
  if (!root) return [];
  const wantedCategory = String(category || '').trim().toLowerCase();
  const files = [];
  for (const item of manifest.values()) {
    if (item?.kind !== 'db') continue;
    const relative = normalizeProjectMirrorRelative(item.relative);
    const parts = relative.split('/');
    if (parts.length !== 2 || !parts[1].toLowerCase().endsWith('.db')) continue;
    const fileCategory = parts[0];
    if (wantedCategory && fileCategory.toLowerCase() !== wantedCategory) continue;
    const filePath = path.resolve(root, ...parts);
    if (!isInside(root, filePath)) continue;
    const sidecars = SQLITE_PERSISTED_SIDECAR_SUFFIXES.flatMap(suffix => {
      const sidecar = manifest.get(`${relative}${suffix}`);
      if (!sidecar || sidecar.kind !== 'sidecar') return [];
      return [{
        name: `${parts[1]}${suffix}`,
        path: `${filePath}${suffix}`,
        suffix,
        bytes: Math.max(0, Number(sidecar.bytes || 0) || 0),
        mtime_ms: Number(sidecar.mtimeMs || 0) || 0,
        last_write_time: new Date(Number(sidecar.mtimeMs || 0) || 0).toISOString(),
      }];
    });
    const dbMtimeMs = Number(item.mtimeMs || 0) || 0;
    const effectiveMtimeMs = Math.max(dbMtimeMs, ...sidecars.map(sidecar => sidecar.mtime_ms));
    files.push({
      path: filePath,
      category: fileCategory,
      name: parts[1],
      bytes: Math.max(0, Number(item.bytes || 0) || 0),
      birthtimeMs: Number(item.birthtimeMs || 0) || 0,
      dev: Number(item.dev || 0) || 0,
      ino: Number(item.ino || 0) || 0,
      sha256: String(item.sha256 || '').trim().toLowerCase(),
      last_write_time: new Date(effectiveMtimeMs).toISOString(),
      db_last_write_time: new Date(dbMtimeMs).toISOString(),
      sidecars,
    });
  }
  return files.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

async function listProjectMirrorDbFilesForRead(account = {}, category = '', { signal = null } = {}) {
  throwIfAborted(signal);
  const manifest = verifiedProjectMirrorManifestByAccount.get(account);
  if (manifest instanceof Map && manifest.size) return projectMirrorDbFilesFromManifest(account, manifest, category);
  return listDbFiles(account, category, { signal });
}

function normalizeWeixinV4ScanPages(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const page = Buffer.isBuffer(value) ? value : (Buffer.isBuffer(value?.page) ? value.page : null);
    if (!page || page.length < WEIXIN_V4_PAGE_SIZE) continue;
    const firstPage = page.subarray(0, WEIXIN_V4_PAGE_SIZE);
    const salt = firstPage.subarray(0, WEIXIN_V4_SALT_BYTES).toString('hex');
    if (!/^[a-f0-9]{32}$/.test(salt) || seen.has(salt)) continue;
    seen.add(salt);
    out.push({
      page: firstPage,
      salt,
      name: String(value?.name || '').trim(),
    });
  }
  return out;
}

function weixinV4ScanPageCoverage(values = [], rawKeys = [], verifiedSalts = []) {
  const pages = normalizeWeixinV4ScanPages(values);
  const verified = new Set((verifiedSalts || [])
    .map(value => String(value || '').trim().toLowerCase())
    .filter(value => /^[a-f0-9]{32}$/.test(value)));
  const matchedSalts = [];
  for (const item of pages) {
    const matched = verified.has(item.salt) || weixinV4KeyCandidates(rawKeys, item.salt)
      .some(raw => validateWeixinV4PageHmac(item.page, raw, 1));
    if (matched) matchedSalts.push(item.salt);
  }
  return {
    requested_salt_count: pages.length,
    matched_salt_count: matchedSalts.length,
    matched_salts: matchedSalts,
  };
}

async function readProjectMirrorMessageFirstPagesForKeyScan(account = {}, dbFiles = [], {
  signal = null,
  required_scope = 'digest',
  onProgress = null,
  allow_stale_account = false,
} = {}) {
  const files = (Array.isArray(dbFiles) ? dbFiles : [])
    .filter(file => file?.category === 'message' && /^message_\d+\.db$/i.test(String(file?.name || '')));
  if (!files.length) return [];
  const scope = String(required_scope || 'digest').trim() || 'digest';
  return withWxDbMirrorReadLock(wxDbMirrorLockIdForAccount(account), async () => {
    throwIfAborted(signal);
    await assertProjectMirrorAccount(account, { signal, allowStaleSource: allow_stale_account === true });
    await assertProjectMirrorPublishedManifest(account, scope, { signal, onProgress });
    const pages = [];
    for (const file of files) {
      throwIfAborted(signal);
      const source = path.resolve(String(file.path || ''));
      const { stat } = await assertDbCopySource(account, source, { signal });
      if (!stat.isFile() || Number(stat.size || 0) < WEIXIN_V4_PAGE_SIZE) {
        throw dbTempCopyError('wxdb_mirror_first_page_incomplete', '项目内微信消息工作副本的数据库第一页不足，已停止密钥验证并自动重新检查工作副本。', {
          source,
          category: 'message',
          cause: 'first_page_too_small',
        });
      }
      const handle = await fsp.open(source, 'r');
      try {
        const page = Buffer.alloc(WEIXIN_V4_PAGE_SIZE);
        const read = await handle.read(page, 0, page.length, 0);
        if (read.bytesRead < WEIXIN_V4_PAGE_SIZE) {
          throw dbTempCopyError('wxdb_mirror_first_page_incomplete', '项目内微信消息工作副本的数据库第一页读取不完整，已停止密钥验证并自动重新检查工作副本。', {
            source,
            category: 'message',
            cause: 'first_page_short_read',
          });
        }
        pages.push({ page, name: String(file.name || '').trim() });
      } finally {
        await handle.close();
      }
    }
    await assertProjectMirrorPublishedManifest(account, scope, { signal, onProgress });
    return normalizeWeixinV4ScanPages(pages);
  }, { signal });
}

function projectMirrorTargetIdentityRecorded(item = {}) {
  return Number(item.target_ctimeMs || 0) > 0
    && Number(item.target_dev || 0) > 0
    && Number(item.target_ino || 0) > 0;
}

function projectMirrorTargetIdentityMatches(stat = {}, item = {}) {
  if (!projectMirrorTargetIdentityRecorded(item)) return false;
  const expectedMtime = Number(item.mtimeMs || 0);
  const expectedBirthtime = Number(item.target_birthtimeMs || 0);
  return (!expectedMtime || Math.abs(Number(stat.mtimeMs || 0) - expectedMtime) <= 2)
    && Math.abs(Number(stat.ctimeMs || 0) - Number(item.target_ctimeMs || 0)) <= 2
    && (!expectedBirthtime || Math.abs(Number(stat.birthtimeMs || 0) - expectedBirthtime) <= 2)
    && Number(stat.dev || 0) === Number(item.target_dev || 0)
    && Number(stat.ino || 0) === Number(item.target_ino || 0);
}

function projectMirrorCopyCanTrustPublishedHash(sourceStat = {}, manifestItem = {}) {
  // Metadata detects copy races, but only the copied bytes prove content identity.
  return false;
}

function projectMirrorContentVerificationFresh(manifest = null, nowMs = Date.now()) {
  const verifiedAt = Date.parse(String(manifest?.target_content_verified_at || ''));
  if (!Number.isFinite(verifiedAt) || verifiedAt <= 0) return false;
  return Math.max(0, Number(nowMs || 0) - verifiedAt) <= PROJECT_MIRROR_CONTENT_VERIFY_TTL_MS;
}

function projectMirrorScopeIncludesDbFile(account = {}, scope = '', dbFile = {}) {
  const manifest = projectMirrorManifestMap(account, scope);
  if (!manifest) return false;
  const category = String(dbFile?.category || '').trim();
  const name = String(dbFile?.name || '').trim();
  const relative = normalizeProjectMirrorRelative(category && name ? `${category}/${name}` : '');
  return !!(relative && manifest.get(relative)?.kind === 'db');
}

function wxdbMirrorManifestChangedError(onProgress = null, detail = '') {
  notifyProgress(onProgress, {
    phase: 'mirror_manifest_mismatch',
    label: '检查本地数据 · 工作副本不完整',
    detail: '项目工作副本与已发布批次清单不一致；已停止读取，避免漏掉消息分片',
  });
  const err = new Error('项目内微信工作副本的文件集合或内容已变化，无法确认消息分片完整性；程序将自动重建工作副本后重试。');
  err.status = 409;
  err.code = 'wxdb_mirror_manifest_changed';
  err.public_code = err.code;
  err.detail = String(detail || '').trim();
  return err;
}

function wxdbMirrorManifestRepairFailedError(error = null) {
  const err = new Error('项目内微信工作副本的文件集合或内容已变化；程序已自动强制重建一次，但重新校验仍不一致。已停止本次读取，请检查项目数据目录是否被其他程序修改后重试。');
  err.status = 409;
  err.code = 'wxdb_mirror_manifest_changed';
  err.public_code = err.code;
  err.detail = String(error?.detail || '').trim();
  err.mirror_repair_attempted = true;
  err.cause = error || undefined;
  return err;
}

function mirrorReadRecoveryAction(error = null, attempt = 0) {
  const code = String(error?.code || error?.public_code || '').trim();
  if (code !== 'wxdb_mirror_manifest_changed') return 'propagate';
  return Number(attempt || 0) > 0 ? 'fail_repair' : 'rebuild';
}

async function assertProjectMirrorPublishedManifest(account = {}, scope = '', { signal = null, onProgress = null } = {}) {
  throwIfAborted(signal);
  const manifest = projectMirrorManifestMap(account, scope);
  if (!manifest) throw wxdbMirrorManifestChangedError(onProgress, 'manifest_missing_or_invalid');
  const root = path.resolve(String(account?.db_storage || ''));
  const expectedNamesByCategory = new Map();
  let targetIdentityCurrent = true;
  for (const item of manifest.values()) {
    throwIfAborted(signal);
    const target = path.resolve(root, ...item.relative.split('/'));
    if (!isInside(root, target)) throw wxdbMirrorManifestChangedError(onProgress, 'manifest_path_outside_root');
    const stat = await fsp.lstat(target).catch(() => null);
    if (!stat?.isFile?.() || stat.isSymbolicLink?.() || Number(stat.size || 0) !== item.bytes) {
      throw wxdbMirrorManifestChangedError(onProgress, 'manifest_file_missing_or_replaced');
    }
    if (!projectMirrorTargetIdentityRecorded(item)) {
      targetIdentityCurrent = false;
    } else if (!projectMirrorTargetIdentityMatches(stat, item)) {
      throw wxdbMirrorManifestChangedError(onProgress, 'manifest_file_identity_changed');
    }
    const [category, ...rest] = item.relative.split('/');
    if (!category || rest.length !== 1) throw wxdbMirrorManifestChangedError(onProgress, 'manifest_layout_invalid');
    if (!expectedNamesByCategory.has(category)) expectedNamesByCategory.set(category, new Set());
    expectedNamesByCategory.get(category).add(rest[0]);
  }
  for (const [category, expectedNames] of expectedNamesByCategory) {
    throwIfAborted(signal);
    const categoryDir = path.resolve(root, category);
    if (!isInside(root, categoryDir)) throw wxdbMirrorManifestChangedError(onProgress, 'manifest_category_outside_root');
    const entries = await fsp.readdir(categoryDir, { withFileTypes: true }).catch(() => null);
    if (!entries) throw wxdbMirrorManifestChangedError(onProgress, 'manifest_category_missing');
    for (const entry of entries) {
      const lower = entry.name.toLowerCase();
      if (!lower.endsWith('.db') && !lower.endsWith('.db-wal') && !lower.endsWith('.db-journal')) continue;
      if (!entry.isFile() || entry.isSymbolicLink() || !expectedNames.has(entry.name)) {
        throw wxdbMirrorManifestChangedError(onProgress, 'manifest_file_set_changed');
      }
    }
  }
  manifest.target_identity_current = targetIdentityCurrent;
  verifiedProjectMirrorManifestByAccount.set(account, manifest);
  return manifest;
}

function projectMirrorSourceUnavailable(account = {}) {
  return account?.source === 'project-mirror'
    && String(account?.mirror?.source_status || (account?.mirror?.source_available === true ? 'available' : 'missing')).trim() !== 'available';
}

async function assertProjectMirrorContentHashes(account = {}, scope = '', { signal = null, onProgress = null } = {}) {
  throwIfAborted(signal);
  const manifest = verifiedProjectMirrorManifestByAccount.get(account) || projectMirrorManifestMap(account, scope);
  if (!(manifest instanceof Map) || !manifest.size) throw wxdbMirrorManifestChangedError(onProgress, 'offline_manifest_missing');
  if (manifest.target_identity_current === true && projectMirrorContentVerificationFresh(manifest)) {
    notifyProgress(onProgress, {
      phase: 'mirror_offline_verify_cached',
      label: '检查本地数据 · 离线工作副本可用',
      detail: `已核对 ${manifest.size} 个项目副本文件的集合、大小、修改时间和文件身份；近期完整内容校验仍有效`,
      file_count: manifest.size,
    });
    return true;
  }
  const root = path.resolve(String(account?.db_storage || ''));
  let index = 0;
  for (const item of manifest.values()) {
    throwIfAborted(signal);
    index += 1;
    const target = path.resolve(root, ...item.relative.split('/'));
    if (!isInside(root, target)) throw wxdbMirrorManifestChangedError(onProgress, 'offline_manifest_path_outside_root');
    const stat = await fsp.lstat(target).catch(() => null);
    if (!stat?.isFile?.() || stat.isSymbolicLink?.() || Number(stat.size || 0) !== item.bytes) {
      throw wxdbMirrorManifestChangedError(onProgress, 'offline_manifest_file_changed');
    }
    const digest = await sha256FileContents(target, { signal });
    if (digest !== item.sha256) throw wxdbMirrorManifestChangedError(onProgress, 'offline_manifest_hash_changed');
    if (index === 1 || index === manifest.size) {
      notifyProgress(onProgress, {
        phase: 'mirror_offline_verify_hash_progress',
        label: '检查本地数据 · 校验离线工作副本',
        detail: `${index}/${manifest.size} 个文件已校验`,
      });
    }
  }
  return true;
}

function accountMatchesMirrorSourceSnapshotToken(account = {}, token = null, requiredScope = '') {
  if (!token || typeof token !== 'object' || Array.isArray(token)) return false;
  const tokenAccountId = String(token.account_id || '').trim();
  if (!tokenAccountId || !accountMatchesMirrorReadinessAccount(account, tokenAccountId)) return false;
  const tokenScope = normalizeMirrorReadinessScope(token.scope || token.mirror_scope || '');
  if (!mirrorReadinessCovers(requiredScope, tokenScope)) return false;
  const manifestScope = normalizeMirrorReadinessScope(token.manifest_scope || tokenScope);
  if (!mirrorReadinessCovers(tokenScope, manifestScope)) return false;
  const tokenHash = String(token.source_snapshot_meta_hash || '').trim();
  if (!tokenHash) return false;
  const accountHash = accountMirrorScopeHash(account, manifestScope);
  return !!accountHash && tokenHash === accountHash;
}

function accountMatchesMirrorReadinessToken(account = {}, token = null, requiredScope = '') {
  if (!accountMatchesMirrorSourceSnapshotToken(account, token, requiredScope)) return false;
  const tokenManifestHash = String(token.published_manifest_hash || '').trim().toLowerCase();
  const accountManifestHash = accountMirrorPublishedManifestHash(account);
  return /^[a-f0-9]{64}$/.test(tokenManifestHash)
    && tokenManifestHash === accountManifestHash;
}

function accountMirrorHasScope(account = {}, requiredScope = '') {
  const required = normalizeMirrorReadinessScope(requiredScope) || 'full';
  if (required === 'groups') {
    return !!(accountMirrorScopeHash(account, 'groups') || accountMirrorScopeHash(account, 'identity') || accountMirrorScopeHash(account, 'digest') || accountMirrorScopeHash(account, 'full'));
  }
  if (required === 'identity') {
    return !!(accountMirrorScopeHash(account, 'identity') || accountMirrorScopeHash(account, 'digest') || accountMirrorScopeHash(account, 'full'));
  }
  if (required === 'digest') {
    return !!(accountMirrorScopeHash(account, 'digest') || accountMirrorScopeHash(account, 'full'));
  }
  return !!accountMirrorScopeHash(account, 'full');
}

function accountMatchesMirrorReadinessAccount(account = {}, accountId = '') {
  const wanted = String(accountId || '').trim();
  if (!wanted) return false;
  return [
    account.account_id,
    account.id,
    account.legacy_id,
    account.wxid,
    ...(Array.isArray(account.account_aliases) ? account.account_aliases : []),
  ].some(value => String(value || '').trim() === wanted);
}

function yieldToEventLoopForKeyValidation() {
  return new Promise(resolve => setImmediate(resolve));
}

async function maybeYieldKeyValidation(attempts, signal, every = KEY_VALIDATION_YIELD_EVERY) {
  const n = Number(attempts || 0);
  const interval = Number(every || 0);
  if (n <= 0 || interval <= 0 || n % interval !== 0) return;
  await yieldToEventLoopForKeyValidation();
  throwIfAborted(signal);
}

async function yieldDecryptProgress(signal) {
  await yieldToEventLoopForKeyValidation();
  throwIfAborted(signal);
}

function isWxdbAbort(error, signal = null) {
  return !!signal?.aborted
    || error?.status === 499
    || error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR';
}

function notifyProgress(onProgress, data) {
  if (typeof onProgress !== 'function') return;
  try { onProgress(data); } catch {}
}

function throwIfMirrorReadGenerationChanged(error) {
  const codes = [error?.public_code, error?.code].map(value => String(value || '').trim());
  if (codes.some(code => code === 'wxdb_mirror_manifest_changed' || code === 'wxdb_mirror_readiness_changed')) {
    throw error;
  }
}

function mediaEnrichmentFailureReason(error, fallbackReason = '媒体解析失败') {
  const base = String(fallbackReason || '媒体解析失败').replace(/\s+/g, ' ').trim() || '媒体解析失败';
  const code = String(error?.code || '').trim().toUpperCase();
  const text = String(error?.message || error || '').replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  let detail = '';
  if (['ENOENT', 'ENOTDIR'].includes(code) || /no such file|file not found|cannot find|not found|找不到|不存在|未找到/.test(lower)) {
    detail = '本地媒体文件不存在或尚未同步';
  } else if (code === 'MEDIA_TEMP_COPY_UNSTABLE' || /复制前后.*不一致|仍在变化|changed during media copy/i.test(text)) {
    detail = '本地媒体文件复制时仍在变化，请稍后重试';
  } else if (['EACCES', 'EPERM', 'EBUSY', 'MEDIA_SOURCE_UNREADABLE'].includes(code) || /permission|access denied|unauthorized|busy|拒绝访问|权限|占用|正在使用/.test(lower)) {
    detail = '本地媒体文件暂时不可读';
  } else if (/timeout|timed out|超时/.test(lower)) {
    detail = '媒体解析超时';
  } else if (/key|decrypt|cipher|hmac|解密|密钥/.test(lower)) {
    detail = '媒体解密未命中可用密钥';
  } else if (/ffmpeg|decode|decoder|invalid data|hevc|video|audio|transcod|wxgf|voipengine|image|format|解码|转码/.test(lower)) {
    detail = '媒体解码失败';
  } else if (/copy|outside|越界|项目.*副本|临时副本/.test(lower)) {
    detail = '媒体文件未能准备为临时读取数据';
  }
  return detail && detail !== base ? `${base}：${detail}` : base;
}

function markMediaEnrichmentFailure(msg, error, fallbackReason = '媒体解析失败') {
  if (!msg?.media) return;
  if (msg.media.payload_omitted_reason) return;
  msg.media.payload_omitted_reason = mediaEnrichmentFailureReason(error, fallbackReason).slice(0, 160);
}

function markMediaPayloadMissing(msg, reason) {
  if (!msg?.media || msg.media.payload_omitted_reason) return;
  msg.media.payload_omitted_reason = String(reason || '媒体内容未能转换为可发送给 AI 的格式').slice(0, 160);
}

export async function probeWxDb(input = '') {
  const accountId = typeof input === 'string' ? input : (input?.account_id || '');
  const rawKeys = typeof input === 'object' && Array.isArray(input.raw_keys) ? input.raw_keys : [];
  const standardScan = typeof input === 'object' && input.standard_scan === true;
  const standardScanAllProcesses = typeof input === 'object' && input.standard_scan_all_processes === true;
  const standardScanIncludeMapped = typeof input === 'object' && input.standard_scan_include_mapped === true;
  const standardScanCodecContext = !(typeof input === 'object' && input.standard_scan_codec_context === false);
  const standardScanIncludeBareHex = !(typeof input === 'object' && input.standard_scan_include_bare_hex === false);
  const standardScanDerivePassphrase = typeof input === 'object' && input.standard_scan_derive_passphrase === true;
  const standardScanRecovery = !(typeof input === 'object' && input.standard_scan_recovery === false);
  const standardScanMaxMs = standardScan
    ? normalizeWeixinV4KeyScanMaxMs(typeof input === 'object' ? input.standard_scan_max_ms : 0)
    : 0;
  const stopAfterMessageSample = typeof input === 'object' && input.stop_after_message_sample === true;
  const deepScan = typeof input === 'object' && input.deep_scan === true;
  const mirrorReason = typeof input === 'object' ? String(input.mirror_reason || input.reason || 'wxdb_refresh').trim() : 'wxdb_refresh';
  const probeScope = typeof input === 'object' ? String(input.probe_scope || input.scope || 'digest').trim() : 'digest';
  const groupsOnlyProbe = probeScope === 'groups';
  const identityProbe = probeScope === 'identity';
  const digestProbe = ['digest', 'message', 'messages'].includes(probeScope);
  const requiredMirrorScope = groupsOnlyProbe ? 'groups' : (identityProbe ? 'identity' : (digestProbe ? 'digest' : 'full'));
  const mirrorReadiness = typeof input === 'object' ? mirrorReadinessTokenForInput(input) : null;
  const allowStaleSource = typeof input === 'object' && input.allow_stale_account === true;
  const signal = typeof input === 'object' ? (input.signal || null) : null;
  throwIfAborted(signal);
  const onProgress = typeof input === 'object' ? (input.onProgress || null) : null;
  const runProbe = async account => {

  const files = await listProjectMirrorDbFilesForRead(account, '', { signal });
  const scopedFiles = files.filter(file => projectMirrorScopeIncludesDbFile(account, requiredMirrorScope, file));
  throwIfAborted(signal);
  const session = scopedFiles.find(f => f.category === 'session' && f.name === 'session.db');
  const messageFiles = scopedFiles.filter(f => f.category === 'message' && /^message_\d+\.db$/i.test(f.name));
  const message = messageFiles[0];
  const contact = scopedFiles.find(f => f.category === 'contact' && f.name === 'contact.db');
  const standardScanMessagePages = standardScan && !groupsOnlyProbe
    ? await readProjectMirrorMessageFirstPagesForKeyScan(account, messageFiles, {
        signal,
        required_scope: requiredMirrorScope,
        onProgress,
        allow_stale_account: allowStaleSource,
      })
    : [];
  const messageProbeFiles = stopAfterMessageSample ? [message] : messageFiles;
  const probeFiles = probeDbFiles(groupsOnlyProbe
    ? [contact, session]
    : (standardScan
      ? [...messageProbeFiles, contact, session, scopedFiles[0]]
      : [contact, session, ...messageProbeFiles, scopedFiles[0]]), {
    limit: stopAfterMessageSample ? 3 : Infinity,
  }, { signal });
  const moduleEvidence = deepScan
    ? await getWeixinModuleEvidence({ signal }).catch(e => {
      if (e?.status === 499 || e?.name === 'AbortError' || signal?.aborted) throw e;
      return null;
    })
    : null;
  let copy = null;
  const dbChecks = [];
  const sharedStandardScanCandidates = [];
  let standardScanStartedAt = 0;
  let standardScanAttemptCount = 0;
  for (const [sampleIndex, sample] of probeFiles.entries()) {
    throwIfAborted(signal);
    let validation = null;
    let standardScanResult = null;
    let deepScanResult = null;
    const sampleLabel = `${sample.category || '数据库'} ${sample.name || '样本'}`;
    notifyProgress(onProgress, {
      phase: 'fetch_key_probe_sample_start',
      label: '拉取消息 · 准备数据库样本',
      detail: `${sampleLabel}：检查样本 ${sampleIndex + 1}/${probeFiles.length}，正在复制到临时读取数据`,
    });
    copy = await copyDbFile(account, sample, { signal, allow_stale_account: allowStaleSource });
    notifyProgress(onProgress, {
      phase: 'fetch_key_probe_sample_copied',
      label: '拉取消息 · 数据库样本已准备',
      detail: `${sampleLabel}：临时读取数据已复制并完成基础检查，开始验证访问候选`,
    });
    try {
      let dbSalt = '';
      const getDbSalt = async () => {
        if (!dbSalt) dbSalt = (await readHeader(copy.target_path, { signal })).toString('hex');
        return dbSalt;
      };
      const existingCandidates = uniqueStrings([...rawKeys, ...sharedStandardScanCandidates]);
      if (existingCandidates.length) {
        notifyProgress(onProgress, {
          phase: 'fetch_key_probe_candidate_validate',
          label: '拉取消息 · 验证已有访问候选',
          detail: `${sampleLabel}：先用已保存或本次扫描候选做完整性校验`,
        });
        validation = standardScan
          ? await validateCopiedDbPageHmacOnly(copy.target_path, existingCandidates, { signal })
          : await validateCopiedDbWithRawKeys(copy.target_path, existingCandidates, { signal });
      }
      throwIfAborted(signal);
      if (standardScan && standardScanRecovery && !validation?.ok) {
        if (!standardScanStartedAt) standardScanStartedAt = Date.now();
        const standardScanRemainingMs = Math.max(0, standardScanMaxMs - (Date.now() - standardScanStartedAt));
        if (standardScanRemainingMs < 1_000) {
          standardScanResult = {
            source_category: sample.category,
            source_name: sample.name,
            scan_all_processes: !!standardScanAllProcesses,
            verified_weixin_v4_hmac: true,
            scan_reused: sharedStandardScanCandidates.length > 0,
            reused_candidate_count: sharedStandardScanCandidates.length,
            scan_skipped_reason: 'shared_probe_budget_exhausted',
            unique_candidate_count: 0,
            timed_out: true,
            scan_incomplete: true,
            scan_timeout_ms: standardScanMaxMs,
            scan_timeout_scope: 'shared_probe_samples',
            scan_attempt_count: standardScanAttemptCount,
          };
          notifyProgress(onProgress, {
            phase: 'fetch_key_probe_standard_scan_budget_done',
            label: '拉取消息 · 自动扫描已到时间上限',
            detail: `${sampleLabel}：本次数据库样本共用 ${Math.max(1, Math.ceil(standardScanMaxMs / 1000))} 秒扫描预算；已复用 ${sharedStandardScanCandidates.length} 条候选，不再重复扫描微信进程`,
          });
        } else {
          notifyProgress(onProgress, {
            phase: 'fetch_key_probe_standard_scan',
            label: '拉取消息 · 扫描本地访问候选',
            detail: `${sampleLabel}：已有候选未打开样本，开始只读检查微信进程中的候选；所有样本共用 ${Math.max(1, Math.ceil(standardScanRemainingMs / 1000))} 秒剩余预算`,
          });
          await getDbSalt();
          standardScanAttemptCount += 1;
          const verifiedScan = await scanVerifiedWeixinV4KeysForCopiedDb(copy.target_path, {
            signal,
            db_pages: sample.category === 'message' ? standardScanMessagePages : [],
            scan_all_processes: standardScanAllProcesses,
            include_mapped: standardScanIncludeMapped,
            codec_context_scan: standardScanCodecContext,
            max_bytes: standardScanAllProcesses ? 1024 * 1024 * 1024 : 512 * 1024 * 1024,
            max_region_bytes: standardScanAllProcesses ? 512 * 1024 * 1024 : 64 * 1024 * 1024,
            max_ms: standardScanRemainingMs,
            include_bare_hex: standardScanIncludeBareHex,
            derive_passphrase_keys: standardScanDerivePassphrase,
            max_passphrase_derive_candidates: WEIXIN_V4_PASSPHRASE_DERIVE_CANDIDATE_LIMIT,
            onProgress,
            source_name: sample.name,
          });
          throwIfAborted(signal);
          standardScanResult = {
          source_category: sample.category,
          source_name: sample.name,
          scan_all_processes: !!standardScanAllProcesses,
          verified_weixin_v4_hmac: true,
          process_enumeration_failed: verifiedScan.process_enumeration_failed === true,
          process_enumeration_error: verifiedScan.process_enumeration_error || '',
          scan_unavailable: verifiedScan.scan_unavailable === true,
          scan_unavailable_reason: verifiedScan.scan_unavailable_reason || '',
          scan_unavailable_error: verifiedScan.scan_unavailable_error || '',
          matched_salt_count: Number(verifiedScan.matched_salt_count || 0),
          requested_salt_count: Number(verifiedScan.requested_salt_count || 0),
          unique_candidate_count: Number(verifiedScan.raw_keys?.length || verifiedScan.unique_candidate_count || 0),
          hex_pattern_count: Number(verifiedScan.hex_pattern_count || 0),
          v4_pointer_pattern_hit_count: Number(verifiedScan.v4_pointer_pattern_hit_count || 0),
          v4_pointer_pattern_candidate_count: Number(verifiedScan.v4_pointer_pattern_candidate_count || 0),
          v4_pointer_verified_candidate_count: Number(verifiedScan.v4_pointer_verified_candidate_count || 0),
          pointer_passphrase_derive_attempts: Number(verifiedScan.pointer_passphrase_derive_attempts || 0),
          pointer_passphrase_derived_match_count: Number(verifiedScan.pointer_passphrase_derived_match_count || 0),
          passphrase_derive_attempts: Number(verifiedScan.passphrase_derive_attempts || 0),
          passphrase_derived_match_count: Number(verifiedScan.passphrase_derived_match_count || 0),
          scanned_bytes: Number(verifiedScan.scanned_bytes || 0),
          region_count: Number(verifiedScan.region_count || 0),
          scan_process_count: Number(verifiedScan.scan_process_count || 0),
          scan_process_attempt_count: Number(verifiedScan.scan_process_attempt_count || 0),
          scan_processes: Array.isArray(verifiedScan.scan_processes) ? verifiedScan.scan_processes : [],
          codec_context_attempted: verifiedScan.codec_context_attempted === true,
          codec_context_scan_process_count: Number(verifiedScan.codec_context_scan_process_count || 0),
          codec_context_salt_match_count: Number(verifiedScan.codec_context_salt_match_count || 0),
          codec_context_unique_candidate_count: Number(verifiedScan.codec_context_unique_candidate_count || 0),
          codec_context_pass_candidate_count: Number(verifiedScan.codec_context_pass_candidate_count || 0),
          codec_context_key_pointer_candidate_count: Number(verifiedScan.codec_context_key_pointer_candidate_count || 0),
          codec_context_page_key_match_count: Number(verifiedScan.codec_context_page_key_match_count || 0),
          codec_context_scanned_bytes: Number(verifiedScan.codec_context_scanned_bytes || 0),
          codec_context_region_count: Number(verifiedScan.codec_context_region_count || 0),
          codec_context_scan_processes: Array.isArray(verifiedScan.codec_context_scan_processes) ? verifiedScan.codec_context_scan_processes : [],
          timed_out: verifiedScan.timed_out === true,
          scan_incomplete: verifiedScan.scan_incomplete === true,
          scan_timeout_ms: standardScanMaxMs,
          scan_attempt_timeout_ms: Number(verifiedScan.scan_timeout_ms || standardScanRemainingMs || 0) || 0,
          scan_timeout_scope: 'shared_probe_samples',
          scan_attempt_count: standardScanAttemptCount,
          };
          notifyProgress(onProgress, {
            phase: 'fetch_key_probe_recheck',
            label: '拉取消息 · 复核扫描候选',
            detail: `${sampleLabel}：扫描完成，找到 ${verifiedScan.raw_keys?.length || 0} 条候选，正在用样本完整性校验复核`,
          });
          if (verifiedScan.raw_keys?.length) {
            for (const raw of verifiedScan.raw_keys) prioritizeRawKeyCandidate(sharedStandardScanCandidates, raw);
            validation = await validateCopiedDbPageHmacOnly(copy.target_path, uniqueStrings([...rawKeys, ...sharedStandardScanCandidates]), { signal });
          }
        }
      }
      throwIfAborted(signal);
      if (deepScan && !validation?.ok) {
        const dbSalt = await getDbSalt();
        const moduleAnchors = moduleStringAddressTargets(moduleEvidence, sample);
        const saltProbe = await probeWxKey({
          scan_all_processes: true,
          scan_db_salts: [dbSalt],
          scan_memory_anchors: dbMemoryAnchors(account, sample),
          scan_anchor_addresses: moduleAnchors.targets,
          scan_codec_salts: [dbSalt],
          include_db_raw: true,
          include_anchor_raw: true,
          include_anchor_address_raw: true,
          include_codec_raw: true,
          db_scan_max_bytes: 1024 * 1024 * 1024,
          db_scan_max_region_bytes: 96 * 1024 * 1024,
          db_scan_max_candidates: 16384,
          db_reverse_pointer_scan: true,
          db_reverse_pointer_max_bytes: 512 * 1024 * 1024,
          db_reverse_pointer_max_hits: 1024,
          anchor_scan_max_bytes: 1024 * 1024 * 1024,
          anchor_scan_max_region_bytes: 96 * 1024 * 1024,
          anchor_scan_max_candidates: 16384,
          anchor_direct_max_candidates: 512,
          anchor_follow_local_pointers: false,
          anchor_reverse_pointer_scan: true,
          anchor_reverse_pointer_max_bytes: 512 * 1024 * 1024,
          anchor_reverse_pointer_max_hits: 1024,
          anchor_address_scan_max_bytes: 512 * 1024 * 1024,
          anchor_address_scan_max_candidates: 16384,
          anchor_address_reverse_pointer_max_hits: 1024,
          anchor_address_target_range_bytes: moduleAnchors.function_target_count > 0 ? 256 : 96,
          anchor_address_reverse_pointer_direct_max_distance: 64,
          anchor_address_reverse_pointer_layout_sample: true,
          anchor_address_reverse_pointer_high_entropy_targets: true,
          anchor_address_second_hop_reverse_pointers: moduleAnchors.function_target_count > 0,
          codec_scan_max_bytes: 1024 * 1024 * 1024,
          codec_scan_max_region_bytes: 96 * 1024 * 1024,
          codec_scan_max_candidates: 4096,
          signal,
        });
        throwIfAborted(signal);
        const saltCandidates = Array.isArray(saltProbe._raw_db_salt_candidates) ? saltProbe._raw_db_salt_candidates : [];
        const anchorCandidates = Array.isArray(saltProbe._raw_anchor_candidates) ? saltProbe._raw_anchor_candidates : [];
        const anchorAddressCandidates = Array.isArray(saltProbe._raw_anchor_address_candidates) ? saltProbe._raw_anchor_address_candidates : [];
        const codecCandidates = Array.isArray(saltProbe._raw_codec_candidates) ? saltProbe._raw_codec_candidates : [];
        deepScanResult = {
          source_category: sample.category,
          source_name: sample.name,
          salt_hit_count: Number(saltProbe.db_salt_hit_count || 0),
          unique_candidate_count: Number(saltProbe.db_salt_unique_candidate_count || 0),
          scanned_bytes: Number(saltProbe.db_salt_scanned_bytes || 0),
          region_count: Number(saltProbe.db_salt_region_count || 0),
          reverse_pointer_hit_count: Number(saltProbe.db_salt_reverse_pointer_hit_count || 0),
          reverse_pointer_scanned_bytes: Number(saltProbe.db_salt_reverse_pointer_scanned_bytes || 0),
          scan_mode: saltProbe.db_salt_scan_mode || null,
          scan_processes: Array.isArray(saltProbe.db_salt_scan_processes) ? saltProbe.db_salt_scan_processes : [],
          anchor_hit_count: Number(saltProbe.anchor_hit_count || 0),
          anchor_unique_candidate_count: Number(saltProbe.anchor_unique_candidate_count || 0),
          anchor_direct_candidate_count: Number(saltProbe.anchor_scan_processes?.reduce?.((sum, p) => sum + Number(p.anchor_direct_candidate_count || 0), 0) || 0),
          anchor_reference_address_count: Number(saltProbe.anchor_scan_processes?.reduce?.((sum, p) => sum + Number(p.anchor_reference_address_count || 0), 0) || 0),
          anchor_scanned_bytes: Number(saltProbe.anchor_scanned_bytes || 0),
          anchor_region_count: Number(saltProbe.anchor_region_count || 0),
          anchor_reverse_pointer_hit_count: Number(saltProbe.anchor_reverse_pointer_hit_count || 0),
          anchor_reverse_pointer_scanned_bytes: Number(saltProbe.anchor_reverse_pointer_scanned_bytes || 0),
          anchor_scan_mode: saltProbe.anchor_scan_mode || null,
          anchor_scan_processes: Array.isArray(saltProbe.anchor_scan_processes) ? saltProbe.anchor_scan_processes : [],
          module_anchor_address_target_count: Number(saltProbe.anchor_address_target_count || 0),
          module_anchor_function_target_count: moduleAnchors.function_target_count || 0,
          module_anchor_address_patterns: moduleAnchors.pattern_counts,
          module_anchor_address_sections: moduleAnchors.section_counts,
          module_anchor_address_modules: moduleAnchors.module_counts,
          module_anchor_address_sources: moduleAnchors.source_counts,
          module_anchor_address_unique_candidate_count: Number(saltProbe.anchor_address_unique_candidate_count || 0),
          module_anchor_address_reverse_pointer_hit_count: Number(saltProbe.anchor_address_reverse_pointer_hit_count || 0),
          module_anchor_address_reverse_pointer_direct_candidate_count: Number(saltProbe.anchor_address_scan_processes?.reduce?.((sum, p) => sum + Number(p.reverse_pointer_direct_candidate_count || 0), 0) || 0),
          module_anchor_address_reverse_pointer_deferred_target_count: Number(saltProbe.anchor_address_scan_processes?.reduce?.((sum, p) => sum + Number(p.reverse_pointer_deferred_target_count || 0), 0) || 0),
          module_anchor_address_reverse_pointer_followed_target_count: Number(saltProbe.anchor_address_scan_processes?.reduce?.((sum, p) => sum + Number(p.reverse_pointer_followed_target_count || 0), 0) || 0),
          module_anchor_address_reverse_pointer_high_entropy_target_read_count: Number(saltProbe.anchor_address_scan_processes?.reduce?.((sum, p) => sum + Number(p.reverse_pointer_high_entropy_target_read_count || 0), 0) || 0),
          module_anchor_address_reverse_pointer_high_entropy_candidate_count: Number(saltProbe.anchor_address_scan_processes?.reduce?.((sum, p) => sum + Number(p.reverse_pointer_high_entropy_candidate_count || 0), 0) || 0),
          module_anchor_address_reverse_pointer_high_entropy_window_candidate_count: Number(saltProbe.anchor_address_scan_processes?.reduce?.((sum, p) => sum + Number(p.reverse_pointer_high_entropy_window_candidate_count || 0), 0) || 0),
          module_anchor_address_reverse_pointer_high_entropy_pointer_table_read_count: Number(saltProbe.anchor_address_scan_processes?.reduce?.((sum, p) => sum + Number(p.reverse_pointer_high_entropy_pointer_table_read_count || 0), 0) || 0),
          module_anchor_address_reverse_pointer_high_entropy_pointer_table_candidate_count: Number(saltProbe.anchor_address_scan_processes?.reduce?.((sum, p) => sum + Number(p.reverse_pointer_high_entropy_pointer_table_candidate_count || 0), 0) || 0),
          module_anchor_address_reverse_pointer_crypto_object_sweep_candidate_count: Number(saltProbe.anchor_address_scan_processes?.reduce?.((sum, p) => sum + Number(p.reverse_pointer_crypto_object_sweep_candidate_count || 0), 0) || 0),
          module_anchor_address_reverse_pointer_second_hop_target_count: Number(saltProbe.anchor_address_scan_processes?.reduce?.((sum, p) => sum + Number(p.reverse_pointer_second_hop_target_count || 0), 0) || 0),
          module_anchor_address_reverse_pointer_second_hop_hit_count: Number(saltProbe.anchor_address_scan_processes?.reduce?.((sum, p) => sum + Number(p.reverse_pointer_second_hop_hit_count || 0), 0) || 0),
          module_anchor_address_reverse_pointer_second_hop_candidate_count: Number(saltProbe.anchor_address_scan_processes?.reduce?.((sum, p) => sum + Number(p.reverse_pointer_second_hop_candidate_count || 0), 0) || 0),
          module_anchor_address_reverse_pointer_layout_summary: summarizeReversePointerLayouts(saltProbe.anchor_address_scan_processes),
          module_anchor_address_scanned_bytes: Number(saltProbe.anchor_address_scanned_bytes || 0),
          module_anchor_address_region_count: Number(saltProbe.anchor_address_region_count || 0),
          module_anchor_address_scan_mode: saltProbe.anchor_address_scan_mode || null,
          module_anchor_address_scan_processes: Array.isArray(saltProbe.anchor_address_scan_processes) ? saltProbe.anchor_address_scan_processes : [],
          codec_context_hit_count: Number(saltProbe.codec_context_hit_count || 0),
          codec_context_salt_match_count: Number(saltProbe.codec_context_salt_match_count || 0),
          codec_context_unique_candidate_count: Number(saltProbe.codec_context_unique_candidate_count || 0),
          codec_context_pass_candidate_count: Number(saltProbe.codec_context_scan_processes?.reduce?.((sum, p) => sum + Number(p.codec_pass_candidate_count || 0), 0) || 0),
          codec_context_key_pointer_candidate_count: Number(saltProbe.codec_context_scan_processes?.reduce?.((sum, p) => sum + Number(p.codec_key_pointer_candidate_count || 0), 0) || 0),
          codec_context_scanned_bytes: Number(saltProbe.codec_context_scanned_bytes || 0),
          codec_context_region_count: Number(saltProbe.codec_context_region_count || 0),
          codec_context_scan_mode: saltProbe.codec_context_scan_mode || null,
          codec_context_scan_processes: Array.isArray(saltProbe.codec_context_scan_processes) ? saltProbe.codec_context_scan_processes : [],
        };
        delete saltProbe._raw_db_salt_candidates;
        delete saltProbe._raw_anchor_candidates;
        delete saltProbe._raw_anchor_address_candidates;
        delete saltProbe._raw_codec_candidates;
        if (saltCandidates.length || anchorCandidates.length || anchorAddressCandidates.length || codecCandidates.length) {
          validation = await validateCopiedDbWithRawKeys(copy.target_path, [...rawKeys, ...saltCandidates, ...anchorCandidates, ...anchorAddressCandidates, ...codecCandidates], { signal });
        }
      }
      if (validation?.__verified_raw_key) prioritizeRawKeyCandidate(rawKeys, validation.__verified_raw_key);
    } finally {
      const copiedPath = copy?.target_path || '';
      if (copiedPath) {
        await removeCopiedDb(copiedPath)
          .then(() => { copy.temp_removed = true; })
          .catch(e => {
            copy.temp_removed = false;
            copy.temp_remove_error = String(e?.message || e).slice(0, 200);
          });
        delete copy.target_path;
      }
    }
    const groupProbeSatisfied = groupsOnlyProbe && validation?.ok;
    const hasNextProbeSample = sampleIndex + 1 < probeFiles.length;
    notifyProgress(onProgress, {
      phase: 'fetch_key_probe_sample_done',
      label: '拉取消息 · 数据库样本检查完成',
      detail: groupProbeSatisfied
        ? `${sampleLabel}：访问验证通过，群列表所需数据库已确认，不再重复检查其他样本`
        : `${sampleLabel}：${validation?.ok ? '访问验证通过' : '本样本未命中可用访问候选'}，${hasNextProbeSample ? '继续检查下一个样本' : '样本检查已完成'}`,
    });
    dbChecks.push({
      source_category: sample.category,
      source_name: sample.name,
      sample_copy: copy,
      decrypted: !!validation?.ok,
      validation,
      standard_scan: standardScanResult,
      deep_scan: deepScanResult,
    });
    if (groupProbeSatisfied || (stopAfterMessageSample
      && standardScan
      && sample.category === 'message'
      && /^message_\d+\.db$/i.test(sample.name || '')
      && validation?.ok)) {
      break;
    }
  }

  const decrypted = dbChecks.some(check => check.decrypted);
  const messageChecks = dbChecks.filter(check => check.source_category === 'message' && /^message_\d+\.db$/i.test(check.source_name || ''));
  const messageSampleDecrypted = messageChecks.some(check => check.decrypted);
  const messageDbTotal = groupsOnlyProbe ? 0 : messageFiles.length;
  const messageDbCheckedCount = messageChecks.length;
  const messageDbVerified = messageDbTotal > 0
    && messageDbCheckedCount >= messageDbTotal
    && messageChecks.every(check => check.decrypted);
  const validationSummary = dbChecks.reduce((out, check) => {
    const validation = check?.validation || {};
    if (validation.error === 'validation_budget_exhausted') out.budget_exhausted_count += 1;
    out.omitted_candidate_count += Math.max(0, Number(validation.profile_fallback_omitted_candidate_count || 0) || 0);
    return out;
  }, { budget_exhausted_count: 0, omitted_candidate_count: 0 });
  const checkedDatabases = dbChecks.map(check => ({
    category: check.source_category,
    name: check.source_name,
    decrypted: !!check.decrypted,
    attempts: Number(check.validation?.attempts || 0) || 0,
    key_profile: check.validation?.key_profile || '',
    validation_error: String(check.validation?.error || '').trim(),
    profile_fallback_bounded: check.validation?.profile_fallback_bounded === true,
    profile_fallback_omitted_candidate_count: Math.max(0, Number(check.validation?.profile_fallback_omitted_candidate_count || 0) || 0),
    table_count: Number(check.validation?.table_count || 0) || 0,
    standard_scan_candidate_count: Number(check.standard_scan?.unique_candidate_count || 0) || 0,
    standard_scan_salt_hit_count: Number(check.standard_scan?.salt_hit_count || check.standard_scan?.matched_salt_count || 0) || 0,
    standard_scan_matched_salt_count: Number(check.standard_scan?.matched_salt_count || check.standard_scan?.salt_hit_count || 0) || 0,
  }));
  const firstCheck = dbChecks[0] || {};
  const redactedAccount = redactAccount(account);
  const validationOk = groupsOnlyProbe ? decrypted : messageSampleDecrypted;
  const result = {
    ok: validationOk,
    request_completed: true,
    validation_ok: validationOk,
    stage: 'copied',
    copy_root_relative: DB_COPY_ROOT_RELATIVE,
    source_access: 'copy_only',
    probe_scope: groupsOnlyProbe ? 'groups' : (identityProbe ? 'identity' : (digestProbe ? 'digest' : 'full')),
    decrypted,
    message_decrypted: messageSampleDecrypted,
    message_sample_verified: messageSampleDecrypted,
    message_db_verified: messageDbVerified,
    message_coverage_verified: messageDbVerified,
    message_db_checked_count: messageDbCheckedCount,
    message_db_total_count: messageDbTotal,
    validation_budget_exhausted_count: validationSummary.budget_exhausted_count,
    validation_omitted_candidate_count: validationSummary.omitted_candidate_count,
    account: redactedAccount,
    db_account_source: redactedAccount.source || '',
    db_mirror: redactedAccount.mirror || null,
    db_count: files.length,
    categories: account.summary?.categories || [],
    sample_copy: firstCheck.sample_copy || null,
    validation: firstCheck.validation || null,
    deep_scan: firstCheck.deep_scan || null,
    checked_databases: checkedDatabases,
    db_checks: dbChecks,
    reason: groupsOnlyProbe
      ? (decrypted
        ? '已用候选密钥成功验证群列表所需的本地工作数据；生成摘要时仍会单独验证消息库。'
        : '已能发现群列表所需本地工作数据；解密仍需有效数据库密钥验证。')
      : messageSampleDecrypted
        ? '已用候选密钥成功验证微信消息库样本；生成摘要时仍会逐个消息分片复核。'
        : decrypted
          ? '候选密钥只能打开群列表等非消息库数据；消息库样本未通过。生成摘要需要当前账号的消息库密钥。'
          : '已能发现微信 v4 数据库，并只用临时读取数据做本地验证；解密仍需有效数据库密钥验证。',
  };
  const verifiedRawKeys = uniqueStrings([
    ...sharedStandardScanCandidates,
    ...dbChecks.map(check => check.validation?.__verified_raw_key).filter(Boolean),
  ]);
  if (verifiedRawKeys.length) {
    Object.defineProperty(result, '__verified_raw_keys', {
      value: verifiedRawKeys,
      enumerable: false,
    });
  }
  return result;
  };
  return withProjectMirrorAccountForRead(accountId, { signal, autoRefresh: true, mirrorReadiness, requiredMirrorScope, reason: groupsOnlyProbe ? 'groups' : (identityProbe ? 'identity' : (digestProbe ? 'digest' : mirrorReason)), onProgress, allowStaleSource }, runProbe);
}

function probeDbFiles(items, { limit = 3 } = {}) {
  const seen = new Set();
  const out = [];
  const maxCount = Number.isFinite(Number(limit)) ? Math.max(0, Math.trunc(Number(limit))) : Infinity;
  if (maxCount <= 0) return out;
  for (const item of items) {
    if (!item?.path) continue;
    const key = item.path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= maxCount) break;
  }
  return out;
}

function dbMemoryAnchors(account, sample) {
  const category = String(sample?.category || '').trim();
  const name = String(sample?.name || path.basename(sample?.path || '')).trim();
  const relative = category && name ? `${category}/${name}` : '';
  const storageRelative = relative ? `db_storage/${relative}` : '';
  // WeChat 4.1.x appears to associate per-db keys with db_storage-relative
  // paths. Keep noisy full account paths out, but include stable relative forms.
  // The wxkey anchor scan caps direct-neighbor candidates so these longer
  // anchors mainly feed reverse-pointer object diagnostics.
  return uniqueStrings([
    name,
    relative,
    relative.replace(/\//g, '\\'),
    storageRelative,
    storageRelative.replace(/\//g, '\\'),
    'session.db',
    'contact.db',
    'hardlink.db',
  ]);
}

function moduleStringAddressTargets(moduleEvidence, sample) {
  const category = String(sample?.category || '').toLowerCase();
  const name = String(sample?.name || path.basename(sample?.path || '')).toLowerCase();
  const wanted = moduleAnchorPatternWeights(category, name);
  const items = [];
  for (const mod of moduleEvidence?.db_related_modules || []) {
    const moduleName = String(mod.name || '').toLowerCase();
    const moduleScore = moduleAnchorModuleWeight(moduleName);
    const addHit = (hit, source) => {
      const address = Number(hit.virtual_address || 0);
      if (!Number.isFinite(address) || address <= 0) return;
      const pattern = String(hit.pattern || '').toLowerCase();
      const patternScore = wanted.get(pattern) || 0;
      if (source === 'crypto' && !patternScore) return;
      if (source !== 'crypto' && !patternScore && moduleScore < 100) return;
      const section = String(hit.section || '').toLowerCase();
      items.push({
        address,
        pattern,
        module: moduleName,
        section,
        source,
        score: moduleScore
          + patternScore
          + moduleAnchorSectionWeight(section)
          + (hit.encoding === 'utf16le' ? 6 : 0)
          + (source === 'crypto' ? 4 : 0),
        rva: Number(hit.rva || 0),
      });
    };
    for (const hit of mod.db_string_address_hits || []) addHit(hit, 'db');
    for (const hit of mod.crypto_string_address_hits || []) addHit(hit, 'crypto');
  }
  items.push(...moduleFunctionAddressTargetItems(moduleEvidence));
  items.sort((a, b) => b.score - a.score || a.rva - b.rva || a.address - b.address);
  const targets = [];
  const seenTargets = new Set();
  const patternCounts = {};
  const sectionCounts = {};
  const moduleCounts = {};
  const sourceCounts = {};
  let functionTargetCount = 0;
  for (const item of items) {
    if (targets.length >= 256) break;
    const key = String(item.address);
    if (seenTargets.has(key)) continue;
    const cap = moduleAnchorPatternCap(item.pattern || 'unknown');
    if ((patternCounts[item.pattern || 'unknown'] || 0) >= cap) continue;
    seenTargets.add(key);
    targets.push({
      address: item.address,
      pattern: item.pattern || 'unknown',
      module: item.module || 'unknown',
      section: item.section || 'unknown',
      source: item.source || 'db',
    });
    incrementCounter(patternCounts, item.pattern || 'unknown');
    incrementCounter(sectionCounts, item.section || 'unknown');
    incrementCounter(moduleCounts, item.module || 'unknown');
    incrementCounter(sourceCounts, item.source || 'db');
    if (item.source === 'function') functionTargetCount++;
  }
  return {
    targets,
    pattern_counts: patternCounts,
    section_counts: sectionCounts,
    module_counts: moduleCounts,
    source_counts: sourceCounts,
    function_target_count: functionTargetCount,
  };
}

function moduleFunctionAddressTargetItems(moduleEvidence) {
  const items = [];
  const seen = new Set();
  for (const mod of moduleEvidence?.db_related_modules || []) {
    const moduleName = String(mod.name || '').toLowerCase();
    const moduleScore = moduleAnchorModuleWeight(moduleName);
    const baseAddress = Number(mod.base_address || 0);
    if (!baseAddress || moduleScore < 100) continue;
    const regions = mod.static_string_xref_summary?.function_summary?.priority_call_graph?.candidate_key_derivation_regions || [];
    for (const region of regions.slice(0, 12)) {
      const regionScore = Math.min(Number(region.priority_score || 0) / 24, 220);
      const paths = region.candidate_bridge_resolved_function_paths || [];
      for (const bridge of paths.slice(0, 6)) {
        const pattern = bridgeFunctionTargetPattern(bridge, region);
        const continuityScore = bridge.is_fully_function_continuous ? 60 : Number(bridge.continuous_function_hop_count || 0) * 20;
        for (const bucket of uniqueStrings([
          ...(bridge.path_function_buckets || []),
          ...(bridge.source_function_buckets || []),
          ...(bridge.target_function_buckets || []),
        ]).slice(0, 12)) {
          const rva = parseHexNumber(bucket);
          if (!rva) continue;
          const key = `${moduleName}:${rva}`;
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({
            address: baseAddress + rva,
            pattern,
            module: moduleName,
            section: '.text',
            source: 'function',
            score: moduleScore + 180 + regionScore + continuityScore + bridgeFunctionPatternScore(bridge),
            rva,
          });
          if (items.length >= 96) return items;
        }
      }
    }
  }
  return items;
}

function bridgeFunctionTargetPattern(bridge, region) {
  const text = [
    ...(bridge?.terminal_patterns || []),
    ...(region?.target_patterns || []),
    ...(bridge?.path_function_xref_summary?.target_patterns || []),
  ].join(' ').toLowerCase();
  if (/sqlcipher|cipher|wcdb|sqlite3_key|pbkdf|kdf/.test(text)) return 'function_bridge_sqlcipher';
  if (/hkdf|hmac|sha256|evp/.test(text)) return 'function_bridge_hmac_sha256';
  if (/aes|sha1/.test(text)) return 'function_bridge_aes_sha1';
  return 'function_bridge_crypto';
}

function bridgeFunctionPatternScore(bridge) {
  let score = 0;
  const xrefSummary = bridge?.path_function_xref_summary || {};
  const text = [...(bridge?.terminal_patterns || []), ...(xrefSummary.target_patterns || [])].join(' ').toLowerCase();
  if (/hkdf|hmac|sha256|evp/.test(text)) score += 80;
  if (/aes|sha1/.test(text)) score += 48;
  if (/sqlcipher|cipher|wcdb|sqlite3_key|pbkdf|kdf/.test(text)) score += 96;
  score += Math.min(Number(bridge?.terminal_region_crypto_xref_count || 0), 64) * 2;
  score += Math.min(Number(bridge?.terminal_function_crypto_xref_count || 0), 32) * 4;
  score += Math.min(Number(xrefSummary.db_xref_count || 0), 32) * 8;
  score += Math.min(Number(xrefSummary.crypto_xref_count || 0), 24) * 6;
  score += Math.min(Number(xrefSummary.sqlcipher_pattern_count || 0), 12) * 24;
  score += Math.min(Number(xrefSummary.crypto_pattern_count || 0), 12) * 12;
  return score;
}

function parseHexNumber(value) {
  const text = String(value || '').trim();
  if (!/^0x[0-9a-f]+$/i.test(text)) return 0;
  const n = Number.parseInt(text.slice(2), 16);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function moduleAnchorPatternWeights(category, name) {
  const weights = new Map([
    ['cipher_compatibility', 96],
    ['cipher_default_kdf_iter', 94],
    ['cipher_page_size', 94],
    ['cipher_hmac_algorithm', 94],
    ['cipher_kdf_algorithm', 94],
    ['cipher_use_hmac', 92],
    ['cipher_default_use_hmac', 92],
    ['cipher_default_page_size', 92],
    ['cipher_default_hmac_algorithm', 92],
    ['cipher_default_compatibility', 92],
    ['cipher_default_plaintext_header_size', 90],
    ['cipher_plaintext_header_size', 90],
    ['cipher_migrate', 82],
    ['cipher_memory_security', 80],
    ['cipher_store_pass', 80],
    ['cipher_version', 80],
    ['cipher_provider', 80],
    ['cipher_salt', 80],
    ['sqlcipher_export', 82],
    ['sqlcipher_codec_ctx', 82],
    ['sqlcipher_activate', 82],
    ['sqlite3_key', 78],
    ['sqlite3_key_v2', 78],
    ['sqlite3_rekey', 78],
    ['sqlite3_rekey_v2', 78],
    ['sqlite_has_codec', 78],
    ['db_key', 76],
    ['codec_ctx', 74],
    ['cipher_ctx', 74],
    ['pragma cipher', 78],
    ['kdf_iter', 76],
    ['key derivation', 74],
    ['pbkdf2_hmac_sha1', 74],
    ['pbkdf2_hmac_sha256', 74],
    ['pbkdf2', 70],
    ['pbkdf', 68],
    ['hmac_sha1', 72],
    ['hmac_sha256', 72],
    ['hmac', 66],
    ['setkey', 70],
    ['derive', 66],
    ['function_bridge_hmac_sha256', 118],
    ['function_bridge_sqlcipher', 116],
    ['function_bridge_aes_sha1', 96],
    ['function_bridge_crypto', 88],
    ['aes-256', 52],
    ['aes', 46],
    ['sha256', 44],
    ['sha1', 40],
    ['wcdb', 44],
    ['sqlcipher', 44],
    ['cipher', 38],
    ['sqlite', 36],
    ['pragma', 32],
    ['db_storage', 28],
    ['xwechat', 20],
  ]);
  if (name) weights.set(name, 120);
  if (category) weights.set(category, Math.max(weights.get(category) || 0, 70));
  if (/^message_\d+\.db$/i.test(name)) weights.set('message_', 110);
  if (name === 'contact.db') weights.set('contact.db', 120);
  if (name === 'session.db') weights.set('session.db', 120);
  weights.set('hardlink.db', Math.max(weights.get('hardlink.db') || 0, 20));
  return weights;
}

function moduleAnchorPatternCap(pattern) {
  switch (String(pattern || '').toLowerCase()) {
    case 'cipher':
      return 20;
    case 'sqlite':
      return 20;
    case 'pragma':
      return 16;
    case 'wcdb':
      return 24;
    case 'sqlcipher':
      return 24;
    case 'xwechat':
      return 16;
    case 'db_storage':
      return 16;
    case 'message_':
      return 24;
    case 'contact.db':
    case 'session.db':
      return 16;
    case 'hardlink.db':
      return 8;
    case 'pragma cipher':
      return 12;
    case 'kdf_iter':
      return 12;
    case 'hmac_sha1':
    case 'hmac_sha256':
    case 'pbkdf2_hmac_sha1':
    case 'pbkdf2_hmac_sha256':
      return 8;
    case 'cipher_compatibility':
    case 'cipher_default_kdf_iter':
    case 'cipher_page_size':
    case 'cipher_hmac_algorithm':
    case 'cipher_kdf_algorithm':
    case 'cipher_use_hmac':
    case 'cipher_default_use_hmac':
    case 'cipher_default_page_size':
    case 'cipher_default_hmac_algorithm':
    case 'cipher_default_compatibility':
    case 'cipher_default_plaintext_header_size':
    case 'cipher_plaintext_header_size':
    case 'cipher_migrate':
    case 'cipher_memory_security':
    case 'cipher_store_pass':
    case 'cipher_version':
    case 'cipher_provider':
    case 'cipher_salt':
    case 'sqlcipher_export':
    case 'sqlcipher_codec_ctx':
    case 'sqlcipher_activate':
    case 'sqlite3_key':
    case 'sqlite3_key_v2':
    case 'sqlite3_rekey':
    case 'sqlite3_rekey_v2':
    case 'sqlite_has_codec':
    case 'db_key':
    case 'codec_ctx':
    case 'cipher_ctx':
    case 'setkey':
      return 12;
    case 'key derivation':
    case 'pbkdf2':
    case 'pbkdf':
    case 'hmac':
    case 'derive':
      return 8;
    case 'function_bridge_hmac_sha256':
    case 'function_bridge_sqlcipher':
    case 'function_bridge_aes_sha1':
    case 'function_bridge_crypto':
      return 64;
    case 'aes-256':
    case 'aes':
    case 'sha256':
    case 'sha1':
      return 6;
    default:
      return 16;
  }
}

function moduleAnchorModuleWeight(moduleName) {
  if (moduleName === 'weixin.dll') return 120;
  if (moduleName.includes('weixin')) return 70;
  if (/wcdb|sqlite|sql|cipher|db/i.test(moduleName)) return 48;
  return 0;
}

function moduleAnchorSectionWeight(section) {
  if (section === '.rdata' || section === 'rdata') return 34;
  if (section === '.data' || section === 'data') return 28;
  if (section === '.mrdata' || section === 'mrdata') return 24;
  if (section.includes('rdata')) return 20;
  if (section.includes('data')) return 16;
  if (section === '.text' || section === 'text') return 4;
  if (section === '.rsrc' || section === 'rsrc') return -20;
  return 0;
}

function summarizeReversePointerLayouts(processes = []) {
  const summaries = (Array.isArray(processes) ? processes : [])
    .map(process => process?.reverse_pointer_layout_summary)
    .filter(Boolean);
  if (!summaries.length) return null;
  const merged = {
    sampled_hit_count: 0,
    pointer_target_reads: 0,
    pointer_field_offsets: {},
    target_pointer_offsets: {},
    zero_field_offsets: {},
    small_uint32_offsets: {},
    length_like_offsets: {},
    pointer_target_kinds: {},
    target_anchor_labels: {},
  };
  const labelLayouts = {};
  let fieldWindowBytes = 0;
  for (const summary of summaries) {
    merged.sampled_hit_count += Number(summary.sampled_hit_count || 0);
    merged.pointer_target_reads += Number(summary.pointer_target_reads || 0);
    fieldWindowBytes = Math.max(fieldWindowBytes, Number(summary.field_window_bytes || 0));
    mergeLayoutCounterList(merged.pointer_field_offsets, summary.pointer_field_offsets);
    mergeLayoutCounterList(merged.target_pointer_offsets, summary.target_pointer_offsets);
    mergeLayoutCounterList(merged.zero_field_offsets, summary.zero_field_offsets);
    mergeLayoutCounterList(merged.small_uint32_offsets, summary.small_uint32_offsets);
    mergeLayoutCounterList(merged.length_like_offsets, summary.length_like_offsets);
    mergeLayoutCounterList(merged.pointer_target_kinds, summary.pointer_target_kinds);
    mergeLayoutCounterList(merged.target_anchor_labels, summary.target_anchor_labels);
    mergeAnchorLabelLayoutList(labelLayouts, summary.anchor_label_layouts);
  }
  return {
    sampled_hit_count: merged.sampled_hit_count,
    field_window_bytes: fieldWindowBytes,
    pointer_target_reads: merged.pointer_target_reads,
    pointer_field_offsets: topLayoutCounterObject(merged.pointer_field_offsets),
    target_pointer_offsets: topLayoutCounterObject(merged.target_pointer_offsets),
    zero_field_offsets: topLayoutCounterObject(merged.zero_field_offsets),
    small_uint32_offsets: topLayoutCounterObject(merged.small_uint32_offsets),
    length_like_offsets: topLayoutCounterObject(merged.length_like_offsets),
    pointer_target_kinds: topLayoutCounterObject(merged.pointer_target_kinds, 8),
    target_anchor_labels: topLayoutCounterObject(merged.target_anchor_labels, 12),
    anchor_label_layouts: summarizeMergedAnchorLabelLayouts(labelLayouts),
  };
}

function mergeLayoutCounterList(target, items = []) {
  for (const item of Array.isArray(items) ? items : []) {
    const key = String(item.key ?? '');
    if (!key) continue;
    target[key] = (target[key] || 0) + Number(item.count || 0);
  }
}

function topLayoutCounterObject(map, limit = 12) {
  return Object.entries(map || {})
    .map(([key, count]) => ({ key, count: Number(count || 0) }))
    .filter(item => item.count > 0)
    .sort((a, b) => b.count - a.count || Math.abs(Number(a.key) || 0) - Math.abs(Number(b.key) || 0))
    .slice(0, limit);
}

function mergeAnchorLabelLayoutList(target, items = []) {
  for (const item of Array.isArray(items) ? items : []) {
    const label = String(item.label || '').slice(0, 80);
    if (!label) continue;
    if (!target[label]) {
      target[label] = {
        label,
        sampled_hit_count: 0,
        pointer_target_reads: 0,
        pointer_field_offsets: {},
        target_pointer_offsets: {},
        small_uint32_offsets: {},
        length_like_offsets: {},
        pointer_target_kinds: {},
      };
    }
    const state = target[label];
    state.sampled_hit_count += Number(item.sampled_hit_count || 0);
    state.pointer_target_reads += Number(item.pointer_target_reads || 0);
    mergeLayoutCounterList(state.pointer_field_offsets, item.pointer_field_offsets);
    mergeLayoutCounterList(state.target_pointer_offsets, item.target_pointer_offsets);
    mergeLayoutCounterList(state.small_uint32_offsets, item.small_uint32_offsets);
    mergeLayoutCounterList(state.length_like_offsets, item.length_like_offsets);
    mergeLayoutCounterList(state.pointer_target_kinds, item.pointer_target_kinds);
  }
}

function summarizeMergedAnchorLabelLayouts(map, limit = 8) {
  return Object.values(map || {})
    .sort((a, b) => b.sampled_hit_count - a.sampled_hit_count || a.label.localeCompare(b.label))
    .slice(0, limit)
    .map(item => ({
      label: item.label,
      sampled_hit_count: item.sampled_hit_count,
      pointer_target_reads: item.pointer_target_reads,
      pointer_field_offsets: topLayoutCounterObject(item.pointer_field_offsets, 6),
      target_pointer_offsets: topLayoutCounterObject(item.target_pointer_offsets, 6),
      small_uint32_offsets: topLayoutCounterObject(item.small_uint32_offsets, 6),
      length_like_offsets: topLayoutCounterObject(item.length_like_offsets, 6),
      pointer_target_kinds: topLayoutCounterObject(item.pointer_target_kinds, 6),
    }));
}

function incrementCounter(target, key) {
  target[key] = (target[key] || 0) + 1;
}

function accountTmpSegment(account = {}) {
  const opaque = String(account.account_id || '').trim().toLowerCase();
  if (/^wxacc_[a-f0-9]{16}$/.test(opaque)) return opaque;
  const material = [
    account.db_storage,
    account.account_root,
    account.id,
    account.wxid,
  ].map(value => String(value || '').trim()).filter(Boolean).join('|') || 'unknown-account';
  const hash = crypto.createHash('sha256').update(material.toLowerCase()).digest('hex').slice(0, 16);
  return `wxacc_${hash}`;
}

function mediaAccountRoot(account = {}) {
  const sourceRoot = String(account.source_account_root || '').trim();
  if (account.source === 'project-mirror' && sourceRoot) {
    return account.mirror?.source_available === true ? path.resolve(sourceRoot) : '';
  }
  const root = String(account.account_root || '').trim();
  return root ? path.resolve(root) : '';
}

function mediaPath(account = {}, ...segments) {
  const root = mediaAccountRoot(account);
  return root ? path.join(root, ...segments.map(segment => String(segment))) : '';
}

function isMissingPathError(error) {
  return ['ENOENT', 'ENOTDIR'].includes(String(error?.code || '').toUpperCase());
}

function mediaSourceAccessError(message, code = 'MEDIA_SOURCE_UNREADABLE', error = null, status = 409) {
  const err = Object.assign(new Error(message), { status, code, public_code: code });
  if (error) err.cause = error;
  return err;
}

function mediaSourceMissingError(error = null) {
  return mediaSourceAccessError('本地媒体文件不存在或尚未同步。', 'MEDIA_SOURCE_MISSING', error, 404);
}

function mediaSourceOutsideError() {
  return mediaSourceAccessError('媒体路径不属于当前微信账号目录。', 'MEDIA_SOURCE_OUTSIDE', null, 403);
}

function mediaSourceNotFileError() {
  return mediaSourceAccessError('媒体路径不是普通文件。', 'MEDIA_SOURCE_NOT_FILE', null, 403);
}

function mediaSourceUnreadableError(action, file, error = null) {
  const cleanAction = String(action || '读取').trim() || '读取';
  const code = String(error?.code || '').trim();
  const suffix = code ? `（${code}）` : '';
  return mediaSourceAccessError(`本地媒体文件${cleanAction}失败，可能被微信占用或没有读取权限${suffix}。`, 'MEDIA_SOURCE_UNREADABLE', error, 409);
}

function mediaTempCopyUnreadableError(action, file, error = null) {
  const cleanAction = String(action || '读取').trim() || '读取';
  const code = String(error?.code || '').trim();
  const suffix = code ? `（${code}）` : '';
  return mediaSourceAccessError(`媒体临时读取数据${cleanAction}失败，已停止读取该媒体内容${suffix}。`, 'MEDIA_TEMP_COPY_UNREADABLE', error, 409);
}

function mediaSourceIgnorableLookupError(error) {
  const code = String(error?.code || '').toUpperCase();
  return error?.status === 404
    || code === 'MEDIA_SOURCE_MISSING'
    || code === 'MEDIA_SOURCE_OUTSIDE'
    || code === 'MEDIA_SOURCE_NOT_FILE';
}

function mediaSourceSnapshot(stat = null) {
  if (!stat) return null;
  return {
    size: Number(stat.size || 0) || 0,
    mtimeMs: Number(stat.mtimeMs || 0) || 0,
  };
}

function mediaSourceSnapshotMatches(left = null, right = null) {
  return !!left
    && !!right
    && left.size === right.size
    && Math.abs(left.mtimeMs - right.mtimeMs) < 1;
}

async function sha256FileContents(file, { signal = null, bufferSize = 4 * 1024 * 1024 } = {}) {
  throwIfAborted(signal);
  const handle = await fsp.open(file, 'r');
  const hash = crypto.createHash('sha256');
  try {
    const size = Math.max(64 * 1024, Number(bufferSize || 0) || 4 * 1024 * 1024);
    const buf = Buffer.alloc(size);
    let position = 0;
    while (true) {
      throwIfAborted(signal);
      const res = await handle.read(buf, 0, buf.length, position);
      if (!res.bytesRead) break;
      hash.update(buf.subarray(0, res.bytesRead));
      position += res.bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function sha256CopiedMediaFile(file = '', { signal = null } = {}) {
  await assertCopiedMediaRealPath(file, { signal });
  return sha256FileContents(file, { signal });
}

function mediaTempCopyUnstableError() {
  return mediaSourceAccessError('本地媒体文件复制前后源文件快照不一致；为避免把半写入文件发给 AI，本次只保留媒体元信息。', 'MEDIA_TEMP_COPY_UNSTABLE', null, 409);
}

async function mediaFileExists(account = {}, file = '', { signal = null } = {}) {
  throwIfAborted(signal);
  try {
    await assertMediaSourceFile(account, file, { signal });
    return true;
  } catch (e) {
    if (e?.status === 499 || signal?.aborted) throw e;
    if (mediaSourceIgnorableLookupError(e)) return false;
    throw e;
  }
}

async function safeMediaSourceFileStat(account = {}, file = '', { signal = null } = {}) {
  const info = await assertMediaSourceFile(account, file, { signal }).catch(e => {
    if (e?.status === 499 || signal?.aborted) throw e;
    if (!mediaSourceIgnorableLookupError(e)) throw e;
    return null;
  });
  return info?.stat?.isFile?.() ? info.stat : null;
}

async function readMediaDir(account = {}, dir = '', { signal = null } = {}) {
  throwIfAborted(signal);
  const root = mediaAccountRoot(account);
  const resolved = path.resolve(String(dir || ''));
  if (!root || !resolved || !isInside(root, resolved)) return [];
  let st;
  try {
    st = await fsp.lstat(resolved);
  } catch (e) {
    if (isMissingPathError(e)) return [];
    throw mediaSourceUnreadableError('检查目录', resolved, e);
  }
  throwIfAborted(signal);
  if (!st?.isDirectory() || st.isSymbolicLink()) return [];
  const [rootReal, dirReal] = await Promise.all([
    fsp.realpath(root).catch(e => {
      if (isMissingPathError(e)) return '';
      throw mediaSourceUnreadableError('解析账号目录', root, e);
    }),
    fsp.realpath(resolved).catch(e => {
      if (isMissingPathError(e)) return '';
      throw mediaSourceUnreadableError('解析目录', resolved, e);
    }),
  ]);
  throwIfAborted(signal);
  if (!rootReal || !dirReal || !isInside(rootReal, dirReal)) return [];
  try {
    return await fsp.readdir(resolved, { withFileTypes: true });
  } catch (e) {
    if (isMissingPathError(e)) return [];
    throw mediaSourceUnreadableError('读取目录', resolved, e);
  }
}

async function assertMediaSourceFile(account = {}, file = '', { signal = null } = {}) {
  throwIfAborted(signal);
  const root = mediaAccountRoot(account);
  const resolved = path.resolve(String(file || ''));
  if (!root || !resolved || !isInside(root, resolved)) {
    throw mediaSourceOutsideError();
  }
  let linkStat;
  try {
    linkStat = await fsp.lstat(resolved);
  } catch (e) {
    if (isMissingPathError(e)) throw mediaSourceMissingError(e);
    throw mediaSourceUnreadableError('检查', resolved, e);
  }
  throwIfAborted(signal);
  if (!linkStat.isFile() || linkStat.isSymbolicLink()) {
    throw mediaSourceNotFileError();
  }
  const [rootReal, fileReal] = await Promise.all([
    fsp.realpath(root).catch(e => {
      if (isMissingPathError(e)) return '';
      throw mediaSourceUnreadableError('解析账号目录', root, e);
    }),
    fsp.realpath(resolved).catch(e => {
      if (isMissingPathError(e)) throw mediaSourceMissingError(e);
      throw mediaSourceUnreadableError('解析', resolved, e);
    }),
  ]);
  throwIfAborted(signal);
  if (!rootReal || !fileReal || !isInside(rootReal, fileReal)) {
    throw mediaSourceOutsideError();
  }
  return { source: resolved, stat: linkStat, rootReal, fileReal };
}

function assertMediaCopyPath(targetPath) {
  const resolved = path.resolve(String(targetPath || ''));
  if (!resolved || !isInside(MEDIA_COPY_ROOT, resolved)) {
  const err = new Error(`媒体文件只能由程序自动准备为临时读取数据后读取；当前读取链路绕过了自动准备步骤，已拒绝直接读取源文件。`);
    err.status = 403;
    err.code = 'MEDIA_COPY_REQUIRED';
    throw err;
  }
}

function assertMediaCopyRoot(targetRoot) {
  const resolved = path.resolve(String(targetRoot || ''));
  if (!resolved || path.resolve(resolved) === path.resolve(MEDIA_COPY_ROOT) || !isInside(MEDIA_COPY_ROOT, resolved)) {
    const err = new Error(`媒体临时读取目录必须位于 ${MEDIA_COPY_ROOT_RELATIVE} 下。`);
    err.status = 403;
    err.code = 'MEDIA_COPY_REQUIRED';
    throw err;
  }
}

async function assertCopiedMediaRealPath(targetPath, { signal = null } = {}) {
  assertMediaCopyPath(targetPath);
  throwIfAborted(signal);
  const resolved = path.resolve(String(targetPath || ''));
  const [copyRootReal, copiedReal, linkStat] = await Promise.all([
    fsp.realpath(MEDIA_COPY_ROOT).catch(() => ''),
    fsp.realpath(resolved).catch(() => ''),
    fsp.lstat(resolved).catch(() => null),
  ]);
  throwIfAborted(signal);
  if (!copyRootReal || !copiedReal || !isInside(copyRootReal, copiedReal) || !linkStat?.isFile() || linkStat.isSymbolicLink()) {
    const err = new Error(`媒体文件临时读取数据不可用，请重新准备。`);
    err.status = 403;
    err.code = 'MEDIA_COPY_REQUIRED';
    throw err;
  }
}

async function copyMediaFileForRead(account = {}, file = '', { signal = null, include_image_siblings = false } = {}) {
  const primary = await assertMediaSourceFile(account, file, { signal });
  const copyId = [
    new Date().toISOString().replace(/[:.]/g, '-'),
    process.pid,
    WEIXIN_V4_PLAINTEXT_CACHE_PROCESS_TOKEN,
    crypto.randomUUID().slice(0, 8),
  ].join('-');
  const tempRoot = path.join(MEDIA_COPY_ROOT, accountTmpSegment(account), copyId);
  const candidates = include_image_siblings ? imageDatSiblingCandidates(primary.source) : [primary.source];
  const seen = new Set();
  let targetPath = '';
  let bytes = 0;
  let copiedCount = 0;
  try {
    for (const candidate of candidates) {
      throwIfAborted(signal);
      const source = path.resolve(candidate);
      const key = source.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const info = await assertMediaSourceFile(account, source, { signal }).catch(e => {
        if (e?.status === 499 || signal?.aborted) throw e;
        if (!mediaSourceIgnorableLookupError(e)) throw e;
        return null;
      });
      if (!info) continue;
      const target = path.join(tempRoot, path.basename(info.source));
      assertMediaCopyPath(target);
      const safeTarget = await assertSafeTmpPath(target, { label: 'media temporary copy', ensureParent: true });
      const copiedStat = await copyMediaSourceFileStable(account, info, safeTarget.resolved, { signal });
      throwIfAborted(signal);
      if (path.resolve(info.source) === path.resolve(primary.source)) targetPath = safeTarget.resolved;
      bytes += Number(copiedStat?.size || info.stat.size || 0) || 0;
      copiedCount += 1;
    }
    if (!targetPath) throw new Error('media temporary copy missing primary file');
    await assertCopiedMediaRealPath(targetPath, { signal });
    return {
      project_copy: true,
      copy_root_relative: MEDIA_COPY_ROOT_RELATIVE,
      temp_root: tempRoot,
      target_path: targetPath,
      bytes,
      copied_count: copiedCount,
    };
  } catch (e) {
    await assertSafeTmpPath(path.join(tempRoot, 'cleanup.marker'), { label: 'media temporary copy root', ensureParent: true })
      .then(() => fsp.rm(tempRoot, { recursive: true, force: true }))
      .catch(() => {});
    throw e;
  }
}

async function copyMediaSourceFileStable(account = {}, info = {}, targetPath = '', { signal = null } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < MEDIA_COPY_STABLE_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    const before = await assertMediaSourceFile(account, info.source, { signal });
    const beforeSnapshot = mediaSourceSnapshot(before.stat);
    try {
      await fsp.copyFile(before.source, targetPath);
    } catch (e) {
      if (isMissingPathError(e)) throw mediaSourceMissingError(e);
      throw mediaSourceUnreadableError('复制', before.source, e);
    }
    throwIfAborted(signal);
    const copiedStat = await fsp.lstat(targetPath).catch(e => {
      if (isMissingPathError(e)) throw mediaTempCopyUnstableError();
      throw mediaSourceAccessError('媒体临时读取数据写入后不可读。', 'MEDIA_TEMP_COPY_UNREADABLE', e, 409);
    });
    throwIfAborted(signal);
    if (!copiedStat?.isFile() || copiedStat.isSymbolicLink()) {
      throw mediaSourceAccessError('媒体临时读取数据不是普通文件，已拒绝读取。', 'MEDIA_TEMP_COPY_INVALID', null, 409);
    }
    const copiedHash = await sha256CopiedMediaFile(targetPath, { signal });
    const after = await assertMediaSourceFile(account, before.source, { signal }).catch(e => {
      if (e?.status === 499 || signal?.aborted) throw e;
      if (mediaSourceIgnorableLookupError(e)) throw mediaTempCopyUnstableError();
      throw e;
    });
    const afterSnapshot = mediaSourceSnapshot(after.stat);
    if (
      mediaSourceSnapshotMatches(beforeSnapshot, afterSnapshot)
      && Number(copiedStat.size || 0) === beforeSnapshot.size
      && copiedHash
    ) {
      return copiedStat;
    }
    lastError = mediaTempCopyUnstableError();
  }
  throw lastError || mediaTempCopyUnstableError();
}

async function removeCopiedMediaRoots(roots = []) {
  for (const root of roots || []) {
    if (!root) continue;
    try {
      assertMediaCopyRoot(root);
      await assertSafeTmpPath(path.join(root, 'cleanup.marker'), { label: 'media temporary copy root', ensureParent: true });
      await fsp.rm(root, { recursive: true, force: true });
    } catch {}
  }
}

function externalTestDbAccessAllowed() {
  return process.env.WX_SUMMARY_ALLOW_EXTERNAL_TEST_DB === '1'
    || process.env.NODE_ENV === 'test';
}

function assertExternalTestDbAccessAllowed() {
  if (externalTestDbAccessAllowed()) return;
  const err = new Error('external test database access is only available in test mode');
  err.status = 403;
  err.code = 'EXTERNAL_TEST_DB_DISABLED';
  err.public_code = err.code;
  throw err;
}

function assertCopiedDbPath(dbPath, { allow_external_test_db = false } = {}) {
  if (allow_external_test_db) {
    assertExternalTestDbAccessAllowed();
    return;
  }
  const resolved = path.resolve(String(dbPath || ''));
  if (!resolved || !isInside(DB_COPY_ROOT, resolved)) {
    throw copiedDbRequiredError();
  }
}

async function assertCopiedDbRealPath(dbPath, { allow_external_test_db = false, signal = null } = {}) {
  if (allow_external_test_db) {
    assertExternalTestDbAccessAllowed();
    return;
  }
  assertCopiedDbPath(dbPath);
  throwIfAborted(signal);
  const resolved = path.resolve(String(dbPath || ''));
  const [projectReal, copyRootReal, copiedReal, linkStat] = await Promise.all([
    fsp.realpath(PROJECT_ROOT).catch(() => ''),
    fsp.realpath(DB_COPY_ROOT).catch(() => ''),
    fsp.realpath(resolved).catch(() => ''),
    fsp.lstat(resolved).catch(() => null),
  ]);
  throwIfAborted(signal);
  if (!projectReal || !copyRootReal || !copiedReal) {
    throw copiedDbRequiredError();
  }
  if (!isInside(projectReal, copyRootReal) || !isInside(copyRootReal, copiedReal)) {
    throw copiedDbRequiredError();
  }
  if (!linkStat?.isFile() || linkStat.isSymbolicLink()) {
    throw copiedDbRequiredError();
  }
}

function copiedDbRequiredError() {
  const err = new Error(`数据库只能由程序自动准备为临时读取数据后打开；当前读取链路绕过了自动准备步骤，已拒绝直接打开数据库。`);
  err.status = 403;
  err.code = 'db_copy_required';
  err.public_code = 'db_copy_required';
  return err;
}

function sanitizeWxdbShardErrorCode(value = '') {
  const code = String(value || '').trim().toLowerCase();
  return /^[a-z0-9_:-]{1,120}$/.test(code) ? code : '';
}

function wxdbShardErrorCode(error = null) {
  return sanitizeWxdbShardErrorCode(error?.public_code || error?.code || '');
}

function isMirrorShardErrorCode(code = '') {
  return code === 'db_copy_required' || /^(?:wxdb_temp_copy_|wxdb_mirror_|wxdb_source_)/.test(code);
}

function shardErrorCategory(item = {}) {
  const code = sanitizeWxdbShardErrorCode(item?.code);
  if (isMirrorShardErrorCode(code)) return 'mirror';
  const text = `${code} ${item?.name || ''} ${item?.error || ''}`;
  if (/wxdb_temp_copy_|wxdb_mirror_|wxdb_source_|db_copy_required|路径越界|源数据库|项目副本|临时副本|temporary copy|unable to open database file|permission denied|access is denied|SQLITE_CANTOPEN|SQLITE_CORRUPT|SQLITE_FORMAT|database disk image is malformed|malformed database schema|EPERM|EACCES|EBUSY|ENOENT|no such file|not found/i.test(text)) return 'mirror';
  if (/no raw key matched|no candidate key opened|validation_budget_exhausted|Weixin v4 page hmac mismatch|page hmac|hmac mismatch|SQLCipher key validation failure|wrong key|invalid key|SQLITE_NOTADB|SQLITE_AUTH/i.test(text)) return 'key';
  return 'other';
}

function sampleWxdbShardErrors(shardErrors = [], limit = 6) {
  const items = Array.isArray(shardErrors) ? shardErrors.filter(Boolean) : [];
  const selected = [];
  const seen = new Set();
  const add = item => {
    const key = `${sanitizeWxdbShardErrorCode(item?.code)}\u001f${item?.name || ''}\u001f${item?.error || ''}`;
    if (!item || seen.has(key) || selected.length >= limit) return;
    seen.add(key);
    selected.push(item);
  };
  for (const category of ['mirror', 'key', 'other']) add(items.find(item => shardErrorCategory(item) === category));
  add(items[0]);
  add(items[Math.floor(items.length / 2)]);
  add(items[items.length - 1]);
  return selected;
}

function summarizeWxdbShardErrorCategories(shardErrors = []) {
  const counts = { mirror: 0, key: 0, other: 0 };
  for (const item of Array.isArray(shardErrors) ? shardErrors : []) counts[shardErrorCategory(item)] += 1;
  return compactObject(counts);
}

function shardOpenFailureCause(shardErrors = []) {
  const categories = new Set((Array.isArray(shardErrors) ? shardErrors : []).map(shardErrorCategory));
  if (categories.size > 1) return 'mixed';
  const category = categories.values().next().value || 'other';
  return category === 'other' ? 'wxdb' : category;
}

function shardOpenFailureCategorySummary(shardErrors = []) {
  const counts = summarizeWxdbShardErrorCategories(shardErrors);
  return [
    counts.mirror ? `本地工作数据或临时读取数据 ${counts.mirror} 个` : '',
    counts.key ? `密钥验证 ${counts.key} 个` : '',
    counts.other ? `其他读取错误 ${counts.other} 个` : '',
  ].filter(Boolean).join('，');
}

function shardOpenFailureMessage({ readableShards = 0, shardErrors = [], sample = '' } = {}) {
  const cause = shardOpenFailureCause(shardErrors);
  const suffix = sample ? `失败示例：${sample}` : '';
  const categorySummary = shardOpenFailureCategorySummary(shardErrors);
  if (cause === 'mixed') {
    return readableShards === 0
      ? `所有微信消息分片都读取失败，并同时出现多类故障（${categorySummary}）。程序已停止生成，避免把混合故障误报为单纯密钥错误或漏掉消息；稍后重试会先自动复核本地工作数据。${suffix}`
      : `有 ${shardErrors.length} 个微信消息分片读取失败，并同时出现多类故障（${categorySummary}）。程序已停止生成，避免使用不完整消息或把混合故障误报为单纯密钥错误。${suffix}`;
  }
  if (readableShards === 0) {
    if (cause === 'mirror') {
      return `所有微信消息分片都读取失败，无法取得稳定的本地工作数据或临时读取数据，已停止生成以避免漏消息；稍后重试会自动重新检查本地数据。${suffix}`;
    }
    if (cause === 'key') {
      return `所有微信消息分片都读取失败，消息库密钥未通过验证，无法确认消息完整性。请先确认右上角账号，再扫描并验证密钥；仍失败再保存当前账号的有效手动密钥。${suffix}`;
    }
    return `所有微信消息分片都读取失败，无法确认消息完整性。请确认账号、微信同步状态和本地数据状态后重试。${suffix}`;
  }
  if (cause === 'mirror') {
    return `有 ${shardErrors.length} 个微信消息分片的本地工作数据或临时读取数据暂时不可读，已停止生成以避免漏数据；稍后重试会自动重新检查本地数据。${suffix}`;
  }
  if (cause === 'key') {
    return `有 ${shardErrors.length} 个微信消息分片密钥验证未通过，已停止生成以避免漏数据。${suffix}`;
  }
  return `有 ${shardErrors.length} 个微信消息分片读取失败，已停止生成以避免漏数据。${suffix}`;
}

async function assertProjectMirrorAccount(account, { signal = null, allowStaleSource = false } = {}) {
  throwIfAborted(signal);
  const sourceStatus = String(account?.source_status || account?.mirror?.source_status || (account?.source_available === false ? 'missing' : 'available')).trim();
  if (account?.source === 'source-unreadable' || (sourceStatus === 'unreadable' && account?.source !== 'project-mirror')) {
    const err = new Error('当前微信数据目录或配置暂时不可读，尚无可验证的项目工作副本；已拒绝把读取失败误判成账号不存在。请恢复访问后重试。');
    err.status = 409;
    err.code = 'wxdb_source_directory_unreadable';
    err.public_code = err.code;
    throw err;
  }
  if (account?.source !== 'project-mirror') {
    const err = new Error('微信本地工作数据尚未准备好。程序会先自动从源库准备项目副本后再读取；后续重试会重新按源库文件元数据判断复用或更新，不需要手动配置。');
    err.status = 428;
    err.code = 'wxdb_mirror_required';
    err.public_code = 'wxdb_mirror_required';
    throw err;
  }
  if (sourceStatus !== 'available') {
    const ambiguous = sourceStatus === 'ambiguous';
    const unreadable = sourceStatus === 'unreadable';
    if (!ambiguous && allowStaleSource) {
      // Offline reads are allowed only after the locked read verifies the published copy.
    } else {
      const err = new Error(ambiguous
        ? '当前本地工作数据对应到多个微信源账号，程序已拒绝按最近写入时间猜测，避免读错账号。请刷新账号列表并在右上角重新选择明确账号后重试。'
        : (unreadable
          ? '当前微信数据目录或配置暂时不可读，不能确认本地工作数据是否最新；已拒绝把读取失败误判成账号不存在。请恢复访问后重试。'
          : '当前没有找到对应微信源账号，不能确认本地工作数据是否最新；已拒绝读取旧数据，避免生成长图/生成文本预览伪成功。'));
      err.status = 409;
      err.code = ambiguous
        ? 'wxdb_source_account_ambiguous'
        : (unreadable ? 'wxdb_source_directory_unreadable' : 'wxdb_source_account_missing');
      err.public_code = err.code;
      throw err;
    }
  }
  const dbStorage = String(account.db_storage || '').trim();
  if (!dbStorage || !isInside(WXDB_MIRROR_ROOT, dbStorage)) {
    const err = new Error('微信本地工作数据索引异常。下次读取会自动重建本地工作数据，不需要手动配置。');
    err.status = 403;
    err.code = 'wxdb_mirror_path_invalid';
    err.public_code = 'wxdb_mirror_path_invalid';
    throw err;
  }
  const [mirrorRootReal, dbStorageReal] = await Promise.all([
    fsp.realpath(WXDB_MIRROR_ROOT).catch(() => ''),
    fsp.realpath(dbStorage).catch(() => ''),
  ]);
  throwIfAborted(signal);
  if (!mirrorRootReal || !dbStorageReal || !isInside(mirrorRootReal, dbStorageReal)) {
    const err = new Error('微信本地工作数据不可用或路径越界；下次读取会自动重建，不需要手动配置。');
    err.status = 403;
    err.code = 'wxdb_mirror_path_invalid';
    err.public_code = 'wxdb_mirror_path_invalid';
    throw err;
  }
}

function wxdbAccountNotFoundError(accountId = '', phase = 'discover') {
  const requested = String(accountId || '').trim();
  const err = new Error(requested
    ? `当前选择的微信账号不在最新可读取账号列表中，不能确认本地工作数据是否对应该账号；已拒绝返回空群或空消息。请刷新账号列表后重新选择。`
    : '未找到可读取的微信账号，不能确认本地工作数据是否最新；已拒绝返回空群或空消息。请确认微信已登录后刷新账号列表。');
  err.status = 409;
  err.code = 'wxdb_account_not_found';
  err.public_code = 'wxdb_account_not_found';
  err.account_id = requested;
  err.phase = phase;
  return err;
}

function wxdbMirrorReadinessChangedError(onProgress = null) {
  notifyProgress(onProgress, {
    phase: 'mirror_readiness_mismatch',
    label: '检查本地数据 · 快照已变化',
    detail: '本地工作数据在读取加锁前已被更新；为避免同一批读取跨版本，当前读取已停止',
  });
  const err = new Error('本次读取开始后，微信本地数据已更新为另一个快照。为避免同一批长图或文本混用不同时间点的数据，系统已停止本批生成；请重新点击生成。');
  err.status = 409;
  err.code = 'wxdb_mirror_readiness_changed';
  err.public_code = err.code;
  return err;
}

function accountMirrorReadinessTokenForLockedRead(account = {}, requiredScope = '') {
  const required = normalizeMirrorReadinessScope(requiredScope) || 'full';
  const candidates = required === 'groups'
    ? ['groups', 'identity', 'digest', 'full']
    : (required === 'identity'
      ? ['identity', 'digest', 'full']
      : (required === 'digest' ? ['digest', 'full'] : ['full']));
  const scope = candidates.find(candidate => accountMirrorScopeHash(account, candidate)) || required;
  return {
    account_id: String(account.account_id || account.id || account.wxid || '').trim(),
    ...accountMirrorScopeMetadata(account, scope),
    published_manifest_hash: accountMirrorPublishedManifestHash(account),
  };
}

async function projectMirrorAccountForRead(accountId = '', { signal = null, autoRefresh = false, forceRefresh = false, mirrorReadiness = null, requiredMirrorScope = 'full', reason = 'wxdb_refresh', onProgress = null, allowStaleSource = false } = {}) {
  throwIfAborted(signal);
  let accounts = await discoverWxAccounts({ signal });
  throwIfAborted(signal);
  let account = pickAccount(accounts, accountId);
  if (!account) throw wxdbAccountNotFoundError(accountId, 'before_mirror_refresh');
  const readinessMatches = accountMatchesMirrorReadinessToken(account, mirrorReadiness, requiredMirrorScope);
  if (mirrorReadiness && !readinessMatches) {
    throw wxdbMirrorReadinessChangedError(onProgress);
  }
  const shouldRefreshMirror = account.source !== 'project-mirror'
    || forceRefresh
    || (autoRefresh && !mirrorReadiness);
  if (mirrorReadiness && readinessMatches && !shouldRefreshMirror) {
    notifyProgress(onProgress, {
      phase: 'mirror_readiness_reused',
      label: '检查本地数据 · 使用工作副本',
      detail: '已安全读取项目内的本地工作副本，不直接读取微信源数据库',
    });
  }
  if (shouldRefreshMirror) {
    const mirror = await ensureWxDbMirror({
      account_id: accountId || account.account_id || account.id || account.wxid || '',
      signal,
      onProgress,
      reason: autoRefresh ? (reason || 'wxdb_refresh') : 'wxdb_read',
      force: forceRefresh,
      allow_stale_account: allowStaleSource,
    });
    throwIfAborted(signal);
    if (mirror?.refreshed || mirror?.reused || account.source !== 'project-mirror') {
      accounts = await discoverWxAccounts({ signal });
      throwIfAborted(signal);
      account = pickAccount(accounts, mirror?.account_id || accountId);
    }
  }
  if (!account) throw wxdbAccountNotFoundError(accountId, 'after_mirror_refresh');
  if (allowStaleSource) {
    await assertProjectMirrorAccount(account, { signal, allowStaleSource: true });
  } else {
    await assertProjectMirrorAccount(account, { signal });
  }
  if (!accountMirrorHasScope(account, requiredMirrorScope)) {
    const err = new Error('微信本地工作数据缺少本次读取需要的范围；下次读取会自动重新准备或更新。');
    err.status = 409;
    err.code = 'wxdb_mirror_scope_missing';
    err.public_code = 'wxdb_mirror_scope_missing';
    err.required_scope = normalizeMirrorReadinessScope(requiredMirrorScope) || 'full';
    throw err;
  }
  return account;
}

async function withProjectMirrorAccountForRead(accountId = '', options = {}, action = null) {
  const {
    signal = null,
    mirrorReadiness = null,
    requiredMirrorScope = 'full',
    onProgress = null,
    allowStaleSource = false,
  } = options || {};
  let readOptions = options;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const account = await projectMirrorAccountForRead(accountId, readOptions);
    const expectedReadiness = accountMirrorReadinessTokenForLockedRead(account, requiredMirrorScope);
    const lockAccountId = wxDbMirrorLockIdForAccount(account);
    try {
      const lockedAccount = await withWxDbMirrorReadLock(lockAccountId, async () => {
        throwIfAborted(signal);
        const accounts = await discoverWxAccounts({ signal });
        throwIfAborted(signal);
        const lockedAccount = pickAccount(accounts, account.account_id || account.id || account.wxid || accountId);
        if (!lockedAccount) throw wxdbAccountNotFoundError(accountId || lockAccountId, 'inside_mirror_read_lock');
        // The ordinary locked path remains: await assertProjectMirrorAccount(lockedAccount, { signal });
        await assertProjectMirrorAccount(lockedAccount, { signal, allowStaleSource });
        if (!accountMatchesMirrorReadinessToken(lockedAccount, expectedReadiness, requiredMirrorScope)) {
          throw wxdbMirrorReadinessChangedError(onProgress);
        }
        const parentReadinessMatches = attempt > 0
          ? accountMatchesMirrorSourceSnapshotToken(lockedAccount, mirrorReadiness, requiredMirrorScope)
          : accountMatchesMirrorReadinessToken(lockedAccount, mirrorReadiness, requiredMirrorScope);
        if (mirrorReadiness && !parentReadinessMatches) {
          throw wxdbMirrorReadinessChangedError(onProgress);
        }
        if (!accountMirrorHasScope(lockedAccount, requiredMirrorScope)) {
          const err = new Error('微信本地工作数据缺少本次读取需要的范围；下次读取会自动重新准备或更新。');
          err.status = 409;
          err.code = 'wxdb_mirror_scope_missing';
          err.public_code = err.code;
          err.required_scope = normalizeMirrorReadinessScope(requiredMirrorScope) || 'full';
          throw err;
        }
        await assertProjectMirrorPublishedManifest(lockedAccount, expectedReadiness.scope, { signal, onProgress });
        if (allowStaleSource && projectMirrorSourceUnavailable(lockedAccount)) {
          await assertProjectMirrorContentHashes(lockedAccount, expectedReadiness.scope, { signal, onProgress });
        }
        return lockedAccount;
      }, { signal });
      return await action(lockedAccount);
    } catch (error) {
      const recoveryAction = mirrorReadRecoveryAction(error, attempt);
      if (recoveryAction === 'propagate') throw error;
      if (recoveryAction === 'fail_repair') throw wxdbMirrorManifestRepairFailedError(error);
      notifyProgress(onProgress, {
        phase: 'mirror_manifest_repair',
        label: '检查本地数据 · 自动重建工作副本',
        detail: '发布清单校验发现项目工作副本被替换或损坏；已释放读取锁，正在从微信源目录重新复制所需数据',
      });
      readOptions = {
        ...options,
        autoRefresh: true,
        forceRefresh: true,
      };
    }
  }
  throw wxdbMirrorManifestRepairFailedError();
}

export async function copyDbFile(account, dbFile, { signal = null, allow_stale_account = false, onProgress = null } = {}) {
  throwIfAborted(signal);
  return withWxDbMirrorReadLock(wxDbMirrorLockIdForAccount(account), () => copyDbFileLocked(account, dbFile, {
    signal,
    allowStaleSource: allow_stale_account === true,
    onProgress,
  }), { signal });
}

function wxDbMirrorLockIdForAccount(account = {}) {
  return String(account?.account_id || account?.id || account?.wxid || account?.db_storage || 'default').trim() || 'default';
}

async function copyDbFileLocked(account, dbFile, { signal = null, allowStaleSource = false, onProgress = null } = {}) {
  throwIfAborted(signal);
  await assertProjectMirrorAccount(account, { signal, allowStaleSource });
  const sourceInput = typeof dbFile === 'string' ? dbFile : dbFile?.path;
  const source = sourceInput ? path.resolve(sourceInput) : '';
  const { stat: st, realDbStorage } = await assertDbCopySource(account, source, { signal });
  throwIfAborted(signal);
  if (!st.isFile()) {
    const err = new Error('db path is not a file');
    err.status = 400;
    throw err;
  }

  const category = path.basename(path.dirname(source));
  let lastStabilityError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    throwIfAborted(signal);
    const copyId = [
      new Date().toISOString().replace(/[:.]/g, '-'),
      process.pid,
      WEIXIN_V4_PLAINTEXT_CACHE_PROCESS_TOKEN,
      crypto.randomUUID().slice(0, 8),
    ].join('-');
    const targetDir = path.join(DB_COPY_ROOT, accountTmpSegment(account), copyId, category);
    const target = path.join(targetDir, path.basename(source));
    let copiedTarget = '';
    try {
      const before = await dbCopySourceSnapshot(source, { signal });
      throwIfAborted(signal);
      await assertAvailableDiskSpace(targetDir, before.reduce((sum, item) => sum + (item.exists ? Number(item.size || 0) || 0 : 0), 0), {
        code: 'wxdb_temp_copy_disk_space_insufficient',
        message: '项目临时目录所在磁盘可用空间不足，无法安全复制本次数据库和 WAL。请清理磁盘空间后重试。',
      });
      const safeTarget = await assertSafeTmpPath(target, { label: 'database temporary copy', ensureParent: true });
      copiedTarget = safeTarget.resolved;
      const progressState = {
        copied_bytes: 0,
        total_bytes: before.reduce((sum, item) => sum + (item.exists ? Number(item.size || 0) || 0 : 0), 0),
        last_report_at: 0,
      };
      notifyProgress(onProgress, {
        phase: 'fetch_temp_copy_start',
        label: '拉取消息 · 创建临时读取数据',
        detail: `${path.basename(source)}：正在复制数据库和写入日志到项目临时目录（共 ${formatBytes(progressState.total_bytes) || `${progressState.total_bytes}B`}）`,
        copied_bytes: 0,
        total_bytes: progressState.total_bytes,
        percent: progressState.total_bytes ? 0 : 100,
      });
      await copyDbArtifactWithSignal(source, safeTarget.resolved, { signal, onProgress, progressState });
      throwIfAborted(signal);
      const sidecars = await copyDbSidecars(source, safeTarget.resolved, {
        signal,
        realDbStorage,
        onProgress,
        progressState,
      });
      notifyProgress(onProgress, {
        phase: 'fetch_temp_copy_done',
        label: '拉取消息 · 临时读取数据已就绪',
        detail: `${path.basename(source)}：数据库和写入日志已完整复制，正在只读打开`,
        copied_bytes: progressState.copied_bytes,
        total_bytes: progressState.total_bytes,
        percent: 100,
      });
      const after = await dbCopySourceSnapshot(source, { signal });
      throwIfAborted(signal);
      if (!sameDbCopySourceSnapshot(before, after)) {
        lastStabilityError = dbTempCopyError('wxdb_temp_copy_unstable', '项目本地工作数据在临时复制期间发生变化，无法取得一致的读取数据；请关闭重复运行的服务或暂停会修改项目目录的同步工具后重试。', {
          source,
          category,
          attempt,
          cause: 'source_snapshot_changed',
        });
        await removeCopiedDb(safeTarget.resolved).catch(() => {});
        await sleepForDbCopyRetry(attempt);
        continue;
      }
      await assertCopiedDbRealPath(safeTarget.resolved, { signal });
      const copied = await fsp.stat(safeTarget.resolved);
      const header = await readHeader(safeTarget.resolved, { signal });
      throwIfAborted(signal);
      const publishedHashes = await assertCopiedDbMatchesPublishedManifest(account, source, safeTarget.resolved, { signal });
      const copiedContentFingerprint = await copiedDbContentFingerprint(safeTarget.resolved, { signal, knownHashes: publishedHashes });
      return {
        project_copy: true,
        copy_root_relative: DB_COPY_ROOT_RELATIVE,
        source_access: 'copy_only',
        source_category: category,
        source_name: path.basename(source),
        source_fingerprint: copiedContentFingerprint,
        source_fingerprint_kind: 'copied_content_sha256',
        target_path: safeTarget.resolved,
        bytes: copied.size,
        sha256_16: await sha256Prefix(safeTarget.resolved, { signal }),
        encrypted_like: !header.equals(SQLITE_HEADER),
        sqlite_header: header.equals(SQLITE_HEADER),
        sidecars,
      };
    } catch (e) {
      if (copiedTarget) await removeCopiedDb(copiedTarget).catch(() => {});
      if (isDiskSpaceError(e)) throw dbTempCopyDiskSpaceError(e, source, category);
      if (isTransientDbCopyError(e)) {
        lastStabilityError = dbTempCopyError('wxdb_temp_copy_failed', '微信数据库临时读取数据复制失败，请稍后重试。', {
          source,
          category,
          attempt,
          cause: transientDbCopyErrorCause(e),
        });
        if (attempt >= 2) throw lastStabilityError;
        await sleepForDbCopyRetry(attempt);
        continue;
      }
      throw e;
    }
  }
  throw lastStabilityError || dbTempCopyError('wxdb_temp_copy_failed', '微信数据库临时读取数据复制失败。', {
    source,
    category,
    cause: 'copy_retry_exhausted',
  });
}

function dbTempCopyError(code, message, { source = '', category = '', attempt = -1, cause = '' } = {}) {
  const err = new Error(message);
  err.status = 409;
  err.code = code;
  err.public_code = code;
  err.wxdb_diagnostics = compactObject({
    copy_stage: 'temporary_project_copy',
    copy_root_relative: DB_COPY_ROOT_RELATIVE,
    source_access: 'project_mirror_copy_only',
    source_category: String(category || '').trim(),
    source_name: source ? path.basename(source) : '',
    attempt: Number.isFinite(Number(attempt)) && Number(attempt) >= 0 ? Number(attempt) + 1 : 0,
    cause: String(cause || '').trim(),
  });
  return err;
}

function dbTempCopyDiskSpaceError(error = null, source = '', category = '') {
  if (String(error?.code || '') === 'wxdb_temp_copy_disk_space_insufficient') return error;
  const err = dbTempCopyError('wxdb_temp_copy_disk_space_insufficient', '项目临时目录所在磁盘可用空间不足，无法安全准备数据库临时读取数据。请清理磁盘空间后重试。', {
    source,
    category,
    cause: String(error?.code || error?.errno || 'disk_space_insufficient').toLowerCase(),
  });
  for (const field of ['required_bytes', 'reserve_bytes', 'available_bytes']) {
    if (Number.isFinite(Number(error?.[field]))) err[field] = Number(error[field]);
  }
  err.status = 507;
  return err;
}

function transientDbCopyErrorCause(error) {
  const code = String(error?.code || '').trim();
  if (code) return code.toLowerCase();
  const message = String(error?.message || error || '').toLowerCase();
  if (/busy|locked|占用/.test(message)) return 'busy_or_locked';
  if (/access|permission|denied|拒绝|权限/.test(message)) return 'permission_denied';
  if (/enoent|not found|no such file|找不到|不存在/.test(message)) return 'source_missing';
  return 'transient_copy_error';
}

function isMissingFileError(error = null) {
  return ['ENOENT', 'ENOTDIR'].includes(String(error?.code || '').trim());
}

function dbSidecarKindLabel(suffix = '') {
  return String(suffix || '').toLowerCase() === '-journal' ? '回滚日志' : 'WAL';
}

async function copyDbArtifactWithSignal(source, target, { signal = null, onProgress = null, progressState = null } = {}) {
  throwIfAborted(signal);
  const sourceStat = await fsp.stat(source);
  throwIfAborted(signal);
  const state = progressState && typeof progressState === 'object'
    ? progressState
    : { copied_bytes: 0, total_bytes: Math.max(0, Number(sourceStat.size || 0) || 0), last_report_at: 0 };
  const emitProgress = (force = false) => {
    if (typeof onProgress !== 'function') return;
    const now = Date.now();
    if (!force && state.last_report_at && now - state.last_report_at < 500) return;
    state.last_report_at = now;
    const copiedBytes = Math.max(0, Number(state.copied_bytes || 0) || 0);
    const totalBytes = Math.max(0, Number(state.total_bytes || 0) || 0);
    notifyProgress(onProgress, {
      phase: 'fetch_temp_copy_progress',
      label: '拉取消息 · 复制临时读取数据',
      detail: `${path.basename(source)}：已复制 ${formatBytes(copiedBytes) || `${copiedBytes}B`}/${formatBytes(totalBytes) || `${totalBytes}B`}`,
      source_name: path.basename(source),
      copied_bytes: copiedBytes,
      total_bytes: totalBytes,
      percent: totalBytes ? Math.min(100, Math.round((copiedBytes / totalBytes) * 100)) : 100,
    });
  };
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      state.copied_bytes = Math.max(0, Number(state.copied_bytes || 0) || 0) + Buffer.byteLength(chunk);
      emitProgress(false);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      fs.createReadStream(source),
      meter,
      fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }),
      signal ? { signal } : {},
    );
    emitProgress(true);
  } catch (error) {
    await fsp.rm(target, { force: true }).catch(() => {});
    if (signal?.aborted) throw abortSignalError(signal, '数据库临时读取数据复制已取消。');
    throw error;
  }
  throwIfAborted(signal);
}

async function assertDbCopySource(account, source, { signal = null } = {}) {
  const dbStorageInput = String(account?.db_storage || '').trim();
  const dbStorage = dbStorageInput ? path.resolve(dbStorageInput) : '';
  if (!source || !dbStorage || !isInside(dbStorage, source)) {
    const err = new Error('db path is outside selected account db_storage');
    err.status = 403;
    throw err;
  }
  throwIfAborted(signal);
  const linkStat = await fsp.lstat(source);
  throwIfAborted(signal);
  if (linkStat.isSymbolicLink()) {
    const err = new Error('db path must be a regular database file, not a symbolic link');
    err.status = 403;
    throw err;
  }
  const [mirrorRootReal, realDbStorage, realSource] = await Promise.all([
    fsp.realpath(WXDB_MIRROR_ROOT).catch(() => ''),
    fsp.realpath(dbStorage).catch(() => ''),
    fsp.realpath(source).catch(() => ''),
  ]);
  throwIfAborted(signal);
  const sourceInsideAccount = !!(realDbStorage && realSource && isInside(realDbStorage, realSource));
  const validRoot = !!(mirrorRootReal && sourceInsideAccount && isInside(mirrorRootReal, realDbStorage));
  if (!validRoot) {
    const err = new Error('数据库读取源必须来自自动准备的本地工作数据，已拒绝从微信源库或越界路径复制。');
    err.status = 403;
    err.code = 'wxdb_mirror_path_invalid';
    err.public_code = 'wxdb_mirror_path_invalid';
    throw err;
  }
  return { stat: linkStat, realDbStorage, realSource };
}

async function copyDbSidecars(source, target, { signal = null, realDbStorage = '', onProgress = null, progressState = null } = {}) {
  const sidecars = [];
  for (const suffix of SQLITE_PERSISTED_SIDECAR_SUFFIXES) {
    throwIfAborted(signal);
    const from = `${source}${suffix}`;
    const to = `${target}${suffix}`;
    const sidecarLabel = dbSidecarKindLabel(suffix);
    let st = null;
    try {
      st = await fsp.lstat(from);
    } catch (e) {
      if (isMissingFileError(e)) continue;
      throw dbTempCopyError('wxdb_temp_copy_sidecar_unreadable', `微信数据库临时读取数据复制失败：${sidecarLabel}文件不可读，请稍后重试。`, {
        source: from,
        category: path.basename(path.dirname(source)),
        cause: transientDbCopyErrorCause(e),
      });
    }
    throwIfAborted(signal);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw dbTempCopyError('wxdb_temp_copy_sidecar_unreadable', `微信数据库临时读取数据复制失败：${sidecarLabel}文件不是普通文件，请重新刷新本地工作数据后重试。`, {
        source: from,
        category: path.basename(path.dirname(source)),
        cause: st.isSymbolicLink() ? 'sidecar_symlink' : 'sidecar_not_regular',
      });
    }
    if (realDbStorage) {
      const realSidecar = await fsp.realpath(from).catch(() => '');
      if (!realSidecar || !isInside(realDbStorage, realSidecar)) {
        const err = new Error('db sidecar real location is outside selected account db_storage');
        err.status = 403;
        throw err;
      }
    }
    const safeSidecarTarget = await assertSafeTmpPath(to, { label: 'database sidecar temporary copy', ensureParent: true });
    await copyDbArtifactWithSignal(from, safeSidecarTarget.resolved, { signal, onProgress, progressState });
    throwIfAborted(signal);
    const copied = await fsp.stat(safeSidecarTarget.resolved);
    throwIfAborted(signal);
    if (!copied.isFile()) {
      throw dbTempCopyError('wxdb_temp_copy_sidecar_unreadable', `微信数据库临时读取数据复制失败：${sidecarLabel}文件没有复制成普通文件。`, {
        source: from,
        category: path.basename(path.dirname(source)),
        cause: 'sidecar_copy_not_file',
      });
    }
    sidecars.push({
      name: path.basename(from),
      suffix,
      bytes: copied.size,
      last_write_time: st.mtime.toISOString(),
    });
  }
  return sidecars;
}

async function dbCopySourceSnapshot(source, { signal = null } = {}) {
  const files = [
    { file: source, required: true },
    ...SQLITE_PERSISTED_SIDECAR_SUFFIXES.map(suffix => ({ file: `${source}${suffix}`, required: false })),
  ];
  const out = [];
  for (const { file, required } of files) {
    throwIfAborted(signal);
    let st = null;
    const suffix = SQLITE_PERSISTED_SIDECAR_SUFFIXES.find(value => file.endsWith(value)) || '';
    const fileLabel = required ? '源数据库' : dbSidecarKindLabel(suffix);
    try {
      st = await fsp.lstat(file);
    } catch (e) {
      if (isMissingFileError(e) && !required) {
        out.push({
          name: path.basename(file),
          exists: false,
          size: 0,
          mtimeMs: 0,
          ctimeMs: 0,
        });
        continue;
      }
      throw dbTempCopyError('wxdb_temp_copy_sidecar_unreadable', `微信数据库临时读取数据复制失败：${fileLabel}文件不可读，请稍后重试。`, {
        source: file,
        category: path.basename(path.dirname(source)),
        cause: transientDbCopyErrorCause(e),
      });
    }
    throwIfAborted(signal);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw dbTempCopyError('wxdb_temp_copy_sidecar_unreadable', `微信数据库临时读取数据复制失败：${fileLabel}文件不是普通文件，请重新刷新本地工作数据后重试。`, {
        source: file,
        category: path.basename(path.dirname(source)),
        cause: st.isSymbolicLink() ? 'source_snapshot_symlink' : 'source_snapshot_not_regular',
      });
    }
    out.push({
      name: path.basename(file),
      exists: true,
      size: st.size,
      mtimeMs: st.mtimeMs,
      ctimeMs: st.ctimeMs,
    });
  }
  return out;
}

async function assertCopiedDbMatchesPublishedManifest(account = {}, source = '', copiedTarget = '', { signal = null } = {}) {
  throwIfAborted(signal);
  const manifest = verifiedProjectMirrorManifestByAccount.get(account);
  if (!(manifest instanceof Map) || !manifest.size) throw wxdbMirrorManifestChangedError(null, 'locked_manifest_not_verified');
  const root = path.resolve(String(account?.db_storage || ''));
  const sourceRelative = normalizeProjectMirrorRelative(path.relative(root, source));
  if (!sourceRelative || !isInside(root, path.resolve(source))) throw wxdbMirrorManifestChangedError(null, 'copy_source_not_in_manifest_root');
  const hashes = new Map();
  for (const suffix of SQLITE_PERSISTED_COPY_SUFFIXES) {
    throwIfAborted(signal);
    const relative = `${sourceRelative}${suffix}`;
    const expected = manifest.get(relative) || null;
    const sourceFile = suffix ? `${source}${suffix}` : source;
    const copiedFile = suffix ? `${copiedTarget}${suffix}` : copiedTarget;
    const stat = await fsp.lstat(copiedFile).catch(e => {
      if (isMissingFileError(e)) return null;
      throw e;
    });
    if (!expected) {
      if (stat) throw wxdbMirrorManifestChangedError(null, 'unexpected_copied_sidecar');
      continue;
    }
    const sourceStat = await fsp.lstat(sourceFile).catch(e => {
      if (isMissingFileError(e)) return null;
      throw e;
    });
    if (!sourceStat?.isFile?.() || sourceStat.isSymbolicLink?.() || Number(sourceStat.size || 0) !== expected.bytes) {
      throw wxdbMirrorManifestChangedError(null, 'copy_source_manifest_file_missing_or_replaced');
    }
    if (!stat?.isFile?.() || stat.isSymbolicLink?.() || Number(stat.size || 0) !== expected.bytes) {
      throw wxdbMirrorManifestChangedError(null, 'copied_manifest_file_missing_or_replaced');
    }
    const digest = projectMirrorCopyCanTrustPublishedHash(sourceStat, expected)
      ? expected.sha256
      : await sha256CopiedFile(copiedFile, { signal });
    if (digest !== expected.sha256) throw wxdbMirrorManifestChangedError(null, 'copied_manifest_hash_changed');
    hashes.set(suffix || '.db', digest);
  }
  if (!hashes.has('.db')) throw wxdbMirrorManifestChangedError(null, 'copied_db_manifest_missing');
  return hashes;
}

function sameDbCopySourceSnapshot(a = [], b = []) {
  if (a.length !== b.length) return false;
  return a.every((item, index) => {
    const other = b[index] || {};
    return item.name === other.name
      && item.exists === other.exists
      && item.size === other.size
      && item.mtimeMs === other.mtimeMs
      && item.ctimeMs === other.ctimeMs;
  });
}

async function copiedDbContentFingerprint(dbPath, { signal = null, knownHashes = null } = {}) {
  await assertCopiedDbRealPath(dbPath, { signal });
  const parts = [];
  for (const suffix of SQLITE_PERSISTED_COPY_SUFFIXES) {
    throwIfAborted(signal);
    const file = suffix ? `${dbPath}${suffix}` : dbPath;
    const label = suffix || '.db';
    let st = null;
    try {
      st = await fsp.stat(file);
    } catch (e) {
      if (isMissingFileError(e) && suffix) {
        parts.push(`${label}:missing`);
        continue;
      }
      throw dbTempCopyError('wxdb_temp_copy_unreadable', '微信数据库临时读取数据写入后不可读，请稍后重试。', {
        source: file,
        category: path.basename(path.dirname(dbPath)),
        cause: transientDbCopyErrorCause(e),
      });
    }
    if (!st?.isFile()) {
      throw dbTempCopyError(suffix ? 'wxdb_temp_copy_sidecar_unreadable' : 'wxdb_temp_copy_unreadable', suffix
        ? '微信数据库临时读取数据复制失败：WAL 文件没有复制成普通文件。'
        : '微信数据库临时读取数据写入后不是普通文件，请稍后重试。', {
        source: file,
        category: path.basename(path.dirname(dbPath)),
        cause: suffix ? 'copied_sidecar_not_file' : 'copied_db_not_file',
      });
    }
    await assertCopiedDbRealPath(file, { signal });
    const digest = String(knownHashes instanceof Map ? knownHashes.get(label) || '' : '').trim().toLowerCase()
      || await sha256CopiedFile(file, { signal });
    parts.push(`${label}:${st.size}:${digest}`);
  }
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

function sqliteTableExists(db, tableName = '') {
  const name = String(tableName || '').trim();
  if (!db || !name) return false;
  const row = db.prepare("select 1 as ok from sqlite_master where type = 'table' and name = ? limit 1").get([name]);
  return !!row;
}

function sqliteTableHasColumns(db, tableName = '', columns = []) {
  const available = sqliteTableColumnNames(db, tableName);
  if (!available) return false;
  const wanted = (Array.isArray(columns) ? columns : [])
    .map(value => String(value || '').trim())
    .filter(Boolean);
  return wanted.every(column => available.has(column));
}

function sqliteTableColumnNames(db, tableName = '') {
  const name = String(tableName || '').trim();
  if (!sqliteTableExists(db, name)) return null;
  const rows = db.prepare('select name from pragma_table_info(?)').all([name]);
  return new Set(rows.map(row => String(row?.name || '').trim()).filter(Boolean));
}

function isTransientDbCopyError(error) {
  const code = String(error?.code || '');
  if (['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(code)) return true;
  return /being used|busy|no such file|permission|access/i.test(String(error?.message || ''));
}

async function sleepForDbCopyRetry(attempt) {
  await new Promise(resolve => setTimeout(resolve, 120 * (attempt + 1)));
}

export async function readDbInventory(accountId = '', { signal = null, force_mirror = false, onProgress = null } = {}) {
  throwIfAborted(signal);
  notifyProgress(onProgress, {
    phase: 'db_inventory_prepare',
    label: '检查完整本地数据 · 准备工作副本',
    detail: '正在确认当前账号和完整数据库文件范围',
  });
  return withProjectMirrorAccountForRead(accountId, {
    signal,
    autoRefresh: true,
    forceRefresh: force_mirror,
    requiredMirrorScope: 'full',
    reason: 'full',
    onProgress,
  }, async account => {
    notifyProgress(onProgress, {
      phase: 'db_inventory_list',
      label: '检查完整本地数据 · 整理文件清单',
      detail: '本地工作副本已通过校验，正在整理可读数据库文件',
    });
    const files = await listProjectMirrorDbFilesForRead(account, '', { signal });
    throwIfAborted(signal);
    notifyProgress(onProgress, {
      phase: 'db_inventory_ready',
      label: '检查完整本地数据 · 文件清单已就绪',
      detail: `已确认 ${files.length} 个可读数据库文件`,
      total: files.length,
      percent: 100,
    });
    return {
      account: redactAccount(account),
      files: files.map(f => ({
        category: f.category,
        name: f.name,
        bytes: f.bytes,
        last_write_time: f.last_write_time,
      })),
    };
  });
}

function accountIdentityPeerHash(value = '') {
  const peer = String(value || '').trim();
  return peer ? crypto.createHash('sha256').update(peer).digest('hex') : '';
}

export function canonicalAccountIdentityDirectPeers(peers = []) {
  const normalized = [];
  const seen = new Set();
  let invalid = false;
  for (const raw of Array.isArray(peers) ? peers : []) {
    const peer = String(raw || '').trim();
    if (!peer || peer.length > 200 || peer.includes('\0') || peer.endsWith('@chatroom')) {
      invalid = true;
      continue;
    }
    if (seen.has(peer)) continue;
    seen.add(peer);
    normalized.push(peer);
  }
  return { peers: normalized, invalid };
}

export function scanAccountIdentityPeerCandidates(db, tableName = '', peer = '', { candidate_limit = ACCOUNT_IDENTITY_MAX_CANDIDATES_PER_PEER } = {}) {
  const table = String(tableName || '').trim();
  const directPeer = String(peer || '').trim();
  const requestedLimit = Math.max(1, Math.trunc(Number(candidate_limit || 0)) || ACCOUNT_IDENTITY_MAX_CANDIDATES_PER_PEER);
  const candidateLimit = Math.min(requestedLimit, ACCOUNT_IDENTITY_MAX_CANDIDATES_PER_PEER);
  if (!/^Msg_[a-f0-9]{32}$/i.test(table)
    || !directPeer
    || directPeer.length > 200
    || directPeer.includes('\0')
    || directPeer.endsWith('@chatroom')
    || !sqliteTableHasColumns(db, 'Name2Id', ['user_name'])
    || !sqliteTableHasColumns(db, table, ['real_sender_id'])) {
    throw Object.assign(new Error('项目副本缺少账号身份验证所需的发送者索引字段。'), {
      status: 409,
      code: 'wxdb_account_identity_unverified',
      public_code: 'wxdb_account_identity_unverified',
    });
  }
  const rows = db.prepare(`
    select trim(n.user_name) as user_name
    from "${table}" m
    join Name2Id n on n.rowid = m.real_sender_id
    where m.real_sender_id is not null
      and m.real_sender_id <> 0
      and typeof(n.user_name) = 'text'
      and length(trim(n.user_name)) between 1 and 200
      and instr(n.user_name, char(0)) = 0
      and trim(n.user_name) <> ?
      and trim(n.user_name) not like '%@chatroom'
    group by trim(n.user_name)
    order by trim(n.user_name)
    limit ?
  `).all([directPeer, candidateLimit + 1]);
  return {
    candidates: rows.slice(0, candidateLimit).map(row => String(row?.user_name || '')),
    candidate_limit_reached: rows.length > candidateLimit,
  };
}

export function accountIdentityDirectPeerFingerprint(peers = [], { truncated = false } = {}) {
  const canonical = canonicalAccountIdentityDirectPeers(peers);
  if (canonical.invalid) return '';
  const normalized = [...canonical.peers].sort();
  if (!normalized.length || normalized.length > ACCOUNT_IDENTITY_MAX_DIRECT_PEERS) return '';
  return crypto.createHash('sha256').update(JSON.stringify({
    version: ACCOUNT_IDENTITY_SHARD_CACHE_VERSION,
    truncated: truncated === true,
    peers: normalized,
  })).digest('hex');
}

export function accountIdentityShardEvidenceCacheKey({
  account_id = '',
  message_db = '',
  direct_peer_fingerprint = '',
  shard_content_fingerprint = '',
} = {}) {
  const accountId = String(account_id || '').trim().toLowerCase();
  const messageDb = String(message_db || '').trim().toLowerCase();
  const directPeerFingerprint = String(direct_peer_fingerprint || '').trim().toLowerCase();
  const shardContentFingerprint = String(shard_content_fingerprint || '').trim().toLowerCase();
  if (!/^wxacc_[a-f0-9]{16}$/.test(accountId)
    || !/^message_\d+\.db$/.test(messageDb)
    || !/^[a-f0-9]{64}$/.test(directPeerFingerprint)
    || !/^[a-f0-9]{64}$/.test(shardContentFingerprint)) return '';
  return crypto.createHash('sha256').update(JSON.stringify({
    version: ACCOUNT_IDENTITY_SHARD_CACHE_VERSION,
    account_id: accountId,
    message_db: messageDb,
    direct_peer_fingerprint: directPeerFingerprint,
    shard_content_fingerprint: shardContentFingerprint,
  })).digest('hex');
}

function canonicalAccountIdentityShardSupport(rawSupport = []) {
  const rows = [];
  let associations = 0;
  const seenUsers = new Set();
  for (const raw of Array.isArray(rawSupport) ? rawSupport : []) {
    const user = String(raw?.user || '').trim();
    if (!user || user.length > 200 || user.includes('\0') || user.endsWith('@chatroom') || seenUsers.has(user)) return null;
    seenUsers.add(user);
    const peerHashes = [...new Set((Array.isArray(raw?.peer_hashes) ? raw.peer_hashes : [])
      .map(value => String(value || '').trim().toLowerCase()))].sort();
    if (!peerHashes.length
      || peerHashes.length > ACCOUNT_IDENTITY_MAX_MATCHED_PEER_TABLES
      || peerHashes.some(value => !/^[a-f0-9]{64}$/.test(value))) return null;
    associations += peerHashes.length;
    if (associations > ACCOUNT_IDENTITY_MAX_SHARD_CACHE_ASSOCIATIONS) return null;
    rows.push({ user, peer_hashes: peerHashes });
  }
  return rows.sort((left, right) => left.user.localeCompare(right.user));
}

function accountIdentityShardEvidenceHash(entry = {}) {
  return crypto.createHash('sha256').update(JSON.stringify({
    matched_peer_tables: Math.max(0, Number(entry.matched_peer_tables || 0) || 0),
    peer_candidate_limit_reached: entry.peer_candidate_limit_reached === true,
    support: Array.isArray(entry.support) ? entry.support : [],
  })).digest('hex');
}

export function normalizeAccountIdentityShardEvidenceCacheEntry(rawEntry = null, expectedAccountId = '') {
  const value = rawEntry && typeof rawEntry === 'object' && !Array.isArray(rawEntry) ? rawEntry : null;
  if (!value || String(value.version || '') !== ACCOUNT_IDENTITY_SHARD_CACHE_VERSION) return null;
  const accountId = String(value.account_id || '').trim().toLowerCase();
  const expected = String(expectedAccountId || '').trim().toLowerCase();
  const messageDb = String(value.message_db || '').trim().toLowerCase();
  const directPeerFingerprint = String(value.direct_peer_fingerprint || '').trim().toLowerCase();
  const shardContentFingerprint = String(value.shard_content_fingerprint || '').trim().toLowerCase();
  const matchedPeerTables = Number(value.matched_peer_tables);
  const support = canonicalAccountIdentityShardSupport(value.support);
  const cacheKey = accountIdentityShardEvidenceCacheKey({
    account_id: accountId,
    message_db: messageDb,
    direct_peer_fingerprint: directPeerFingerprint,
    shard_content_fingerprint: shardContentFingerprint,
  });
  if (!cacheKey
    || (expected && expected !== accountId)
    || String(value.cache_key || '').trim().toLowerCase() !== cacheKey
    || !Number.isSafeInteger(matchedPeerTables)
    || matchedPeerTables < 0
    || matchedPeerTables > ACCOUNT_IDENTITY_MAX_MATCHED_PEER_TABLES + 1
    || !support) return null;
  const normalized = {
    version: ACCOUNT_IDENTITY_SHARD_CACHE_VERSION,
    account_id: accountId,
    cache_key: cacheKey,
    message_db: messageDb,
    direct_peer_fingerprint: directPeerFingerprint,
    shard_content_fingerprint: shardContentFingerprint,
    matched_peer_tables: matchedPeerTables,
    peer_candidate_limit_reached: value.peer_candidate_limit_reached === true,
    support,
    evidence_hash: '',
  };
  normalized.evidence_hash = accountIdentityShardEvidenceHash(normalized);
  if (String(value.evidence_hash || '').trim().toLowerCase() !== normalized.evidence_hash) return null;
  return normalized;
}

export function createAccountIdentityShardEvidenceCacheEntry({
  account_id = '',
  message_db = '',
  direct_peer_fingerprint = '',
  shard_content_fingerprint = '',
  matched_peer_tables = 0,
  peer_candidate_limit_reached = false,
  support_by_user = new Map(),
} = {}) {
  const support = [];
  for (const [rawUser, rawPeers] of support_by_user instanceof Map ? support_by_user.entries() : []) {
    const peerHashes = [...new Set([...(rawPeers instanceof Set ? rawPeers : new Set(rawPeers || []))]
      .map(accountIdentityPeerHash)
      .filter(Boolean))];
    if (peerHashes.length) support.push({ user: String(rawUser || '').trim(), peer_hashes: peerHashes });
  }
  const cacheKey = accountIdentityShardEvidenceCacheKey({
    account_id,
    message_db,
    direct_peer_fingerprint,
    shard_content_fingerprint,
  });
  if (!cacheKey) return null;
  const entry = {
    version: ACCOUNT_IDENTITY_SHARD_CACHE_VERSION,
    account_id: String(account_id || '').trim().toLowerCase(),
    cache_key: cacheKey,
    message_db: String(message_db || '').trim().toLowerCase(),
    direct_peer_fingerprint: String(direct_peer_fingerprint || '').trim().toLowerCase(),
    shard_content_fingerprint: String(shard_content_fingerprint || '').trim().toLowerCase(),
    matched_peer_tables: Math.max(0, Number(matched_peer_tables || 0) || 0),
    peer_candidate_limit_reached: peer_candidate_limit_reached === true,
    support,
    evidence_hash: '',
  };
  const canonicalSupport = canonicalAccountIdentityShardSupport(entry.support);
  if (!canonicalSupport) return null;
  entry.support = canonicalSupport;
  entry.evidence_hash = accountIdentityShardEvidenceHash(entry);
  return normalizeAccountIdentityShardEvidenceCacheEntry(entry, entry.account_id);
}

function accountIdentityShardContentFingerprint(account = {}, messageFile = {}) {
  const manifest = verifiedProjectMirrorManifestByAccount.get(account) || projectMirrorManifestMap(account, 'identity');
  const accountId = String(account?.account_id || '').trim().toLowerCase();
  const messageDb = String(messageFile?.name || '').trim().toLowerCase();
  const relative = normalizeProjectMirrorRelative(`message/${messageDb}`);
  if (!(manifest instanceof Map)
    || !/^wxacc_[a-f0-9]{16}$/.test(accountId)
    || !/^message_\d+\.db$/.test(messageDb)
    || !relative) return '';
  const files = [];
  for (const suffix of SQLITE_PERSISTED_COPY_SUFFIXES) {
    const item = manifest.get(`${relative}${suffix}`);
    if (!item) continue;
    const sha256 = String(item.sha256 || '').trim().toLowerCase();
    if (!['db', 'sidecar'].includes(String(item.kind || '').trim().toLowerCase())
      || !/^[a-f0-9]{64}$/.test(sha256)) return '';
    files.push({
      relative: `${relative}${suffix}`,
      kind: String(item.kind || '').trim().toLowerCase(),
      bytes: Math.max(0, Number(item.bytes || 0) || 0),
      sha256,
    });
  }
  if (!files.length || files[0].relative !== relative || files[0].kind !== 'db') return '';
  return crypto.createHash('sha256').update(JSON.stringify({
    version: ACCOUNT_IDENTITY_SHARD_CACHE_VERSION,
    account_id: accountId,
    files,
  })).digest('hex');
}

function accountIdentityShardEvidenceEntriesByKey(accountId = '', rawEntries = []) {
  const id = String(accountId || '').trim().toLowerCase();
  const out = new Map();
  for (const raw of (Array.isArray(rawEntries) ? rawEntries : []).slice(0, ACCOUNT_IDENTITY_INCOMING_SHARD_CACHE_LIMIT)) {
    const entry = normalizeAccountIdentityShardEvidenceCacheEntry(raw, id);
    if (entry) out.set(entry.cache_key, entry);
  }
  return out;
}

function mergeAccountIdentityShardEvidence(entry = null, supportByUser = new Map()) {
  if (!entry || !(supportByUser instanceof Map)) return false;
  for (const row of Array.isArray(entry.support) ? entry.support : []) {
    const user = String(row?.user || '').trim();
    if (!user) continue;
    if (!supportByUser.has(user)) supportByUser.set(user, new Set());
    const peers = supportByUser.get(user);
    for (const peerHash of Array.isArray(row?.peer_hashes) ? row.peer_hashes : []) peers.add(peerHash);
  }
  return true;
}

function attachAccountIdentityShardEvidenceCacheEntries(result = null, entries = []) {
  if (!result || typeof result !== 'object') return result;
  Object.defineProperty(result, '__identity_shard_evidence_cache_entries', {
    value: (Array.isArray(entries) ? entries : [])
      .map(entry => normalizeAccountIdentityShardEvidenceCacheEntry(entry, entry?.account_id || ''))
      .filter(Boolean)
      .slice(0, ACCOUNT_IDENTITY_INCOMING_SHARD_CACHE_LIMIT),
    enumerable: false,
  });
  return result;
}

function resolveSelfWxidEvidence({ supportByUser = new Map(), contactUsernames = new Set(), matchedPeerTables = 0, sampledMessageDbs = [] } = {}) {
  const contacts = contactUsernames instanceof Set ? contactUsernames : new Set(contactUsernames || []);
  const candidates = [];
  for (const [rawUser, rawPeers] of supportByUser instanceof Map ? supportByUser.entries() : []) {
    const user = String(rawUser || '').trim();
    const peers = rawPeers instanceof Set ? rawPeers : new Set(rawPeers || []);
    if (!user || user.length > 200 || user.endsWith('@chatroom') || peers.size < 2 || !contacts.has(user)) continue;
    candidates.push({ self_wxid: user, peer_support: peers.size });
  }
  candidates.sort((a, b) => b.peer_support - a.peer_support || a.self_wxid.localeCompare(b.self_wxid));
  if (candidates.length === 1) {
    return {
      ok: true,
      self_wxid: candidates[0].self_wxid,
      peer_support: candidates[0].peer_support,
      matched_peer_tables: Math.max(0, Number(matchedPeerTables || 0) || 0),
      sampled_message_dbs: [...new Set((sampledMessageDbs || []).map(value => String(value || '').trim()).filter(Boolean))],
      evidence: 'direct_message_sender_across_independent_peers',
    };
  }
  const ambiguous = candidates.length > 1;
  throw Object.assign(new Error(ambiguous
    ? '项目副本中出现多个本人账号候选，已拒绝按路径或昵称猜测当前微信账号。'
    : '项目副本中没有足够的一对一消息证据确认本人微信账号；至少需要两个独立会话共同证明。'), {
    status: 409,
    code: ambiguous ? 'wxdb_account_identity_ambiguous' : 'wxdb_account_identity_unverified',
    public_code: ambiguous ? 'wxdb_account_identity_ambiguous' : 'wxdb_account_identity_unverified',
    candidate_count: candidates.length,
    matched_peer_tables: Math.max(0, Number(matchedPeerTables || 0) || 0),
  });
}

function accountIdentityScanLimitError({ directPeerTruncated = false, messageShardTruncated = false, eligibleMessageCount = 0, matchedPeerLimitReached = false, peerCandidateLimitReached = false } = {}) {
  return Object.assign(new Error('当前账号的一对一会话、消息分片或单聊身份候选集合超过身份验证安全硬上限；系统没有按路径、昵称或不完整样本猜测账号。若微信刚切号或正在同步，请等同步稳定后刷新群列表；若持续显示相同上限，当前版本无法安全确认该账号，请在设置页导出诊断记录。'), {
    status: 413,
    code: 'wxdb_account_identity_scan_limit',
    public_code: 'wxdb_account_identity_scan_limit',
    wxdb_diagnostics: compactObject({
      direct_peer_limit: ACCOUNT_IDENTITY_MAX_DIRECT_PEERS,
      message_shard_limit: ACCOUNT_IDENTITY_MAX_MESSAGE_SHARDS,
      eligible_message_shard_count: Math.max(0, Number(eligibleMessageCount || 0) || 0),
      matched_peer_table_limit: ACCOUNT_IDENTITY_MAX_MATCHED_PEER_TABLES,
      candidate_limit_per_peer: ACCOUNT_IDENTITY_MAX_CANDIDATES_PER_PEER,
      direct_peer_truncated: directPeerTruncated,
      message_shard_truncated: messageShardTruncated,
      matched_peer_limit_reached: matchedPeerLimitReached,
      peer_candidate_limit_reached: peerCandidateLimitReached,
    }),
  });
}

function finalizeSelfWxidIdentityScan({
  supportByUser = new Map(),
  contactUsernames = new Set(),
  matchedPeerTables = 0,
  sampledMessageDbs = [],
  directPeerTruncated = false,
  messageShardTruncated = false,
  eligibleMessageCount = 0,
  matchedPeerLimitReached = false,
  peerCandidateLimitReached = false,
} = {}) {
  let evidence = null;
  try {
    evidence = resolveSelfWxidEvidence({ supportByUser, contactUsernames, matchedPeerTables, sampledMessageDbs });
  } catch (error) {
    if (error?.code !== 'wxdb_account_identity_unverified'
      || (!directPeerTruncated && !messageShardTruncated && !matchedPeerLimitReached && !peerCandidateLimitReached)) throw error;
    throw accountIdentityScanLimitError({ directPeerTruncated, messageShardTruncated, eligibleMessageCount, matchedPeerLimitReached, peerCandidateLimitReached });
  }
  if (directPeerTruncated || messageShardTruncated || matchedPeerLimitReached || peerCandidateLimitReached) {
    throw accountIdentityScanLimitError({ directPeerTruncated, messageShardTruncated, eligibleMessageCount, matchedPeerLimitReached, peerCandidateLimitReached });
  }
  return evidence;
}

function accountIdentityEvidenceCacheKey(account = {}) {
  const metadata = accountMirrorScopeMetadata(account, 'identity');
  const snapshotHash = String(metadata?.source_snapshot_meta_hash || account?.mirror?.source_snapshot_meta_hash || '').trim();
  const manifestHash = accountMirrorPublishedManifestHash(account);
  const sourceGenerationHash = String(account?.source_generation_hash || account?.mirror?.source_generation_hash || '').trim().toLowerCase();
  return `${String(account?.account_id || '').trim()}\n${snapshotHash}\n${manifestHash}\n${sourceGenerationHash}`;
}

function rememberAccountIdentityEvidence(account = {}, evidence = {}) {
  const key = accountIdentityEvidenceCacheKey(account);
  if (!key.trim() || !evidence?.self_wxid) return evidence;
  accountIdentityEvidenceCache.set(key, evidence);
  while (accountIdentityEvidenceCache.size > ACCOUNT_IDENTITY_EVIDENCE_CACHE_LIMIT) {
    const oldest = accountIdentityEvidenceCache.keys().next().value;
    if (!oldest) break;
    accountIdentityEvidenceCache.delete(oldest);
  }
  return evidence;
}

async function verifyAndRecordProjectMirrorAccountIdentity(account, rawKeys = [], options = {}) {
  const signal = options.signal || null;
  const expectedReadiness = accountMirrorReadinessTokenForLockedRead(account, 'identity');
  return withWxDbMirrorReadLock(wxDbMirrorLockIdForAccount(account), async () => {
    throwIfAborted(signal);
    const accounts = await discoverWxAccounts({ signal });
    throwIfAborted(signal);
    const accountSelector = account.account_id || account.id || account.wxid || '';
    const lockedAccount = pickAccount(accounts, accountSelector);
    if (!lockedAccount) throw wxdbAccountNotFoundError(accountSelector, 'inside_identity_lock');
    await assertProjectMirrorAccount(lockedAccount, {
      signal,
      allowStaleSource: options.allow_stale_account === true,
    });
    if (!accountMatchesMirrorReadinessToken(lockedAccount, expectedReadiness, 'identity')) {
      throw wxdbMirrorReadinessChangedError(options.onProgress);
    }
    await assertProjectMirrorPublishedManifest(lockedAccount, expectedReadiness.scope, {
      signal,
      onProgress: options.onProgress,
    });
    const identitySnapshotHash = String(accountMirrorScopeMetadata(lockedAccount, 'identity')?.source_snapshot_meta_hash || '').trim().toLowerCase();
    const sourceGenerationHash = String(lockedAccount?.source_generation_hash || lockedAccount?.mirror?.source_generation_hash || '').trim().toLowerCase();
    const key = accountIdentityEvidenceCacheKey(lockedAccount);
    let evidence = key ? accountIdentityEvidenceCache.get(key) : null;
    if (!evidence) {
      evidence = await extractSelfWxidFromProjectMirrorAccount(lockedAccount, rawKeys, options);
      rememberAccountIdentityEvidence(lockedAccount, evidence);
    }
    const recorded = await recordWxDbMirrorAccountIdentity({
      account_id: lockedAccount.account_id,
      self_wxid: evidence.self_wxid,
      evidence,
      expected_published_manifest_hash: accountMirrorPublishedManifestHash(lockedAccount),
      expected_source_generation_hash: sourceGenerationHash,
      expected_identity_snapshot_hash: identitySnapshotHash,
      signal,
    });
    const identityChange = recorded.identity_switched === true ? {
      storage_id: String(recorded.storage_id || '').trim(),
      previous_identity_id: String(recorded.previous_identity_id || '').trim(),
      identity_id: String(recorded.identity_id || '').trim(),
      identity_switched: true,
    } : null;
    if (identityChange) {
      notifyProgress(options.onProgress, {
        phase: 'account_identity_switched',
        label: '确认账号身份 · 已切换到当前微信账号',
        detail: '已用一对一消息证据确认当前账号；旧密钥缓存、群缓存和自动规则不会继承到新账号',
        identity_change: identityChange,
      });
    }
    lockedAccount.storage_id = recorded.storage_id;
    lockedAccount.identity_id = recorded.identity_id;
    lockedAccount.identity_status = 'verified';
    lockedAccount.identity_generation_status = 'verified';
    lockedAccount.identity_generation_verified_at = String(recorded.identity_generation_verified_at || '').trim();
    lockedAccount.identity_generation_changed_at = '';
    lockedAccount.identity_source_generation_hash = String(recorded.identity_source_generation_hash || sourceGenerationHash).trim().toLowerCase();
    lockedAccount.verified_self_wxid = evidence.self_wxid;
    lockedAccount.wxid = evidence.self_wxid;
    if (lockedAccount.mirror && typeof lockedAccount.mirror === 'object') {
      lockedAccount.mirror.identity_id = recorded.identity_id;
      lockedAccount.mirror.identity_status = 'verified';
      lockedAccount.mirror.identity_generation_status = 'verified';
      lockedAccount.mirror.identity_generation_verified_at = String(recorded.identity_generation_verified_at || '').trim();
      lockedAccount.mirror.identity_generation_changed_at = '';
      lockedAccount.mirror.identity_source_generation_hash = String(recorded.identity_source_generation_hash || sourceGenerationHash).trim().toLowerCase();
      lockedAccount.mirror.verified_self_wxid = evidence.self_wxid;
    }
    Object.assign(account, lockedAccount);
    return attachAccountIdentityShardEvidenceCacheEntries({
      ...evidence,
      identity_id: recorded.identity_id,
      storage_id: recorded.storage_id,
      identity_switched: recorded.identity_switched === true,
      identity_change: identityChange,
    }, evidence.__identity_shard_evidence_cache_entries);
  }, { signal });
}

async function extractSelfWxidFromProjectMirrorAccount(account, rawKeys = [], {
  signal = null,
  onProgress = null,
  allow_key_scan = true,
  allow_stale_account = false,
  identity_shard_evidence_cache_entries = [],
} = {}) {
  await assertProjectMirrorAccount(account, { signal, allowStaleSource: allow_stale_account === true });
  const rawKeyPool = uniqueStrings(rawKeys);
  const contactFile = path.join(account.db_storage, 'contact', 'contact.db');
  const sessionFile = path.join(account.db_storage, 'session', 'session.db');
  const allMessageFiles = (await listProjectMirrorDbFilesForRead(account, 'message', { signal }))
    .filter(file => /^message_\d+\.db$/i.test(String(file?.name || '')));
  if (!allMessageFiles.length) {
    throw Object.assign(new Error('项目副本缺少消息分片，无法确认本人微信账号。'), {
      status: 409,
      code: 'wxdb_account_identity_unverified',
      public_code: 'wxdb_account_identity_unverified',
    });
  }
  const identityScope = accountMirrorScopeMetadata(account, 'identity');
  const eligibleMessageCount = Math.max(allMessageFiles.length, Number(identityScope.eligible_message_count || 0) || 0);
  const messageShardTruncated = eligibleMessageCount > ACCOUNT_IDENTITY_MAX_MESSAGE_SHARDS;
  const messageFiles = accountIdentityMessageShardCandidates(allMessageFiles);
  let contact = null;
  let session = null;
  const supportByUser = new Map();
  const sampledMessageDbs = [];
  let matchedPeerTables = 0;
  let directPeerTruncated = false;
  let matchedPeerLimitReached = false;
  let peerCandidateLimitReached = false;
  const returnedShardEvidence = [];
  try {
    notifyProgress(onProgress, {
      phase: 'account_identity_open',
      label: '确认账号身份 · 打开项目副本',
      detail: '从项目副本准备联系人、会话和最小消息分片的临时读取数据，不直接查询微信源库',
    });
    contact = await openCopiedSqlCipherDb(account, contactFile, rawKeyPool, { signal, onProgress, allow_key_scan, allow_stale_account });
    prioritizeRawKeyCandidate(rawKeyPool, contact.raw_key);
    session = await openCopiedSqlCipherDb(account, sessionFile, rawKeyPool, { signal, onProgress, allow_key_scan, allow_stale_account });
    prioritizeRawKeyCandidate(rawKeyPool, session.raw_key);
    if (!sqliteTableHasColumns(contact.db, 'contact', ['username'])
      || !sqliteTableHasColumns(session.db, 'SessionTable', ['username'])) {
      throw Object.assign(new Error('项目副本缺少账号身份验证所需的联系人或会话字段。'), {
        status: 409,
        code: 'wxdb_account_identity_unverified',
        public_code: 'wxdb_account_identity_unverified',
      });
    }
    const contactUsernames = new Set();
    const contactLookup = contact.db.prepare("select username from contact where username = ? and username is not null and username <> '' limit 1");
    const sessionColumns = sqliteTableColumnNames(session.db, 'SessionTable') || new Set();
    const directPeerOrder = sessionColumns.has('sort_timestamp') ? 'max(cast(sort_timestamp as integer)) desc' : 'max(rowid) desc';
    const directPeerRows = session.db.prepare(`select username from SessionTable where username is not null and username <> '' and username not like '%@chatroom' group by username order by ${directPeerOrder} limit ?`).all([ACCOUNT_IDENTITY_MAX_DIRECT_PEERS + 1]);
    directPeerTruncated = directPeerRows.length > ACCOUNT_IDENTITY_MAX_DIRECT_PEERS;
    const canonicalDirectPeers = canonicalAccountIdentityDirectPeers(
      directPeerRows.slice(0, ACCOUNT_IDENTITY_MAX_DIRECT_PEERS).map(row => row?.username),
    );
    if (canonicalDirectPeers.invalid) {
      throw accountIdentityScanLimitError({ directPeerTruncated: true, messageShardTruncated, eligibleMessageCount });
    }
    const directPeers = canonicalDirectPeers.peers;
    const accountId = String(account.account_id || '').trim().toLowerCase();
    const directPeerFingerprint = accountIdentityDirectPeerFingerprint(directPeers, { truncated: directPeerTruncated });
    const cachedShardEvidence = accountIdentityShardEvidenceEntriesByKey(accountId, identity_shard_evidence_cache_entries);
    identityShardLoop:
    for (const messageFile of messageFiles) {
      throwIfAborted(signal);
      const shardContentFingerprint = accountIdentityShardContentFingerprint(account, messageFile);
      const shardCacheKey = accountIdentityShardEvidenceCacheKey({
        account_id: accountId,
        message_db: messageFile.name,
        direct_peer_fingerprint: directPeerFingerprint,
        shard_content_fingerprint: shardContentFingerprint,
      });
      let shardEvidence = shardCacheKey ? cachedShardEvidence.get(shardCacheKey) : null;
      if (shardEvidence) {
        notifyProgress(onProgress, {
          phase: 'account_identity_sample_cached',
          label: '确认账号身份 · 复用未变化消息证据',
          detail: `${messageFile.name}：数据库、WAL 和一对一会话集合均未变化，无需再次解密`,
        });
      }
      let opened = null;
      try {
        if (!shardEvidence) {
          notifyProgress(onProgress, {
            phase: 'account_identity_sample',
            label: '确认账号身份 · 核对一对一会话',
            detail: `${messageFile.name}：按文件从小到大验证本人发送者证据`,
          });
          opened = await openCopiedSqlCipherDb(account, messageFile.path, rawKeyPool, { signal, onProgress, allow_key_scan, allow_stale_account });
          prioritizeRawKeyCandidate(rawKeyPool, opened.raw_key);
          const shardSupportByUser = new Map();
          let shardMatchedPeerTables = 0;
          let shardPeerCandidateLimitReached = false;
          if (sqliteTableHasColumns(opened.db, 'Name2Id', ['user_name'])) {
            const tableNames = new Set(opened.db.prepare("select name from sqlite_master where type = 'table' and name like 'Msg_%'").all()
              .map(row => String(row?.name || '').trim())
              .filter(name => /^Msg_[a-f0-9]{32}$/i.test(name)));
            for (const peer of directPeers) {
              const tableName = `Msg_${crypto.createHash('md5').update(peer).digest('hex')}`;
              if (!tableNames.has(tableName)) continue;
              shardMatchedPeerTables += 1;
              if (shardMatchedPeerTables > ACCOUNT_IDENTITY_MAX_MATCHED_PEER_TABLES) {
                matchedPeerLimitReached = true;
                break;
              }
              const peerCandidates = scanAccountIdentityPeerCandidates(opened.db, tableName, peer);
              if (peerCandidates.candidate_limit_reached) shardPeerCandidateLimitReached = true;
              for (const user of peerCandidates.candidates) {
                if (!shardSupportByUser.has(user)) shardSupportByUser.set(user, new Set());
                shardSupportByUser.get(user).add(peer);
              }
            }
          }
          shardEvidence = createAccountIdentityShardEvidenceCacheEntry({
            account_id: accountId,
            message_db: messageFile.name,
            direct_peer_fingerprint: directPeerFingerprint,
            shard_content_fingerprint: shardContentFingerprint,
            matched_peer_tables: shardMatchedPeerTables,
            peer_candidate_limit_reached: shardPeerCandidateLimitReached,
            support_by_user: shardSupportByUser,
          });
          if (!shardEvidence) {
            for (const [user, peers] of shardSupportByUser) {
              if (!supportByUser.has(user)) supportByUser.set(user, new Set());
              for (const peer of peers) supportByUser.get(user).add(accountIdentityPeerHash(peer));
            }
            matchedPeerTables += shardMatchedPeerTables;
            peerCandidateLimitReached ||= shardPeerCandidateLimitReached;
          }
        }
        if (shardEvidence) {
          mergeAccountIdentityShardEvidence(shardEvidence, supportByUser);
          matchedPeerTables += shardEvidence.matched_peer_tables;
          matchedPeerLimitReached ||= shardEvidence.matched_peer_tables > ACCOUNT_IDENTITY_MAX_MATCHED_PEER_TABLES;
          peerCandidateLimitReached ||= shardEvidence.peer_candidate_limit_reached;
          returnedShardEvidence.push(shardEvidence);
        }
        sampledMessageDbs.push(messageFile.name);
      } finally {
        await closeCopiedDbHandle(opened);
      }
    }
    for (const [user, peers] of supportByUser) {
      if (peers.size >= 2 && contactLookup.get([user])?.username) contactUsernames.add(user);
    }
    return attachAccountIdentityShardEvidenceCacheEntries(finalizeSelfWxidIdentityScan({
      supportByUser,
      contactUsernames,
      matchedPeerTables,
      sampledMessageDbs,
      directPeerTruncated,
      messageShardTruncated,
      eligibleMessageCount,
      matchedPeerLimitReached,
      peerCandidateLimitReached,
    }), returnedShardEvidence);
  } catch (error) {
    attachAccountIdentityShardEvidenceCacheEntries(error, returnedShardEvidence);
    throw error;
  } finally {
    await closeCopiedDbHandle(session);
    await closeCopiedDbHandle(contact);
  }
}

export async function extractSelfWxidFromProjectCopy({ account_id = '', raw_keys = [], signal = null, mirror_readiness = null, onProgress = null, allow_key_scan = true, auto_refresh = true, allow_stale_account = false, identity_shard_evidence_cache_entries = [] } = {}) {
  throwIfAborted(signal);
  return withProjectMirrorAccountForRead(account_id, {
    signal,
    autoRefresh: auto_refresh !== false,
    mirrorReadiness: mirror_readiness,
    requiredMirrorScope: 'identity',
    reason: 'identity',
    onProgress,
    allowStaleSource: allow_stale_account === true,
  }, account => verifyAndRecordProjectMirrorAccountIdentity(account, raw_keys, {
    signal,
    onProgress,
    allow_key_scan,
    allow_stale_account,
    identity_shard_evidence_cache_entries,
  }));
}

function chatroomRequiredMirrorScope(requestedMirrorScope = 'digest', account = {}) {
  const normalized = normalizeMirrorReadinessScope(requestedMirrorScope);
  const requested = ['groups', 'identity'].includes(normalized) ? normalized : 'digest';
  return requested === 'groups' && !isWxDbMirrorIdentityVerified(account)
    ? 'identity'
    : requested;
}

function groupsIdentityScopeRetryError() {
  const error = new Error('群列表工作副本的账号身份尚未完成当前代次验证。');
  error.code = 'wxdb_groups_identity_scope_required';
  return error;
}

export async function listChatroomsFromWxDb({ account_id = '', raw_keys = [], signal = null, mirror_scope = 'digest', mirror_readiness = null, onProgress = null, allow_key_scan = true, allow_stale_account = false, identity_shard_evidence_cache_entries = [] } = {}) {
  throwIfAborted(signal);
  const normalizedRequestedScope = normalizeMirrorReadinessScope(mirror_scope);
  const requestedMirrorScope = ['groups', 'identity'].includes(normalizedRequestedScope) ? normalizedRequestedScope : 'digest';
  notifyProgress(onProgress, {
    phase: 'groups_account',
    label: '读取群列表 · 确认当前账号',
    detail: account_id ? '使用当前选择的账号' : '使用默认可读账号',
  });
  const readGroups = async (readMirrorScope, readMirrorReadiness) => withProjectMirrorAccountForRead(account_id, { signal, autoRefresh: true, mirrorReadiness: readMirrorReadiness, requiredMirrorScope: readMirrorScope, reason: readMirrorScope, onProgress, allowStaleSource: allow_stale_account === true }, async account => {

  if (chatroomRequiredMirrorScope(readMirrorScope, account) !== readMirrorScope) {
    throw groupsIdentityScopeRetryError();
  }

  const rawKeyPool = uniqueStrings(raw_keys);
  let returnedIdentityShardEvidenceCacheEntries = [];
  const identityAlreadyVerified = isWxDbMirrorIdentityVerified(account);
  if (identityAlreadyVerified) {
    notifyProgress(onProgress, {
      phase: 'groups_account_bound',
      label: '读取群列表 · 已确认当前账号',
      detail: '已复用此前验证过的当前账号身份；先读取 contact.db，最近消息排序仅在本批次副本同时包含 session.db 时补充',
    });
  } else {
    const identityEvidence = await verifyAndRecordProjectMirrorAccountIdentity(account, rawKeyPool, {
      signal,
      onProgress,
      allow_key_scan,
      allow_stale_account,
      identity_shard_evidence_cache_entries,
    });
    returnedIdentityShardEvidenceCacheEntries = Array.isArray(identityEvidence?.__identity_shard_evidence_cache_entries)
      ? identityEvidence.__identity_shard_evidence_cache_entries
      : [];
    notifyProgress(onProgress, {
      phase: 'groups_account_bound',
      label: '读取群列表 · 已确认当前账号',
      detail: '已用项目副本中的联系人、会话和消息证据确认当前微信本人账号',
    });
  }
  throwIfAborted(signal);
  const contactFile = path.join(account.db_storage, 'contact', 'contact.db');
  const sessionFile = path.join(account.db_storage, 'session', 'session.db');
  const sessionDbRef = {
    category: 'session',
    name: 'session.db',
  };
  const sessionManifestScope = projectMirrorScopeIncludesDbFile(account, readMirrorScope, sessionDbRef)
    ? readMirrorScope
    : '';
  let contact = null;
  let session = null;
  try {
    notifyProgress(onProgress, {
      phase: 'groups_open_contact',
      label: '读取群列表 · 打开 contact.db',
      detail: '准备临时读取数据后验证密钥并只读打开',
    });
    contact = await openCopiedSqlCipherDb(account, contactFile, rawKeyPool, { signal, onProgress, allow_key_scan, allow_stale_account });
    prioritizeRawKeyCandidate(rawKeyPool, contact.raw_key);
    throwIfAborted(signal);
    if (sessionManifestScope) {
      notifyProgress(onProgress, {
        phase: 'groups_open_session',
        label: '读取群列表 · 打开 session.db',
        detail: '读取最近消息时间用于排序；失败时仍会保留 contact.db 群列表',
      });
      session = await openCopiedSqlCipherDb(account, sessionFile, rawKeyPool, { signal, onProgress, allow_key_scan, allow_stale_account }).catch(e => {
        if (e?.status === 499 || signal?.aborted) throw e;
        throwIfMirrorReadGenerationChanged(e);
        notifyProgress(onProgress, {
          phase: 'groups_session_skipped',
          label: '读取群列表 · session.db 不可用',
          detail: `session.db 仅用于最近消息排序；本次降级继续读取群名：${sanitizeWxdbDiagnosticError(e?.message || e || '未知错误').slice(0, 120)}`,
          session_unavailable_reason: 'optional_session_open_failed',
        });
        return null;
      });
    } else {
      notifyProgress(onProgress, {
        phase: 'groups_session_not_in_scope',
        label: '读取群列表 · 跳过最近消息排序',
        detail: '当前群列表副本没有包含同批次复核的 session.db；已跳过旧会话副本，避免把过期时间、未读数或旧会话群当作当前数据',
        session_unavailable_reason: 'optional_session_not_in_scope',
      });
    }
    if (session?.raw_key) prioritizeRawKeyCandidate(rawKeyPool, session.raw_key);
    throwIfAborted(signal);
    notifyProgress(onProgress, {
      phase: 'groups_query_contact',
      label: '读取群列表 · 查询群名和成员数',
      detail: '从 contact.db 读取群聊、拼音和成员计数',
    });
    const chatroomMemberAvailable = sqliteTableHasColumns(contact.db, 'chatroom_member', ['room_id', 'member_id']);
    const rows = contact.db.prepare(chatroomMemberAvailable ? `
      select
        c.username as id,
        coalesce(nullif(c.nick_name, ''), c.username) as name,
        c.quan_pin as quan_pin,
        c.pin_yin_initial as pin_yin_initial,
        c.chat_room_type as chat_room_type,
        count(cm.member_id) as members
      from contact c
      left join chatroom_member cm on cm.room_id = c.id
      where c.username like '%@chatroom' and coalesce(c.delete_flag, 0) = 0
      group by c.id
      order by c.username
    ` : `
      select
        c.username as id,
        coalesce(nullif(c.nick_name, ''), c.username) as name,
        c.quan_pin as quan_pin,
        c.pin_yin_initial as pin_yin_initial,
        c.chat_room_type as chat_room_type,
        0 as members
      from contact c
      where c.username like '%@chatroom' and coalesce(c.delete_flag, 0) = 0
      order by c.username
    `).all();
    if (!chatroomMemberAvailable) {
      notifyProgress(onProgress, {
        phase: 'groups_member_count_skipped',
        label: '读取群列表 · 成员计数不可用',
        detail: 'contact.db 没有可用的 chatroom_member 表/列，本次成员数按 0 显示，不影响选择群和读取消息',
      });
    }

    notifyProgress(onProgress, {
      phase: 'groups_query_session',
      label: '读取群列表 · 查询最近消息时间',
      detail: session ? '从 session.db 读取 last_timestamp/sort_timestamp' : 'session.db 不可用，使用群名列表继续',
    });
    let sessionRows = [];
    let sessionAvailable = !!session;
    if (session) {
      try {
        const sessionColumns = sqliteTableColumnNames(session.db, 'SessionTable');
        if (!sessionColumns?.has('username')) throw new Error('SessionTable 缺少 username 列');
        const optionalSessionColumns = [
          ['last_timestamp', '0'],
          ['sort_timestamp', '0'],
          ['summary', "''"],
          ['unread_count', '0'],
          ['last_msg_type', '0'],
        ];
        const selectColumns = [
          'username',
          ...optionalSessionColumns.map(([name, fallback]) => sessionColumns.has(name) ? name : `${fallback} as ${name}`),
        ];
        sessionRows = session.db.prepare(`select ${selectColumns.join(', ')} from SessionTable`).all();
        const missingOptionalColumns = optionalSessionColumns
          .map(([name]) => name)
          .filter(name => !sessionColumns.has(name));
        if (missingOptionalColumns.length) {
          notifyProgress(onProgress, {
            phase: 'groups_session_schema_partial',
            label: '读取群列表 · session.db 兼容读取',
            detail: `SessionTable 缺少非核心列 ${missingOptionalColumns.join('、')}，已用默认值继续保留会话群列表`,
            missing_columns: missingOptionalColumns,
          });
        }
      } catch (e) {
        if (e?.status === 499 || signal?.aborted) throw e;
        sessionRows = [];
        sessionAvailable = false;
        notifyProgress(onProgress, {
          phase: 'groups_session_schema_skipped',
          label: '读取群列表 · session.db 结构不兼容',
          detail: `会继续读取群名，但最近消息排序可能不完整：${sanitizeWxdbDiagnosticError(e?.message || e || '未知错误').slice(0, 120)}`,
        });
      }
    }
    const sessions = new Map(sessionRows.map(row => [row.username, row]));

    const groupsById = new Map();
    for (const row of rows) {
      const s = sessions.get(row.id) || {};
      const name = String(row.name || row.id);
      const search = groupSearchFields(name, row.quan_pin, row.pin_yin_initial);
      const lastMessage = normalizeSessionLastMessageEvidence(s, { sessionAvailable });
      groupsById.set(String(row.id), {
        id: String(row.id),
        name,
        members: Number(row.members || 0),
        last_msg_at: lastMessage.timestamp,
        last_msg_status: lastMessage.status,
        pinyin: search.pinyin,
        pinyin_initial: search.pinyin_initial,
        source: 'wxdb',
        unread_count: Number(s.unread_count || 0),
      });
    }
    let sessionOnlyChatroomRows = 0;
    if (sessionAvailable) {
      for (const row of sessionRows) {
        const id = String(row?.username || '').trim();
        if (!id.endsWith('@chatroom') || groupsById.has(id)) continue;
        sessionOnlyChatroomRows++;
        const lastMessage = normalizeSessionLastMessageEvidence(row, { sessionAvailable });
        groupsById.set(id, {
          id,
          name: id,
          members: 0,
          last_msg_at: lastMessage.timestamp,
          last_msg_status: lastMessage.status,
          pinyin: '',
          pinyin_initial: '',
          source: 'wxdb',
          source_detail: 'session_only',
          unread_count: Number(row.unread_count || 0),
        });
      }
    }
    throwIfAborted(signal);
    const groups = [...groupsById.values()].sort((a, b) => (b.last_msg_at || 0) - (a.last_msg_at || 0));
    const sessionChatroomRows = sessionRows.filter(row => String(row?.username || '').trim().endsWith('@chatroom')).length;
    if (!groups.length) {
      const err = new Error('contact.db 和 session.db 均未读到任何群聊；已停止返回空群列表，避免把密钥、账号或本地数据问题误判为“没有群”。请刷新账号或稍后重试。');
      err.status = 409;
      err.code = 'wxdb_group_list_empty_unverified';
      err.public_code = err.code;
      err.wxdb_diagnostics = compactObject({
        contact_chatroom_row_count: rows.length,
        session_available: sessionAvailable,
        session_row_count: sessionRows.length,
        session_chatroom_row_count: sessionChatroomRows,
        session_only_chatroom_row_count: sessionOnlyChatroomRows,
        chatroom_member_available: chatroomMemberAvailable,
        account: redactAccount(account),
      });
      throw err;
    }
    notifyProgress(onProgress, {
      phase: 'groups_sort',
      label: '读取群列表 · 已整理群列表',
      detail: `contact ${rows.length} 条，会话 ${sessionRows.length} 条，session-only ${sessionOnlyChatroomRows} 条，输出 ${groups.length} 个群`,
    });
    Object.defineProperty(groups, '__verified_raw_keys', {
      value: uniqueStrings([contact.raw_key, session?.raw_key].filter(Boolean)),
      enumerable: false,
    });
    Object.defineProperty(groups, '__verified_account', {
      value: redactAccount(account),
      enumerable: false,
    });
    attachAccountIdentityShardEvidenceCacheEntries(groups, returnedIdentityShardEvidenceCacheEntries);
    return groups;
  } finally {
    await closeCopiedDbHandle(contact);
    await closeCopiedDbHandle(session);
  }
  });
  try {
    return await readGroups(requestedMirrorScope, mirror_readiness);
  } catch (error) {
    if (requestedMirrorScope !== 'groups' || String(error?.code || '') !== 'wxdb_groups_identity_scope_required') throw error;
    notifyProgress(onProgress, {
      phase: 'groups_identity_recheck',
      label: '读取群列表 · 重新确认当前账号',
      detail: '群列表工作副本已变化，正在准备最小身份消息样本重新确认账号；不会混用旧消息分片或返回未确认账号的群列表',
    });
    return readGroups('identity', null);
  }
}

export async function collectMessagesFromWxDb({ account_id = '', group_id, since, until, since_ms = undefined, until_ms = undefined, raw_keys = [], signal, onProgress = null, pre_media_filter = null, sender_filter_active = false, sender_filter_terms = [], fallback_sensitive_filter_active = false, min_messages = 0, mirror_readiness = null, skip_media_enrichment = false, media_enrichment_skip_reason = '', allow_key_scan = true, allow_stale_account = false, shard_row_positions = {}, shard_row_positions_initialized = false, identity_shard_evidence_cache_entries = [] } = {}) {
  throwIfAborted(signal);
  if (!group_id) {
    throw Object.assign(new Error('请先选择一个本机微信会话。'), { status: 400, code: 'group_missing', public_code: 'group_missing' });
  }
  if (!since) {
    throw Object.assign(new Error('请提供起始时间，避免误读全部历史消息。'), { status: 400, code: 'since_missing', public_code: 'since_missing' });
  }
  notifyProgress(onProgress, {
    phase: 'fetch_account',
    label: '拉取消息 · 定位微信账号',
    detail: account_id ? '使用当前选择的账号' : '使用默认可读账号',
  });
  return withProjectMirrorAccountForRead(account_id, { signal, autoRefresh: true, mirrorReadiness: mirror_readiness, requiredMirrorScope: 'digest', reason: 'digest', onProgress, allowStaleSource: allow_stale_account === true }, async account => {
  const mirrorSnapshot = accountMirrorScopeMetadata(account, 'digest');
  const tableName = `Msg_${crypto.createHash('md5').update(group_id).digest('hex')}`;
  const allDbFiles = (await listProjectMirrorDbFilesForRead(account, 'message', { signal }))
    .filter(f => /^message_\d+\.db$/i.test(f.name))
    .sort(compareMessageShardsByLastWriteDesc);
  assertMessageShardCountSupported(allDbFiles);
  if (!allDbFiles.length) {
    throw Object.assign(new Error(`未找到微信消息分片 message_*.db，无法读取该会话消息。账号目录：${path.basename(account.account_root || account.db_storage || '') || '未知'}`), { status: 502, code: 'wxdb_message_shards_missing', public_code: 'wxdb_message_shards_missing' });
  }
  const rawKeyPool = uniqueStrings(raw_keys);
  const verifiedMessageRawKeys = [];
  const accountIdentity = await verifyAndRecordProjectMirrorAccountIdentity(account, rawKeyPool, {
    signal,
    onProgress,
    allow_key_scan,
    allow_stale_account,
    identity_shard_evidence_cache_entries,
  });
  const attachCollectedIdentityEvidence = result => attachAccountIdentityShardEvidenceCacheEntries(
    result,
    accountIdentity?.__identity_shard_evidence_cache_entries,
  );

  const hasSinceEpoch = since_ms !== undefined && since_ms !== null && since_ms !== '';
  const hasUntilEpoch = until_ms !== undefined && until_ms !== null && until_ms !== '';
  if (hasSinceEpoch !== hasUntilEpoch) {
    throw Object.assign(new Error('时间范围必须同时包含起止时间戳。'), { status: 400, code: 'time_epoch_incomplete', public_code: 'time_epoch_incomplete' });
  }
  const sinceEpochMs = hasSinceEpoch ? toEpochMs(since_ms, '起始时间') : null;
  const untilEpochMs = hasUntilEpoch ? toEpochMs(until_ms, '结束时间') : null;
  const sinceTs = hasSinceEpoch ? Math.floor(sinceEpochMs / 1000) : toUnixSeconds(since, 0, '起始时间');
  const untilTs = hasUntilEpoch ? Math.floor(untilEpochMs / 1000) : toUnixSeconds(until, Math.floor(Date.now() / 1000), '结束时间', { endOfMinuteWhenSecondsMissing: true });
  if (sinceTs > untilTs) {
    throw Object.assign(new Error('起始时间不能晚于结束时间。'), { status: 400, code: 'time_range_invalid', public_code: 'time_range_invalid' });
  }
  const timeBounds = messageTimeBounds(sinceTs, untilTs, { since_ms: sinceEpochMs, until_ms: untilEpochMs });
  // File mtimes are telemetry, not content proof. We must open every message
  // shard and decide by the target table's create_time/sort_seq rows.
  const dbFiles = allDbFiles;
  const beforeRangeMtimeShardCount = allDbFiles
    .filter(file => messageShardMtimeRelationToRange(file.last_write_time, timeBounds) === 'before_range_start')
    .length;
  const afterRangeMtimeShardCount = allDbFiles
    .filter(file => messageShardMtimeRelationToRange(file.last_write_time, timeBounds) === 'after_range_end')
    .length;
  const skippedBeforeRangeShardCount = 0;
  throwIfAborted(signal);
  notifyProgress(onProgress, {
    phase: 'fetch_shards',
    label: '拉取消息 · 筛选消息分片',
    detail: beforeRangeMtimeShardCount || afterRangeMtimeShardCount
      ? `发现 ${allDbFiles.length} 个 message_*.db，文件写入时间仅作诊断（早于范围 ${beforeRangeMtimeShardCount} 个，晚于范围 ${afterRangeMtimeShardCount} 个），全部打开后按表内消息时间检查`
      : `发现 ${allDbFiles.length} 个 message_*.db，全部打开后按表内消息时间检查`,
  }, { signal });
  if (!dbFiles.length) {
    const shardWriteSummary = summarizeMessageShardWriteTimes(allDbFiles);
    const result = {
      source: 'wxdb',
      account: redactAccount(account),
      mirror_snapshot: mirrorSnapshot,
      group_id,
      table: tableName,
      messages: [],
      scanned_message_count: 0,
      pre_filter_message_count: 0,
      pre_media_filtered_count: 0,
      searched_shard_count: allDbFiles.length,
      candidate_shard_count: 0,
      skipped_before_range_shard_count: skippedBeforeRangeShardCount,
      mtime_before_range_shard_count: beforeRangeMtimeShardCount,
      mtime_after_range_shard_count: afterRangeMtimeShardCount,
      readable_shard_count: 0,
      matching_shard_count: 0,
      table_row_count: 0,
      window_hit_count: 0,
      query_time_bounds: timeBounds,
      message_table_time_range: null,
      message_shards_last_write_time: shardWriteSummary.newest_time,
      all_message_shards_before_range: true,
      sender_hydration: null,
      truncated: false,
    };
    Object.defineProperty(result, '__verified_raw_keys', {
      value: [],
      enumerable: false,
    });
    return attachCollectedIdentityEvidence(result);
  }
  const out = [];
  const shardErrors = [];
  const tableTimeStats = [];
  const previousShardRowPositions = normalizeMessageShardRowPositions(shard_row_positions);
  const observedShardRowPositions = {};
  const rowPositionsInitialized = shard_row_positions_initialized === true;
  let lateSyncIncrementalMessageCount = 0;
  let lateSyncIncrementalOutOfRangeCount = 0;
  let readableShards = 0;
  let matchingShards = 0;
  let duplicateMessageCount = 0;
  let normalizedMessagePayloadBytes = 0;
  const shardWriteSummary = summarizeMessageShardWriteTimes(allDbFiles);
  const allMessageShardsBeforeRange = messageShardWritesBeforeRange(shardWriteSummary, timeBounds);

  let shardIndex = 0;
  for (const file of dbFiles) {
    throwIfAborted(signal);
    shardIndex += 1;
      notifyProgress(onProgress, {
        phase: 'fetch_shard',
        label: '拉取消息 · 准备消息分片',
        detail: `${shardIndex}/${dbFiles.length} ${file.name}：准备本次临时读取数据`,
      });
    let opened = null;
    try {
      notifyProgress(onProgress, {
        phase: 'fetch_shard_opening',
        label: '拉取消息 · 打开消息分片',
        detail: `${shardIndex}/${dbFiles.length} ${file.name}：正在创建临时读取数据并只读打开`,
      });
      opened = await openMessageSqlCipherDb(account, file.path, rawKeyPool, { signal, onProgress, allow_key_scan, allow_stale_account });
      prioritizeRawKeyCandidate(rawKeyPool, opened.raw_key);
      prioritizeRawKeyCandidate(verifiedMessageRawKeys, opened.raw_key);
      readableShards++;
      throwIfAborted(signal);
      notifyProgress(onProgress, {
        phase: 'fetch_shard_opened',
        label: '拉取消息 · 消息分片已打开',
        detail: `${shardIndex}/${dbFiles.length} 已只读打开，检查会话表`,
      });
      const exists = opened.db.prepare('select name from sqlite_master where type = ? and name = ?').get(['table', tableName]);
      if (!exists) continue;
      matchingShards++;
      const currentShardRowId = messageTableMaxRowId(opened.db, tableName);
      const shardCursor = messageShardCursorState(file, previousShardRowPositions, {
        db: opened.db,
        table_name: tableName,
      });
      const hasPreviousShardPosition = shardCursor.has_previous;
      const previousShardRowId = shardCursor.previous_row_id;
      if (rowPositionsInitialized && shardCursor.reset_reason && shardCursor.reset_reason !== 'missing') {
        notifyProgress(onProgress, {
          phase: 'fetch_shard_cursor_reset',
          label: '拉取消息 · 重新核对分片水位',
          detail: `${file.name} 的旧增量水位缺少连续性证明，已从头执行有界补读`,
          reset_reason: shardCursor.reset_reason,
        });
      }
      if (rowPositionsInitialized && hasPreviousShardPosition && currentShardRowId < previousShardRowId) {
        throw Object.assign(new Error(`${file.name} 的会话表 rowid 从 ${previousShardRowId} 回退到 ${currentShardRowId}，本地工作数据可能已重建。已停止推进调度游标，避免静默漏掉迟到消息；请刷新本地工作数据后重试。`), {
          status: 409,
          code: 'wxdb_message_shard_position_reset',
          public_code: 'wxdb_message_shard_position_reset',
        });
      }
      const shouldReadIncrementalRows = rowPositionsInitialized
        && (!hasPreviousShardPosition || currentShardRowId > previousShardRowId);
      const createTimePayloadStats = messageRowsPayloadStatsByTimeColumn(opened.db, tableName, 'create_time', timeBounds, MAX_MESSAGE_ROWS_PER_DIGEST + 1);
      let shardRawPayloadBytes = assertMessagePayloadBudget(createTimePayloadStats, {
        shard: file.name,
        timeSource: 'create_time',
      });
      let incrementalRows = [];
      if (shouldReadIncrementalRows) {
        const incrementalPayloadStats = messageRowsPayloadStatsByRowIdRange(opened.db, tableName, previousShardRowId, currentShardRowId, MAX_MESSAGE_ROWS_PER_DIGEST + 1);
        shardRawPayloadBytes = assertMessagePayloadBudget(incrementalPayloadStats, {
          cumulativeBytes: shardRawPayloadBytes,
          shard: file.name,
          timeSource: 'incremental_rowid',
        });
        if (incrementalPayloadStats.row_count > MAX_MESSAGE_ROWS_PER_DIGEST) {
          throw Object.assign(new Error(`${file.name} 新增消息行至少 ${incrementalPayloadStats.row_count} 条，超过单次调度安全上限 ${MAX_MESSAGE_ROWS_PER_DIGEST} 条。已停止推进游标，避免静默截断迟到消息。`), {
            status: 413,
            code: 'wxdb_message_incremental_window_too_large',
            public_code: 'wxdb_message_incremental_window_too_large',
          });
        }
        incrementalRows = selectMessageRowsByRowIdRange(opened.db, tableName, previousShardRowId, currentShardRowId, MAX_MESSAGE_ROWS_PER_DIGEST + 1);
      }
      const createTimeRows = selectMessageRowsByTimeColumn(opened.db, tableName, 'create_time', timeBounds, MAX_MESSAGE_ROWS_PER_DIGEST + 1);
      const sortSeqFallback = shouldUseSortSeqFallback(createTimeRows, {
        min_messages,
        pre_media_filter,
        sender_filter_active,
        fallback_sensitive_filter_active,
      });
      notifyProgress(onProgress, {
        phase: 'fetch_create_time',
        label: '拉取消息 · 按消息时间查询',
        detail: `${file.name} create_time 命中 ${createTimeRows.length} 条；${sortSeqFallback.detail}`,
      });
      let directSortSeqRows = [];
      let packedSortSeqRows = [];
      if (sortSeqFallback.needed) {
        notifyProgress(onProgress, {
          phase: 'fetch_sort_seq_start',
          label: '拉取消息 · 排序时间兜底',
          detail: `${file.name}：${sortSeqFallback.detail}`,
        });
        const directSortSeqPayloadStats = messageRowsPayloadStatsByTimeColumn(opened.db, tableName, 'sort_seq', timeBounds, MAX_MESSAGE_ROWS_PER_DIGEST + 1);
        const packedSortSeqPayloadStats = messageRowsPayloadStatsByPackedSortSeq(opened.db, tableName, timeBounds, MAX_MESSAGE_ROWS_PER_DIGEST + 1);
        shardRawPayloadBytes = assertMessagePayloadBudget(directSortSeqPayloadStats, {
          cumulativeBytes: shardRawPayloadBytes,
          shard: file.name,
          timeSource: 'sort_seq',
        });
        shardRawPayloadBytes = assertMessagePayloadBudget(packedSortSeqPayloadStats, {
          cumulativeBytes: shardRawPayloadBytes,
          shard: file.name,
          timeSource: 'packed_sort_seq',
        });
        directSortSeqRows = selectMessageRowsByTimeColumn(opened.db, tableName, 'sort_seq', timeBounds, MAX_MESSAGE_ROWS_PER_DIGEST + 1);
        packedSortSeqRows = selectMessageRowsByPackedSortSeq(opened.db, tableName, timeBounds, MAX_MESSAGE_ROWS_PER_DIGEST + 1);
      }
      const querySourceRows = [
        ['create_time', createTimeRows],
        ['sort_seq', directSortSeqRows],
        ['packed_sort_seq', packedSortSeqRows],
      ];
      const overflowingSource = querySourceRows.find(([, sourceRows]) => sourceRows.length > MAX_MESSAGE_ROWS_PER_DIGEST);
      if (overflowingSource) {
        const [timeSource, sourceRows] = overflowingSource;
        throw Object.assign(new Error(`所选时间范围内单个消息查询至少命中 ${sourceRows.length} 行，超过单次摘要安全上限 ${MAX_MESSAGE_ROWS_PER_DIGEST} 条。请缩短时间范围后重试；系统没有静默截取消息。`), {
          status: 413,
          code: 'wxdb_message_window_too_large',
          public_code: 'wxdb_message_window_too_large',
          wxdb_diagnostics: {
            query_row_count_lower_bound: sourceRows.length,
            message_limit: MAX_MESSAGE_ROWS_PER_DIGEST,
            searched_shard_count: shardIndex,
            overflowing_shard: file.name,
            overflowing_time_source: timeSource,
          },
        });
      }
      const sortSeqRows = [...directSortSeqRows, ...packedSortSeqRows];
      if (packedSortSeqRows.length) {
        notifyProgress(onProgress, {
          phase: 'fetch_sort_seq_packed_fallback',
          label: '拉取消息 · 解码排序时间',
          detail: `${file.name} 已从编码 sort_seq 补到 ${packedSortSeqRows.length} 条`,
        });
      }
      const merged = mergeMessageRowsByTimeSources(createTimeRows, sortSeqRows, timeBounds, incrementalRows);
      const rows = merged.rows;
      const nextShardRowId = messageShardRowPositionAfterIncrementalMerge({
        row_positions_initialized: rowPositionsInitialized,
        previous_row_id: previousShardRowId,
        current_row_id: currentShardRowId,
        incremental_row_count: incrementalRows.length,
        incremental_consumed_count: merged.incremental_consumed_count,
      });
      observedShardRowPositions[shardCursor.key] = messageShardCursorRecord(
        file,
        opened.db,
        tableName,
        nextShardRowId,
      );
      lateSyncIncrementalMessageCount += merged.incremental_only_hit_count;
      lateSyncIncrementalOutOfRangeCount += merged.incremental_out_of_range_count;
      if (merged.incremental_out_of_range_count > 0) {
        notifyProgress(onProgress, {
          phase: 'fetch_incremental_late_sync',
          label: '拉取消息 · 补入迟到消息',
          detail: `${file.name} 发现 ${merged.incremental_out_of_range_count} 条新写入但时间落在本次窗口外的消息，已纳入去重和调度处理`,
        });
      }
      if (merged.sort_only_hit_count > 0) {
        notifyProgress(onProgress, {
          phase: 'fetch_sort_seq_fallback',
          label: '拉取消息 · 使用排序时间兜底',
          detail: `${file.name} create_time 命中 ${merged.create_time_hit_count} 条，sort_seq 额外补到 ${merged.sort_only_hit_count} 条`,
        });
      }
      throwIfAborted(signal);
      collectTableTimeStat(opened.db, tableName, file.name, tableTimeStats, merged, timeBounds);
      if (!rows.length) continue;
      notifyProgress(onProgress, {
        phase: 'fetch_rows',
        label: '拉取消息 · 解析消息行',
        detail: `${file.name} 合并命中 ${rows.length} 条${merged.sort_only_hit_count > 0 ? `（排序时间补 ${merged.sort_only_hit_count} 条）` : ''}；累计 ${out.length + rows.length} 条`,
      });

      const senderIds = [...new Set(rows.map(r => Number(r.real_sender_id || 0)).filter(Boolean))];
      const senderMap = new Map();
      const senderIndexAvailable = sqliteTableHasColumns(opened.db, 'Name2Id', ['user_name']);
      const stmt = senderIndexAvailable
        ? opened.db.prepare('select rowid, user_name from Name2Id where rowid = ?')
        : null;
      if (senderIds.length) {
        notifyProgress(onProgress, {
          phase: 'fetch_sender_ids',
          label: '拉取消息 · 解析发送人索引',
          detail: senderIndexAvailable
            ? `${file.name} 需要补全 ${senderIds.length} 个发送人`
            : `${file.name} 没有可用 Name2Id 发送人索引，正文继续读取，未匹配发送人显示为“未知成员”`,
        });
      }
      for (const id of senderIds) {
        if (!stmt) break;
        throwIfAborted(signal);
        const sender = stmt.get([id]);
        if (sender?.user_name) senderMap.set(id, String(sender.user_name));
      }

      for (const row of rows) {
        throwIfAborted(signal);
        const normalized = normalizeMessageContent(row.message_content, row.local_type, {
          compress_content: row.compress_content,
          packed_info_data: row.packed_info_data,
        });
        const normalizedPayloadBytes = Buffer.byteLength(String(normalized.content || ''), 'utf8');
        if (normalizedPayloadBytes > MAX_MESSAGE_RAW_PAYLOAD_BYTES_PER_ROW
          || normalizedMessagePayloadBytes + normalizedPayloadBytes > MAX_MESSAGE_NORMALIZED_PAYLOAD_BYTES_PER_DIGEST) {
          throw messagePayloadTooLargeError({
            rowBytes: normalizedPayloadBytes,
            totalBytes: normalizedMessagePayloadBytes + normalizedPayloadBytes,
            shard: file.name,
            timeSource: row.__time_source === 'sort_seq' ? 'sort_seq' : 'create_time',
            stage: 'normalized',
          });
        }
        normalizedMessagePayloadBytes += normalizedPayloadBytes;
        const sender = normalized.sender || senderMap.get(Number(row.real_sender_id || 0)) || '未知成员';
        const timeSource = row.__time_source === 'sort_seq' ? 'sort_seq' : 'create_time';
        const timestamp = normalizeMessageRowTimestamp(row, timeSource, timeBounds);
        out.push({
          id: `${file.name}:${row.local_id}`,
          local_id: Number(row.local_id),
          server_id: String(row.server_id || ''),
          sort_seq: normalizeMessageSortSeqValue(row.sort_seq),
          time_source: timeSource,
          late_sync_incremental: row.__late_sync_incremental === true,
          time: formatMessageTime(timestamp),
          timestamp,
          sender,
          sender_username: sender,
          sender_display_name: '',
          type: normalized.type,
          content: normalized.content,
          media: normalized.media,
          raw_type: Number(row.local_type || 0),
          group: group_id,
        });
      }
      const partialDedupe = dedupeMessagesAcrossShards(out);
      duplicateMessageCount += partialDedupe.duplicate_count;
      if (partialDedupe.duplicate_count > 0) {
        out.length = 0;
        out.push(...partialDedupe.messages);
      }
      if (out.length > MAX_MESSAGE_ROWS_PER_DIGEST) {
        throw Object.assign(new Error(`所选时间范围内至少有 ${out.length} 条唯一消息，超过单次摘要安全上限 ${MAX_MESSAGE_ROWS_PER_DIGEST} 条。请缩短时间范围后重试；系统没有静默截取消息。`), {
          status: 413,
          code: 'wxdb_message_window_too_large',
          public_code: 'wxdb_message_window_too_large',
          wxdb_diagnostics: {
            message_count_lower_bound: out.length,
            message_limit: MAX_MESSAGE_ROWS_PER_DIGEST,
            searched_shard_count: shardIndex,
          },
        });
      }
    } catch (e) {
      if (e?.status === 499 || signal?.aborted) throw e;
      if (['wxdb_mirror_manifest_changed', 'wxdb_mirror_readiness_changed', 'wxdb_message_window_too_large', 'wxdb_message_payload_too_large', 'wxdb_message_shard_position_invalid', 'wxdb_message_shard_position_reset', 'wxdb_message_incremental_window_too_large'].includes(e?.code)) throw e;
      const keyScan = sanitizeWxdbKeyScanDiagnostics(e?.key_scan_diagnostics);
      shardErrors.push(compactObject({
        name: file.name,
        code: wxdbShardErrorCode(e),
        error: sanitizeWxdbDiagnosticError(e?.message || e || '未知错误'),
        bytes: Number(file.bytes || 0) || 0,
        last_write_time: file.last_write_time || '',
        mtime_relation_to_request: messageShardMtimeRelationToRange(file.last_write_time, timeBounds),
        key_scan: keyScan,
      }));
    } finally {
      await closeCopiedDbHandle(opened);
    }
  }

  const messageTableTimeRange = summarizeTableTimeStats(tableTimeStats);
  const tableRowCount = Math.max(0, Number(messageTableTimeRange?.row_count || 0) || 0);
  const windowHitCount = Math.max(0, Number(messageTableTimeRange?.hit_count || 0) || 0);

  if (shardErrors.length) {
    const sampledShardErrors = sampleWxdbShardErrors(shardErrors);
    const sample = sampledShardErrors.map(item => `${item.name}: ${item.error}`).join('；');
    const failedShardTimeSummary = summarizeFailedMessageShardTimes(shardErrors, timeBounds);
    const shardFailureCause = shardOpenFailureCause(shardErrors);
    const err = new Error(shardOpenFailureMessage({ readableShards, shardErrors, sample }));
    err.status = readableShards === 0 ? 502 : 409;
    err.code = readableShards === 0 ? 'wxdb_all_shards_unreadable' : 'wxdb_partial_shards_unreadable';
    err.public_code = err.code;
    err.wxdb_diagnostics = compactObject({
      shard_open_failure_cause: shardFailureCause,
      searched_shard_count: allDbFiles.length,
      candidate_shard_count: dbFiles.length,
      skipped_before_range_shard_count: skippedBeforeRangeShardCount,
      mtime_before_range_shard_count: beforeRangeMtimeShardCount,
      mtime_after_range_shard_count: afterRangeMtimeShardCount,
      readable_shard_count: readableShards,
      failed_shard_count: shardErrors.length,
      matching_shard_count: matchingShards,
      partial_collected_message_count: out.length,
      table_row_count: tableRowCount,
      window_hit_count: windowHitCount,
      target_table: tableName,
      group_id,
      since,
      until: until || 'now',
      query_time_bounds: timeBounds,
      message_table_time_range: messageTableTimeRange,
      message_shards_last_write_time: shardWriteSummary.newest_time,
      all_message_shards_before_range: allMessageShardsBeforeRange,
      message_coverage_verified: false,
      coverage_failure: 'unreadable_message_shards',
      failed_shard_time_summary: failedShardTimeSummary,
      sample_errors: sampledShardErrors,
      sample_error_limit: sampledShardErrors.length,
      omitted_error_count: Math.max(0, shardErrors.length - sampledShardErrors.length),
      error_category_counts: summarizeWxdbShardErrorCategories(shardErrors),
      key_scan_summary: summarizeShardKeyScans(shardErrors),
    });
    throw err;
  }
  if (matchingShards === 0) {
    const err = new Error(`未在 ${readableShards} 个可读消息分片中找到该会话消息表 ${tableName}。可能是会话 ID 不匹配、账号选择错误、本地工作数据尚未更新到这次会话，或该会话尚未在本机同步消息。`);
    err.status = 404;
    err.code = 'wxdb_message_table_missing';
    err.public_code = err.code;
    err.wxdb_diagnostics = compactObject({
      searched_shard_count: allDbFiles.length,
      candidate_shard_count: dbFiles.length,
      skipped_before_range_shard_count: skippedBeforeRangeShardCount,
      mtime_before_range_shard_count: beforeRangeMtimeShardCount,
      mtime_after_range_shard_count: afterRangeMtimeShardCount,
      readable_shard_count: readableShards,
      matching_shard_count: matchingShards,
      target_table: tableName,
      group_id,
      since,
      until: until || 'now',
      query_time_bounds: timeBounds,
    });
    throw err;
  }

  const dedupe = dedupeMessagesAcrossShards(out);
  duplicateMessageCount += dedupe.duplicate_count;
  if (duplicateMessageCount > 0) {
    out.length = 0;
    out.push(...dedupe.messages);
    notifyProgress(onProgress, {
      phase: 'fetch_dedupe_shards',
      label: '拉取消息 · 合并重复分片记录',
      detail: `跨消息分片发现 ${duplicateMessageCount} 条重复记录，已保留 ${out.length} 条唯一消息`,
    });
  }
  out.sort((a, b) => a.timestamp - b.timestamp || compareMessageIntegerValues(a.sort_seq, b.sort_seq) || a.local_id - b.local_id || String(a.id || '').localeCompare(String(b.id || '')));
  throwIfAborted(signal);
  const scannedCount = out.length;
  notifyProgress(onProgress, {
    phase: 'fetch_senders',
    label: '拉取消息 · 补全发送人',
    detail: `${scannedCount} 条消息 · ${readableShards}/${dbFiles.length} 个分片可读`,
  });
  const senderHydration = await hydrateSenderNames(account, rawKeyPool, out, group_id, { signal, onProgress, allow_stale_account });
  throwIfAborted(signal);
  const senderHydrationIncomplete = senderHydration?.ok === true
    && senderHydration.attempted !== false
    && Number(senderHydration.raw_sender_count || 0) > Number(senderHydration.mapped_sender_count || 0);
  const senderFilterHydrationRisk = senderHydrationSenderFilterRisk(senderHydration, out, sender_filter_terms);
  if (senderHydration?.ok === false || senderHydrationIncomplete) {
    if (sender_filter_active && senderFilterHydrationRisk.risky) {
      const reason = senderHydration?.ok === false
        ? (senderHydration.error_code || 'unknown')
        : `仅补全 ${Number(senderHydration.mapped_sender_count || 0)}/${Number(senderHydration.raw_sender_count || 0)} 个发送人`;
      const err = new Error(`发送人昵称未完整补全（${reason}），已停止生成以避免发送人筛选漏消息。请清空发送人筛选后重试，或稍后等 contact.db 可读后再生成。`);
      err.status = 409;
      err.code = 'wxdb_sender_filter_unverified';
      err.public_code = err.code;
      err.wxdb_diagnostics = compactObject({
        searched_shard_count: allDbFiles.length,
        candidate_shard_count: dbFiles.length,
        skipped_before_range_shard_count: skippedBeforeRangeShardCount,
        mtime_before_range_shard_count: beforeRangeMtimeShardCount,
        mtime_after_range_shard_count: afterRangeMtimeShardCount,
        readable_shard_count: readableShards,
        matching_shard_count: matchingShards,
        table_row_count: tableRowCount,
        window_hit_count: windowHitCount,
        target_table: tableName,
        group_id,
        since,
        until: until || 'now',
        sender_hydration: senderHydration,
        sender_filter_hydration_risk: senderFilterHydrationRisk,
      });
      throw err;
    }
    notifyProgress(onProgress, {
      phase: 'fetch_senders_warning',
      label: '拉取消息 · 发送人昵称未补全',
      detail: senderHydration?.ok === false
        ? `contact.db 暂不可读（${senderHydration.error_code || 'unknown'}），已继续使用原始 ID`
        : (sender_filter_active
          ? `仅补全 ${Number(senderHydration.mapped_sender_count || 0)}/${Number(senderHydration.raw_sender_count || 0)} 个发送人；本次发送人筛选使用原始 ID，继续生成`
          : `仅补全 ${Number(senderHydration.mapped_sender_count || 0)}/${Number(senderHydration.raw_sender_count || 0)} 个发送人，已继续使用原始 ID`),
    });
  } else {
    notifyProgress(onProgress, {
      phase: 'fetch_senders_done',
      label: '拉取消息 · 发送人已补全',
      detail: `${out.length} 条消息已按时间排序${senderHydration?.mapped_sender_count ? `，补全 ${senderHydration.mapped_sender_count} 个发送人` : ''}`,
    });
  }
  const messagesForOutput = typeof pre_media_filter === 'function' ? out.filter(pre_media_filter) : out;
  if (messagesForOutput.length !== out.length) {
    notifyProgress(onProgress, {
      phase: 'fetch_prefilter',
      label: '拉取消息 · 预筛选',
      detail: `媒体解析前保留 ${messagesForOutput.length}/${out.length} 条`,
    });
  }
  const preMediaMinimum = Math.max(0, Number(min_messages || 0) || 0);
  if (preMediaMinimum > 0 && messagesForOutput.length < preMediaMinimum) {
    notifyProgress(onProgress, {
      phase: 'fetch_below_minimum_pre_media',
      label: '拉取消息 · 消息数低于阈值',
      detail: `${messagesForOutput.length}/${preMediaMinimum} 条，已跳过媒体解析`,
    });
    const result = {
      source: 'wxdb',
      account: redactAccount(account),
      mirror_snapshot: mirrorSnapshot,
      group_id,
      table: tableName,
      messages: messagesForOutput,
      scanned_message_count: scannedCount,
      duplicate_message_count: duplicateMessageCount,
      pre_filter_message_count: scannedCount,
      pre_media_filtered_count: messagesForOutput.length,
      media_skipped_reason: 'below_minimum_pre_media',
      searched_shard_count: allDbFiles.length,
      candidate_shard_count: dbFiles.length,
      skipped_before_range_shard_count: skippedBeforeRangeShardCount,
      mtime_before_range_shard_count: beforeRangeMtimeShardCount,
      mtime_after_range_shard_count: afterRangeMtimeShardCount,
      readable_shard_count: readableShards,
      matching_shard_count: matchingShards,
      table_row_count: tableRowCount,
      window_hit_count: windowHitCount,
      query_time_bounds: timeBounds,
      message_table_time_range: messageTableTimeRange,
      message_shards_last_write_time: shardWriteSummary.newest_time,
      all_message_shards_before_range: allMessageShardsBeforeRange,
      sender_hydration: senderHydration,
      shard_row_positions_initialized: true,
      shard_row_positions: observedShardRowPositions,
      late_sync_incremental_message_count: lateSyncIncrementalMessageCount,
      late_sync_incremental_out_of_range_count: lateSyncIncrementalOutOfRangeCount,
      truncated: false,
    };
    Object.defineProperty(result, '__verified_raw_keys', {
      value: uniqueStrings(verifiedMessageRawKeys).filter(persistableRawKey),
      enumerable: false,
    });
    return attachCollectedIdentityEvidence(result);
  }
  if (skip_media_enrichment) {
    const skipReason = String(media_enrichment_skip_reason || 'privacy_media_disabled');
    notifyProgress(onProgress, {
      phase: 'fetch_media_skipped',
      label: '拉取消息 · 跳过媒体解析',
      detail: skipReason === 'privacy_media_disabled'
        ? '隐私设置未允许媒体内容附给 AI；保留图片、视频和语音元信息，不复制或解码本地媒体文件'
        : '保留图片、视频和语音元信息，不复制或解码本地媒体文件',
    });
    const result = {
      source: 'wxdb',
      account: redactAccount(account),
      mirror_snapshot: mirrorSnapshot,
      group_id,
      table: tableName,
      messages: messagesForOutput,
      scanned_message_count: scannedCount,
      duplicate_message_count: duplicateMessageCount,
      pre_filter_message_count: scannedCount,
      pre_media_filtered_count: messagesForOutput.length,
      media_skipped_reason: skipReason,
      searched_shard_count: allDbFiles.length,
      candidate_shard_count: dbFiles.length,
      skipped_before_range_shard_count: skippedBeforeRangeShardCount,
      mtime_before_range_shard_count: beforeRangeMtimeShardCount,
      mtime_after_range_shard_count: afterRangeMtimeShardCount,
      readable_shard_count: readableShards,
      matching_shard_count: matchingShards,
      table_row_count: tableRowCount,
      window_hit_count: windowHitCount,
      query_time_bounds: timeBounds,
      message_table_time_range: messageTableTimeRange,
      message_shards_last_write_time: shardWriteSummary.newest_time,
      all_message_shards_before_range: allMessageShardsBeforeRange,
      sender_hydration: senderHydration,
      shard_row_positions_initialized: true,
      shard_row_positions: observedShardRowPositions,
      late_sync_incremental_message_count: lateSyncIncrementalMessageCount,
      late_sync_incremental_out_of_range_count: lateSyncIncrementalOutOfRangeCount,
      truncated: false,
    };
    Object.defineProperty(result, '__verified_raw_keys', {
      value: uniqueStrings(verifiedMessageRawKeys).filter(persistableRawKey),
      enumerable: false,
    });
    return attachCollectedIdentityEvidence(result);
  }
  notifyProgress(onProgress, {
    phase: 'fetch_media',
    label: '拉取消息 · 解析媒体',
    detail: messagesForOutput.length === out.length
      ? '定位本地图片、视频关键帧和语音元信息'
      : `仅解析筛选后 ${messagesForOutput.length} 条消息的媒体`,
  });
  await enrichMessageMedia(account, rawKeyPool, messagesForOutput, { signal, onProgress, allow_stale_account });
  throwIfAborted(signal);
  notifyProgress(onProgress, {
    phase: 'fetch_media_done',
    label: '拉取消息 · 媒体解析完成',
    detail: `${messagesForOutput.length} 条消息可进入筛选和总结`,
  });
  const result = {
    source: 'wxdb',
    account: redactAccount(account),
    mirror_snapshot: mirrorSnapshot,
    group_id,
    table: tableName,
    messages: messagesForOutput,
    scanned_message_count: scannedCount,
    duplicate_message_count: duplicateMessageCount,
    pre_filter_message_count: scannedCount,
    pre_media_filtered_count: messagesForOutput.length,
    searched_shard_count: allDbFiles.length,
    candidate_shard_count: dbFiles.length,
    skipped_before_range_shard_count: skippedBeforeRangeShardCount,
    mtime_before_range_shard_count: beforeRangeMtimeShardCount,
    mtime_after_range_shard_count: afterRangeMtimeShardCount,
    readable_shard_count: readableShards,
    matching_shard_count: matchingShards,
    table_row_count: tableRowCount,
    window_hit_count: windowHitCount,
    query_time_bounds: timeBounds,
    message_table_time_range: messageTableTimeRange,
    message_shards_last_write_time: shardWriteSummary.newest_time,
    all_message_shards_before_range: allMessageShardsBeforeRange,
    sender_hydration: senderHydration,
    shard_row_positions_initialized: true,
    shard_row_positions: observedShardRowPositions,
    late_sync_incremental_message_count: lateSyncIncrementalMessageCount,
    late_sync_incremental_out_of_range_count: lateSyncIncrementalOutOfRangeCount,
    truncated: false,
  };
  Object.defineProperty(result, '__verified_raw_keys', {
    value: uniqueStrings(verifiedMessageRawKeys).filter(persistableRawKey),
    enumerable: false,
  });
  return attachCollectedIdentityEvidence(result);
  });
}

function summarizeMessageShardWriteTimes(dbFiles = []) {
  const times = (Array.isArray(dbFiles) ? dbFiles : [])
    .map(file => safeMessageShardMtimeMs(file?.last_write_time || ''))
    .filter(ms => ms > 0);
  const newest = times.length ? Math.max(...times) : 0;
  return {
    newest_ms: newest,
    newest_time: newest ? formatMessageTime(newest) : '',
  };
}

function safeMessageShardMtimeMs(value = '') {
  const text = String(value || '').trim();
  if (!text) return 0;
  const utc = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/);
  if (utc) return checkedMessageShardDateMs(utc, { utc: true });
  const local = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/);
  if (local) return checkedMessageShardDateMs(local, { utc: false });
  return 0;
}

function checkedMessageShardDateMs(match, { utc = false } = {}) {
  const [, y, mo, d, h, mi, rawSeconds = '0', rawMilliseconds = '0'] = match;
  const ms = Number(String(rawMilliseconds || '0').padEnd(3, '0'));
  const parts = [y, mo, d, h, mi, rawSeconds].map(Number);
  if (parts.some(part => !Number.isInteger(part)) || !Number.isInteger(ms)) return 0;
  const [year, month, day, hour, minute, second] = parts;
  const date = utc
    ? new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms))
    : new Date(year, month - 1, day, hour, minute, second, ms);
  const time = date.getTime();
  if (!Number.isFinite(time)) return 0;
  const valid = utc
    ? date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day
      && date.getUTCHours() === hour
      && date.getUTCMinutes() === minute
      && date.getUTCSeconds() === second
      && date.getUTCMilliseconds() === ms
    : date.getFullYear() === year
      && date.getMonth() === month - 1
      && date.getDate() === day
      && date.getHours() === hour
      && date.getMinutes() === minute
      && date.getSeconds() === second
      && date.getMilliseconds() === ms;
  return valid ? time : 0;
}

function compareMessageShardsByLastWriteDesc(a = {}, b = {}) {
  const byTime = safeMessageShardMtimeMs(b.last_write_time) - safeMessageShardMtimeMs(a.last_write_time);
  if (byTime) return byTime;
  return String(a.name || '').localeCompare(String(b.name || ''));
}

function messageShardWritesBeforeRange(shardWriteSummary = {}, timeBounds = {}) {
  const newest = Number(shardWriteSummary.newest_ms || 0) || 0;
  const since = Number(timeBounds.since_ms || 0) || 0;
  return !!newest && !!since && newest < since;
}

function messageShardMtimeRelationToRange(lastWriteTime = '', timeBounds = {}) {
  const ms = safeMessageShardMtimeMs(lastWriteTime);
  const since = Number(timeBounds.since_ms || 0) || 0;
  const until = Number(timeBounds.until_ms || 0) || 0;
  if (ms <= 0 || !since) return 'unknown_mtime';
  if (ms < since) return 'before_range_start';
  if (until && ms > until) return 'after_range_end';
  return 'within_requested_range';
}

function summarizeFailedMessageShardTimes(shardErrors = [], timeBounds = {}) {
  const items = Array.isArray(shardErrors) ? shardErrors : [];
  const times = items
    .map(item => safeMessageShardMtimeMs(item?.last_write_time || ''))
    .filter(ms => ms > 0);
  const relationCounts = items.reduce((acc, item) => {
    const relation = item?.mtime_relation_to_request || 'unknown_mtime';
    acc[relation] = (acc[relation] || 0) + 1;
    return acc;
  }, {});
  const before = Number(relationCounts.before_range_start || 0) || 0;
  const unknown = Number(relationCounts.unknown_mtime || 0) || 0;
  const atOrAfter = items.length - unknown - before;
  return compactObject({
    coverage_basis: 'db_wal_shm_last_write_time_not_integrity_proof',
    coverage_risk: items.length ? 'possible' : '',
    failed_shard_count: items.length,
    failed_shards_before_since_count: before,
    failed_shards_at_or_after_since_count: atOrAfter,
    failed_shards_unknown_mtime_count: unknown,
    newest_failed_last_write_time: times.length ? formatMessageTime(Math.max(...times)) : '',
    oldest_failed_last_write_time: times.length ? formatMessageTime(Math.min(...times)) : '',
    request_since_time: timeBounds.since_ms ? formatMessageTime(timeBounds.since_ms) : '',
    request_until_time: timeBounds.until_ms ? formatMessageTime(timeBounds.until_ms) : '',
    relation_counts: relationCounts,
  });
}

function shouldUseSortSeqFallback(createTimeRows = [], {
  min_messages = 0,
  pre_media_filter = null,
  sender_filter_active = false,
  fallback_sensitive_filter_active = false,
} = {}) {
  const rows = Array.isArray(createTimeRows) ? createTimeRows : [];
  const minimum = Math.max(0, Number(min_messages || 0) || 0);
  if (!rows.length) {
    return {
      needed: true,
      reason: 'create_time_empty',
      detail: 'create_time 没有命中，继续检查 sort_seq',
    };
  }
  if (sender_filter_active || fallback_sensitive_filter_active) {
    return {
      needed: true,
      reason: sender_filter_active ? 'sender_filter_active' : 'fallback_sensitive_filter_active',
      detail: '本次启用了发送人或关键词筛选，继续检查 sort_seq 防止筛选后漏消息',
    };
  }
  const filteredCount = estimatePreMediaFilteredRowCount(rows, pre_media_filter, { stop_at: minimum });
  if (filteredCount === null) {
    return {
      needed: true,
      reason: 'pre_media_filter_unknown',
      detail: '无法提前确认筛选后消息数，继续检查 sort_seq',
    };
  }
  if (minimum > 0 && filteredCount < minimum) {
    return {
      needed: true,
      reason: 'below_minimum',
      detail: `create_time 筛选后 ${filteredCount}/${minimum} 条，继续检查 sort_seq`,
    };
  }
  return {
    needed: true,
    reason: 'time_source_crosscheck',
    detail: minimum > 0
      ? `create_time 筛选后 ${filteredCount}/${minimum} 条，继续检查 sort_seq 防止时间字段异常漏消息`
      : `create_time 命中 ${filteredCount} 条，继续检查 sort_seq 防止时间字段异常漏消息`,
  };
}

function estimatePreMediaFilteredRowCount(rows = [], preMediaFilter = null, { stop_at = 0 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (typeof preMediaFilter !== 'function') return list.length;
  const stopAt = Math.max(0, Number(stop_at || 0) || 0);
  let count = 0;
  try {
    for (const row of list) {
      const normalized = normalizeMessageContent(row.message_content, row.local_type, {
        compress_content: row.compress_content,
        packed_info_data: row.packed_info_data,
      });
      if (preMediaFilter({
        sender: normalized.sender || '未知成员',
        sender_username: normalized.sender || '未知成员',
        sender_display_name: '',
        type: normalized.type,
        content: normalized.content,
        media: normalized.media,
        raw_type: Number(row.local_type || 0),
      })) {
        count += 1;
        if (stopAt > 0 && count >= stopAt) return count;
      }
    }
  } catch {
    return null;
  }
  return count;
}

function messagePayloadTooLargeError({ rowBytes = 0, totalBytes = 0, shard = '', timeSource = '', stage = 'raw' } = {}) {
  const rowLimitExceeded = Number(rowBytes || 0) > MAX_MESSAGE_RAW_PAYLOAD_BYTES_PER_ROW;
  const measuredBytes = rowLimitExceeded ? Number(rowBytes || 0) : Number(totalBytes || 0);
  const limitBytes = rowLimitExceeded ? MAX_MESSAGE_RAW_PAYLOAD_BYTES_PER_ROW : MAX_MESSAGE_RAW_PAYLOAD_BYTES_PER_SHARD;
  const scope = rowLimitExceeded ? '单条消息内容' : '本次消息内容';
  return Object.assign(new Error(`${scope}约 ${Math.ceil(measuredBytes / 1024)} KB，超过安全上限 ${Math.ceil(limitBytes / 1024)} KB。请缩短时间范围后重试；系统没有静默截取消息内容。`), {
    status: 413,
    code: 'wxdb_message_payload_too_large',
    public_code: 'wxdb_message_payload_too_large',
    wxdb_diagnostics: compactObject({
      payload_stage: stage,
      payload_bytes: measuredBytes,
      payload_limit_bytes: limitBytes,
      overflowing_shard: shard,
      overflowing_time_source: timeSource,
    }),
  });
}

function messagePayloadStatsQuery(db, tableName, whereSql, orderColumn, params = [], maxRows = 0) {
  const limit = Math.max(0, Math.trunc(Number(maxRows || 0)) || 0);
  const row = db.prepare(`
    select count(*) as row_count,
           coalesce(max(row_payload_bytes), 0) as max_row_payload_bytes,
           coalesce(sum(row_payload_bytes), 0) as total_payload_bytes
    from (
      select coalesce(length(message_content), 0)
             + coalesce(length(compress_content), 0)
             + coalesce(length(packed_info_data), 0) as row_payload_bytes
      from ${tableName}
      where ${whereSql}
      order by ${orderColumn} asc
      ${limit ? 'limit ?' : ''}
    )
  `).get([...params, ...(limit ? [limit] : [])]) || {};
  return {
    row_count: Math.max(0, Number(row.row_count || 0) || 0),
    max_row_payload_bytes: Math.max(0, Number(row.max_row_payload_bytes || 0) || 0),
    total_payload_bytes: Math.max(0, Number(row.total_payload_bytes || 0) || 0),
  };
}

function messageRowsPayloadStatsByTimeColumn(db, tableName, columnName, timeBounds, maxRows = 0) {
  const column = columnName === 'sort_seq' ? 'sort_seq' : 'create_time';
  return messagePayloadStatsQuery(db, tableName, `
    (
      (${column} >= ? and ${column} <= ?)
      or (${column} >= ? and ${column} <= ?)
      or (${column} >= ? and ${column} <= ?)
      or (${column} >= cast(? as integer) and ${column} <= cast(? as integer))
    )
  `, column, [
    timeBounds.since_s,
    timeBounds.until_s,
    timeBounds.since_ms,
    timeBounds.until_ms,
    timeBounds.since_us,
    timeBounds.until_us,
    timeBounds.since_ns,
    timeBounds.until_ns,
  ], maxRows);
}

function messageShardLimitError(count = 0) {
  const observed = Math.max(0, Math.trunc(Number(count || 0)) || 0);
  return Object.assign(new Error(`发现 ${observed} 个微信消息分片，超过当前可完整持久化增量游标的 ${MAX_MESSAGE_SHARDS_WITH_CURSOR} 个上限。已停止读取且不会推进游标，避免静默漏掉后续分片。`), {
    status: 409,
    code: 'wxdb_message_shard_limit_exceeded',
    public_code: 'wxdb_message_shard_limit_exceeded',
    wxdb_diagnostics: {
      message_shard_count: observed,
      message_shard_limit: MAX_MESSAGE_SHARDS_WITH_CURSOR,
    },
  });
}

function assertMessageShardCountSupported(value = []) {
  const count = Array.isArray(value)
    ? value.length
    : Math.max(0, Math.trunc(Number(value || 0)) || 0);
  if (count > MAX_MESSAGE_SHARDS_WITH_CURSOR) throw messageShardLimitError(count);
  return count;
}

function messageShardGenerationComponent(file = {}) {
  const birthtimeMs = Number(file.birthtimeMs || file.birthtime_ms || 0) || 0;
  const dev = Number(file.dev || 0) || 0;
  const ino = Number(file.ino || 0) || 0;
  if (birthtimeMs > 0 && dev > 0 && ino > 0) {
    return {
      kind: 'source_file_identity_v1',
      birthtimeMs,
      dev,
      ino,
    };
  }
  const sha256 = String(file.sha256 || '').trim().toLowerCase();
  if (/^[a-f0-9]{64}$/.test(sha256)) {
    return {
      kind: 'project_copy_content_sha256_v1',
      sha256,
    };
  }
  return null;
}

function messageShardGenerationFingerprint(file = {}) {
  const name = String(file?.name || '').trim().toLowerCase();
  if (!/^message_\d+\.db$/i.test(name)) return '';
  const database = messageShardGenerationComponent(file);
  if (!database) return '';
  return crypto.createHash('sha256').update(JSON.stringify({
    version: 'wxdb_message_shard_generation_v1',
    name,
    database,
  })).digest('hex');
}

function messageShardGenerationMissingError(file = {}) {
  const name = String(file?.name || '').trim();
  return Object.assign(new Error(`${name || '微信消息分片'} 缺少可验证的文件代次，已停止使用 rowid 增量游标，避免把旧分片位置套用到新文件。请重新刷新本地工作数据后重试。`), {
    status: 409,
    code: 'wxdb_message_shard_generation_missing',
    public_code: 'wxdb_message_shard_generation_missing',
    wxdb_diagnostics: {
      source_name: name,
    },
  });
}

function messageShardRowAnchorMissingError(file = '', rowId = 0) {
  return Object.assign(new Error(`${String(file || '微信消息分片')} 的水位行 ${rowId} 不存在，已停止沿用旧 rowid。`), {
    status: 409,
    code: 'wxdb_message_shard_anchor_missing',
    public_code: 'wxdb_message_shard_anchor_missing',
    wxdb_diagnostics: {
      source_name: String(file || '').trim(),
      row_id: Math.max(0, Math.trunc(Number(rowId || 0)) || 0),
    },
  });
}

function updateMessageShardAnchorHash(hash, name, value) {
  let kind = 'string';
  let bytes;
  if (value === null || value === undefined) {
    kind = 'null';
    bytes = Buffer.alloc(0);
  } else if (Buffer.isBuffer(value)) {
    kind = 'bytes';
    bytes = value;
  } else if (ArrayBuffer.isView(value)) {
    kind = 'bytes';
    bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  } else if (typeof value === 'number' || typeof value === 'bigint') {
    kind = 'integer';
    bytes = Buffer.from(String(value), 'utf8');
  } else {
    bytes = Buffer.from(String(value), 'utf8');
  }
  hash.update(`${name}:${kind}:${bytes.length}:`, 'utf8');
  hash.update(bytes);
  hash.update('\n', 'utf8');
}

function messageShardRowAnchorHash(db, tableName = '', rowId = 0) {
  const table = String(tableName || '').trim();
  const position = Math.trunc(Number(rowId || 0));
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) || !Number.isSafeInteger(position) || position <= 0) {
    throw Object.assign(new Error('消息分片水位锚点参数无效。'), {
      status: 409,
      code: 'wxdb_message_shard_anchor_invalid',
      public_code: 'wxdb_message_shard_anchor_invalid',
    });
  }
  const row = db.prepare(`
    select cast(rowid as text) as __rowid, cast(local_id as text) as local_id,
           cast(server_id as text) as server_id, cast(local_type as text) as local_type,
           cast(sort_seq as text) as sort_seq, cast(real_sender_id as text) as real_sender_id,
           cast(create_time as text) as create_time,
           length(cast(message_content as blob)) as message_content_bytes,
           substr(cast(message_content as blob), 1, 256) as message_content_prefix,
           substr(cast(message_content as blob), -256) as message_content_suffix,
           length(cast(compress_content as blob)) as compress_content_bytes,
           substr(cast(compress_content as blob), 1, 256) as compress_content_prefix,
           substr(cast(compress_content as blob), -256) as compress_content_suffix,
           length(cast(packed_info_data as blob)) as packed_info_data_bytes,
           substr(cast(packed_info_data as blob), 1, 256) as packed_info_data_prefix,
           substr(cast(packed_info_data as blob), -256) as packed_info_data_suffix
    from ${table}
    where rowid = ?
  `).get([position]);
  if (!row) throw messageShardRowAnchorMissingError(table, position);
  const actualRowId = Number(row.__rowid ?? row.rowid ?? position);
  if (!Number.isSafeInteger(actualRowId) || actualRowId !== position) {
    throw messageShardRowAnchorMissingError(table, position);
  }
  const hash = crypto.createHash('sha256');
  hash.update('wxdb_message_shard_row_anchor_v1\n', 'utf8');
  for (const [name, value] of [
    ['rowid', position],
    ['local_id', row.local_id],
    ['server_id', row.server_id],
    ['local_type', row.local_type],
    ['sort_seq', row.sort_seq],
    ['real_sender_id', row.real_sender_id],
    ['create_time', row.create_time],
    ['message_content_bytes', row.message_content_bytes],
    ['message_content_prefix', row.message_content_prefix],
    ['message_content_suffix', row.message_content_suffix],
    ['compress_content_bytes', row.compress_content_bytes],
    ['compress_content_prefix', row.compress_content_prefix],
    ['compress_content_suffix', row.compress_content_suffix],
    ['packed_info_data_bytes', row.packed_info_data_bytes],
    ['packed_info_data_prefix', row.packed_info_data_prefix],
    ['packed_info_data_suffix', row.packed_info_data_suffix],
  ]) updateMessageShardAnchorHash(hash, name, value);
  return hash.digest('hex');
}

function messageShardCursorRecord(file = {}, db = null, tableName = '', rowId = 0) {
  const position = Math.max(0, Math.trunc(Number(rowId || 0)) || 0);
  if (!Number.isSafeInteger(position)) {
    throw Object.assign(new Error('消息分片 rowid 超出安全整数范围，已停止保存增量游标。'), {
      status: 409,
      code: 'wxdb_message_shard_position_invalid',
      public_code: 'wxdb_message_shard_position_invalid',
    });
  }
  const generation = messageShardGenerationFingerprint(file);
  if (!generation) throw messageShardGenerationMissingError(file);
  return {
    row_id: position,
    generation,
    anchor_hash: position > 0 ? messageShardRowAnchorHash(db, tableName, position) : '',
  };
}

function messageShardCursorState(file = {}, positions = {}, { db = null, table_name = '' } = {}) {
  const key = String(file?.name || '').trim().toLowerCase();
  const generation = messageShardGenerationFingerprint(file);
  if (!key || !generation) throw messageShardGenerationMissingError(file);
  if (!Object.hasOwn(positions, key)) {
    return { key, has_previous: false, previous_row_id: 0, reset_reason: 'missing' };
  }
  const previous = positions[key];
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) {
    return { key, has_previous: false, previous_row_id: 0, reset_reason: 'legacy_unverified' };
  }
  const previousRowId = Number(previous.row_id);
  if (String(previous.generation || '').trim().toLowerCase() !== generation) {
    return { key, has_previous: false, previous_row_id: 0, reset_reason: 'generation_mismatch' };
  }
  if (previousRowId === 0) {
    return { key, has_previous: true, previous_row_id: 0, reset_reason: '' };
  }
  let currentAnchor = '';
  try {
    currentAnchor = messageShardRowAnchorHash(db, table_name, previousRowId);
  } catch (error) {
    if (error?.code !== 'wxdb_message_shard_anchor_missing') throw error;
    return { key, has_previous: false, previous_row_id: 0, reset_reason: 'anchor_missing' };
  }
  if (currentAnchor !== String(previous.anchor_hash || '').trim().toLowerCase()) {
    return { key, has_previous: false, previous_row_id: 0, reset_reason: 'anchor_mismatch' };
  }
  return {
    key,
    has_previous: true,
    previous_row_id: previousRowId,
    reset_reason: '',
  };
}

function normalizeMessageShardRowPositions(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value);
  assertMessageShardCountSupported(entries.length);
  const out = {};
  for (const [name, position] of entries) {
    const key = String(name || '').trim().toLowerCase();
    const normalized = normalizeMessageShardCursorPosition(position);
    if (!isMessageShardCursorKey(key) || normalized === null || Object.hasOwn(out, key)) {
      throw Object.assign(new Error(`${key || '消息分片'} 的增量水位格式无效或重复，已停止读取且不会推进游标。`), {
        status: 409,
        code: 'wxdb_message_shard_position_invalid',
        public_code: 'wxdb_message_shard_position_invalid',
        wxdb_diagnostics: {
          source_name: key,
          duplicate_normalized_key: Object.hasOwn(out, key),
        },
      });
    }
    out[key] = normalized;
  }
  return out;
}

function messageTableMaxRowId(db, tableName) {
  const rowId = Number(db.prepare(`select coalesce(max(rowid), 0) as max_rowid from ${tableName}`).get()?.max_rowid || 0);
  if (!Number.isSafeInteger(rowId) || rowId < 0) {
    throw Object.assign(new Error('消息表 rowid 超出安全整数范围，已停止增量读取。'), {
      status: 409,
      code: 'wxdb_message_shard_position_invalid',
      public_code: 'wxdb_message_shard_position_invalid',
    });
  }
  return rowId;
}

function messageRowsPayloadStatsByRowIdRange(db, tableName, afterRowId = 0, throughRowId = 0, maxRows = 0) {
  return messagePayloadStatsQuery(
    db,
    tableName,
    'rowid > ? and rowid <= ?',
    'rowid',
    [afterRowId, throughRowId],
    maxRows,
  );
}

function selectMessageRowsByRowIdRange(db, tableName, afterRowId = 0, throughRowId = 0, maxRows = 0) {
  const limit = Math.max(0, Math.trunc(Number(maxRows || 0)) || 0);
  return db.prepare(`
    select local_id, server_id, local_type, cast(sort_seq as text) as sort_seq, real_sender_id, create_time,
           message_content, compress_content, packed_info_data
    from ${tableName}
    where rowid > ? and rowid <= ?
    order by rowid asc
    ${limit ? 'limit ?' : ''}
  `).all([afterRowId, throughRowId, ...(limit ? [limit] : [])]);
}

function messageRowsPayloadStatsByPackedSortSeq(db, tableName, timeBounds = {}, maxRows = 0) {
  const ranges = packedSortSeqRanges(timeBounds);
  if (!ranges.length) return { row_count: 0, max_row_payload_bytes: 0, total_payload_bytes: 0 };
  const clauses = ranges.map(() => '(sort_seq >= cast(? as integer) and sort_seq <= cast(? as integer))').join(' or ');
  return messagePayloadStatsQuery(
    db,
    tableName,
    `sort_seq > 0 and (${clauses})`,
    'sort_seq',
    ranges.flatMap(range => [range.since, range.until]),
    maxRows,
  );
}

function assertMessagePayloadBudget(stats = {}, { cumulativeBytes = 0, shard = '', timeSource = '' } = {}) {
  const rowBytes = Math.max(0, Number(stats.max_row_payload_bytes || 0) || 0);
  const totalBytes = Math.max(0, Number(cumulativeBytes || 0) || 0) + Math.max(0, Number(stats.total_payload_bytes || 0) || 0);
  if (rowBytes > MAX_MESSAGE_RAW_PAYLOAD_BYTES_PER_ROW || totalBytes > MAX_MESSAGE_RAW_PAYLOAD_BYTES_PER_SHARD) {
    throw messagePayloadTooLargeError({ rowBytes, totalBytes, shard, timeSource, stage: 'raw' });
  }
  return totalBytes;
}

function selectMessageRowsByTimeColumn(db, tableName, columnName, timeBounds, maxRows = 0) {
  const column = columnName === 'sort_seq' ? 'sort_seq' : 'create_time';
  const limit = Math.max(0, Math.trunc(Number(maxRows || 0)) || 0);
  return db.prepare(`
    select local_id, server_id, local_type, cast(sort_seq as text) as sort_seq, real_sender_id, create_time,
           message_content, compress_content, packed_info_data
    from ${tableName}
    where (
      (${column} >= ? and ${column} <= ?)
      or (${column} >= ? and ${column} <= ?)
      or (${column} >= ? and ${column} <= ?)
      or (${column} >= cast(? as integer) and ${column} <= cast(? as integer))
    )
    order by ${column} asc
    ${limit ? 'limit ?' : ''}
  `).all([
    timeBounds.since_s,
    timeBounds.until_s,
    timeBounds.since_ms,
    timeBounds.until_ms,
    timeBounds.since_us,
    timeBounds.until_us,
    timeBounds.since_ns,
    timeBounds.until_ns,
    ...(limit ? [limit] : []),
  ]);
}

function selectMessageRowsByPackedSortSeq(db, tableName, timeBounds = {}, maxRows = 0) {
  const ranges = packedSortSeqRanges(timeBounds);
  if (!ranges.length) return [];
  const limit = Math.max(0, Math.trunc(Number(maxRows || 0)) || 0);
  const clauses = ranges.map(() => '(sort_seq >= cast(? as integer) and sort_seq <= cast(? as integer))').join(' or ');
  return db.prepare(`
    select local_id, server_id, local_type, cast(sort_seq as text) as sort_seq, real_sender_id, create_time,
           message_content, compress_content, packed_info_data
    from ${tableName}
    where sort_seq > 0 and (${clauses})
    order by sort_seq asc
    ${limit ? 'limit ?' : ''}
  `).all([...ranges.flatMap(range => [range.since, range.until]), ...(limit ? [limit] : [])])
    .map(row => ({ ...row, __sort_seq_packed: true }));
}

function packedSortSeqRanges(timeBounds = {}) {
  const ranges = [];
  for (const factor of SORT_SEQ_PACKED_MS_FACTORS) {
    const range = scaledIntegerRange(timeBounds.since_ms, timeBounds.until_ms, factor);
    if (range) ranges.push(range);
  }
  for (const factor of SORT_SEQ_PACKED_SECOND_FACTORS) {
    const range = scaledIntegerRange(timeBounds.since_s, timeBounds.until_s, factor);
    if (range) ranges.push(range);
  }
  return ranges;
}

function scaledIntegerRange(since, until, factor) {
  try {
    const start = BigInt(Math.max(0, Number(since || 0) || 0));
    const end = BigInt(Math.max(0, Number(until || since || 0) || 0));
    const scale = BigInt(Math.max(1, Number(factor || 1) || 1));
    if (!start || !end || end < start) return null;
    return {
      since: (start * scale).toString(),
      until: ((end * scale) + (scale - 1n)).toString(),
    };
  } catch {
    return null;
  }
}

function mergeMessageRowsByTimeSources(createTimeRows = [], sortSeqRows = [], timeBounds = {}, incrementalRows = []) {
  const rowsByKey = new Map();
  const createRows = (Array.isArray(createTimeRows) ? createTimeRows : [])
    .filter(row => messageRowTimeInBounds(row, 'create_time', timeBounds));
  const sortRows = (Array.isArray(sortSeqRows) ? sortSeqRows : [])
    .filter(row => messageRowTimeInBounds(row, 'sort_seq', timeBounds));
  for (const row of createRows) {
    rowsByKey.set(messageRowIdentity(row), { ...row, __time_source: 'create_time' });
  }
  let sortOnlyHitCount = 0;
  for (const row of sortRows) {
    const key = messageRowIdentity(row);
    const existing = rowsByKey.get(key);
    if (!existing) {
      sortOnlyHitCount++;
      rowsByKey.set(key, { ...row, __time_source: 'sort_seq' });
      continue;
    }
    if (!messageRowTimeInBounds(existing, 'create_time', timeBounds) && messageRowTimeInBounds(row, 'sort_seq', timeBounds)) {
      rowsByKey.set(key, { ...row, __time_source: 'sort_seq' });
    }
  }
  let incrementalOnlyHitCount = 0;
  const incrementalCandidates = Array.isArray(incrementalRows) ? incrementalRows : [];
  let incrementalOutOfRangeCount = 0;
  let incrementalConsumedCount = 0;
  for (const row of incrementalCandidates) {
    const inRequestedRange = messageRowTimeInBounds(row, 'create_time', timeBounds)
      || messageRowTimeInBounds(row, 'sort_seq', timeBounds);
    if (!inRequestedRange) incrementalOutOfRangeCount += 1;
    const key = messageRowIdentity(row);
    const existing = rowsByKey.get(key);
    if (existing) {
      rowsByKey.set(key, {
        ...existing,
        __late_sync_incremental: true,
        __late_sync_incremental_out_of_range: !inRequestedRange,
      });
      incrementalConsumedCount += 1;
      continue;
    }
    const createTimestamp = normalizeWxTimestamp(row.create_time);
    const sortTimestamp = normalizeWxSortSeqTimestamp(row.sort_seq, timeBounds);
    const timeSource = createTimestamp > 0 || sortTimestamp <= 0 ? 'create_time' : 'sort_seq';
    incrementalOnlyHitCount += 1;
    incrementalConsumedCount += 1;
    rowsByKey.set(key, {
      ...row,
      __time_source: timeSource,
      __late_sync_incremental: true,
      __late_sync_incremental_out_of_range: !inRequestedRange,
    });
  }
  return {
    rows: [...rowsByKey.values()],
    create_time_hit_count: createRows.length,
    sort_seq_hit_count: sortRows.length,
    sort_only_hit_count: sortOnlyHitCount,
    sort_seq_packed_hit_count: sortRows.filter(row => row.__sort_seq_packed).length,
    union_hit_count: rowsByKey.size,
    incremental_only_hit_count: incrementalOnlyHitCount,
    incremental_out_of_range_count: incrementalOutOfRangeCount,
    incremental_consumed_count: incrementalConsumedCount,
  };
}

function messageShardRowPositionAfterIncrementalMerge({
  row_positions_initialized = false,
  previous_row_id = 0,
  current_row_id = 0,
  incremental_row_count = 0,
  incremental_consumed_count = 0,
} = {}) {
  const previous = Math.max(0, Math.trunc(Number(previous_row_id || 0)) || 0);
  const current = Math.max(0, Math.trunc(Number(current_row_id || 0)) || 0);
  if (row_positions_initialized !== true || current <= previous) return current;
  const selected = Math.max(0, Math.trunc(Number(incremental_row_count || 0)) || 0);
  const consumed = Math.max(0, Math.trunc(Number(incremental_consumed_count || 0)) || 0);
  return consumed >= selected ? current : previous;
}

function normalizeMessageSortSeqValue(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return 0;
  try {
    const integer = BigInt(text);
    return integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer.toString();
  } catch {
    return 0;
  }
}

function compareMessageIntegerValues(left, right) {
  try {
    const a = BigInt(String(left ?? '').trim() || '0');
    const b = BigInt(String(right ?? '').trim() || '0');
    return a < b ? -1 : (a > b ? 1 : 0);
  } catch {
    return String(left ?? '').localeCompare(String(right ?? ''));
  }
}

function messageRowIdentity(row = {}) {
  const localId = String(row.local_id ?? '').trim();
  const serverId = String(row.server_id ?? '').trim();
  if (localId || serverId) return `${localId}\u0000${serverId}`;
  return crypto.createHash('sha1').update(JSON.stringify([
    row.create_time,
    row.sort_seq,
    row.local_type,
    row.real_sender_id,
    row.message_content,
  ])).digest('hex');
}

function dedupeMessagesAcrossShards(messages = []) {
  const out = [];
  const byIdentity = new Map();
  let duplicateCount = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    const serverId = String(message?.server_id || '').trim();
    const localId = String(message?.local_id ?? '').trim();
    const sortSeq = String(message?.sort_seq ?? '').trim();
    const timestamp = String(message?.timestamp ?? '').trim();
    const fallbackPayload = JSON.stringify([
      localId,
      sortSeq,
      timestamp,
      String(message?.sender_username || message?.sender || '').trim(),
      String(message?.raw_type ?? message?.type ?? '').trim(),
      String(message?.content || '').trim(),
    ]);
    const identity = serverId && serverId !== '0'
      ? `server:${serverId}`
      : (localId && (sortSeq || timestamp)
        ? `local:${crypto.createHash('sha1').update(fallbackPayload).digest('hex')}`
        : '');
    if (!identity) {
      out.push(message);
      continue;
    }
    const existingIndex = byIdentity.get(identity);
    if (existingIndex === undefined) {
      byIdentity.set(identity, out.length);
      out.push(message);
      continue;
    }
    duplicateCount += 1;
    const existing = out[existingIndex];
    if (existing?.time_source === 'sort_seq' && message?.time_source === 'create_time') {
      out[existingIndex] = message;
    }
  }
  return { messages: out, duplicate_count: duplicateCount };
}

function messageRowTimeInBounds(row = {}, columnName = 'create_time', timeBounds = {}) {
  const timestamp = columnName === 'sort_seq'
    ? normalizeWxSortSeqTimestamp(row.sort_seq, timeBounds)
    : normalizeWxTimestamp(row.create_time);
  const since = Number(timeBounds.since_ms || 0);
  const until = Number(timeBounds.until_ms || 0);
  return timestamp > 0 && timestamp >= since && (!until || timestamp <= until);
}

function normalizeMessageRowTimestamp(row = {}, timeSource = 'create_time', timeBounds = {}) {
  const primary = timeSource === 'sort_seq' ? row.sort_seq : row.create_time;
  return (timeSource === 'sort_seq' ? normalizeWxSortSeqTimestamp(primary, timeBounds) : normalizeWxTimestamp(primary))
    || normalizeWxTimestamp(row.create_time)
    || normalizePlausibleWxSortSeqTimestamp(row.sort_seq, timeBounds);
}

function plausibleWxDiagnosticTimeBounds(timeBounds = {}) {
  const upperCandidates = [
    Date.now() + PLAUSIBLE_WX_TIMESTAMP_FUTURE_GRACE_MS,
    Number(timeBounds.since_ms || 0) + PLAUSIBLE_WX_TIMESTAMP_FUTURE_GRACE_MS,
    Number(timeBounds.until_ms || 0) + PLAUSIBLE_WX_TIMESTAMP_FUTURE_GRACE_MS,
  ].filter(value => Number.isFinite(value) && value > PLAUSIBLE_WX_TIMESTAMP_MIN_MS);
  return {
    since_ms: PLAUSIBLE_WX_TIMESTAMP_MIN_MS,
    until_ms: Math.max(PLAUSIBLE_WX_TIMESTAMP_MIN_MS, ...upperCandidates),
  };
}

function timestampInPlausibleWxDiagnosticBounds(timestamp, timeBounds = {}) {
  return messageTimestampInBounds(timestamp, plausibleWxDiagnosticTimeBounds(timeBounds));
}

function normalizePlausibleWxTimestamp(value, timeBounds = {}) {
  const timestamp = normalizeWxTimestamp(value);
  return timestampInPlausibleWxDiagnosticBounds(timestamp, timeBounds) ? timestamp : 0;
}

function normalizePlausibleWxSortSeqTimestamp(value, timeBounds = {}) {
  const diagnosticBounds = plausibleWxDiagnosticTimeBounds(timeBounds);
  const packed = normalizePackedSortSeqTimestamp(value, diagnosticBounds);
  if (packed) return packed;
  const direct = normalizeWxTimestamp(value);
  return messageTimestampInBounds(direct, diagnosticBounds) ? direct : 0;
}

function normalizeSessionLastMessageTimestamp(session = {}) {
  const timeBounds = plausibleSessionTimeBounds();
  const sortTimestamp = normalizePlausibleWxSortSeqTimestamp(session?.sort_timestamp, timeBounds);
  if (sortTimestamp) return sortTimestamp;
  return normalizePlausibleWxTimestamp(session?.last_timestamp, timeBounds);
}

function normalizeSessionLastMessageEvidence(session = {}, { sessionAvailable = true } = {}) {
  if (!sessionAvailable) return { timestamp: 0, status: 'session_unavailable' };
  const timestamp = normalizeSessionLastMessageTimestamp(session);
  if (timestamp) return { timestamp, status: 'known' };
  const hasRawTime = String(session?.sort_timestamp ?? '').trim() || String(session?.last_timestamp ?? '').trim();
  return { timestamp: 0, status: hasRawTime ? 'untrusted_time' : 'unknown' };
}

function plausibleSessionTimeBounds() {
  return {
    since_ms: Date.UTC(2000, 0, 1),
    until_ms: Date.now() + 7 * 24 * 60 * 60 * 1000,
  };
}

function collectTableTimeStat(db, tableName, shardName, out, hitStats = {}, timeBounds = {}) {
  try {
    const row = db.prepare(`select min(create_time) as min_time, max(create_time) as max_time, min(sort_seq) as min_sort_seq, max(sort_seq) as max_sort_seq, count(*) as row_count from ${tableName}`).get();
    const count = Number(row?.row_count || 0) || 0;
    if (!count) return;
    const createHitCount = Math.max(0, Number(hitStats.create_time_hit_count || 0) || 0);
    const sortSeqHitCount = Math.max(0, Number(hitStats.sort_seq_hit_count || 0) || 0);
    const sortOnlyHitCount = Math.max(0, Number(hitStats.sort_only_hit_count || 0) || 0);
    const sortSeqPackedHitCount = Math.max(0, Number(hitStats.sort_seq_packed_hit_count || 0) || 0);
    const unionHitCount = Math.max(0, Number(hitStats.union_hit_count ?? hitStats.rows?.length ?? 0) || 0);
    const minTime = normalizeWxTimestamp(row.min_time);
    const maxTime = normalizeWxTimestamp(row.max_time);
    const minSortTime = normalizePlausibleWxSortSeqTimestamp(row.min_sort_seq, timeBounds);
    const maxSortTime = normalizePlausibleWxSortSeqTimestamp(row.max_sort_seq, timeBounds);
    const nearest = unionHitCount === 0
      ? nearestMessageTableTimes(db, tableName, timeBounds, {
        create_time: { min: minTime, max: maxTime },
        sort_seq: { min: minSortTime, max: maxSortTime },
      })
      : {};
    out.push({
      shard: shardName,
      row_count: count,
      hit_count: unionHitCount,
      create_time_hit_count: createHitCount,
      sort_seq_hit_count: sortSeqHitCount,
      sort_only_hit_count: sortOnlyHitCount,
      sort_seq_packed_hit_count: sortSeqPackedHitCount,
      union_hit_count: unionHitCount,
      time_source: sortOnlyHitCount > 0 ? 'sort_seq' : 'create_time',
      min_time: minTime,
      max_time: maxTime,
      min_sort_time: minSortTime,
      max_sort_time: maxSortTime,
      ...nearest,
    });
  } catch {
    // Empty-result diagnostics must never make message collection fail.
  }
}

function nearestMessageTableTimes(db, tableName, timeBounds = {}, known = {}) {
  const knownBefore = bestNearestTimeCandidate(knownNearestTimeCandidates(known, 'before', timeBounds), 'before', timeBounds);
  const knownAfter = bestNearestTimeCandidate(knownNearestTimeCandidates(known, 'after', timeBounds), 'after', timeBounds);
  const before = knownBefore || bestNearestTimeCandidate([
    ...nearestDirectTimeCandidates(db, tableName, 'create_time', timeBounds, 'before'),
    ...nearestDirectTimeCandidates(db, tableName, 'sort_seq', timeBounds, 'before'),
    ...nearestPackedSortSeqTimeCandidates(db, tableName, timeBounds, 'before'),
  ], 'before', timeBounds);
  const after = knownAfter || bestNearestTimeCandidate([
    ...nearestDirectTimeCandidates(db, tableName, 'create_time', timeBounds, 'after'),
    ...nearestDirectTimeCandidates(db, tableName, 'sort_seq', timeBounds, 'after'),
    ...nearestPackedSortSeqTimeCandidates(db, tableName, timeBounds, 'after'),
  ], 'after', timeBounds);
  return compactObject({
    nearest_before_time: before?.timestamp || 0,
    nearest_before_source: before?.source || '',
    nearest_after_time: after?.timestamp || 0,
    nearest_after_source: after?.source || '',
  });
}

function knownNearestTimeCandidates(known = {}, direction = 'before', timeBounds = {}) {
  const since = Number(timeBounds.since_ms || 0);
  const until = Number(timeBounds.until_ms || 0);
  const pairs = direction === 'before'
    ? [
      { timestamp: Number(known.create_time?.max || 0) || 0, source: 'create_time' },
      { timestamp: Number(known.sort_seq?.max || 0) || 0, source: 'sort_seq' },
    ]
    : [
      { timestamp: Number(known.create_time?.min || 0) || 0, source: 'create_time' },
      { timestamp: Number(known.sort_seq?.min || 0) || 0, source: 'sort_seq' },
    ];
  return pairs.filter(item => item.timestamp > 0)
    .filter(item => direction === 'before'
      ? (since > 0 && item.timestamp < since)
      : (!until || item.timestamp > until));
}

function nearestDirectTimeCandidates(db, tableName, columnName, timeBounds = {}, direction = 'before') {
  const column = columnName === 'sort_seq' ? 'sort_seq' : 'create_time';
  const source = column === 'sort_seq' ? 'sort_seq' : 'create_time';
  const ranges = direction === 'before'
    ? [
      { bound: timeBounds.since_s },
      { bound: timeBounds.since_ms },
      { bound: timeBounds.since_us },
      { bound: timeBounds.since_ns },
    ]
    : [
      { bound: timeBounds.until_s },
      { bound: timeBounds.until_ms },
      { bound: timeBounds.until_us },
      { bound: timeBounds.until_ns },
  ];
  const op = direction === 'before' ? '<' : '>';
  const aggregate = direction === 'before' ? 'max' : 'min';
  const out = [];
  for (const range of ranges) {
    if (range.bound === undefined || range.bound === null || range.bound === '') continue;
    try {
      const row = db.prepare(`
        select ${aggregate}(${column}) as value
        from ${tableName}
        where ${column} > 0 and ${column} ${op} cast(? as integer)
      `).get([String(range.bound)]);
      const timestamp = column === 'sort_seq'
        ? normalizePlausibleWxSortSeqTimestamp(row?.value, timeBounds)
        : normalizePlausibleWxTimestamp(row?.value, timeBounds);
      if (timestamp) out.push({ timestamp, source });
    } catch {}
  }
  return out;
}

function nearestPackedSortSeqTimeCandidates(db, tableName, timeBounds = {}, direction = 'before') {
  const out = [];
  for (const factor of SORT_SEQ_PACKED_MS_FACTORS) {
    const candidate = nearestPackedSortSeqTimeCandidate(db, tableName, timeBounds, direction, factor, 'ms');
    if (candidate) out.push(candidate);
  }
  for (const factor of SORT_SEQ_PACKED_SECOND_FACTORS) {
    const candidate = nearestPackedSortSeqTimeCandidate(db, tableName, timeBounds, direction, factor, 's');
    if (candidate) out.push(candidate);
  }
  return out;
}

function nearestPackedSortSeqTimeCandidate(db, tableName, timeBounds = {}, direction = 'before', factor = 1, unit = 'ms') {
  const base = unit === 's'
    ? (direction === 'before' ? timeBounds.since_s : timeBounds.until_s)
    : (direction === 'before' ? timeBounds.since_ms : timeBounds.until_ms);
  const range = scaledIntegerRange(base, base, factor);
  if (!range) return null;
  const bound = direction === 'before' ? range.since : range.until;
  const op = direction === 'before' ? '<' : '>';
  const aggregate = direction === 'before' ? 'max' : 'min';
  try {
    const row = db.prepare(`
      select ${aggregate}(sort_seq) as value
      from ${tableName}
      where sort_seq > 0 and sort_seq ${op} cast(? as integer)
    `).get([bound]);
    const raw = Number(row?.value || 0);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const timestamp = unit === 's'
      ? Math.floor(raw / factor) * 1000
      : Math.floor(raw / factor);
    return { timestamp, source: 'packed_sort_seq' };
  } catch {
    return null;
  }
}

function bestNearestTimeCandidate(candidates = [], direction = 'before', timeBounds = {}) {
  const since = Number(timeBounds.since_ms || 0);
  const until = Number(timeBounds.until_ms || 0);
  const plausible = (Array.isArray(candidates) ? candidates : [])
    .map(item => ({ ...item, timestamp: Number(item?.timestamp || 0) || 0 }))
    .filter(item => item.timestamp >= 946684800000)
    .filter(item => direction === 'before'
      ? (since > 0 && item.timestamp < since)
      : (!until || item.timestamp > until));
  if (!plausible.length) return null;
  plausible.sort((a, b) => direction === 'before'
    ? b.timestamp - a.timestamp
    : a.timestamp - b.timestamp);
  return plausible[0];
}

function summarizeTableTimeStats(stats = []) {
  const valid = (Array.isArray(stats) ? stats : [])
    .filter(item => Number(item.row_count || 0) > 0
      || Number(item.hit_count || 0) > 0
      || Number(item.min_time || 0) > 0
      || Number(item.max_time || 0) > 0
      || Number(item.min_sort_time || 0) > 0
      || Number(item.max_sort_time || 0) > 0);
  if (!valid.length) return null;
  const createTimes = valid.flatMap(item => [Number(item.min_time || 0), Number(item.max_time || 0)].filter(Boolean));
  const minTime = createTimes.length ? Math.min(...createTimes) : 0;
  const maxTime = createTimes.length ? Math.max(...createTimes) : 0;
  const rowCount = valid.reduce((sum, item) => sum + (Number(item.row_count || 0) || 0), 0);
  const hitCount = valid.reduce((sum, item) => sum + (Number(item.hit_count || 0) || 0), 0);
  const createHitCount = valid.reduce((sum, item) => sum + (Number(item.create_time_hit_count || 0) || 0), 0);
  const sortSeqHitCount = valid.reduce((sum, item) => sum + (Number(item.sort_seq_hit_count || 0) || 0), 0);
  const sortOnlyHitCount = valid.reduce((sum, item) => sum + (Number(item.sort_only_hit_count || 0) || 0), 0);
  const sortSeqPackedHitCount = valid.reduce((sum, item) => sum + (Number(item.sort_seq_packed_hit_count || 0) || 0), 0);
  const hitShardCount = valid.filter(item => Number(item.hit_count || 0) > 0).length;
  const fallbackHitCount = sortOnlyHitCount;
  const sortTimes = valid.flatMap(item => [Number(item.min_sort_time || 0), Number(item.max_sort_time || 0)].filter(Boolean));
  const sortMinTime = sortTimes.length ? Math.min(...sortTimes) : 0;
  const sortMaxTime = sortTimes.length ? Math.max(...sortTimes) : 0;
  const nearestBefore = nearestSummaryCandidate(valid, 'before');
  const nearestAfter = nearestSummaryCandidate(valid, 'after');
  return {
    row_count: rowCount,
    hit_count: hitCount,
    create_time_hit_count: createHitCount,
    sort_seq_hit_count: sortSeqHitCount,
    sort_only_hit_count: sortOnlyHitCount,
    sort_seq_packed_hit_count: sortSeqPackedHitCount,
    union_hit_count: hitCount,
    fallback_hit_count: fallbackHitCount,
    shard_count: valid.length,
    hit_shard_count: hitShardCount,
    first_time: minTime ? formatMessageTime(minTime) : '',
    last_time: maxTime ? formatMessageTime(maxTime) : '',
    sort_first_time: sortMinTime ? formatMessageTime(sortMinTime) : '',
    sort_last_time: sortMaxTime ? formatMessageTime(sortMaxTime) : '',
    ...(nearestBefore ? {
      nearest_before_time: formatMessageTime(nearestBefore.timestamp),
      nearest_before_source: nearestBefore.source,
      nearest_before_shard: nearestBefore.shard,
    } : {}),
    ...(nearestAfter ? {
      nearest_after_time: formatMessageTime(nearestAfter.timestamp),
      nearest_after_source: nearestAfter.source,
      nearest_after_shard: nearestAfter.shard,
    } : {}),
    shards: valid.slice(0, 8).map(item => ({
      shard: item.shard,
      row_count: Number(item.row_count || 0) || 0,
      hit_count: Number(item.hit_count || 0) || 0,
      create_time_hit_count: Number(item.create_time_hit_count || 0) || 0,
      sort_seq_hit_count: Number(item.sort_seq_hit_count || 0) || 0,
      sort_only_hit_count: Number(item.sort_only_hit_count || 0) || 0,
      sort_seq_packed_hit_count: Number(item.sort_seq_packed_hit_count || 0) || 0,
      union_hit_count: Number(item.union_hit_count || item.hit_count || 0) || 0,
      time_source: item.time_source || 'create_time',
      first_time: item.min_time ? formatMessageTime(item.min_time) : '',
      last_time: item.max_time ? formatMessageTime(item.max_time) : '',
      sort_first_time: item.min_sort_time ? formatMessageTime(item.min_sort_time) : '',
      sort_last_time: item.max_sort_time ? formatMessageTime(item.max_sort_time) : '',
      ...(item.nearest_before_time ? {
        nearest_before_time: formatMessageTime(item.nearest_before_time),
        nearest_before_source: item.nearest_before_source || '',
      } : {}),
      ...(item.nearest_after_time ? {
        nearest_after_time: formatMessageTime(item.nearest_after_time),
        nearest_after_source: item.nearest_after_source || '',
      } : {}),
    })),
  };
}

function nearestSummaryCandidate(stats = [], direction = 'before') {
  const timeKey = direction === 'before' ? 'nearest_before_time' : 'nearest_after_time';
  const sourceKey = direction === 'before' ? 'nearest_before_source' : 'nearest_after_source';
  const candidates = (Array.isArray(stats) ? stats : [])
    .map(item => ({
      timestamp: Number(item?.[timeKey] || 0) || 0,
      source: item?.[sourceKey] || '',
      shard: item?.shard || '',
    }))
    .filter(item => item.timestamp >= 946684800000);
  if (!candidates.length) return null;
  candidates.sort((a, b) => direction === 'before'
    ? b.timestamp - a.timestamp
    : a.timestamp - b.timestamp);
  return candidates[0];
}

async function hydrateSenderNames(account, rawKeys, messages, groupId = '', { signal = null, onProgress = null, allow_stale_account = false } = {}) {
  throwIfAborted(signal);
  const usernames = [...new Set(messages.map(m => m.sender).filter(Boolean))];
  if (!usernames.length) {
    return {
      ok: true,
      attempted: false,
      raw_sender_count: 0,
      mapped_sender_count: 0,
      unmapped_sender_count: 0,
      unmapped_sender_sample: [],
      updated_message_count: 0,
    };
  }
  const failureCacheScope = senderHydrationFailureCacheScope(account);
  const keyFingerprints = senderHydrationRawKeyFingerprints(rawKeys);
  const cachedFailure = senderHydrationCachedFailure(failureCacheScope, keyFingerprints);
  if (cachedFailure) {
    notifyProgress(onProgress, {
      phase: 'fetch_senders_contact_failure_cache_hit',
      label: '拉取消息 · 跳过重复昵称补全',
      detail: `同一账号和本地数据刚确认 contact.db 暂不可读（${cachedFailure.error_code}），直接使用原始 ID`,
    });
    return senderHydrationFailureResult(usernames, cachedFailure.error_code, { cached: true });
  }
  let contact = null;
  try {
    notifyProgress(onProgress, {
      phase: 'fetch_senders_contact_open',
      label: '拉取消息 · 补全发送人',
      detail: '尝试用已有密钥快速打开 contact.db；不为可选昵称补全触发扩展扫描',
    });
    contact = await openCopiedSqlCipherDb(account, path.join(account.db_storage, 'contact', 'contact.db'), rawKeys, { signal, onProgress, allow_key_scan: false, allow_stale_account });
    senderHydrationFailureCache.delete(failureCacheScope);
    prioritizeRawKeyCandidate(rawKeys, contact.raw_key);
    throwIfAborted(signal);
    const stmt = contact.db.prepare(`
      select coalesce(nullif(nick_name, ''), username) as name
      from contact
      where username = ?
      limit 1
    `);
    const roomMemberNames = readRoomMemberNames(contact.db, groupId);
    const map = new Map();
    for (const username of usernames) {
      throwIfAborted(signal);
      if (roomMemberNames.has(username)) {
        map.set(username, roomMemberNames.get(username));
        continue;
      }
      const row = stmt.get([username]);
      if (row?.name) map.set(username, String(row.name));
    }
    let updatedMessageCount = 0;
    const unmappedSenderSample = [];
    for (const msg of messages) {
      throwIfAborted(signal);
      const username = String(msg.sender_username || msg.sender || '').trim();
      if (username) msg.sender_username = username;
      if (map.has(username)) {
        const hydrated = map.get(username);
        msg.sender_display_name = hydrated;
        if (hydrated !== msg.sender) updatedMessageCount += 1;
        msg.sender = hydrated;
      } else {
        msg.sender_display_name = msg.sender_display_name || '';
        if (username && unmappedSenderSample.length < 10 && !unmappedSenderSample.includes(username)) {
          unmappedSenderSample.push(username);
        }
      }
    }
    const unmappedSenderCount = Math.max(0, usernames.length - map.size);
    return {
      ok: true,
      attempted: true,
      raw_sender_count: usernames.length,
      mapped_sender_count: map.size,
      unmapped_sender_count: unmappedSenderCount,
      unmapped_sender_sample: unmappedSenderSample,
      updated_message_count: updatedMessageCount,
    };
  } catch (e) {
    if (e?.status === 499 || e?.name === 'AbortError' || signal?.aborted) throw e;
    throwIfMirrorReadGenerationChanged(e);
    const errorCode = senderHydrationFailureCode(e);
    if (senderHydrationFailureCacheable(e, errorCode)) {
      rememberSenderHydrationFailure(failureCacheScope, keyFingerprints, errorCode);
    }
    return senderHydrationFailureResult(usernames, errorCode);
  } finally {
    await closeCopiedDbHandle(contact);
  }
}

function senderHydrationFailureCode(error) {
  const explicitCode = String(error?.public_code || error?.code || '').trim();
  const namedCode = String(error?.name || '').trim();
  const code = explicitCode || (namedCode && namedCode !== 'Error' ? namedCode : '');
  if (code) return code.toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 80);
  const text = String(error?.message || error || '').toLowerCase();
  if (/enoent|not found|no such file|找不到|未找到|不存在/.test(text)) return 'contact_db_missing';
  if (/decrypt|cipher|hmac|key|密钥|解密/.test(text)) return 'contact_db_key_failed';
  if (/busy|locked|占用|database is locked/.test(text)) return 'contact_db_busy';
  return 'sender_hydration_failed';
}

function senderHydrationFailureResult(usernames = [], errorCode = 'sender_hydration_failed', { cached = false } = {}) {
  const list = Array.isArray(usernames) ? usernames : [];
  return {
    ok: false,
    attempted: !cached,
    cached_failure: cached,
    raw_sender_count: list.length,
    mapped_sender_count: 0,
    unmapped_sender_count: list.length,
    unmapped_sender_sample: list.slice(0, 10),
    updated_message_count: 0,
    error_code: String(errorCode || 'sender_hydration_failed'),
  };
}

function senderHydrationFailureCacheScope(account = {}) {
  const mirror = account?.mirror || {};
  return crypto.createHash('sha256').update(JSON.stringify([
    account.account_id || account.id || account.wxid || '',
    account.db_storage || '',
    mirror.source_snapshot_hash || mirror.source_snapshot_meta_hash || '',
    mirror.refreshed_at || mirror.mirror_refreshed_at || '',
  ])).digest('hex');
}

function senderHydrationRawKeyFingerprints(rawKeys = []) {
  return uniqueStrings(Array.isArray(rawKeys) ? rawKeys : [])
    .map(persistableRawKey)
    .filter(Boolean)
    .map(key => crypto.createHash('sha256').update(key).digest('hex').slice(0, 16))
    .sort();
}

function senderHydrationFailureCacheCovers(item = null, keyFingerprints = []) {
  if (!item) return false;
  const tested = new Set(Array.isArray(item.tested_key_fingerprints) ? item.tested_key_fingerprints : []);
  return (Array.isArray(keyFingerprints) ? keyFingerprints : []).every(fingerprint => tested.has(fingerprint));
}

function senderHydrationCachedFailure(scope = '', keyFingerprints = [], now = Date.now()) {
  pruneSenderHydrationFailureCache(now);
  const item = senderHydrationFailureCache.get(String(scope || ''));
  if (!item || now - Number(item.at || 0) > SENDER_HYDRATION_FAILURE_CACHE_MS) return null;
  return senderHydrationFailureCacheCovers(item, keyFingerprints) ? item : null;
}

function rememberSenderHydrationFailure(scope = '', keyFingerprints = [], errorCode = '') {
  const cacheKey = String(scope || '');
  const code = String(errorCode || '').trim();
  if (!cacheKey || !code) return;
  const previous = senderHydrationFailureCache.get(cacheKey);
  const testedKeyFingerprints = [...new Set([
    ...(Array.isArray(previous?.tested_key_fingerprints) ? previous.tested_key_fingerprints : []),
    ...(Array.isArray(keyFingerprints) ? keyFingerprints : []),
  ])].sort();
  senderHydrationFailureCache.set(cacheKey, {
    at: Date.now(),
    error_code: code,
    tested_key_fingerprints: testedKeyFingerprints,
  });
  pruneSenderHydrationFailureCache();
}

function pruneSenderHydrationFailureCache(now = Date.now()) {
  for (const [key, item] of senderHydrationFailureCache.entries()) {
    if (now - Number(item?.at || 0) > SENDER_HYDRATION_FAILURE_CACHE_MS) senderHydrationFailureCache.delete(key);
  }
  if (senderHydrationFailureCache.size <= SENDER_HYDRATION_FAILURE_CACHE_LIMIT) return;
  const oldest = [...senderHydrationFailureCache.entries()]
    .sort((a, b) => Number(a[1]?.at || 0) - Number(b[1]?.at || 0));
  for (const [key] of oldest.slice(0, senderHydrationFailureCache.size - SENDER_HYDRATION_FAILURE_CACHE_LIMIT)) {
    senderHydrationFailureCache.delete(key);
  }
}

function senderHydrationFailureCacheable(error = null, errorCode = '') {
  const text = `${errorCode} ${error?.message || ''}`.toLowerCase();
  return !/(busy|locked|timeout|timed_out|cancel|abort|stale|mirror|snapshot|temporar|占用|超时|取消)/.test(text);
}

function senderHydrationSenderFilterRisk(senderHydration = null, messages = [], senderTerms = []) {
  const terms = [...new Set((Array.isArray(senderTerms) ? senderTerms : [])
    .map(normalizeSenderFilterTerm)
    .filter(Boolean))];
  if (!terms.length) return { risky: false, reason: 'no_sender_filter_terms' };
  const rawSenders = new Set((Array.isArray(messages) ? messages : [])
    .map(message => normalizeSenderFilterTerm(message?.sender_username || ''))
    .filter(Boolean));
  const rawMatchedTerms = terms.filter(term => rawSenders.has(term));
  if (rawMatchedTerms.length === terms.length) {
    return {
      risky: false,
      reason: 'raw_sender_terms_exactly_matched',
      term_count: terms.length,
      raw_matched_term_count: rawMatchedTerms.length,
    };
  }
  return {
    risky: true,
    reason: senderHydration?.ok === false ? 'sender_hydration_failed' : 'sender_hydration_incomplete',
    term_count: terms.length,
    raw_matched_term_count: rawMatchedTerms.length,
    raw_sender_count: rawSenders.size,
  };
}

function normalizeSenderFilterTerm(value) {
  return String(value || '').normalize('NFKC').toLowerCase().trim();
}

function readRoomMemberNames(db, groupId) {
  const map = new Map();
  if (!groupId || !String(groupId).includes('@chatroom')) return map;
  try {
    const room = db.prepare('select id, ext_buffer from chat_room where username = ? limit 1').get([groupId]);
    for (const item of parseChatRoomMemberBuffer(room?.ext_buffer)) {
      if (item.username && item.display_name) map.set(item.username, item.display_name);
    }
  } catch {
    // Group-specific member cards vary across WeChat v4 builds; contact nicknames are the fallback.
  }
  return map;
}

function parseChatRoomMemberBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return [];
  const out = [];
  for (const field of readProtoFields(buffer)) {
    if (field.field !== 1 || !Buffer.isBuffer(field.value)) continue;
    const member = {};
    for (const sub of readProtoFields(field.value)) {
      if (sub.field === 1 && Buffer.isBuffer(sub.value)) member.username = cleanDecodedString(sub.value.toString('utf-8'));
      if (sub.field === 2 && Buffer.isBuffer(sub.value)) member.display_name = cleanDecodedString(sub.value.toString('utf-8'));
    }
    if (member.username && member.display_name) out.push(member);
  }
  return out;
}

function groupSearchFields(name, quanPin = '', pinYinInitial = '') {
  const pinyin = normalizeSearchToken(quanPin);
  const pinyinInitial = normalizeSearchToken(pinYinInitial) || groupPinyinInitial(name);
  return {
    pinyin: pinyin || pinyinInitial,
    pinyin_initial: pinyinInitial,
  };
}

function groupPinyinInitial(text) {
  return Array.from(String(text || ''))
    .map(ch => pinyinInitialForChar(ch))
    .join('')
    .toLowerCase();
}

function pinyinInitialForChar(ch) {
  const normalized = String(ch || '').normalize('NFKC');
  if (/^[a-z0-9]$/i.test(normalized)) return normalized.toUpperCase();
  if (!/[\u3400-\u9fff]/u.test(normalized)) return '';
  for (let i = 0; i < PINYIN_ANCHORS.length; i++) {
    if (normalized.localeCompare(PINYIN_ANCHORS[i], 'zh-Hans-CN-u-co-pinyin') < 0) {
      return PINYIN_INITIALS[Math.max(0, i - 1)] || '';
    }
  }
  return 'Z';
}

function normalizeSearchToken(value) {
  return String(value || '').normalize('NFKC').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

async function enrichMessageMedia(account, rawKeys, messages, { signal = null, onProgress = null, maxMs = MEDIA_ENRICHMENT_MAX_MS, allow_stale_account = false } = {}) {
  throwIfAborted(signal);
  const mediaMessages = messages.filter(m => m.media && (m.media.md5 || m.media.file_key || m.media.file_name || ['voice', 'video'].includes(m.type)));
  if (!mediaMessages.length) return;
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(1000, Number(maxMs || MEDIA_ENRICHMENT_MAX_MS));
  const remainingMs = () => Math.max(0, deadline - Date.now());
  const overBudget = () => Date.now() >= deadline;
  const notifyMedia = (phase, detail) => notifyProgress(onProgress, {
    phase,
    label: '拉取消息 · 解析媒体',
    detail,
  });
  const markJobsOverBudget = (jobs, reason) => {
    for (const job of jobs || []) markMediaPayloadMissing(job.msg, reason);
  };
  notifyMedia('fetch_media_locate', `待检查 ${mediaMessages.length} 条媒体消息，最多用时 ${Math.round(Math.max(1000, Number(maxMs || MEDIA_ENRICHMENT_MAX_MS)) / 1000)} 秒`);
  let hardlink = null;
  const copiedMediaRoots = new Set();
  const rememberCopiedMedia = copy => {
    if (copy?.temp_root) copiedMediaRoots.add(copy.temp_root);
    return copy?.target_path || '';
  };
  try {
    const dirCache = new Map();
    let dirStmt = null;
    let imageStmt = null;
    let fileByMd5Stmt = null;
    let fileByNameStmt = null;
    let imageByNameStmt = null;
    try {
      hardlink = await openCopiedSqlCipherDb(account, path.join(account.db_storage, 'hardlink', 'hardlink.db'), rawKeys, { signal, allow_stale_account });
      prioritizeRawKeyCandidate(rawKeys, hardlink.raw_key);
      dirStmt = hardlink.db.prepare('select username from dir2id where rowid = ? limit 1');
      imageStmt = hardlink.db.prepare(`
        select md5, type, file_name, file_size, modify_time, dir1, dir2
        from image_hardlink_info_v4
        where md5 = ?
        order by file_size desc
        limit 1
      `);
      fileByMd5Stmt = hardlink.db.prepare(`
        select md5, type, file_name, file_size, modify_time, dir1, dir2
        from file_hardlink_info_v4
        where md5 = ?
        order by file_size desc
        limit 1
      `);
      fileByNameStmt = hardlink.db.prepare(`
        select md5, type, file_name, file_size, modify_time, dir1, dir2
        from file_hardlink_info_v4
        where file_name = ?
        order by file_size desc
        limit 1
      `);
      imageByNameStmt = hardlink.db.prepare(`
        select md5, type, file_name, file_size, modify_time, dir1, dir2
        from image_hardlink_info_v4
        where file_name = ?
        order by file_size desc
        limit 1
      `);
    } catch (e) {
      throwIfMirrorReadGenerationChanged(e);
      hardlink = null;
    }

    const dirName = (id) => {
      const n = Number(id || 0);
      if (!n || !dirStmt) return '';
      if (!dirCache.has(n)) dirCache.set(n, String(dirStmt.get([n])?.username || ''));
      return dirCache.get(n);
    };

    const imageJobs = [];
    const videoJobs = [];
    const audioJobs = [];
    const imageSamples = [];
    const localImageSearch = { index: null };

    let locatedCount = 0;
    let lastLocatedProgress = 0;
    for (const msg of mediaMessages) {
      throwIfAborted(signal);
      if (overBudget()) {
        markMediaPayloadMissing(msg, '媒体解析超出本次预算，已保留元信息继续生成');
        continue;
      }
      try {
        if (msg.type === 'image') {
          const row = (imageStmt && msg.media.md5 ? imageStmt.get([msg.media.md5]) : null)
            || findImageByFileKey(imageByNameStmt, msg.media.file_key)
            || findImageByFileName(imageByNameStmt, msg.media.file_name);
          let localPath = '';
          if (row) {
            msg.media.file_name = msg.media.file_name || String(row.file_name || '');
            msg.media.size = msg.media.size || Number(row.file_size || 0);
            const d1 = dirName(row.dir1);
            const d2 = dirName(row.dir2);
            localPath = d1 && d2 && row.file_name
              ? mediaPath(account, 'msg', 'attach', d1, d2, 'Img', row.file_name)
              : '';
          }
          if (!localPath && msg.media.file_key) {
            localPath = await findLocalImagePathByFileKey(account, msg.media.file_key, localImageSearch, msg, { signal });
            if (localPath) {
              msg.media.file_name = msg.media.file_name || path.basename(localPath);
              const st = await safeMediaSourceFileStat(account, localPath, { signal });
              if (st?.isFile()) msg.media.size = msg.media.size || st.size;
            }
          }
          if (!localPath && msg.media.file_name) {
            localPath = await findLocalImagePathByFileName(account, msg.media.file_name, msg, { signal });
            if (localPath) {
              msg.media.file_name = msg.media.file_name || path.basename(localPath);
              const st = await safeMediaSourceFileStat(account, localPath, { signal });
              if (st?.isFile()) msg.media.size = msg.media.size || st.size;
            }
          }
          if (localPath) {
            msg.media.local_available = await mediaFileExists(account, localPath, { signal });
            if (msg.media.local_available) {
              const copiedImage = await copyMediaFileForRead(account, localPath, { signal, include_image_siblings: true });
              const copiedImagePath = rememberCopiedMedia(copiedImage);
              imageJobs.push({ msg, localPath: copiedImagePath, sourcePath: localPath });
              try {
                imageSamples.push(...await readImageValidationSamples(copiedImagePath, { signal }));
              } catch (e) {
                if (e?.status === 499 || signal?.aborted) throw e;
                markMediaEnrichmentFailure(msg, e, '图片解密样本读取失败');
              }
            }
          } else {
            markMediaPayloadMissing(msg, '本机未找到或未下载图片文件，只能保留图片元信息');
          }
          if (localPath && !msg.media.local_available) {
            markMediaPayloadMissing(msg, '本机图片路径已定位但文件不可读，只能保留图片元信息');
          }
        } else if (msg.type === 'file') {
          const row = (fileByMd5Stmt && msg.media.md5 ? fileByMd5Stmt.get([msg.media.md5]) : null)
            || (fileByNameStmt && msg.media.file_name ? fileByNameStmt.get([msg.media.file_name]) : null);
          if (row) {
            msg.media.file_name = msg.media.file_name || String(row.file_name || '');
            msg.media.size = msg.media.size || Number(row.file_size || 0);
            const localPath = await resolveAttachPath(account, dirName(row.dir1), dirName(row.dir2), row.file_name, ['File', 'Video', 'Audio'], { signal })
              || await findLocalMessageFilePath(account, row.file_name, msg, { signal });
            if (localPath) {
              msg.media.local_available = true;
              msg.media.local_path_hint = path.basename(localPath);
              msg.media.ext = msg.media.ext || path.extname(localPath).slice(1).toLowerCase();
              if (isVideoLike(msg.media)) videoJobs.push({ msg, localPath });
              else if (isAudioLike(msg.media)) audioJobs.push({ msg, localPath });
            }
          } else if (msg.media.file_name) {
            const localPath = await findLocalMessageFilePath(account, msg.media.file_name, msg, { signal });
            if (localPath) {
              msg.media.local_available = true;
              msg.media.local_path_hint = path.basename(localPath);
              msg.media.ext = msg.media.ext || path.extname(localPath).slice(1).toLowerCase();
              const st = await safeMediaSourceFileStat(account, localPath, { signal });
              if (st?.isFile()) msg.media.size = msg.media.size || st.size;
              if (isVideoLike(msg.media)) videoJobs.push({ msg, localPath });
              else if (isAudioLike(msg.media)) audioJobs.push({ msg, localPath });
            }
          }
          if (!msg.media.local_available && isVideoLike(msg.media)) {
            markMediaPayloadMissing(msg, '本机未找到或未下载视频文件，只能保留文件元信息');
          } else if (!msg.media.local_available && isAudioLike(msg.media)) {
            markMediaPayloadMissing(msg, '本机未找到或未下载音频文件，只能保留文件元信息');
          }
          msg.content = formatFileContent(msg.media);
        } else if (msg.type === 'video') {
          const row = (fileByMd5Stmt && msg.media.md5 ? fileByMd5Stmt.get([msg.media.md5]) : null)
            || (fileByNameStmt && msg.media.file_name ? fileByNameStmt.get([msg.media.file_name]) : null);
          let localPath = '';
          if (row) {
            msg.media.file_name = msg.media.file_name || String(row.file_name || '');
            msg.media.size = msg.media.size || Number(row.file_size || 0);
            localPath = await resolveAttachPath(account, dirName(row.dir1), dirName(row.dir2), row.file_name, ['Video', 'File'], { signal })
              || await findLocalMessageFilePath(account, row.file_name, msg, { signal });
          }
          if (!localPath && msg.media.file_key) {
            localPath = await findLocalVideoPathByFileKey(account, msg.media.file_key, msg, { signal });
            if (localPath) {
              msg.media.file_name = msg.media.file_name || path.basename(localPath);
              const st = await safeMediaSourceFileStat(account, localPath, { signal });
              if (st?.isFile()) msg.media.size = msg.media.size || st.size;
            }
          }
          if (localPath) {
            msg.media.local_available = true;
            msg.media.local_path_hint = path.basename(localPath);
            videoJobs.push({ msg, localPath });
          } else {
            markMediaPayloadMissing(msg, '本机未找到或未下载视频文件，只能保留视频元信息');
          }
          msg.content = formatVideoContent(msg.media);
        } else if (msg.type === 'voice') {
          const row = (fileByMd5Stmt && msg.media.md5 ? fileByMd5Stmt.get([msg.media.md5]) : null)
            || (fileByNameStmt && msg.media.file_name ? fileByNameStmt.get([msg.media.file_name]) : null)
            || findFileByFileKey(fileByNameStmt, msg.media.file_key, VOICE_FILE_EXTENSIONS);
          let localPath = '';
          if (row) {
            msg.media.file_name = msg.media.file_name || String(row.file_name || '');
            msg.media.size = msg.media.size || Number(row.file_size || 0);
            localPath = await resolveAttachPath(account, dirName(row.dir1), dirName(row.dir2), row.file_name, ['Voice', 'Audio', 'File'], { signal })
              || await findLocalVoicePathByFileName(account, row.file_name, msg, { signal });
          }
          if (!localPath && msg.media.file_name) {
            localPath = await findLocalVoicePathByFileName(account, msg.media.file_name, msg, { signal });
          }
          if (!localPath && msg.media.file_key) {
            localPath = await findLocalVoicePathByFileKey(account, msg.media.file_key, msg, { signal });
          }
          if (localPath) {
            msg.media.local_available = true;
            msg.media.local_path_hint = path.basename(localPath);
            msg.media.file_name = msg.media.file_name || path.basename(localPath);
            msg.media.ext = msg.media.ext || path.extname(localPath).slice(1).toLowerCase();
            const st = await safeMediaSourceFileStat(account, localPath, { signal });
            if (st?.isFile()) msg.media.size = msg.media.size || st.size;
            audioJobs.push({ msg, localPath });
          } else {
            markMediaPayloadMissing(msg, '本机未找到或未下载语音/音频文件，只能保留语音元信息');
          }
          msg.content = formatVoiceContent(msg.media);
        }
        locatedCount += msg.media?.local_available ? 1 : 0;
        if (locatedCount && locatedCount % 10 === 0 && locatedCount !== lastLocatedProgress) {
          lastLocatedProgress = locatedCount;
          notifyMedia('fetch_media_locating', `已定位 ${locatedCount} 个本机媒体文件，剩余预算 ${Math.ceil(remainingMs() / 1000)} 秒`);
        }
      } catch (e) {
        if (e?.status === 499 || signal?.aborted) throw e;
        markMediaEnrichmentFailure(msg, e, '媒体定位失败');
      }
    }
    notifyMedia('fetch_media_located', `图片 ${imageJobs.length}，视频 ${videoJobs.length}，语音/音频 ${audioJobs.length}；剩余预算 ${Math.ceil(remainingMs() / 1000)} 秒`);

    let imageKeys = [];
    try {
      if (imageSamples.length && !overBudget()) {
        notifyMedia('fetch_media_image_key', `扫描图片解密 key 样本 ${Math.min(imageSamples.length, 32)} 个`);
        imageKeys = await getImageKeyCandidatesForSamples(imageSamples, { signal, maxMs: Math.min(IMAGE_KEY_SCAN_MAX_MS, remainingMs()) });
        notifyMedia('fetch_media_image_key_done', imageKeys.length ? `命中图片 key ${imageKeys.length} 条` : '未命中图片 key，保留可读图片元信息');
      }
    } catch (e) {
      if (e?.status === 499 || signal?.aborted) throw e;
      for (const job of imageJobs) markMediaEnrichmentFailure(job.msg, e, '图片解密 key 扫描失败');
    }
    const imageDecodeJobs = imageJobs.slice(0, MEDIA_DECODE_MAX_ITEMS_PER_KIND);
    const skippedImageJobs = imageJobs.slice(imageDecodeJobs.length);
    markJobsOverBudget(skippedImageJobs, `媒体数量较多，本次仅尝试解析前 ${MEDIA_DECODE_MAX_ITEMS_PER_KIND} 张图片，其余保留元信息`);
    let decodedImages = 0;
    for (const job of imageDecodeJobs) {
      throwIfAborted(signal);
      if (overBudget()) {
        markMediaPayloadMissing(job.msg, '图片解析超出本次预算，已保留图片元信息继续生成');
        continue;
      }
      try {
        const data = await readImageDataUrlIfUsable(job.localPath, imageKeys, { signal });
        if (data) {
          Object.assign(job.msg.media, data);
          decodedImages += 1;
        }
        else markMediaPayloadMissing(job.msg, '本地图片已定位，但未能解密成可发送给 AI 的图片');
      } catch (e) {
        if (e?.status === 499 || signal?.aborted) throw e;
        markMediaEnrichmentFailure(job.msg, e, '图片解密失败');
      }
      job.msg.content = formatImageContent(job.msg.media);
    }
    notifyMedia('fetch_media_images_done', `图片已附加 ${decodedImages}/${imageJobs.length}${skippedImageJobs.length ? `，跳过 ${skippedImageJobs.length}` : ''}`);
    const videoDecodeJobs = videoJobs.slice(0, MEDIA_DECODE_MAX_ITEMS_PER_KIND);
    const skippedVideoJobs = videoJobs.slice(videoDecodeJobs.length);
    markJobsOverBudget(skippedVideoJobs, `媒体数量较多，本次仅尝试解析前 ${MEDIA_DECODE_MAX_ITEMS_PER_KIND} 个视频，其余保留元信息`);
    let decodedVideos = 0;
    for (const job of videoDecodeJobs) {
      throwIfAborted(signal);
      if (overBudget()) {
        markMediaPayloadMissing(job.msg, '视频解析超出本次预算，已保留视频元信息继续生成');
        continue;
      }
      try {
        notifyMedia('fetch_media_copy', '正在准备视频临时读取数据用于抽帧');
        const copiedVideoPath = rememberCopiedMedia(await copyMediaFileForRead(account, job.localPath, { signal }));
        const frame = await readVideoFrameDataUrlIfUsable(copiedVideoPath, { signal });
        if (frame) {
          Object.assign(job.msg.media, { frame_data_url: frame.data_url, frame_mime: frame.mime });
          decodedVideos += 1;
        }
        else markMediaPayloadMissing(job.msg, '本地视频已定位，但未能抽取可发送给 AI 的关键帧');
      } catch (e) {
        if (e?.status === 499 || signal?.aborted) throw e;
        markMediaEnrichmentFailure(job.msg, e, '视频关键帧提取失败');
      }
      job.msg.content = job.msg.type === 'file' ? formatFileContent(job.msg.media) : formatVideoContent(job.msg.media);
    }
    notifyMedia('fetch_media_videos_done', `视频关键帧已附加 ${decodedVideos}/${videoJobs.length}${skippedVideoJobs.length ? `，跳过 ${skippedVideoJobs.length}` : ''}`);
    const audioDecodeJobs = audioJobs.slice(0, MEDIA_DECODE_MAX_ITEMS_PER_KIND);
    const skippedAudioJobs = audioJobs.slice(audioDecodeJobs.length);
    markJobsOverBudget(skippedAudioJobs, `媒体数量较多，本次仅尝试解析前 ${MEDIA_DECODE_MAX_ITEMS_PER_KIND} 条语音/音频，其余保留元信息`);
    let decodedAudios = 0;
    for (const job of audioDecodeJobs) {
      throwIfAborted(signal);
      if (overBudget()) {
        markMediaPayloadMissing(job.msg, '音频解析超出本次预算，已保留语音/音频元信息继续生成');
        continue;
      }
      try {
        notifyMedia('fetch_media_copy', '正在准备音频临时读取数据用于转码');
        const copiedAudioPath = rememberCopiedMedia(await copyMediaFileForRead(account, job.localPath, { signal }));
        const audio = await readAudioDataUrlIfUsable(copiedAudioPath, { signal });
        if (audio) {
          Object.assign(job.msg.media, audio);
          decodedAudios += 1;
        }
        else markMediaPayloadMissing(job.msg, '本地语音/音频已定位，但未能转换成可发送给 AI 的音频');
      } catch (e) {
        if (e?.status === 499 || signal?.aborted) throw e;
        markMediaEnrichmentFailure(job.msg, e, '音频读取/转码失败');
      }
      job.msg.content = job.msg.type === 'voice' ? formatVoiceContent(job.msg.media) : formatFileContent(job.msg.media);
    }
    notifyMedia('fetch_media_audio_done', `语音/音频已附加 ${decodedAudios}/${audioJobs.length}${skippedAudioJobs.length ? `，跳过 ${skippedAudioJobs.length}` : ''}`);
  } catch (e) {
    if (e?.status === 499 || signal?.aborted) throw e;
    for (const msg of mediaMessages) markMediaEnrichmentFailure(msg, e, '媒体解析流程失败');
  } finally {
    await closeCopiedDbHandle(hardlink);
    await removeCopiedMediaRoots([...copiedMediaRoots]);
  }
}

export async function validateCopiedDbWithRawKeys(dbPath, rawKeys, { signal = null, fallback_profiles = true, derive_passphrase_keys = true, allow_external_test_db = false } = {}) {
  throwIfAborted(signal);
  await assertCopiedDbRealPath(dbPath, { allow_external_test_db, signal });
  const Database = await loadSqlCipher();
  const dbSalt = (await readHeader(dbPath, { signal, allow_external_test_db })).toString('hex');
  throwIfAborted(signal);
  const orderedKeys = orderedRawKeyCandidates(rawKeys, dbSalt);
  const pageKey = await findWeixinV4PageKeyForCopiedDb(dbPath, orderedKeys, { signal, derive_passphrase_keys: derive_passphrase_keys === true, allow_external_test_db }).catch(e => {
    if (e?.status === 499 || signal?.aborted || !isExpectedSqlCipherKeyValidationError(e)) throw e;
    return null;
  });
  if (pageKey?.raw) {
    if (/^[a-f0-9]{32}$/.test(dbSalt)) prioritizeRawKeyCandidate(orderedKeys, `${pageKey.raw}${dbSalt}`);
    prioritizeRawKeyCandidate(orderedKeys, pageKey.raw);
  }
  let attempts = 0;
  const sqlCipherAttempts = sqlCipherValidationAttempts(orderedKeys, { fallback_profiles });
  const omissionStats = sqlCipherProfileFallbackOmissionStats(orderedKeys.length, { fallback_profiles });
  const validationStartedAt = Date.now();
  let validationTimedOut = false;
  for (const { raw, profile } of sqlCipherAttempts) {
    throwIfAborted(signal);
    if (Date.now() - validationStartedAt >= SQLCIPHER_VALIDATION_MAX_MS) {
      validationTimedOut = true;
      break;
    }
    attempts++;
    let db;
    try {
      db = await openReadonlyDatabase(Database, dbPath, { allow_external_test_db, signal });
      applySqlCipherKeyProfile(db, raw, profile);
      enforceQueryOnly(db);
      const row = db.prepare('select count(*) as c from sqlite_master').get();
      const tables = db.prepare("select name from sqlite_master where type = 'table' order by name limit 20").all();
      const prevalidatedKeyKind = pageKey?.raw && rawIncludesWeixinV4PageKey(raw, pageKey.raw) ? String(pageKey.key_kind || '') : '';
      return withVerifiedRawKey({
        ok: true,
        attempts,
        key_profile: profile.id,
        key_kind: prevalidatedKeyKind,
        profile_count: SQLCIPHER_KEY_PROFILES.length,
        key_hash: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12),
        table_count: Number(row?.c || 0),
        tables: tables.map(t => String(t.name || '')).filter(Boolean),
        page_hmac_prevalidated: pageKey?.raw ? rawIncludesWeixinV4PageKey(raw, pageKey.raw) : false,
        page_hmac_validation_attempts: pageKey?.attempts || 0,
      }, raw, { keyKind: prevalidatedKeyKind, sourceRaw: pageKey?.source_raw || '' });
    } catch (e) {
      if (isSqliteCorruptionError(e)) throw copiedDbCorruptionError(e, dbPath);
      if (!isExpectedSqlCipherKeyValidationError(e) && !isSqlCipherProfileProbeError(e, { fallback_profiles })) throw e;
      // Keep trying candidates; SQLCipher errors are intentionally not surfaced with key data.
    } finally {
      try { db?.close(); } catch {}
    }
    await maybeYieldKeyValidation(attempts, signal);
  }
  const manual = await validateCopiedDbWithWeixinV4PageKeys(dbPath, orderedKeys, { signal, derive_passphrase_keys: derive_passphrase_keys === true, allow_external_test_db });
  if (manual?.ok) {
    return withVerifiedRawKey({
      ok: true,
      attempts: attempts + manual.attempts,
      key_profile: manual.key_profile,
      key_kind: manual.key_kind || '',
      profile_count: SQLCIPHER_KEY_PROFILES.length + 1,
      key_hash: manual.key_hash,
      table_count: manual.table_count,
      tables: manual.tables,
      manual_page_validation_attempts: manual.attempts,
    }, manual.__verified_raw_key);
  }
  const validationBudgetExhausted = validationTimedOut || omissionStats.omitted_candidate_count > 0;
  return {
    ok: false,
    attempts,
    profile_count: SQLCIPHER_KEY_PROFILES.length,
    profile_fallback_bounded: true,
    profile_fallback_priority_limit: SQLCIPHER_PROFILE_FALLBACK_PRIORITY_MAX_KEYS,
    profile_fallback_priority_limits: sqlCipherProfileFallbackLimits(),
    profile_fallback_omitted_candidate_count: omissionStats.omitted_candidate_count,
    validation_time_budget_ms: SQLCIPHER_VALIDATION_MAX_MS,
    validation_timed_out: validationTimedOut,
    manual_page_validation_attempts: manual?.attempts || 0,
    error: validationBudgetExhausted
      ? 'validation_budget_exhausted'
      : 'no candidate key opened sample database',
  };
}

async function validateCopiedDbPageHmacOnly(dbPath, rawKeys, { signal = null } = {}) {
  throwIfAborted(signal);
  await assertCopiedDbRealPath(dbPath, { signal });
  const found = await findWeixinV4PageKeyForCopiedDb(dbPath, rawKeys, {
    signal,
    derive_passphrase_keys: false,
  }).catch(e => {
    if (e?.status === 499 || signal?.aborted || !isExpectedSqlCipherKeyValidationError(e)) throw e;
    return null;
  });
  throwIfAborted(signal);
  if (!found?.ok || !found.raw) {
    return {
      ok: false,
      attempts: Number(found?.attempts || 0) || 0,
      key_profile: `${WEIXIN_V4_MANUAL_PROFILE.id}:page_hmac_only`,
    };
  }
  return withVerifiedRawKey({
    ok: true,
    attempts: Number(found.attempts || 0) || 0,
    key_profile: `${WEIXIN_V4_MANUAL_PROFILE.id}:page_hmac_only`,
    key_hash: crypto.createHash('sha256').update(found.raw).digest('hex').slice(0, 12),
    table_count: 0,
    tables: [],
    page_hmac_verified_only: true,
  }, found.raw);
}

export async function cleanupCopiedDbs(keep = false) {
  if (keep) return;
  await assertSafeTmpPath(path.join(DB_COPY_ROOT, 'cleanup.marker'), { label: 'database temporary copy root', ensureParent: true })
    .then(() => fsp.rm(DB_COPY_ROOT, { recursive: true, force: true }))
    .catch(() => {});
}

function redactAccount(account) {
  return {
    id: account.account_id || account.id || account.wxid || '',
    account_id: account.account_id || account.id || account.wxid || '',
    storage_id: account.storage_id || account.account_id || '',
    identity_id: account.identity_id || '',
    identity_status: account.identity_status || '',
    identity_generation_status: account.identity_generation_status || '',
    identity_generation_changed_at: account.identity_generation_changed_at || '',
    identity_generation_verified_at: account.identity_generation_verified_at || '',
    identity_source_generation_hash: account.identity_source_generation_hash || '',
    source_generation_hash: account.source_generation_hash || account.mirror?.source_generation_hash || '',
    verified_self_wxid: account.verified_self_wxid || '',
    legacy_id: account.legacy_id || '',
    wxid: account.wxid,
    account_aliases: Array.isArray(account.account_aliases) ? account.account_aliases : [],
    display_name: account.display_name,
    last_write_time: account.last_write_time,
    summary: account.summary,
    source: account.source || '',
    mirror: account.mirror ? {
      relative_root: account.mirror.relative_root || '',
      imported_at: account.mirror.imported_at || '',
      refreshed_at: account.mirror.refreshed_at || '',
      refresh_reason: account.mirror.refresh_reason || '',
      refresh_reason_label: account.mirror.refresh_reason_label || '',
      refresh_action: account.mirror.refresh_action || '',
      source_snapshot_meta_hash: account.mirror.source_snapshot_meta_hash || '',
      identity_id: account.mirror.identity_id || account.identity_id || '',
      identity_status: account.mirror.identity_status || account.identity_status || '',
      identity_generation_status: account.mirror.identity_generation_status || account.identity_generation_status || '',
      identity_generation_changed_at: account.mirror.identity_generation_changed_at || account.identity_generation_changed_at || '',
      identity_generation_verified_at: account.mirror.identity_generation_verified_at || account.identity_generation_verified_at || '',
      identity_source_generation_hash: account.mirror.identity_source_generation_hash || account.identity_source_generation_hash || '',
      source_generation_hash: account.mirror.source_generation_hash || account.source_generation_hash || '',
      verified_self_wxid: account.mirror.verified_self_wxid || account.verified_self_wxid || '',
      source_last_write_time: account.mirror.source_last_write_time || '',
      mirror_last_write_time: account.mirror.mirror_last_write_time || '',
      source_available: account.source === 'project-mirror'
        ? account.mirror.source_available === true
        : true,
      source_status: account.source === 'project-mirror'
        ? String(account.mirror.source_status || (account.mirror.source_available === true ? 'available' : 'missing')).trim()
        : 'available',
      source_status_label: String(account.mirror.source_status_label || '').trim(),
    } : null,
  };
}

async function readHeader(file, { signal = null, allow_external_test_db = false } = {}) {
  await assertCopiedDbRealPath(file, { allow_external_test_db, signal });
  throwIfAborted(signal);
  const handle = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(16);
    await handle.read(buf, 0, buf.length, 0);
    return buf;
  } finally {
    await handle.close();
  }
}

async function sha256Prefix(file, { signal = null } = {}) {
  throwIfAborted(signal);
  await assertCopiedDbRealPath(file, { signal });
  throwIfAborted(signal);
  const handle = await fsp.open(file, 'r');
  const hash = crypto.createHash('sha256');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let read = 0;
    while (read < 4 * 1024 * 1024) {
      throwIfAborted(signal);
      const res = await handle.read(buf, 0, Math.min(buf.length, 4 * 1024 * 1024 - read), read);
      if (!res.bytesRead) break;
      hash.update(buf.subarray(0, res.bytesRead));
      read += res.bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex').slice(0, 16);
}

async function sha256CopiedFile(file, { signal = null } = {}) {
  throwIfAborted(signal);
  await assertCopiedDbRealPath(file, { signal });
  throwIfAborted(signal);
  return sha256FileContents(file, { signal });
}

async function loadSqlCipher() {
  if (SqlCipherDatabase) return SqlCipherDatabase;
  const mod = await import('@signalapp/sqlcipher');
  if (!sqlcipherLoggerSet && typeof mod.setLogger === 'function') {
    mod.setLogger(() => {});
    sqlcipherLoggerSet = true;
  }
  SqlCipherDatabase = mod.default || mod.Database;
  if (!SqlCipherDatabase) throw new Error('SQLCipher module is unavailable');
  return SqlCipherDatabase;
}

async function openReadonlyDatabase(Database, dbPath, { allow_external_test_db = false, signal = null } = {}) {
  await assertCopiedDbRealPath(dbPath, { allow_external_test_db, signal });
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function enforceQueryOnly(db) {
  try { db?.pragma?.('query_only = ON'); } catch {}
}

function isExpectedSqlCipherKeyValidationError(error = null) {
  if (!error || typeof error !== 'object') return false;
  if (error.status === 499 || error.name === 'AbortError') return false;
  const code = String(error.public_code || error.code || error.errno || '').trim();
  if (/^(?:SQLITE_NOTADB|SQLITE_AUTH)$/i.test(code)) return true;
  if (/^(?:ENOENT|EACCES|EPERM|EBUSY|ENOTDIR|EISDIR|SQLITE_CANTOPEN|SQLITE_IOERR|SQLITE_FULL|SQLITE_CORRUPT|SQLITE_FORMAT)$/i.test(code)) return false;
  if (isSqlCipherResourceError(error)) return false;
  if (isSqliteCorruptionError(error)) return false;
  if (/^(?:db_copy_required|wxdb_|db_copy_|path_|output_|history_)/i.test(code)) return false;
  const message = String(error.message || error.toString?.() || '').toLowerCase();
  if (!message) return false;
  if (/no such file|permission denied|access is denied|unable to open database file|database temporary copy|project mirror|路径越界|临时副本|项目副本/.test(message)) return false;
  return /file is encrypted|file is not a database|not a database|sqlite_notadb|notadb|mac mismatch|hmac mismatch|wrong key|invalid key|unsupported file format|bad decrypt|bad password|key validation failure/.test(message);
}

function isSqliteCorruptionError(error = null) {
  if (!error || typeof error !== 'object') return false;
  const code = String(error.public_code || error.code || error.errno || '').trim();
  if (/^(?:SQLITE_CORRUPT|SQLITE_FORMAT)$/i.test(code)) return true;
  const message = String(error.message || error.toString?.() || '').toLowerCase();
  return /database disk image is malformed|malformed database schema|database corruption|sqlite_corrupt/.test(message);
}

function copiedDbCorruptionError(error = null, dbPath = '') {
  const cause = String(error?.code || error?.errno || '').trim().toLowerCase() || 'sqlite_corrupt';
  return dbTempCopyError('wxdb_temp_copy_database_invalid', '微信数据库临时读取数据结构损坏或不完整，已停止密钥验证，避免把副本问题误判为密钥错误。请稍后重试自动准备本地工作数据。', {
    source: dbPath,
    category: path.basename(path.dirname(dbPath || '')),
    cause,
  });
}

function isSqlCipherResourceError(error = null) {
  if (!error || typeof error !== 'object') return false;
  const code = String(error.public_code || error.code || error.errno || '').trim();
  if (/^(?:SQLITE_NOMEM|SQLITE_TOOBIG|SQLITE_NOLFS)$/i.test(code)) return true;
  const message = String(error.message || error.toString?.() || '').toLowerCase();
  return /sqlite_nomem|out of memory|not enough memory|memory allocation|malloc|resource exhausted/.test(message);
}

function isSqlCipherProfileProbeError(error = null, { fallback_profiles = false } = {}) {
  return fallback_profiles === true && isSqlCipherResourceError(error);
}

async function openCopiedSqlCipherDb(account, source, rawKeys, { signal = null, onProgress = null, allow_key_scan = true, allow_stale_account = false } = {}) {
  throwIfAborted(signal);
  const copied = await copyDbFile(account, source, { signal, allow_stale_account, onProgress });
  await assertCopiedDbRealPath(copied.target_path, { signal });
  let handedOff = false;
  const sourceName = path.basename(source || copied.target_path || 'database');
  let keyScanDiagnostics = {
    source_name: sourceName,
    initial_candidate_count: uniqueStrings(Array.isArray(rawKeys) ? rawKeys : []).length,
    quick_candidate_matched: false,
    page_hmac_candidate_matched: false,
    targeted_scan_attempted: false,
  };
  try {
    const Database = await loadSqlCipher();
    const initialCandidates = uniqueStrings(Array.isArray(rawKeys) ? rawKeys : []);
    const preferPageHmac = initialCandidates.length > 0;
    if (preferPageHmac) {
      notifyProgress(onProgress, {
        phase: 'fetch_shard_page_hmac',
        label: '拉取消息 · 验证数据库密钥',
        detail: `${sourceName}：先用第一页完整性校验快速验证 ${initialCandidates.length} 条已有候选`,
      });
      const pageHmac = await openWeixinV4DecryptedDb(copied.target_path, initialCandidates, Database, {
        signal,
        onProgress,
        sourceName,
        copied,
        maxPassphraseDeriveCandidates: WEIXIN_V4_PASSPHRASE_DERIVE_CANDIDATE_LIMIT,
      });
      if (pageHmac?.db) {
        keyScanDiagnostics.page_hmac_candidate_matched = true;
        handedOff = true;
        return {
          db: pageHmac.db,
          raw_key: persistableRawKey(pageHmac.raw_key),
          key_hash: pageHmac.key_hash,
          key_profile: pageHmac.key_profile,
          copied,
          close() {
            return closeCopiedDb(copied.target_path, pageHmac.db, pageHmac.plain_path, { keepPlain: pageHmac.plain_cached, plainLease: pageHmac.plain_lease });
          },
        };
      }
    }
    notifyProgress(onProgress, {
      phase: 'fetch_shard_sqlcipher_compat',
      label: '拉取消息 · 检查旧式数据库兼容',
      detail: `${sourceName}：第一页完整性校验未命中，限量检查高优先级候选的旧式 SQLCipher 格式`,
    });
    const found = await findRawKeyForCopiedDb(copied.target_path, initialCandidates, { signal });
    keyScanDiagnostics = {
      ...keyScanDiagnostics,
      sqlcipher_compat_attempts: Number(found?.attempts || 0) || 0,
      sqlcipher_compat_budget_exhausted: found?.validation_budget_exhausted === true,
      sqlcipher_compat_omitted_attempt_count: Number(found?.omitted_attempt_count || 0) || 0,
    };
    throwIfAborted(signal);
    if (found?.raw) {
      keyScanDiagnostics.quick_candidate_matched = true;
      throwIfAborted(signal);
      const db = await openReadonlyDatabase(Database, copied.target_path, { signal });
      try {
        applySqlCipherKeyProfile(db, found.raw, found.profile);
        enforceQueryOnly(db);
        db.prepare('select count(*) as c from sqlite_master').get();
        throwIfAborted(signal);
      } catch (e) {
        try { db.close(); } catch {}
        if (isSqliteCorruptionError(e)) throw copiedDbCorruptionError(e, copied.target_path);
        throw e;
      }
      handedOff = true;
      return {
        db,
        raw_key: persistableRawKey(found.raw),
        key_hash: crypto.createHash('sha256').update(found.raw).digest('hex').slice(0, 12),
        key_profile: found.profile.id,
        copied,
        close() {
          try { db.close(); } catch {}
          return removeCopiedDb(copied.target_path);
        },
      };
    }
    if (!allow_key_scan) {
      const err = new Error(`no raw key matched ${path.basename(source)}`);
      err.key_scan_diagnostics = keyScanDiagnostics;
      throw err;
    }
    notifyProgress(onProgress, {
      phase: 'fetch_shard_key_scan',
      label: '拉取消息 · 扩展密钥验证',
      detail: `${sourceName}：已有密钥未打开该分片，正在只读寻找可用于当前消息库的密钥`,
    });
    const verified = await scanVerifiedWeixinV4KeysForCopiedDb(copied.target_path, { signal, onProgress, source_name: sourceName });
    throwIfAborted(signal);
    keyScanDiagnostics = {
      ...keyScanDiagnostics,
      targeted_scan_attempted: true,
      targeted_raw_key_count: Number(verified.raw_keys?.length || 0) || 0,
      scan_unavailable: verified.scan_unavailable === true,
      scan_unavailable_reason: verified.scan_unavailable_reason || '',
      scan_unavailable_error: verified.scan_unavailable_error || '',
      scan_process_count: Number(verified.scan_process_count || 0) || 0,
      scan_process_attempt_count: Number(verified.scan_process_attempt_count || 0) || 0,
      matched_salt_count: Number(verified.matched_salt_count || 0) || 0,
      hex_pattern_count: Number(verified.hex_pattern_count || 0) || 0,
      passphrase_derive_attempts: Number(verified.passphrase_derive_attempts || 0) || 0,
      passphrase_derived_match_count: Number(verified.passphrase_derived_match_count || 0) || 0,
      scanned_bytes: Number(verified.scanned_bytes || 0) || 0,
      codec_context_attempted: verified.codec_context_attempted === true,
      codec_context_scan_process_count: Number(verified.codec_context_scan_process_count || 0) || 0,
      codec_context_salt_match_count: Number(verified.codec_context_salt_match_count || 0) || 0,
      codec_context_unique_candidate_count: Number(verified.codec_context_unique_candidate_count || 0) || 0,
      codec_context_pass_candidate_count: Number(verified.codec_context_pass_candidate_count || 0) || 0,
      codec_context_key_pointer_candidate_count: Number(verified.codec_context_key_pointer_candidate_count || 0) || 0,
      codec_context_page_key_match_count: Number(verified.codec_context_page_key_match_count || 0) || 0,
      codec_context_scanned_bytes: Number(verified.codec_context_scanned_bytes || 0) || 0,
    };
    notifyProgress(onProgress, {
      phase: verified.raw_keys.length ? 'fetch_shard_key_scan_done' : 'fetch_shard_key_scan_empty',
      label: verified.raw_keys.length ? '拉取消息 · 候选密钥通过初检' : '拉取消息 · 未验证到可用密钥',
      detail: verified.raw_keys.length
        ? `${sourceName}：找到 ${verified.raw_keys.length} 条候选密钥，已检查 ${Number(verified.scan_process_count || 0) || 0} 个微信进程；继续打开消息库验证`
        : `${sourceName}：本轮未找到新的可用候选，已检查 ${Number(verified.scan_process_count || 0) || 0} 个微信进程；改用已保存或手动候选继续验证`,
    });
    if (verified.raw_keys.length) {
      notifyProgress(onProgress, {
        phase: 'fetch_shard_decrypting',
        label: '拉取消息 · 打开并验证消息库',
        detail: `${sourceName}：正在用候选密钥打开消息库`,
      });
      const manual = await openWeixinV4DecryptedDb(copied.target_path, [...verified.raw_keys, ...rawKeys], Database, { signal, onProgress, sourceName, copied });
      if (manual?.db) {
        handedOff = true;
        return {
          db: manual.db,
          raw_key: persistableRawKey(manual.raw_key),
          key_hash: manual.key_hash,
          key_profile: `${manual.key_profile}:verified_memory_hmac`,
          copied,
          close() {
            return closeCopiedDb(copied.target_path, manual.db, manual.plain_path, { keepPlain: manual.plain_cached, plainLease: manual.plain_lease });
          },
        };
      }
    }
    notifyProgress(onProgress, {
      phase: 'fetch_shard_decrypting',
      label: '拉取消息 · 验证并打开消息库',
      detail: `${sourceName}：继续用已保存密钥打开消息库`,
    });
    const manual = await openWeixinV4DecryptedDb(copied.target_path, rawKeys, Database, { signal, onProgress, sourceName, copied });
    if (manual?.db) {
      handedOff = true;
      return {
        db: manual.db,
        raw_key: persistableRawKey(manual.raw_key),
        key_hash: manual.key_hash,
          key_profile: manual.key_profile,
          copied,
          close() {
            return closeCopiedDb(copied.target_path, manual.db, manual.plain_path, { keepPlain: manual.plain_cached, plainLease: manual.plain_lease });
          },
        };
      }
    const err = new Error(`no raw key matched ${path.basename(source)}`);
    err.key_scan_diagnostics = keyScanDiagnostics;
    throw err;
  } catch (e) {
    if (e && typeof e === 'object' && keyScanDiagnostics && !e.key_scan_diagnostics) {
      e.key_scan_diagnostics = keyScanDiagnostics;
    }
    if (!handedOff) await removeCopiedDb(copied.target_path).catch(() => {});
    throw e;
  }
}

async function openMessageSqlCipherDb(account, source, rawKeys, { signal = null, onProgress = null, allow_key_scan = true, allow_stale_account = false } = {}) {
  throwIfAborted(signal);
  return openCopiedSqlCipherDb(account, source, rawKeys, { signal, onProgress, allow_key_scan, allow_stale_account });
}

function normalizeWeixinV4KeyScanMaxMs(value = 0) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return WEIXIN_V4_STANDARD_SCAN_MAX_MS;
  return Math.max(1_000, Math.min(Math.floor(parsed), WEIXIN_V4_STANDARD_SCAN_MAX_MS_HARD_LIMIT));
}

function weixinProcessProgressRole(process) {
  if (shouldPrioritizeWeixinProcessScan(process)) return '（已确认主进程）';
  if (process?.is_main === false && process?.main_process_confidence === 'command_line') return '（辅助进程）';
  return '';
}

function weixinProcessDiagnosticType(process) {
  if (shouldPrioritizeWeixinProcessScan(process)) return 'main';
  if (process?.is_main === false && process?.main_process_confidence === 'command_line') return 'helper';
  return 'unknown';
}

async function scanVerifiedWeixinV4KeysForCopiedDb(dbPath, {
  signal = null,
  db_pages = [],
  scan_all_processes = true,
  include_mapped = true,
  writable_only = false,
  max_bytes = 1024 * 1024 * 1024,
  max_region_bytes = 128 * 1024 * 1024,
  include_bare_hex = true,
  derive_passphrase_keys = false,
  max_passphrase_derive_candidates = WEIXIN_V4_PASSPHRASE_DERIVE_CANDIDATE_LIMIT,
  codec_context_scan = true,
  codec_scan_max_bytes = 512 * 1024 * 1024,
  codec_scan_max_region_bytes = 64 * 1024 * 1024,
  codec_scan_max_candidates = 1024,
  max_ms = WEIXIN_V4_STANDARD_SCAN_MAX_MS,
  onProgress = null,
  source_name = '',
} = {}) {
  throwIfAborted(signal);
  await assertCopiedDbRealPath(dbPath, { signal });
  let page;
  try {
    page = await readFirstPage(dbPath, { signal });
  } catch (e) {
    if (e?.status === 499 || e?.name === 'AbortError' || signal?.aborted) throw e;
    throw dbTempCopyError('wxdb_temp_copy_first_page_unreadable', '微信数据库临时读取数据不可读：无法读取数据库第一页，已停止密钥扫描以避免把读取失败误判为没有可用密钥。请稍后重试。', {
      source: dbPath,
      category: path.basename(path.dirname(dbPath)),
      cause: transientDbCopyErrorCause(e) || 'first_page_read_failed',
    });
  }
  throwIfAborted(signal);
  if (!page || page.length < WEIXIN_V4_PAGE_SIZE) {
    throw dbTempCopyError('wxdb_temp_copy_first_page_incomplete', '微信数据库临时读取数据不完整：数据库第一页不足，已停止密钥扫描以避免把损坏副本误判为没有可用密钥。请重新检查本地数据后重试。', {
      source: dbPath,
      category: path.basename(path.dirname(dbPath)),
      cause: 'first_page_too_small',
    });
  }
  const scanPages = normalizeWeixinV4ScanPages([page, ...db_pages]);
  if (!scanPages.length) {
    throw dbTempCopyError('wxdb_temp_copy_first_page_incomplete', '微信数据库临时读取数据不完整：没有可用于密钥验证的数据库第一页。请重新检查本地数据后重试。', {
      source: dbPath,
      category: path.basename(path.dirname(dbPath)),
      cause: 'no_valid_first_pages',
    });
  }
  let processEnumerationError = '';
  const processes = await getWeixinProcesses({ signal }).catch(e => {
    if (e?.status === 499 || e?.name === 'AbortError' || signal?.aborted) throw e;
    processEnumerationError = sanitizeWxdbDiagnosticError(e?.message || e || '未知错误');
    return [];
  });
  if (processes?.process_enumeration_failed === true) {
    processEnumerationError = String(processes.process_enumeration_error || '无法枚举微信进程').trim();
  }
  throwIfAborted(signal);
  if (processEnumerationError) {
    notifyProgress(onProgress, {
      phase: 'fetch_shard_key_scan_unavailable',
      label: '拉取消息 · 扩展密钥验证不可用',
      detail: `${source_name || path.basename(dbPath)}：无法枚举微信进程，本次不能把自动扫描结果当成 0 个候选：${processEnumerationError.slice(0, 100)}`,
    });
  }
  const ordered = orderWeixinProcessesForKeyScan(processes);
  const targets = scan_all_processes ? ordered : ordered.slice(0, 1);
  const raw = [];
  const summaries = [];
  const codecSummaries = [];
  const verifiedScanSalts = new Set();
  const requestedScanSalts = new Set(scanPages.map(item => item.salt));
  const sourceLabel = source_name || path.basename(dbPath);
  const scanMaxMs = normalizeWeixinV4KeyScanMaxMs(max_ms);
  const scanStartedAt = Date.now();
  const scanDeadline = scanStartedAt + scanMaxMs;
  const regularScanDeadline = codec_context_scan
    ? scanStartedAt + Math.max(1_000, Math.floor(scanMaxMs * 2 / 3))
    : scanDeadline;
  const processScanSliceMs = (deadline, index) => {
    const remainingMs = deadline - Date.now();
    return allocateSharedProcessScanMs(remainingMs, targets.length - index, {
      priority: index === 0 && shouldPrioritizeWeixinProcessScan(targets[index]),
    });
  };
  let scanTimedOut = false;
  for (const [index, process] of targets.entries()) {
    throwIfAborted(signal);
    const processMaxMs = processScanSliceMs(regularScanDeadline, index);
    if (!processMaxMs) {
      scanTimedOut = true;
      break;
    }
    notifyProgress(onProgress, {
      phase: 'fetch_shard_key_scan_process',
      label: '拉取消息 · 扩展密钥验证',
      detail: `${sourceLabel}：检查微信进程 ${index + 1}/${targets.length}${weixinProcessProgressRole(process)}`,
    });
    const result = await scanProcessForVerifiedWeixinV4DbKeys(process.pid, {
      db_pages: scanPages,
      include_raw: true,
      include_bare_hex,
      derive_passphrase_keys,
      max_passphrase_derive_candidates,
      include_mapped,
      writable_only,
      max_bytes,
      max_region_bytes,
      max_ms: processMaxMs,
      on_progress: progress => {
        const scanned = Math.max(0, Number(progress?.scanned_bytes || 0) || 0);
        const limit = Math.max(0, Number(progress?.scan_limit_bytes || 0) || 0);
        const scannedLabel = formatBytes(scanned) || `${scanned}B`;
        const limitLabel = limit ? (formatBytes(limit) || `${limit}B`) : '';
        notifyProgress(onProgress, {
          phase: 'fetch_shard_key_scan_progress',
          label: '拉取消息 · 扩展密钥验证',
          detail: `${sourceLabel}：已检查 ${scannedLabel}${limitLabel ? `/${limitLabel}` : ''}，正在确认本机消息可读取`,
        });
      },
      signal,
    }).catch(e => {
      if (e?.status === 499 || signal?.aborted) throw e;
      return { error: e?.message || String(e), raw_candidates: [] };
    });
    throwIfAborted(signal);
    notifyProgress(onProgress, {
      phase: 'fetch_shard_key_scan_process_done',
      label: '拉取消息 · 扩展密钥验证',
      detail: [
        `${sourceLabel}：进程 ${index + 1}/${targets.length} 已检查`,
        `候选 ${Number(result.unique_candidate_count || 0) || 0}`,
        scanPages.length > 1
          ? `本进程验证 ${Math.min(Number(result.matched_salt_count || 0) || 0, scanPages.length)}/${scanPages.length} 个消息库分片`
          : (Number(result.matched_salt_count || 0) ? '数据库完整性校验已命中' : ''),
        result.timed_out === true ? `达到本进程 ${Math.max(1, Math.ceil(Number(result.scan_mode?.max_ms || processMaxMs) / 1000))} 秒分配上限，已保留已读候选，继续检查其余微信进程` : '',
        result.error ? `失败：${String(result.error).slice(0, 80)}` : '',
      ].filter(Boolean).join(' · '),
    });
    summaries.push({
      pid: process.pid,
      type: weixinProcessDiagnosticType(process),
      unique_candidate_count: Number(result.unique_candidate_count || 0),
      matched_salt_count: Number(result.matched_salt_count || 0),
      hex_pattern_count: Number(result.hex_pattern_count || 0),
      v4_pointer_pattern_hit_count: Number(result.v4_pointer_pattern_hit_count || 0),
      v4_pointer_pattern_candidate_count: Number(result.v4_pointer_pattern_candidate_count || 0),
      v4_pointer_verified_candidate_count: Number(result.v4_pointer_verified_candidate_count || 0),
      pointer_passphrase_derive_attempts: Number(result.pointer_passphrase_derive_attempts || 0),
      pointer_passphrase_derived_match_count: Number(result.pointer_passphrase_derived_match_count || 0),
      passphrase_derive_attempts: Number(result.passphrase_derive_attempts || 0),
      passphrase_derived_match_count: Number(result.passphrase_derived_match_count || 0),
      scanned_bytes: Number(result.scanned_bytes || 0),
      timed_out: result.timed_out === true,
      error: result.error ? String(result.error) : '',
    });
    for (const item of result.raw_candidates || []) raw.push(item);
    for (const salt of result.matched_salts || []) {
      const normalized = String(salt || '').trim().toLowerCase();
      if (requestedScanSalts.has(normalized)) verifiedScanSalts.add(normalized);
    }
    if (result.timed_out === true) scanTimedOut = true;
    if (weixinV4ScanPageCoverage(scanPages, raw, verifiedScanSalts).matched_salt_count >= scanPages.length) break;
  }
  if (weixinV4ScanPageCoverage(scanPages, raw, verifiedScanSalts).matched_salt_count < scanPages.length
    && codec_context_scan
    && scanDeadline - Date.now() >= 1_000) {
    notifyProgress(onProgress, {
      phase: 'fetch_shard_codec_key_scan',
      label: '拉取消息 · 兼容新版消息库',
      detail: `${sourceLabel}：常规密钥未命中，继续尝试新版微信数据库的兼容验证`,
    });
    for (const [index, process] of targets.entries()) {
      throwIfAborted(signal);
      const processMaxMs = processScanSliceMs(scanDeadline, index);
      if (!processMaxMs) {
        scanTimedOut = true;
        break;
      }
      notifyProgress(onProgress, {
        phase: 'fetch_shard_codec_key_scan_process',
        label: '拉取消息 · 兼容新版消息库',
        detail: `${sourceLabel}：检查兼容密钥结构 ${index + 1}/${targets.length}${weixinProcessProgressRole(process)}`,
      });
      const result = await scanProcessForCodecContextKeyCandidates(process.pid, {
        db_salts: scanPages.map(item => item.salt),
        include_raw: true,
        include_mapped,
        writable_only: false,
        max_bytes: codec_scan_max_bytes,
        max_region_bytes: codec_scan_max_region_bytes,
        max_candidates: codec_scan_max_candidates,
        max_ms: processMaxMs,
        on_progress: progress => {
          const scanned = Math.max(0, Number(progress?.scanned_bytes || 0) || 0);
          const limit = Math.max(0, Number(progress?.scan_limit_bytes || 0) || 0);
          const scannedLabel = formatBytes(scanned) || `${scanned}B`;
          const limitLabel = limit ? (formatBytes(limit) || `${limit}B`) : '';
          notifyProgress(onProgress, {
            phase: 'fetch_shard_codec_key_scan_progress',
            label: '拉取消息 · 兼容新版消息库',
            detail: `${sourceLabel}：已检查 ${scannedLabel}${limitLabel ? `/${limitLabel}` : ''}，正在确认兼容访问方式`,
          });
        },
        signal,
      }).catch(e => {
        if (e?.status === 499 || signal?.aborted) throw e;
        return { error: e?.message || String(e), raw_candidates: [] };
      });
      throwIfAborted(signal);
      const codecRaw = uniqueStrings(result.raw_candidates || []);
      let pageMatchCount = 0;
      if (codecRaw.length) {
        const alreadyMatched = new Set(weixinV4ScanPageCoverage(scanPages, raw, verifiedScanSalts).matched_salts);
        for (const item of scanPages) {
          if (alreadyMatched.has(item.salt)) continue;
          const found = await findWeixinV4PageKeyForPage(item.page, codecRaw, {
            signal,
            derive_passphrase_keys,
            max_passphrase_derive_candidates: Math.min(WEIXIN_V4_PASSPHRASE_DERIVE_CANDIDATE_LIMIT, codecRaw.length),
          }).catch(e => {
            if (e?.status === 499 || signal?.aborted) throw e;
            return null;
          });
          throwIfAborted(signal);
          if (!found?.ok || !found.raw) continue;
          pageMatchCount += 1;
          verifiedScanSalts.add(item.salt);
          raw.push(...portableWeixinV4VerifiedCandidates(found, item.salt));
        }
      }
      codecSummaries.push({
        pid: process.pid,
        type: weixinProcessDiagnosticType(process),
        codec_context_hit_count: Number(result.codec_context_hit_count || 0),
        codec_context_salt_match_count: Number(result.codec_context_salt_match_count || 0),
        unique_candidate_count: Number(result.unique_candidate_count || 0),
        codec_pass_candidate_count: Number(result.codec_pass_candidate_count || 0),
        codec_key_pointer_candidate_count: Number(result.codec_key_pointer_candidate_count || 0),
        page_key_match_count: pageMatchCount,
        scanned_bytes: Number(result.scanned_bytes || 0),
        region_count: Number(result.region_count || 0),
        timed_out: result.timed_out === true,
        error: result.error ? String(result.error) : '',
      });
      notifyProgress(onProgress, {
        phase: 'fetch_shard_codec_key_scan_process_done',
        label: '拉取消息 · 兼容新版消息库',
        detail: [
          `${sourceLabel}：兼容检查 ${index + 1}/${targets.length} 已完成`,
          `候选 ${Number(result.unique_candidate_count || 0) || 0}`,
          pageMatchCount ? '完整性校验已命中' : '',
          result.timed_out === true ? `达到本进程 ${Math.max(1, Math.ceil(Number(result.scan_mode?.max_ms || processMaxMs) / 1000))} 秒分配上限，已保留已读候选，继续检查其余微信进程` : '',
          result.error ? `失败：${String(result.error).slice(0, 80)}` : '',
        ].filter(Boolean).join(' · '),
      });
      if (result.timed_out === true) scanTimedOut = true;
      if (weixinV4ScanPageCoverage(scanPages, raw, verifiedScanSalts).matched_salt_count >= scanPages.length) break;
    }
  }
  const availability = verifiedWeixinV4KeyScanAvailability({
    targets,
    processEnumerationError,
    summaries,
    codecSummaries,
  });
  if (availability.scan_unavailable && !processEnumerationError) {
    notifyProgress(onProgress, {
      phase: 'fetch_shard_key_scan_unavailable',
      label: '拉取消息 · 扩展密钥验证不可用',
      detail: `${sourceLabel}：${availability.scan_unavailable_error || '没有可读取的微信进程内存'}；本次不能把自动扫描结果当成 0 个候选`,
    });
  }
  const uniqueRaw = uniqueStrings(raw);
  const pageCoverage = weixinV4ScanPageCoverage(scanPages, uniqueRaw, verifiedScanSalts);
  if (scanTimedOut) {
    notifyProgress(onProgress, {
      phase: 'fetch_shard_key_scan_timeout',
      label: '拉取消息 · 扩展密钥验证未完成',
      detail: `${sourceLabel}：所有微信进程共用 ${Math.max(1, Math.ceil(scanMaxMs / 1000))} 秒扫描预算，${targets.some(shouldPrioritizeWeixinProcessScan) ? '已优先检查明确识别的主进程，并为其余进程保留时间' : '未明确识别主进程，已按工作集大小排序并公平分配时间'}，已验证 ${pageCoverage.matched_salt_count}/${pageCoverage.requested_salt_count} 个消息库分片，共保留 ${uniqueRaw.length} 条候选；未命中不能视为没有可用密钥`,
    });
  }
  return {
    raw_keys: uniqueRaw,
    process_enumeration_failed: !!processEnumerationError,
    process_enumeration_error: processEnumerationError,
    scan_unavailable: availability.scan_unavailable,
    scan_unavailable_reason: availability.scan_unavailable_reason,
    scan_unavailable_error: availability.scan_unavailable_error,
    scan_process_count: availability.readable_process_count,
    scan_process_attempt_count: summaries.length,
    timed_out: scanTimedOut,
    scan_incomplete: scanTimedOut,
    scan_timeout_ms: scanMaxMs,
    scan_timeout_scope: 'shared_all_processes',
    scan_processes: summaries,
    requested_salt_count: pageCoverage.requested_salt_count,
    matched_salt_count: pageCoverage.matched_salt_count,
    unique_candidate_count: uniqueRaw.length,
    hex_pattern_count: summaries.reduce((sum, item) => sum + Number(item.hex_pattern_count || 0), 0),
    v4_pointer_pattern_hit_count: summaries.reduce((sum, item) => sum + Number(item.v4_pointer_pattern_hit_count || 0), 0),
    v4_pointer_pattern_candidate_count: summaries.reduce((sum, item) => sum + Number(item.v4_pointer_pattern_candidate_count || 0), 0),
    v4_pointer_verified_candidate_count: summaries.reduce((sum, item) => sum + Number(item.v4_pointer_verified_candidate_count || 0), 0),
    pointer_passphrase_derive_attempts: summaries.reduce((sum, item) => sum + Number(item.pointer_passphrase_derive_attempts || 0), 0),
    pointer_passphrase_derived_match_count: summaries.reduce((sum, item) => sum + Number(item.pointer_passphrase_derived_match_count || 0), 0),
    passphrase_derive_attempts: summaries.reduce((sum, item) => sum + Number(item.passphrase_derive_attempts || 0), 0),
    passphrase_derived_match_count: summaries.reduce((sum, item) => sum + Number(item.passphrase_derived_match_count || 0), 0),
    scanned_bytes: summaries.reduce((sum, item) => sum + Number(item.scanned_bytes || 0), 0),
    codec_context_attempted: codecSummaries.length > 0,
    codec_context_scan_process_count: codecSummaries.length,
    codec_context_salt_match_count: codecSummaries.reduce((sum, item) => sum + Number(item.codec_context_salt_match_count || 0), 0),
    codec_context_unique_candidate_count: codecSummaries.reduce((sum, item) => sum + Number(item.unique_candidate_count || 0), 0),
    codec_context_pass_candidate_count: codecSummaries.reduce((sum, item) => sum + Number(item.codec_pass_candidate_count || 0), 0),
    codec_context_key_pointer_candidate_count: codecSummaries.reduce((sum, item) => sum + Number(item.codec_key_pointer_candidate_count || 0), 0),
    codec_context_page_key_match_count: codecSummaries.reduce((sum, item) => sum + Number(item.page_key_match_count || 0), 0),
    codec_context_scanned_bytes: codecSummaries.reduce((sum, item) => sum + Number(item.scanned_bytes || 0), 0),
    codec_context_region_count: codecSummaries.reduce((sum, item) => sum + Number(item.region_count || 0), 0),
    codec_context_scan_processes: codecSummaries,
  };
}

function verifiedWeixinV4KeyScanAvailability({ targets = [], processEnumerationError = '', summaries = [], codecSummaries = [] } = {}) {
  const attempted = [...(Array.isArray(summaries) ? summaries : []), ...(Array.isArray(codecSummaries) ? codecSummaries : [])];
  const readablePids = new Set(attempted
    .filter(item => Number(item?.scanned_bytes || 0) > 0 && !item?.error)
    .map(item => Number(item?.pid || 0))
    .filter(pid => Number.isInteger(pid) && pid > 0));
  const noProcesses = !Array.isArray(targets) || targets.length === 0;
  const processMemoryUnreadable = !noProcesses && attempted.length > 0 && readablePids.size === 0;
  const scanUnavailable = noProcesses || processMemoryUnreadable;
  const reason = processEnumerationError
    ? 'process_enumeration_failed'
    : (noProcesses ? 'process_not_running' : (processMemoryUnreadable ? 'process_memory_unreadable' : ''));
  const firstError = attempted.find(item => item?.error)?.error || '';
  const unavailableError = processEnumerationError
    || firstError
    || (noProcesses ? '未检测到可扫描的微信进程' : (processMemoryUnreadable ? '微信进程存在，但没有成功读取到进程内存' : ''));
  return {
    scan_unavailable: scanUnavailable,
    scan_unavailable_reason: reason,
    scan_unavailable_error: sanitizeWxdbDiagnosticError(unavailableError),
    readable_process_count: readablePids.size,
  };
}

async function findRawKeyForCopiedDb(dbPath, rawKeys, { signal = null, readonly = false } = {}) {
  throwIfAborted(signal);
  await assertCopiedDbRealPath(dbPath, { signal });
  const salt = (await readHeader(dbPath, { signal })).toString('hex');
  throwIfAborted(signal);
  const orderedKeys = orderedRawKeyCandidates(rawKeys, salt);
  const Database = await loadSqlCipher();
  const validationPlan = sqlCipherValidationAttempts(orderedKeys);
  const omissionStats = sqlCipherProfileFallbackOmissionStats(orderedKeys.length);
  const validationStartedAt = Date.now();
  let attempts = 0;
  let validationTimedOut = false;
  for (const { raw, profile } of validationPlan) {
    throwIfAborted(signal);
    if (Date.now() - validationStartedAt >= SQLCIPHER_VALIDATION_MAX_MS) {
      validationTimedOut = true;
      break;
    }
    attempts++;
    let db;
    try {
      db = await openReadonlyDatabase(Database, dbPath, { signal });
      applySqlCipherKeyProfile(db, raw, profile);
      enforceQueryOnly(db);
      db.prepare('select count(*) as c from sqlite_master').get();
      return {
        raw,
        profile,
        attempts,
        validation_budget_exhausted: false,
        omitted_attempt_count: omissionStats.omitted_candidate_count,
      };
    } catch (e) {
      if (isSqliteCorruptionError(e)) throw copiedDbCorruptionError(e, dbPath);
      if (!isExpectedSqlCipherKeyValidationError(e) && !isSqlCipherProfileProbeError(e, { fallback_profiles: true })) throw e;
      // Keep trying candidates; invalid key errors are expected for broad memory scans.
    } finally {
      try { db?.close(); } catch {}
    }
    await maybeYieldKeyValidation(attempts, signal);
  }
  return {
    raw: '',
    attempts,
    validation_budget_exhausted: validationTimedOut || omissionStats.omitted_candidate_count > 0,
    validation_timed_out: validationTimedOut,
    validation_time_budget_ms: SQLCIPHER_VALIDATION_MAX_MS,
    omitted_attempt_count: omissionStats.omitted_candidate_count,
  };
}

async function validateCopiedDbWithWeixinV4PageKeys(dbPath, orderedKeys, { signal = null, derive_passphrase_keys = true, allow_external_test_db = false } = {}) {
  throwIfAborted(signal);
  await assertCopiedDbRealPath(dbPath, { allow_external_test_db, signal });
  const found = await findWeixinV4PageKeyForCopiedDb(dbPath, orderedKeys, { signal, derive_passphrase_keys: derive_passphrase_keys === true, allow_external_test_db });
  throwIfAborted(signal);
  if (!found?.raw) return found;
  const Database = await loadSqlCipher();
  const plainPath = await decryptWeixinV4DbToPlaintext(dbPath, found.raw, { signal, allow_external_test_db, page_hmac_prevalidated: true });
  let db;
  try {
    throwIfAborted(signal);
    await assertCopiedDbRealPath(plainPath, { allow_external_test_db, signal });
    db = await openReadonlyDatabase(Database, plainPath, { allow_external_test_db, signal });
    enforceQueryOnly(db);
    const row = db.prepare('select count(*) as c from sqlite_master').get();
    const tables = db.prepare("select name from sqlite_master where type = 'table' order by name limit 20").all();
    return withVerifiedRawKey({
      ok: true,
      attempts: found.attempts,
      key_profile: WEIXIN_V4_MANUAL_PROFILE.id,
      key_kind: found.key_kind || '',
      key_hash: crypto.createHash('sha256').update(found.raw).digest('hex').slice(0, 12),
      table_count: Number(row?.c || 0),
      tables: tables.map(t => String(t.name || '')).filter(Boolean),
    }, found.raw, { keyKind: found.key_kind, sourceRaw: found.source_raw });
  } catch (e) {
    if (isSqliteCorruptionError(e)) throw copiedDbCorruptionError(e, dbPath);
    if (e?.status === 499 || signal?.aborted || !isExpectedSqlCipherKeyValidationError(e)) throw e;
    return { ok: false, attempts: found.attempts };
  } finally {
    try { db?.close(); } catch {}
    await assertCopiedDbRealPath(plainPath)
      .then(() => fsp.rm(plainPath, { force: true }))
      .catch(() => {});
  }
}

async function openWeixinV4DecryptedDb(dbPath, rawKeys, Database, {
  signal = null,
  onProgress = null,
  sourceName = '',
  copied = null,
  maxPassphraseDeriveCandidates = WEIXIN_V4_PASSPHRASE_DERIVE_CANDIDATE_LIMIT,
} = {}) {
  throwIfAborted(signal);
  await assertCopiedDbRealPath(dbPath, { signal });
  const salt = (await readHeader(dbPath, { signal })).toString('hex');
  throwIfAborted(signal);
  const orderedKeys = orderedRawKeyCandidates(rawKeys, salt);
  const sourceLabel = sourceName || path.basename(dbPath);
  const found = await findWeixinV4PageKeyForCopiedDb(dbPath, orderedKeys, {
    signal,
    derive_passphrase_keys: true,
    max_passphrase_derive_candidates: maxPassphraseDeriveCandidates,
    on_progress: progress => {
      if (progress?.phase !== 'passphrase_derive') return;
      notifyProgress(onProgress, {
        phase: 'fetch_shard_passphrase_verify',
        label: '拉取消息 · 验证数据库访问候选',
        detail: `${sourceLabel}：正在验证备用访问候选 ${progress.attempted}/${progress.total}`,
      });
    },
  });
  throwIfAborted(signal);
  if (!found?.raw) return null;
  const opened = await openCachedWeixinV4PlaintextDb(dbPath, found.raw, Database, { signal, onProgress, sourceName, copied });
  return {
    db: opened.db,
    plain_path: opened.plain_path,
    plain_cached: opened.plain_cached,
    plain_lease: opened.plain_lease,
    raw_key: persistableRawKeyForVerifiedCache(found.raw, { keyKind: found.key_kind, sourceRaw: found.source_raw }),
    key_hash: crypto.createHash('sha256').update(found.raw).digest('hex').slice(0, 12),
    key_profile: WEIXIN_V4_MANUAL_PROFILE.id,
    key_kind: found.key_kind || '',
  };
}

async function openCachedWeixinV4PlaintextDb(dbPath, keyHex, Database, { signal = null, onProgress = null, sourceName = '', copied = null } = {}) {
  await assertNoHotCopiedRollbackJournal(dbPath, { signal });
  const sourceLabel = sourceName || path.basename(dbPath);
  await pruneWeixinV4PlaintextCache({ signal });
  const cache = await weixinV4PlaintextCachePaths(dbPath, keyHex, { signal, copied });
  const cached = await openUsableCachedPlaintextDb(Database, cache.plainPath, { signal }).catch(async e => {
    if (e?.status === 499 || signal?.aborted) throw e;
    await removePlaintextCacheEntryIfUnused(cache.plainPath, { signal }).catch(() => {});
    return null;
  });
  if (cached?.db) {
    notifyProgress(onProgress, {
        phase: 'fetch_shard_decrypt_plain_cache_hit',
        label: '拉取消息 · 复用已解密临时读取数据',
        detail: `${sourceLabel}：命中临时读取缓存，跳过重复逐页处理`,
    });
    return { db: cached.db, plain_path: cache.plainPath, plain_cached: true, plain_lease: cached.lease_path };
  }

  const releaseBuildLock = await acquirePlaintextCacheEntryLock(cache.plainPath, {
    signal,
    onWait: () => notifyProgress(onProgress, {
      phase: 'fetch_shard_decrypt_plain_wait',
      label: '拉取消息 · 等待临时读取数据',
      detail: `${sourceLabel}：另一个读取任务正在准备同一数据库，完成后直接复用`,
    }),
  });
  let openedResult = null;
  try {
    const existing = await openUsableCachedPlaintextDb(Database, cache.plainPath, { signal, lock_held: true }).catch(async e => {
      if (isWxdbAbort(e, signal)) throw e;
      await removePlaintextCacheEntryIfUnused(cache.plainPath, { signal, lock_held: true }).catch(() => {});
      return null;
    });
    if (existing?.db) {
      notifyProgress(onProgress, {
        phase: 'fetch_shard_decrypt_plain_cache_hit',
        label: '拉取消息 · 复用已解密临时读取数据',
        detail: `${sourceLabel}：并发任务已准备好临时读取数据，跳过重复逐页处理`,
      });
      return { db: existing.db, plain_path: cache.plainPath, plain_cached: true, plain_lease: existing.lease_path };
    }

    await assertSafeTmpPath(cache.tempPath, { label: 'plaintext cache temp', ensureParent: true });
    await assertSafeTmpPath(cache.plainPath, { label: 'plaintext cache file', ensureParent: true });
    const producedPath = await decryptWeixinV4DbToPlaintext(dbPath, keyHex, {
      signal,
      onProgress,
      sourceName,
      targetPath: cache.tempPath,
      page_hmac_prevalidated: true,
    });
    let producedPathOwned = true;
    try {
      throwIfAborted(signal);
      await assertCopiedDbRealPath(producedPath, { signal });
      await assertSafeTmpPath(cache.plainPath, { label: 'plaintext cache file', ensureParent: true });
      await renameAtomicWithRetry(producedPath, cache.plainPath);
      producedPathOwned = false;
    } finally {
      if (producedPathOwned) {
        await assertCopiedDbRealPath(producedPath)
          .then(() => fsp.rm(producedPath, { force: true }))
          .catch(() => {});
      }
    }
    await assertCopiedDbRealPath(cache.plainPath, { signal });
    const opened = await openUsableCachedPlaintextDb(Database, cache.plainPath, { signal, lock_held: true }).catch(async e => {
      await removePlaintextCacheEntryIfUnused(cache.plainPath, { signal, lock_held: true }).catch(() => {});
      if (isSqliteCorruptionError(e)) throw copiedDbCorruptionError(e, dbPath);
      throw e;
    });
    openedResult = { db: opened.db, plain_path: cache.plainPath, plain_cached: true, plain_lease: opened.lease_path };
  } finally {
    await releaseBuildLock();
  }
  await pruneWeixinV4PlaintextCache({ signal }).catch(() => {});
  return openedResult;
}

async function openUsableCachedPlaintextDb(Database, plainPath, { signal = null, lock_held = false } = {}) {
  throwIfAborted(signal);
  let leasePath = '';
  let db;
  try {
    leasePath = await retainWeixinV4PlaintextCache(plainPath, { signal, lock_held });
    const header = await readHeader(plainPath, { signal });
    if (!header.equals(SQLITE_HEADER)) throw new Error('cached plaintext database has an invalid sqlite header');
    db = await openReadonlyDatabase(Database, plainPath, { signal });
    enforceQueryOnly(db);
    db.prepare('select count(*) as c from sqlite_master').get();
    throwIfAborted(signal);
    return { db, lease_path: leasePath };
  } catch (e) {
    try { db?.close(); } catch {}
    await releaseWeixinV4PlaintextCache(plainPath, leasePath);
    throw e;
  }
}

function plaintextCacheRefKey(file) {
  const resolved = path.resolve(String(file || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function rememberLocalPlaintextCacheLease(file, leasePath) {
  if (!file || !leasePath) return;
  const key = plaintextCacheRefKey(file);
  const leases = weixinV4PlaintextCacheRefs.get(key) || new Set();
  leases.add(path.resolve(leasePath));
  weixinV4PlaintextCacheRefs.set(key, leases);
}

function forgetLocalPlaintextCacheLease(file, leasePath) {
  if (!file || !leasePath) return;
  const key = plaintextCacheRefKey(file);
  const leases = weixinV4PlaintextCacheRefs.get(key);
  if (!leases) return;
  leases.delete(path.resolve(leasePath));
  if (!leases.size) weixinV4PlaintextCacheRefs.delete(key);
}

function weixinV4PlaintextCacheInUse(file) {
  if (!file) return false;
  return (weixinV4PlaintextCacheRefs.get(plaintextCacheRefKey(file))?.size || 0) > 0;
}

function plaintextCacheEntryLockPath(file = '') {
  const target = `${path.resolve(String(file || ''))}.build.lock`;
  assertCopiedDbPath(target);
  return target;
}

function plaintextCacheLeasePath(file = '') {
  const target = `${path.resolve(String(file || ''))}.${process.pid}.${WEIXIN_V4_PLAINTEXT_CACHE_PROCESS_TOKEN}.${crypto.randomUUID().slice(0, 8)}.lease`;
  assertCopiedDbPath(target);
  return target;
}

function plaintextCacheReleasingLeasePath(file = '') {
  const leasePath = path.resolve(String(file || ''));
  if (!leasePath.toLowerCase().endsWith('.lease')) {
    throw new Error('plaintext cache releasing marker requires a lease path');
  }
  const target = `${leasePath}.releasing`;
  assertCopiedDbPath(target);
  return target;
}

function plaintextCachePlainPathFromLeaseArtifact(file = '') {
  const artifact = path.resolve(String(file || ''));
  const match = path.basename(artifact).match(/^([a-f0-9]{64}\.db)\.\d+\.[a-f0-9]{16}\.[a-f0-9]{8}\.lease(?:\.releasing)?$/i);
  if (!match) return '';
  const target = path.join(path.dirname(artifact), match[1]);
  assertCopiedDbPath(target);
  return path.resolve(target);
}

function plaintextCacheLeaseOwner(file = '') {
  const match = path.basename(String(file || '')).match(/^[a-f0-9]{64}\.db\.(\d+)\.([a-f0-9]{16})\.[a-f0-9]{8}\.lease$/i);
  const pid = Math.trunc(Number(match?.[1] || 0));
  return {
    pid: pid > 0 ? pid : 0,
    process_token: String(match?.[2] || '').toLowerCase(),
  };
}

async function readPlaintextCacheArtifactOwner(file) {
  const st = await fsp.lstat(file).catch(() => null);
  if (!st?.isFile() || st.isSymbolicLink?.() || st.size <= 0 || st.size > 4096) {
    return { owner: null, stat: st, raw: '' };
  }
  const raw = await fsp.readFile(file, 'utf8').catch(() => '');
  let owner = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) owner = parsed;
  } catch {}
  return { owner, stat: st, raw };
}

function plaintextCacheArtifactIsFresh(observed = null, now = Date.now()) {
  if (!observed?.stat) return false;
  const ageMs = Math.max(0, Number(now || 0) - Number(observed.stat.mtimeMs || 0));
  return ageMs < DB_PLAINTEXT_CACHE_STALE_GRACE_MS;
}

async function plaintextCacheOwnerMatches(owner = null, observed = null, {
  processAlive = processIsAlive,
  processStartIdentityFn = processStartIdentity,
} = {}) {
  const pid = Math.trunc(Number(owner?.pid || 0));
  const token = String(owner?.token || owner?.process_token || '').trim();
  if (pid <= 0 || !token) return false;
  const state = await processOwnerState(owner, { processAlive, processStartIdentityFn });
  return state === 'same' || state === 'unknown';
}

async function reclaimStalePlaintextCacheLock(lockPath) {
  const observed = await readPlaintextCacheArtifactOwner(lockPath);
  if (!observed.stat) return true;
  if (!atomicProcessLockOwnerIsComplete(observed.owner)) {
    throw dbTempCopyError(
      'wxdb_temp_copy_plain_cache_lock_owner_incomplete',
      '临时数据库构建锁缺少完整 owner 信息；为避免并发创建同一明文缓存，程序不会按文件年龄自动删除它。请重启本程序后重试。',
      { source: lockPath, cause: 'plaintext_cache_lock_owner_incomplete' },
    );
  }
  const ownerState = await processOwnerState(observed.owner, {
    processAlive: processIsAlive,
    processStartIdentityFn: processStartIdentity,
  });
  if (!['dead', 'different'].includes(ownerState)) return false;
  return reclaimAtomicProcessLockFile(lockPath, observed, {
    ownerState,
    readLock: readPlaintextCacheArtifactOwner,
  });
}

async function acquirePlaintextCacheEntryLock(file, { signal = null, onWait = null } = {}) {
  throwIfAborted(signal);
  const lockPath = plaintextCacheEntryLockPath(file);
  const token = crypto.randomUUID();
  const processStartId = await processStartIdentity(process.pid);
  const startedAt = Date.now();
  let waitReported = false;
  while (true) {
    throwIfAborted(signal);
    const safe = await assertSafeTmpPath(lockPath, { label: 'plaintext cache build lock', ensureParent: true });
    let acquisition = null;
    let handle = null;
    let heartbeat = null;
    try {
      acquisition = await publishAtomicProcessLock({
        lockPath: safe.resolved,
        mode: 0o600,
        owner: {
          version: 1,
          pid: process.pid,
          process_start_id: processStartId,
          process_token: WEIXIN_V4_PLAINTEXT_CACHE_PROCESS_TOKEN,
          token,
          created_at: new Date().toISOString(),
        },
      });
      handle = acquisition.handle;
      heartbeat = setInterval(() => {
        const now = new Date();
        void handle?.utimes(now, now).catch(() => {});
      }, DB_PLAINTEXT_CACHE_HEARTBEAT_MS);
      heartbeat.unref?.();
      return async () => {
        clearInterval(heartbeat);
        heartbeat = null;
        await handle?.close().catch(() => {});
        handle = null;
        return releaseAtomicProcessLockFile(lockPath, token, {
          readLock: readPlaintextCacheArtifactOwner,
        });
      };
    } catch (e) {
      clearInterval(heartbeat);
      await handle?.close().catch(() => {});
      if (acquisition) {
        await releaseAtomicProcessLockFile(lockPath, token, {
          readLock: readPlaintextCacheArtifactOwner,
        }).catch(() => {});
      }
      if (e?.code !== 'EEXIST') {
        throw e;
      }
      if (await reclaimStalePlaintextCacheLock(lockPath)) continue;
      if (!waitReported) {
        waitReported = true;
        try { onWait?.(); } catch {}
      }
      if (Date.now() - startedAt >= DB_PLAINTEXT_CACHE_LOCK_WAIT_MS) {
        throw dbTempCopyError('wxdb_temp_copy_plain_cache_wait_timeout', '另一个数据库读取任务长时间未完成临时读取数据准备，已停止本次等待。请稍后重试。', {
          source: file,
          category: path.basename(path.dirname(file)),
          cause: 'plaintext_cache_lock_timeout',
        });
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

async function createPlaintextCacheLease(file, { signal = null } = {}) {
  throwIfAborted(signal);
  await assertCopiedDbRealPath(file, { signal });
  const leasePath = plaintextCacheLeasePath(file);
  const safe = await assertSafeTmpPath(leasePath, { label: 'plaintext cache lease', ensureParent: true });
  let handle = null;
  let heartbeat = null;
  try {
    handle = await fsp.open(safe.resolved, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({
      pid: process.pid,
      process_start_id: await processStartIdentity(process.pid),
      process_token: WEIXIN_V4_PLAINTEXT_CACHE_PROCESS_TOKEN,
      created_at: new Date().toISOString(),
    }));
    await handle.sync();
    heartbeat = setInterval(() => {
      const now = new Date();
      void handle?.utimes(now, now).catch(() => {});
    }, DB_PLAINTEXT_CACHE_HEARTBEAT_MS);
    heartbeat.unref?.();
    weixinV4PlaintextCacheLeaseHeartbeats.set(plaintextCacheRefKey(safe.resolved), { handle, heartbeat });
    rememberLocalPlaintextCacheLease(file, safe.resolved);
    return safe.resolved;
  } catch (e) {
    clearInterval(heartbeat);
    await handle?.close().catch(() => {});
    await fsp.rm(safe.resolved, { force: true }).catch(() => {});
    throw e;
  }
}

async function retainWeixinV4PlaintextCache(file, { signal = null, lock_held = false } = {}) {
  if (!file) return '';
  if (lock_held) return createPlaintextCacheLease(file, { signal });
  const releaseLock = await acquirePlaintextCacheEntryLock(file, { signal });
  try {
    return await createPlaintextCacheLease(file, { signal });
  } finally {
    await releaseLock();
  }
}

async function transitionPlaintextCacheLeaseToReleasing(leasePath) {
  const releasingPath = plaintextCacheReleasingLeasePath(leasePath);
  const safeLease = await assertSafeTmpPath(leasePath, {
    label: 'plaintext cache lease',
    allowMissing: true,
  });
  const safeReleasing = await assertSafeTmpPath(releasingPath, {
    label: 'plaintext cache releasing marker',
    ensureParent: true,
    allowMissing: true,
  });
  if (!safeLease.exists) return safeReleasing.resolved;
  try {
    await fsp.rename(safeLease.resolved, safeReleasing.resolved);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    await fsp.rm(safeLease.resolved, { force: true });
  }
  return safeReleasing.resolved;
}

async function settlePlaintextCacheRelease(file, releasingPath, { signal = null } = {}) {
  let markerCanBeRemoved = false;
  const releaseLock = await acquirePlaintextCacheEntryLock(file, { signal });
  try {
    const plaintextRemoved = await removePlaintextCacheEntryIfUnused(file, { signal, lock_held: true });
    markerCanBeRemoved = plaintextRemoved
      || await activePlaintextCacheLeaseCount(file, { signal }) > 0;
  } finally {
    await releaseLock();
  }
  if (!markerCanBeRemoved) return false;
  const safeMarker = await assertSafeTmpPath(releasingPath, {
    label: 'plaintext cache releasing marker',
    allowMissing: true,
  });
  if (safeMarker.exists) await fsp.rm(safeMarker.resolved, { force: true });
  return true;
}

async function releaseWeixinV4PlaintextCache(file, leasePath = '', { retainForWorkerSession = false } = {}) {
  if (!file || !leasePath) return;
  const refKey = plaintextCacheRefKey(file);
  if (retainForWorkerSession
    && WXDB_PERSISTENT_WORKER_SESSION
    && !wxDbPersistentWorkerSessionClosing
    && !weixinV4WorkerSessionPlaintextLeases.has(refKey)) {
    const stat = await fsp.stat(file).catch(() => null);
    const heldBytes = [...weixinV4WorkerSessionPlaintextLeases.values()]
      .reduce((total, item) => total + Math.max(0, Number(item.bytes || 0) || 0), 0);
    const bytes = Math.max(0, Number(stat?.size || 0) || 0);
    if (stat?.isFile()
      && bytes > 0
      && weixinV4WorkerSessionPlaintextLeases.size < DB_PLAINTEXT_CACHE_MAX_ENTRIES
      && heldBytes + bytes <= DB_PLAINTEXT_CACHE_MAX_BYTES) {
      weixinV4WorkerSessionPlaintextLeases.set(refKey, {
        file: path.resolve(file),
        lease_path: path.resolve(leasePath),
        bytes,
      });
      return;
    }
  }
  forgetLocalPlaintextCacheLease(file, leasePath);
  const heartbeatState = weixinV4PlaintextCacheLeaseHeartbeats.get(plaintextCacheRefKey(leasePath));
  if (heartbeatState) {
    weixinV4PlaintextCacheLeaseHeartbeats.delete(plaintextCacheRefKey(leasePath));
    clearInterval(heartbeatState.heartbeat);
    await heartbeatState.handle?.close().catch(() => {});
  }
  let releasingPath = '';
  try {
    releasingPath = await transitionPlaintextCacheLeaseToReleasing(leasePath);
  } catch {
    return;
  }
  // The durable marker closes the crash window between giving up the final
  // reader lease and deleting the readable database.
  await settlePlaintextCacheRelease(file, releasingPath).catch(() => {});
}

export async function releaseWxDbWorkerSessionPlaintextCaches() {
  if (wxDbPersistentWorkerSessionClosing) return 0;
  wxDbPersistentWorkerSessionClosing = true;
  const held = [...weixinV4WorkerSessionPlaintextLeases.values()];
  weixinV4WorkerSessionPlaintextLeases.clear();
  let released = 0;
  try {
    for (const item of held) {
      await releaseWeixinV4PlaintextCache(item.file, item.lease_path);
      released += 1;
    }
  } finally {
    wxDbPersistentWorkerSessionClosing = false;
  }
  return released;
}

async function collectWxDbWorkerPlaintextArtifacts(root, pid, token, artifacts, plainPaths, buildLocks, depth = 0) {
  if (depth > 4) return;
  const stat = await fsp.lstat(root).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink?.()) return;
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    assertCopiedDbPath(target);
    if (entry.isSymbolicLink?.()) continue;
    if (entry.isDirectory()) {
      await collectWxDbWorkerPlaintextArtifacts(target, pid, token, artifacts, plainPaths, buildLocks, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    let plainName = '';
    const leaseMatch = entry.name.match(new RegExp(`^([a-f0-9]{64}\\.db)\\.${pid}\\.${token}\\.[a-f0-9]{8}\\.lease(?:\\.releasing)?$`, 'i'));
    const tempMatch = entry.name.match(new RegExp(`^([a-f0-9]{64})\\.${pid}\\.${token}\\.\\d+\\.[a-f0-9]{8}\\.tmp$`, 'i'));
    const buildMatch = entry.name.match(/^([a-f0-9]{64}\.db)\.build\.lock$/i);
    if (leaseMatch) {
      plainName = leaseMatch[1];
    } else if (tempMatch) {
      plainName = `${tempMatch[1]}.db`;
    } else if (buildMatch) {
      const observed = await readPlaintextCacheArtifactOwner(target);
      if (Math.trunc(Number(observed.owner?.pid || 0)) !== pid
        || String(observed.owner?.process_token || '').toLowerCase() !== token) continue;
      const safe = await assertSafeTmpPath(target, {
        label: 'terminated wxdb worker plaintext build lock',
        requireFile: true,
      }).catch(() => null);
      if (!safe?.exists) continue;
      plainName = buildMatch[1];
      const plainPath = path.join(root, plainName);
      assertCopiedDbPath(plainPath);
      plainPaths.add(path.resolve(plainPath));
      buildLocks.add(safe.resolved);
      continue;
    } else {
      continue;
    }
    const safe = await assertSafeTmpPath(target, { label: 'terminated wxdb worker plaintext artifact', requireFile: true }).catch(() => null);
    if (!safe?.exists) continue;
    artifacts.add(safe.resolved);
    const plainPath = path.join(root, plainName);
    assertCopiedDbPath(plainPath);
    plainPaths.add(path.resolve(plainPath));
  }
}

export async function cleanupWxDbWorkerPlaintextCaches(pid, token) {
  const cleanPid = Math.trunc(Number(pid || 0));
  const cleanToken = String(token || '').trim().toLowerCase();
  if (cleanPid <= 0 || !/^[a-f0-9]{16}$/.test(cleanToken)) {
    return { artifacts_removed: 0, plaintext_removed: 0, failed: 0 };
  }
  const artifacts = new Set();
  const plainPaths = new Set();
  const buildLocks = new Set();
  await collectWxDbWorkerPlaintextArtifacts(DB_PLAINTEXT_CACHE_ROOT, cleanPid, cleanToken, artifacts, plainPaths, buildLocks);
  const releasingMarkers = new Map();
  const removableArtifacts = new Set();
  const markerPlainPaths = new Set();
  let artifactsRemoved = 0;
  let plaintextRemoved = 0;
  let failed = 0;
  // This function is called only after the isolated worker has exited. Remove
  // its exact-token build locks before settling leases, or the cleanup would
  // wait on a lock that can no longer be released by its original owner.
  for (const buildLock of buildLocks) {
    try {
      const safe = await assertSafeTmpPath(buildLock, {
        label: 'terminated wxdb worker plaintext build lock',
        allowMissing: true,
      });
      if (!safe.exists) continue;
      const observed = await readPlaintextCacheArtifactOwner(safe.resolved);
      if (Math.trunc(Number(observed.owner?.pid || 0)) !== cleanPid
        || String(observed.owner?.process_token || '').toLowerCase() !== cleanToken) continue;
      await fsp.rm(safe.resolved, { force: true });
      artifactsRemoved += 1;
    } catch {
      failed += 1;
    }
  }
  for (const artifact of artifacts) {
    if (artifact.toLowerCase().endsWith('.lease.releasing')) {
      const plainPath = plaintextCachePlainPathFromLeaseArtifact(artifact);
      if (plainPath) {
        releasingMarkers.set(artifact, plainPath);
        markerPlainPaths.add(plainPath);
      }
      continue;
    }
    if (artifact.toLowerCase().endsWith('.lease')) {
      try {
        const marker = await transitionPlaintextCacheLeaseToReleasing(artifact);
        const plainPath = plaintextCachePlainPathFromLeaseArtifact(marker);
        if (plainPath) {
          releasingMarkers.set(marker, plainPath);
          markerPlainPaths.add(plainPath);
        }
      } catch {
        failed += 1;
      }
      continue;
    }
    removableArtifacts.add(artifact);
  }
  for (const [marker, plainPath] of releasingMarkers) {
    try {
      const markerExisted = await fsp.lstat(marker).then(stat => stat.isFile()).catch(() => false);
      if (!await settlePlaintextCacheRelease(plainPath, marker)) {
        failed += 1;
        continue;
      }
      if (markerExisted) artifactsRemoved += 1;
    } catch {
      failed += 1;
    }
  }
  for (const plainPath of plainPaths) {
    if (markerPlainPaths.has(plainPath)) {
      if (!await fsp.lstat(plainPath).then(stat => stat.isFile()).catch(() => false)) plaintextRemoved += 1;
      continue;
    }
    try {
      if (await removePlaintextCacheEntryIfUnused(plainPath)) plaintextRemoved += 1;
    } catch {
      failed += 1;
    }
  }
  for (const artifact of removableArtifacts) {
    try {
      const safe = await assertSafeTmpPath(artifact, {
        label: 'terminated wxdb worker plaintext artifact',
        allowMissing: true,
      });
      if (!safe.exists) continue;
      await fsp.rm(safe.resolved, { force: true });
      artifactsRemoved += 1;
    } catch {
      failed += 1;
    }
  }
  return {
    artifacts_removed: artifactsRemoved,
    plaintext_removed: plaintextRemoved,
    failed,
  };
}

async function activePlaintextCacheLeaseCount(file, { signal = null } = {}) {
  throwIfAborted(signal);
  if (weixinV4PlaintextCacheInUse(file)) return weixinV4PlaintextCacheRefs.get(plaintextCacheRefKey(file))?.size || 1;
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.`;
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  let active = 0;
  for (const entry of entries) {
    throwIfAborted(signal);
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.lease')) continue;
    const leasePath = path.join(dir, entry.name);
    const filenameOwner = plaintextCacheLeaseOwner(entry.name);
    const observed = await readPlaintextCacheArtifactOwner(leasePath);
    if (!observed.stat?.isFile() || observed.stat.isSymbolicLink?.()) continue;
    const ownerMatches = await plaintextCacheOwnerMatches(observed.owner, observed);
    const leaseAgeMs = Math.max(0, Date.now() - Number(observed.stat.mtimeMs || 0));
    const ownerBindingMatches = filenameOwner.pid > 0
      && filenameOwner.pid === Math.trunc(Number(observed.owner?.pid || 0))
      && filenameOwner.process_token === String(observed.owner?.process_token || '').toLowerCase();
    const stale = !ownerBindingMatches
      ? leaseAgeMs > DB_PLAINTEXT_CACHE_LEASE_HARD_MAX_MS
      : !ownerMatches;
    if (stale) {
      const transitioned = await transitionPlaintextCacheLeaseToReleasing(leasePath)
        .then(() => true)
        .catch(() => false);
      if (!transitioned) active += 1;
      continue;
    }
    active += 1;
  }
  return active;
}

async function removePlaintextCacheEntryIfUnused(file, { signal = null, lock_held = false } = {}) {
  const remove = async () => {
    if (await activePlaintextCacheLeaseCount(file, { signal })) return false;
    const stat = await fsp.lstat(file).catch(e => {
      if (isMissingFileError(e)) return null;
      throw e;
    });
    if (!stat) return true;
    try {
      await assertCopiedDbRealPath(file, { signal });
      await fsp.rm(file, { force: true });
      return true;
    } catch (e) {
      if (isMissingFileError(e)) return true;
      return false;
    }
  };
  if (lock_held) return remove();
  const releaseLock = await acquirePlaintextCacheEntryLock(file, { signal });
  try {
    return await remove();
  } finally {
    await releaseLock();
  }
}

function plaintextCacheTempOwner(file = '') {
  const match = path.basename(String(file || '')).match(/^([a-f0-9]{64})\.(\d+)\.([a-f0-9]{16})\.\d+\.[a-f0-9]{8}\.tmp$/i);
  return {
    cache_key: String(match?.[1] || '').toLowerCase(),
    pid: Math.trunc(Number(match?.[2] || 0)) > 0 ? Math.trunc(Number(match[2])) : 0,
    process_token: String(match?.[3] || '').toLowerCase(),
  };
}

async function plaintextCacheTempIsActive(file = '') {
  const owner = plaintextCacheTempOwner(file);
  if (!owner.cache_key || owner.pid <= 0 || !owner.process_token) return false;
  const lockPath = plaintextCacheEntryLockPath(path.join(path.dirname(file), `${owner.cache_key}.db`));
  const lock = await readPlaintextCacheArtifactOwner(lockPath);
  if (!lock.stat) return false;
  if (owner.pid !== Math.trunc(Number(lock.owner?.pid || 0))) return false;
  if (owner.process_token !== String(lock.owner?.process_token || '').toLowerCase()) return false;
  return plaintextCacheOwnerMatches(lock.owner, lock);
}

function processIsAlive(pid) {
  const value = Math.trunc(Number(pid || 0));
  if (value <= 0) return false;
  if (value === process.pid) return true;
  try {
    process.kill(value, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

async function weixinV4PlaintextCachePaths(dbPath, keyHex, { signal = null, copied = null } = {}) {
  await ensurePrivatePlaintextCacheRoot({ signal });
  const cacheKey = await weixinV4PlaintextCacheKey(dbPath, keyHex, { signal, copied });
  const accountSegment = copiedDbAccountCacheSegment(dbPath);
  const dir = path.join(DB_PLAINTEXT_CACHE_ROOT, accountSegment, cacheKey.slice(0, 2));
  const plainPath = path.join(dir, `${cacheKey}.db`);
  const tempPath = path.join(dir, `${cacheKey}.${process.pid}.${WEIXIN_V4_PLAINTEXT_CACHE_PROCESS_TOKEN}.${Date.now()}.${crypto.randomUUID().slice(0, 8)}.tmp`);
  assertCopiedDbPath(plainPath);
  assertCopiedDbPath(tempPath);
  return { cacheKey, dir, plainPath, tempPath };
}

function privatePlaintextCacheAclScript(root) {
  const rootBase64 = Buffer.from(String(root || ''), 'utf8').toString('base64');
  return `
$ErrorActionPreference = 'Stop'
$root = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${rootBase64}'))
$allowedSidValues = @(
  [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
  'S-1-5-18',
  'S-1-5-32-544'
)
function Invoke-PrivateIcacls([string[]]$arguments) {
  $icacls = Join-Path (Join-Path $env:SystemRoot 'System32') 'icacls.exe'
  & $icacls @arguments | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "icacls failed with exit code $LASTEXITCODE"
  }
}
function Get-PrivateFileSystemAcl([string]$itemPath, [bool]$isDirectory) {
  if ($isDirectory) {
    return [System.IO.Directory]::GetAccessControl($itemPath)
  }
  return [System.IO.File]::GetAccessControl($itemPath)
}
function Get-ForeignAclSids([System.Security.AccessControl.FileSystemSecurity]$acl) {
  $foreignSids = @{}
  $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
  foreach ($rule in $rules) {
    $sid = $rule.IdentityReference.Value
    if ($allowedSidValues -notcontains $sid) {
      $foreignSids[$sid] = $true
    }
  }
  return @($foreignSids.Keys)
}
function Set-PrivateFileSystemAcl([string]$itemPath, [bool]$isDirectory) {
  $grant = @()
  foreach ($sid in $allowedSidValues) {
    if ($isDirectory) {
      $grant += ('*{0}:(OI)(CI)F' -f $sid)
    } else {
      $grant += ('*{0}:F' -f $sid)
    }
  }
  Invoke-PrivateIcacls (@($itemPath, '/inheritance:r', '/grant:r') + $grant + @('/Q'))
  $acl = Get-PrivateFileSystemAcl $itemPath $isDirectory
  foreach ($sid in @(Get-ForeignAclSids $acl)) {
    Invoke-PrivateIcacls @($itemPath, '/remove', "*$sid", '/Q')
  }
  $verifiedAcl = Get-PrivateFileSystemAcl $itemPath $isDirectory
  if ((@(Get-ForeignAclSids $verifiedAcl)).Count -gt 0 -or -not $verifiedAcl.AreAccessRulesProtected) {
    throw "plaintext cache ACL verification failed: $itemPath"
  }
}
$root = [System.IO.Directory]::CreateDirectory($root).FullName
Set-PrivateFileSystemAcl $root $true
foreach ($itemPath in [System.IO.Directory]::EnumerateFileSystemEntries($root, '*', [System.IO.SearchOption]::AllDirectories)) {
  Set-PrivateFileSystemAcl $itemPath ([System.IO.Directory]::Exists($itemPath))
}
`;
}

async function applyPrivatePlaintextCachePermissions() {
  await assertSafeTmpPath(path.join(DB_PLAINTEXT_CACHE_ROOT, 'permission.probe'), {
    label: 'plaintext cache permission root',
    ensureParent: true,
  });
  if (process.platform !== 'win32') {
    await fsp.chmod(DB_PLAINTEXT_CACHE_ROOT, 0o700);
    return;
  }
  const encoded = Buffer.from(privatePlaintextCacheAclScript(DB_PLAINTEXT_CACHE_ROOT), 'utf16le').toString('base64');
  await execFileAsync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encoded,
  ], {
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
}

async function ensurePrivatePlaintextCacheRoot({ signal = null } = {}) {
  throwIfAborted(signal);
  if (!plaintextCacheSecurityPromise) {
    plaintextCacheSecurityPromise = applyPrivatePlaintextCachePermissions().catch(error => {
      plaintextCacheSecurityPromise = null;
      throw dbTempCopyError(
        'wxdb_plaintext_cache_permissions_unsafe',
        '无法为数据库临时读取目录设置仅当前用户可访问的权限，已停止解密读取以避免明文消息库暴露。请检查 outputs/.tmp 权限后重试。',
        {
          source: DB_PLAINTEXT_CACHE_ROOT,
          category: 'plain-cache',
          cause: sanitizeWxdbDiagnosticError(error?.message || error),
        },
      );
    });
  }
  await plaintextCacheSecurityPromise;
  throwIfAborted(signal);
  return DB_PLAINTEXT_CACHE_ROOT;
}

async function weixinV4PlaintextCacheKey(dbPath, keyHex, { signal = null, copied = null } = {}) {
  await assertCopiedDbRealPath(dbPath, { signal });
  const keyHash = crypto.createHash('sha256').update(String(keyHex || '').toLowerCase()).digest('hex');
  const parts = [DB_PLAINTEXT_CACHE_VERSION, `key:${keyHash}`];
  const copiedFingerprint = copiedDbSourceFingerprintForCache(copied);
  if (copiedFingerprint) {
    parts.push(copiedFingerprint);
    return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
  }
  for (const suffix of SQLITE_PERSISTED_COPY_SUFFIXES) {
    const file = suffix ? `${dbPath}${suffix}` : dbPath;
    const label = suffix || '.db';
    let st = null;
    try {
      st = await fsp.lstat(file);
    } catch (e) {
      if (suffix && isMissingFileError(e)) {
        parts.push(`${label}:missing`);
        continue;
      }
      throw dbTempCopyError('wxdb_temp_copy_cache_fingerprint_unreadable', '微信数据库临时读取数据缓存校验失败：无法读取数据库或 WAL 副本状态，已停止复用缓存以避免漏掉最新消息。请稍后重试。', {
        source: file,
        category: path.basename(path.dirname(dbPath)),
        cause: transientDbCopyErrorCause(e),
      });
    }
    throwIfAborted(signal);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw dbTempCopyError('wxdb_temp_copy_cache_fingerprint_unreadable', '微信数据库临时读取数据缓存校验失败：数据库或 WAL 副本不是普通文件，已停止复用缓存以避免漏掉最新消息。请重新检查本地数据后重试。', {
        source: file,
        category: path.basename(path.dirname(dbPath)),
        cause: st.isSymbolicLink() ? 'cache_fingerprint_symlink' : 'cache_fingerprint_not_regular',
      });
    }
    const digest = await sha256CopiedFile(file, { signal });
    parts.push(`${label}:${st.size}:${digest}`);
  }
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

function copiedDbSourceFingerprintForCache(copied = null) {
  if (!copied || typeof copied !== 'object') return '';
  if (String(copied.source_fingerprint_kind || '').trim() !== 'copied_content_sha256') return '';
  const fingerprint = String(copied.source_fingerprint || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) return '';
  const sourceName = String(copied.source_name || '').trim();
  const sourceCategory = String(copied.source_category || '').trim();
  const bytes = Number(copied.bytes || 0) || 0;
  if (!sourceName || !sourceCategory || bytes <= 0) return '';
  return JSON.stringify({
    source_category: sourceCategory,
    source_name: sourceName,
    bytes,
    source_fingerprint_kind: 'copied_content_sha256',
    source_fingerprint: fingerprint,
  });
}

function copiedDbAccountCacheSegment(dbPath) {
  const rel = path.relative(DB_COPY_ROOT, path.resolve(String(dbPath || '')));
  const segment = rel.split(path.sep)[0] || '';
  return /^wxacc_[a-f0-9]{16}$/i.test(segment) ? segment : 'wxacc_unknown';
}

async function pruneWeixinV4PlaintextCache({ signal = null } = {}) {
  throwIfAborted(signal);
  const entries = [];
  await collectPlaintextCacheEntries(DB_PLAINTEXT_CACHE_ROOT, entries, { signal });
  const now = Date.now();
  const live = [];
  for (const entry of entries) {
    throwIfAborted(signal);
    if (entry.releasing) {
      await settlePlaintextCacheRelease(entry.plain_path, entry.path, { signal }).catch(() => {});
      continue;
    }
    if (entry.temporary) {
      const active = await plaintextCacheTempIsActive(entry.path);
      const stale = now - Number(entry.mtimeMs || 0) >= DB_PLAINTEXT_CACHE_STALE_GRACE_MS;
      if (!active && stale) {
        await assertCopiedDbRealPath(entry.path, { signal }).then(() => fsp.rm(entry.path, { force: true })).catch(() => {});
      }
      continue;
    }
    const releaseEntryLock = await acquirePlaintextCacheEntryLock(entry.path, { signal });
    let retained = false;
    try {
      retained = await activePlaintextCacheLeaseCount(entry.path, { signal }) > 0;
    } finally {
      await releaseEntryLock();
    }
    if (retained) {
      live.push({ ...entry, retained: true });
      continue;
    }
    const expired = now - Number(entry.mtimeMs || 0) > DB_PLAINTEXT_CACHE_TTL_MS;
    if (expired) {
      await removePlaintextCacheEntryIfUnused(entry.path, { signal }).catch(() => {});
      continue;
    }
    live.push(entry);
  }
  live.sort((a, b) => Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0));
  let totalBytes = 0;
  let kept = 0;
  for (const entry of live) {
    totalBytes += Number(entry.size || 0) || 0;
    kept += 1;
    if (entry.retained) continue;
    if (kept > DB_PLAINTEXT_CACHE_MAX_ENTRIES || totalBytes > DB_PLAINTEXT_CACHE_MAX_BYTES) {
      await removePlaintextCacheEntryIfUnused(entry.path, { signal }).catch(() => {});
    }
  }
  await removeEmptyCopiedDbParents(DB_PLAINTEXT_CACHE_ROOT).catch(() => {});
}

let plaintextCachePruneInFlight = false;

function startWeixinV4PlaintextCachePruner() {
  if (process.env.WX_SUMMARY_WXDB_MESSAGE_WORKER === '1') return;
  const timer = setInterval(async () => {
    if (plaintextCachePruneInFlight) return;
    plaintextCachePruneInFlight = true;
    try {
      await pruneWeixinV4PlaintextCache();
    } catch {
      // The next interval or cache access retries cleanup; active leases remain protected.
    } finally {
      plaintextCachePruneInFlight = false;
    }
  }, DB_PLAINTEXT_CACHE_PRUNE_INTERVAL_MS);
  timer.unref?.();
}

startWeixinV4PlaintextCachePruner();

async function collectPlaintextCacheEntries(root, entries, { signal = null } = {}) {
  throwIfAborted(signal);
  await assertSafeTmpPath(path.join(root, 'probe.tmp'), { label: 'plaintext cache root' });
  const stat = await fsp.lstat(root).catch(() => null);
  if (!stat) return;
  if (stat.isSymbolicLink?.()) return;
  if (!stat.isDirectory()) return;
  const children = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const child of children) {
    throwIfAborted(signal);
    const full = path.join(root, child.name);
    assertCopiedDbPath(full);
    if (child.isSymbolicLink?.()) continue;
    if (child.isDirectory()) {
      await collectPlaintextCacheEntries(full, entries, { signal });
      continue;
    }
    if (!child.isFile()) continue;
    const releasingMatch = child.name.match(/^([a-f0-9]{64}\.db)\.\d+\.[a-f0-9]{16}\.[a-f0-9]{8}\.lease\.releasing$/i);
    if (releasingMatch) {
      const marker = await assertSafeTmpPath(full, {
        label: 'plaintext cache releasing marker',
        requireFile: true,
      }).then(safe => safe.resolved).catch(() => '');
      if (!marker) continue;
      const plainPath = path.join(root, releasingMatch[1]);
      assertCopiedDbPath(plainPath);
      entries.push({ path: marker, plain_path: path.resolve(plainPath), releasing: true });
      continue;
    }
    if (!/\.db$|\.tmp$/i.test(child.name)) continue;
    const safe = await assertCopiedDbRealPath(full, { signal }).then(() => full).catch(() => '');
    if (!safe) continue;
    const st = await fsp.stat(safe).catch(() => null);
    if (!st?.isFile()) continue;
    entries.push({
      path: safe,
      size: Number(st.size || 0) || 0,
      mtimeMs: Number(st.mtimeMs || 0) || 0,
      temporary: /\.tmp$/i.test(child.name),
    });
  }
}

function persistableRawKey(raw) {
  const text = String(raw || '').trim().toLowerCase();
  if (/^[a-f0-9]{64}$/.test(text)) return text;
  if (/^[a-f0-9]{96}$/.test(text)) return text;
  if (/^[a-f0-9]{128}$/.test(text)) return text;
  if (/^[a-f0-9]{160}$/.test(text)) return text;
  if (/^[a-f0-9]{192}$/.test(text)) return text;
  return '';
}

function persistableRawKeyForVerifiedCache(raw, { keyKind = '', sourceRaw = '' } = {}) {
  if (String(keyKind || '').trim() === 'passphrase_derived') return persistableRawKey(sourceRaw);
  return persistableRawKey(raw);
}

function rawIncludesWeixinV4PageKey(raw, pageKeyRaw) {
  const key = String(pageKeyRaw || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(key) && weixinV4KeyCandidates([raw]).includes(key);
}

function withVerifiedRawKey(result, raw, { keyKind = '', sourceRaw = '' } = {}) {
  const key = persistableRawKeyForVerifiedCache(raw, { keyKind, sourceRaw });
  if (key && result && typeof result === 'object') {
    Object.defineProperty(result, '__verified_raw_key', {
      value: key,
      enumerable: false,
    });
  }
  return result;
}

function portableWeixinV4VerifiedCandidates(found = {}, saltHex = '') {
  const salt = /^[a-f0-9]{32}$/.test(String(saltHex || '').trim().toLowerCase())
    ? String(saltHex || '').trim().toLowerCase()
    : '';
  const keyKind = String(found?.key_kind || '').trim();
  const source = persistableRawKey(found?.source_raw || '');
  const raw = persistableRawKey(found?.raw || '');
  const key = keyKind === 'passphrase_derived' && source ? source : raw;
  if (!key) return [];
  return uniqueStrings([key, salt ? `${key}${salt}` : '']);
}

async function findWeixinV4PageKeyForCopiedDb(dbPath, rawKeys, options = {}) {
  const signal = options.signal || null;
  throwIfAborted(signal);
  const allowExternalTestDb = options.allow_external_test_db === true;
  await assertCopiedDbRealPath(dbPath, { allow_external_test_db: allowExternalTestDb, signal });
  const page = await readFirstPage(dbPath, { signal, allow_external_test_db: allowExternalTestDb });
  return findWeixinV4PageKeyForPage(page, rawKeys, options);
}

async function findWeixinV4PageKeyForPage(page, rawKeys, options = {}) {
  const signal = options.signal || null;
  const onProgress = typeof options.on_progress === 'function' ? options.on_progress : null;
  throwIfAborted(signal);
  if (!Buffer.isBuffer(page) || page.length < WEIXIN_V4_PAGE_SIZE) return { ok: false, attempts: 0 };
  const salt = page.subarray(0, WEIXIN_V4_SALT_BYTES);
  const candidateKeys = weixinV4KeyCandidates(rawKeys, salt.toString('hex'));
  const deriveLimit = options.derive_passphrase_keys === true
    ? Math.max(0, Math.min(
      Number(options.max_passphrase_derive_candidates || WEIXIN_V4_PASSPHRASE_DERIVE_CANDIDATE_LIMIT) || 0,
      candidateKeys.length,
    ))
    : 0;
  let attempts = 0;
  for (const raw of candidateKeys) {
    throwIfAborted(signal);
    attempts++;
    if (validateWeixinV4PageHmac(page, raw, 1)) return { ok: true, raw, attempts, key_kind: 'enc_key' };
    await maybeYieldKeyValidation(attempts, signal, WEIXIN_V4_PAGE_HMAC_YIELD_EVERY);
  }
  if (deriveLimit > 0) {
    notifyProgress(onProgress, {
      phase: 'passphrase_derive',
      attempted: 0,
      total: deriveLimit,
    });
  }
  let deriveAttempts = 0;
  for (const raw of candidateKeys.slice(0, deriveLimit)) {
    throwIfAborted(signal);
    await maybeYieldKeyValidation(attempts + 1, signal, WEIXIN_V4_PASSPHRASE_YIELD_EVERY);
    const derived = await deriveWeixinV4PassphrasePageKeyAsync(raw, salt, { signal });
    attempts++;
    deriveAttempts++;
    const matched = derived && validateWeixinV4PageHmac(page, derived, 1);
    notifyProgress(onProgress, {
      phase: 'passphrase_derive',
      attempted: deriveAttempts,
      total: deriveLimit,
    });
    if (matched) return { ok: true, raw: derived, source_raw: raw, attempts, key_kind: 'passphrase_derived' };
  }
  return { ok: false, attempts };
}

function weixinV4KeyCandidates(rawKeys, salt = '') {
  const out = [];
  const seen = new Set();
  for (const value of normalizeRawKeyCandidates(rawKeys, salt)) {
    const raw = String(value || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64,160}$/.test(raw)) continue;
    const key = raw.slice(0, 64);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

async function readFirstPage(file, { signal = null, allow_external_test_db = false } = {}) {
  await assertCopiedDbRealPath(file, { allow_external_test_db, signal });
  throwIfAborted(signal);
  const handle = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(WEIXIN_V4_PAGE_SIZE);
    const res = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, res.bytesRead);
  } finally {
    await handle.close();
  }
}

function validateWeixinV4PageHmac(page, keyHex, pageNumber) {
  const material = deriveWeixinV4PageKeys(keyHex, page.subarray(0, WEIXIN_V4_SALT_BYTES));
  return validateWeixinV4PageHmacWithMacKey(page, material.macKey, pageNumber);
}

function validateWeixinV4PageHmacWithMacKey(page, macKey, pageNumber) {
  const hmacRange = weixinV4PageHmacRange(page, pageNumber === 1);
  if (!hmacRange) return false;
  const hmac = crypto.createHmac('sha512', macKey);
  hmac.update(hmacRange.signed);
  const pageNo = Buffer.alloc(4);
  pageNo.writeUInt32LE(pageNumber, 0);
  hmac.update(pageNo);
  return crypto.timingSafeEqual(hmac.digest(), hmacRange.stored);
}

function weixinV4PageHmacRange(page, isFirstPage) {
  if (page.length < WEIXIN_V4_PAGE_SIZE) return null;
  const offset = isFirstPage ? WEIXIN_V4_SALT_BYTES : 0;
  const hmacOffset = WEIXIN_V4_PAGE_SIZE - WEIXIN_V4_HMAC_BYTES;
  const signedEnd = WEIXIN_V4_PAGE_SIZE - WEIXIN_V4_HMAC_BYTES;
  if (offset >= signedEnd || hmacOffset + WEIXIN_V4_HMAC_BYTES > page.length) return null;
  return {
    signed: page.subarray(offset, signedEnd),
    stored: page.subarray(hmacOffset, hmacOffset + WEIXIN_V4_HMAC_BYTES),
  };
}

function deriveWeixinV4PageKeys(keyHex, salt) {
  const key = Buffer.from(keyHex, 'hex');
  const encKey = key;
  const macSalt = Buffer.from(salt.map(byte => byte ^ 0x3a));
  const macKey = crypto.pbkdf2Sync(key, macSalt, 2, WEIXIN_V4_KEY_BYTES, 'sha512');
  return { encKey, macKey };
}

function deriveWeixinV4PassphrasePageKey(keyHex, salt) {
  if (!/^[a-f0-9]{64}$/.test(String(keyHex || '')) || !Buffer.isBuffer(salt) || salt.length !== WEIXIN_V4_SALT_BYTES) return '';
  return crypto.pbkdf2Sync(Buffer.from(keyHex, 'hex'), salt, WEIXIN_V4_KDF_ITER, WEIXIN_V4_KEY_BYTES, 'sha512').toString('hex');
}

async function deriveWeixinV4PassphrasePageKeyAsync(keyHex, salt, { signal = null } = {}) {
  if (!/^[a-f0-9]{64}$/.test(String(keyHex || '')) || !Buffer.isBuffer(salt) || salt.length !== WEIXIN_V4_SALT_BYTES) return '';
  throwIfAborted(signal);
  const key = await pbkdf2Async(Buffer.from(keyHex, 'hex'), salt, WEIXIN_V4_KDF_ITER, WEIXIN_V4_KEY_BYTES, 'sha512');
  throwIfAborted(signal);
  return key.toString('hex');
}

async function decryptWeixinV4DbToPlaintext(dbPath, keyHex, { signal = null, allow_external_test_db = false, onProgress = null, sourceName = '', targetPath = '', page_hmac_prevalidated = false } = {}) {
  throwIfAborted(signal);
  await assertCopiedDbRealPath(dbPath, { allow_external_test_db, signal });
  await assertNoHotCopiedRollbackJournal(dbPath, { signal, allow_external_test_db });
  const st = await fsp.stat(dbPath);
  if (st.size < WEIXIN_V4_PAGE_SIZE) throw new Error('database file is too small for Weixin v4 page decrypt');
  const firstPage = await readFirstPage(dbPath, { signal, allow_external_test_db });
  throwIfAborted(signal);
  if (firstPage.length < WEIXIN_V4_PAGE_SIZE) throw new Error('database file is too small for Weixin v4 page decrypt');
  const salt = firstPage.subarray(0, WEIXIN_V4_SALT_BYTES);
  const material = deriveWeixinV4PageKeys(keyHex, salt);
  const target = targetPath ? path.resolve(targetPath) : `${dbPath}.weixin-v4-plain.db`;
  if (!allow_external_test_db) {
    assertCopiedDbPath(target);
    await assertSafeTmpPath(target, { label: 'plaintext database temp', ensureParent: true });
  } else {
    await ensureDir(path.dirname(target));
  }
  let input = null;
  let output = null;
  const encryptedChunk = Buffer.allocUnsafe(WEIXIN_V4_DECRYPT_CHUNK_BYTES);
  const plaintextChunk = Buffer.allocUnsafe(WEIXIN_V4_DECRYPT_CHUNK_BYTES);
  const sourceLabel = sourceName || path.basename(dbPath);
  const totalSize = Number(st.size || 0) || 0;
  const totalSizeLabel = formatBytes(totalSize) || `${totalSize}B`;
  await assertAvailableDiskSpace(path.dirname(target), totalSize, {
    code: 'wxdb_temp_copy_disk_space_insufficient',
    message: '项目临时目录所在磁盘可用空间不足，无法安全生成数据库临时读取数据。请清理磁盘空间后重试。',
  });
  const progressDetail = (bytes) => {
    const done = Math.max(0, Number(bytes || 0) || 0);
    const pct = totalSize > 0 ? Math.max(0, Math.min(99, Math.floor((done / totalSize) * 100))) : 0;
    return `${sourceLabel}：已处理 ${formatBytes(done) || `${done}B`}/${totalSizeLabel}${pct ? `（${pct}%）` : ''}`;
  };
  let lastProgressAt = 0;
  let position = 0;
  let pageNumber = 1;
  let plaintextWritten = false;
  notifyProgress(onProgress, {
    phase: 'fetch_shard_decrypt_plain_start',
    label: '拉取消息 · 兼容读取消息库',
    detail: `${sourceLabel}：${totalSizeLabel}，正在逐页准备临时读取数据`,
  });
  try {
    input = await fsp.open(dbPath, 'r');
    output = await fsp.open(target, 'wx', 0o600);
    const fullPageBytes = Math.floor(st.size / WEIXIN_V4_PAGE_SIZE) * WEIXIN_V4_PAGE_SIZE;
    while (position < fullPageBytes) {
      throwIfAborted(signal);
      const chunkBytes = Math.min(WEIXIN_V4_DECRYPT_CHUNK_BYTES, fullPageBytes - position);
      const bytesRead = await readExactly(input, encryptedChunk, 0, chunkBytes, position);
      if (bytesRead !== chunkBytes) throw new Error('database file changed while decrypting');
      for (let chunkOffset = 0; chunkOffset < chunkBytes; chunkOffset += WEIXIN_V4_PAGE_SIZE) {
        const encryptedPage = encryptedChunk.subarray(chunkOffset, chunkOffset + WEIXIN_V4_PAGE_SIZE);
        decryptWeixinV4PageInto(encryptedPage, material, pageNumber, plaintextChunk, chunkOffset);
        pageNumber++;
      }
      const bytesWritten = await writeExactly(output, plaintextChunk, 0, chunkBytes, position);
      if (bytesWritten !== chunkBytes) throw new Error('failed to write decrypted database chunk');
      position += chunkBytes;
      if (position - lastProgressAt >= WEIXIN_V4_DECRYPT_PROGRESS_BYTES) {
        lastProgressAt = position;
        notifyProgress(onProgress, {
          phase: 'fetch_shard_decrypt_plain_progress',
          label: '拉取消息 · 兼容读取消息库',
          detail: progressDetail(position),
        });
        await yieldDecryptProgress(signal);
      }
    }
    const remainderBytes = st.size - position;
    if (remainderBytes > 0) {
      throwIfAborted(signal);
      const remainder = Buffer.allocUnsafe(remainderBytes);
      const bytesRead = await readExactly(input, remainder, 0, remainderBytes, position);
      if (bytesRead !== remainderBytes) throw new Error('database file changed while decrypting');
      const bytesWritten = await writeExactly(output, remainder, 0, remainder.length, position);
      if (bytesWritten !== remainder.length) throw new Error('failed to write decrypted database remainder');
      position += remainderBytes;
    }
    plaintextWritten = true;
  } catch (e) {
    if (isDiskSpaceError(e)) throw dbTempCopyDiskSpaceError(e, dbPath, path.basename(path.dirname(dbPath)));
    if (page_hmac_prevalidated && isWeixinV4PageHmacMismatch(e)) {
      throw dbTempCopyError('wxdb_temp_copy_page_integrity_failed', '微信数据库临时读取数据在密钥已通过第一页验证后仍有后续页面完整性校验失败；这表示副本不完整或代次不一致，不是密钥错误。已停止读取，请重新检查本地数据后重试。', {
        source: dbPath,
        category: path.basename(path.dirname(dbPath)),
        cause: `page_${Math.max(1, Number(e?.page_number || pageNumber || 1) || 1)}_hmac_mismatch_after_key_prevalidation`,
      });
    }
    throw e;
  } finally {
    await input?.close().catch(() => {});
    await output?.close().catch(() => {});
    if (!plaintextWritten) {
      if (allow_external_test_db) await fsp.rm(target, { force: true }).catch(() => {});
      else await assertCopiedDbRealPath(target).then(() => fsp.rm(target, { force: true })).catch(() => {});
    }
  }
  try {
    await mergeWeixinV4WalIntoPlaintext(dbPath, target, material, { signal, allow_external_test_db });
  } catch (e) {
    if (allow_external_test_db) await fsp.rm(target, { force: true }).catch(() => {});
    else await assertCopiedDbRealPath(target, { signal }).then(() => fsp.rm(target, { force: true })).catch(() => {});
    throw e;
  }
  notifyProgress(onProgress, {
    phase: 'fetch_shard_decrypt_plain_done',
    label: '拉取消息 · 消息库已准备好',
    detail: `${sourceLabel}：已处理 ${formatBytes(position) || `${position}B`}/${totalSizeLabel}（100%）`,
  });
  return target;
}

async function assertNoHotCopiedRollbackJournal(dbPath, { signal = null, allow_external_test_db = false } = {}) {
  throwIfAborted(signal);
  const journalPath = `${dbPath}-journal`;
  let st = null;
  try {
    st = await fsp.lstat(journalPath);
  } catch (e) {
    if (isMissingFileError(e)) return;
    throw dbTempCopyError('wxdb_temp_copy_journal_unreadable', '微信数据库回滚日志临时读取数据不可读，已停止读取以避免使用未确认事务。请稍后重试。', {
      source: journalPath,
      category: path.basename(path.dirname(dbPath)),
      cause: transientDbCopyErrorCause(e),
    });
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw dbTempCopyError('wxdb_temp_copy_journal_unreadable', '微信数据库回滚日志临时读取数据不是普通文件，已停止读取以避免使用未确认事务。请重新检查本地数据后重试。', {
      source: journalPath,
      category: path.basename(path.dirname(dbPath)),
      cause: st.isSymbolicLink() ? 'copied_journal_symlink' : 'copied_journal_not_regular',
    });
  }
  if (st.size < SQLITE_ROLLBACK_JOURNAL_MIN_HOT_BYTES) return;
  await assertCopiedDbRealPath(journalPath, { allow_external_test_db, signal });
  const handle = await fsp.open(journalPath, 'r');
  const header = Buffer.alloc(SQLITE_ROLLBACK_JOURNAL_MAGIC.length);
  try {
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length) return;
  } finally {
    await handle.close().catch(() => {});
  }
  throwIfAborted(signal);
  if (!header.equals(SQLITE_ROLLBACK_JOURNAL_MAGIC)) return;
  throw dbTempCopyError('wxdb_temp_copy_hot_rollback_journal', '微信数据库副本包含尚未完成恢复的回滚日志；为避免读取未提交或不一致的数据，本次已停止。请等待微信同步完成后重试自动准备本地工作数据。', {
    source: journalPath,
    category: path.basename(path.dirname(dbPath)),
    cause: 'hot_rollback_journal',
  });
}

async function readExactly(handle, buffer, offset, length, position) {
  let total = 0;
  while (total < length) {
    const res = await handle.read(buffer, offset + total, length - total, position + total);
    if (!res.bytesRead) break;
    total += res.bytesRead;
  }
  return total;
}

async function writeExactly(handle, buffer, offset, length, position) {
  let total = 0;
  while (total < length) {
    const res = await handle.write(buffer, offset + total, length - total, position + total);
    if (!res.bytesWritten) break;
    total += res.bytesWritten;
  }
  return total;
}

async function mergeWeixinV4WalIntoPlaintext(dbPath, plainPath, material, { signal = null, allow_external_test_db = false } = {}) {
  throwIfAborted(signal);
  await assertCopiedDbRealPath(dbPath, { allow_external_test_db, signal });
  await assertCopiedDbRealPath(plainPath, { allow_external_test_db, signal });
  const walPath = `${dbPath}-wal`;
  let st = null;
  try {
    st = await fsp.lstat(walPath);
  } catch (e) {
    if (isMissingFileError(e)) return null;
    throw dbTempCopyError('wxdb_temp_copy_wal_unreadable', '微信数据库 WAL 临时读取数据不可读，已停止合并增量以避免漏掉最新消息。请稍后重试。', {
      source: walPath,
      category: path.basename(path.dirname(dbPath)),
      cause: transientDbCopyErrorCause(e),
    });
  }
  throwIfAborted(signal);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw dbTempCopyError('wxdb_temp_copy_wal_unreadable', '微信数据库 WAL 临时读取数据不是普通文件，已停止合并增量以避免漏掉最新消息。请重新检查本地数据后重试。', {
      source: walPath,
      category: path.basename(path.dirname(dbPath)),
      cause: st.isSymbolicLink() ? 'copied_wal_symlink' : 'copied_wal_not_regular',
    });
  }
  if (st.size === 0) return null;
  await assertCopiedDbRealPath(walPath, { allow_external_test_db, signal });
  const invalidWal = (cause, detail) => dbTempCopyError(
    'wxdb_temp_copy_wal_invalid',
    `微信数据库 WAL 临时读取数据${detail}，已停止读取以避免漏掉最新消息。请重新检查本地数据后重试。`,
    {
      source: walPath,
      category: path.basename(path.dirname(dbPath)),
      cause,
    },
  );
  if (st.size < 32) return null;

  const input = await fsp.open(walPath, 'r');
  let output = null;
  try {
    const header = Buffer.alloc(32);
    const headerBytes = await readExactly(input, header, 0, header.length, 0);
    if (headerBytes !== header.length) throw invalidWal('wal_header_short_read', '头部读取不完整');
    const magic = header.readUInt32BE(0);
    if (magic !== 0x377f0682 && magic !== 0x377f0683) throw invalidWal('wal_magic_invalid', '格式无效');
    const pageSize = header.readUInt32BE(8);
    if (pageSize !== WEIXIN_V4_PAGE_SIZE) {
      throw invalidWal('wal_page_size_invalid', `页大小 ${pageSize || 'unknown'} 不受支持`);
    }
    const checksumLittleEndian = magic === 0x377f0682;
    const salt1 = header.readUInt32BE(16);
    const salt2 = header.readUInt32BE(20);
    let checksum = walChecksum(header.subarray(0, 24), checksumLittleEndian);
    if (header.readUInt32BE(24) !== checksum[0] || header.readUInt32BE(28) !== checksum[1]) {
      throw invalidWal('wal_header_checksum_invalid', '头部校验失败');
    }

    const frameSize = 24 + pageSize;
    const frameBytes = st.size - header.length;
    const trailingBytes = frameBytes % frameSize;
    const frameCount = Math.floor(frameBytes / frameSize);
    if (frameCount <= 0) return null;

    const frameHeader = Buffer.alloc(24);
    const encryptedPage = Buffer.allocUnsafe(pageSize);
    const frames = [];
    let lastCommitIndex = -1;
    let lastCommitDbPages = 0;
    for (let i = 0; i < frameCount; i++) {
      throwIfAborted(signal);
      const frameOffset = header.length + i * frameSize;
      const read = await readExactly(input, frameHeader, 0, frameHeader.length, frameOffset);
      if (read !== frameHeader.length) throw invalidWal('wal_frame_header_short_read', '帧头读取不完整');
      const pageNumber = frameHeader.readUInt32BE(0);
      const commitDbPages = frameHeader.readUInt32BE(4);
      if (frameHeader.readUInt32BE(8) !== salt1 || frameHeader.readUInt32BE(12) !== salt2) break;
      const pageRead = await readExactly(input, encryptedPage, 0, pageSize, frameOffset + frameHeader.length);
      if (pageRead !== pageSize) throw invalidWal('wal_frame_page_short_read', '帧页面读取不完整');
      const nextChecksum = walChecksum(frameHeader.subarray(0, 8), checksumLittleEndian, [...checksum]);
      walChecksum(encryptedPage, checksumLittleEndian, nextChecksum);
      if (frameHeader.readUInt32BE(16) !== nextChecksum[0] || frameHeader.readUInt32BE(20) !== nextChecksum[1]) break;
      checksum = nextChecksum;
      if (pageNumber < 1) throw invalidWal('wal_page_number_invalid', '包含非法页号');
      frames.push({
        pageNumber,
        commitDbPages,
        pageOffset: frameOffset + frameHeader.length,
      });
      if (commitDbPages > 0) {
        lastCommitIndex = frames.length - 1;
        lastCommitDbPages = commitDbPages;
      }
    }
    if (lastCommitIndex < 0) return null;

    output = await fsp.open(plainPath, 'r+');
    for (const frame of frames.slice(0, lastCommitIndex + 1)) {
      throwIfAborted(signal);
      const read = await readExactly(input, encryptedPage, 0, pageSize, frame.pageOffset);
      if (read !== pageSize) throw invalidWal('wal_committed_page_short_read', '已提交帧读取不完整');
      let plainPage;
      try {
        plainPage = decryptWeixinV4Page(encryptedPage, material, frame.pageNumber);
      } catch (e) {
        if (isWeixinV4PageHmacMismatch(e)) {
          throw invalidWal('wal_committed_page_hmac_mismatch', `已提交帧第 ${frame.pageNumber} 页完整性校验失败`);
        }
        throw e;
      }
      const written = await writeExactly(output, plainPage, 0, plainPage.length, (frame.pageNumber - 1) * pageSize);
      if (written !== plainPage.length) throw invalidWal('wal_committed_page_short_write', '已提交帧写入不完整');
    }
    if (lastCommitDbPages > 0) {
      await output.truncate(lastCommitDbPages * pageSize);
    }
    return {
      frame_count: frameCount,
      committed_frame_count: lastCommitIndex + 1,
      commit_db_pages: lastCommitDbPages,
      trailing_bytes_ignored: trailingBytes,
    };
  } catch (e) {
    if (e?.status === 499 || signal?.aborted) throw e;
    if (String(e?.code || '').startsWith('wxdb_temp_copy_wal_')) throw e;
    if (isDiskSpaceError(e)) throw dbTempCopyDiskSpaceError(e, dbPath, path.basename(path.dirname(dbPath)));
    throw new Error(`合并微信数据库 WAL 增量失败：${e?.message || e}`);
  } finally {
    await input.close().catch(() => {});
    await output?.close().catch(() => {});
  }
}

function walChecksum(buffer, littleEndian, checksum = [0, 0]) {
  let s0 = checksum[0] >>> 0;
  let s1 = checksum[1] >>> 0;
  const readUInt32 = littleEndian ? Buffer.prototype.readUInt32LE : Buffer.prototype.readUInt32BE;
  for (let i = 0; i + 7 < buffer.length; i += 8) {
    s0 = (s0 + readUInt32.call(buffer, i) + s1) >>> 0;
    s1 = (s1 + readUInt32.call(buffer, i + 4) + s0) >>> 0;
  }
  checksum[0] = s0;
  checksum[1] = s1;
  return checksum;
}

function decryptWeixinV4Page(page, material, pageNumber) {
  const output = Buffer.allocUnsafe(WEIXIN_V4_PAGE_SIZE);
  decryptWeixinV4PageInto(page, material, pageNumber, output, 0);
  return output;
}

function isWeixinV4PageHmacMismatch(error = null) {
  return String(error?.code || '') === 'wxdb_page_hmac_mismatch'
    || /Weixin v4 page hmac mismatch/i.test(String(error?.message || error || ''));
}

function decryptWeixinV4PageInto(page, material, pageNumber, output, outputOffset = 0) {
  if (page.equals(WEIXIN_V4_ZERO_PAGE)) {
    WEIXIN_V4_ZERO_PAGE.copy(output, outputOffset);
    return;
  }
  if (!validateWeixinV4PageHmacWithMacKey(page, material.macKey, pageNumber)) {
    throw Object.assign(new Error('Weixin v4 page hmac mismatch'), {
      code: 'wxdb_page_hmac_mismatch',
      page_number: Math.max(1, Number(pageNumber || 1) || 1),
    });
  }
  const offset = pageNumber === 1 ? WEIXIN_V4_SALT_BYTES : 0;
  const cipherEnd = WEIXIN_V4_PAGE_SIZE - WEIXIN_V4_RESERVED_BYTES;
  const iv = page.subarray(cipherEnd, cipherEnd + WEIXIN_V4_IV_BYTES);
  const encrypted = page.subarray(offset, cipherEnd);
  const decipher = crypto.createDecipheriv('aes-256-cbc', material.encKey, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const expectedBytes = cipherEnd - offset;
  if (decrypted.length !== expectedBytes) throw new Error('Weixin v4 page decrypt returned an unexpected size');
  if (pageNumber === 1) SQLITE_HEADER.copy(output, outputOffset);
  decrypted.copy(output, outputOffset + (pageNumber === 1 ? SQLITE_HEADER.length : 0));
  output.fill(0, outputOffset + cipherEnd, outputOffset + WEIXIN_V4_PAGE_SIZE);
}

function silenceSqlCipherNoise(db) {
  for (const pragma of ['cipher_log = off', 'cipher_log_level = NONE']) {
    try { db.pragma(pragma); } catch {}
  }
}

function applySqlCipherKeyProfile(db, raw, profile = SQLCIPHER_KEY_PROFILES[0]) {
  silenceSqlCipherNoise(db);
  for (const pragma of profile.before_key || []) {
    try { db.pragma(pragma); } catch {}
  }
  db.pragma(`key = "x'${raw}'"`);
  for (const pragma of profile.after_key || []) {
    try { db.pragma(pragma); } catch {}
  }
}

function orderedRawKeyCandidates(rawKeys, salt = '') {
  const groups = (rawKeys || [])
    .map(raw => {
      const normalized = normalizeRawKeyCandidates([raw], salt);
      return [
        ...normalized.filter(candidate => rawKeySalt(candidate) === salt),
        ...normalized.filter(candidate => rawKeySalt(candidate) !== salt),
      ];
    })
    .filter(group => group.length > 0);
  const ordered = [];
  const seen = new Set();
  const append = candidate => {
    if (!candidate || seen.has(candidate)) return false;
    seen.add(candidate);
    ordered.push(candidate);
    return true;
  };

  // Each reserved raw source gets one real compatibility attempt before a
  // 96/160/192-character candidate can contribute its remaining expansions.
  for (const group of groups.slice(0, SQLCIPHER_PROFILE_FALLBACK_PRIORITY_MAX_KEYS)) {
    for (const candidate of group) {
      if (append(candidate)) break;
    }
  }
  for (const currentSalt of [true, false]) {
    for (const group of groups) {
      for (const candidate of group) {
        if ((rawKeySalt(candidate) === salt) === currentSalt) append(candidate);
      }
    }
  }
  return ordered;
}

function rawKeySalt(raw) {
  const text = String(raw || '').toLowerCase();
  if (/^[a-f0-9]{160}$/.test(text)) return text.slice(128);
  if (/^[a-f0-9]{96}$/.test(text)) return text.slice(64);
  return '';
}

function sqlCipherValidationAttempts(orderedKeys, { fallback_profiles = true } = {}) {
  const defaultProfile = SQLCIPHER_KEY_PROFILES[0];
  const extraProfiles = SQLCIPHER_KEY_PROFILES.slice(1);
  const attempts = orderedKeys
    .slice(0, sqlCipherDefaultProfileLimit({ fallback_profiles }))
    .map(raw => ({ raw, profile: defaultProfile }));
  if (fallback_profiles === false) return attempts.slice(0, SQLCIPHER_VALIDATION_MAX_ATTEMPTS);
  for (const profile of extraProfiles) {
    const priorityCount = sqlCipherProfileFallbackLimit(profile);
    for (const raw of orderedKeys.slice(0, priorityCount)) attempts.push({ raw, profile });
  }
  return attempts.slice(0, SQLCIPHER_VALIDATION_MAX_ATTEMPTS);
}

function sqlCipherDefaultProfileLimit({ fallback_profiles = true } = {}) {
  if (fallback_profiles === false) return Math.min(SQLCIPHER_DEFAULT_PROFILE_MAX_KEYS, SQLCIPHER_VALIDATION_MAX_ATTEMPTS);
  const reservedCompatibilityAttempts = SQLCIPHER_KEY_PROFILES
    .slice(1)
    .reduce((sum, profile) => sum + sqlCipherProfileFallbackLimit(profile), 0);
  return Math.max(0, Math.min(
    SQLCIPHER_DEFAULT_PROFILE_MAX_KEYS,
    SQLCIPHER_VALIDATION_MAX_ATTEMPTS - reservedCompatibilityAttempts,
  ));
}

function sqlCipherProfileFallbackLimit(profile = {}) {
  const n = Number(profile.fallback_key_priority || 0);
  if (Number.isFinite(n) && n > 0) return Math.min(Math.floor(n), SQLCIPHER_PROFILE_FALLBACK_PRIORITY_MAX_KEYS);
  return SQLCIPHER_PROFILE_FALLBACK_PRIORITY_MAX_KEYS;
}

function sqlCipherProfileFallbackLimits() {
  return Object.fromEntries(SQLCIPHER_KEY_PROFILES.slice(1).map(profile => [profile.id, sqlCipherProfileFallbackLimit(profile)]));
}

function sqlCipherProfileFallbackOmissionStats(candidateCount = 0, { fallback_profiles = true } = {}) {
  const total = Math.max(0, Number(candidateCount || 0) || 0);
  if (total <= 0) return { omitted_candidate_count: 0, profile_count: 0 };
  const defaultOmitted = Math.max(0, total - sqlCipherDefaultProfileLimit({ fallback_profiles }));
  if (fallback_profiles === false) return { omitted_candidate_count: defaultOmitted, profile_count: 1 };
  const limits = Object.values(sqlCipherProfileFallbackLimits());
  return {
    omitted_candidate_count: defaultOmitted + limits.reduce((sum, limit) => sum + Math.max(0, total - limit), 0),
    profile_count: limits.length + 1,
  };
}

function normalizeRawKeyCandidates(rawKeys, salt = '') {
  const out = [];
  const seen = new Set();
  const add = (value) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };
  for (const value of rawKeys || []) {
    const raw = String(value || '').trim().toLowerCase();
    if (/^[a-f0-9]{192}$/.test(raw)) {
      const keyAndHmac = raw.slice(0, 128);
      const keyHalf = raw.slice(0, 64);
      const embeddedSalt = raw.slice(-32);
      add(`${keyAndHmac}${embeddedSalt}`);
      if (/^[a-f0-9]{32}$/.test(salt)) add(`${keyAndHmac}${salt}`);
      add(`${keyHalf}${embeddedSalt}`);
      if (/^[a-f0-9]{32}$/.test(salt)) add(`${keyHalf}${salt}`);
      add(keyHalf);
    } else if (/^[a-f0-9]{160}$/.test(raw)) {
      add(raw);
      const keyAndHmac = raw.slice(0, 128);
      const keyHalf = raw.slice(0, 64);
      if (/^[a-f0-9]{32}$/.test(salt)) add(`${keyAndHmac}${salt}`);
      add(`${keyHalf}${raw.slice(128)}`);
      if (/^[a-f0-9]{32}$/.test(salt)) add(`${keyHalf}${salt}`);
      add(keyHalf);
    } else if (/^[a-f0-9]{128}$/.test(raw)) {
      if (/^[a-f0-9]{32}$/.test(salt)) add(`${raw}${salt}`);
      const keyHalf = raw.slice(0, 64);
      if (/^[a-f0-9]{32}$/.test(salt)) add(`${keyHalf}${salt}`);
      add(keyHalf);
    } else if (/^[a-f0-9]{96}$/.test(raw)) {
      add(raw);
      const keyHalf = raw.slice(0, 64);
      if (/^[a-f0-9]{32}$/.test(salt)) add(`${keyHalf}${salt}`);
      add(keyHalf);
    } else if (/^[a-f0-9]{64}$/.test(raw)) {
      if (/^[a-f0-9]{32}$/.test(salt)) add(`${raw}${salt}`);
      add(raw);
    }
  }
  return out;
}

async function removeCopiedDb(targetPath) {
  assertCopiedDbPath(targetPath);
  const tempRoot = path.dirname(path.dirname(targetPath));
  await assertSafeTmpPath(path.join(tempRoot, 'cleanup.marker'), { label: 'database temporary copy root', ensureParent: true });
  await rmWithRetry(tempRoot);
  await removeEmptyCopiedDbParents(tempRoot);
}

async function closeCopiedDb(targetPath, db, plainPath = '', { keepPlain = false, plainLease = '' } = {}) {
  try { db?.close(); } catch {}
  await releaseWeixinV4PlaintextCache(plainPath, plainLease, {
    retainForWorkerSession: keepPlain,
  });
  if (plainPath && !keepPlain) {
    await removePlaintextCacheEntryIfUnused(plainPath).catch(() => {});
  }
  return removeCopiedDb(targetPath);
}

async function closeCopiedDbHandle(handle) {
  if (!handle || typeof handle.close !== 'function') return;
  try {
    await handle.close();
  } catch {}
}

async function rmWithRetry(target) {
  await assertSafeTmpPath(path.join(target, 'cleanup.marker'), { label: 'database temporary copy root', ensureParent: true });
  for (let i = 0; i < 8; i++) {
    await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
    const stillThere = await exists(target);
    if (!stillThere) return;
    await new Promise(resolve => setTimeout(resolve, 50 * (i + 1)));
  }
  throw new Error(`failed to remove temporary database copy: ${path.basename(target)}`);
}

async function removeEmptyCopiedDbParents(tempRoot) {
  const dbRoot = DB_COPY_ROOT;
  let current = path.dirname(tempRoot);
  while (isInside(dbRoot, current) && path.resolve(current) !== path.resolve(WXDB_TMP_DIR)) {
    try {
      await assertSafeTmpPath(path.join(current, 'cleanup.marker'), { label: 'database temporary copy parent', ensureParent: true });
      await fsp.rmdir(current);
    } catch {
      return;
    }
    if (path.resolve(current) === path.resolve(dbRoot)) return;
    current = path.dirname(current);
  }
}

function nonNegativeIntegerBigInt(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  try { return BigInt(text); } catch { return null; }
}

function normalizeWxTimestamp(value) {
  if (!value) return 0;
  const integer = nonNegativeIntegerBigInt(value);
  if (integer !== null) {
    if (integer >= 10_000_000_000_000_000n) return Number(integer / 1_000_000n);
    if (integer >= 10_000_000_000_000n) return Number(integer / 1_000n);
    return Number(integer > 10_000_000_000n ? integer : integer * 1_000n);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n >= 10_000_000_000_000_000) return Math.floor(n / 1_000_000);
  if (n >= 10_000_000_000_000) return Math.floor(n / 1000);
  return n > 10_000_000_000 ? n : n * 1000;
}

function normalizeWxSortSeqTimestamp(value, timeBounds = {}) {
  const direct = normalizeWxTimestamp(value);
  if (messageTimestampInBounds(direct, timeBounds)) return direct;
  const packed = normalizePackedSortSeqTimestamp(value, timeBounds);
  return packed;
}

function normalizePackedSortSeqTimestamp(value, timeBounds = {}) {
  const n = nonNegativeIntegerBigInt(value);
  if (n === null || n <= 0n) return 0;
  for (const factor of SORT_SEQ_PACKED_MS_FACTORS) {
    const timestamp = Number(n / BigInt(factor));
    if (messageTimestampInBounds(timestamp, timeBounds)) return timestamp;
  }
  for (const factor of SORT_SEQ_PACKED_SECOND_FACTORS) {
    const timestamp = Number(n / BigInt(factor)) * 1000;
    if (messageTimestampInBounds(timestamp, timeBounds)) return timestamp;
  }
  return 0;
}

function messageTimestampInBounds(timestamp, timeBounds = {}) {
  const value = Number(timestamp || 0);
  if (!Number.isFinite(value) || value <= 0) return false;
  const since = Number(timeBounds.since_ms || 0);
  const until = Number(timeBounds.until_ms || 0);
  if (!since && !until) return true;
  return value >= since && (!until || value <= until);
}

function toUnixSeconds(value, fallback, label = '时间', { endOfMinuteWhenSecondsMissing = false } = {}) {
  const text = String(value || '').trim();
  if (!text || text === 'now') return fallback;
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    throw Object.assign(new Error(`${label}格式无效，请使用 YYYY-MM-DD HH:mm 或 YYYY-MM-DD HH:mm:ss。`), { status: 400, code: 'time_format_invalid', public_code: 'time_format_invalid' });
  }
  const [, y, mo, d, h, mi, rawSeconds] = match;
  const s = rawSeconds ?? (endOfMinuteWhenSecondsMissing ? '59' : '0');
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), 0);
  const valid = date.getFullYear() === Number(y)
    && date.getMonth() === Number(mo) - 1
    && date.getDate() === Number(d)
    && date.getHours() === Number(h)
    && date.getMinutes() === Number(mi)
    && date.getSeconds() === Number(s);
  if (!valid) {
    throw Object.assign(new Error(`${label}格式无效，请使用真实存在的日期时间。`), { status: 400, code: 'time_value_invalid', public_code: 'time_value_invalid' });
  }
  return Math.floor(date.getTime() / 1000);
}

function toEpochMs(value, label = '时间') {
  const epochMs = Number(value);
  if (!Number.isSafeInteger(epochMs) || epochMs < Date.UTC(2000, 0, 1) || epochMs > Date.UTC(2200, 0, 1)) {
    throw Object.assign(new Error(`${label}时间戳无效。`), { status: 400, code: 'time_epoch_invalid', public_code: 'time_epoch_invalid' });
  }
  return epochMs;
}

function toUnixSecondsFromEpochMs(value, label = '时间') {
  return Math.floor(toEpochMs(value, label) / 1000);
}

function messageTimeBounds(sinceSeconds, untilSeconds, { since_ms = null, until_ms = null } = {}) {
  const since = Number(sinceSeconds || 0);
  const until = Number(untilSeconds || 0);
  const sinceMs = since_ms === null || since_ms === undefined || since_ms === ''
    ? since * 1000
    : Number(since_ms);
  const untilMs = until_ms === null || until_ms === undefined || until_ms === ''
    ? until * 1000 + 999
    : Number(until_ms);
  const sinceNs = BigInt(Math.trunc(since)) * 1_000_000_000n;
  const exactSinceNs = BigInt(Math.trunc(sinceMs)) * 1_000_000n;
  const exactUntilNs = BigInt(Math.trunc(untilMs)) * 1_000_000n + 999_999n;
  return {
    since_s: since,
    until_s: until,
    since_ms: sinceMs,
    until_ms: untilMs,
    since_us: sinceMs * 1_000,
    until_us: untilMs * 1_000 + 999,
    since_ns: (since_ms === null || since_ms === undefined || since_ms === '' ? sinceNs : exactSinceNs).toString(),
    until_ns: (until_ms === null || until_ms === undefined || until_ms === '' ? BigInt(Math.trunc(until)) * 1_000_000_000n + 999_999_999n : exactUntilNs).toString(),
  };
}

function formatMessageTime(value) {
  const timestamp = normalizeWxTimestamp(value);
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

function normalizeMessageContent(value, localType, extra = {}) {
  const decoded = decodeMessagePayload(value);
  const split = splitSenderPrefix(decoded);
  const fallbackDecoded = decodeMessagePayload(extra.compress_content);
  const fallbackSplit = splitSenderPrefix(fallbackDecoded);
  const body = split.body.trim() || fallbackSplit.body.trim();
  const sender = split.sender || fallbackSplit.sender;
  const typeCode = baseLocalType(localType);

  if (typeCode === 1 && body) {
    return { type: 'text', sender, content: body || '[空文本]' };
  }
  if (typeCode === 3) {
    const media = parseImageMedia(body, extra.packed_info_data);
    return { type: 'image', sender, content: formatImageContent(media), media };
  }
  if (typeCode === 34) {
    const media = parseVoiceMedia(body, extra.packed_info_data);
    return { type: 'voice', sender, content: formatVoiceContent(media), media };
  }
  if (typeCode === 43) {
    const media = parseVideoMedia(body, extra.packed_info_data);
    return { type: 'video', sender, content: formatVideoContent(media), media };
  }
  if (typeCode === 47) {
    const media = parseEmojiMedia(body);
    return { type: 'emoji', sender, content: formatEmojiContent(media), media };
  }
  if (typeCode === 49) {
    const parsed = parseAppMessage(body, extra.packed_info_data);
    return { type: parsed.type, sender, content: parsed.content, media: parsed.media };
  }
  if (typeCode === 10000) {
    const content = extractTag(body, 'content') || body.replace(/<[^>]+>/g, '').trim();
    return { type: 'system', sender, content: content || '[系统消息]' };
  }
  if (body) return { type: 'other', sender, content: body.slice(0, 1000) };
  return { type: 'other', sender, content: `[非文本消息 type=${Number(localType || 0)}]` };
}

function decodeMessagePayload(value) {
  if (typeof value === 'string') return value;
  if (!Buffer.isBuffer(value)) return '';
  let buf = value;
  if (buf.length >= 4 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd && typeof zlib.zstdDecompressSync === 'function') {
    if (buf.length > MESSAGE_ZSTD_MAX_INPUT_BYTES) {
      return '[压缩消息过大，已跳过内容解码]';
    }
    try {
      buf = zlib.zstdDecompressSync(buf, { maxOutputLength: MESSAGE_ZSTD_MAX_OUTPUT_BYTES });
    } catch {
      return '[压缩消息无法解码或解压后内容过大]';
    }
  }
  return cleanDecodedString(buf.toString('utf-8'));
}

function cleanDecodedString(text) {
  return String(text || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
}

function splitSenderPrefix(text) {
  const value = String(text || '');
  const splitAt = value.indexOf(':\n');
  if (splitAt > 0 && splitAt < 100) {
    return { sender: value.slice(0, splitAt).trim(), body: value.slice(splitAt + 2) };
  }
  return { sender: '', body: value };
}

function baseLocalType(localType) {
  const n = BigInt(Math.trunc(Number(localType || 0)));
  return Number(n & 0xffffffffn);
}

function parseImageMedia(xml, packedInfoData) {
  const media = {
    kind: 'image',
    md5: xmlAttr(xml, 'img', 'md5'),
    size: numberAttr(xml, 'img', 'length') || numberAttr(xml, 'img', 'hdlength') || numberAttr(xml, 'img', 'hevc_mid_size'),
    width: firstNumber([
      xmlAttr(xml, 'img', 'width'),
      xmlAttr(xml, 'img', 'cdnmidwidth'),
      xmlAttr(xml, 'img', 'cdnhdwidth'),
      xmlAttr(xml, 'img', 'cdnthumbwidth'),
    ]),
    height: firstNumber([
      xmlAttr(xml, 'img', 'height'),
      xmlAttr(xml, 'img', 'cdnmidheight'),
      xmlAttr(xml, 'img', 'cdnhdheight'),
      xmlAttr(xml, 'img', 'cdnthumbheight'),
    ]),
    file_key: firstHex(decodeMessagePayload(packedInfoData), 32, { requireBoundary: false }),
  };
  return compactObject(media);
}

function parseVoiceMedia(xml, packedInfoData) {
  const media = {
    kind: 'voice',
    md5: xmlAttr(xml, 'voicemsg', 'md5') || extractTag(xml, 'md5'),
    file_name: decodeXmlEntities(xmlAttr(xml, 'voicemsg', 'filename') || extractTag(xml, 'filename')),
    duration_ms: firstNumber([
      xmlAttr(xml, 'voicemsg', 'voicelength'),
      xmlAttr(xml, 'voicemsg', 'length'),
      extractTag(xml, 'voicelength'),
    ]),
    size: firstNumber([
      xmlAttr(xml, 'voicemsg', 'bufsize'),
      xmlAttr(xml, 'voicemsg', 'length'),
      extractTag(xml, 'bufsize'),
    ]),
    format: decodeXmlEntities(xmlAttr(xml, 'voicemsg', 'voiceformat') || extractTag(xml, 'voiceformat')),
    file_key: firstHex(decodeMessagePayload(packedInfoData), 32, { requireBoundary: false }),
  };
  return compactObject(media);
}

function parseVideoMedia(xml, packedInfoData) {
  const media = {
    kind: 'video',
    md5: xmlAttr(xml, 'videomsg', 'md5') || extractTag(xml, 'md5'),
    file_name: decodeXmlEntities(xmlAttr(xml, 'videomsg', 'filename') || extractTag(xml, 'filename')),
    size: firstNumber([
      xmlAttr(xml, 'videomsg', 'length'),
      xmlAttr(xml, 'videomsg', 'rawlength'),
      extractTag(xml, 'length'),
    ]),
    duration_s: firstNumber([
      xmlAttr(xml, 'videomsg', 'playlength'),
      extractTag(xml, 'playlength'),
    ]),
    width: firstNumber([xmlAttr(xml, 'videomsg', 'width'), extractTag(xml, 'width')]),
    height: firstNumber([xmlAttr(xml, 'videomsg', 'height'), extractTag(xml, 'height')]),
    url: decodeXmlEntities(xmlAttr(xml, 'videomsg', 'cdnvideourl') || extractTag(xml, 'cdnvideourl')),
    file_key: firstHex(decodeMessagePayload(packedInfoData), 32, { requireBoundary: false }),
  };
  return compactObject(media);
}

function parseEmojiMedia(xml) {
  return compactObject({
    kind: 'emoji',
    md5: xmlAttr(xml, 'emoji', 'md5'),
    width: numberAttr(xml, 'emoji', 'width'),
    height: numberAttr(xml, 'emoji', 'height'),
    size: numberAttr(xml, 'emoji', 'len') || numberAttr(xml, 'emoji', 'androidlen'),
    desc: decodeXmlEntities(xmlAttr(xml, 'emoji', 'desc')),
  });
}

function parseAppMessage(xml, packedInfoData) {
  const appType = Number(extractTag(xml, 'type') || 0);
  const title = decodeXmlEntities(extractTag(xml, 'title') || '');
  const url = decodeXmlEntities(extractTag(xml, 'url') || '');
  const md5 = extractTag(xml, 'md5') || extractTag(xml, 'filemd5') || firstHex(decodeMessagePayload(packedInfoData), 32);
  const quote = parseQuoteMedia(xml);
  if (appType === 57 || quote) {
    const media = compactObject({ kind: 'quote', title, quote });
    return { type: 'quote', content: formatQuoteContent(title, quote), media };
  }
  const media = compactObject({
    kind: appType === 6 ? 'file' : 'app',
    file_name: title,
    md5,
    size: Number(extractTag(xml, 'totallen') || extractTag(xml, 'filetotallen') || 0) || undefined,
    ext: decodeXmlEntities(extractTag(xml, 'fileext') || ''),
    url,
  });
  if (appType === 6 || /<appattach[\s>]/i.test(xml) || looksLikeFilename(title)) {
    return { type: 'file', content: formatFileContent(media), media };
  }
  if (appType === 5 || url) {
    return { type: 'link', content: title ? `[链接] ${title}${url ? ` ${url}` : ''}` : `[链接] ${url}`, media };
  }
  return { type: 'file', content: title ? `[文件/小程序] ${title}` : '[文件/链接]', media };
}

function parseQuoteMedia(xml) {
  const referXml = String(xml || '').match(/<refermsg\b[^>]*>[\s\S]*?<\/refermsg>/i)?.[0] || '';
  if (!referXml) return null;
  const rawContent = cleanQuoteText(extractTag(referXml, 'content'));
  const split = splitSenderPrefix(rawContent);
  const displayName = cleanQuoteText(extractTag(referXml, 'displayname'));
  return compactObject({
    from: displayName || split.sender || cleanQuoteText(extractTag(referXml, 'fromusr')),
    content: split.body ? cleanQuoteText(split.body) : rawContent,
    type: cleanQuoteText(extractTag(referXml, 'type')),
    server_id: cleanQuoteText(extractTag(referXml, 'svrid')),
    create_time: cleanQuoteText(extractTag(referXml, 'createtime')),
  });
}

function cleanQuoteText(text) {
  return decodeXmlEntities(String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function formatImageContent(media = {}) {
  const bits = [];
  if (media.width && media.height) bits.push(`${media.width}x${media.height}`);
  if (media.size) bits.push(formatBytes(media.size));
  if (media.md5) bits.push(`md5=${String(media.md5).slice(0, 8)}`);
  if (media.data_url) bits.push('已附图');
  else if (media.local_available) bits.push('本地文件待解封');
  return `[图片${bits.length ? ' ' + bits.join(' · ') : ''}]`;
}

function formatVoiceContent(media = {}) {
  const bits = [];
  if (media.duration_ms) bits.push(`${Math.round(Number(media.duration_ms) / 1000)}秒`);
  if (media.file_name) bits.push(`文件=${media.file_name}`);
  if (media.size) bits.push(formatBytes(media.size));
  if (media.format) bits.push(`格式=${media.format}`);
  if (media.audio_data_url) bits.push('已附音频');
  else if (media.local_available) bits.push('本地语音已定位');
  return `[语音${bits.length ? ' ' + bits.join(' · ') : ''}]`;
}

function formatVideoContent(media = {}) {
  const bits = [];
  if (media.width && media.height) bits.push(`${media.width}x${media.height}`);
  if (media.duration_s) bits.push(`${media.duration_s}秒`);
  if (media.size) bits.push(formatBytes(media.size));
  if (media.frame_data_url) bits.push('已附关键帧');
  else if (media.local_available) bits.push('本地视频已定位');
  return `[视频${bits.length ? ' ' + bits.join(' · ') : ''}]`;
}

function formatEmojiContent(media = {}) {
  const desc = media.desc ? ` ${media.desc}` : '';
  return `[表情${desc}]`;
}

function formatFileContent(media = {}) {
  const name = media.file_name || '未命名文件';
  const bits = [];
  if (media.ext) bits.push(media.ext);
  if (media.size) bits.push(formatBytes(media.size));
  if (media.frame_data_url) bits.push('已附视频关键帧');
  if (media.audio_data_url) bits.push('已附音频');
  return `[文件] ${name}${bits.length ? ` (${bits.join(' · ')})` : ''}`;
}

function formatQuoteContent(title = '', quote = {}) {
  const reply = cleanQuoteText(title);
  const from = quote?.from ? `${quote.from}: ` : '';
  const quoted = quote?.content ? `${from}${quote.content}` : '未识别引用内容';
  return `[引用] ${reply || '（无回复正文）'}；原文：${quoted}`;
}

function xmlAttr(xml, tag, attr) {
  const match = String(xml || '').match(new RegExp(`<${tag}\\b[^>]*\\s${attr}\\s*=\\s*([\"'])(.*?)\\1`, 'i'));
  return match ? decodeXmlEntities(match[2]) : '';
}

function numberAttr(xml, tag, attr) {
  const n = Number(xmlAttr(xml, tag, attr));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function extractTag(xml, tag) {
  const match = String(xml || '').match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? decodeXmlEntities(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()) : '';
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function firstNumber(values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function firstHex(text, length, { requireBoundary = true } = {}) {
  const pattern = requireBoundary ? `\\b[a-fA-F0-9]{${length}}\\b` : `[a-fA-F0-9]{${length}}`;
  return String(text || '').match(new RegExp(pattern))?.[0]?.toLowerCase() || '';
}

function findImageByFileKey(stmt, fileKey) {
  const key = String(fileKey || '').trim().toLowerCase();
  if (!stmt || !/^[a-f0-9]{32}$/.test(key)) return null;
  for (const suffix of ['.dat', '_h.dat', '_t.dat']) {
    const row = stmt.get([`${key}${suffix}`]);
    if (row) return row;
  }
  return null;
}

function findImageByFileName(stmt, fileName) {
  const name = safeLocalFileName(fileName);
  if (!stmt || !name) return null;
  for (const candidate of imageCandidateNamesFromFileName(name)) {
    const row = stmt.get([candidate]);
    if (row) return row;
  }
  return null;
}

function findFileByFileKey(stmt, fileKey, extensions = []) {
  const key = String(fileKey || '').trim().toLowerCase();
  if (!stmt || !/^[a-f0-9]{32}$/.test(key)) return null;
  for (const suffix of uniqueStrings(['', ...extensions])) {
    const row = stmt.get([`${key}${suffix}`]);
    if (row) return row;
  }
  return null;
}

async function findLocalImagePathByFileKey(account, fileKey, cache = {}, msg = null, { signal = null } = {}) {
  throwIfAborted(signal);
  const key = String(fileKey || '').trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(key)) return '';
  const direct = await findLocalImagePathByConversation(account, key, msg, { signal });
  if (direct) return direct;
  if (!cache.index) cache.index = await buildLocalImageFileIndex(account, { signal });
  throwIfAborted(signal);
  return cache.index.get(key) || '';
}

async function findLocalImagePathByFileName(account, fileName, msg = null, { signal = null } = {}) {
  throwIfAborted(signal);
  const safeName = safeLocalFileName(fileName);
  if (!safeName) return '';
  const direct = await findLocalImagePathByConversationFileName(account, safeName, msg, { signal });
  if (direct) return direct;
  return await findLocalImagePathByBoundedNameSearch(account, safeName, msg, { signal });
}

async function findLocalImagePathByConversation(account, key, msg, { signal = null } = {}) {
  throwIfAborted(signal);
  const conversationDir = conversationStorageDir(msg?.group || msg?.sender);
  const monthDir = messageMonthDir(msg);
  if (!conversationDir || !monthDir) return '';
  const dir = mediaPath(account, 'msg', 'attach', conversationDir, monthDir, 'Img');
  for (const suffix of ['_h.dat', '.dat', '_t.dat']) {
    throwIfAborted(signal);
    const candidate = path.join(dir, `${key}${suffix}`);
    if (await mediaFileExists(account, candidate, { signal })) return candidate;
  }
  return '';
}

async function findLocalImagePathByConversationFileName(account, fileName, msg, { signal = null } = {}) {
  throwIfAborted(signal);
  const conversationDir = conversationStorageDir(msg?.group || msg?.sender);
  const monthDir = messageMonthDir(msg);
  if (!conversationDir || !monthDir) return '';
  const dir = mediaPath(account, 'msg', 'attach', conversationDir, monthDir, 'Img');
  for (const name of imageCandidateNamesFromFileName(fileName)) {
    throwIfAborted(signal);
    const candidate = path.join(dir, name);
    if (await mediaFileExists(account, candidate, { signal })) return candidate;
  }
  return '';
}

async function findLocalImagePathByBoundedNameSearch(account, fileName, msg, { signal = null } = {}) {
  throwIfAborted(signal);
  const monthDir = messageMonthDir(msg);
  if (!monthDir) return '';
  const targets = new Set(imageCandidateNamesFromFileName(fileName).map(name => name.toLowerCase()));
  if (!targets.size) return '';
  const root = mediaPath(account, 'msg', 'attach');
  const stack = [root];
  let visited = 0;
  const deadline = Date.now() + LOCAL_IMAGE_INDEX_MAX_MS;
  while (stack.length && visited < LOCAL_IMAGE_INDEX_MAX_ENTRIES && Date.now() < deadline) {
    throwIfAborted(signal);
    const dir = stack.pop();
    const entries = await readMediaDir(account, dir, { signal });
    for (const entry of entries) {
      throwIfAborted(signal);
      visited++;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (entry.name === monthDir || lower === 'img' || /^[a-f0-9]{32}$/i.test(entry.name)) stack.push(full);
      } else if (entry.isFile() && targets.has(entry.name.toLowerCase())) {
        return full;
      }
      if (visited >= LOCAL_IMAGE_INDEX_MAX_ENTRIES || Date.now() >= deadline) break;
    }
  }
  return '';
}

function imageCandidateNamesFromFileName(fileName) {
  const name = safeLocalFileName(fileName);
  if (!name) return [];
  const base = name.replace(/\.(?:dat|jpe?g|png|webp|heic|heif|gif)$/i, '');
  const withDat = /\.dat$/i.test(name) ? '' : `${name}.dat`;
  return uniqueStrings([
    name,
    withDat,
    `${base}.dat`,
    `${base}_h.dat`,
    `${base}_t.dat`,
  ]);
}

async function buildLocalImageFileIndex(account, { signal = null } = {}) {
  throwIfAborted(signal);
  const index = new Map();
  const root = mediaPath(account, 'msg', 'attach');
  const stack = [root];
  let visited = 0;
  const deadline = Date.now() + LOCAL_IMAGE_INDEX_MAX_MS;
  while (stack.length && visited < LOCAL_IMAGE_INDEX_MAX_ENTRIES && Date.now() < deadline) {
    throwIfAborted(signal);
    const dir = stack.pop();
    const entries = await readMediaDir(account, dir, { signal });
    for (const entry of entries) {
      throwIfAborted(signal);
      visited++;
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
      else if (entry.isFile()) {
        const match = entry.name.toLowerCase().match(/^([a-f0-9]{32})(?:_[ht])?\.dat$/);
        if (!match) continue;
        const key = match[1];
        const file = path.join(dir, entry.name);
        const prev = index.get(key);
        if (!prev || imageFilePriority(file) < imageFilePriority(prev)) index.set(key, file);
      }
    }
  }
  return index;
}

function imageFilePriority(file) {
  const name = path.basename(file).toLowerCase();
  if (name.endsWith('_h.dat')) return 0;
  if (name.endsWith('.dat') && !name.endsWith('_t.dat')) return 1;
  return 2;
}

async function findLocalVoicePathByFileName(account, fileName, msg, { signal = null } = {}) {
  throwIfAborted(signal);
  const safeName = safeLocalFileName(fileName);
  if (!safeName) return '';
  const monthDir = messageMonthDir(msg);
  if (!monthDir) return '';
  for (const dir of voiceSearchDirs(account, msg)) {
    throwIfAborted(signal);
    const candidate = path.join(dir, safeName);
    if (await mediaFileExists(account, candidate, { signal })) return candidate;
  }
  return await findLocalVoicePathByBoundedIndex(account, name => name.toLowerCase() === safeName.toLowerCase(), msg, { signal });
}

async function findLocalVoicePathByFileKey(account, fileKey, msg, { signal = null } = {}) {
  throwIfAborted(signal);
  const key = String(fileKey || '').trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(key)) return '';
  for (const dir of voiceSearchDirs(account, msg)) {
    for (const name of voiceCandidateNames(key)) {
      throwIfAborted(signal);
      const candidate = path.join(dir, name);
      if (await mediaFileExists(account, candidate, { signal })) return candidate;
    }
  }
  return await findLocalVoicePathByBoundedIndex(account, name => {
    const lower = name.toLowerCase();
    return lower === key || VOICE_FILE_EXTENSIONS.some(ext => lower === `${key}${ext}`);
  }, msg, { signal });
}

function voiceSearchDirs(account, msg) {
  const monthDir = messageMonthDir(msg);
  if (!monthDir) return [];
  const dirs = [
    mediaPath(account, 'msg', 'file', monthDir),
    mediaPath(account, 'msg', 'voice', monthDir),
    mediaPath(account, 'msg', 'audio', monthDir),
  ];
  const conversationDir = conversationStorageDir(msg?.group || msg?.sender);
  if (conversationDir) {
    for (const subdir of ['Voice', 'Audio', 'File']) {
      dirs.push(mediaPath(account, 'msg', 'attach', conversationDir, monthDir, subdir));
    }
  }
  return uniqueStrings(dirs);
}

function voiceCandidateNames(key) {
  return uniqueStrings([key, ...VOICE_FILE_EXTENSIONS.map(ext => `${key}${ext}`)]);
}

async function findLocalVoicePathByBoundedIndex(account, predicate, msg, { signal = null } = {}) {
  throwIfAborted(signal);
  const monthDir = messageMonthDir(msg);
  if (!monthDir) return '';
  const roots = [
    mediaPath(account, 'msg', 'file', monthDir),
    mediaPath(account, 'msg', 'attach'),
  ];
  const stack = uniqueStrings(roots);
  let visited = 0;
  const deadline = Date.now() + LOCAL_VOICE_INDEX_MAX_MS;
  while (stack.length && visited < LOCAL_VOICE_INDEX_MAX_ENTRIES && Date.now() < deadline) {
    throwIfAborted(signal);
    const dir = stack.pop();
    const entries = await readMediaDir(account, dir, { signal });
    for (const entry of entries) {
      throwIfAborted(signal);
      visited++;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (entry.name === monthDir || /^[a-f0-9]{32}$/i.test(entry.name) || ['voice', 'audio', 'file'].includes(lower)) stack.push(full);
      } else if (entry.isFile() && predicate(entry.name)) {
        return full;
      }
      if (visited >= LOCAL_VOICE_INDEX_MAX_ENTRIES || Date.now() >= deadline) break;
    }
  }
  return '';
}

function safeLocalFileName(fileName) {
  return path.basename(String(fileName || '').replace(/\\/g, '/')).trim();
}

function looksLikeFilename(value) {
  return /\.[a-z0-9]{1,12}$/i.test(String(value || ''));
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)}KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)}MB`;
}

function compactObject(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== '' && value !== undefined && value !== null));
}

async function exists(file, { signal = null } = {}) {
  throwIfAborted(signal);
  const st = await fsp.stat(file).catch(() => null);
  throwIfAborted(signal);
  return !!st;
}

async function readImageDataUrlIfUsable(file, imageKeyCandidates = [], { signal = null } = {}) {
  throwIfAborted(signal);
  const seen = new Set();
  for (const candidate of [file, ...imageDatSiblingCandidates(file)]) {
    throwIfAborted(signal);
    assertMediaCopyPath(candidate);
    const lower = candidate.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    const linkStat = await fsp.lstat(candidate).catch(e => {
      if (isMissingPathError(e)) return null;
      throw e;
    });
    throwIfAborted(signal);
    if (!linkStat) continue;
    await assertCopiedMediaRealPath(candidate, { signal });
    const st = await fsp.stat(candidate).catch(e => {
      if (isMissingPathError(e)) return null;
      throw mediaTempCopyUnreadableError('检查', candidate, e);
    });
    throwIfAborted(signal);
    if (!st?.isFile() || st.size > 3 * 1024 * 1024) continue;
    const raw = await fsp.readFile(candidate);
    throwIfAborted(signal);
    const decoded = await materializeDecodedImage(extractPlainImage(raw, imageKeyCandidates), { signal });
    if (!decoded) continue;
    return {
      mime: decoded.mime,
      data_url: `data:${decoded.mime};base64,${decoded.bytes.toString('base64')}`,
    };
  }
  return null;
}

async function readVideoFrameDataUrlIfUsable(file, { signal = null } = {}) {
  throwIfAborted(signal);
  await assertCopiedMediaRealPath(file, { signal });
  const st = await fsp.stat(file).catch(e => {
    throw mediaTempCopyUnreadableError('检查', file, e);
  });
  throwIfAborted(signal);
  if (!st?.isFile() || st.size > 512 * 1024 * 1024) return null;
  const raw = st.size <= 16 * 1024 * 1024
    ? await fsp.readFile(file).catch(e => {
        throw mediaTempCopyUnreadableError('读取', file, e);
      })
    : null;
  throwIfAborted(signal);
  const image = raw ? extractPlainImage(raw) : null;
  if (image) {
    return {
      mime: image.mime,
      data_url: `data:${image.mime};base64,${image.bytes.toString('base64')}`,
    };
  }
  const frame = await extractVideoFrameToImage(file, { signal });
  throwIfAborted(signal);
  if (!frame) return null;
  return {
    mime: frame.mime,
    data_url: `data:${frame.mime};base64,${frame.bytes.toString('base64')}`,
  };
}

async function readAudioDataUrlIfUsable(file, { signal = null } = {}) {
  throwIfAborted(signal);
  await assertCopiedMediaRealPath(file, { signal });
  const st = await fsp.stat(file).catch(e => {
    throw mediaTempCopyUnreadableError('检查', file, e);
  });
  throwIfAborted(signal);
  if (!st?.isFile() || st.size > 8 * 1024 * 1024) return null;
  const mime = audioMimeFromPath(file);
  if (mime === 'audio/mpeg' || mime === 'audio/wav') {
    const raw = await fsp.readFile(file);
    throwIfAborted(signal);
    return {
      mime,
      audio_data_url: `data:${mime};base64,${raw.toString('base64')}`,
    };
  }
  const wav = await transcodeAudioToWav(file, { signal });
  throwIfAborted(signal);
  if (wav && wav.bytes.length <= 8 * 1024 * 1024) {
    return {
      mime: wav.mime,
      converted_from_mime: mime || '',
      audio_data_url: `data:${wav.mime};base64,${wav.bytes.toString('base64')}`,
    };
  }
  if (!mime) return null;
  const raw = await fsp.readFile(file);
  throwIfAborted(signal);
  return {
    mime,
    audio_data_url: `data:${mime};base64,${raw.toString('base64')}`,
  };
}

async function materializeDecodedImage(decoded, { signal = null } = {}) {
  throwIfAborted(signal);
  if (!decoded) return null;
  if (decoded.mime === 'application/x-wxgf') return decodeWxgfToImage(decoded.bytes, { signal });
  return decoded;
}

async function findLocalMessageFilePath(account, fileName, msg, { signal = null } = {}) {
  throwIfAborted(signal);
  const safeName = safeLocalFileName(fileName);
  const monthDir = messageMonthDir(msg);
  if (!safeName || !monthDir) return '';
  const dirs = [
    mediaPath(account, 'msg', 'file', monthDir),
    mediaPath(account, 'msg', 'video', monthDir),
  ];
  for (const dir of dirs) {
    throwIfAborted(signal);
    const candidate = path.join(dir, safeName);
    if (await mediaFileExists(account, candidate, { signal })) return candidate;
  }
  return '';
}

async function resolveAttachPath(account, d1, d2, fileName, subdirs = [], { signal = null } = {}) {
  throwIfAborted(signal);
  if (!d1 || !d2 || !fileName) return '';
  for (const subdir of subdirs) {
    throwIfAborted(signal);
    const candidate = mediaPath(account, 'msg', 'attach', d1, d2, subdir, fileName);
    if (await mediaFileExists(account, candidate, { signal })) return candidate;
  }
  const direct = mediaPath(account, 'msg', 'attach', d1, d2, fileName);
  return await mediaFileExists(account, direct, { signal }) ? direct : '';
}

async function findLocalVideoPathByFileKey(account, fileKey, msg, { signal = null } = {}) {
  throwIfAborted(signal);
  const key = String(fileKey || '').trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(key)) return '';
  const monthDir = messageMonthDir(msg);
  if (!monthDir) return '';
  const dir = mediaPath(account, 'msg', 'video', monthDir);
  const candidates = [
    `${key}.mp4`,
    `${key}.mov`,
    `${key}.m4v`,
    `${key}.dat`,
    `${key}_thumb.jpg`,
    `${key}_thumb.jpeg`,
    `${key}_thumb.png`,
  ].map(name => path.join(dir, name));
  for (const candidate of candidates) {
    throwIfAborted(signal);
    if (await mediaFileExists(account, candidate, { signal })) return candidate;
  }
  return '';
}

function conversationStorageDir(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return crypto.createHash('md5').update(text).digest('hex');
}

function messageMonthDir(msg) {
  const time = Number(msg?.timestamp || 0);
  const date = Number.isFinite(time) && time > 0 ? new Date(time) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function isVideoLike(media = {}) {
  const name = String(media.file_name || '').toLowerCase();
  const ext = String(media.ext || path.extname(name).slice(1)).toLowerCase();
  return ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', '3gp'].includes(ext);
}

function isAudioLike(media = {}) {
  const name = String(media.file_name || '').toLowerCase();
  const ext = String(media.ext || path.extname(name).slice(1)).toLowerCase();
  return ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'webm', 'flac', 'amr', 'silk', 'aud'].includes(ext);
}

function audioMimeFromPath(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.aac') return 'audio/aac';
  if (ext === '.ogg' || ext === '.oga') return 'audio/ogg';
  if (ext === '.webm') return 'audio/webm';
  if (ext === '.flac') return 'audio/flac';
  if (ext === '.amr') return 'audio/amr';
  if (ext === '.silk') return 'audio/silk';
  if (ext === '.aud') return 'audio/x-wx-voice';
  return '';
}

async function readImageValidationSamples(file, { signal = null } = {}) {
  throwIfAborted(signal);
  const samples = [];
  const seen = new Set();
  for (const candidate of imageDatSiblingCandidates(file)) {
    throwIfAborted(signal);
    const lower = candidate.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    const prefix = await readPrefix(candidate, 64, { signal });
    const sample = weChatV4ValidationSample(prefix);
    if (sample) samples.push(sample);
  }
  return samples;
}

function imageDatSiblingCandidates(file) {
  const dir = path.dirname(file);
  const name = path.basename(file);
  const root = name.replace(/(?:_[ht])?\.dat$/i, '');
  return [
    path.join(dir, `${root}_t.dat`),
    path.join(dir, `${root}.dat`),
    path.join(dir, `${root}_h.dat`),
    file,
  ];
}

async function readPrefix(file, bytes, { signal = null } = {}) {
  throwIfAborted(signal);
  assertMediaCopyPath(file);
  const st = await fsp.lstat(file).catch(e => {
    if (isMissingPathError(e)) return null;
    throw mediaTempCopyUnreadableError('检查', file, e);
  });
  throwIfAborted(signal);
  if (!st?.isFile() || st.isSymbolicLink()) return null;
  await assertCopiedMediaRealPath(file, { signal });
  const handle = await fsp.open(file, 'r').catch(e => {
    if (isMissingPathError(e)) return null;
    throw mediaTempCopyUnreadableError('读取', file, e);
  });
  if (!handle) return null;
  try {
    throwIfAborted(signal);
    const buf = Buffer.alloc(bytes);
    const res = await handle.read(buf, 0, bytes, 0);
    throwIfAborted(signal);
    return buf.subarray(0, res.bytesRead);
  } finally {
    await handle.close();
  }
}

async function getImageKeyCandidatesForSamples(samples, { signal = null, maxMs = IMAGE_KEY_SCAN_MAX_MS } = {}) {
  throwIfAborted(signal);
  const unique = [];
  const seen = new Set();
  for (const sample of samples) {
    throwIfAborted(signal);
    if (!Buffer.isBuffer(sample) || sample.length < 16) continue;
    const hex = sample.subarray(0, 16).toString('hex');
    if (seen.has(hex)) continue;
    seen.add(hex);
    unique.push(sample.subarray(0, 16));
  }
  if (!unique.length) return [];
  const sampleHash = crypto.createHash('sha256').update(Buffer.concat(unique)).digest('hex');
  const cacheFresh = imageKeyCache.keys.length && Date.now() - imageKeyCache.at < IMAGE_KEY_CACHE_MS;
  if (cacheFresh && imageKeyCache.sampleHash === sampleHash && samplesCoveredByImageKeys(unique, imageKeyCache.keys)) {
    return imageKeyCache.keys;
  }
  if (cacheFresh && samplesCoveredByImageKeys(unique, imageKeyCache.keys)) return imageKeyCache.keys;
  // Message/image bytes always come from local DB/file copies; this memory scan only finds AES key material.
  try {
    const keys = [...(cacheFresh ? imageKeyCache.keys : [])];
    addUniqueStrings(keys, await scanImageKeysForValidationSamples(unique.filter(sample => !keys.some(key => validateImageKeyCandidate(key, [sample]))), { signal, maxMs }));
    imageKeyCache = { at: Date.now(), sampleHash, keys };
    return keys;
  } catch (e) {
    if (isWxdbAbort(e, signal)) throw e;
    return cacheFresh ? imageKeyCache.keys : [];
  }
}

function samplesCoveredByImageKeys(samples, keys) {
  return samples.every(sample => keys.some(key => validateImageKeyCandidate(key, [sample])));
}

async function scanImageKeysForValidationSamples(samples, { signal = null, maxMs = IMAGE_KEY_SCAN_MAX_MS } = {}) {
  throwIfAborted(signal);
  const keys = [];
  const samplePlan = pickImageKeyValidationSamples(samples);
  const deadline = Date.now() + Math.max(1000, Number(maxMs || IMAGE_KEY_SCAN_MAX_MS));
  const remainingMs = () => Math.max(0, deadline - Date.now());

  addUniqueStrings(keys, await probeImageKeys(samplePlan, false, { signal, maxMs: remainingMs() }));
  if (!keys.length && remainingMs() > 1000) addUniqueStrings(keys, await probeImageKeys(samplePlan, true, { signal, maxMs: remainingMs() }));

  for (const sample of samples) {
    throwIfAborted(signal);
    if (remainingMs() <= 1000) break;
    if (keys.some(key => validateImageKeyCandidate(key, [sample]))) continue;
    addUniqueStrings(keys, await probeImageKeys([sample], false, { signal, maxMs: remainingMs() }));
    if (keys.some(key => validateImageKeyCandidate(key, [sample]))) continue;
    if (remainingMs() > 1000) addUniqueStrings(keys, await probeImageKeys([sample], true, { signal, maxMs: remainingMs() }));
  }
  return keys;
}

async function probeImageKeys(validationSamples, wide, { signal = null, maxMs = IMAGE_KEY_SCAN_MAX_MS } = {}) {
  throwIfAborted(signal);
  if (!validationSamples.length) return [];
  const result = await probeWxKey({
    scan_all_processes: true,
    scan_image: true,
    image_samples: validationSamples,
    include_image_raw: true,
    ...(wide ? {
      image_include_mapped: true,
      image_scan_max_bytes: 512 * 1024 * 1024,
      image_scan_max_ms: Math.min(IMAGE_KEY_WIDE_SCAN_MAX_MS, Math.max(1000, Number(maxMs || IMAGE_KEY_SCAN_MAX_MS))),
    } : {
      image_scan_max_ms: Math.min(IMAGE_KEY_SCAN_MAX_MS, Math.max(1000, Number(maxMs || IMAGE_KEY_SCAN_MAX_MS))),
    }),
    signal,
  });
  return uniqueStrings(result._raw_image_keys || []);
}

function addUniqueStrings(target, items) {
  const seen = new Set(target);
  for (const item of items || []) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    target.push(item);
  }
}

function pickImageKeyValidationSamples(samples) {
  if (samples.length <= 2) return samples;
  return uniqueBuffers([
    samples[0],
    samples[Math.floor(samples.length / 2)],
    samples[samples.length - 1],
  ]);
}

function uniqueBuffers(buffers) {
  const out = [];
  const seen = new Set();
  for (const item of buffers) {
    if (!Buffer.isBuffer(item)) continue;
    const hex = item.toString('hex');
    if (seen.has(hex)) continue;
    seen.add(hex);
    out.push(item);
  }
  return out;
}

function uniqueStrings(items) {
  return [...new Set(items.map(item => String(item || '').trim()).filter(Boolean))];
}

function sanitizeWxdbDiagnosticError(value = '') {
  return String(value || '')
    .replace(/[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/g, '[redacted-path]')
    .replace(/\/(?:[^/\0\r\n]+\/)*[^/\0\r\n]+/g, '[redacted-path]')
    .replace(/[a-f0-9]{64,192}/gi, '[redacted-hex]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function wxdbDiagnosticCount(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function sanitizeWxdbKeyScanDiagnostics(value = null) {
  if (!value || typeof value !== 'object') return null;
  const out = compactObject({
    source_name: sanitizeWxdbDiagnosticError(value.source_name || ''),
    initial_candidate_count: wxdbDiagnosticCount(value.initial_candidate_count),
    quick_candidate_matched: value.quick_candidate_matched === true,
    page_hmac_candidate_matched: value.page_hmac_candidate_matched === true,
    targeted_scan_attempted: value.targeted_scan_attempted === true,
    targeted_raw_key_count: wxdbDiagnosticCount(value.targeted_raw_key_count),
    scan_unavailable: value.scan_unavailable === true,
    scan_unavailable_reason: sanitizeWxdbDiagnosticError(value.scan_unavailable_reason || ''),
    scan_unavailable_error: sanitizeWxdbDiagnosticError(value.scan_unavailable_error || ''),
    scan_process_count: wxdbDiagnosticCount(value.scan_process_count),
    scan_process_attempt_count: wxdbDiagnosticCount(value.scan_process_attempt_count),
    requested_salt_count: wxdbDiagnosticCount(value.requested_salt_count),
    matched_salt_count: wxdbDiagnosticCount(value.matched_salt_count),
    hex_pattern_count: wxdbDiagnosticCount(value.hex_pattern_count),
    v4_pointer_pattern_hit_count: wxdbDiagnosticCount(value.v4_pointer_pattern_hit_count),
    v4_pointer_pattern_candidate_count: wxdbDiagnosticCount(value.v4_pointer_pattern_candidate_count),
    v4_pointer_verified_candidate_count: wxdbDiagnosticCount(value.v4_pointer_verified_candidate_count),
    pointer_passphrase_derive_attempts: wxdbDiagnosticCount(value.pointer_passphrase_derive_attempts),
    pointer_passphrase_derived_match_count: wxdbDiagnosticCount(value.pointer_passphrase_derived_match_count),
    passphrase_derive_attempts: wxdbDiagnosticCount(value.passphrase_derive_attempts),
    passphrase_derived_match_count: wxdbDiagnosticCount(value.passphrase_derived_match_count),
    scanned_bytes: wxdbDiagnosticCount(value.scanned_bytes),
    codec_context_attempted: value.codec_context_attempted === true,
    codec_context_scan_process_count: wxdbDiagnosticCount(value.codec_context_scan_process_count),
    codec_context_salt_match_count: wxdbDiagnosticCount(value.codec_context_salt_match_count),
    codec_context_unique_candidate_count: wxdbDiagnosticCount(value.codec_context_unique_candidate_count),
    codec_context_pass_candidate_count: wxdbDiagnosticCount(value.codec_context_pass_candidate_count),
    codec_context_key_pointer_candidate_count: wxdbDiagnosticCount(value.codec_context_key_pointer_candidate_count),
    codec_context_page_key_match_count: wxdbDiagnosticCount(value.codec_context_page_key_match_count),
    codec_context_scanned_bytes: wxdbDiagnosticCount(value.codec_context_scanned_bytes),
    error: sanitizeWxdbDiagnosticError(value.error || ''),
  });
  return Object.keys(out).length ? out : null;
}

function summarizeShardKeyScans(shardErrors = []) {
  const scans = shardErrors
    .map(item => sanitizeWxdbKeyScanDiagnostics(item?.key_scan))
    .filter(Boolean);
  if (!scans.length) return null;
  const sum = field => scans.reduce((total, item) => total + wxdbDiagnosticCount(item[field]), 0);
  return compactObject({
    shard_count: scans.length,
    quick_candidate_match_shard_count: scans.filter(item => item.quick_candidate_matched === true).length,
    targeted_scan_shard_count: scans.filter(item => item.targeted_scan_attempted === true).length,
    targeted_raw_key_hit_shard_count: scans.filter(item => wxdbDiagnosticCount(item.targeted_raw_key_count) > 0).length,
    scan_unavailable_shard_count: scans.filter(item => item.scan_unavailable === true).length,
    scan_unavailable_reason: scans.find(item => item.scan_unavailable_reason)?.scan_unavailable_reason || '',
    scan_unavailable_error: scans.find(item => item.scan_unavailable_error)?.scan_unavailable_error || '',
    initial_candidate_count_max: Math.max(0, ...scans.map(item => wxdbDiagnosticCount(item.initial_candidate_count))),
    scan_process_count_total: sum('scan_process_count'),
    scan_process_attempt_count_total: sum('scan_process_attempt_count'),
    requested_salt_count_total: sum('requested_salt_count'),
    matched_salt_count_total: sum('matched_salt_count'),
    hex_pattern_count_total: sum('hex_pattern_count'),
    v4_pointer_pattern_hit_count_total: sum('v4_pointer_pattern_hit_count'),
    v4_pointer_pattern_candidate_count_total: sum('v4_pointer_pattern_candidate_count'),
    v4_pointer_verified_candidate_count_total: sum('v4_pointer_verified_candidate_count'),
    pointer_passphrase_derive_attempts_total: sum('pointer_passphrase_derive_attempts'),
    pointer_passphrase_derived_match_count_total: sum('pointer_passphrase_derived_match_count'),
    passphrase_derive_attempts_total: sum('passphrase_derive_attempts'),
    passphrase_derived_match_count_total: sum('passphrase_derived_match_count'),
    scanned_bytes_total: sum('scanned_bytes'),
    codec_context_scan_shard_count: scans.filter(item => item.codec_context_attempted === true).length,
    codec_context_scan_process_count_total: sum('codec_context_scan_process_count'),
    codec_context_salt_match_count_total: sum('codec_context_salt_match_count'),
    codec_context_unique_candidate_count_total: sum('codec_context_unique_candidate_count'),
    codec_context_pass_candidate_count_total: sum('codec_context_pass_candidate_count'),
    codec_context_key_pointer_candidate_count_total: sum('codec_context_key_pointer_candidate_count'),
    codec_context_page_key_match_count_total: sum('codec_context_page_key_match_count'),
    codec_context_scanned_bytes_total: sum('codec_context_scanned_bytes'),
  });
}

function prioritizeRawKeyCandidate(rawKeys, rawKey) {
  if (!Array.isArray(rawKeys)) return;
  const key = String(rawKey || '').trim().toLowerCase();
  if (!key) return;
  const index = rawKeys.findIndex(item => String(item || '').trim().toLowerCase() === key);
  if (index >= 0) rawKeys.splice(index, 1);
  rawKeys.unshift(key);
}

function readProtoFields(buffer) {
  const fields = [];
  let pos = 0;
  while (pos < buffer.length) {
    const tag = readVarint(buffer, pos);
    if (!tag) break;
    pos = tag.next;
    const field = tag.value >> 3;
    const wire = tag.value & 7;
    if (wire === 0) {
      const value = readVarint(buffer, pos);
      if (!value) break;
      fields.push({ field, wire, value: value.value });
      pos = value.next;
    } else if (wire === 2) {
      const len = readVarint(buffer, pos);
      if (!len) break;
      pos = len.next;
      fields.push({ field, wire, value: buffer.subarray(pos, pos + len.value) });
      pos += len.value;
    } else if (wire === 5) {
      if (pos + 4 > buffer.length) break;
      fields.push({ field, wire, value: buffer.readUInt32LE(pos) });
      pos += 4;
    } else if (wire === 1) {
      if (pos + 8 > buffer.length) break;
      fields.push({ field, wire, value: Number(buffer.readBigUInt64LE(pos)) });
      pos += 8;
    } else {
      break;
    }
  }
  return fields;
}

function readVarint(buffer, pos) {
  let value = 0;
  let shift = 0;
  while (pos < buffer.length && shift < 53) {
    const byte = buffer[pos++];
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return { value, next: pos };
    shift += 7;
  }
  return null;
}

export const __wxdbInternals = {
  assertProjectMirrorAccount,
  canonicalAccountIdentityDirectPeers,
  accountIdentityDirectPeerFingerprint,
  scanAccountIdentityPeerCandidates,
  accountIdentityShardEvidenceCacheKey,
  createAccountIdentityShardEvidenceCacheEntry,
  normalizeAccountIdentityShardEvidenceCacheEntry,
  normalizeProjectMirrorRelative,
  projectMirrorManifestMap,
  projectMirrorDbFilesFromManifest,
  projectMirrorTargetIdentityRecorded,
  projectMirrorTargetIdentityMatches,
  projectMirrorContentVerificationFresh,
  projectMirrorScopeIncludesDbFile,
  mirrorReadinessCovers,
  normalizeMessageContent,
  decodeMessagePayload,
  parseChatRoomMemberBuffer,
  readImageDataUrlIfUsable,
  persistableRawKey,
  persistableRawKeyForVerifiedCache,
  portableWeixinV4VerifiedCandidates,
  normalizeWeixinV4ScanPages,
  weixinV4ScanPageCoverage,
  normalizeRawKeyCandidates,
  orderedRawKeyCandidates,
  sqlCipherValidationAttempts,
  throwIfMirrorReadGenerationChanged,
  isExpectedSqlCipherKeyValidationError,
  isSqliteCorruptionError,
  validateWeixinV4PageHmac,
  decryptWeixinV4DbToPlaintext,
  weixinV4KeyCandidates,
  deriveWeixinV4PassphrasePageKey,
  findWeixinV4PageKeyForCopiedDb,
  normalizeWxTimestamp,
  normalizePlausibleWxTimestamp,
  normalizePlausibleWxSortSeqTimestamp,
  plausibleWxDiagnosticTimeBounds,
  normalizeSessionLastMessageTimestamp,
  normalizeWxSortSeqTimestamp,
  messageTimeBounds,
  safeMessageShardMtimeMs,
  compareMessageShardsByLastWriteDesc,
  assertMessageShardCountSupported,
  messageShardCursorRecord,
  messageShardCursorState,
  messageShardGenerationFingerprint,
  messageShardRowAnchorHash,
  normalizeMessageShardRowPositions,
  summarizeMessageShardWriteTimes,
  messageShardMtimeRelationToRange,
  shouldUseSortSeqFallback,
  estimatePreMediaFilteredRowCount,
  assertMessagePayloadBudget,
  mergeMessageRowsByTimeSources,
  messageShardRowPositionAfterIncrementalMerge,
  dedupeMessagesAcrossShards,
  senderHydrationFailureCode,
  senderHydrationFailureCacheScope,
  senderHydrationRawKeyFingerprints,
  senderHydrationFailureCacheCovers,
  senderHydrationFailureCacheable,
  summarizeTableTimeStats,
  summarizeFailedMessageShardTimes,
  sanitizeWxdbDiagnosticError,
  sanitizeWxdbShardErrorCode,
  shardErrorCategory,
  shardOpenFailureCause,
  verifiedWeixinV4KeyScanAvailability,
  resolveSelfWxidEvidence,
  finalizeSelfWxidIdentityScan,
  accountIdentityScanLimitError,
  accountIdentityMessageShardCandidates,
  extractSelfWxidFromProjectMirrorAccount,
  acquirePlaintextCacheEntryLock,
  plaintextCacheArtifactIsFresh,
  plaintextCacheOwnerMatches,
  plaintextCacheTempOwner,
  plaintextCacheTempIsActive,
  retainWeixinV4PlaintextCache,
  releaseWeixinV4PlaintextCache,
  transitionPlaintextCacheLeaseToReleasing,
  settlePlaintextCacheRelease,
  plaintextCachePlainPathFromLeaseArtifact,
  activePlaintextCacheLeaseCount,
  removePlaintextCacheEntryIfUnused,
  pruneWeixinV4PlaintextCache,
  ensurePrivatePlaintextCacheRoot,
  toUnixSeconds,
  formatMessageTime,
  groupPinyinInitial,
  groupSearchFields,
  chatroomRequiredMirrorScope,
  accountMatchesMirrorSourceSnapshotToken,
  accountMatchesMirrorReadinessToken,
  mirrorReadRecoveryAction,
  projectMirrorCopyCanTrustPublishedHash,
  copyDbArtifactWithSignal,
};
