import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { pipeline } from 'node:stream/promises';
import { DATA_DIR, assertAvailableDiskSpace, isDiskSpaceError, isInside } from '../lib/paths.js';
import { ensureDir, readJson, renameAtomicWithRetry, writeJsonAtomic } from '../lib/json-store.js';
import { atomicProcessLockOwnerIsComplete, atomicProcessLockOwnerIsLegacyDeadReclaimable, publishAtomicProcessLock, reclaimAtomicProcessLockFile, releaseAtomicProcessLockFile } from '../lib/atomic-process-lock.js';
import { ACCOUNT_IDENTITY_MAX_MESSAGE_SHARDS, ACCOUNT_IDENTITY_MESSAGE_SELECTION_STRATEGY, accountIdentityMessageShardCandidates } from '../wxdb/identity-scope.js';

let wxDbMirrorRefreshListener = null;
let wxDbMirrorIdentityChangeListener = null;

const XWECHAT_CONFIG_DIR = path.join(process.env.APPDATA || '', 'Tencent', 'xwechat', 'config');
const XWECHAT_APPDATA_DIR = path.join(process.env.APPDATA || '', 'Tencent', 'xwechat');
const WINDOWS_POWERSHELL_EXE = process.platform === 'win32'
  ? [
    path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ].find(file => {
    try { return fs.existsSync(file); } catch { return false; }
  }) || ''
  : '';
const MODULE_DB_PATTERNS = [
  'sqlite',
  'SQLite',
  'SQLCipher',
  'sqlcipher',
  'cipher',
  'cipher_use_hmac',
  'cipher_default_use_hmac',
  'cipher_default_page_size',
  'cipher_default_hmac_algorithm',
  'cipher_default_compatibility',
  'cipher_default_plaintext_header_size',
  'cipher_memory_security',
  'cipher_store_pass',
  'cipher_version',
  'cipher_provider',
  'cipher_salt',
  'WCDB',
  'wcdb',
  'PRAGMA',
  'PRAGMA cipher',
  'cipher_compatibility',
  'cipher_default_kdf_iter',
  'cipher_page_size',
  'cipher_hmac_algorithm',
  'cipher_kdf_algorithm',
  'cipher_plaintext_header_size',
  'cipher_migrate',
  'sqlcipher_export',
  'kdf_iter',
  'HMAC_SHA1',
  'HMAC_SHA256',
  'PBKDF2_HMAC_SHA1',
  'PBKDF2_HMAC_SHA256',
  'setKey',
  'sqlite3_key',
  'sqlite3_rekey',
  'sqlite3_rekey_v2',
  'sqlcipher_codec_ctx',
  'sqlcipher_activate',
  'xwechat',
  'db_storage',
  'message_',
  'contact.db',
  'session.db',
  'hardlink.db',
];
const MAX_MODULE_STRING_ADDRESS_HITS = 2048;
const MODULE_CRYPTO_PATTERNS = [
  'AES',
  'AES-256',
  'BCRYPT_AES_ALGORITHM',
  'BCRYPT_SHA1_ALGORITHM',
  'BCRYPT_SHA256_ALGORITHM',
  'BCryptDecrypt',
  'BCryptDeriveKeyPBKDF2',
  'BCryptEncrypt',
  'BCryptGenerateSymmetricKey',
  'BCryptHashData',
  'BCryptOpenAlgorithmProvider',
  'CALG_AES_256',
  'CryptAcquireContext',
  'CryptDeriveKey',
  'CryptHashData',
  'EVP_Decrypt',
  'EVP_Encrypt',
  'HMAC',
  'HKDF',
  'PBKDF',
  'PBKDF2',
  'SHA1',
  'SHA256',
  'SHA512',
  'SQLITE_HAS_CODEC',
  'SqlCipher',
  'cipher_ctx',
  'codec_ctx',
  'db_key',
  'derive',
  'key derivation',
  'mbedtls_aes',
  'mbedtls_md_hmac',
  'openssl',
  'sqlite3_key',
  'sqlite3_key_v2',
  'wxsqlite',
];
const MAX_MODULE_CRYPTO_ADDRESS_HITS = 1024;
const MAX_IMPORT_DLLS = 96;
const MAX_IMPORT_FUNCTIONS_PER_DLL = 64;
const MAX_INTERESTING_IMPORT_FUNCTIONS_PER_DLL = 32;
const MAX_EXPORT_NAMES = 256;
const MAX_STRING_CLUSTERS = 40;
const MAX_STATIC_STRING_XREF_TARGETS = 1200;
const MAX_STATIC_STRING_XREFS = 12000;
const MAX_STATIC_STRING_XREF_BUCKETS = 80;
const MAX_STATIC_STRING_XREF_PATTERNS = 120;
const MAX_STATIC_XREF_FUNCTIONS = 96;
const MAX_STATIC_XREF_CALL_TARGETS = 160;
const MAX_STATIC_XREF_PRIORITY_GRAPH_FUNCTIONS = 16;
const MAX_STATIC_XREF_PRIORITY_FIRST_HOPS = 24;
const MAX_STATIC_XREF_PRIORITY_SECOND_HOPS = 32;
const MAX_STATIC_XREF_CANDIDATE_REGIONS = 32;
const MAX_STATIC_XREF_CANDIDATE_SOURCE_FUNCTIONS = 12;
const MAX_STATIC_XREF_CANDIDATE_REGION_FUNCTIONS = 12;
const MAX_STATIC_XREF_INCOMING_CALLERS = 8;
const MAX_STATIC_XREF_OUTGOING_REGIONS = 12;
const MAX_STATIC_XREF_CRYPTO_BRIDGE_PATHS = 8;
const MAX_STATIC_XREF_CRYPTO_BRIDGE_DEPTH = 3;
const MAX_STATIC_XREF_BRIDGE_FUNCTION_PATHS = 12;
const MAX_STATIC_XREF_BRIDGE_FUNCTION_STARTS = 8;
const MAX_STATIC_XREF_BRIDGE_FUNCTION_TARGETS = 16;
const MAX_STATIC_XREF_FUNCTION_XREF_FUNCTIONS = 8;
const MAX_STATIC_XREF_FUNCTION_XREF_NEIGHBOR_BUCKETS = 8;
const STATIC_XREF_FUNCTION_XREF_NEIGHBOR_RADIUS = 0x600;

const MAC_HOME = process.env.HOME || '';
const MAC_XWECHAT_DATA = path.join(MAC_HOME, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Documents', 'xwechat_files');
const MAC_CONFIG_INI = path.join(MAC_HOME, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', '.wechat_config.ini');
const WXDB_MIRROR_ROOT = path.join(DATA_DIR, 'wxdb-mirror');
const WXDB_MIRROR_INDEX = path.join(WXDB_MIRROR_ROOT, 'index.json');
const WXDB_MIRROR_PROCESS_LOCK = path.join(DATA_DIR, '.wxdb-mirror.lock');
const WXDB_MIRROR_ROOT_RELATIVE = 'data/wxdb-mirror';
const WXDB_MIRROR_STABLE_COPY_ATTEMPTS = 8;
const WXDB_MIRROR_GROUP_REUSE_COPY_ATTEMPTS = 2;
const WXDB_MIRROR_RETRY_DELAYS_MS = [250, 500, 1000, 1500, 2500, 4000, 6000];
const SQLITE_PERSISTED_SIDECAR_SUFFIXES = ['-wal', '-journal'];
// session.db changes with ordinary message traffic and only enriches group
// ordering. Group identity comes from contact.db, so do not make a selector
// refresh wait for a globally stable session snapshot.
const WXDB_MIRROR_GROUP_CATEGORIES = ['contact', 'session'];
const WXDB_MIRROR_IDENTITY_CATEGORIES = ['message', 'contact', 'session'];
const WXDB_MIRROR_DIGEST_CATEGORIES = ['message', 'contact', 'session', 'hardlink'];
const WXDB_MIRROR_IMPORT_LOCKS = new Map();
const WXDB_MIRROR_INDEX_LOCK_KEY = '__mirror_index__';
const WXDB_MIRROR_LOCK_QUEUE_LIMIT = 32;
const WXDB_MIRROR_PROCESS_LOCK_WAIT_MS = 10 * 60 * 1000;
const WXDB_MIRROR_PROCESS_LOCK_HEARTBEAT_MS = 5 * 1000;
const WXDB_MIRROR_PROCESS_LOCK_STALE_GRACE_MS = 30 * 1000;
const WXDB_MIRROR_CONTENT_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const WXDB_MIRROR_LOCK_CONTEXT = new AsyncLocalStorage();
const WXDB_MIRROR_LOCK_OPTIONS_CONTEXT = new AsyncLocalStorage();
const WXDB_MIRROR_INDEX_WRITE_CONTEXT = new AsyncLocalStorage();
const ACTIVE_WXDB_MIRROR_TASKS = new Map();
let NEXT_WXDB_MIRROR_TASK_ID = 1;
let WXDB_MIRROR_TASK_ADMISSION_CLOSED = false;
let WXDB_MIRROR_TASK_SHUTDOWN_MESSAGE = '';
let WXDB_MIRROR_SELF_PROCESS_START_ID = null;
const WXDB_MIRROR_SELF_PROCESS_START_EPOCH_MS = Math.max(1, Math.round(Date.now() - (process.uptime() * 1000)));
const PROCESS_START_IDENTITY_EPOCH_TOLERANCE_MS = 2000;
let WXDB_MIRROR_INDEX_INVALID_INFO = null;

export function isConfirmedMainWeixinProcess(candidate = null) {
  if (candidate?.is_main !== true) return false;
  const confidence = String(candidate?.main_process_confidence || '').trim();
  return !confidence || confidence === 'command_line';
}

function compareWeixinProcessPreference(left, right) {
  const confirmedMainDiff = Number(isConfirmedMainWeixinProcess(right)) - Number(isConfirmedMainWeixinProcess(left));
  if (confirmedMainDiff) return confirmedMainDiff;
  const workingSetDiff = Number(right?.working_set_bytes || 0) - Number(left?.working_set_bytes || 0);
  if (workingSetDiff) return workingSetDiff;
  const privateMemoryDiff = Number(right?.private_memory_bytes || 0) - Number(left?.private_memory_bytes || 0);
  if (privateMemoryDiff) return privateMemoryDiff;
  return Number(left?.pid || 0) - Number(right?.pid || 0);
}

export function preferredWeixinProcess(processes = []) {
  return [...(Array.isArray(processes) ? processes : [])].sort(compareWeixinProcessPreference)[0] || null;
}

export function normalizeWindowsWeixinProcesses(parsed, { commandLineUnavailable = false } = {}) {
  if (!parsed) return [];
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map(p => {
    const commandLine = commandLineUnavailable ? '' : String(p.CommandLine || '');
    const isMain = isMainWeixinProcess(commandLine);
    return {
      pid: Number(p.ProcessId ?? p.process_id ?? p.Id),
      path: p.ExecutablePath || p.Path || '',
      command_line: commandLine,
      started_at: String(p.CreationDate || p.StartTime || ''),
      working_set_bytes: Math.max(0, Number(p.WorkingSet64 ?? p.WorkingSetSize ?? 0) || 0),
      private_memory_bytes: Math.max(0, Number(p.PrivateMemorySize64 ?? p.PrivatePageCount ?? 0) || 0),
      is_main: isMain,
      main_process_confidence: isMain ? 'command_line' : (commandLine ? 'command_line_excluded' : 'unknown'),
    };
  })
    .filter(p => Number.isInteger(p.pid) && p.pid > 0)
    .sort(compareWeixinProcessPreference);
}

export async function getWeixinProcesses({ signal = null } = {}) {
  throwIfDiscoveryAborted(signal);
  if (process.platform === 'darwin') {
    return getMacWeixinProcesses({ signal });
  }
  if (process.platform !== 'win32') {
    return [];
  }
  try {
    if (!WINDOWS_POWERSHELL_EXE) return [];
    const out = await execFileText(WINDOWS_POWERSHELL_EXE, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; $items = @(Get-Process -Name Weixin -ErrorAction SilentlyContinue | ForEach-Object { $path = \'\'; try { $path = $_.Path } catch {}; $start = \'\'; try { $start = $_.StartTime.ToUniversalTime().ToString(\'o\') } catch {}; [pscustomobject]@{ ProcessId = $_.Id; Path = $path; StartTime = $start; CommandLine = \'\'; WorkingSet64 = $_.WorkingSet64; PrivateMemorySize64 = $_.PrivateMemorySize64 } }); if ($items.Count -eq 1) { $items[0] | ConvertTo-Json -Compress } else { $items | ConvertTo-Json -Compress }',
    ], { signal });
    throwIfDiscoveryAborted(signal);
    if (!out.trim()) return [];
    return normalizeWindowsWeixinProcesses(JSON.parse(out), { commandLineUnavailable: true });
  } catch (e) {
    if (isDiscoveryAbort(e, signal)) throw e;
    const primaryError = e;
    try {
      if (!WINDOWS_POWERSHELL_EXE) return processEnumerationFailure(primaryError);
      const fallbackCommand = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; Get-CimInstance Win32_Process -Filter "name = \'Weixin.exe\'" | Select-Object ProcessId,ExecutablePath,CommandLine,CreationDate,WorkingSetSize,PrivatePageCount | ConvertTo-Json -Compress';
      const out = await execFileText(WINDOWS_POWERSHELL_EXE, [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        fallbackCommand,
      ], { signal });
      throwIfDiscoveryAborted(signal);
      return normalizeWindowsWeixinProcesses(out.trim() ? JSON.parse(out) : []);
    } catch (fallbackError) {
      if (isDiscoveryAbort(fallbackError, signal)) throw fallbackError;
      const combined = new Error(`主进程查询失败；备用进程查询也失败：${String(fallbackError?.message || fallbackError || primaryError?.message || '').replace(/\s+/g, ' ').trim()}`);
      combined.code = 'process_enumeration_failed';
      return processEnumerationFailure(combined);
    }
  }
}

function processEnumerationFailure(error = null) {
  const message = String(error?.message || error || '无法枚举微信进程').replace(/\s+/g, ' ').trim().slice(0, 240);
  const processes = [];
  Object.defineProperties(processes, {
    process_enumeration_failed: { value: true, enumerable: false },
    process_enumeration_error: { value: message || '无法枚举微信进程', enumerable: false },
    process_enumeration_code: { value: String(error?.code || 'process_enumeration_failed').trim() || 'process_enumeration_failed', enumerable: false },
  });
  return processes;
}

export function isMainWeixinProcess(commandLine) {
  const text = String(commandLine || '');
  return /Weixin\.exe/i.test(text) && !/--type=/i.test(text);
}

export function isMainMacWeixinProcess(commandLine) {
  const text = String(commandLine || '').trim();
  return /\/WeChat$/i.test(text) && !/Sparkle|Updater|Installer/i.test(text);
}

async function getMacWeixinProcesses({ signal = null } = {}) {
  throwIfDiscoveryAborted(signal);
  try {
    const out = await execFileText('/usr/bin/pgrep', ['-f', '/WeChat$'], { signal });
    throwIfDiscoveryAborted(signal);
    if (!out.trim()) return [];
    const pids = out.trim().split(/\s+/).map(s => parseInt(s.trim())).filter(n => Number.isFinite(n) && n > 0);
    const results = [];
    for (const pid of pids) {
      throwIfDiscoveryAborted(signal);
      try {
        const cmdline = await execFileText('/bin/ps', ['-p', String(pid), '-o', 'comm='], { signal });
        const p = cmdline.trim() || '';
        results.push({
          pid,
          path: p,
          command_line: p,
          is_main: isMainMacWeixinProcess(p),
          main_process_confidence: 'command_line',
        });
      } catch (e) {
        if (isDiscoveryAbort(e, signal)) throw e;
      }
    }
    return results.filter(p => p.is_main);
  } catch (e) {
    if (isDiscoveryAbort(e, signal)) throw e;
    return processEnumerationFailure(e);
  }
}

export async function readConfiguredDataRoots({ signal = null } = {}) {
  const result = await readConfiguredDataRootsResult({ signal });
  if (!result.roots.length && result.unreadable.length) {
    throw sourceDiscoveryAggregateError(result.unreadable, '微信配置的数据目录不可读');
  }
  return result.roots;
}

async function readConfiguredDataRootsResult({ signal = null } = {}) {
  throwIfDiscoveryAborted(signal);
  const candidates = [];
  const unreadable = [];
  if (process.platform === 'darwin') {
    try {
      const text = await fsp.readFile(MAC_CONFIG_INI, 'utf-8');
      throwIfDiscoveryAborted(signal);
      const line = text.split(/\r?\n/).map(s => s.trim()).find(Boolean);
      if (line && path.isAbsolute(line)) candidates.push(line);
    } catch (e) {
      if (isDiscoveryAbort(e, signal)) throw e;
      if (!['ENOENT', 'ENOTDIR'].includes(String(e?.code || ''))) {
        unreadable.push(sourceDiscoveryIssue(sourceDirectoryUnreadableError('微信配置文件', e), {
          scope: 'configuration_file',
          configuration_file: MAC_CONFIG_INI,
        }));
      }
    }
    try {
      const st = await fsp.stat(MAC_XWECHAT_DATA);
      throwIfDiscoveryAborted(signal);
      if (st.isDirectory()) candidates.push(MAC_XWECHAT_DATA);
    } catch (e) {
      if (isDiscoveryAbort(e, signal)) throw e;
      if (!['ENOENT', 'ENOTDIR'].includes(String(e?.code || ''))) {
        unreadable.push(sourceDiscoveryIssue(sourceDirectoryUnreadableError('Mac 微信数据目录', e), {
          scope: 'root',
          data_root: MAC_XWECHAT_DATA,
        }));
      }
    }
    return { roots: uniqueConfiguredDataRoots(candidates), unreadable };
  }
  let files = [];
  try {
    files = await fsp.readdir(XWECHAT_CONFIG_DIR, { withFileTypes: true });
  } catch (e) {
    if (isDiscoveryAbort(e, signal)) throw e;
    if (!['ENOENT', 'ENOTDIR'].includes(String(e?.code || ''))) {
      unreadable.push(sourceDiscoveryIssue(sourceDirectoryUnreadableError('微信配置目录', e), {
        scope: 'configuration',
        configuration_file: XWECHAT_CONFIG_DIR,
      }));
    }
    return { roots: [], unreadable };
  }
  return readWindowsConfiguredDataRootEntries(files, {
    config_dir: XWECHAT_CONFIG_DIR,
    signal,
  });
}

async function readWindowsConfiguredDataRootEntries(entries = [], {
  config_dir = XWECHAT_CONFIG_DIR,
  read_file = fsp.readFile,
  signal = null,
} = {}) {
  const candidates = [];
  const unreadable = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    throwIfDiscoveryAborted(signal);
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.ini')) continue;
    const file = path.join(config_dir, entry.name);
    let text = '';
    try {
      text = await read_file(file, 'utf-8');
    } catch (e) {
      if (isDiscoveryAbort(e, signal)) throw e;
      if (['ENOENT', 'ENOTDIR'].includes(String(e?.code || ''))) continue;
      unreadable.push(sourceDiscoveryIssue(sourceDirectoryUnreadableError(`微信配置文件 ${entry.name}`, e), {
        scope: 'configuration_file',
        configuration_file: file,
      }));
      continue;
    }
    const line = text.split(/\r?\n/).map(s => s.trim()).find(Boolean);
    const root = normalizeWindowsConfiguredDataRoot(line);
    if (root) candidates.push(root);
  }
  return { roots: uniqueConfiguredDataRoots(candidates), unreadable };
}

function uniqueConfiguredDataRoots(roots = []) {
  const out = [];
  const seen = new Set();
  for (const root of roots) {
    const value = String(root || '').trim();
    if (!value) continue;
    const key = platformPathIdentity(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function platformPathIdentity(value = '') {
  const text = String(value || '').trim();
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

function normalizeWindowsConfiguredDataRoot(line = '') {
  const raw = String(line || '').trim();
  if (!raw) return '';
  const documents = path.join(process.env.USERPROFILE || '', 'Documents');
  const myDocument = raw.match(/^MyDocument:(.*)$/i);
  if (myDocument && documents) {
    const suffix = String(myDocument[1] || '').replace(/^[\\/]+/, '');
    return suffix ? path.join(documents, suffix) : documents;
  }
  const expanded = raw.replace(/%([^%]+)%/g, (_match, name) => process.env[String(name || '')] || '');
  return path.isAbsolute(expanded) ? expanded : '';
}

export async function discoverDataRoots({ signal = null } = {}) {
  const result = await discoverDataRootsResult({ signal });
  if (!result.roots.length && result.unreadable.length) {
    throw sourceDiscoveryAggregateError(result.unreadable, '微信数据根目录均不可读');
  }
  return result.roots;
}

async function discoverDataRootsResult({ signal = null } = {}) {
  throwIfDiscoveryAborted(signal);
  const roots = [];
  const unreadable = [];
  const configured = await readConfiguredDataRootsResult({ signal });
  roots.push(...configured.roots);
  unreadable.push(...configured.unreadable);
  if (process.platform === 'darwin') {
    roots.push(MAC_XWECHAT_DATA);
  } else {
    roots.push(
      path.join(process.env.APPDATA || '', 'Tencent', 'xwechat'),
      path.join(process.env.USERPROFILE || '', 'Documents'),
      path.join(process.env.USERPROFILE || '', 'Documents', 'xwechat_files'),
      path.join(process.env.USERPROFILE || '', 'Documents', 'WeChat Files'),
    );
  }

  const result = await discoverDataRootsFromCandidates(roots, { signal });
  return {
    roots: result.roots,
    unreadable: [...unreadable, ...result.unreadable],
  };
}

async function discoverDataRootsFromCandidates(roots = [], { signal = null } = {}) {
  const existing = [];
  const unreadable = [];
  const seen = new Set();
  for (const root of roots) {
    throwIfDiscoveryAborted(signal);
    const key = platformPathIdentity(root);
    if (!root || seen.has(key)) continue;
    seen.add(key);
    let st = null;
    try {
      st = await fsp.stat(root);
    } catch (e) {
      if (isDiscoveryAbort(e, signal)) throw e;
      if (['ENOENT', 'ENOTDIR'].includes(String(e?.code || ''))) continue;
      unreadable.push(sourceDiscoveryIssue(sourceDirectoryUnreadableError(`微信数据根目录 ${root}`, e), {
        scope: 'root',
        data_root: root,
      }));
      continue;
    }
    if (st?.isDirectory()) existing.push(root);
  }
  return { roots: existing, unreadable };
}

export async function discoverWxAccounts({ signal = null, data_roots = null, data_root_unreadable = [] } = {}) {
  throwIfDiscoveryAborted(signal);
  // Normal reads prepare the project mirror automatically. Source probing here
  // stays at account-dir discovery; DB inventory, SQLCipher checks and message
  // reads happen after db_storage has been copied into data/wxdb-mirror.
  const providedDataRoots = Array.isArray(data_roots)
    ? data_roots.map(root => String(root || '').trim()).filter(Boolean)
    : null;
  const sourceDiscovery = providedDataRoots
    ? await sourceWxAccountDiscoveryFromDataRoots(providedDataRoots, { signal })
    : await discoverSourceWxAccountsResult({ signal });
  if (providedDataRoots && Array.isArray(data_root_unreadable) && data_root_unreadable.length) {
    sourceDiscovery.unreadable.unshift(...data_root_unreadable);
  }
  const sourceAccounts = sourceDiscovery.accounts;
  const sourceDiscoveryError = !sourceAccounts.length && sourceDiscovery.unreadable.length
    ? sourceDiscoveryAggregateError(sourceDiscovery.unreadable, '微信账号目录均不可读')
    : null;
  throwIfDiscoveryAborted(signal);
  const mirrored = await discoverMirroredWxAccounts(sourceAccounts, {
    signal,
    unreadable: sourceDiscovery.unreadable,
  });
  const accounts = mergeMirroredWxAccounts(sourceAccounts, mirrored);
  for (const unreadableAccount of unreadableSourceAccountsFromDiscovery(sourceDiscovery.unreadable)) {
    const alreadyRepresented = accounts.some(account => {
      if (String(account?.account_id || '').trim() === unreadableAccount.account_id) return true;
      const sourcePath = String(account?.source_db_storage || account?.mirror?.source_db_storage || '').trim();
      return sourcePath && sameRealPath(sourcePath, unreadableAccount.db_storage);
    });
    if (!alreadyRepresented) accounts.push(unreadableAccount);
  }
  if (sourceDiscoveryError && !accounts.length) throw sourceDiscoveryError;
  if (WXDB_MIRROR_INDEX_INVALID_INFO) {
    for (const account of accounts) {
      account.mirror_index_status = WXDB_MIRROR_INDEX_INVALID_INFO.status;
      account.mirror_index_backup_relative_path = WXDB_MIRROR_INDEX_INVALID_INFO.backup_relative_path;
      account.mirror_index_error = WXDB_MIRROR_INDEX_INVALID_INFO.error;
    }
  }
  accounts.sort(compareAccountsByLastWriteDesc);
  return accounts;
}

function safeDiscoveryTimeMs(value = '') {
  const text = String(value || '').trim();
  if (!text) return 0;
  const utc = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/);
  if (utc) return checkedDiscoveryDateMs(utc, { utc: true });
  const local = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/);
  if (local) return checkedDiscoveryDateMs(local, { utc: false });
  return 0;
}

function checkedDiscoveryDateMs(match, { utc = false } = {}) {
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

function accountDiscoveryLastWriteTimeMs(account = {}) {
  return Math.max(
    safeDiscoveryTimeMs(account?.summary?.last_write_time),
    safeDiscoveryTimeMs(account?.last_write_time),
  );
}

function compareAccountsByLastWriteDesc(a = {}, b = {}) {
  const byTime = accountDiscoveryLastWriteTimeMs(b) - accountDiscoveryLastWriteTimeMs(a);
  if (byTime) return byTime;
  return String(a.account_id || a.id || a.wxid || '').localeCompare(String(b.account_id || b.id || b.wxid || ''));
}

export function hasWxDbMirrorIdentityAnchor(account = {}) {
  const mirror = account?.mirror && typeof account.mirror === 'object' ? account.mirror : {};
  const identityIds = [account?.identity_id, mirror.identity_id]
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  const verifiedSelfWxids = [account?.verified_self_wxid, mirror.verified_self_wxid]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  const identityId = identityIds[0] || '';
  const verifiedSelfWxid = verifiedSelfWxids[0] || '';
  const expectedIdentityId = verifiedSelfWxid
    ? `wxacct_${crypto.createHash('sha256').update(verifiedSelfWxid).digest('hex').slice(0, 24)}`
    : '';
  const identityStatuses = [account?.identity_status, mirror.identity_status]
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  return identityIds.length > 0
    && identityIds.every(value => value === identityId)
    && verifiedSelfWxids.length > 0
    && verifiedSelfWxids.every(value => value === verifiedSelfWxid)
    && identityStatuses.length > 0
    && identityStatuses.every(status => status === 'verified')
    && /^wxacct_[a-f0-9]{24}$/.test(identityId)
    && identityId === expectedIdentityId;
}

export function isWxDbMirrorIdentityVerified(account = {}) {
  if (!hasWxDbMirrorIdentityAnchor(account)) return false;
  const mirror = account?.mirror && typeof account.mirror === 'object' ? account.mirror : {};
  const generationStatuses = [account?.identity_generation_status, mirror.identity_generation_status]
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  const generationEvidenceTypes = [account?.identity_generation_evidence?.type, mirror.identity_generation_evidence?.type]
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  const sourceAvailable = mirror.source_available === true || account?.source_available === true;
  const sourceExplicitlyUnavailable = mirror.source_available === false || account?.source_available === false;
  const sourceGenerationHash = String(account?.source_generation_hash || mirror.source_generation_hash || '').trim().toLowerCase();
  const identitySourceGenerationHash = String(account?.identity_source_generation_hash || mirror.identity_source_generation_hash || '').trim().toLowerCase();
  const hasGenerationBinding = !!(sourceGenerationHash || identitySourceGenerationHash);
  const onlineGenerationCurrent = sourceExplicitlyUnavailable
    || ((!sourceAvailable && !hasGenerationBinding)
      || (/^[a-f0-9]{64}$/.test(sourceGenerationHash)
      && /^[a-f0-9]{64}$/.test(identitySourceGenerationHash)
      && sourceGenerationHash === identitySourceGenerationHash));
  return onlineGenerationCurrent
    && generationStatuses.length > 0
    && generationStatuses.every(status => status === 'verified')
    && !generationEvidenceTypes.includes('account_bound_key_reopened_contact');
}

async function discoverMirroredWxAccounts(sourceAccounts = [], {
  signal = null,
  account_id = '',
  resolve_source = true,
  unreadable = [],
} = {}) {
  throwIfDiscoveryAborted(signal);
  const requestedAccountId = String(account_id || '').trim().toLowerCase();
  const index = await readMirrorIndex();
  const mirrors = [];
  for (const [accountId, item] of Object.entries(index.accounts || {})) {
    throwIfDiscoveryAborted(signal);
    if (requestedAccountId && String(accountId || '').trim().toLowerCase() !== requestedAccountId) continue;
    const mirrorSegment = safeMirrorSegment(item.mirror_segment || accountId);
    const accountRoot = path.join(WXDB_MIRROR_ROOT, mirrorSegment);
    const dbStorage = path.join(accountRoot, 'db_storage');
    await assertSafeMirrorTargetRoot(accountRoot);
    await assertSafeMirrorTargetRoot(dbStorage);
    const dbStat = await statMirrorTargetDbStorage(dbStorage, { signal });
    if (!dbStat) continue;
    const summary = await summarizeDbStorage(dbStorage, { signal });
    const sourceResolution = resolve_source
      ? await safeMirrorSourceAccountResolution(sourceAccounts, accountId, item, { signal, unreadable })
      : { status: 'missing', source: null };
    const source = sourceResolution.source || {};
    const sourceStatus = sourceResolution.status || 'missing';
    const sourceAvailable = sourceStatus === 'available';
    const sourceLastWriteTime = sourceAvailable ? (sourceAccountLastWriteTime(source) || mirrorIndexSourceLastWriteTime(item)) : '';
    const mirrorLastWriteTime = mirrorIndexMirrorLastWriteTime(item, summary, dbStat);
    const sourceLooksNewer = mirrorSourceLooksNewerThanMirror(sourceLastWriteTime, mirrorLastWriteTime);
    const accountRefreshReason = sourceLooksNewer ? 'pending_source_check' : (item.refresh_reason || '');
    const accountRefreshReasonLabel = sourceLooksNewer
      ? '源库可能有新写入，读取前自动复核/刷新'
      : (item.refresh_reason_label || (item.refresh_reason ? mirrorRefreshReasonLabel(item.refresh_reason) : '本地工作数据已存在，读取前自动复核'));
    const accountRefreshAction = sourceLooksNewer
      ? 'pending_check'
      : (item.refresh_action || (item.refresh_reason ? mirrorRefreshAction(item.refresh_reason) : 'pending_check'));
    const legacyId = String(item.legacy_id || source.legacy_id || source.id || mirrorSegment).trim();
    const verifiedSelfWxid = String(item.verified_self_wxid || '').trim();
    const identityId = String(item.identity_id || '').trim();
    const identityGenerationEvidence = plainObject(item.identity_generation_evidence) ? item.identity_generation_evidence : null;
    const indexedSourceGenerationHash = String(item.source_generation_hash || '').trim().toLowerCase();
    const sourceGenerationHash = sourceAvailable
      ? sourceAccountGenerationHash(source)
      : indexedSourceGenerationHash;
    const identitySourceGenerationHash = String(item.identity_source_generation_hash || '').trim().toLowerCase();
    const indexedGenerationStatus = String(item.identity_generation_status || '').trim();
    const identityGenerationStatus = String(indexedGenerationStatus).toLowerCase() === 'verified'
      && (String(identityGenerationEvidence?.type || '').trim().toLowerCase() === 'account_bound_key_reopened_contact'
        || (sourceAvailable && !mirrorIdentitySourceGenerationCurrent(item, sourceGenerationHash)))
      ? 'pending_validation'
      : indexedGenerationStatus;
    const wxid = String(verifiedSelfWxid || item.wxid || source.wxid || accountNameToWxid(legacyId)).trim();
    const aliases = [...new Set([
      accountId,
      identityId,
      source.account_id,
      source.id,
      legacyId,
      wxid,
      ...(Array.isArray(item.account_aliases) ? item.account_aliases : []),
      ...(Array.isArray(source.account_aliases) ? source.account_aliases : []),
    ].filter(Boolean))];
    mirrors.push({
      account_id: accountId,
      storage_id: accountId,
      identity_id: identityId,
      verified_self_wxid: verifiedSelfWxid,
      identity_status: String(item.identity_status || (verifiedSelfWxid ? 'verified' : 'unverified')).trim(),
      identity_verified_at: String(item.identity_verified_at || '').trim(),
      identity_generation_status: identityGenerationStatus,
      identity_generation_changed_at: String(item.identity_generation_changed_at || '').trim(),
      identity_generation_verified_at: String(item.identity_generation_verified_at || '').trim(),
      identity_generation_evidence: identityGenerationEvidence,
      identity_source_generation_hash: identitySourceGenerationHash,
      source_generation_hash: sourceGenerationHash,
      id: accountId,
      legacy_id: legacyId,
      wxid,
      display_name: String(item.display_name || source.display_name || accountNameToDisplay(legacyId)).trim(),
      account_aliases: aliases,
      account_root: accountRoot,
      db_storage: dbStorage,
      source_account_root: source.account_root || item.source_account_root || '',
      source_db_storage: source.db_storage || item.source_db_storage || '',
      source_db_storage_realpath: source.db_storage_realpath || item.source_db_storage_realpath || '',
      source_last_write_time: sourceLastWriteTime,
      mirror_last_write_time: mirrorLastWriteTime,
      last_write_time: sourceLastWriteTime || summary.last_write_time || dbStat.mtime.toISOString(),
      summary,
      source: 'project-mirror',
      mirror: {
        root: accountRoot,
        relative_root: `${WXDB_MIRROR_ROOT_RELATIVE}/${mirrorSegment}`,
        imported_at: item.imported_at || '',
        refreshed_at: item.refreshed_at || item.imported_at || '',
        checked_at: item.checked_at || item.refreshed_at || item.imported_at || '',
        source_account_id: accountId,
        identity_id: identityId,
        verified_self_wxid: verifiedSelfWxid,
        identity_status: String(item.identity_status || (verifiedSelfWxid ? 'verified' : 'unverified')).trim(),
        identity_verified_at: String(item.identity_verified_at || '').trim(),
        identity_generation_status: identityGenerationStatus,
        identity_generation_changed_at: String(item.identity_generation_changed_at || '').trim(),
        identity_generation_verified_at: String(item.identity_generation_verified_at || '').trim(),
        identity_generation_evidence: identityGenerationEvidence,
        identity_source_generation_hash: identitySourceGenerationHash,
        identity_evidence: plainObject(item.identity_evidence) ? item.identity_evidence : null,
        source_generation_hash: sourceGenerationHash,
        source_last_write_time: sourceLastWriteTime,
        mirror_last_write_time: mirrorLastWriteTime,
        source_snapshot_meta_hash: item.source_snapshot_meta_hash || '',
        published_manifest_hash: String(item.published_manifest_hash || '').trim().toLowerCase(),
        source_scopes: plainObject(item.source_scopes) ? item.source_scopes : {},
        refresh_reason: accountRefreshReason,
        refresh_reason_label: accountRefreshReasonLabel,
        refresh_action: accountRefreshAction,
        source_available: sourceAvailable,
        source_status: sourceStatus,
        source_status_label: mirrorSourceStatusLabel(sourceStatus),
      },
    });
  }
  return mirrors;
}

export async function readWxDbMirrorAccount(accountId = '', { signal = null } = {}) {
  throwIfDiscoveryAborted(signal);
  const requestedAccountId = String(accountId || '').trim().toLowerCase();
  if (!/^wxacc_[a-f0-9]{16}$/.test(requestedAccountId)) return null;
  const accounts = await discoverMirroredWxAccounts([], {
    signal,
    account_id: requestedAccountId,
    resolve_source: false,
  });
  return accounts.length === 1 ? accounts[0] : null;
}

function mirrorSourceLooksNewerThanMirror(sourceLastWriteTime = '', mirrorLastWriteTime = '') {
  const sourceTs = safeDiscoveryTimeMs(sourceLastWriteTime);
  const mirrorTs = safeDiscoveryTimeMs(mirrorLastWriteTime);
  return sourceTs > 0
    && mirrorTs > 0
    && sourceTs > mirrorTs + 2000;
}

function mergeMirroredWxAccounts(sourceAccounts = [], mirrors = []) {
  const mirrorById = new Map(mirrors.map(account => [String(account.account_id || '').trim(), account]));
  const out = [];
  for (const account of sourceAccounts) {
    const accountId = String(account.account_id || '').trim();
    const directMirror = accountId ? mirrorById.get(accountId) : null;
    const aliasMirror = directMirror ? null : mirrorForSourceAccount(mirrorById, account);
    const mirror = directMirror || aliasMirror?.mirror || null;
    const mirrorKey = directMirror ? accountId : aliasMirror?.key || '';
    if (mirror) {
      if (!mirrorSourceAvailableForMerge(mirror)) {
        // The live source account is authoritative when it is discoverable; do not append its stale mirror as a second account.
        if (mirrorKey) mirrorById.delete(mirrorKey);
        out.push(account);
        continue;
      }
      const sourceLastWriteTime = String(sourceAccountLastWriteTime(account) || mirror.source_last_write_time || mirror.mirror?.source_last_write_time || '').trim();
      mirror.source_account_root = account.account_root || mirror.source_account_root || '';
      mirror.source_db_storage = account.db_storage || mirror.source_db_storage || '';
      mirror.source_last_write_time = sourceLastWriteTime;
      mirror.last_write_time = sourceLastWriteTime || mirror.last_write_time || mirror.summary?.last_write_time || '';
      mirror.account_aliases = [...new Set([...(mirror.account_aliases || []), account.account_id, ...(account.account_aliases || []), account.id, account.wxid].filter(Boolean))];
      if (mirror.mirror && typeof mirror.mirror === 'object') {
        mirror.mirror.source_available = true;
        mirror.mirror.source_status = 'available';
        mirror.mirror.source_status_label = mirrorSourceStatusLabel('available');
        mirror.mirror.source_last_write_time = sourceLastWriteTime;
      }
      out.push(mirror);
      if (mirrorKey) mirrorById.delete(mirrorKey);
    } else {
      out.push(account);
    }
  }
  out.push(...mirrorById.values());
  return out;
}

function mirrorSourceAvailableForMerge(mirror = {}) {
  return mirror?.source === 'project-mirror'
    && mirror?.mirror?.source_available === true
    && String(mirror?.mirror?.source_status || '').trim() === 'available';
}

function mirrorForSourceAccount(mirrorById = new Map(), source = {}) {
  const aliases = [
    source.account_id,
    source.id,
    source.legacy_id,
    source.wxid,
    ...(Array.isArray(source.account_aliases) ? source.account_aliases : []),
  ].map(value => String(value || '').trim()).filter(Boolean);
  if (!aliases.length) return null;
  const matches = [];
  for (const [key, mirror] of mirrorById.entries()) {
    const boundStorage = String(mirror?.source_db_storage_realpath || mirror?.source_db_storage || '').trim();
    const sourceStorage = String(source?.db_storage_realpath || source?.db_storage || '').trim();
    if (boundStorage && sourceStorage && !sameRealPath(boundStorage, sourceStorage)) continue;
    if (aliases.some(alias => accountMatchesId(mirror, alias))) {
      matches.push({ key, mirror });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function mirrorRefreshReason({
  force = false,
  targetExists = false,
  targetMatchesSnapshot = false,
  existingSnapshotMetaHash = '',
  sourceSnapshotMetaHash = '',
} = {}) {
  if (force) return 'force_rebuild';
  if (!targetExists) return 'first_copy';
  if (!existingSnapshotMetaHash) return 'missing_snapshot_index';
  if (String(existingSnapshotMetaHash || '') !== String(sourceSnapshotMetaHash || '')) return 'source_snapshot_changed';
  if (!targetMatchesSnapshot) return 'target_incomplete_or_stale';
  return 'source_snapshot_unchanged';
}

function mirrorRefreshDecision(input = {}) {
  const reason = mirrorRefreshReason(input);
  const action = mirrorRefreshAction(reason);
  return {
    reason,
    action,
    label: mirrorRefreshReasonLabel(reason),
    should_refresh: reason !== 'source_snapshot_unchanged',
  };
}

function mirrorRefreshReasonLabel(reason = '') {
  switch (String(reason || '')) {
    case 'source_snapshot_unchanged':
      return '源库文件元数据未变化，本地工作数据完整';
    case 'first_copy':
      return '首次读取，自动准备本地工作数据';
    case 'source_snapshot_changed':
      return '源库文件元数据变化，自动更新本地工作数据';
    case 'target_incomplete_or_stale':
      return '本地工作数据不完整或与源库不一致，自动重建';
    case 'missing_snapshot_index':
      return '本地工作数据缺少快照记录，自动重建';
    case 'force_rebuild':
      return '强制更新本地工作数据';
    default:
      return '自动准备本地工作数据';
  }
}

function mirrorScopeForReason(reason = '') {
  const cleanReason = String(reason || '').trim();
  if (cleanReason === 'groups') {
    return {
      key: 'groups',
      label: '群列表',
      categories: WXDB_MIRROR_GROUP_CATEGORIES,
      allowExtraTargetFiles: true,
      overlayExistingMirror: true,
    };
  }
  if (cleanReason === 'identity') {
    return {
      key: 'identity',
      label: '账号身份',
      categories: WXDB_MIRROR_IDENTITY_CATEGORIES,
      allowExtraTargetFiles: true,
      overlayExistingMirror: true,
      partialMessageCategory: true,
    };
  }
  if (cleanReason === 'digest') {
    return {
      key: 'digest',
      label: '摘要读取',
      categories: WXDB_MIRROR_DIGEST_CATEGORIES,
      allowExtraTargetFiles: true,
      overlayExistingMirror: true,
    };
  }
  return {
    key: 'full',
    label: '完整数据库',
    categories: [],
    allowExtraTargetFiles: false,
    overlayExistingMirror: false,
  };
}

// A broader verified project mirror can safely serve a narrower read. Keep the
// coverage order here so offline reuse and account-bound settings validation do
// not disagree about the same published snapshot.
export function wxDbMirrorScopeCoverageCandidates(scope = '') {
  const requested = String(typeof scope === 'object' && scope !== null ? scope.key : scope).trim().toLowerCase();
  if (requested === 'groups') return ['groups', 'identity', 'digest', 'full'];
  if (requested === 'identity') return ['identity', 'digest', 'full'];
  if (['digest', 'message', 'messages'].includes(requested)) return ['digest', 'full'];
  return ['full'];
}

export function wxDbMirrorScopeRecordsForRead(mirror = {}, scope = '') {
  const source = plainObject(mirror) ? mirror : {};
  const sourceScopes = plainObject(source.source_scopes) ? source.source_scopes : {};
  const records = [];
  for (const key of wxDbMirrorScopeCoverageCandidates(scope)) {
    const scoped = plainObject(sourceScopes[key]) ? sourceScopes[key] : null;
    if (scoped) {
      records.push({ key, record: scoped });
    }
    // Older full-mirror indexes predate source_scopes. They carry the same
    // full manifest at the account root and remain safe after validation.
    if (key === 'full' && (plainObject(source.source_snapshot) || String(source.source_snapshot_meta_hash || '').trim())) {
      records.push({
        key,
        record: {
          ...source,
          source_snapshot: source.source_snapshot,
          source_snapshot_meta_hash: source.source_snapshot_meta_hash,
        },
      });
    }
  }
  return records;
}

function mirrorScopeSnapshotHash(existing = {}, scope = {}, snapshot = null) {
  if (scope.key === 'full') {
    return mirrorSnapshotHashFromIndexedPayload(mirrorIndexedSnapshotForScope(existing, scope, snapshot), snapshot)
      || String(existing.source_snapshot_meta_hash || '');
  }
  // A verified digest/full manifest may contain every file required by a
  // narrower groups read. Prefer that projected manifest when the exact
  // groups record is older, otherwise a successful identity recheck would be
  // invisible to the next groups request and trigger another large refresh.
  const indexedSnapshot = mirrorIndexedSnapshotForScope(existing, scope, snapshot);
  const indexedHash = mirrorSnapshotHashFromIndexedPayload(indexedSnapshot, snapshot);
  if (indexedHash) return indexedHash;
  const scopes = plainObject(existing.source_scopes) ? existing.source_scopes : {};
  const scoped = plainObject(scopes[scope.key]) ? scopes[scope.key] : {};
  const scopedHash = String(scoped.source_snapshot_meta_hash || '');
  if (scopedHash) return scopedHash;
  if (!plainObject(snapshot) || !Array.isArray(snapshot.dbFiles) || !snapshot.dbFiles.length) return '';
  return mirrorSnapshotHashFromIndexedPayload(existing.source_snapshot, snapshot);
}

function mirrorSnapshotCategoryContentHashesMatch(previous = {}, scope = {}, snapshot = null, nextPayload = null, category = '') {
  const wantedCategory = String(category || '').trim().toLowerCase();
  if (!wantedCategory
    || !plainObject(nextPayload)
    || String(nextPayload.target_content_hash_alg || '').trim().toLowerCase() !== 'sha256') return false;
  const categoryHashes = payload => {
    const hashes = new Map();
    for (const file of Array.isArray(payload.files) ? payload.files : []) {
      const relative = normalizeMirrorRelative(file?.relative || '');
      const [fileCategory = ''] = relative.split('/');
      if (fileCategory.toLowerCase() !== wantedCategory) continue;
      const sha256 = String(file?.sha256 || '').trim().toLowerCase();
      if (!relative || !/^[a-f0-9]{64}$/.test(sha256)) return null;
      hashes.set(relative, sha256);
    }
    return hashes;
  };
  const nextHashes = categoryHashes(nextPayload);
  if (!nextHashes || !nextHashes.size) return false;
  const previousPayloads = wxDbMirrorScopeRecordsForRead(previous, scope)
    .map(candidate => candidate?.record?.source_snapshot)
    .filter(plainObject);
  if (plainObject(previous.source_snapshot)) previousPayloads.push(previous.source_snapshot);
  return previousPayloads.some(previousPayload => {
    if (String(previousPayload.target_content_hash_alg || '').trim().toLowerCase() !== 'sha256') return false;
    const previousHashes = categoryHashes(previousPayload);
    if (!previousHashes || !previousHashes.size || previousHashes.size !== nextHashes.size) return false;
    return [...previousHashes].every(([relative, sha256]) => nextHashes.get(relative) === sha256);
  });
}

function mirrorPayloadCategorySourceMetadataMatches(previousPayload = null, snapshot = null, category = '') {
  const wantedCategory = String(category || '').trim().toLowerCase();
  if (!wantedCategory || !plainObject(previousPayload) || !plainObject(snapshot)) return false;
  const categoryMetadata = value => {
    const files = Array.isArray(value?.files) ? value.files : mirrorSnapshotManifest(value || {});
    return files
      .filter(file => normalizeMirrorRelative(file?.relative || '').split('/')[0]?.toLowerCase() === wantedCategory)
      .map(file => ({
        kind: String(file?.kind || '').trim().toLowerCase(),
        relative: normalizeMirrorRelative(file?.relative || ''),
        bytes: Math.max(0, Number(file?.bytes || 0) || 0),
        mtimeMs: Math.max(0, Number(file?.mtimeMs || 0) || 0),
        ctimeMs: Math.max(0, Number(file?.ctimeMs || 0) || 0),
        birthtimeMs: Math.max(0, Number(file?.birthtimeMs || 0) || 0),
        dev: String(file?.dev ?? '').trim(),
        ino: String(file?.ino ?? '').trim(),
      }))
      .filter(file => file.relative && ['db', 'sidecar', 'wal', 'journal'].includes(file.kind))
      .sort((left, right) => left.relative.localeCompare(right.relative) || left.kind.localeCompare(right.kind));
  };
  const currentMetadata = categoryMetadata(snapshot);
  if (!currentMetadata.length) return false;
  if (String(previousPayload.target_content_hash_alg || '').trim().toLowerCase() !== 'sha256') return false;
  const files = Array.isArray(previousPayload.files) ? previousPayload.files : [];
  const categoryFiles = files.filter(file => normalizeMirrorRelative(file?.relative || '').split('/')[0]?.toLowerCase() === wantedCategory);
  if (!categoryFiles.length || categoryFiles.some(file => !/^[a-f0-9]{64}$/i.test(String(file?.sha256 || '').trim()))) return false;
  const previousMetadata = categoryMetadata(previousPayload);
  return previousMetadata.length === currentMetadata.length
    && JSON.stringify(previousMetadata) === JSON.stringify(currentMetadata);
}

function mirrorSnapshotCategorySourceMetadataMatches(previous = {}, scope = {}, snapshot = null, category = '') {
  if (!plainObject(snapshot)) return false;
  const previousPayloads = wxDbMirrorScopeRecordsForRead(previous, scope)
    .map(candidate => candidate?.record?.source_snapshot)
    .filter(plainObject);
  if (plainObject(previous.source_snapshot)) previousPayloads.push(previous.source_snapshot);
  return previousPayloads.some(previousPayload => (
    mirrorPayloadCategorySourceMetadataMatches(previousPayload, snapshot, category)
  ));
}

function mirrorIdentityFieldsForRefresh(previous = {}, scope = {}, snapshot = null, nextPayload = null, {
  identityAnchorCurrent = false,
  sourceGenerationHash = '',
} = {}) {
  const previousHash = mirrorScopeSnapshotHash(previous, scope, snapshot);
  const nextHash = String(snapshot?.hash || '').trim();
  const generationEvidenceType = String(previous?.identity_generation_evidence?.type || '').trim().toLowerCase();
  const unchangedSnapshot = !!previousHash && !!nextHash && previousHash === nextHash;
  if (unchangedSnapshot && generationEvidenceType !== 'account_bound_key_reopened_contact') return {};
  const currentSourceGenerationHash = String(sourceGenerationHash || '').trim().toLowerCase();
  if (identityAnchorCurrent === true && /^[a-f0-9]{64}$/.test(currentSourceGenerationHash)) {
    return {
      identity_generation_status: 'verified',
      identity_generation_changed_at: '',
      identity_source_generation_hash: currentSourceGenerationHash,
    };
  }
  // A second WeChat write can publish another snapshot before the first changed
  // generation finishes revalidation. Keep the last cryptographically bound
  // account identity as an untrusted anchor across every pending generation;
  // reads still have to prove the current generation before returning data.
  if (hasWxDbMirrorIdentityAnchor(previous)) {
    return {
      identity_generation_status: 'pending_validation',
      identity_generation_changed_at: new Date().toISOString(),
      identity_generation_previous_snapshot_meta_hash: previousHash,
      identity_generation_snapshot_meta_hash: nextHash,
    };
  }
  return {
    identity_id: '',
    verified_self_wxid: '',
    identity_status: 'unverified',
    identity_verified_at: '',
    identity_evidence: null,
    identity_generation_status: 'unverified',
    identity_generation_evidence: null,
    identity_generation_changed_at: new Date().toISOString(),
    identity_generation_previous_snapshot_meta_hash: previousHash,
    identity_generation_snapshot_meta_hash: nextHash,
  };
}

function mirrorRefreshIdentityAnchorCurrent(previous = {}, source = {}, scope = {}, snapshot = null, nextPayload = null) {
  if (scope?.key !== 'groups' || !isWxDbMirrorIdentityVerified(previous)) return false;
  const previousHash = mirrorScopeSnapshotHash(previous, scope, snapshot);
  const nextHash = String(snapshot?.hash || '').trim();
  const unchangedSnapshot = !!previousHash && !!nextHash && previousHash === nextHash;
  const previousAccountId = String(previous?.account_id || '').trim();
  const currentAccountId = String(source?.account_id || '').trim();
  const previousSource = String(previous?.source_db_storage || '').trim();
  const currentSource = String(source?.db_storage || '').trim();
  const bindingCurrent = !!previousAccountId
    && !!currentAccountId
    && previousAccountId === currentAccountId
    && !!previousSource
    && !!currentSource
    && sameRealPath(previousSource, currentSource);
  if (!bindingCurrent) return false;
  if (unchangedSnapshot) return true;

  const verifiedSelfWxid = String(previous?.verified_self_wxid || '').trim();
  const sourceWxid = String(source?.wxid || '').trim();
  const identityEvidence = plainObject(previous?.identity_evidence) ? previous.identity_evidence : {};
  const generationEvidenceType = String(previous?.identity_generation_evidence?.type || '').trim().toLowerCase();
  const messageIdentityBound = generationEvidenceType === 'message_identity_proof'
    && wxDbMirrorIdentityProofSufficient(identityEvidence);
  if (!verifiedSelfWxid || sourceWxid !== verifiedSelfWxid || !messageIdentityBound) return false;

  const sourceGenerationHash = String(source?.source_generation_hash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sourceGenerationHash)) return false;
  const contactContentCurrent = plainObject(nextPayload)
    && mirrorSnapshotCategoryContentHashesMatch(previous, scope, snapshot, nextPayload, 'contact');
  const contactSourceMetadataCurrent = mirrorSnapshotCategorySourceMetadataMatches(previous, scope, snapshot, 'contact');
  return contactContentCurrent || contactSourceMetadataCurrent;
}

function mirrorSnapshotIndexPayload(snapshot = {}) {
  return {
    db_count: Number(snapshot.db_count || 0) || 0,
    bytes: Number(snapshot.bytes || 0) || 0,
    last_write_time: snapshot.last_write_time || '',
    ...(Number(snapshot.eligible_message_count || 0) > 0 ? {
      eligible_message_count: Number(snapshot.eligible_message_count || 0) || 0,
      selected_message_count: Number(snapshot.selected_message_count || 0) || 0,
      selection_limit: Number(snapshot.selection_limit || 0) || 0,
      selection_strategy: String(snapshot.selection_strategy || '').trim(),
    } : {}),
    files: mirrorSnapshotManifest(snapshot),
  };
}

function projectIndexedMirrorPayloadToSnapshot(indexed = {}, snapshot = {}, { targetContentVerifiedAt = '' } = {}) {
  const payload = mirrorSnapshotIndexPayload(snapshot);
  if (String(indexed?.target_content_hash_alg || '').trim().toLowerCase() !== 'sha256') return payload;
  const indexedFiles = mirrorPayloadFilesByRelative(indexed);
  const projectedFiles = payload.files.map(file => ({
    ...file,
    ...mirrorTargetIdentityFields(indexedFiles.get(normalizeMirrorRelative(file.relative || ''))),
    sha256: String(indexedFiles.get(normalizeMirrorRelative(file.relative || ''))?.sha256 || '').trim().toLowerCase(),
  }));
  if (projectedFiles.some(file => !/^[a-f0-9]{64}$/.test(file.sha256))) return payload;
  return {
    ...payload,
    target_content_hash_alg: 'sha256',
    target_content_verified_at: String(targetContentVerifiedAt || indexed?.target_content_verified_at || '').trim(),
    files: projectedFiles,
  };
}

function mirrorPayloadFileWithoutTargetIdentity(file = {}) {
  const {
    target_ctimeMs: _targetCtimeMs,
    target_birthtimeMs: _targetBirthtimeMs,
    target_dev: _targetDev,
    target_ino: _targetIno,
    ...sourceProof
  } = file || {};
  return sourceProof;
}

function bindMirrorPayloadTargetIdentityFromPublishedManifest(existing = {}, payload = null) {
  if (!plainObject(payload)
    || String(payload.target_content_hash_alg || '').trim().toLowerCase() !== 'sha256'
    || !Array.isArray(payload.files)
    || !payload.files.length) return payload;
  const published = existing?.published_manifest;
  const publishedHash = String(existing?.published_manifest_hash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(publishedHash)
    || mirrorPublishedManifestHash(published) !== publishedHash) return payload;
  const publishedFiles = mirrorPayloadFilesByRelative(published);
  return {
    ...payload,
    // The scope timestamp remains the content-verification boundary. Rebasing
    // target file identity must not silently extend that verification period.
    files: payload.files.map(file => {
      const sourceProof = mirrorPayloadFileWithoutTargetIdentity(file);
      const relative = normalizeMirrorRelative(file?.relative || '');
      const current = publishedFiles.get(relative);
      const sourceSha = String(file?.sha256 || '').trim().toLowerCase();
      const currentSha = String(current?.sha256 || '').trim().toLowerCase();
      const sourceKind = String(file?.kind || '').trim().toLowerCase();
      const currentKind = String(current?.kind || '').trim().toLowerCase();
      const sameContent = !!relative
        && plainObject(current)
        && sourceKind === currentKind
        && Number(file?.bytes || 0) === Number(current?.bytes || 0)
        && Math.abs(Number(file?.mtimeMs || 0) - Number(current?.mtimeMs || 0)) <= 2
        && /^[a-f0-9]{64}$/.test(sourceSha)
        && sourceSha === currentSha;
      return sameContent
        ? { ...sourceProof, ...mirrorTargetIdentityFields(current) }
        : sourceProof;
    }),
  };
}

function mirrorReusablePayloadFromSourceScopes(existing = {}, snapshot = {}) {
  const payload = mirrorSnapshotIndexPayload(snapshot);
  if (!Array.isArray(payload.files) || !payload.files.length) return null;
  const wantedByKey = new Map(payload.files.map(file => {
    const entry = mirrorSnapshotEntryFromPayload(file);
    return [entry ? mirrorSnapshotEntryKey(entry) : '', file];
  }).filter(([key]) => !!key));
  if (!wantedByKey.size) return null;

  // A narrow refresh can intentionally revoke full-scope authorization while
  // leaving many unchanged files in the published project mirror. Those files
  // remain reusable only when a scoped source snapshot still proves the current
  // source identity and the staged copy is hashed again before publication.
  const candidates = [];
  const sourceScopes = plainObject(existing?.source_scopes) ? existing.source_scopes : {};
  for (const record of Object.values(sourceScopes)) {
    const scoped = record?.source_snapshot;
    if (plainObject(scoped)) candidates.push(bindMirrorPayloadTargetIdentityFromPublishedManifest(existing, scoped));
  }
  if (plainObject(existing?.source_snapshot)) {
    candidates.push(bindMirrorPayloadTargetIdentityFromPublishedManifest(existing, existing.source_snapshot));
  }
  candidates.sort((left, right) => (
    Date.parse(String(right?.target_content_verified_at || ''))
      - Date.parse(String(left?.target_content_verified_at || ''))
  ));

  const reusableByKey = new Map();
  for (const candidate of candidates) {
    if (String(candidate?.target_content_hash_alg || '').trim().toLowerCase() !== 'sha256') continue;
    const seen = new Set();
    for (const file of Array.isArray(candidate.files) ? candidate.files : []) {
      const entry = mirrorSnapshotEntryFromPayload(file);
      const key = entry ? mirrorSnapshotEntryKey(entry) : '';
      const sha256 = String(file?.sha256 || '').trim().toLowerCase();
      if (!key || seen.has(key) || !/^[a-f0-9]{64}$/.test(sha256)) continue;
      seen.add(key);
      const wanted = wantedByKey.get(key);
      if (!wanted || reusableByKey.has(key) || !mirrorSnapshotEntryMatchesPayload(entry.kind, wanted, file)) continue;
      reusableByKey.set(key, file);
    }
  }
  if (!reusableByKey.size) return null;
  return {
    ...payload,
    target_content_hash_alg: 'sha256',
    files: payload.files.map(file => {
      const entry = mirrorSnapshotEntryFromPayload(file);
      const verified = entry ? reusableByKey.get(mirrorSnapshotEntryKey(entry)) : null;
      return verified
        ? { ...file, ...mirrorTargetIdentityFields(verified), sha256: String(verified.sha256 || '').trim().toLowerCase() }
        : file;
    }),
  };
}

function mirrorPayloadHasVerifiedFiles(payload = null) {
  return Array.isArray(payload?.files) && payload.files.some(file => /^[a-f0-9]{64}$/i.test(String(file?.sha256 || '').trim()));
}

async function mirrorSnapshotIndexPayloadForTarget(snapshot = {}, targetDbStorage = '', { signal = null, onProgress = null, knownHashes = null, targetContentVerifiedAt = '' } = {}) {
  const payload = mirrorSnapshotIndexPayload(snapshot);
  const hashes = await mirrorProjectContentHashMap(targetDbStorage, snapshot, { signal, onProgress, knownHashes });
  const targetIdentities = hashes.target_identities instanceof Map ? hashes.target_identities : new Map();
  payload.target_content_hash_alg = 'sha256';
  payload.target_content_verified_at = String(targetContentVerifiedAt || '').trim() || new Date().toISOString();
  payload.files = payload.files.map(file => ({
    ...file,
    ...mirrorTargetIdentityFields(targetIdentities.get(file.relative)),
    sha256: hashes.get(file.relative) || '',
  }));
  return payload;
}

function mirrorPayloadFilesByRelative(payload = {}) {
  const out = new Map();
  for (const file of Array.isArray(payload?.files) ? payload.files : []) {
    const relative = normalizeMirrorRelative(file?.relative || '');
    if (relative) out.set(relative, file);
  }
  return out;
}

function mirrorTargetIdentityFields(value = {}) {
  const fields = {};
  for (const key of ['target_ctimeMs', 'target_birthtimeMs', 'target_dev', 'target_ino']) {
    const number = Number(value?.[key] || 0) || 0;
    if (number > 0) fields[key] = number;
  }
  return fields;
}

function mirrorTargetIdentityFieldsFromStat(stat = {}) {
  return {
    target_ctimeMs: Number(stat?.ctimeMs || 0) || 0,
    target_birthtimeMs: Number(stat?.birthtimeMs || 0) || 0,
    target_dev: Number(stat?.dev || 0) || 0,
    target_ino: Number(stat?.ino || 0) || 0,
  };
}

function mirrorSnapshotPayloadCategories(payload = {}) {
  const categories = new Set();
  for (const file of Array.isArray(payload?.files) ? payload.files : []) {
    const relative = normalizeMirrorRelative(file?.relative || '');
    const [category = ''] = relative.split('/');
    if (category) categories.add(category.toLowerCase());
  }
  return categories;
}

function mirrorSnapshotPayloadMetaHash(payload = {}) {
  if (!plainObject(payload) || !Array.isArray(payload.files) || !payload.files.length) return '';
  const entries = [];
  const keys = new Set();
  for (const file of payload.files) {
    const entry = mirrorSnapshotEntryFromPayload(file);
    const key = entry ? mirrorSnapshotEntryKey(entry) : '';
    if (!entry || !key || keys.has(key)) return '';
    keys.add(key);
    entries.push(entry);
  }
  entries.sort((a, b) => a.relative.localeCompare(b.relative) || a.kind.localeCompare(b.kind));
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function mirrorPublishedManifestHash(payload = {}) {
  if (!plainObject(payload)
    || Number(payload.version || 0) !== 1
    || String(payload.target_content_hash_alg || '').trim().toLowerCase() !== 'sha256'
    || !Array.isArray(payload.files)
    || !payload.files.length) return '';
  const entries = [];
  const seen = new Set();
  for (const file of payload.files) {
    const relative = normalizeMirrorRelative(file?.relative || '');
    const sha256 = String(file?.sha256 || '').trim().toLowerCase();
    const kind = String(file?.kind || '').trim().toLowerCase();
    const expectedKind = /\.db$/i.test(path.basename(relative)) ? 'db' : 'sidecar';
    if (!relative
      || seen.has(relative)
      || !isMirrorDatabaseCopyName(path.basename(relative))
      || kind !== expectedKind
      || !/^[a-f0-9]{64}$/.test(sha256)) return '';
    seen.add(relative);
    entries.push({
      kind,
      relative,
      bytes: Math.max(0, Number(file?.bytes || 0) || 0),
      mtimeMs: Math.max(0, Number(file?.mtimeMs || 0) || 0),
      ctimeMs: Math.max(0, Number(file?.ctimeMs || 0) || 0),
      birthtimeMs: Math.max(0, Number(file?.birthtimeMs || 0) || 0),
      dev: Math.max(0, Number(file?.dev || 0) || 0),
      ino: Math.max(0, Number(file?.ino || 0) || 0),
      target_ctimeMs: Math.max(0, Number(file?.target_ctimeMs || 0) || 0),
      target_birthtimeMs: Math.max(0, Number(file?.target_birthtimeMs || 0) || 0),
      target_dev: Math.max(0, Number(file?.target_dev || 0) || 0),
      target_ino: Math.max(0, Number(file?.target_ino || 0) || 0),
      sha256,
    });
  }
  entries.sort((a, b) => a.relative.localeCompare(b.relative));
  return crypto.createHash('sha256').update(JSON.stringify({ version: 1, files: entries })).digest('hex');
}

function mirrorCollectedTargetFileIdentityMatches(left = null, right = null) {
  if (!left || !right) return false;
  return left.is_file === true
    && right.is_file === true
    && left.is_symbolic_link !== true
    && right.is_symbolic_link !== true
    && Number(left.bytes || 0) === Number(right.bytes || 0)
    && Math.abs(Number(left.mtimeMs || 0) - Number(right.mtimeMs || 0)) <= 2
    && Math.abs(Number(left.ctimeMs || 0) - Number(right.ctimeMs || 0)) <= 2
    && Math.abs(Number(left.birthtimeMs || 0) - Number(right.birthtimeMs || 0)) <= 2
    && Number(left.dev || 0) === Number(right.dev || 0)
    && Number(left.ino || 0) === Number(right.ino || 0);
}

function mirrorPublishedManifestRaceError() {
  return Object.assign(new Error('项目本地工作数据在发布清单校验期间发生变化，已保留旧数据且停止发布。'), {
    status: 409,
    code: 'wxdb_mirror_publish_manifest_raced',
    public_code: 'wxdb_mirror_publish_manifest_raced',
  });
}

async function mirrorPublishedManifestForTarget(targetDbStorage = '', { signal = null, progress = null, knownHashes = null } = {}) {
  throwIfDiscoveryAborted(signal);
  const root = path.resolve(targetDbStorage || '');
  await assertNoMirrorSymlinkTree(root);
  if (await mirrorTargetHasCategoryBackups(root, { signal })) throw mirrorPublishedManifestRaceError();
  const before = await collectMirrorTargetSnapshotFiles(root, { signal });
  if (!before.size) throw mirrorPublishedManifestRaceError();
  const known = knownHashes instanceof Map ? knownHashes : new Map();
  const hashes = new Map();
  const sorted = [...before.entries()].sort(([left], [right]) => left.localeCompare(right));
  const totalBytes = sorted.reduce((sum, [, file]) => sum + Math.max(0, Number(file?.bytes || 0) || 0), 0);
  try {
    progress?.({
      phase: 'mirror_publish_manifest',
      label: '检查本地数据 · 绑定完整发布清单',
      detail: `正在核对完整工作数据，共 ${sorted.length} 个文件（${formatMirrorBytes(totalBytes)}）；完成前不会替换当前版本`,
      total: sorted.length,
      total_bytes: totalBytes,
      percent: 0,
    });
  } catch {}
  let completedBytes = 0;
  for (const [index, [relative, file]] of sorted.entries()) {
    throwIfDiscoveryAborted(signal);
    if (!file?.is_file || file.is_symbolic_link) throw mirrorPublishedManifestRaceError();
    const knownHash = String(known.get(relative) || '').trim().toLowerCase();
    const knownIdentity = known?.target_identities instanceof Map ? known.target_identities.get(relative) : null;
    let sha256 = '';
    if (/^[a-f0-9]{64}$/.test(knownHash) && mirrorTargetIdentityMatches(file, knownIdentity)) {
      sha256 = knownHash;
    } else {
      const target = path.resolve(root, relative);
      assertMirrorStagingTarget(root, target);
      const verification = await hashProjectMirrorCopyFile(target, { signal, includeIdentity: true });
      sha256 = verification.sha256;
    }
    hashes.set(relative, sha256);
    completedBytes += Math.max(0, Number(file.bytes || 0) || 0);
    try {
      progress?.({
        phase: 'mirror_publish_manifest_progress',
        label: '检查本地数据 · 绑定完整发布清单',
        detail: `${index + 1}/${sorted.length} ${relative} · ${formatMirrorBytes(completedBytes)}/${formatMirrorBytes(totalBytes)}`,
        index: index + 1,
        total: sorted.length,
        bytes_read: completedBytes,
        total_bytes: totalBytes,
        percent: totalBytes ? Math.min(100, Math.round((completedBytes / totalBytes) * 100)) : 100,
      });
    } catch {}
  }
  const after = await collectMirrorTargetSnapshotFiles(root, { signal });
  if (after.size !== before.size) throw mirrorPublishedManifestRaceError();
  for (const [relative, file] of before) {
    if (!mirrorCollectedTargetFileIdentityMatches(file, after.get(relative))) throw mirrorPublishedManifestRaceError();
  }
  await assertNoMirrorSymlinkTree(root);
  const files = [...after.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relative, file]) => ({
      kind: /\.db$/i.test(path.basename(relative)) ? 'db' : 'sidecar',
      relative,
      bytes: Number(file.bytes || 0) || 0,
      mtimeMs: Number(file.mtimeMs || 0) || 0,
      ctimeMs: Number(file.ctimeMs || 0) || 0,
      birthtimeMs: Number(file.birthtimeMs || 0) || 0,
      dev: Number(file.dev || 0) || 0,
      ino: Number(file.ino || 0) || 0,
      ...mirrorTargetIdentityFieldsFromStat(file),
      sha256: hashes.get(relative) || '',
    }));
  const lastWriteMs = files.reduce((latest, file) => Math.max(latest, Number(file.mtimeMs || 0) || 0), 0);
  const manifest = {
    version: 1,
    db_count: files.filter(file => file.kind === 'db').length,
    bytes: files.reduce((sum, file) => sum + Math.max(0, Number(file.bytes || 0) || 0), 0),
    last_write_time: lastWriteMs ? new Date(lastWriteMs).toISOString() : '',
    target_content_hash_alg: 'sha256',
    target_content_verified_at: new Date().toISOString(),
    files,
  };
  const hash = mirrorPublishedManifestHash(manifest);
  if (!hash) throw mirrorPublishedManifestRaceError();
  try {
    progress?.({
      phase: 'mirror_publish_manifest_done',
      label: '检查本地数据 · 完整发布清单已确认',
      detail: `已绑定 ${files.length} 个文件；接下来原子替换本地工作数据并提交索引`,
      total: files.length,
      total_bytes: manifest.bytes,
      percent: 100,
    });
  } catch {}
  return { manifest, hash };
}

function mirrorOldestVerifiedAt(...values) {
  const times = values
    .map(value => Date.parse(String(value || '')))
    .filter(value => Number.isFinite(value) && value > 0);
  return times.length ? new Date(Math.min(...times)).toISOString() : '';
}

function mergeMirrorSnapshotPayloadCategories(previousPayload = {}, refreshedPayload = {}, categories = []) {
  if (!plainObject(previousPayload)
    || !plainObject(refreshedPayload)
    || !Array.isArray(previousPayload.files)
    || !Array.isArray(refreshedPayload.files)
    || String(previousPayload.target_content_hash_alg || '').trim().toLowerCase() !== 'sha256'
    || String(refreshedPayload.target_content_hash_alg || '').trim().toLowerCase() !== 'sha256') return null;
  const replaced = new Set((Array.isArray(categories) ? categories : [])
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean));
  if (!replaced.size) return null;
  const files = [
    ...previousPayload.files.filter(file => {
      const [category = ''] = normalizeMirrorRelative(file?.relative || '').split('/');
      return !replaced.has(category.toLowerCase());
    }),
    ...refreshedPayload.files.filter(file => {
      const [category = ''] = normalizeMirrorRelative(file?.relative || '').split('/');
      return replaced.has(category.toLowerCase());
    }),
  ];
  if (!files.length || files.some(file => !/^[a-f0-9]{64}$/i.test(String(file?.sha256 || '').trim()))) return null;
  const payload = {
    ...previousPayload,
    db_count: files.filter(file => String(file?.kind || '').trim() === 'db').length,
    bytes: files.reduce((sum, file) => sum + (Number(file?.bytes || 0) || 0), 0),
    last_write_time: files.reduce((latest, file) => {
      const time = Number(file?.mtimeMs || 0) || 0;
      return time > latest ? time : latest;
    }, 0),
    target_content_hash_alg: 'sha256',
    target_content_verified_at: mirrorOldestVerifiedAt(
      previousPayload.target_content_verified_at,
      refreshedPayload.target_content_verified_at,
    ),
    files,
  };
  payload.last_write_time = payload.last_write_time ? new Date(payload.last_write_time).toISOString() : '';
  return mirrorSnapshotPayloadMetaHash(payload) ? payload : null;
}

function mirrorSourceScopesForWrite(previous = {}, scope = {}, snapshot = {}, refreshedAt = '', refreshReason = '', refreshAction = '', snapshotPayload = null, { checkedAt = refreshedAt } = {}) {
  const next = scope.key === 'full'
    ? {}
    : (plainObject(previous.source_scopes) ? { ...previous.source_scopes } : {});
  const payload = plainObject(snapshotPayload) ? snapshotPayload : mirrorSnapshotIndexPayload(snapshot);
  const identitySelection = plainObject(snapshot) ? snapshot : payload;
  const identitySelectionKnown = Object.hasOwn(identitySelection, 'eligible_message_count')
    && Object.hasOwn(identitySelection, 'selected_message_count');
  const eligibleIdentityMessages = Number(identitySelection.eligible_message_count);
  const selectedIdentityMessages = Number(identitySelection.selected_message_count);
  const partialIdentityCategoryPublished = scope.key === 'identity'
    && String(refreshAction || '').trim().toLowerCase() !== 'reuse'
    && (!identitySelectionKnown
      || !Number.isSafeInteger(eligibleIdentityMessages)
      || !Number.isSafeInteger(selectedIdentityMessages)
      || eligibleIdentityMessages < 0
      || selectedIdentityMessages < 0
      || selectedIdentityMessages !== eligibleIdentityMessages);
  if (partialIdentityCategoryPublished) {
    // The physical message category now contains only the bounded identity
    // sample. Any previously complete message scope must stop authorizing reads.
    delete next.digest;
    delete next.full;
  }
  if (scope.key !== 'full') {
    const refreshedCategories = new Set((Array.isArray(scope.categories) ? scope.categories : [])
      .map(value => String(value || '').trim().toLowerCase())
      .filter(Boolean));
    for (const [key, record] of Object.entries(next)) {
      if (key === scope.key) continue;
      if (scope.key === 'identity' && String(refreshAction || '').trim().toLowerCase() === 'reuse') continue;
      const indexedCategories = new Set((Array.isArray(record?.categories) && record.categories.length
        ? record.categories
        : [...mirrorSnapshotPayloadCategories(record?.source_snapshot)])
        .map(value => String(value || '').trim().toLowerCase())
        .filter(Boolean));
      const overlappingCategories = [...indexedCategories].filter(category => refreshedCategories.has(category));
      if (!overlappingCategories.length) continue;
      const mergedPayload = mergeMirrorSnapshotPayloadCategories(record?.source_snapshot, payload, overlappingCategories);
      const mergedHash = mirrorSnapshotPayloadMetaHash(mergedPayload);
      if (!mergedPayload || !mergedHash) {
        delete next[key];
        continue;
      }
      next[key] = {
        ...record,
        source_snapshot_meta_hash: mergedHash,
        source_snapshot: mergedPayload,
        refreshed_at: refreshedAt,
        checked_at: checkedAt || refreshedAt,
        refresh_reason: refreshReason,
        refresh_reason_label: mirrorRefreshReasonLabel(refreshReason),
        refresh_action: refreshAction || mirrorRefreshAction(refreshReason),
      };
    }
  }
  next[scope.key || 'full'] = {
    scope: scope.key || 'full',
    label: scope.label || '',
    categories: Array.isArray(scope.categories) ? [...scope.categories] : [],
    source_snapshot_meta_hash: snapshot.hash || '',
    source_snapshot: payload,
    refreshed_at: refreshedAt,
    checked_at: checkedAt || refreshedAt,
    refresh_reason: refreshReason,
    refresh_reason_label: mirrorRefreshReasonLabel(refreshReason),
    refresh_action: refreshAction || mirrorRefreshAction(refreshReason),
  };
  return next;
}

function mirrorIndexedSnapshotForScope(existing = {}, scope = {}, snapshot = null) {
  const record = mirrorIndexedScopeRecord(existing, scope, snapshot);
  if (plainObject(record?.source_snapshot)) {
    return bindMirrorPayloadTargetIdentityFromPublishedManifest(existing, record.source_snapshot);
  }
  if (scope.key !== 'full' && plainObject(existing.source_snapshot)) {
    return bindMirrorPayloadTargetIdentityFromPublishedManifest(existing, existing.source_snapshot);
  }
  return plainObject(existing.source_snapshot)
    ? bindMirrorPayloadTargetIdentityFromPublishedManifest(existing, existing.source_snapshot)
    : null;
}

function mirrorIndexedScopeRecord(existing = {}, scope = {}, snapshot = null) {
  const records = wxDbMirrorScopeRecordsForRead(existing, scope);
  if (plainObject(snapshot) && Array.isArray(snapshot.dbFiles) && snapshot.dbFiles.length) {
    const covering = records.find(candidate => mirrorSnapshotHashFromIndexedPayload(candidate?.record?.source_snapshot, snapshot));
    if (covering?.record) return covering.record;
  }
  const exact = records.find(candidate => candidate?.key === scope.key && plainObject(candidate.record));
  return exact?.record || records[0]?.record || existing;
}

function mirrorTargetContentVerifiedAt(indexed = {}, scopeRecord = {}) {
  const candidates = [
    indexed?.target_content_verified_at,
    scopeRecord?.target_content_verified_at,
    scopeRecord?.checked_at,
    scopeRecord?.refreshed_at,
  ];
  for (const value of candidates) {
    const time = Date.parse(String(value || ''));
    if (Number.isFinite(time) && time > 0) return new Date(time).toISOString();
  }
  return '';
}

function mirrorTargetContentHashFresh(indexed = {}, scopeRecord = {}, nowMs = Date.now(), ttlMs = WXDB_MIRROR_CONTENT_VERIFY_TTL_MS) {
  const verifiedAt = mirrorTargetContentVerifiedAt(indexed, scopeRecord);
  if (!verifiedAt) return false;
  const age = Math.max(0, Number(nowMs || 0) - Date.parse(verifiedAt));
  return age <= Math.max(0, Number(ttlMs || 0) || 0);
}

function mirrorIndexedSnapshotHasContentHashes(indexed = null, snapshot = {}) {
  if (!plainObject(indexed) || String(indexed.target_content_hash_alg || '').toLowerCase() !== 'sha256') return false;
  const targetByRelative = mirrorContentHashMapFromPayload(indexed);
  return mirrorSnapshotRelativeFiles(snapshot).every(relative => !!targetByRelative.get(relative));
}

function mirrorCopyAttemptsForRequest({
  force = false,
  scope = {},
  sourceBusyReusePurpose = '',
  targetExists = false,
  indexedSnapshot = null,
  sourceSnapshot = null,
  identityAnchorCurrent = false,
} = {}) {
  const sourceFiles = mirrorSnapshotRelativeFiles(sourceSnapshot);
  const indexedContactMatchesSource = mirrorPayloadCategorySourceMetadataMatches(indexedSnapshot, sourceSnapshot, 'contact');
  const mayReuseVerifiedGroupMirror = force !== true
    && String(sourceBusyReusePurpose || '').trim().toLowerCase() === 'groups'
    && String(scope?.key || '').trim().toLowerCase() === 'groups'
    && targetExists === true
    && sourceFiles.length > 0
    && identityAnchorCurrent === true
    && indexedContactMatchesSource
    && mirrorIndexedSnapshotHasContentHashes(indexedSnapshot, sourceSnapshot);
  return mayReuseVerifiedGroupMirror
    ? WXDB_MIRROR_GROUP_REUSE_COPY_ATTEMPTS
    : WXDB_MIRROR_STABLE_COPY_ATTEMPTS;
}

function mirrorContentHashMapFromPayload(payload = {}) {
  const out = new Map();
  for (const file of Array.isArray(payload.files) ? payload.files : []) {
    const relative = normalizeMirrorRelative(file?.relative || '');
    const sha256 = String(file?.sha256 || '').trim().toLowerCase();
    if (relative && /^[a-f0-9]{64}$/.test(sha256)) out.set(relative, sha256);
  }
  return out;
}

function mirrorSnapshotContentHashesMatch(indexed = {}, actual = {}, snapshot = {}) {
  const expected = mirrorContentHashMapFromPayload(indexed);
  const current = mirrorContentHashMapFromPayload(actual);
  return mirrorSnapshotRelativeFiles(snapshot).every(relative => {
    const wanted = expected.get(relative);
    return !!wanted && wanted === current.get(relative);
  });
}

function mirrorSnapshotHashFromIndexedPayload(payload = {}, snapshot = {}) {
  if (!plainObject(payload)
    || !Array.isArray(payload.files)
    || !plainObject(snapshot)
    || !Array.isArray(snapshot.dbFiles)) return '';
  const wanted = new Set(mirrorSnapshotManifest(snapshot).map(entry => mirrorSnapshotEntryKey(entry)));
  if (!wanted.size) return '';
  const entries = [];
  for (const file of payload.files) {
    const entry = mirrorSnapshotEntryFromPayload(file);
    if (!entry) continue;
    const key = mirrorSnapshotEntryKey(entry);
    if (wanted.has(key)) entries.push(entry);
  }
  if (entries.length !== wanted.size) return '';
  entries.sort((a, b) => a.relative.localeCompare(b.relative) || a.kind.localeCompare(b.kind));
  const hash = crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return hash === snapshot.hash ? hash : '';
}

function mirrorSnapshotEntryKey(entry = {}) {
  return `${String(entry.kind || '')}\0${normalizeMirrorRelative(entry.relative || '')}`;
}

function mirrorSnapshotEntryFromPayload(file = {}) {
  const kind = String(file?.kind || '').trim();
  const relative = normalizeMirrorRelative(file?.relative || '');
  if (!kind || !relative) return null;
  return {
    kind,
    relative,
    bytes: Number(file?.bytes || 0) || 0,
    mtimeMs: Number(file?.mtimeMs || 0) || 0,
    ctimeMs: Number(file?.ctimeMs || 0) || 0,
    birthtimeMs: Number(file?.birthtimeMs || 0) || 0,
    dev: Number(file?.dev || 0) || 0,
    ino: Number(file?.ino || 0) || 0,
  };
}

export async function cleanupStaleWxDbMirrorWorkDirs({
  mirror_segment = '',
  source_available = false,
  source_backed_publish_succeeded = false,
  continue_on_recovery_error = false,
  onProgress = null,
  signal = null,
} = {}) {
  const requestedSegment = String(mirror_segment || '').trim();
  if (!requestedSegment) {
    throwIfDiscoveryAborted(signal);
    await assertMirrorRootReady();
    const entries = await fsp.readdir(WXDB_MIRROR_ROOT, { withFileTypes: true }).catch(e => {
      if (e?.code === 'ENOENT') return [];
      throw e;
    });
    const segments = [...new Set(entries
      .map(entry => mirrorWorkDirInfo(entry.name)?.segment || '')
      .filter(Boolean))].sort();
    const settled = await Promise.allSettled(segments.map(segment => cleanupStaleWxDbMirrorWorkDirs({
        mirror_segment: segment,
        source_available,
        source_backed_publish_succeeded,
        continue_on_recovery_error,
        onProgress,
        signal,
      })));
    const results = [];
    const accountErrors = [];
    let fatalError = null;
    for (let index = 0; index < settled.length; index += 1) {
      const outcome = settled[index];
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
        continue;
      }
      const error = outcome.reason;
      const aborted = signal?.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError';
      if (aborted || !continue_on_recovery_error) fatalError ||= error;
      else accountErrors.push(mirrorCleanupErrorPayload(segments[index], error, 'wxdb_mirror_account_cleanup_failed'));
    }
    if (fatalError) throw fatalError;
    const recoveryErrors = [
      ...results.flatMap(result => Array.isArray(result?.recovery_errors) ? result.recovery_errors : []),
      ...accountErrors,
    ];
    return {
      ok: results.every(result => result?.ok === true) && recoveryErrors.length === 0,
      transient_dirs_removed: results.reduce((total, result) => total + (Number(result?.transient_dirs_removed || 0) || 0), 0),
      previous_segments_checked: results.reduce((total, result) => total + (Number(result?.previous_segments_checked || 0) || 0), 0),
      recovery_actions: results.flatMap(result => Array.isArray(result?.recovery_actions) ? result.recovery_actions : []),
      recovery_errors: recoveryErrors,
    };
  }
  const wantedSegment = safeMirrorSegment(requestedSegment);
  const held = WXDB_MIRROR_LOCK_CONTEXT.getStore();
  if (!held?.has(wantedSegment)) {
    return runWithWxDbMirrorLock(
      wantedSegment,
      () => cleanupStaleWxDbMirrorWorkDirs({
        mirror_segment: wantedSegment,
        source_available,
        source_backed_publish_succeeded,
        continue_on_recovery_error,
        onProgress,
        signal,
      }),
      { signal },
    );
  }
  throwIfDiscoveryAborted(signal);
  await assertMirrorRootReady();
  const entries = await fsp.readdir(WXDB_MIRROR_ROOT, { withFileTypes: true }).catch(e => {
    if (e?.code === 'ENOENT') return [];
    throw e;
  });
  const previousBySegment = new Map();
  const recoveryErrors = [];
  let transientDirsRemoved = 0;
  for (const entry of entries) {
    throwIfDiscoveryAborted(signal);
    const info = mirrorWorkDirInfo(entry.name);
    if (!info || (wantedSegment && info.segment !== wantedSegment)) continue;
    const full = path.join(WXDB_MIRROR_ROOT, entry.name);
    await assertSafeMirrorTargetRoot(full);
    if (info.kind === 'previous') {
      const list = previousBySegment.get(info.segment) || [];
      list.push({ name: entry.name, full });
      previousBySegment.set(info.segment, list);
      continue;
    }
    try {
      await removeSafeMirrorRoot(full);
      transientDirsRemoved += 1;
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error;
      if (!continue_on_recovery_error) throw error;
      recoveryErrors.push(mirrorCleanupErrorPayload(info.segment, error, 'wxdb_mirror_transient_cleanup_failed'));
    }
  }
  const indexJson = previousBySegment.size ? await readMirrorIndex() : { accounts: {} };
  const recoveryActions = [];
  for (const [segment, previousDirs] of previousBySegment.entries()) {
    throwIfDiscoveryAborted(signal);
    const targetRoot = path.join(WXDB_MIRROR_ROOT, segment);
    await assertSafeMirrorTargetRoot(targetRoot);
    const targetStat = await fsp.lstat(targetRoot).catch(e => {
      if (e?.code === 'ENOENT') return null;
      throw e;
    });
    try {
      recoveryActions.push(await recoverStalePreviousMirrorDirs({
        segment,
        targetRoot,
        targetStat,
        previousDirs,
        indexedAccount: indexJson.accounts?.[segment] || null,
        source_available,
        source_backed_publish_succeeded,
        persist_rebound_metadata: true,
        onProgress,
        signal,
      }));
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') throw e;
      if (!continue_on_recovery_error) throw e;
      recoveryErrors.push(mirrorCleanupErrorPayload(segment, e, 'wxdb_mirror_recovery_failed'));
    }
  }
  return {
    ok: recoveryErrors.length === 0,
    transient_dirs_removed: transientDirsRemoved,
    previous_segments_checked: previousBySegment.size,
    recovery_actions: recoveryActions.filter(Boolean),
    recovery_errors: recoveryErrors,
  };
}

function mirrorCleanupErrorPayload(segment = '', error = null, fallbackCode = 'wxdb_mirror_cleanup_failed') {
  return {
    segment: String(segment || '').trim().toLowerCase(),
    code: String(error?.public_code || error?.code || fallbackCode).slice(0, 80),
    message: String(error?.message || error || '').replace(/\s+/g, ' ').trim().slice(0, 240),
  };
}

function cloneMirrorIndexRecordForRetention(account = null) {
  if (!plainObject(account)) return null;
  try {
    const copy = JSON.parse(JSON.stringify(account));
    delete copy.retained_previous_generation;
    return copy;
  } catch {
    return null;
  }
}

function retainedMirrorGenerationFromIndex(segment = '', indexedAccount = null) {
  if (!plainObject(indexedAccount) || !plainObject(indexedAccount.retained_previous_generation)) return null;
  const record = indexedAccount.retained_previous_generation;
  const rootName = String(record.root_name || '').trim();
  const info = mirrorWorkDirInfo(rootName);
  const accountIndex = record.account_index;
  if (Number(record.version || 0) !== 1
    || !rootName
    || rootName !== path.basename(rootName)
    || info?.segment !== String(segment || '').trim().toLowerCase()
    || info?.kind !== 'previous'
    || !plainObject(accountIndex)) return null;
  const accountId = String(indexedAccount.account_id || '').trim().toLowerCase();
  const retainedAccountId = String(accountIndex.account_id || '').trim().toLowerCase();
  const retainedSegment = String(accountIndex.mirror_segment || '').trim().toLowerCase();
  if (accountId && retainedAccountId !== accountId) return null;
  if (retainedSegment !== String(segment || '').trim().toLowerCase()) return null;
  const manifest = accountIndex.published_manifest;
  const manifestHash = String(accountIndex.published_manifest_hash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(manifestHash) || mirrorPublishedManifestHash(manifest) !== manifestHash) return null;
  return {
    root_name: rootName,
    account_index: accountIndex,
    published_manifest: manifest,
    published_manifest_hash: manifestHash,
  };
}

function retainedMirrorGenerationForBackup(backupRoot = '', previousAccount = null) {
  const accountIndex = cloneMirrorIndexRecordForRetention(previousAccount);
  if (!accountIndex) return null;
  const manifest = accountIndex.published_manifest;
  const manifestHash = String(accountIndex.published_manifest_hash || '').trim().toLowerCase();
  const info = mirrorWorkDirInfo(path.basename(backupRoot));
  if (!info || info.kind !== 'previous'
    || !/^[a-f0-9]{64}$/.test(manifestHash)
    || mirrorPublishedManifestHash(manifest) !== manifestHash) return null;
  return {
    version: 1,
    root_name: path.basename(backupRoot),
    account_index: accountIndex,
    retained_at: new Date().toISOString(),
  };
}

async function copyMirrorGenerationToStaging(sourceRoot = '', stagingRoot = '', { signal = null } = {}) {
  throwIfDiscoveryAborted(signal);
  const source = path.resolve(sourceRoot || '');
  const target = path.resolve(stagingRoot || '');
  await assertSafeMirrorTargetRoot(source);
  await assertSafeMirrorTargetRoot(target);
  await assertNoMirrorSymlinkTree(source);
  await ensureSafeMirrorDir(target);
  await copyMirrorTree(path.join(source, 'db_storage'), path.join(target, 'db_storage'), {
    sourceRoot: path.resolve(WXDB_MIRROR_ROOT),
    targetRoot: path.resolve(WXDB_MIRROR_ROOT),
    signal,
  });
  await assertNoMirrorSymlinkTree(target);
  return target;
}

async function restoreMirrorIndexFromRetainedGeneration(segment = '', indexedAccount = null, retained = null) {
  if (!plainObject(indexedAccount) || !plainObject(retained?.account_index)) {
    throw Object.assign(new Error('保留代次索引不完整，已停止自动回退。'), {
      status: 409,
      code: 'wxdb_mirror_recovery_ambiguous',
      public_code: 'wxdb_mirror_recovery_ambiguous',
    });
  }
  return runWithWxDbMirrorIndexWriteLock(async () => {
    const indexJson = await readMirrorIndex();
    const entries = Object.entries(indexJson.accounts || {}).filter(([, item]) => (
      String(item?.mirror_segment || '').trim().toLowerCase() === String(segment || '').trim().toLowerCase()
    ));
    if (entries.length !== 1) {
      throw Object.assign(new Error('保留代次对应的当前账号索引不唯一，已停止自动回退。'), {
        status: 409,
        code: 'wxdb_mirror_recovery_ambiguous',
        public_code: 'wxdb_mirror_recovery_ambiguous',
      });
    }
    const [accountId, current] = entries[0];
    if (String(current?.published_manifest_hash || '').trim().toLowerCase()
      !== String(indexedAccount.published_manifest_hash || '').trim().toLowerCase()) {
      throw Object.assign(new Error('本地工作数据索引在回退期间发生变化，已停止自动回退。'), {
        status: 409,
        code: 'wxdb_mirror_recovery_ambiguous',
        public_code: 'wxdb_mirror_recovery_ambiguous',
      });
    }
    const restored = cloneMirrorIndexRecordForRetention(retained.account_index);
    if (!restored) throw Object.assign(new Error('保留代次索引无法恢复。'), { status: 409, code: 'wxdb_mirror_recovery_ambiguous', public_code: 'wxdb_mirror_recovery_ambiguous' });
    indexJson.accounts[accountId] = restored;
    await ensureDir(WXDB_MIRROR_ROOT);
    await writeJsonAtomic(WXDB_MIRROR_INDEX, indexJson);
    return restored;
  });
}

async function persistReboundRetainedMirrorGeneration({
  segment = '',
  indexedAccount = null,
  rootName = '',
  expectedRetainedHash = '',
  reboundAccount = null,
} = {}) {
  const rebound = cloneMirrorIndexRecordForRetention(reboundAccount);
  const reboundHash = String(rebound?.published_manifest_hash || '').trim().toLowerCase();
  if (!rebound || !/^[a-f0-9]{64}$/.test(reboundHash)) {
    throw Object.assign(new Error('保留代次复核完成，但无法生成新的文件身份绑定。'), {
      status: 409,
      code: 'wxdb_mirror_recovery_ambiguous',
      public_code: 'wxdb_mirror_recovery_ambiguous',
    });
  }
  return runWithWxDbMirrorIndexWriteLock(async () => {
    const indexJson = await readMirrorIndex();
    const entries = Object.entries(indexJson.accounts || {}).filter(([, item]) => (
      String(item?.mirror_segment || '').trim().toLowerCase() === String(segment || '').trim().toLowerCase()
    ));
    if (entries.length !== 1) {
      throw Object.assign(new Error('保留代次复核期间账号索引不唯一，已停止更新文件身份。'), {
        status: 409,
        code: 'wxdb_mirror_recovery_ambiguous',
        public_code: 'wxdb_mirror_recovery_ambiguous',
      });
    }
    const [accountId, current] = entries[0];
    const descriptor = current?.retained_previous_generation;
    const currentHash = String(current?.published_manifest_hash || '').trim().toLowerCase();
    const expectedCurrentHash = String(indexedAccount?.published_manifest_hash || '').trim().toLowerCase();
    const retainedHash = String(descriptor?.account_index?.published_manifest_hash || '').trim().toLowerCase();
    if (currentHash !== expectedCurrentHash
      || String(descriptor?.root_name || '').trim() !== String(rootName || '').trim()
      || retainedHash !== String(expectedRetainedHash || '').trim().toLowerCase()) {
      throw Object.assign(new Error('保留代次复核期间索引已变化，已停止更新文件身份。'), {
        status: 409,
        code: 'wxdb_mirror_recovery_ambiguous',
        public_code: 'wxdb_mirror_recovery_ambiguous',
      });
    }
    indexJson.accounts[accountId] = {
      ...current,
      retained_previous_generation: {
        ...descriptor,
        account_index: rebound,
        identity_rebound_at: new Date().toISOString(),
      },
    };
    await ensureDir(WXDB_MIRROR_ROOT);
    await writeJsonAtomic(WXDB_MIRROR_INDEX, indexJson);
    return rebound;
  });
}

async function persistReboundCurrentMirrorGeneration({ segment = '', indexedAccount = null, reboundAccount = null } = {}) {
  const rebound = plainObject(reboundAccount) ? reboundAccount : null;
  const reboundHash = String(rebound?.published_manifest_hash || '').trim().toLowerCase();
  if (!rebound || !/^[a-f0-9]{64}$/.test(reboundHash)) {
    throw Object.assign(new Error('当前代次复核完成，但无法生成新的文件身份绑定。'), {
      status: 409,
      code: 'wxdb_mirror_recovery_ambiguous',
      public_code: 'wxdb_mirror_recovery_ambiguous',
    });
  }
  return runWithWxDbMirrorIndexWriteLock(async () => {
    const indexJson = await readMirrorIndex();
    const entries = Object.entries(indexJson.accounts || {}).filter(([, item]) => (
      String(item?.mirror_segment || '').trim().toLowerCase() === String(segment || '').trim().toLowerCase()
    ));
    if (entries.length !== 1) {
      throw Object.assign(new Error('当前代次复核期间账号索引不唯一，已停止更新文件身份。'), {
        status: 409,
        code: 'wxdb_mirror_recovery_ambiguous',
        public_code: 'wxdb_mirror_recovery_ambiguous',
      });
    }
    const [accountId, current] = entries[0];
    const expectedHash = String(indexedAccount?.published_manifest_hash || '').trim().toLowerCase();
    const currentDescriptor = current?.retained_previous_generation;
    const expectedDescriptor = indexedAccount?.retained_previous_generation;
    const descriptorBinding = descriptor => ({
      root: String(descriptor?.root_name || '').trim(),
      hash: String(descriptor?.account_index?.published_manifest_hash || '').trim().toLowerCase(),
    });
    if (String(current?.published_manifest_hash || '').trim().toLowerCase() !== expectedHash
      || JSON.stringify(descriptorBinding(currentDescriptor)) !== JSON.stringify(descriptorBinding(expectedDescriptor))) {
      throw Object.assign(new Error('当前代次复核期间索引已变化，已停止更新文件身份。'), {
        status: 409,
        code: 'wxdb_mirror_recovery_ambiguous',
        public_code: 'wxdb_mirror_recovery_ambiguous',
      });
    }
    const next = {
      ...current,
      ...rebound,
      identity_rebound_at: new Date().toISOString(),
    };
    if (plainObject(currentDescriptor)) next.retained_previous_generation = currentDescriptor;
    else delete next.retained_previous_generation;
    indexJson.accounts[accountId] = next;
    await ensureDir(WXDB_MIRROR_ROOT);
    await writeJsonAtomic(WXDB_MIRROR_INDEX, indexJson);
    return next;
  });
}

async function recoverStalePreviousMirrorDirs({
  segment = '',
  targetRoot = '',
  targetStat = null,
  previousDirs = [],
  indexedAccount = null,
  source_available = false,
  source_backed_publish_succeeded = false,
  persist_rebound_metadata = false,
  onProgress = null,
  signal = null,
} = {}) {
  const ambiguous = message => Object.assign(new Error(message), {
    status: 409,
    code: 'wxdb_mirror_recovery_ambiguous',
    public_code: 'wxdb_mirror_recovery_ambiguous',
  });
  const verifyRetainedCandidate = async (retainedCandidate, retained) => {
    const expectedRetainedHash = String(retained?.account_index?.published_manifest_hash || '').trim().toLowerCase();
    let reboundAccount = null;
    const matches = await previousMirrorRootMatchesIndexedContent(retainedCandidate.full, retained.account_index, {
      signal,
      onRebound: next => { reboundAccount = next; },
    }).catch(e => {
      if (signal?.aborted || e?.name === 'AbortError') throw e;
      return false;
    });
    if (!matches) return false;
    if (reboundAccount) {
      retained.account_index = persist_rebound_metadata
        ? await persistReboundRetainedMirrorGeneration({
            segment,
            indexedAccount,
            rootName: retained.root_name,
            expectedRetainedHash,
            reboundAccount,
          })
        : reboundAccount;
      if (plainObject(indexedAccount?.retained_previous_generation)) {
        indexedAccount.retained_previous_generation.account_index = retained.account_index;
      }
    }
    return previousMirrorRootMatchesIndexedContent(retainedCandidate.full, retained.account_index, { signal }).catch(e => {
      if (signal?.aborted || e?.name === 'AbortError') throw e;
      return false;
    });
  };
  let reboundCurrentAccount = null;
  const targetMatchesIndex = targetStat
    ? await previousMirrorRootMatchesIndexedContent(targetRoot, indexedAccount, {
        signal,
        onRebound: next => { reboundCurrentAccount = next; },
      }).catch(e => {
        if (signal?.aborted || e?.name === 'AbortError') throw e;
        return false;
      })
    : false;
  if (targetMatchesIndex) {
    if (reboundCurrentAccount) {
      indexedAccount = persist_rebound_metadata
        ? await persistReboundCurrentMirrorGeneration({
            segment,
            indexedAccount,
            reboundAccount: reboundCurrentAccount,
          })
        : reboundCurrentAccount;
    }
    const targetStillMatchesIndex = await previousMirrorRootMatchesIndexedContent(targetRoot, indexedAccount, { signal }).catch(e => {
      if (signal?.aborted || e?.name === 'AbortError') throw e;
      return false;
    });
    if (!targetStillMatchesIndex) {
      throw ambiguous('当前本地工作数据在恢复复核期间发生变化；已保留当前目录和全部崩溃前候选，停止自动清理。');
    }
    const retained = retainedMirrorGenerationFromIndex(segment, indexedAccount);
    const retainedCandidates = retained
      ? previousDirs.filter(item => item.name === retained.root_name)
      : [];
    if (retainedCandidates.length === 1) {
      const retainedCandidate = retainedCandidates[0];
      const retainedStillMatches = await verifyRetainedCandidate(retainedCandidate, retained);
      if (!retainedStillMatches) throw ambiguous('保留代次在清理复核期间发生变化；已保留当前目录和全部候选，停止自动清理。');
      let prunedPreviousCount = 0;
      for (const item of previousDirs) {
        if (item.name === retained.root_name) continue;
        await removeSafeMirrorRoot(item.full);
        prunedPreviousCount += 1;
      }
      return {
        action: 'keep_committed_target',
        segment,
        retained_previous_root: retained.root_name,
        preserved_previous_count: 1,
        pruned_previous_count: prunedPreviousCount,
      };
    }
    if (source_backed_publish_succeeded) {
      let prunedPreviousCount = 0;
      for (const item of previousDirs) {
        await removeSafeMirrorRoot(item.full);
        prunedPreviousCount += 1;
      }
      return {
        action: 'keep_committed_target_after_source_publish',
        segment,
        preserved_previous_count: 0,
        pruned_previous_count: prunedPreviousCount,
      };
    }
    return {
      action: 'keep_committed_target',
      segment,
      preserved_previous_count: previousDirs.length,
      retained_previous_root: retainedMirrorGenerationFromIndex(segment, indexedAccount)?.root_name || '',
    };
  }

  const matching = [];
  for (const item of previousDirs) {
    throwIfDiscoveryAborted(signal);
    if (await previousMirrorRootMatchesIndexedContent(item.full, indexedAccount, { signal }).catch(e => {
      if (signal?.aborted || e?.name === 'AbortError') throw e;
      return false;
    })) matching.push(item);
  }
  if (matching.length !== 1) {
    const retained = retainedMirrorGenerationFromIndex(segment, indexedAccount);
    const retainedCandidates = retained
      ? previousDirs.filter(item => item.name === retained.root_name)
      : [];
    if (retainedCandidates.length === 1) {
      const retainedCandidate = retainedCandidates[0];
      const retainedStillMatches = await verifyRetainedCandidate(retainedCandidate, retained);
      if (!retainedStillMatches) throw ambiguous('保留代次在恢复复核期间发生变化；已保留当前目录和全部候选，停止自动回退。');
      const recoveryStagingRoot = path.join(WXDB_MIRROR_ROOT, `${segment}.recovery-staging-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
      let replacement = null;
      try {
        await copyMirrorGenerationToStaging(retainedCandidate.full, recoveryStagingRoot, { signal });
        if (!await previousMirrorRootMatchesIndexedContent(recoveryStagingRoot, retained.account_index, { signal })) {
          throw ambiguous('保留代次复制到恢复工作区后未通过完整清单校验；已保留所有项目副本。');
        }
        replacement = await replaceMirrorRootFromStaging(recoveryStagingRoot, targetRoot);
        if (!await previousMirrorRootMatchesIndexedContent(targetRoot, retained.account_index, { signal })) {
          throw ambiguous('恢复后的本地工作数据未通过保留代次完整清单校验；已尽量恢复原现场。');
        }
        const restored = await restoreMirrorIndexFromRetainedGeneration(segment, indexedAccount, retained);
        if (!await previousMirrorRootMatchesIndexedContent(targetRoot, restored, { signal })) {
          throw ambiguous('恢复后的本地工作数据与回退索引不一致；已保留当前目录和所有候选。');
        }
        const commit = await replacement.commit();
        return {
          action: 'restore_retained_previous',
          segment,
          retained_previous_root: retained.root_name,
          preserved_previous_count: previousDirs.length,
          previous_cleanup_pending: commit.previous_cleanup_pending,
        };
      } catch (error) {
        if (replacement && !replacement.settled) await rollbackMirrorRootReplacement(replacement, error);
        throw error;
      } finally {
        await removeSafeMirrorRoot(recoveryStagingRoot).catch(() => {});
      }
    }
    if (source_available) {
      notifyMirrorProgress(onProgress, {
        phase: 'mirror_recovery_rebuild',
        label: '检查本地数据 · 准备完整重建',
        detail: '发现无法由完整发布清单确认的项目内候选；已全部保留，接下来先从微信源库建立完整新版本，发布成功后再清理旧候选',
      });
      return { action: 'preserve_ambiguous_project_copies', segment, fresh_copy_required: true };
    }
    throw ambiguous(`检测到 ${previousDirs.length} 个崩溃前本地工作数据备份，但无法根据已提交索引唯一确认应恢复哪一个；已保留当前目录和全部候选且停止读取，避免误删完整副本。`);
  }

  const recovered = matching[0];
  const recoveredMatches = await previousMirrorRootMatchesIndexedContent(recovered.full, indexedAccount, { signal }).catch(e => {
    if (signal?.aborted || e?.name === 'AbortError') throw e;
    return false;
  });
  const recoveredStillMatches = recoveredMatches
    && await previousMirrorRootMatchesIndexedContent(recovered.full, indexedAccount, { signal }).catch(e => {
      if (signal?.aborted || e?.name === 'AbortError') throw e;
      return false;
    });
  if (!recoveredStillMatches) throw ambiguous('崩溃前本地工作数据候选在恢复复核期间发生变化；已保留当前目录和全部候选，停止自动恢复。');
  const recoveryStagingRoot = path.join(WXDB_MIRROR_ROOT, `${segment}.recovery-staging-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  let replacement = null;
  try {
    await copyMirrorGenerationToStaging(recovered.full, recoveryStagingRoot, { signal });
    if (!await previousMirrorRootMatchesIndexedContent(recoveryStagingRoot, indexedAccount, { signal })) throw ambiguous('恢复工作区未通过已提交完整清单校验。');
    replacement = await replaceMirrorRootFromStaging(recoveryStagingRoot, targetRoot);
    const restoredMatches = await previousMirrorRootMatchesIndexedContent(targetRoot, indexedAccount, { signal });
    if (!restoredMatches) throw ambiguous('恢复后的本地工作数据未通过已提交完整清单校验；已尽量恢复原现场。');
    const commit = await replacement.commit();
    return { action: 'restore_indexed_previous', segment, preserved_previous_count: previousDirs.length, previous_cleanup_pending: commit.previous_cleanup_pending };
  } catch (error) {
    if (replacement && !replacement.settled) await rollbackMirrorRootReplacement(replacement, error);
    throw error;
  } finally {
    await removeSafeMirrorRoot(recoveryStagingRoot).catch(() => {});
  }
}

async function previousMirrorRootMatchesIndexedContent(previousRoot = '', indexedAccount = null, {
  signal = null,
  verificationStats = null,
  onRebound = null,
} = {}) {
  const stats = plainObject(verificationStats) ? verificationStats : null;
  if (stats) {
    stats.identity_reused_files = 0;
    stats.hashed_files = 0;
  }
  if (!plainObject(indexedAccount)) return false;
  const manifest = indexedAccount.published_manifest;
  const indexedHash = String(indexedAccount.published_manifest_hash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(indexedHash) || mirrorPublishedManifestHash(manifest) !== indexedHash) return false;
  const expected = mirrorContentHashMapFromPayload(manifest);
  if (!expected.size || expected.size !== manifest.files.length) return false;
  await assertNoMirrorSymlinkTree(previousRoot);
  const dbStorage = path.join(previousRoot, 'db_storage');
  const categoryEntries = await fsp.readdir(dbStorage, { withFileTypes: true }).catch(e => {
    if (e?.code === 'ENOENT') return [];
    throw e;
  });
  if (categoryEntries.some(entry => entry.isDirectory() && /^.+\.previous-\d+-\d+-[a-f0-9]{8}$/i.test(entry.name))) return false;
  const actualFiles = await collectMirrorTargetSnapshotFiles(dbStorage, { signal });
  if (actualFiles.size !== expected.size) return false;
  const identityMatches = manifest.files.every(file => {
    const relative = normalizeMirrorRelative(file?.relative || '');
    const actual = actualFiles.get(relative);
    return !!relative
      && mirrorTargetSnapshotFileMatches(actual, file)
      && mirrorTargetIdentityMatches(actual, file)
      && Math.abs(Number(actual?.ctimeMs || 0) - Number(file?.ctimeMs || 0)) <= 2
      && Math.abs(Number(actual?.birthtimeMs || 0) - Number(file?.birthtimeMs || 0)) <= 2
      && Number(actual?.dev || 0) === Number(file?.dev || 0)
      && Number(actual?.ino || 0) === Number(file?.ino || 0);
  });
  if (identityMatches) {
    const afterIdentityFiles = await collectMirrorTargetSnapshotFiles(dbStorage, { signal });
    if (afterIdentityFiles.size !== actualFiles.size) return false;
    for (const [relative, file] of actualFiles) {
      if (!mirrorCollectedTargetFileIdentityMatches(file, afterIdentityFiles.get(relative))) return false;
    }
    await assertNoMirrorSymlinkTree(previousRoot);
    if (stats) stats.identity_reused_files = actualFiles.size;
    return true;
  }
  for (const [relative, sha256] of expected) {
    throwIfDiscoveryAborted(signal);
    const snapshotFile = actualFiles.get(relative);
    if (!snapshotFile?.is_file || snapshotFile.is_symbolic_link) return false;
    const target = path.resolve(dbStorage, relative);
    assertMirrorStagingTarget(dbStorage, target);
    const actualHash = await hashProjectMirrorCopyFile(target, { signal }).catch(e => {
      if (signal?.aborted || e?.name === 'AbortError') throw e;
      return '';
    });
    if (stats) stats.hashed_files += 1;
    if (actualHash !== sha256) return false;
  }
  const afterFiles = await collectMirrorTargetSnapshotFiles(dbStorage, { signal });
  if (afterFiles.size !== actualFiles.size) return false;
  for (const [relative, file] of actualFiles) {
    if (!mirrorCollectedTargetFileIdentityMatches(file, afterFiles.get(relative))) return false;
  }
  await assertNoMirrorSymlinkTree(previousRoot);
  if (typeof onRebound === 'function') {
    const published = reboundPublishedMirrorManifest(indexedAccount.published_manifest, afterFiles);
    if (!published) return false;
    await onRebound(mirrorAccountWithReboundPublishedManifest(indexedAccount, published));
  }
  return true;
}

async function mirrorPublishedManifestTargetIdentityState(targetRoot = '', indexedAccount = null, { signal = null } = {}) {
  if (!plainObject(indexedAccount)) return 'changed';
  const manifest = indexedAccount.published_manifest;
  const indexedHash = String(indexedAccount.published_manifest_hash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(indexedHash) || mirrorPublishedManifestHash(manifest) !== indexedHash) return 'changed';
  const expected = Array.isArray(manifest?.files) ? manifest.files : [];
  if (!expected.length) return 'changed';
  await assertNoMirrorSymlinkTree(targetRoot);
  const dbStorage = path.join(targetRoot, 'db_storage');
  const actual = await collectMirrorTargetSnapshotFiles(dbStorage, { signal });
  if (actual.size !== expected.length) return 'changed';
  let ctimeChanged = false;
  for (const file of expected) {
    throwIfDiscoveryAborted(signal);
    const relative = normalizeMirrorRelative(file?.relative || '');
    const target = actual.get(relative);
    if (!relative || !mirrorTargetSnapshotFileMatches(target, file)) return 'changed';
    const expectedBirthtime = Number(file.target_birthtimeMs || 0);
    if ((expectedBirthtime && Math.abs(Number(target.birthtimeMs || 0) - expectedBirthtime) > 2)
      || Number(target.dev || 0) !== Number(file.target_dev || 0)
      || Number(target.ino || 0) !== Number(file.target_ino || 0)) return 'changed';
    if (Math.abs(Number(target.ctimeMs || 0) - Number(file.target_ctimeMs || 0)) > 2) ctimeChanged = true;
  }
  return ctimeChanged ? 'ctime_only_changed' : 'current';
}

function rebindMirrorSnapshotPayloadTargetContent(payload = null, manifest = null, verifiedAt = '') {
  if (!plainObject(payload) || !Array.isArray(payload.files) || !payload.files.length) return null;
  const manifestFiles = new Map((Array.isArray(manifest?.files) ? manifest.files : []).map(file => [
    normalizeMirrorRelative(file?.relative || ''),
    file,
  ]).filter(([relative, file]) => !!relative && plainObject(file)));
  const files = [];
  for (const file of payload.files) {
    const relative = normalizeMirrorRelative(file?.relative || '');
    const current = manifestFiles.get(relative);
    if (!relative
      || !current
      || String(current.kind || '') !== String(file?.kind || '')
      || Number(current.bytes || 0) !== Number(file?.bytes || 0)
      || !/^[a-f0-9]{64}$/.test(String(current.sha256 || '').trim())
      || String(current.sha256 || '').trim().toLowerCase() !== String(file?.sha256 || '').trim().toLowerCase()) return null;
    files.push({
      ...file,
      ...mirrorTargetIdentityFields(current),
      sha256: String(current.sha256 || '').trim().toLowerCase(),
    });
  }
  return {
    ...payload,
    target_content_hash_alg: 'sha256',
    target_content_verified_at: String(verifiedAt || manifest?.target_content_verified_at || '').trim() || new Date().toISOString(),
    files,
  };
}

function reboundPublishedMirrorManifest(previousManifest = null, actualFiles = new Map(), verifiedAt = new Date().toISOString()) {
  if (!plainObject(previousManifest) || !Array.isArray(previousManifest.files) || !previousManifest.files.length) return null;
  const files = [];
  for (const file of previousManifest.files) {
    const relative = normalizeMirrorRelative(file?.relative || '');
    const actual = actualFiles.get(relative);
    if (!relative
      || !actual?.is_file
      || actual.is_symbolic_link
      || Number(actual.bytes || 0) !== Number(file?.bytes || 0)) return null;
    files.push({
      ...file,
      bytes: Number(actual.bytes || 0) || 0,
      mtimeMs: Number(actual.mtimeMs || 0) || 0,
      ctimeMs: Number(actual.ctimeMs || 0) || 0,
      birthtimeMs: Number(actual.birthtimeMs || 0) || 0,
      dev: Number(actual.dev || 0) || 0,
      ino: Number(actual.ino || 0) || 0,
      ...mirrorTargetIdentityFieldsFromStat(actual),
    });
  }
  const manifest = {
    ...previousManifest,
    target_content_verified_at: String(verifiedAt || '').trim() || new Date().toISOString(),
    files,
  };
  const hash = mirrorPublishedManifestHash(manifest);
  return hash ? { manifest, hash } : null;
}

function mirrorAccountWithReboundPublishedManifest(account = null, published = null) {
  if (!plainObject(account)
    || !plainObject(published?.manifest)
    || !/^[a-f0-9]{64}$/.test(String(published?.hash || '').trim().toLowerCase())) return null;
  const verifiedAt = String(published.manifest.target_content_verified_at || '').trim() || new Date().toISOString();
  const next = { ...account };
  const reboundRootSnapshot = rebindMirrorSnapshotPayloadTargetContent(next.source_snapshot, published.manifest, verifiedAt);
  if (reboundRootSnapshot) next.source_snapshot = reboundRootSnapshot;
  else if (plainObject(next.source_snapshot)) delete next.source_snapshot;
  const nextScopes = {};
  for (const [scopeKey, record] of Object.entries(plainObject(next.source_scopes) ? next.source_scopes : {})) {
    const rebound = rebindMirrorSnapshotPayloadTargetContent(record?.source_snapshot, published.manifest, verifiedAt);
    if (!rebound) continue;
    nextScopes[scopeKey] = {
      ...record,
      source_snapshot: rebound,
      checked_at: verifiedAt,
    };
  }
  next.source_scopes = nextScopes;
  if (!plainObject(next.source_snapshot) && !plainObject(next.source_scopes.full)) next.source_snapshot_meta_hash = '';
  next.published_manifest = published.manifest;
  next.published_manifest_hash = published.hash;
  next.checked_at = verifiedAt;
  return next;
}

async function rebindPublishedMirrorTargetMetadataAfterCleanup({
  accountId = '',
  targetDbStorage = '',
  signal = null,
  progress = null,
  publishedAccount = null,
  context = 'post_cleanup',
} = {}) {
  throwIfDiscoveryAborted(signal);
  const id = String(accountId || '').trim();
  if (!id) throw Object.assign(new Error('项目工作副本缺少账号标识，无法重绑发布清单。'), {
    status: 409,
    code: 'wxdb_mirror_publish_metadata_missing',
    public_code: 'wxdb_mirror_publish_metadata_missing',
  });
  const targetRoot = path.dirname(path.resolve(targetDbStorage || ''));
  const expectedManifestHash = String(publishedAccount?.published_manifest_hash || '').trim().toLowerCase();
  if (!plainObject(publishedAccount)
    || !/^[a-f0-9]{64}$/.test(expectedManifestHash)
    || mirrorPublishedManifestHash(publishedAccount.published_manifest) !== expectedManifestHash) {
    throw Object.assign(new Error('项目工作副本缺少可验证的发布清单，无法重绑最终文件身份。'), {
      status: 409,
      code: 'wxdb_mirror_publish_metadata_missing',
      public_code: 'wxdb_mirror_publish_metadata_missing',
    });
  }
  const identityState = await mirrorPublishedManifestTargetIdentityState(targetRoot, publishedAccount, { signal });
  if (identityState !== 'ctime_only_changed') {
    throw Object.assign(new Error('项目工作副本清理后的变化不只涉及硬链接时间，已拒绝沿用原内容哈希。'), {
      status: 409,
      code: 'wxdb_mirror_post_cleanup_identity_changed',
      public_code: 'wxdb_mirror_post_cleanup_identity_changed',
    });
  }
  const discardedStaging = context === 'discarded_staging';
  notifyMirrorProgress(progress, {
    phase: discardedStaging ? 'mirror_retry_identity_rebind' : 'mirror_publish_finalize',
    label: discardedStaging ? '检查本地数据 · 整理本轮临时副本' : '检查本地数据 · 确认最终发布清单',
    detail: discardedStaging
      ? '微信仍在写入，本轮临时副本已撤销；正在更新项目副本的文件身份，不重复读取数据库内容'
      : '旧硬链接代次已清理；正在复核文件集合、大小、时间和文件身份，不重复读取数据库内容',
  });
  const actualBefore = await collectMirrorTargetSnapshotFiles(targetDbStorage, { signal });
  const published = reboundPublishedMirrorManifest(
    publishedAccount.published_manifest,
    actualBefore,
    publishedAccount.published_manifest.target_content_verified_at,
  );
  if (!published) {
    throw Object.assign(new Error('项目工作副本最终文件集合无法重绑到已验证内容清单。'), {
      status: 409,
      code: 'wxdb_mirror_publish_metadata_missing',
      public_code: 'wxdb_mirror_publish_metadata_missing',
    });
  }
  const actualAfter = await collectMirrorTargetSnapshotFiles(targetDbStorage, { signal });
  if (actualAfter.size !== actualBefore.size) throw mirrorPublishedManifestRaceError();
  for (const [relative, file] of actualBefore) {
    if (!mirrorCollectedTargetFileIdentityMatches(file, actualAfter.get(relative))) {
      throw mirrorPublishedManifestRaceError();
    }
  }
  const reboundAccount = mirrorAccountWithReboundPublishedManifest(publishedAccount, published);
  if (!reboundAccount
    || await mirrorPublishedManifestTargetIdentityState(targetRoot, reboundAccount, { signal }) !== 'current') {
    throw Object.assign(new Error('项目工作副本最终文件身份复核失败，已拒绝提交重绑清单。'), {
      status: 409,
      code: 'wxdb_mirror_publish_metadata_missing',
      public_code: 'wxdb_mirror_publish_metadata_missing',
    });
  }
  await runWithWxDbMirrorIndexWriteLock(async () => {
    throwIfDiscoveryAborted(signal);
    const indexJson = await readMirrorIndex();
    indexJson.accounts = plainObject(indexJson.accounts) ? indexJson.accounts : {};
    const current = indexJson.accounts[id];
    if (!plainObject(current)
      || String(current.published_manifest_hash || '').trim().toLowerCase() !== expectedManifestHash
      || mirrorPublishedManifestHash(current.published_manifest) !== expectedManifestHash) {
      throw Object.assign(new Error('项目工作副本发布索引已变化，无法重绑最终清单。'), {
        status: 409,
        code: 'wxdb_mirror_publish_index_changed',
        public_code: 'wxdb_mirror_publish_index_changed',
      });
    }
    const next = mirrorAccountWithReboundPublishedManifest(current, published);
    if (!next) {
      throw Object.assign(new Error('项目工作副本最终清单无法重绑到当前索引。'), {
        status: 409,
        code: 'wxdb_mirror_publish_metadata_missing',
        public_code: 'wxdb_mirror_publish_metadata_missing',
      });
    }
    indexJson.accounts[id] = next;
    await ensureDir(WXDB_MIRROR_ROOT);
    await writeJsonAtomic(WXDB_MIRROR_INDEX, indexJson);
  });
  notifyMirrorProgress(progress, {
    phase: discardedStaging ? 'mirror_retry_identity_rebind_done' : 'mirror_publish_finalize_done',
    label: discardedStaging ? '检查本地数据 · 可继续稳定捕获' : '检查本地数据 · 最终发布清单已确认',
    detail: discardedStaging
      ? '项目副本仅因临时硬链接发生时间变化；已沿用此前验证的内容哈希，下一轮无需重读大文件'
      : '文件集合和身份一致；已沿用发布前验证的内容哈希，完整内容校验周期未延长',
  });
  return published;
}

function publishedMirrorIndexRecordMatches(indexedAccount = null, publishedAccount = null, retainedAccount = null, retainedRoot = '') {
  if (!plainObject(indexedAccount) || !plainObject(publishedAccount)) return false;
  const publishedHash = String(publishedAccount.published_manifest_hash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(publishedHash)
    || String(indexedAccount.published_manifest_hash || '').trim().toLowerCase() !== publishedHash
    || mirrorPublishedManifestHash(indexedAccount.published_manifest) !== publishedHash) return false;
  const descriptor = indexedAccount.retained_previous_generation;
  if (!retainedAccount) return !descriptor;
  if (!plainObject(descriptor) || Number(descriptor.version || 0) !== 1) return false;
  if (String(descriptor.root_name || '').trim() !== path.basename(String(retainedRoot || ''))) return false;
  const descriptorAccount = descriptor.account_index;
  if (!plainObject(descriptorAccount)) return false;
  const retainedHash = String(retainedAccount.published_manifest_hash || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(retainedHash)
    && String(descriptorAccount.published_manifest_hash || '').trim().toLowerCase() === retainedHash
    && mirrorPublishedManifestHash(descriptorAccount.published_manifest) === retainedHash;
}

function mirrorWorkDirInfo(name = '') {
  const text = String(name || '').trim();
  const match = /^(wxacc_[a-f0-9]{16})(?:\.(staging|verify|reuse-verify|previous)-|\.[a-z0-9_-]+-(staging|verify)-)/i.exec(text);
  if (!match) return null;
  return {
    segment: match[1].toLowerCase(),
    kind: (match[2] || match[3] || '').toLowerCase(),
  };
}

async function mirrorTargetHasCategoryBackups(targetDbStorage = '', { signal = null } = {}) {
  throwIfDiscoveryAborted(signal);
  const dbStorage = path.resolve(targetDbStorage || '');
  await assertSafeMirrorTargetRoot(dbStorage);
  const entries = await fsp.readdir(dbStorage, { withFileTypes: true }).catch(e => {
    if (e?.code === 'ENOENT') return [];
    throw e;
  });
  throwIfDiscoveryAborted(signal);
  return entries.some(entry => /^.+\.previous-\d+-\d+-[a-f0-9]{8}$/i.test(entry.name));
}

function mirrorRefreshAction(reason = '') {
  switch (String(reason || '')) {
    case 'source_snapshot_unchanged':
      return 'reuse';
    case 'first_copy':
      return 'create';
    default:
      return 'replace';
  }
}

function mirrorReadinessToken({
  accountId = '',
  scope = {},
  manifestScope = scope,
  sourceSnapshotMetaHash = '',
  publishedManifestHash = '',
  refreshedAt = '',
  stale = false,
  sourceBusy = false,
  offline = false,
  sourceAccess = '',
  refreshReason = '',
  sourceBusyReuseMode = '',
  requiredThroughMs = 0,
  requestedRangeCovered = false,
} = {}) {
  const capturedAt = String(refreshedAt || '').trim();
  const sourceHash = String(sourceSnapshotMetaHash || '').trim().toLowerCase();
  const publishedHash = String(publishedManifestHash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sourceHash) || !/^[a-f0-9]{64}$/.test(publishedHash)) {
    throw Object.assign(new Error('本地工作数据缺少完整代际证明；已停止读取，避免混用无法确认的数据库副本。'), {
      status: 409,
      code: 'wxdb_mirror_readiness_missing',
      public_code: 'wxdb_mirror_readiness_missing',
    });
  }
  return {
    account_id: String(accountId || '').trim(),
    scope: scope?.key || 'full',
    manifest_scope: manifestScope?.key || scope?.key || 'full',
    source_snapshot_meta_hash: sourceHash,
    published_manifest_hash: publishedHash,
    refreshed_at: capturedAt,
    captured_at: capturedAt,
    stale: stale === true,
    source_busy: sourceBusy === true,
    offline: offline === true,
    source_access: String(sourceAccess || '').trim(),
    refresh_reason: String(refreshReason || '').trim(),
    source_busy_reuse_mode: String(sourceBusyReuseMode || '').trim(),
    required_through_ms: Math.max(0, Number(requiredThroughMs || 0) || 0),
    requested_range_covered: requestedRangeCovered === true,
  };
}

function notifyMirrorProgress(onProgress, data = {}) {
  if (typeof onProgress !== 'function') return;
  try { onProgress(data); } catch {}
}

function formatMirrorBytes(bytes = 0) {
  const value = Math.max(0, Number(bytes || 0) || 0);
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)}MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${value}B`;
}

function linkWxDbMirrorAbortSignal(controller, signal) {
  if (!signal?.addEventListener) return () => {};
  const abort = () => {
    if (controller.signal.aborted) return;
    controller.abort(signal.reason instanceof Error ? signal.reason : discoveryAbortError());
  };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener?.('abort', abort);
}

export function activeWxDbMirrorTaskStatus() {
  const now = Date.now();
  return {
    active: ACTIVE_WXDB_MIRROR_TASKS.size,
    closing: WXDB_MIRROR_TASK_ADMISSION_CLOSED,
    tasks: [...ACTIVE_WXDB_MIRROR_TASKS.values()].map(task => ({
      id: task.id,
      account_id: task.account_id,
      reason: task.reason,
      started_at: new Date(task.started_at).toISOString(),
      elapsed_ms: Math.max(0, now - task.started_at),
      aborted: task.controller.signal.aborted,
    })),
  };
}

function wxDbMirrorShutdownError(message = '') {
  return Object.assign(new Error(message || WXDB_MIRROR_TASK_SHUTDOWN_MESSAGE || '服务正在关闭，本地工作数据准备未开始。'), {
    name: 'AbortError',
    status: 503,
    code: 'wxdb_mirror_shutdown',
    public_code: 'wxdb_mirror_shutdown',
  });
}

function abortActiveWxDbMirrorTasks(error) {
  let aborted = 0;
  for (const task of ACTIVE_WXDB_MIRROR_TASKS.values()) {
    if (task.controller.signal.aborted) continue;
    task.controller.abort(error);
    aborted += 1;
  }
  return aborted;
}

export function cancelActiveWxDbMirrorTasks(message = '服务正在关闭，本地工作数据准备已取消。') {
  const error = Object.assign(new Error(message), {
    name: 'AbortError',
    status: 499,
    code: 'wxdb_mirror_cancelled',
    public_code: 'wxdb_mirror_cancelled',
  });
  return { ...activeWxDbMirrorTaskStatus(), aborted: abortActiveWxDbMirrorTasks(error) };
}

export function closeWxDbMirrorTaskAdmission(message = '服务正在关闭，本地工作数据准备已取消。') {
  WXDB_MIRROR_TASK_ADMISSION_CLOSED = true;
  WXDB_MIRROR_TASK_SHUTDOWN_MESSAGE = String(message || '').trim();
  const aborted = abortActiveWxDbMirrorTasks(wxDbMirrorShutdownError());
  return { ...activeWxDbMirrorTaskStatus(), aborted };
}

export async function waitForActiveWxDbMirrorTasksToSettle(timeoutMs = 30_000) {
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, Number(timeoutMs || 0) || 0);
  while (ACTIVE_WXDB_MIRROR_TASKS.size && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return {
    ...activeWxDbMirrorTaskStatus(),
    waited_ms: Date.now() - startedAt,
  };
}

export function setWxDbMirrorRefreshListener(listener = null) {
  wxDbMirrorRefreshListener = typeof listener === 'function' ? listener : null;
}

export function setWxDbMirrorIdentityChangeListener(listener = null) {
  wxDbMirrorIdentityChangeListener = typeof listener === 'function' ? listener : null;
}

async function notifyWxDbMirrorRefreshed({ mirror = null, account = null } = {}) {
  if (!mirror?.refreshed || typeof wxDbMirrorRefreshListener !== 'function') return;
  try {
    await wxDbMirrorRefreshListener({
      mirror,
      account,
      account_id: mirror.account_id || account?.account_id || account?.id || account?.wxid || '',
    });
  } catch {}
}

export async function ensureWxDbMirror(options = {}) {
  if (WXDB_MIRROR_TASK_ADMISSION_CLOSED) throw wxDbMirrorShutdownError();
  const accountId = String(options?.account_id || '').trim();
  const reason = String(options?.reason || 'auto').trim() || 'auto';
  const controller = new AbortController();
  const unlink = linkWxDbMirrorAbortSignal(controller, options?.signal || null);
  const id = NEXT_WXDB_MIRROR_TASK_ID++;
  ACTIVE_WXDB_MIRROR_TASKS.set(id, {
    id,
    account_id: accountId,
    reason,
    started_at: Date.now(),
    controller,
  });
  try {
    return await ensureWxDbMirrorTracked({
      ...options,
      account_id: accountId,
      reason,
      signal: controller.signal,
    });
  } finally {
    unlink();
    ACTIVE_WXDB_MIRROR_TASKS.delete(id);
  }
}

async function notifyWxDbMirrorIdentityChanged(change = {}) {
  if (change?.identity_switched !== true || typeof wxDbMirrorIdentityChangeListener !== 'function') return;
  try {
    await wxDbMirrorIdentityChangeListener(change);
  } catch {}
}

async function ensureWxDbMirrorTracked({ account_id = '', signal = null, onProgress = null, force = false, reason = 'auto', source_busy_reuse_purpose = '', allow_stale_account = false, required_through_ms = 0 } = {}) {
  throwIfDiscoveryAborted(signal);
  let scope = mirrorScopeForReason(reason);
  let forceRefresh = force === true;
  const sourceDiscovery = await discoverSourceWxAccountsResult({ signal });
  const sourceAccounts = sourceDiscovery.accounts;
  let sourceDiscoveryError = null;
  throwIfDiscoveryAborted(signal);
  const sourceResolution = await resolveSourceAccountForMirrorRequest(sourceAccounts, account_id, { signal });
  const source = sourceResolution?.source || null;
  if (!source) {
    const offlineIndex = await readMirrorIndex();
    sourceDiscoveryError = sourceDiscoveryErrorForRequestedAccount(sourceDiscovery, account_id, offlineIndex);
    if (sourceDiscoveryError && !allow_stale_account) throw sourceDiscoveryError;
    if (allow_stale_account) {
      const offlineMirrorSegment = mirrorSegmentForRequestedOfflineAccount(offlineIndex, account_id);
      await cleanupStaleWxDbMirrorWorkDirs({
        mirror_segment: offlineMirrorSegment,
        source_available: false,
        onProgress,
        signal,
      });
      const mirrored = await discoverMirroredWxAccounts([], { signal });
      const candidates = mirrored.filter(account => accountMatchesId(account, account_id));
      if (candidates.length > 1) {
        throw Object.assign(new Error('当前本地工作数据对应多个微信账号，已拒绝按别名猜测旧副本。请刷新账号列表并明确选择账号后重试。'), {
          status: 409,
          code: 'wxdb_source_account_ambiguous',
          public_code: 'wxdb_source_account_ambiguous',
        });
      }
      if (candidates.length === 1) {
        return reuseOfflineWxDbMirror(candidates[0], { scope, signal, onProgress, sourceDiscoveryError });
      }
    }
    if (sourceDiscoveryError) throw sourceDiscoveryError;
    throw Object.assign(new Error('未找到可读取的微信账号数据库目录，不能确认本地工作数据是否最新，已拒绝复用旧数据。请确认微信数据目录存在，并在右上角选择正确账号后重试。'), {
      status: 404,
      code: 'wxdb_source_account_missing',
      public_code: 'wxdb_source_account_missing',
    });
  }
  const accountId = String(sourceResolution?.storage_account_id || source.account_id || accountOpaqueId(source.db_storage)).trim();
  return runWithWxDbMirrorLock(accountId, async () => {
    throwIfDiscoveryAborted(signal);
    const indexJson = await readMirrorIndex();
  let existing = indexJson.accounts?.[accountId] || {};
    const mirrorSegment = safeMirrorSegment(accountId);
    const targetRoot = path.join(WXDB_MIRROR_ROOT, mirrorSegment);
    await assertSafeMirrorTargetRoot(targetRoot);
    const recovery = await cleanupStaleWxDbMirrorWorkDirs({
      mirror_segment: mirrorSegment,
      source_available: !!String(source?.db_storage || '').trim(),
      onProgress,
      signal,
    });
    const postRecoveryIndex = await readMirrorIndex();
    existing = postRecoveryIndex.accounts?.[accountId] || {};
    const crashRecoveryRequiresFullRebuild = recovery.recovery_actions.some(action => action?.fresh_copy_required === true);
    const targetDbStorage = path.join(targetRoot, 'db_storage');
    await assertSafeMirrorTargetRoot(targetDbStorage);
    const targetStat = await statMirrorTargetDbStorage(targetDbStorage, { signal });
    const categoryBackupRequiresFullRebuild = !!targetStat
      && await mirrorTargetHasCategoryBackups(targetDbStorage, { signal });
    const recoveryRequiresFullRebuild = crashRecoveryRequiresFullRebuild || categoryBackupRequiresFullRebuild;
    if (recoveryRequiresFullRebuild) {
      scope = mirrorScopeForReason('full');
      forceRefresh = true;
      if (categoryBackupRequiresFullRebuild) {
        notifyMirrorProgress(onProgress, {
          phase: 'mirror_category_recovery_rebuild',
          label: '检查本地数据 · 准备完整重建',
          detail: '发现旧版本留下的分类备份；已保留原目录，先建立完整新版本并成功发布后再整体替换',
        });
      }
    }
    const groupsIdentityGuardRequired = scope.key === 'groups' && isWxDbMirrorIdentityVerified(existing);
    let sourceGenerationHash = sourceAccountGenerationHash(source);
    let groupsIdentityAnchorCurrent = false;
    const upgradeGroupsToIdentityScope = detail => {
      scope = mirrorScopeForReason('identity');
      notifyMirrorProgress(onProgress, {
        phase: 'groups_source_generation_changed',
        label: '读取群列表 · 重新确认当前账号',
        detail: detail || '消息库总体代次与上次账号验证不一致；自动复制最小消息样本到项目工作目录并重新验证，不会返回上一账号的群列表',
      });
    };
    try {
    const prepareMirrorScopeSnapshot = async activeScope => {
      const preparedSnapshot = await collectStableMirrorSourceSnapshot(source, {
        signal,
        categories: activeScope.categories,
        scope: activeScope,
        onProgress,
      });
      assertMirrorSourceSnapshotSupportsScope(preparedSnapshot, activeScope);
      let targetMatches = targetStat?.isDirectory()
        ? await mirrorTargetMatchesSourceSnapshot(targetDbStorage, preparedSnapshot, {
            signal,
            allowExtra: activeScope.allowExtraTargetFiles,
            extraScopeCategories: mirrorScopeCategoriesToReplace(preparedSnapshot, activeScope),
          })
        : false;
      let targetPayload = null;
      if (targetMatches) {
        const indexedScope = mirrorIndexedScopeRecord(existing, activeScope, preparedSnapshot);
        const indexedSnapshot = mirrorIndexedSnapshotForScope(existing, activeScope, preparedSnapshot);
        if (mirrorIndexedSnapshotHasContentHashes(indexedSnapshot, preparedSnapshot)) {
          const verifiedAt = mirrorTargetContentVerifiedAt(indexedSnapshot, indexedScope);
          const targetIdentityCurrent = await mirrorPublishedTargetIdentityMatches(targetDbStorage, indexedSnapshot, preparedSnapshot, { signal });
          if (targetIdentityCurrent && mirrorTargetContentHashFresh(indexedSnapshot, indexedScope)) {
            targetPayload = projectIndexedMirrorPayloadToSnapshot(indexedSnapshot, preparedSnapshot, {
              targetContentVerifiedAt: verifiedAt,
            });
            if (typeof onProgress === 'function') {
              try {
                onProgress({
                  phase: 'mirror_reuse_verify_cached',
                  label: '检查本地数据 · 快速校验完成',
                  detail: '文件清单、大小和修改时间一致；复用最近完整内容校验，最长 24 小时重新校验一次',
                });
              } catch {}
            }
          } else {
            if (typeof onProgress === 'function') {
              try {
                onProgress({
                  phase: 'mirror_reuse_verify_hash',
                  label: '检查本地数据 · 完整校验本地工作数据',
                  detail: targetIdentityCurrent
                    ? '距离上次完整校验已超过 24 小时；只读取项目内本地工作数据，不读取微信源库内容'
                    : '项目副本缺少可复用的文件身份记录或文件身份已变化；正在重新完整校验项目内本地工作数据',
                });
              } catch {}
            }
            targetPayload = await mirrorSnapshotIndexPayloadForTarget(preparedSnapshot, targetDbStorage, { signal, onProgress });
            targetMatches = mirrorSnapshotContentHashesMatch(indexedSnapshot, targetPayload, preparedSnapshot);
          }
        } else {
          targetMatches = false;
        }
      }
      return {
        snapshot: preparedSnapshot,
        targetMatchesSnapshot: targetMatches,
        targetSnapshotPayload: targetPayload,
      };
    };
    const prepareStableMirrorScope = async () => {
      let prepared = await prepareMirrorScopeSnapshot(scope);
      const decideRefresh = () => mirrorRefreshDecision({
        force: forceRefresh,
        targetExists: !!targetStat?.isDirectory(),
        targetMatchesSnapshot: prepared.targetMatchesSnapshot,
        existingSnapshotMetaHash: mirrorScopeSnapshotHash(existing, scope, prepared.snapshot),
        sourceSnapshotMetaHash: prepared.snapshot.hash,
      });
      let decision = decideRefresh();
      while (true) {
        if (decision.should_refresh) break;
        try {
          prepared.snapshot = await confirmMirrorSourceSnapshotStillStable(source, prepared.snapshot, {
            signal,
            scope,
            onProgress,
            phase: 'mirror_reuse_source_verify',
            label: '检查本地数据 · 复用前确认源库代次',
          });
          break;
        } catch (error) {
          if (String(error?.code || '') !== 'wxdb_source_changed_during_mirror_copy') throw error;
          notifyMirrorProgress(onProgress, {
            phase: 'mirror_reuse_source_changed',
            label: '检查本地数据 · 发现新写入',
            detail: '源 DB/WAL 在复用确认期间发生变化；放弃旧副本复用，自动捕获最新稳定代次',
          });
          prepared = await prepareMirrorScopeSnapshot(scope);
          decision = decideRefresh();
        }
      }
      return { ...prepared, refreshDecision: decision };
    };
    let preparedScope = await prepareStableMirrorScope();
    if (groupsIdentityGuardRequired && scope.key === 'groups') {
      const confirmedSourceGenerationHash = await readSourceAccountGenerationHash(source, { signal });
      sourceGenerationHash = confirmedSourceGenerationHash;
      const sourceWithGeneration = {
        ...source,
        source_generation_hash: confirmedSourceGenerationHash,
      };
      const generationAlreadyCurrent = mirrorIdentitySourceGenerationCurrent(existing, confirmedSourceGenerationHash);
      groupsIdentityAnchorCurrent = generationAlreadyCurrent
        || mirrorRefreshIdentityAnchorCurrent(
          existing,
          sourceWithGeneration,
          scope,
          preparedScope.snapshot,
          preparedScope.targetSnapshotPayload,
        );
      if (!groupsIdentityAnchorCurrent) {
        upgradeGroupsToIdentityScope('账号联系人数据与上次验证结果不一致；正在复制最小消息样本重新确认当前账号，避免显示上一账号的群列表');
        preparedScope = await prepareStableMirrorScope();
      } else if (!generationAlreadyCurrent) {
        existing = await recordWxDbMirrorIdentityGenerationContinuity({
          accountId,
          existing,
          sourceGenerationHash: confirmedSourceGenerationHash,
          signal,
        });
      }
    }
    const { snapshot, targetMatchesSnapshot, targetSnapshotPayload, refreshDecision } = preparedScope;
    const sourceForMirror = {
      ...source,
      source_generation_hash: sourceGenerationHash,
    };
    const refreshReason = refreshDecision.reason;
    const refreshReasonLabel = refreshDecision.label;
    const refreshAction = refreshDecision.action;
    const unchanged = !refreshDecision.should_refresh;
    if (unchanged) {
      const reuseRecord = await recordWxDbMirrorReuse({
        accountId,
        mirrorSegment,
        source: sourceForMirror,
        snapshot,
          existing,
          refreshReason,
          refreshReasonLabel,
          refreshAction,
          scope,
          snapshotPayload: targetSnapshotPayload,
          identityAnchorCurrent: groupsIdentityAnchorCurrent,
          signal,
        });
      if (typeof onProgress === 'function') {
        try {
          onProgress({
            phase: 'mirror_reuse',
            label: '检查本地数据 · 已是最新',
            detail: refreshReasonLabel,
          });
        } catch {}
      }
      return {
        ok: true,
        account_id: accountId,
        mirror_readiness: mirrorReadinessToken({
          accountId,
          scope,
          sourceSnapshotMetaHash: snapshot.hash,
          publishedManifestHash: reuseRecord.published_manifest_hash || existing.published_manifest_hash || '',
          refreshedAt: reuseRecord.refreshed_at || existing.refreshed_at || existing.imported_at || '',
          sourceAccess: 'copy_only_auto_reuse',
          refreshReason,
        }),
        reused: true,
        refreshed: false,
        reason,
        mirror_relative_root: `${WXDB_MIRROR_ROOT_RELATIVE}/${mirrorSegment}`,
        mirror_db_relative_root: `${WXDB_MIRROR_ROOT_RELATIVE}/${mirrorSegment}/db_storage`,
        source_access: 'copy_only_auto_reuse',
        db_count: Number(reuseRecord.db_count || snapshot.db_count || 0) || 0,
        refreshed_db_count: 0,
        bytes: Number(reuseRecord.bytes || snapshot.bytes || 0) || 0,
        categories: reuseRecord.summary?.categories || existing.summary?.categories || [],
        refreshed_categories: [],
        refreshed_at: reuseRecord.refreshed_at || existing.refreshed_at || existing.imported_at || '',
        checked_at: reuseRecord.checked_at || '',
        source_snapshot_meta_hash: snapshot.hash,
        refresh_reason: refreshReason,
        refresh_reason_label: refreshReasonLabel,
        refresh_action: refreshAction,
      };
    }
    if (typeof onProgress === 'function') {
      try {
        onProgress({
          phase: 'mirror_refresh_needed',
          label: '检查本地数据 · 需要更新',
          detail: `${refreshReasonLabel}；先准备临时工作数据，确认稳定后${refreshAction === 'create' ? '创建' : '更新'}本地工作数据`,
        });
      } catch {}
    }
    const stableCopyAttempts = mirrorCopyAttemptsForRequest({
      force: forceRefresh,
      scope,
      sourceBusyReusePurpose: source_busy_reuse_purpose || reason,
      targetExists: !!targetStat?.isDirectory(),
      indexedSnapshot: mirrorIndexedSnapshotForScope(existing, scope, snapshot),
      sourceSnapshot: snapshot,
      identityAnchorCurrent: groupsIdentityAnchorCurrent,
    });
    const refreshInput = {
      source: sourceForMirror,
      sourceSnapshot: snapshot,
      existingMirrorIndex: existing,
      mirrorSegment,
      sourceAccess: 'copy_only_auto',
      signal,
      onProgress,
      reason,
      refreshReason,
      scope,
      stableCopyAttempts,
    };
    const result = targetStat?.isDirectory()
      ? await refreshWxDbMirrorScopeUnlocked(refreshInput)
      : await importWxDbMirrorUnlocked(refreshInput);
    if (recoveryRequiresFullRebuild) {
      await cleanupStaleWxDbMirrorWorkDirs({
        mirror_segment: mirrorSegment,
        source_available: false,
        source_backed_publish_succeeded: true,
        onProgress,
        signal,
      });
    }
    const committedIndex = await readMirrorIndex();
    const committedAccount = committedIndex.accounts?.[accountId];
    const committedManifestHash = String(committedAccount?.published_manifest_hash || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(committedManifestHash)
      || mirrorPublishedManifestHash(committedAccount?.published_manifest) !== committedManifestHash) {
      throw Object.assign(new Error('本地工作数据已发布，但最终文件清单未能稳定绑定；已停止读取。'), {
        status: 409,
        code: 'wxdb_mirror_readiness_missing',
        public_code: 'wxdb_mirror_readiness_missing',
      });
    }
    const mirrorResult = {
      ...result,
      mirror_readiness: mirrorReadinessToken({
        accountId,
        scope,
        sourceSnapshotMetaHash: result.source_snapshot_meta_hash || snapshot.hash,
        publishedManifestHash: committedManifestHash,
        refreshedAt: result.refreshed_at || '',
        sourceAccess: result.source_access || 'copy_only_auto',
        refreshReason,
      }),
      reused: false,
      refreshed: true,
      auto: true,
      identity_anchor_current: result.identity_anchor_current === true,
      previous_snapshot_meta_hash: existing.source_snapshot_meta_hash || '',
      refresh_reason: refreshReason,
      refresh_reason_label: refreshReasonLabel,
      refresh_action: refreshAction,
    };
    await notifyWxDbMirrorRefreshed({ mirror: mirrorResult, account: source });
    return mirrorResult;
    } catch (error) {
      if (String(error?.code || '') !== 'wxdb_source_changed_during_mirror_copy'
        || !targetStat?.isDirectory()
        || forceRefresh) throw error;
      const mirroredAccounts = await discoverMirroredWxAccounts(sourceAccounts, { signal });
      const verifiedPreviousMirror = mirroredAccounts.find(account => String(account.account_id || account.id || '').trim() === accountId);
      if (!verifiedPreviousMirror) throw error;
      const sourceBusyReuse = sourceBusyMirrorReusePolicy({
        account: verifiedPreviousMirror,
        scope,
        reason: source_busy_reuse_purpose || reason,
        requiredThroughMs: required_through_ms,
        identityAnchorCurrent: error?.source_busy_identity_anchor_current === true,
      });
      if (!sourceBusyReuse.allowed) throw error;
      try {
        return await reuseOfflineWxDbMirror(verifiedPreviousMirror, {
          scope,
          signal,
          onProgress,
          sourceBusyError: error,
          sourceBusyReuse,
        });
      } catch (reuseError) {
        error.mirror_reuse_error_code = String(reuseError?.code || '').trim();
        throw error;
      }
    }
  }, { signal });
}

async function mirrorPublishedTargetIdentityMatches(targetDbStorage = '', payload = {}, snapshot = {}, { signal = null } = {}) {
  const payloadFiles = mirrorPayloadFilesByRelative(payload);
  const wanted = mirrorSnapshotRelativeFiles(snapshot);
  if (!wanted.length) return false;
  const expected = wanted.map(relative => payloadFiles.get(relative));
  if (expected.some(file => !file || !mirrorTargetIdentityRecorded(file))) return false;
  const actual = await collectMirrorTargetSnapshotFiles(targetDbStorage, { signal });
  return wanted.every(relative => {
    const file = payloadFiles.get(relative);
    const target = actual.get(relative);
    return mirrorTargetSnapshotFileMatches(target, file) && mirrorTargetIdentityMatches(target, file);
  });
}

function verifiedMirrorScopeCandidate(account = {}, scope = {}) {
  const mirror = account?.mirror && typeof account.mirror === 'object' && !Array.isArray(account.mirror)
    ? account.mirror
    : {};
  return wxDbMirrorScopeRecordsForRead(mirror, scope).find(candidate => {
    const record = candidate?.record;
    const snapshot = record?.source_snapshot && typeof record.source_snapshot === 'object' && !Array.isArray(record.source_snapshot)
      ? record.source_snapshot
      : null;
    const hash = String(record?.source_snapshot_meta_hash || '').trim();
    const files = Array.isArray(snapshot?.files) ? snapshot.files : [];
    return /^[a-f0-9]{64}$/i.test(hash)
      && String(snapshot?.target_content_hash_alg || '').toLowerCase() === 'sha256'
      && files.length > 0
      && files.every(file => normalizeMirrorRelative(file?.relative) && /^[a-f0-9]{64}$/i.test(String(file?.sha256 || '').trim()));
  }) || null;
}

function sourceBusyMirrorReusePolicy({
  account = {},
  scope = {},
  reason = '',
  requiredThroughMs = 0,
  identityAnchorCurrent = false,
} = {}) {
  const candidate = verifiedMirrorScopeCandidate(account, scope);
  const record = candidate?.record || {};
  const mirror = account?.mirror && typeof account.mirror === 'object' && !Array.isArray(account.mirror)
    ? account.mirror
    : {};
  const rawCapturedAt = String(record.refreshed_at || mirror.refreshed_at || mirror.imported_at || '').trim();
  const capturedMs = Date.parse(rawCapturedAt);
  const capturedAt = Number.isFinite(capturedMs) ? new Date(capturedMs).toISOString() : '';
  const requiredMs = Math.max(0, Number(requiredThroughMs || 0) || 0);
  const verifiedGroupList = String(reason || '').trim().toLowerCase() === 'groups'
    && String(scope?.key || '').trim().toLowerCase() === 'groups';
  const verifiedCurrentIdentity = identityAnchorCurrent === true
    && isWxDbMirrorIdentityVerified(account);
  // Capture time cannot prove completeness: WeChat may later sync a message
  // whose create_time belongs to an older requested range. A group-list read
  // makes no message-completeness claim, so it may use a verified stable copy.
  const allowed = !!candidate && verifiedGroupList && verifiedCurrentIdentity;
  return {
    allowed,
    mode: allowed ? 'verified_group_list' : '',
    captured_at: capturedAt,
    captured_ms: Number.isFinite(capturedMs) ? capturedMs : 0,
    required_through_ms: requiredMs,
    requested_range_covered: false,
    scope: String(candidate?.key || scope?.key || '').trim(),
    identity_anchor_current: verifiedCurrentIdentity,
  };
}

async function reuseOfflineWxDbMirror(account = {}, options = {}) {
  const signal = options?.signal || null;
  const accountId = String(account.account_id || account.id || '').trim();
  if (!accountId) return reuseOfflineWxDbMirrorLocked(account, options);
  return runWithWxDbMirrorLock(accountId, async () => {
    throwIfDiscoveryAborted(signal);
    const currentMirrors = await discoverMirroredWxAccounts([], { signal });
    const current = currentMirrors.find(item => String(item.account_id || item.id || '').trim() === accountId);
    if (!current) {
      throw offlineMirrorVerificationError('项目工作副本索引在等待读取锁期间已变化，无法确认当前副本仍属于所选账号。');
    }
    return reuseOfflineWxDbMirrorLocked(current, options);
  }, { signal });
}

async function reuseOfflineWxDbMirrorLocked(account = {}, {
  scope = mirrorScopeForReason('auto'),
  signal = null,
  onProgress = null,
  sourceDiscoveryError = null,
  sourceBusyError = null,
  sourceBusyReuse = null,
} = {}) {
  throwIfDiscoveryAborted(signal);
  const sourceBusy = String(sourceBusyError?.code || '') === 'wxdb_source_changed_during_mirror_copy';
  const accountId = String(account.account_id || account.id || '').trim();
  const targetDbStorageInput = String(account.db_storage || '').trim();
  const targetDbStorage = targetDbStorageInput ? path.resolve(targetDbStorageInput) : '';
  const mirror = account.mirror && typeof account.mirror === 'object' ? account.mirror : {};
  const scopedCandidate = verifiedMirrorScopeCandidate(account, scope);
  const scoped = scopedCandidate?.record || null;
  const resolvedScope = mirrorScopeForReason(scopedCandidate?.key || scope.key);
  const exposedScope = sourceBusy && sourceBusyReuse?.mode === 'verified_group_list'
    ? mirrorScopeForReason('groups')
    : resolvedScope;
  const snapshot = scoped?.source_snapshot && typeof scoped.source_snapshot === 'object' && !Array.isArray(scoped.source_snapshot)
    ? scoped.source_snapshot
    : null;
  const sourceHash = String(scoped?.source_snapshot_meta_hash || (scope.key === 'full' ? mirror.source_snapshot_meta_hash : '') || '').trim();
  const files = Array.isArray(snapshot?.files) ? snapshot.files : [];
  const relativeFiles = files.map(file => normalizeMirrorRelative(file?.relative));
  if (!accountId || !targetDbStorage || !sourceHash || !/^[a-f0-9]{64}$/i.test(sourceHash)
    || String(snapshot?.target_content_hash_alg || '').toLowerCase() !== 'sha256'
    || !files.length
    || new Set(relativeFiles).size !== files.length
    || files.some((file, index) => !relativeFiles[index] || !/^[a-f0-9]{64}$/i.test(String(file?.sha256 || '').trim()))) {
    throw Object.assign(new Error('已找到旧项目工作副本，但缺少完整的发布清单或内容校验记录；为避免读取不完整副本，必须先恢复微信源目录并自动更新。'), {
      status: 409,
      code: 'wxdb_mirror_offline_unverified',
      public_code: 'wxdb_mirror_offline_unverified',
    });
  }
  await assertSafeMirrorTargetRoot(path.dirname(targetDbStorage));
  await assertSafeMirrorTargetRoot(targetDbStorage);
  await assertNoMirrorSymlinkTree(path.dirname(targetDbStorage));
  const verification = await verifyOfflineMirrorContent({
    accountId,
    targetDbStorage,
    scope: resolvedScope,
    scoped,
    snapshot,
    sourceBusy,
    signal,
    onProgress,
  });
  notifyMirrorProgress(onProgress, {
    phase: sourceBusy ? 'mirror_source_busy_reuse' : 'mirror_offline_reuse',
    label: sourceBusy ? '检查本地数据 · 使用上次稳定副本' : '检查本地数据 · 已确认使用项目副本',
    detail: sourceBusy
      ? (sourceBusyReuse?.mode === 'verified_group_list'
        ? `微信持续写入导致最新复制未能稳定完成；已使用${verification.cached ? '近期完整校验仍有效的' : '刚完成完整校验的'}上次稳定副本显示群列表${sourceBusyReuse?.captured_at ? `（副本截点 ${new Date(sourceBusyReuse.captured_at).toLocaleString('zh-CN', { hour12: false })}）` : ''}；生成时会重新检查消息数据`
        : `微信持续写入导致最新复制未能稳定完成；已按旧账号读取确认使用${verification.cached ? '近期完整校验仍有效的' : '刚完成完整校验的'}上次稳定副本${sourceBusyReuse?.captured_at ? `（副本截点 ${new Date(sourceBusyReuse.captured_at).toLocaleString('zh-CN', { hour12: false })}）` : ''}；该副本可能缺少之后同步的历史时间消息`)
      : (sourceDiscoveryError
        ? '微信源目录当前不可读；已确认项目副本完整，本次只读取项目内副本，不覆盖源库'
        : '微信源目录当前不存在；已确认项目副本完整，本次只读取项目内副本，不覆盖源库'),
  });
  return {
    ok: true,
    account_id: accountId,
    mirror_readiness: mirrorReadinessToken({
      accountId,
      scope: exposedScope,
      manifestScope: resolvedScope,
      sourceSnapshotMetaHash: sourceHash,
      publishedManifestHash: mirror.published_manifest_hash || '',
      refreshedAt: String(scoped?.refreshed_at || mirror.refreshed_at || mirror.imported_at || '').trim(),
      stale: true,
      sourceBusy,
      offline: !sourceBusy,
      sourceAccess: sourceBusy ? 'copy_only_busy_reuse' : 'copy_only_offline_reuse',
      refreshReason: sourceBusy ? 'source_busy_stable_snapshot_reused' : 'offline_source_unavailable',
      sourceBusyReuseMode: sourceBusy ? sourceBusyReuse?.mode : '',
      requiredThroughMs: sourceBusy ? sourceBusyReuse?.required_through_ms : 0,
      requestedRangeCovered: sourceBusy ? sourceBusyReuse?.requested_range_covered === true : false,
    }),
    reused: true,
    refreshed: false,
    stale: true,
    refreshed_at: String(scoped?.refreshed_at || mirror.refreshed_at || mirror.imported_at || '').trim(),
    captured_at: String(scoped?.refreshed_at || mirror.refreshed_at || mirror.imported_at || '').trim(),
    source_access: sourceBusy ? 'copy_only_busy_reuse' : 'copy_only_offline_reuse',
    mirror_relative_root: String(mirror.relative_root || '').trim(),
    mirror_db_relative_root: `${String(mirror.relative_root || '').trim()}/db_storage`.replace(/^\//, ''),
    source_snapshot_meta_hash: sourceHash,
    refresh_reason: sourceBusy ? 'source_busy_stable_snapshot_reused' : 'offline_source_unavailable',
    refresh_reason_label: sourceBusy
      ? (sourceBusyReuse?.mode === 'verified_group_list'
        ? '微信持续写入，群列表复用已校验的上次稳定副本'
        : '微信持续写入，复用已校验的上次稳定副本')
      : (sourceDiscoveryError ? '源目录不可读，复用已校验项目副本' : '源目录不存在，复用已校验项目副本'),
    refresh_action: 'reuse',
    offline: !sourceBusy,
    source_busy: sourceBusy,
    source_busy_reuse_mode: sourceBusy ? String(sourceBusyReuse?.mode || '').trim() : '',
    required_through_ms: sourceBusy ? Math.max(0, Number(sourceBusyReuse?.required_through_ms || 0) || 0) : 0,
    requested_range_covered: sourceBusy && sourceBusyReuse?.requested_range_covered === true,
    requested_mirror_scope: scope.key || 'full',
    mirror_scope: exposedScope.key || 'full',
  };
}

async function verifyOfflineMirrorContent({
  accountId = '',
  targetDbStorage = '',
  scope = mirrorScopeForReason('auto'),
  scoped = {},
  snapshot = {},
  sourceBusy = false,
  signal = null,
  onProgress = null,
} = {}) {
  const files = Array.isArray(snapshot?.files) ? snapshot.files : [];
  const totalBytes = files.reduce((sum, file) => sum + Math.max(0, Number(file?.bytes || 0) || 0), 0);
  const identityCurrent = await offlineMirrorTargetIdentityMatches(targetDbStorage, files, { signal, scope });
  if (identityCurrent && mirrorTargetContentHashFresh(snapshot, scoped)) {
    notifyMirrorProgress(onProgress, {
      phase: sourceBusy ? 'mirror_source_busy_verify_cached' : 'mirror_offline_verify_cached',
      label: sourceBusy ? '检查本地数据 · 上次稳定副本可用' : '检查本地数据 · 离线工作副本可用',
      detail: `已核对 ${files.length} 个项目副本文件的集合、大小、修改时间和文件身份；最近完整内容校验仍在 24 小时有效期内`,
      file_count: files.length,
      total_bytes: totalBytes,
    });
    return { cached: true, file_count: files.length, bytes: totalBytes };
  }

  notifyMirrorProgress(onProgress, {
    phase: sourceBusy ? 'mirror_source_busy_verify_hash' : 'mirror_offline_verify_hash',
    label: sourceBusy ? '检查本地数据 · 完整校验上次稳定副本' : '检查本地数据 · 完整校验离线工作副本',
    detail: identityCurrent
      ? `最近完整校验已超过 24 小时；正在读取项目副本并校验 ${files.length} 个文件（${formatMirrorBytes(totalBytes)}）`
      : `项目副本缺少可复用的文件身份记录或文件身份已变化；正在重新完整校验 ${files.length} 个文件（${formatMirrorBytes(totalBytes)}）`,
    file_count: files.length,
    total_bytes: totalBytes,
  });
  const verifiedFiles = [];
  let completedBytes = 0;
  for (const [index, file] of files.entries()) {
    throwIfDiscoveryAborted(signal);
    const relative = normalizeMirrorRelative(file.relative);
    const target = path.resolve(targetDbStorage, ...relative.split('/'));
    assertMirrorStagingTarget(targetDbStorage, target);
    const stat = await fsp.lstat(target).catch(() => null);
    if (!stat?.isFile?.() || stat.isSymbolicLink?.() || !mirrorTargetSnapshotFileMatches({
      is_file: true,
      is_symbolic_link: false,
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
    }, file)) {
      throw offlineMirrorVerificationError('项目工作副本文件缺失、大小或修改时间已变化；源目录不可用时不会冒险读取。');
    }
    const fileBytes = Math.max(0, Number(file.bytes || 0) || 0);
    const digest = await hashProjectMirrorCopyFile(target, {
      signal,
      includeIdentity: true,
      onProgress: progress => {
        const bytesRead = Math.min(totalBytes, completedBytes + Math.max(0, Number(progress?.bytes_read || 0) || 0));
        notifyMirrorProgress(onProgress, {
          phase: sourceBusy ? 'mirror_source_busy_verify_hash_progress' : 'mirror_offline_verify_hash_progress',
          label: sourceBusy ? '检查本地数据 · 完整校验上次稳定副本' : '检查本地数据 · 完整校验离线工作副本',
          detail: `${index + 1}/${files.length} ${relative} · ${formatMirrorBytes(bytesRead)}/${formatMirrorBytes(totalBytes)}`,
          index: index + 1,
          total: files.length,
          bytes_read: bytesRead,
          total_bytes: totalBytes,
          percent: totalBytes ? Math.min(100, Math.round(bytesRead / totalBytes * 100)) : 100,
        });
      },
    });
    if (digest.sha256 !== String(file.sha256 || '').trim().toLowerCase()) {
      throw offlineMirrorVerificationError('项目工作副本内容校验未通过；源目录不可用时不会读取可能损坏的副本。');
    }
    completedBytes += fileBytes;
    verifiedFiles.push({
      ...file,
      ...mirrorTargetIdentityFields(digest.target_identity),
      sha256: digest.sha256,
    });
  }
  const verifiedExpected = new Map(verifiedFiles.map(file => [normalizeMirrorRelative(file?.relative || ''), file]));
  const verifiedActual = await collectMirrorTargetSnapshotFiles(targetDbStorage, { signal });
  if (!mirrorTargetFileSetMatchesScope(verifiedActual, verifiedExpected, scope)) {
    throw offlineMirrorVerificationError('项目工作副本在完整校验期间出现了本次范围之外的新增、缺失或额外数据库文件；源目录不可用时不会读取。');
  }
  const verifiedAt = new Date().toISOString();
  await rememberOfflineMirrorContentVerification(accountId, scope, snapshot, verifiedFiles, verifiedAt, { signal });
  return { cached: false, file_count: files.length, bytes: totalBytes, verified_at: verifiedAt };
}

function offlineMirrorVerificationError(message = '') {
  return Object.assign(new Error(`${String(message || '').trim()} 必须先恢复微信源目录并重新复制。`), {
    status: 409,
    code: 'wxdb_mirror_offline_unverified',
    public_code: 'wxdb_mirror_offline_unverified',
  });
}

function mirrorTargetFileSetMatchesScope(actual = new Map(), expected = new Map(), scope = {}) {
  const coveredCategories = new Set([...expected.keys()].map(relative => relative.split('/')[0]).filter(Boolean));
  const allowExtra = scope?.allowExtraTargetFiles === true;
  if (!allowExtra && actual.size !== expected.size) return false;
  for (const relative of actual.keys()) {
    if (expected.has(relative)) continue;
    const category = relative.split('/')[0] || '';
    if (!allowExtra || coveredCategories.has(category)) return false;
  }
  return true;
}

async function offlineMirrorTargetIdentityMatches(targetDbStorage = '', files = [], { signal = null, scope = {} } = {}) {
  const expected = new Map((Array.isArray(files) ? files : []).map(file => [normalizeMirrorRelative(file?.relative || ''), file]));
  if (!expected.size || [...expected.values()].some(file => !mirrorTargetIdentityRecorded(file))) return false;
  const actual = await collectMirrorTargetSnapshotFiles(targetDbStorage, { signal });
  if (!mirrorTargetFileSetMatchesScope(actual, expected, scope)) return false;
  for (const [relative, file] of expected) {
    throwIfDiscoveryAborted(signal);
    const target = actual.get(relative);
    if (!mirrorTargetSnapshotFileMatches(target, file) || !mirrorTargetIdentityMatches(target, file)) return false;
  }
  return true;
}

function mirrorTargetIdentityRecorded(file = {}) {
  return Number(file.target_ctimeMs || 0) > 0
    && Number(file.target_dev || 0) > 0
    && Number(file.target_ino || 0) > 0;
}

function mirrorTargetIdentityMatches(target = {}, file = {}) {
  if (!mirrorTargetIdentityRecorded(file)) return false;
  const expectedBirthtime = Number(file.target_birthtimeMs || 0);
  return Math.abs(Number(target.ctimeMs || 0) - Number(file.target_ctimeMs || 0)) <= 2
    && (!expectedBirthtime || Math.abs(Number(target.birthtimeMs || 0) - expectedBirthtime) <= 2)
    && Number(target.dev || 0) === Number(file.target_dev || 0)
    && Number(target.ino || 0) === Number(file.target_ino || 0);
}

async function rememberOfflineMirrorContentVerification(accountId = '', scope = {}, snapshot = {}, verifiedFiles = [], verifiedAt = '', { signal = null } = {}) {
  throwIfDiscoveryAborted(signal);
  await runWithWxDbMirrorIndexWriteLock(async () => {
    throwIfDiscoveryAborted(signal);
    const indexJson = await readMirrorIndex();
    const previous = indexJson.accounts?.[accountId];
    if (!plainObject(previous)) return;
    const candidate = wxDbMirrorScopeRecordsForRead(previous, scope).find(item => item?.record?.source_snapshot === snapshot)
      || wxDbMirrorScopeRecordsForRead(previous, scope).find(item => String(item?.record?.source_snapshot_meta_hash || '') === mirrorSnapshotPayloadMetaHash(snapshot));
    const key = String(candidate?.key || scope?.key || '').trim();
    if (!key || !plainObject(previous.source_scopes?.[key])) return;
    const currentPayload = previous.source_scopes[key].source_snapshot;
    const currentHash = mirrorSnapshotPayloadMetaHash(currentPayload);
    const expectedHash = mirrorSnapshotPayloadMetaHash(snapshot);
    if (!currentHash || currentHash !== expectedHash) return;
    const nextPayload = {
      ...currentPayload,
      target_content_verified_at: verifiedAt,
      files: verifiedFiles,
    };
    previous.source_scopes[key] = {
      ...previous.source_scopes[key],
      source_snapshot: nextPayload,
      checked_at: verifiedAt,
    };
    if (key === 'full') previous.source_snapshot = nextPayload;
    indexJson.accounts[accountId] = previous;
    await writeJsonAtomic(WXDB_MIRROR_INDEX, indexJson);
  });
}

function wxDbMirrorIdentityProofSufficient(proof = {}) {
  const value = plainObject(proof) ? proof : {};
  return value.evidence === 'direct_message_sender_across_independent_peers'
    && Math.max(0, Number(value.peer_support || 0) || 0) >= 2
    && Math.max(0, Number(value.matched_peer_tables || 0) || 0) >= 2
    && Array.isArray(value.sampled_message_dbs)
    && value.sampled_message_dbs.length >= 1;
}

export async function recordWxDbMirrorAccountIdentity({ account_id = '', self_wxid = '', evidence = null, expected_published_manifest_hash = '', expected_source_generation_hash = '', expected_identity_snapshot_hash = '', signal = null } = {}) {
  throwIfDiscoveryAborted(signal);
  const storageId = String(account_id || '').trim().toLowerCase();
  const selfWxid = String(self_wxid || '').trim();
  const expectedPublishedManifestHash = String(expected_published_manifest_hash || '').trim().toLowerCase();
  const expectedSourceGenerationHash = String(expected_source_generation_hash || '').trim().toLowerCase();
  const expectedIdentitySnapshotHash = String(expected_identity_snapshot_hash || '').trim().toLowerCase();
  if (!/^wxacc_[a-f0-9]{16}$/.test(storageId)
    || !selfWxid
    || selfWxid.length > 200
    || selfWxid.endsWith('@chatroom')
    || !/^[a-f0-9]{64}$/.test(expectedPublishedManifestHash)
    || !/^[a-f0-9]{64}$/.test(expectedSourceGenerationHash)
    || !/^[a-f0-9]{64}$/.test(expectedIdentitySnapshotHash)) {
    throw Object.assign(new Error('项目副本账号身份记录无效，已拒绝写入。'), {
      status: 400,
      code: 'wxdb_account_identity_invalid',
      public_code: 'wxdb_account_identity_invalid',
    });
  }
  const recorded = await runWithWxDbMirrorLock(storageId, () => runWithWxDbMirrorIndexWriteLock(async () => {
    const indexJson = await readMirrorIndex();
    const previous = indexJson.accounts?.[storageId];
    if (!plainObject(previous)) {
      throw Object.assign(new Error('项目副本索引缺少当前存储账号，无法绑定本人身份。'), {
        status: 409,
        code: 'wxdb_account_identity_index_missing',
        public_code: 'wxdb_account_identity_index_missing',
      });
    }
    const currentPublishedManifestHash = String(previous.published_manifest_hash || '').trim().toLowerCase();
    const currentSourceGenerationHash = String(previous.source_generation_hash || '').trim().toLowerCase();
    const currentIdentitySnapshotHash = String(wxDbMirrorScopeRecordsForRead(previous, 'identity')
      .map(candidate => candidate?.record?.source_snapshot_meta_hash)
      .find(value => /^[a-f0-9]{64}$/i.test(String(value || '').trim())) || '').trim().toLowerCase();
    if (currentPublishedManifestHash !== expectedPublishedManifestHash
      || mirrorPublishedManifestHash(previous.published_manifest) !== currentPublishedManifestHash
      || currentSourceGenerationHash !== expectedSourceGenerationHash
      || currentIdentitySnapshotHash !== expectedIdentitySnapshotHash) {
      throw Object.assign(new Error('账号身份验证期间，本地工作数据已更新为另一个快照；已拒绝把旧快照的身份证据写入当前账号。'), {
        status: 409,
        code: 'wxdb_mirror_readiness_changed',
        public_code: 'wxdb_mirror_readiness_changed',
      });
    }
    const previousSelfWxid = String(previous.verified_self_wxid || '').trim();
    const identityId = `wxacct_${crypto.createHash('sha256').update(selfWxid).digest('hex').slice(0, 24)}`;
    const proof = plainObject(evidence) ? {
      evidence: String(evidence.evidence || '').trim().slice(0, 120),
      peer_support: Math.max(0, Number(evidence.peer_support || 0) || 0),
      matched_peer_tables: Math.max(0, Number(evidence.matched_peer_tables || 0) || 0),
      sampled_message_dbs: [...new Set((Array.isArray(evidence.sampled_message_dbs) ? evidence.sampled_message_dbs : [])
        .map(value => String(value || '').trim())
        .filter(value => /^message_\d+\.db$/i.test(value)))].slice(0, 8),
    } : {};
    if (!wxDbMirrorIdentityProofSufficient(proof)) {
      throw Object.assign(new Error('项目副本缺少足够的一对一消息证据，不能变更微信本人账号绑定。'), {
        status: 409,
        code: 'wxdb_account_identity_unverified',
        public_code: 'wxdb_account_identity_unverified',
      });
    }
    const previousIdentityId = String(previous.identity_id || '').trim();
    const identitySwitched = !!previousSelfWxid && previousSelfWxid !== selfWxid;
    const unchanged = previousSelfWxid === selfWxid
      && previousIdentityId === identityId
      && JSON.stringify(previous.identity_evidence || {}) === JSON.stringify(proof)
      && String(previous.identity_generation_status || '').trim() === 'verified'
      && mirrorIdentitySourceGenerationCurrent(previous, currentSourceGenerationHash)
      && String(previous.identity_generation_evidence?.type || '').trim().toLowerCase() !== 'account_bound_key_reopened_contact';
    if (!unchanged) {
      const generationVerifiedAt = new Date().toISOString();
      indexJson.accounts[storageId] = {
        ...previous,
        storage_id: storageId,
        identity_id: identityId,
        verified_self_wxid: selfWxid,
        identity_status: 'verified',
        identity_verified_at: generationVerifiedAt,
        identity_evidence: proof,
        identity_generation_status: 'verified',
        identity_generation_evidence: {
          type: 'message_identity_proof',
          verified_at: generationVerifiedAt,
        },
        identity_generation_changed_at: '',
        identity_generation_verified_at: generationVerifiedAt,
        identity_source_generation_hash: currentSourceGenerationHash,
        identity_generation_previous_snapshot_meta_hash: '',
        identity_generation_snapshot_meta_hash: currentIdentitySnapshotHash,
      };
      await writeJsonAtomic(WXDB_MIRROR_INDEX, indexJson);
    }
    return {
      ok: true,
      storage_id: storageId,
      identity_id: identityId,
      self_wxid: selfWxid,
      changed: !unchanged,
      identity_switched: identitySwitched,
      previous_identity_id: previousIdentityId,
      identity_evidence: proof,
      identity_generation_status: String(indexJson.accounts[storageId].identity_generation_status || '').trim(),
      identity_generation_verified_at: String(indexJson.accounts[storageId].identity_generation_verified_at || '').trim(),
      identity_source_generation_hash: String(indexJson.accounts[storageId].identity_source_generation_hash || '').trim().toLowerCase(),
      identity_snapshot_hash: String(indexJson.accounts[storageId].identity_generation_snapshot_meta_hash || '').trim().toLowerCase(),
    };
  }), { signal });
  await notifyWxDbMirrorIdentityChanged(recorded);
  return recorded;
}

async function recordWxDbMirrorIdentityGenerationContinuity({
  accountId = '',
  existing = {},
  sourceGenerationHash = '',
  signal = null,
} = {}) {
  throwIfDiscoveryAborted(signal);
  const generationHash = String(sourceGenerationHash || '').trim().toLowerCase();
  if (!/^wxacc_[a-f0-9]{16}$/.test(String(accountId || '').trim().toLowerCase())
    || !/^[a-f0-9]{64}$/.test(generationHash)) {
    throw Object.assign(new Error('账号联系人数据连续性记录无效，已停止复用旧身份。'), {
      status: 409,
      code: 'wxdb_identity_generation_continuity_invalid',
      public_code: 'wxdb_identity_generation_continuity_invalid',
    });
  }
  return runWithWxDbMirrorIndexWriteLock(async () => {
    throwIfDiscoveryAborted(signal);
    const indexJson = await readMirrorIndex();
    const previous = indexJson.accounts?.[accountId];
    const expectedIdentityId = String(existing?.identity_id || '').trim().toLowerCase();
    const expectedManifestHash = String(existing?.published_manifest_hash || '').trim().toLowerCase();
    const currentManifestHash = String(previous?.published_manifest_hash || '').trim().toLowerCase();
    const generationEvidenceType = String(previous?.identity_generation_evidence?.type || '').trim().toLowerCase();
    if (!plainObject(previous)
      || !hasWxDbMirrorIdentityAnchor(previous)
      || String(previous.identity_generation_status || '').trim().toLowerCase() !== 'verified'
      || generationEvidenceType !== 'message_identity_proof'
      || !wxDbMirrorIdentityProofSufficient(previous.identity_evidence)
      || String(previous.identity_id || '').trim().toLowerCase() !== expectedIdentityId
      || (expectedManifestHash && currentManifestHash !== expectedManifestHash)) {
      throw Object.assign(new Error('账号身份或本地工作数据在连续性确认期间已变化，已停止复用。'), {
        status: 409,
        code: 'wxdb_mirror_readiness_changed',
        public_code: 'wxdb_mirror_readiness_changed',
      });
    }
    indexJson.accounts[accountId] = {
      ...previous,
      source_generation_hash: generationHash,
      identity_generation_status: 'verified',
      identity_generation_changed_at: '',
      identity_source_generation_hash: generationHash,
    };
    await writeJsonAtomic(WXDB_MIRROR_INDEX, indexJson);
    return indexJson.accounts[accountId];
  });
}

async function recordWxDbMirrorReuse({
  accountId = '',
  mirrorSegment = '',
  source = {},
  snapshot = {},
  existing = {},
  refreshReason = 'source_snapshot_unchanged',
  refreshReasonLabel = mirrorRefreshReasonLabel('source_snapshot_unchanged'),
  refreshAction = mirrorRefreshAction('source_snapshot_unchanged'),
  scope = mirrorScopeForReason('auto'),
  snapshotPayload = null,
  identityAnchorCurrent = false,
  signal = null,
} = {}) {
  throwIfDiscoveryAborted(signal);
  return runWithWxDbMirrorIndexWriteLock(async () => {
    throwIfDiscoveryAborted(signal);
    const indexJson = await readMirrorIndex();
    indexJson.accounts = plainObject(indexJson.accounts) ? indexJson.accounts : {};
    const previous = indexJson.accounts[accountId] || existing || {};
    const checked_at = new Date().toISOString();
    const refreshed_at = previous.refreshed_at || previous.imported_at || checked_at;
    const summary = plainObject(previous.summary)
      ? previous.summary
      : {
        categories: [],
        db_count: Number(snapshot.db_count || 0) || 0,
        bytes: Number(snapshot.bytes || 0) || 0,
        last_write_time: snapshot.last_write_time || '',
      };
    const payload = plainObject(snapshotPayload) ? snapshotPayload : mirrorSnapshotIndexPayload(snapshot);
    indexJson.accounts[accountId] = {
      ...previous,
      ...mirrorIdentityFieldsForRefresh(previous, scope, snapshot, payload, {
        identityAnchorCurrent,
        sourceGenerationHash: source.source_generation_hash,
      }),
      account_id: accountId,
      mirror_segment: mirrorSegment,
      legacy_id: source.legacy_id || source.id || previous.legacy_id || '',
      wxid: source.wxid || previous.wxid || '',
      display_name: source.display_name || source.name || previous.display_name || '',
      account_aliases: [...new Set([
        ...(Array.isArray(previous.account_aliases) ? previous.account_aliases : []),
        ...(Array.isArray(source.account_aliases) ? source.account_aliases : []),
        source.id,
        source.wxid,
      ].filter(Boolean))],
      source_platform: process.platform,
      source_access: previous.source_access || 'copy_only_auto',
      mirror_scope: scope.key || previous.mirror_scope || 'full',
      refresh_reason: refreshReason,
      refresh_reason_label: refreshReasonLabel,
      refresh_action: refreshAction,
      source_account_root: source.account_root || previous.source_account_root || '',
      source_db_storage: source.db_storage || previous.source_db_storage || '',
      source_db_storage_realpath: source.db_storage_realpath || previous.source_db_storage_realpath || '',
      source_generation_hash: String(source.source_generation_hash || previous.source_generation_hash || '').trim().toLowerCase(),
      source_snapshot_meta_hash: scope.key === 'full'
        ? (snapshot.hash || previous.source_snapshot_meta_hash || '')
        : (scope.key === 'identity' && refreshAction !== 'reuse' ? '' : (previous.source_snapshot_meta_hash || '')),
      source_snapshot: scope.key === 'full'
        ? payload
        : (scope.key === 'identity' && refreshAction !== 'reuse' ? null : (plainObject(previous.source_snapshot) ? previous.source_snapshot : null)),
      source_scopes: mirrorSourceScopesForWrite(previous, scope, snapshot, refreshed_at, refreshReason, refreshAction, payload, { checkedAt: checked_at }),
      imported_at: previous.imported_at || refreshed_at,
      refreshed_at,
      checked_at,
      db_count: Number(summary.db_count || snapshot.db_count || previous.db_count || 0) || 0,
      bytes: Number(summary.bytes || snapshot.bytes || previous.bytes || 0) || 0,
      summary,
    };
    await ensureDir(WXDB_MIRROR_ROOT);
    await writeJsonAtomic(WXDB_MIRROR_INDEX, indexJson);
    return indexJson.accounts[accountId];
  });
}

async function pickSourceAccountForMirrorRequest(sourceAccounts = [], requested = '', { signal = null } = {}) {
  const resolution = await resolveSourceAccountForMirrorRequest(sourceAccounts, requested, { signal });
  return resolution?.source || null;
}

function mirrorSourceAccountResolution(source = null, storageAccountId = '') {
  if (!source) return null;
  return {
    source,
    storage_account_id: String(storageAccountId || source.account_id || accountOpaqueId(source.db_storage)).trim(),
  };
}

async function mirrorIndexPhysicalBindingsForSource(index = {}, source = {}, { signal = null } = {}) {
  const sourceStorage = String(source?.db_storage_realpath || source?.db_storage || '').trim();
  if (!sourceStorage) return [];
  const matches = [];
  for (const [accountId, item] of Object.entries(index?.accounts || {})) {
    throwIfDiscoveryAborted(signal);
    const boundStorage = await mirrorAccountSourceDbStorageRealpath(item);
    if (boundStorage && sameRealPath(boundStorage, sourceStorage)) matches.push({ accountId, item });
  }
  return matches;
}

async function resolveSourceAccountForMirrorRequest(sourceAccounts = [], requested = '', { signal = null } = {}) {
  throwIfDiscoveryAborted(signal);
  const direct = pickAccount(sourceAccounts, requested);
  const index = await readMirrorIndex();
  throwIfDiscoveryAborted(signal);
  if (direct) {
    const physicalMatches = await mirrorIndexPhysicalBindingsForSource(index, direct, { signal });
    if (physicalMatches.length > 1) {
      throw Object.assign(new Error('同一微信数据库目录对应多个本地工作账号，已拒绝猜测要更新哪一份。请保留 data/wxdb-mirror 和索引文件后重启服务检查。'), {
        status: 409,
        code: 'wxdb_source_account_ambiguous',
        public_code: 'wxdb_source_account_ambiguous',
      });
    }
    return mirrorSourceAccountResolution(direct, physicalMatches[0]?.accountId);
  }
  if (!String(requested || '').trim()) return null;
  const matches = Object.entries(index.accounts || {})
    .filter(([accountId, item]) => mirrorIndexAccountMatchesRequest(accountId, item, requested));
  if (!matches.length) return null;
  if (matches.length > 1) {
    throw Object.assign(new Error('账号标识不唯一，请在页面右上角重新选择微信账号后再试。'), {
      status: 400,
      code: 'account_selection_ambiguous',
      public_code: 'account_selection_ambiguous',
    });
  }
  const [mirrorAccountId, item] = matches[0];
  const source = await uniqueMirrorSourceAccount(sourceAccounts, mirrorAccountId, item);
  return mirrorSourceAccountResolution(source, mirrorAccountId);
}

function mirrorIndexAccountMatchesRequest(accountId = '', item = {}, requested = '') {
  const needle = String(requested || '').trim();
  if (!needle) return false;
  return [
    accountId,
    item.account_id,
    item.legacy_id,
    item.wxid,
    item.source_account_id,
    ...(Array.isArray(item.account_aliases) ? item.account_aliases : []),
  ].some(value => String(value || '').trim() === needle);
}

async function mirrorAccountSourceDbStorageRealpath(item = {}) {
  const candidates = [item.source_db_storage_realpath, item.source_db_storage]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  for (const candidate of candidates) {
    const resolved = await fsp.realpath(candidate).catch(() => '');
    if (resolved) return resolved;
  }
  return '';
}

function mirrorSourceAccountIdentity(account = {}) {
  const pathValue = account?.db_storage_realpath || account?.db_storage || '';
  if (pathValue) return platformPathIdentity(pathValue);
  return String(account?.account_id || '').trim();
}

async function uniqueMirrorSourceAccount(sourceAccounts = [], mirrorAccountId = '', item = {}) {
  const expectedDbStorageReal = await mirrorAccountSourceDbStorageRealpath(item);
  // A moved source directory is a different data identity. Alias-only recovery
  // would silently bind an old project copy to a new account directory.
  if (!expectedDbStorageReal) return null;
  const candidates = [];
  const seen = new Set();
  for (const account of Array.isArray(sourceAccounts) ? sourceAccounts : []) {
    const key = mirrorSourceAccountIdentity(account);
    if (!key || seen.has(key)) continue;
    if (!sameRealPath(account?.db_storage_realpath || account?.db_storage, expectedDbStorageReal)) continue;
    seen.add(key);
    candidates.push(account);
  }
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  throw Object.assign(new Error('本地工作数据对应的微信账号源目录不唯一，已拒绝按最近写入时间猜测账号。请在页面右上角选择正确账号后重试。'), {
    status: 400,
    code: 'wxdb_source_account_ambiguous',
    public_code: 'wxdb_source_account_ambiguous',
  });
}

function mirrorSourceStatusLabel(status = '') {
  switch (String(status || '').trim()) {
    case 'available':
      return '源账号已匹配';
    case 'ambiguous':
      return '源账号不唯一';
    case 'unreadable':
      return '微信数据目录或配置暂不可读';
    case 'missing':
      return '源账号未找到';
    default:
      return '源账号状态未知';
  }
}

function pathContainsDiscoveryPath(parent = '', child = '') {
  const rawParent = String(parent || '').trim();
  const rawChild = String(child || '').trim();
  if (!rawParent || !rawChild) return false;
  const relative = path.relative(path.resolve(rawParent), path.resolve(rawChild));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sourceDiscoveryIssueMatchesMirror(issue = {}, mirrorAccountId = '', item = {}, requested = '') {
  if (!issue?.error) return false;
  if (issue.scope === 'all_roots') return true;
  if (issue.scope === 'configuration' || issue.scope === 'configuration_file') return true;
  const sourcePaths = [item.source_db_storage_realpath, item.source_db_storage]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  if (issue.db_storage && sourcePaths.some(sourcePath => sameRealPath(issue.db_storage, sourcePath))) return true;
  if (issue.account_root && sourcePaths.some(sourcePath => pathContainsDiscoveryPath(issue.account_root, sourcePath))) return true;
  if (issue.scope === 'root') {
    const discoveryRoots = [issue.xwechat_files, issue.data_root]
      .map(value => String(value || '').trim())
      .filter(Boolean);
    if (sourcePaths.some(sourcePath => discoveryRoots.some(root => pathContainsDiscoveryPath(root, sourcePath)))) return true;
  }
  const issueHasPath = !!String(issue.db_storage || issue.account_root || issue.xwechat_files || issue.data_root || '').trim();
  if (issueHasPath && sourcePaths.length) return false;

  const issueAliases = [issue.account_id, issue.account_name]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  const mirrorAliases = [
    requested,
    mirrorAccountId,
    item.account_id,
    item.legacy_id,
    item.wxid,
    item.source_account_id,
    ...(Array.isArray(item.account_aliases) ? item.account_aliases : []),
  ].map(value => String(value || '').trim()).filter(Boolean);
  return issueAliases.some(alias => mirrorAliases.includes(alias));
}

function sourceDiscoveryErrorForMirrorRequest(unreadable = [], requested = '', indexJson = {}) {
  const matches = Object.entries(indexJson?.accounts || {})
    .filter(([accountId, item]) => mirrorIndexAccountMatchesRequest(accountId, item, requested));
  const candidates = matches.length
    ? matches
    : [[String(requested || '').trim(), { account_id: String(requested || '').trim() }]];
  const issues = Array.isArray(unreadable) ? unreadable : [];
  const orderedIssues = [
    ...issues.filter(issue => !['configuration', 'configuration_file'].includes(issue?.scope)),
    ...issues.filter(issue => ['configuration', 'configuration_file'].includes(issue?.scope)),
  ];
  for (const issue of orderedIssues) {
    if (candidates.some(([accountId, item]) => sourceDiscoveryIssueMatchesMirror(issue, accountId, item, requested))) {
      return issue.error || null;
    }
  }
  return null;
}

function sourceDiscoveryErrorForRequestedAccount(discovery = {}, requested = '', indexJson = {}) {
  const accountId = String(requested || '').trim();
  if (accountId) return sourceDiscoveryErrorForMirrorRequest(discovery?.unreadable, accountId, indexJson);
  const accounts = Array.isArray(discovery?.accounts) ? discovery.accounts : [];
  const unreadable = Array.isArray(discovery?.unreadable) ? discovery.unreadable : [];
  return !accounts.length && unreadable.length
    ? sourceDiscoveryAggregateError(unreadable, '微信账号目录均不可读')
    : null;
}

async function safeMirrorSourceAccountResolution(sourceAccounts = [], mirrorAccountId = '', item = {}, { signal = null, unreadable = [] } = {}) {
  throwIfDiscoveryAborted(signal);
  try {
    const source = await uniqueMirrorSourceAccount(sourceAccounts, mirrorAccountId, item);
    if (source) return { status: 'available', source };
    const issues = Array.isArray(unreadable) ? unreadable : [];
    const unreadableIssue = issues
      .filter(issue => !['configuration', 'configuration_file'].includes(issue?.scope))
      .find(issue => sourceDiscoveryIssueMatchesMirror(issue, mirrorAccountId, item, mirrorAccountId))
      || issues
        .filter(issue => ['configuration', 'configuration_file'].includes(issue?.scope))
        .find(issue => sourceDiscoveryIssueMatchesMirror(issue, mirrorAccountId, item, mirrorAccountId));
    const unreadableError = unreadableIssue?.error || null;
    return unreadableError
      ? { status: 'unreadable', source: null, error: unreadableError }
      : { status: 'missing', source: null };
  } catch (e) {
    if (e?.code === 'wxdb_source_account_ambiguous') return { status: 'ambiguous', source: null, error: e };
    throw e;
  }
}

function mirrorIndexSourceLastWriteTime(item = {}) {
  const fullScope = item?.source_scopes && typeof item.source_scopes === 'object' && !Array.isArray(item.source_scopes)
    ? item.source_scopes.full
    : null;
  const candidates = [
    item?.source_snapshot?.last_write_time,
    fullScope?.source_snapshot?.last_write_time,
    item?.summary?.last_write_time,
  ];
  return candidates
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .sort((a, b) => safeDiscoveryTimeMs(b) - safeDiscoveryTimeMs(a))[0] || '';
}

function sourceAccountLastWriteTime(account = {}) {
  const candidates = [
    account?.summary?.last_write_time,
    account?.last_write_time,
  ];
  return candidates
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .sort((a, b) => safeDiscoveryTimeMs(b) - safeDiscoveryTimeMs(a))[0] || '';
}

function sourceAccountGenerationHash(account = {}) {
  const summary = plainObject(account?.summary) ? account.summary : account;
  const preparedHash = String(summary?.generation_hash || '').trim().toLowerCase();
  if (/^[a-f0-9]{64}$/.test(preparedHash)) return preparedHash;
  const files = (Array.isArray(summary?.generation_files) ? summary.generation_files : [])
    .map(file => ({
      relative: normalizeMirrorRelative(file?.relative || ''),
      kind: String(file?.kind || '').trim().toLowerCase(),
      bytes: Math.max(0, Number(file?.bytes || 0) || 0),
      mtime_ms: Math.max(0, Number(file?.mtime_ms || 0) || 0),
      ctime_ms: Math.max(0, Number(file?.ctime_ms || 0) || 0),
      birthtime_ms: Math.max(0, Number(file?.birthtime_ms || 0) || 0),
      dev: String(file?.dev ?? '').trim(),
      ino: String(file?.ino ?? '').trim(),
    }))
    .filter(file => file.relative && ['db', 'wal', 'journal'].includes(file.kind))
    .filter(file => file.relative.split('/')[0] === 'contact')
    .sort((left, right) => left.relative.localeCompare(right.relative) || left.kind.localeCompare(right.kind));
  if (!files.length) return '';
  return crypto.createHash('sha256').update(JSON.stringify({ files })).digest('hex');
}

async function readSourceAccountGenerationHash(source = {}, { signal = null } = {}) {
  throwIfDiscoveryAborted(signal);
  const dbStorage = String(source?.db_storage || '').trim();
  if (!dbStorage) return '';
  const summary = await sourceAccountDirectorySummary(dbStorage, { signal });
  return sourceAccountGenerationHash({ summary });
}

function mirrorIdentitySourceGenerationCurrent(existing = {}, sourceGenerationHash = '') {
  const verified = String(existing?.identity_source_generation_hash || '').trim().toLowerCase();
  const current = String(sourceGenerationHash || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(verified)
    && /^[a-f0-9]{64}$/.test(current)
    && verified === current;
}

function mirrorIndexMirrorLastWriteTime(item = {}, summary = {}, dbStat = null) {
  const fullScope = item?.source_scopes && typeof item.source_scopes === 'object' && !Array.isArray(item.source_scopes)
    ? item.source_scopes.full
    : null;
  const candidates = [
    item?.source_snapshot?.last_write_time,
    fullScope?.source_snapshot?.last_write_time,
    summary?.last_write_time,
    dbStat?.mtime?.toISOString?.(),
  ];
  return candidates
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .sort((a, b) => safeDiscoveryTimeMs(b) - safeDiscoveryTimeMs(a))[0] || '';
}

function sameRealPath(a = '', b = '') {
  const rawLeft = String(a || '').trim();
  const rawRight = String(b || '').trim();
  if (!rawLeft || !rawRight) return false;
  const left = path.resolve(rawLeft);
  const right = path.resolve(rawRight);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function importWxDbMirrorUnlocked({ source, sourceSnapshot = null, existingMirrorIndex = null, mirrorSegment = '', sourceAccess = 'copy_only_auto', signal = null, onProgress = null, reason = 'auto', refreshReason = 'first_copy', scope = mirrorScopeForReason('auto'), stableCopyAttempts = WXDB_MIRROR_STABLE_COPY_ATTEMPTS } = {}) {
  throwIfDiscoveryAborted(signal);
  const accountId = String(source.account_id || accountOpaqueId(source.db_storage)).trim();
  const resolvedMirrorSegment = safeMirrorSegment(mirrorSegment || accountId);
  const targetRoot = path.join(WXDB_MIRROR_ROOT, resolvedMirrorSegment);
  const targetDbStorage = path.join(targetRoot, 'db_storage');
  await assertSafeMirrorTargetRoot(targetRoot);
  const progress = data => {
    if (typeof onProgress !== 'function') return;
    try { onProgress(data); } catch {}
  };
  let lastError = null;
  const copyAttempts = normalizeMirrorCopyAttempts(stableCopyAttempts);
  for (let attempt = 0; attempt < copyAttempts; attempt += 1) {
    throwIfDiscoveryAborted(signal);
    const snapshot = attempt === 0 && sourceSnapshot
      ? sourceSnapshot
      : await collectMirrorSourceSnapshot(source, { signal, categories: scope.categories, scope, onProgress });
    assertMirrorSourceSnapshotSupportsScope(snapshot, scope);
    const stagingRoot = path.join(WXDB_MIRROR_ROOT, `${resolvedMirrorSegment}.staging-${process.pid}-${Date.now()}-${attempt}`);
    const stagingDbStorage = path.join(stagingRoot, 'db_storage');
    let copied = [];
    let bytes = 0;
    let stableContentHashes = new Map();
    let finalSnapshot = snapshot;
    try {
      await assertSafeMirrorTargetRoot(stagingRoot);
      await ensureSafeMirrorDir(stagingDbStorage);
      const sourceDbStorageReal = await fsp.realpath(source.db_storage).catch(() => '');
      const refreshReasonLabel = mirrorRefreshReasonLabel(refreshReason);
      progress({
        phase: 'mirror_copy_start',
        label: '检查本地数据 · 开始准备',
        detail: `${refreshReasonLabel}；${snapshot.db_count} 个数据库文件，先准备临时工作数据，稳定后${mirrorRefreshAction(refreshReason) === 'create' ? '创建' : '更新'}本地工作数据`,
        reason,
        refresh_reason: refreshReason,
      });
      let reusedContentHashes = new Map();
      ({ copied, bytes, reused_content_hashes: reusedContentHashes, captured_snapshot: finalSnapshot } = await copyMirrorDbFileSet({
        snapshot,
        sourceDbStorageReal,
        targetDbStorage: stagingDbStorage,
        signal,
        progress,
        phase: 'mirror_copy_db',
        label: '检查本地数据 · 复制数据库文件',
      }));
      progress({
        phase: 'mirror_copy_verify',
        label: '检查本地数据 · 校验临时工作数据',
        detail: '每个数据库及其 WAL/回滚日志已在各自复制前后通过一致性校验；现在只校验项目临时副本的文件集合、大小和时间戳',
        refresh_reason: refreshReason,
      });
      const stagingMatchesSnapshot = await mirrorTargetMatchesSourceSnapshot(stagingDbStorage, finalSnapshot, { signal });
      if (!stagingMatchesSnapshot) {
        throw Object.assign(new Error('本地工作数据临时校验失败，已保留旧数据且未覆盖。请稍后重试。'), {
          status: 409,
          code: 'wxdb_mirror_staging_incomplete',
          public_code: 'wxdb_mirror_staging_incomplete',
        });
      }
      stableContentHashes = await hashVerifiedMirrorStagingCopy(stagingDbStorage, finalSnapshot, {
        signal,
        progress,
        knownHashes: reusedContentHashes,
        phase: 'mirror_copy_hash',
        label: '检查本地数据 · 校验项目副本内容',
      });
      const published = await mirrorPublishedManifestForTarget(stagingDbStorage, {
        signal,
        progress,
        knownHashes: stableContentHashes,
      });
      await confirmMirrorSourceSnapshotStillStable(source, finalSnapshot, {
        signal,
        scope,
        onProgress: progress,
        phase: 'mirror_copy_source_verify_before_publish',
        label: '检查本地数据 · 发布前确认源文件未变化',
      });
      throwIfDiscoveryAborted(signal);
      progress({
        phase: 'mirror_copy_publish_ready',
        label: '检查本地数据 · 准备发布',
        detail: '稳定捕获已完成；微信后续新写入不会使当前项目副本失效，下次读取会自动检查并增量更新',
        refresh_reason: refreshReason,
      });
      const replacement = await replaceMirrorRootFromStaging(stagingRoot, targetRoot);
      const publishedAccount = {
        published_manifest: published.manifest,
        published_manifest_hash: published.hash,
      };
      let summary;
      let targetSnapshotPayload;
      let refreshedAt;
      let identityAnchorCurrent = false;
      let indexCommitted = false;
      let retainedAccountForVerification = null;
      let retainedRootForVerification = '';
      try {
        if (!await previousMirrorRootMatchesIndexedContent(targetRoot, publishedAccount, { signal })) {
          throw Object.assign(new Error('发布后的本地工作数据未通过完整清单复核；旧副本已保留，未提交新索引。'), {
            status: 409,
            code: 'wxdb_mirror_publish_manifest_raced',
            public_code: 'wxdb_mirror_publish_manifest_raced',
          });
        }
        summary = await summarizeDbStorage(targetDbStorage);
        targetSnapshotPayload = await mirrorSnapshotIndexPayloadForTarget(finalSnapshot, targetDbStorage, { signal, knownHashes: stableContentHashes });
        refreshedAt = await runWithWxDbMirrorIndexWriteLock(async () => {
          const indexJson = await readMirrorIndex();
          indexJson.accounts = plainObject(indexJson.accounts) ? indexJson.accounts : {};
          const previous = indexJson.accounts[accountId] || {};
          const refreshed_at = new Date().toISOString();
          const refreshAction = mirrorRefreshAction(refreshReason);
          let reboundPrevious = null;
          const backupMatchesPrevious = replacement.backupRoot
            ? await previousMirrorRootMatchesIndexedContent(replacement.backupRoot, previous, {
                signal,
                onRebound: next => { reboundPrevious = next; },
              }).catch(error => {
                if (signal?.aborted || error?.name === 'AbortError') throw error;
                return false;
              })
            : false;
          const retained = backupMatchesPrevious
            ? retainedMirrorGenerationForBackup(replacement.backupRoot, reboundPrevious || previous)
            : null;
          retainedAccountForVerification = retained?.account_index || null;
          retainedRootForVerification = retained?.root_name ? path.join(WXDB_MIRROR_ROOT, retained.root_name) : '';
          identityAnchorCurrent = mirrorRefreshIdentityAnchorCurrent(previous, source, scope, finalSnapshot, targetSnapshotPayload);
          const nextAccount = {
            ...previous,
            ...mirrorIdentityFieldsForRefresh(previous, scope, finalSnapshot, targetSnapshotPayload, {
              identityAnchorCurrent,
              sourceGenerationHash: source.source_generation_hash,
            }),
            account_id: accountId,
            mirror_segment: resolvedMirrorSegment,
            legacy_id: source.legacy_id || source.id || '',
            wxid: source.wxid || '',
            display_name: source.display_name || source.name || '',
            account_aliases: source.account_aliases || [source.id, source.wxid].filter(Boolean),
            source_platform: process.platform,
            source_access: sourceAccess,
            mirror_scope: scope.key || 'full',
            refresh_reason: refreshReason,
            refresh_reason_label: mirrorRefreshReasonLabel(refreshReason),
            refresh_action: refreshAction,
            source_account_root: source.account_root || '',
            source_db_storage: source.db_storage || '',
            source_db_storage_realpath: source.db_storage_realpath || '',
            source_generation_hash: String(source.source_generation_hash || '').trim().toLowerCase(),
            source_snapshot_meta_hash: scope.key === 'full' ? finalSnapshot.hash : '',
            source_snapshot: scope.key === 'full' ? targetSnapshotPayload : null,
            source_scopes: mirrorSourceScopesForWrite(previous, scope, finalSnapshot, refreshed_at, refreshReason, refreshAction, targetSnapshotPayload),
            published_manifest: published.manifest,
            published_manifest_hash: published.hash,
            imported_at: previous.imported_at || refreshed_at,
            refreshed_at,
            db_count: Number(summary.db_count || copied.length || 0) || 0,
            bytes: Number(summary.bytes || bytes || 0) || 0,
            summary,
          };
          if (retained) nextAccount.retained_previous_generation = retained;
          else delete nextAccount.retained_previous_generation;
          indexJson.accounts[accountId] = nextAccount;
          await ensureDir(WXDB_MIRROR_ROOT);
          await writeJsonAtomic(WXDB_MIRROR_INDEX, indexJson);
          indexCommitted = true;
          return refreshed_at;
        });
        const committedIndex = await readMirrorIndex();
        const indexStillMatches = publishedMirrorIndexRecordMatches(
          committedIndex.accounts?.[accountId],
          publishedAccount,
          retainedAccountForVerification,
          retainedRootForVerification,
        );
        const targetStillMatches = await previousMirrorRootMatchesIndexedContent(targetRoot, publishedAccount, { signal });
        const retainedStillMatches = retainedAccountForVerification
          ? await previousMirrorRootMatchesIndexedContent(retainedRootForVerification, retainedAccountForVerification, { signal })
          : true;
        if (!indexStillMatches || !targetStillMatches || !retainedStillMatches) {
          throw Object.assign(new Error('本地工作数据或索引在提交后发生变化；已保留当前目录和上一代副本，下一次读取会自动回退或重建。'), {
            status: 409,
            code: 'wxdb_mirror_post_commit_verification_failed',
            public_code: 'wxdb_mirror_post_commit_verification_failed',
          });
        }
      } catch (e) {
        if (indexCommitted) await replacement.commit().catch(() => {});
        else await rollbackMirrorRootReplacement(replacement, e);
        throw e;
      }
      const replacementCleanup = await replacement.commit();
      let postPublishCleanup = { ok: true, recovery_errors: [] };
      try {
        postPublishCleanup = await cleanupStaleWxDbMirrorWorkDirs({
          mirror_segment: resolvedMirrorSegment,
          source_available: false,
          source_backed_publish_succeeded: true,
          onProgress,
          signal,
        });
      } catch (error) {
        postPublishCleanup = {
          ok: false,
          recovery_errors: [{
            code: String(error?.code || 'wxdb_mirror_previous_cleanup_failed').slice(0, 80),
            message: String(error?.message || error || '').slice(0, 240),
          }],
        };
      }
      const previousCleanupPending = replacementCleanup.previous_cleanup_pending
        || postPublishCleanup.ok !== true
        || (Array.isArray(postPublishCleanup.recovery_errors) && postPublishCleanup.recovery_errors.length > 0);
      const previousCleanupErrorCode = replacementCleanup.previous_cleanup_error_code
        || postPublishCleanup.recovery_errors?.[0]?.code
        || '';
      const targetIdentityState = await mirrorPublishedManifestTargetIdentityState(targetRoot, publishedAccount, { signal });
      if (targetIdentityState !== 'current') {
        throw Object.assign(new Error('清理旧工作数据后，当前发布文件的身份发生了非预期变化；已停止继续读取。'), {
          status: 409,
          code: 'wxdb_mirror_post_cleanup_identity_changed',
          public_code: 'wxdb_mirror_post_cleanup_identity_changed',
        });
      }
      progress({
        phase: 'mirror_copy_done',
        label: '检查本地数据 · 已更新',
        detail: `${mirrorRefreshReasonLabel(refreshReason)}；已准备 ${copied.length} 个数据库文件${previousCleanupPending ? '；旧副本临时目录将在下次读取时继续自动清理' : ''}`,
        refresh_reason: refreshReason,
      });
      return {
        ok: true,
        account_id: accountId,
        mirror_relative_root: `${WXDB_MIRROR_ROOT_RELATIVE}/${resolvedMirrorSegment}`,
        mirror_db_relative_root: `${WXDB_MIRROR_ROOT_RELATIVE}/${resolvedMirrorSegment}/db_storage`,
        source_access: sourceAccess,
        db_count: copied.length,
        refreshed_db_count: Number(finalSnapshot.db_count || copied.length || 0) || 0,
        bytes,
        categories: summary.categories || [],
        refreshed_categories: summary.categories || [],
        refreshed_at: refreshedAt,
        source_snapshot_meta_hash: finalSnapshot.hash,
        refresh_reason: refreshReason,
        refresh_reason_label: mirrorRefreshReasonLabel(refreshReason),
        refresh_action: mirrorRefreshAction(refreshReason),
        identity_anchor_current: identityAnchorCurrent,
        previous_cleanup_pending: previousCleanupPending,
        previous_cleanup_error_code: previousCleanupErrorCode,
      };
    } catch (e) {
      await removeSafeMirrorRoot(stagingRoot).catch(() => {});
      if (isDiskSpaceError(e)) throw mirrorDiskSpaceError(e);
      lastError = e;
      if (isTransientMirrorCopyError(e)) {
        if (attempt < copyAttempts - 1) {
          await sleepForMirrorCopyRetry(attempt, { signal, onProgress, phase: 'mirror_copy_retry_wait', attempts: copyAttempts });
          continue;
        }
        throw mirrorCopyRetryExhaustedError(e, copyAttempts);
      }
      throw e;
    }
  }
  throw lastError || Object.assign(new Error('微信本地工作数据准备失败。'), { status: 409, code: 'wxdb_mirror_copy_failed', public_code: 'wxdb_mirror_copy_failed' });
}

async function refreshWxDbMirrorScopeUnlocked({ source, sourceSnapshot = null, existingMirrorIndex = null, mirrorSegment = '', sourceAccess = 'copy_only_auto', signal = null, onProgress = null, reason = 'auto', refreshReason = 'source_snapshot_changed', scope = mirrorScopeForReason('auto'), stableCopyAttempts = WXDB_MIRROR_STABLE_COPY_ATTEMPTS } = {}) {
  throwIfDiscoveryAborted(signal);
  const accountId = String(source.account_id || accountOpaqueId(source.db_storage)).trim();
  const resolvedMirrorSegment = safeMirrorSegment(mirrorSegment || accountId);
  const targetRoot = path.join(WXDB_MIRROR_ROOT, resolvedMirrorSegment);
  const targetDbStorage = path.join(targetRoot, 'db_storage');
  await assertSafeMirrorTargetRoot(targetRoot);
  await ensureSafeMirrorDir(targetDbStorage);
  const progress = data => {
    if (typeof onProgress !== 'function') return;
    try { onProgress(data); } catch {}
  };
  let lastError = null;
  const stagingRoot = path.join(WXDB_MIRROR_ROOT, `${resolvedMirrorSegment}.${scope.key || 'scope'}-staging-${process.pid}-${Date.now()}`);
  const stagingDbStorage = path.join(stagingRoot, 'db_storage');
  let retryStagingPayload = null;
  const copyAttempts = normalizeMirrorCopyAttempts(stableCopyAttempts);
  for (let attempt = 0; attempt < copyAttempts; attempt += 1) {
    throwIfDiscoveryAborted(signal);
    const snapshot = attempt === 0 && sourceSnapshot
      ? sourceSnapshot
      : await collectMirrorSourceSnapshot(source, { signal, categories: scope.categories, scope, onProgress });
    assertMirrorSourceSnapshotSupportsScope(snapshot, scope);
    let copied = [];
    let bytes = 0;
    let reusedDbCount = 0;
    let reusedFileCount = 0;
    let reusedCachedHashCount = 0;
    let sourceCopiedFileCount = 0;
    let reusedBytes = 0;
    let sourceCopiedBytes = 0;
    let stableContentHashes = new Map();
    let finalSnapshot = snapshot;
    let stagingContainsPreservedCategories = false;
    try {
      await assertSafeMirrorTargetRoot(stagingRoot);
      await ensureSafeMirrorDir(stagingDbStorage);
      const sourceDbStorageReal = await fsp.realpath(source.db_storage).catch(() => '');
      const refreshReasonLabel = mirrorRefreshReasonLabel(refreshReason);
      progress({
        phase: 'mirror_scope_copy_start',
        label: `检查本地数据 · 更新${scope.label || '所需'}范围`,
        detail: `${refreshReasonLabel}；${snapshot.db_count} 个数据库文件，只更新本次读取需要的本地工作数据`,
        reason,
        refresh_reason: refreshReason,
      });
      const plannedRefreshedCategories = mirrorScopeCategoriesToReplace(snapshot, scope);
      const preservedCategoryBytes = await existingMirrorCategoriesRequiredBytes(
        targetDbStorage,
        plannedRefreshedCategories,
        { signal },
      );
      let reusedContentHashes = new Map();
      const reusePublishedOrStagingPayload = retryStagingPayload
        || mirrorReusablePayloadFromSourceScopes(existingMirrorIndex || {}, snapshot);
      const reusePublishedOrStagingRoot = retryStagingPayload ? stagingDbStorage : targetDbStorage;
      ({ copied, bytes, reused_db_count: reusedDbCount, reused_file_count: reusedFileCount, reused_cached_hash_count: reusedCachedHashCount, source_copied_file_count: sourceCopiedFileCount, reused_bytes: reusedBytes, source_copied_bytes: sourceCopiedBytes, reused_content_hashes: reusedContentHashes, captured_snapshot: finalSnapshot } = await copyMirrorDbFileSet({
        snapshot,
        sourceDbStorageReal,
        targetDbStorage: stagingDbStorage,
        existingTargetDbStorage: reusePublishedOrStagingRoot,
        reuseSnapshotPayload: reusePublishedOrStagingPayload,
        allowProjectReuse: !!retryStagingPayload || mirrorPayloadHasVerifiedFiles(reusePublishedOrStagingPayload),
        additionalRequiredBytes: preservedCategoryBytes,
        signal,
        progress,
        phase: 'mirror_scope_copy_db',
        label: '检查本地数据 · 复制所需数据库文件',
      }));
      const categories = mirrorScopeCategoriesToReplace(finalSnapshot, scope);
      progress({
        phase: 'mirror_scope_copy_verify',
        label: '检查本地数据 · 校验所需范围',
        detail: '每个数据库及其 WAL/回滚日志已在各自复制前后通过一致性校验；现在只校验本次所需项目副本的文件集合、大小和时间戳',
        refresh_reason: refreshReason,
      });
      const stagingMatchesSnapshot = await mirrorTargetMatchesSourceSnapshot(stagingDbStorage, finalSnapshot, {
        signal,
        allowExtra: scope.allowExtraTargetFiles,
        extraScopeCategories: categories,
      });
      if (!stagingMatchesSnapshot) {
        throw Object.assign(new Error('本地工作数据临时校验失败，已保留旧数据且未覆盖。请稍后重试。'), {
          status: 409,
          code: 'wxdb_mirror_staging_incomplete',
          public_code: 'wxdb_mirror_staging_incomplete',
        });
      }
      stableContentHashes = await hashVerifiedMirrorStagingCopy(stagingDbStorage, finalSnapshot, {
        signal,
        progress,
        knownHashes: reusedContentHashes,
        phase: 'mirror_scope_copy_hash',
        label: '检查本地数据 · 校验所需项目副本',
      });
      retryStagingPayload = await mirrorSnapshotIndexPayloadForTarget(finalSnapshot, stagingDbStorage, {
        signal,
        knownHashes: stableContentHashes,
      });
      const refreshedScope = { ...scope, categories };
      if (scope.overlayExistingMirror) {
        const preservedContentHashes = await copyExistingMirrorCategoriesToStaging(
          targetDbStorage,
          stagingDbStorage,
          categories,
          { signal, publishedAccount: existingMirrorIndex },
        );
        for (const [relative, sha256] of preservedContentHashes) {
          stableContentHashes.set(relative, sha256);
          const targetIdentity = preservedContentHashes.target_identities?.get(relative);
          if (targetIdentity && stableContentHashes.target_identities instanceof Map) {
            stableContentHashes.target_identities.set(relative, targetIdentity);
          }
        }
        stagingContainsPreservedCategories = true;
      }
      const published = await mirrorPublishedManifestForTarget(stagingDbStorage, {
        signal,
        progress,
        knownHashes: stableContentHashes,
      });
      await confirmMirrorSourceSnapshotStillStable(source, finalSnapshot, {
        signal,
        scope: refreshedScope,
        onProgress: progress,
        phase: 'mirror_scope_source_verify_before_publish',
        label: '检查本地数据 · 发布前确认源文件未变化',
      });
      throwIfDiscoveryAborted(signal);
      progress({
        phase: 'mirror_scope_publish_ready',
        label: '检查本地数据 · 准备发布',
        detail: '稳定捕获已完成；微信后续新写入不会使当前项目副本失效，下次读取会自动检查并增量更新',
        refresh_reason: refreshReason,
      });
      const replacement = await replaceMirrorRootFromStaging(stagingRoot, targetRoot);
      const publishedAccount = {
        published_manifest: published.manifest,
        published_manifest_hash: published.hash,
      };
      let summary;
      let targetSnapshotPayload;
      let refreshedAt;
      let identityAnchorCurrent = false;
      let indexCommitted = false;
      let retainedAccountForVerification = null;
      let retainedRootForVerification = '';
      try {
        if (!await previousMirrorRootMatchesIndexedContent(targetRoot, publishedAccount, { signal })) {
          throw Object.assign(new Error('发布后的本地工作数据未通过完整清单复核；旧副本已保留，未提交新索引。'), {
            status: 409,
            code: 'wxdb_mirror_publish_manifest_raced',
            public_code: 'wxdb_mirror_publish_manifest_raced',
          });
        }
        summary = await summarizeDbStorage(targetDbStorage);
        targetSnapshotPayload = await mirrorSnapshotIndexPayloadForTarget(finalSnapshot, targetDbStorage, {
          signal,
          knownHashes: stableContentHashes,
        });
        refreshedAt = await runWithWxDbMirrorIndexWriteLock(async () => {
          const indexJson = await readMirrorIndex();
          indexJson.accounts = plainObject(indexJson.accounts) ? indexJson.accounts : {};
          const previous = indexJson.accounts[accountId] || {};
          const refreshed_at = new Date().toISOString();
          const refreshAction = mirrorRefreshAction(refreshReason);
          let reboundPrevious = null;
          const backupMatchesPrevious = replacement.backupRoot
            ? await previousMirrorRootMatchesIndexedContent(replacement.backupRoot, previous, {
                signal,
                onRebound: next => { reboundPrevious = next; },
              }).catch(error => {
                if (signal?.aborted || error?.name === 'AbortError') throw error;
                return false;
              })
            : false;
          const retained = backupMatchesPrevious
            ? retainedMirrorGenerationForBackup(replacement.backupRoot, reboundPrevious || previous)
            : null;
          retainedAccountForVerification = retained?.account_index || null;
          retainedRootForVerification = retained?.root_name ? path.join(WXDB_MIRROR_ROOT, retained.root_name) : '';
          identityAnchorCurrent = mirrorRefreshIdentityAnchorCurrent(previous, source, refreshedScope, finalSnapshot, targetSnapshotPayload);
          const nextAccount = {
            ...previous,
            ...mirrorIdentityFieldsForRefresh(previous, refreshedScope, finalSnapshot, targetSnapshotPayload, {
              identityAnchorCurrent,
              sourceGenerationHash: source.source_generation_hash,
            }),
            account_id: accountId,
            mirror_segment: resolvedMirrorSegment,
            legacy_id: source.legacy_id || source.id || previous.legacy_id || '',
            wxid: source.wxid || previous.wxid || '',
            display_name: source.display_name || source.name || previous.display_name || '',
            account_aliases: [...new Set([
              ...(Array.isArray(previous.account_aliases) ? previous.account_aliases : []),
              ...(Array.isArray(source.account_aliases) ? source.account_aliases : []),
              source.id,
              source.wxid,
            ].filter(Boolean))],
            source_platform: process.platform,
            source_access: sourceAccess,
            mirror_scope: scope.key || 'full',
            refresh_reason: refreshReason,
            refresh_reason_label: mirrorRefreshReasonLabel(refreshReason),
            refresh_action: refreshAction,
            source_account_root: source.account_root || previous.source_account_root || '',
            source_db_storage: source.db_storage || previous.source_db_storage || '',
            source_db_storage_realpath: source.db_storage_realpath || previous.source_db_storage_realpath || '',
            source_generation_hash: String(source.source_generation_hash || previous.source_generation_hash || '').trim().toLowerCase(),
            source_snapshot_meta_hash: refreshedScope.key === 'full' ? finalSnapshot.hash : '',
            source_snapshot: refreshedScope.key === 'full' ? targetSnapshotPayload : null,
            source_scopes: mirrorSourceScopesForWrite(previous, refreshedScope, finalSnapshot, refreshed_at, refreshReason, refreshAction, targetSnapshotPayload),
            published_manifest: published.manifest,
            published_manifest_hash: published.hash,
            imported_at: previous.imported_at || refreshed_at,
            refreshed_at,
            db_count: Number(summary.db_count || previous.db_count || copied.length || 0) || 0,
            bytes: Number(summary.bytes || previous.bytes || bytes || 0) || 0,
            summary,
          };
          if (retained) nextAccount.retained_previous_generation = retained;
          else delete nextAccount.retained_previous_generation;
          indexJson.accounts[accountId] = nextAccount;
          await ensureDir(WXDB_MIRROR_ROOT);
          await writeJsonAtomic(WXDB_MIRROR_INDEX, indexJson);
          indexCommitted = true;
          return refreshed_at;
        });
        const committedIndex = await readMirrorIndex();
        const indexStillMatches = publishedMirrorIndexRecordMatches(
          committedIndex.accounts?.[accountId],
          publishedAccount,
          retainedAccountForVerification,
          retainedRootForVerification,
        );
        const targetStillMatches = await previousMirrorRootMatchesIndexedContent(targetRoot, publishedAccount, { signal });
        const retainedStillMatches = retainedAccountForVerification
          ? await previousMirrorRootMatchesIndexedContent(retainedRootForVerification, retainedAccountForVerification, { signal })
          : true;
        if (!indexStillMatches || !targetStillMatches || !retainedStillMatches) {
          throw Object.assign(new Error('本地工作数据或索引在提交后发生变化；已保留当前目录和上一代副本，下一次读取会自动回退或重建。'), {
            status: 409,
            code: 'wxdb_mirror_post_commit_verification_failed',
            public_code: 'wxdb_mirror_post_commit_verification_failed',
          });
        }
      } catch (e) {
        if (indexCommitted) await replacement.commit().catch(() => {});
        else await rollbackMirrorRootReplacement(replacement, e);
        throw e;
      }
      const replacementCleanup = await replacement.commit();
      let postPublishCleanup = { ok: true, recovery_errors: [] };
      try {
        postPublishCleanup = await cleanupStaleWxDbMirrorWorkDirs({
          mirror_segment: resolvedMirrorSegment,
          source_available: false,
          source_backed_publish_succeeded: true,
          onProgress,
          signal,
        });
      } catch (error) {
        postPublishCleanup = {
          ok: false,
          recovery_errors: [{
            code: String(error?.code || 'wxdb_mirror_previous_cleanup_failed').slice(0, 80),
            message: String(error?.message || error || '').slice(0, 240),
          }],
        };
      }
      const previousCleanupPending = replacementCleanup.previous_cleanup_pending
        || postPublishCleanup.ok !== true
        || (Array.isArray(postPublishCleanup.recovery_errors) && postPublishCleanup.recovery_errors.length > 0);
      const previousCleanupErrorCode = replacementCleanup.previous_cleanup_error_code
        || postPublishCleanup.recovery_errors?.[0]?.code
        || '';
      const targetIdentityState = await mirrorPublishedManifestTargetIdentityState(targetRoot, publishedAccount, { signal });
      if (targetIdentityState !== 'current') {
        const projectReuseMayChangeTargetCtime = scope.overlayExistingMirror || reusedFileCount > 0;
        if (targetIdentityState !== 'ctime_only_changed' || !projectReuseMayChangeTargetCtime) {
          throw Object.assign(new Error('清理旧工作数据后，当前发布文件的身份发生了非预期变化；已停止继续读取。'), {
            status: 409,
            code: 'wxdb_mirror_post_cleanup_identity_changed',
            public_code: 'wxdb_mirror_post_cleanup_identity_changed',
          });
        }
        const finalizedPublished = await rebindPublishedMirrorTargetMetadataAfterCleanup({
          accountId,
          targetDbStorage,
          signal,
          progress,
          publishedAccount,
        });
        const finalizedIndex = await readMirrorIndex();
        const finalizedAccount = finalizedIndex.accounts?.[accountId];
        if (String(finalizedAccount?.published_manifest_hash || '').trim().toLowerCase() !== finalizedPublished.hash
          || await mirrorPublishedManifestTargetIdentityState(targetRoot, finalizedAccount, { signal }) !== 'current') {
          throw Object.assign(new Error('清理旧工作数据后的最终发布清单未能稳定提交；已停止继续读取。'), {
            status: 409,
            code: 'wxdb_mirror_post_cleanup_finalize_failed',
            public_code: 'wxdb_mirror_post_cleanup_finalize_failed',
          });
        }
      }
      progress({
        phase: 'mirror_scope_copy_done',
        label: `检查本地数据 · ${scope.label || '所需范围'}已更新`,
        detail: `${mirrorRefreshReasonLabel(refreshReason)}；已更新 ${categories.join('、')} 所需数据${reusedFileCount ? `，复用项目副本 ${reusedFileCount} 个文件（${formatMirrorBytes(reusedBytes)}，其中 ${reusedCachedHashCount} 个沿用已发布完整校验）、从源库复制 ${sourceCopiedFileCount} 个变化文件（${formatMirrorBytes(sourceCopiedBytes)}）` : ''}${previousCleanupPending ? '；旧副本临时目录将在下次读取时继续自动清理' : ''}`,
        refresh_reason: refreshReason,
      });
      return {
        ok: true,
        account_id: accountId,
        mirror_relative_root: `${WXDB_MIRROR_ROOT_RELATIVE}/${resolvedMirrorSegment}`,
        mirror_db_relative_root: `${WXDB_MIRROR_ROOT_RELATIVE}/${resolvedMirrorSegment}/db_storage`,
        source_access: sourceAccess,
        db_count: Number(summary.db_count || copied.length || 0) || 0,
        refreshed_db_count: Number(finalSnapshot.db_count || copied.length || 0) || 0,
        reused_db_count: reusedDbCount,
        reused_file_count: reusedFileCount,
        reused_cached_hash_count: reusedCachedHashCount,
        source_copied_file_count: sourceCopiedFileCount,
        reused_bytes: reusedBytes,
        source_copied_bytes: sourceCopiedBytes,
        bytes: Number(summary.bytes || bytes || 0) || 0,
        categories: summary.categories || [],
        refreshed_categories: Array.isArray(categories) ? [...categories] : [],
        refreshed_at: refreshedAt,
        source_snapshot_meta_hash: finalSnapshot.hash,
        refresh_reason: refreshReason,
        refresh_reason_label: mirrorRefreshReasonLabel(refreshReason),
        refresh_action: mirrorRefreshAction(refreshReason),
        mirror_scope: scope.key || 'full',
        identity_anchor_current: identityAnchorCurrent,
        previous_cleanup_pending: previousCleanupPending,
        previous_cleanup_error_code: previousCleanupErrorCode,
      };
    } catch (e) {
      if (String(e?.code || '') === 'wxdb_source_changed_during_mirror_copy' && retryStagingPayload) {
        e.source_busy_identity_anchor_current = mirrorSourceBusyIdentityAnchorCurrent(
          existingMirrorIndex || {},
          source,
          scope,
          finalSnapshot,
          retryStagingPayload,
          e,
        );
      }
      const reuseStableStagingOnRetry = String(e?.code || '') === 'wxdb_source_changed_during_mirror_copy'
        && !!retryStagingPayload
        && !stagingContainsPreservedCategories
        && attempt < copyAttempts - 1;
      if (!reuseStableStagingOnRetry) {
        retryStagingPayload = null;
        const stagingRemoved = await removeSafeMirrorRoot(stagingRoot).then(() => true).catch(() => false);
        const projectReuseMayChangeTargetCtime = reusedFileCount > 0 || stagingContainsPreservedCategories;
        if (stagingRemoved && projectReuseMayChangeTargetCtime) {
          const targetIdentityState = await mirrorPublishedManifestTargetIdentityState(targetRoot, existingMirrorIndex, { signal });
          if (targetIdentityState === 'ctime_only_changed') {
            await rebindPublishedMirrorTargetMetadataAfterCleanup({
              accountId,
              targetDbStorage,
              signal,
              progress,
              publishedAccount: existingMirrorIndex,
              context: 'discarded_staging',
            });
            const reboundIndex = await readMirrorIndex();
            const reboundAccount = reboundIndex.accounts?.[accountId];
            if (!plainObject(reboundAccount)
              || await mirrorPublishedManifestTargetIdentityState(targetRoot, reboundAccount, { signal }) !== 'current') {
              throw Object.assign(new Error('撤销临时副本后，当前项目副本的文件身份未能稳定重绑。'), {
                status: 409,
                code: 'wxdb_mirror_post_cleanup_finalize_failed',
                public_code: 'wxdb_mirror_post_cleanup_finalize_failed',
              });
            }
            existingMirrorIndex = reboundAccount;
          } else if (targetIdentityState !== 'current') {
            throw Object.assign(new Error('撤销临时副本后，当前项目副本发生了非预期变化；已停止继续读取。'), {
              status: 409,
              code: 'wxdb_mirror_post_cleanup_identity_changed',
              public_code: 'wxdb_mirror_post_cleanup_identity_changed',
            });
          }
        }
      }
      if (isDiskSpaceError(e)) throw mirrorDiskSpaceError(e);
      lastError = e;
      if (isTransientMirrorCopyError(e)) {
        if (attempt < copyAttempts - 1) {
          await sleepForMirrorCopyRetry(attempt, { signal, onProgress, phase: 'mirror_scope_copy_retry_wait', attempts: copyAttempts });
          continue;
        }
        throw mirrorCopyRetryExhaustedError(e, copyAttempts);
      }
      throw e;
    }
  }
  throw lastError || Object.assign(new Error('微信本地工作数据更新失败。'), { status: 409, code: 'wxdb_mirror_copy_failed', public_code: 'wxdb_mirror_copy_failed' });
}

function assertMirrorSourceSnapshotHasDatabases(snapshot = {}) {
  const count = Number(snapshot.db_count || 0) || 0;
  if (count > 0) return;
  throw Object.assign(new Error('当前微信账号源数据库目录没有可读取的数据库文件，已拒绝更新本地工作数据。请确认右上角账号正确、微信已登录并完成同步后重试。'), {
    status: 409,
    code: 'wxdb_source_no_databases',
    public_code: 'wxdb_source_no_databases',
  });
}

function mirrorSnapshotHasDatabase(snapshot = {}, category = '', name = '') {
  const wantedCategory = String(category || '').trim().toLowerCase();
  const wantedName = String(name || '').trim().toLowerCase();
  return (Array.isArray(snapshot.dbFiles) ? snapshot.dbFiles : []).some(item => {
    const itemCategory = String(item?.category || '').trim().toLowerCase();
    const itemName = String(item?.name || '').trim().toLowerCase();
    if (wantedCategory && itemCategory !== wantedCategory) return false;
    if (wantedName && itemName !== wantedName) return false;
    return true;
  });
}

function assertMirrorSourceSnapshotSupportsScope(snapshot = {}, scope = {}) {
  assertMirrorSourceSnapshotHasDatabases(snapshot);
  if (scope?.key === 'groups') {
    if (mirrorSnapshotHasDatabase(snapshot, 'contact', 'contact.db')) return;
    throw Object.assign(new Error('当前微信账号源数据库缺少群列表所需数据，已拒绝复用旧群列表。请确认右上角账号正确、微信已完成同步后重试。'), {
      status: 409,
      code: 'wxdb_mirror_scope_source_missing',
      public_code: 'wxdb_mirror_scope_source_missing',
      scope: scope.key || 'groups',
      category: 'contact',
      file: 'contact.db',
    });
  }
  if (scope?.key === 'identity') {
    if (mirrorSnapshotHasDatabase(snapshot, 'message')
      && mirrorSnapshotHasDatabase(snapshot, 'contact', 'contact.db')
      && mirrorSnapshotHasDatabase(snapshot, 'session', 'session.db')) return;
    throw Object.assign(new Error('当前微信账号源数据库缺少账号身份确认所需数据，已拒绝返回未确认账号的群列表。请确认微信已完成同步后重试。'), {
      status: 409,
      code: 'wxdb_mirror_scope_source_missing',
      public_code: 'wxdb_mirror_scope_source_missing',
      scope: 'identity',
      category: 'message/contact/session',
      file: 'message_*.db/contact.db/session.db',
    });
  }
  if (scope?.key === 'digest') {
    if (mirrorSnapshotHasDatabase(snapshot, 'message')
      && mirrorSnapshotHasDatabase(snapshot, 'contact', 'contact.db')
      && mirrorSnapshotHasDatabase(snapshot, 'session', 'session.db')) return;
    throw Object.assign(new Error('当前微信账号源数据库缺少摘要读取所需数据，已拒绝复用旧本地工作数据。请确认右上角账号正确、微信已完成同步后重试。'), {
      status: 409,
      code: 'wxdb_mirror_scope_source_missing',
      public_code: 'wxdb_mirror_scope_source_missing',
      scope: 'digest',
      category: 'message/contact/session',
      file: 'message_*.db/contact.db/session.db',
    });
  }
}

function mirrorScopeAllowsDbFile(scope = {}, dbFile = {}) {
  const key = String(scope?.key || '').trim();
  const category = String(dbFile?.category || '').trim().toLowerCase();
  const name = String(dbFile?.name || '').trim().toLowerCase();
  if (key === 'digest' || key === 'identity') {
    if (category === 'message') return /^message_\d+\.db$/i.test(name);
    if (category === 'contact') return name === 'contact.db';
    if (category === 'session') return name === 'session.db';
    if (key === 'digest' && category === 'hardlink') return name === 'hardlink.db';
    return false;
  }
  if (key === 'groups') {
    return (category === 'contact' && name === 'contact.db')
      || (category === 'session' && name === 'session.db');
  }
  return true;
}

function safeMirrorCategoryName(category = '') {
  const value = String(category || '').trim();
  if (!value || value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
    throw Object.assign(new Error('微信本地工作数据分类名无效，已拒绝更新。'), {
      status: 403,
      code: 'wxdb_mirror_invalid_category',
      public_code: 'wxdb_mirror_invalid_category',
    });
  }
  return value;
}

function mirrorScopeCategoriesToReplace(snapshot = {}, scope = {}) {
  const snapshotCategories = [...new Set((Array.isArray(snapshot.dbFiles) ? snapshot.dbFiles : [])
    .map(item => String(item?.category || '').trim())
    .filter(Boolean)
    .map(safeMirrorCategoryName))];
  const scoped = [...new Set((Array.isArray(scope.categories) ? scope.categories : [])
    .map(safeMirrorCategoryName)
    .filter(Boolean))];
  if (!scoped.length) return snapshotCategories;
  return scoped;
}

function publishedMirrorFilesForReuse(account = null) {
  const manifest = plainObject(account?.published_manifest) ? account.published_manifest : null;
  const expectedHash = String(account?.published_manifest_hash || '').trim().toLowerCase();
  if (!manifest
    || !/^[a-f0-9]{64}$/.test(expectedHash)
    || mirrorPublishedManifestHash(manifest) !== expectedHash) return new Map();
  return new Map(manifest.files.map(file => [normalizeMirrorRelative(file.relative || ''), file]));
}

function createKnownMirrorContentHashes() {
  const hashes = new Map();
  Object.defineProperty(hashes, 'target_identities', { value: new Map() });
  return hashes;
}

async function copyExistingMirrorCategoriesToStaging(targetDbStorage, stagingDbStorage, replacedCategories = [], { signal = null, publishedAccount = null } = {}) {
  throwIfDiscoveryAborted(signal);
  const targetRoot = path.resolve(targetDbStorage || '');
  const stagingRoot = path.resolve(stagingDbStorage || '');
  const knownHashes = createKnownMirrorContentHashes();
  const publishedFiles = publishedMirrorFilesForReuse(publishedAccount);
  assertMirrorStagingTarget(path.resolve(WXDB_MIRROR_ROOT), targetRoot);
  assertMirrorStagingTarget(path.resolve(WXDB_MIRROR_ROOT), stagingRoot);
  const targetStat = await fsp.lstat(targetRoot).catch(e => {
    if (e?.code === 'ENOENT') return null;
    throw e;
  });
  if (!targetStat) return knownHashes;
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw Object.assign(new Error('微信本地工作数据不是普通目录，已拒绝组装临时工作区。'), { status: 403, code: 'wxdb_mirror_target_not_directory', public_code: 'wxdb_mirror_target_not_directory' });
  }
  await assertNoMirrorSymlinkTree(targetRoot);
  const replaced = new Set((Array.isArray(replacedCategories) ? replacedCategories : []).map(safeMirrorCategoryName));
  const entries = await fsp.readdir(targetRoot, { withFileTypes: true }).catch(e => {
    if (e?.code === 'ENOENT') return [];
    throw e;
  });
  for (const entry of entries) {
    throwIfDiscoveryAborted(signal);
    if (!entry.isDirectory()) continue;
    if (/^.+\.previous-\d+-\d+-[a-f0-9]{8}$/i.test(entry.name)) continue;
    const category = safeMirrorCategoryName(entry.name);
    if (replaced.has(category)) continue;
    await copyMirrorTree(path.join(targetRoot, category), path.join(stagingRoot, category), {
      sourceRoot: targetRoot,
      targetRoot: stagingRoot,
      signal,
      publishedFiles,
      knownHashes,
    });
  }
  return knownHashes;
}

async function copyMirrorTree(sourceDir, targetDir, {
  sourceRoot = '',
  targetRoot = '',
  signal = null,
  publishedFiles = null,
  knownHashes = null,
} = {}) {
  throwIfDiscoveryAborted(signal);
  const source = path.resolve(sourceDir || '');
  const target = path.resolve(targetDir || '');
  assertMirrorStagingTarget(path.resolve(sourceRoot || ''), source);
  assertMirrorStagingTarget(path.resolve(targetRoot || ''), target);
  const sourceStat = await fsp.lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw Object.assign(new Error('微信本地工作数据分类不是普通目录，已拒绝复制到临时工作区。'), { status: 403, code: 'wxdb_mirror_reparse_point', public_code: 'wxdb_mirror_reparse_point' });
  }
  await ensureSafeMirrorDir(target);
  const entries = await fsp.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    throwIfDiscoveryAborted(signal);
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    assertMirrorStagingTarget(path.resolve(sourceRoot || ''), from);
    assertMirrorStagingTarget(path.resolve(targetRoot || ''), to);
    const st = await fsp.lstat(from);
    if (st.isSymbolicLink()) {
      throw Object.assign(new Error('微信本地工作数据目录树包含链接或重解析点，已拒绝复制到临时工作区。'), { status: 403, code: 'wxdb_mirror_reparse_point', public_code: 'wxdb_mirror_reparse_point' });
    }
    if (st.isDirectory()) {
      await copyMirrorTree(from, to, {
        sourceRoot,
        targetRoot,
        signal,
        publishedFiles,
        knownHashes,
      });
      continue;
    }
    if (!st.isFile()) {
      throw Object.assign(new Error('微信本地工作数据目录树包含非普通文件，已拒绝复制到临时工作区。'), { status: 403, code: 'wxdb_mirror_non_regular_file', public_code: 'wxdb_mirror_non_regular_file' });
    }
    await ensureSafeMirrorDir(path.dirname(to));
    const relative = normalizeMirrorRelative(path.relative(path.resolve(sourceRoot || ''), from));
    const publishedFile = publishedFiles instanceof Map ? publishedFiles.get(relative) : null;
    const publishedHash = String(publishedFile?.sha256 || '').trim().toLowerCase();
    const sourceBefore = {
      is_file: st.isFile(),
      is_symbolic_link: st.isSymbolicLink(),
      bytes: st.size,
      mtimeMs: st.mtimeMs,
      ctimeMs: st.ctimeMs,
      birthtimeMs: st.birthtimeMs,
      dev: st.dev,
      ino: st.ino,
    };
    const mayReusePublishedHash = /^[a-f0-9]{64}$/.test(publishedHash)
      && mirrorTargetSnapshotFileMatches(sourceBefore, publishedFile)
      && mirrorTargetIdentityMatches(sourceBefore, publishedFile);
    const transferred = await linkOrCopyMirrorFile(from, to, { signal });
    // Updating timestamps on a hard link would also mutate the retained mirror.
    if (!transferred.linked) await fsp.utimes(to, st.atime, st.mtime).catch(() => {});
    if (mayReusePublishedHash && transferred.linked && knownHashes instanceof Map) {
      const [sourceAfter, targetAfter] = await Promise.all([
        fsp.lstat(from),
        fsp.lstat(to),
      ]);
      const linkedIdentityStable = sourceAfter.isFile()
        && !sourceAfter.isSymbolicLink()
        && targetAfter.isFile()
        && !targetAfter.isSymbolicLink()
        && Number(sourceAfter.dev || 0) === Number(st.dev || 0)
        && Number(sourceAfter.ino || 0) === Number(st.ino || 0)
        && Number(targetAfter.dev || 0) === Number(sourceAfter.dev || 0)
        && Number(targetAfter.ino || 0) === Number(sourceAfter.ino || 0)
        && Number(sourceAfter.size || 0) === Number(st.size || 0)
        && Number(targetAfter.size || 0) === Number(sourceAfter.size || 0)
        && Math.abs(Number(sourceAfter.mtimeMs || 0) - Number(st.mtimeMs || 0)) <= 2
        && Math.abs(Number(targetAfter.mtimeMs || 0) - Number(sourceAfter.mtimeMs || 0)) <= 2;
      if (linkedIdentityStable) {
        knownHashes.set(relative, publishedHash);
        if (knownHashes.target_identities instanceof Map) {
          knownHashes.target_identities.set(relative, mirrorTargetIdentityFieldsFromStat(targetAfter));
        }
      }
    }
  }
}

async function existingMirrorCategoriesRequiredBytes(targetDbStorage, replacedCategories = [], { signal = null } = {}) {
  throwIfDiscoveryAborted(signal);
  const targetRoot = path.resolve(targetDbStorage || '');
  assertMirrorStagingTarget(path.resolve(WXDB_MIRROR_ROOT), targetRoot);
  const targetStat = await fsp.lstat(targetRoot).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!targetStat) return 0;
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw Object.assign(new Error('微信本地工作数据不是普通目录，已拒绝计算临时工作区磁盘预算。'), {
      status: 403,
      code: 'wxdb_mirror_target_not_directory',
      public_code: 'wxdb_mirror_target_not_directory',
    });
  }
  await assertNoMirrorSymlinkTree(targetRoot);
  const replaced = new Set((Array.isArray(replacedCategories) ? replacedCategories : []).map(safeMirrorCategoryName));
  const entries = await fsp.readdir(targetRoot, { withFileTypes: true });
  let bytes = 0;
  for (const entry of entries) {
    throwIfDiscoveryAborted(signal);
    if (!entry.isDirectory() || /^.+\.previous-\d+-\d+-[a-f0-9]{8}$/i.test(entry.name)) continue;
    if (replaced.has(safeMirrorCategoryName(entry.name))) continue;
    bytes += await mirrorTreeRequiredBytes(path.join(targetRoot, entry.name), { sourceRoot: targetRoot, signal });
  }
  return bytes;
}

async function mirrorTreeRequiredBytes(sourceDir, { sourceRoot = '', signal = null } = {}) {
  throwIfDiscoveryAborted(signal);
  const source = path.resolve(sourceDir || '');
  assertMirrorStagingTarget(path.resolve(sourceRoot || ''), source);
  const sourceStat = await fsp.lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw Object.assign(new Error('微信本地工作数据分类不是普通目录，已拒绝计算临时工作区磁盘预算。'), {
      status: 403,
      code: 'wxdb_mirror_reparse_point',
      public_code: 'wxdb_mirror_reparse_point',
    });
  }
  let bytes = 0;
  const entries = await fsp.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    throwIfDiscoveryAborted(signal);
    const file = path.join(source, entry.name);
    assertMirrorStagingTarget(path.resolve(sourceRoot || ''), file);
    const st = await fsp.lstat(file);
    if (st.isSymbolicLink()) {
      throw Object.assign(new Error('微信本地工作数据目录树包含链接或重解析点，已拒绝计算临时工作区磁盘预算。'), {
        status: 403,
        code: 'wxdb_mirror_reparse_point',
        public_code: 'wxdb_mirror_reparse_point',
      });
    }
    if (st.isDirectory()) {
      bytes += await mirrorTreeRequiredBytes(file, { sourceRoot, signal });
      continue;
    }
    if (!st.isFile()) {
      throw Object.assign(new Error('微信本地工作数据目录树包含非普通文件，已拒绝计算临时工作区磁盘预算。'), {
        status: 403,
        code: 'wxdb_mirror_non_regular_file',
        public_code: 'wxdb_mirror_non_regular_file',
      });
    }
    bytes += Math.max(0, Number(st.size || 0) || 0);
  }
  return bytes;
}

async function replaceMirrorRootFromStaging(stagingRoot, targetRoot) {
  await assertSafeMirrorTargetRoot(targetRoot);
  await assertSafeMirrorTargetRoot(stagingRoot);
  await assertNoMirrorSymlinkTree(stagingRoot);
  const backupRoot = `${targetRoot}.previous-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  await assertSafeMirrorTargetRoot(backupRoot);
  const targetStat = await fsp.lstat(targetRoot).catch(() => null);
  if (!targetStat) {
    await renameAtomicWithRetry(stagingRoot, targetRoot);
    return mirrorRootReplacementTransaction({ targetRoot, backupRoot: '', hadTarget: false });
  }
  await assertNoMirrorSymlinkTree(targetRoot);
  await removeSafeMirrorRoot(backupRoot).catch(() => {});
  await renameAtomicWithRetry(targetRoot, backupRoot);
  try {
    await assertNoMirrorSymlinkTree(stagingRoot);
    await renameAtomicWithRetry(stagingRoot, targetRoot);
  } catch (e) {
    try {
      const restoredStat = await fsp.lstat(targetRoot).catch(() => null);
      if (!restoredStat) await renameAtomicWithRetry(backupRoot, targetRoot);
    } catch (restoreError) {
      e.restore_error = restoreError?.message || String(restoreError);
    }
    throw e;
  }
  return mirrorRootReplacementTransaction({ targetRoot, backupRoot, hadTarget: true });
}

function mirrorRootReplacementTransaction({ targetRoot = '', backupRoot = '', hadTarget = false } = {}) {
  let settled = false;
  let commitResult = {
    previous_cleanup_pending: false,
    previous_cleanup_error_code: '',
    retained_previous_root: backupRoot,
  };
  return {
    targetRoot,
    backupRoot,
    hadTarget: !!hadTarget,
    get settled() {
      return settled;
    },
    async commit() {
      if (settled) return commitResult;
      settled = true;
      return commitResult;
    },
    async rollback() {
      if (settled) return;
      await removeSafeMirrorRoot(targetRoot);
      if (hadTarget && backupRoot) {
        await assertSafeMirrorTargetRoot(backupRoot);
        await assertNoMirrorSymlinkTree(backupRoot);
        await renameAtomicWithRetry(backupRoot, targetRoot);
      }
      settled = true;
    },
  };
}

async function rollbackMirrorRootReplacement(replacement, cause) {
  try {
    await replacement?.rollback?.();
  } catch (rollbackError) {
    throw Object.assign(new Error('本地工作数据更新失败，且旧副本回滚也失败；当前项目副本状态不确定，已停止继续读取。请重新检查本地数据或重启服务后重试。'), {
      status: 500,
      code: 'wxdb_mirror_rollback_failed',
      public_code: 'wxdb_mirror_rollback_failed',
      cause,
      mirror_rollback_error: rollbackError?.message || String(rollbackError),
      mirror_rollback_failed: true,
    });
  }
}

async function collectMirrorSourceSnapshot(source, { signal = null, categories = [], scope = {}, onProgress = null } = {}) {
  throwIfDiscoveryAborted(signal);
  const dbStorage = path.resolve(String(source?.db_storage || ''));
  const dbStorageReal = await fsp.realpath(dbStorage).catch(() => '');
  const progress = data => notifyMirrorProgress(onProgress, data);
  const wantedCategories = [...new Set((Array.isArray(categories) ? categories : [])
    .map(value => String(value || '').trim())
    .filter(Boolean))];
  const dbFiles = wantedCategories.length
    ? (await Promise.all(wantedCategories.map(category => listDbFiles(source, category, { signal, strictSnapshot: true })))).flat()
    : await listDbFiles(source, '', { signal, strictSnapshot: true });
  const allowedDbFiles = dbFiles.filter(dbFile => mirrorScopeAllowsDbFile(scope, dbFile));
  const eligibleIdentityMessages = scope?.key === 'identity'
    ? allowedDbFiles.filter(dbFile => String(dbFile?.category || '').trim().toLowerCase() === 'message')
    : [];
  const selectedIdentityMessages = scope?.key === 'identity'
    ? accountIdentityMessageShardCandidates(eligibleIdentityMessages)
    : [];
  const selectedIdentityPaths = new Set(selectedIdentityMessages
    .map(dbFile => path.resolve(String(dbFile?.path || '')))
    .filter(Boolean));
  const scopedDbFiles = scope?.key === 'identity'
    ? allowedDbFiles.filter(dbFile => String(dbFile?.category || '').trim().toLowerCase() !== 'message'
      || selectedIdentityPaths.has(path.resolve(String(dbFile?.path || ''))))
    : allowedDbFiles;
  const selectionMetadata = scope?.key === 'identity' ? {
    eligible_message_count: eligibleIdentityMessages.length,
    selected_message_count: selectedIdentityMessages.length,
    selection_limit: ACCOUNT_IDENTITY_MAX_MESSAGE_SHARDS,
    selection_strategy: ACCOUNT_IDENTITY_MESSAGE_SELECTION_STRATEGY,
  } : {};
  progress({
    phase: 'mirror_source_snapshot_start',
    label: '检查本地数据 · 读取源库文件元数据',
    detail: `检查 ${scopedDbFiles.length} 个数据库文件的大小、时间和文件身份`,
  });
  const snapshotDbFiles = [];
  const entries = [];
  let bytes = 0;
  let last = 0;
  for (let index = 0; index < scopedDbFiles.length; index += 1) {
    const dbFile = scopedDbFiles[index];
    throwIfDiscoveryAborted(signal);
    const sourcePath = path.resolve(dbFile.path);
    await assertMirrorSourceFile(dbStorageReal, sourcePath);
    const st = await statWxDbSourceFile(sourcePath, { signal });
    if (!st) {
      throw Object.assign(new Error(`源数据库文件在快照构造期间消失，已拒绝用不完整快照更新本地工作数据：${path.basename(sourcePath)}`), {
        status: 409,
        code: 'wxdb_source_snapshot_unstable',
        public_code: 'wxdb_source_snapshot_unstable',
      });
    }
    if (!st.isFile() || st.isSymbolicLink()) {
      throw Object.assign(new Error('源数据库文件清单包含非普通文件或符号链接，已拒绝更新本地工作数据。'), {
        status: 403,
        code: 'wxdb_source_not_regular_file',
        public_code: 'wxdb_source_not_regular_file',
      });
    }
    const relative = normalizeMirrorRelative(path.relative(dbStorage, sourcePath));
    const item = {
      category: dbFile.category,
      name: dbFile.name,
      path: sourcePath,
      relative,
      bytes: st.size,
      mtimeMs: st.mtimeMs,
      ...mirrorSnapshotStatIdentity(st),
      last_write_time: st.mtime.toISOString(),
      sidecars: [],
    };
    entries.push(mirrorSnapshotEntry('db', item));
    bytes += st.size;
    last = Math.max(last, st.mtimeMs);
    for (const suffix of SQLITE_PERSISTED_SIDECAR_SUFFIXES) {
      throwIfDiscoveryAborted(signal);
      const sidePath = `${sourcePath}${suffix}`;
      if (!await optionalMirrorSourceSidecarExists(dbStorageReal, sidePath, { signal })) continue;
      const sideStat = await statWxDbSourceSidecar(sidePath, { signal });
      if (!sideStat?.isFile() || sideStat.isSymbolicLink()) continue;
      const sidecar = {
        name: path.basename(sidePath),
        suffix,
        path: sidePath,
        relative: normalizeMirrorRelative(path.relative(dbStorage, sidePath)),
        bytes: sideStat.size,
        mtimeMs: sideStat.mtimeMs,
        ...mirrorSnapshotStatIdentity(sideStat),
        last_write_time: sideStat.mtime.toISOString(),
      };
      item.sidecars.push(sidecar);
      entries.push(mirrorSnapshotEntry('sidecar', sidecar));
      bytes += sideStat.size;
      last = Math.max(last, sideStat.mtimeMs);
    }
    snapshotDbFiles.push(item);
  }
  progress({
    phase: 'mirror_source_snapshot_done',
    label: '检查本地数据 · 源库文件清单完成',
    detail: `${snapshotDbFiles.length} 个数据库文件，合计 ${formatMirrorBytes(bytes)}`,
  });
  entries.sort((a, b) => a.relative.localeCompare(b.relative) || a.kind.localeCompare(b.kind));
  const hashInput = scope?.key === 'identity' ? { entries, ...selectionMetadata } : entries;
  const hash = crypto.createHash('sha256').update(JSON.stringify(hashInput)).digest('hex');
  return {
    hash,
    dbFiles: snapshotDbFiles,
    db_count: snapshotDbFiles.length,
    bytes,
    last_write_time: last ? new Date(last).toISOString() : '',
    ...selectionMetadata,
  };
}

async function collectStableMirrorSourceSnapshot(source, options = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < WXDB_MIRROR_STABLE_COPY_ATTEMPTS; attempt += 1) {
    try {
      return await collectMirrorSourceSnapshot(source, options);
    } catch (error) {
      lastError = error;
      if (!isTransientMirrorCopyError(error)) throw error;
      if (attempt >= WXDB_MIRROR_STABLE_COPY_ATTEMPTS - 1) throw mirrorCopyRetryExhaustedError(error);
      await sleepForMirrorCopyRetry(attempt, {
        signal: options.signal,
        onProgress: options.onProgress,
        phase: 'mirror_source_snapshot_retry_wait',
      });
    }
  }
  throw lastError || Object.assign(new Error('微信源数据库文件清单准备失败。'), {
    status: 409,
    code: 'wxdb_source_snapshot_unstable',
    public_code: 'wxdb_source_snapshot_unstable',
  });
}

async function confirmMirrorSourceSnapshotStillStable(source, expectedSnapshot, {
  signal = null,
  scope = {},
  onProgress = null,
  phase = 'mirror_copy_source_verify',
  label = '检查本地数据 · 确认源文件元数据未变化',
} = {}) {
  throwIfDiscoveryAborted(signal);
  notifyMirrorProgress(onProgress, {
    phase,
    label,
    detail: '复用前重新读取所需源文件元数据，确认没有新增分片或较早文件继续变化',
  });
  const currentSnapshot = await collectMirrorSourceSnapshot(source, {
    signal,
    categories: scope.categories,
    scope,
  });
  assertMirrorSourceSnapshotSupportsScope(currentSnapshot, scope);
  if (!expectedSnapshot?.hash || currentSnapshot.hash !== expectedSnapshot.hash) {
    const error = mirrorSourceChangedDuringCopyError();
    const categories = [...new Set([
      ...(Array.isArray(scope?.categories) ? scope.categories : []),
      ...(Array.isArray(expectedSnapshot?.dbFiles) ? expectedSnapshot.dbFiles.map(item => item?.category) : []),
      ...(Array.isArray(currentSnapshot?.dbFiles) ? currentSnapshot.dbFiles.map(item => item?.category) : []),
    ].map(value => String(value || '').trim().toLowerCase()).filter(Boolean))];
    error.source_snapshot_unchanged_categories = categories.filter(category => (
      mirrorSourceSnapshotCategoryMetadataMatches(expectedSnapshot, currentSnapshot, category)
    ));
    throw error;
  }
  notifyMirrorProgress(onProgress, {
    phase,
    label,
    detail: `${currentSnapshot.db_count} 个数据库文件的大小、时间戳和文件身份未变化，继续复用已校验的项目副本`,
  });
  return currentSnapshot;
}

function mirrorSourceSnapshotCategoryMetadataMatches(expectedSnapshot = {}, currentSnapshot = {}, category = '') {
  const wanted = String(category || '').trim().toLowerCase();
  if (!wanted) return false;
  const categoryManifest = snapshot => mirrorSnapshotManifest(snapshot)
    .filter(file => normalizeMirrorRelative(file?.relative || '').split('/')[0]?.toLowerCase() === wanted);
  const expected = categoryManifest(expectedSnapshot);
  const current = categoryManifest(currentSnapshot);
  return expected.length > 0
    && expected.length === current.length
    && JSON.stringify(expected) === JSON.stringify(current);
}

function mirrorSourceBusyIdentityAnchorCurrent(previous = {}, source = {}, scope = {}, expectedSnapshot = {}, targetSnapshotPayload = {}, error = null) {
  const unchangedCategories = Array.isArray(error?.source_snapshot_unchanged_categories)
    ? error.source_snapshot_unchanged_categories.map(value => String(value || '').trim().toLowerCase())
    : [];
  if (!unchangedCategories.includes('contact')) return false;
  return mirrorRefreshIdentityAnchorCurrent(previous, source, scope, expectedSnapshot, targetSnapshotPayload);
}

function mirrorSnapshotEntry(kind, item) {
  return {
    kind,
    relative: item.relative,
    bytes: item.bytes,
    mtimeMs: item.mtimeMs,
    ctimeMs: Number(item.ctimeMs || 0) || 0,
    birthtimeMs: Number(item.birthtimeMs || 0) || 0,
    dev: Number(item.dev || 0) || 0,
    ino: Number(item.ino || 0) || 0,
  };
}

function mirrorSnapshotStatIdentity(st = {}) {
  return {
    ctimeMs: Number(st?.ctimeMs || 0) || 0,
    birthtimeMs: Number(st?.birthtimeMs || 0) || 0,
    dev: Number(st?.dev || 0) || 0,
    ino: Number(st?.ino || 0) || 0,
  };
}

function mirrorSnapshotManifest(snapshot = {}) {
  const files = [];
  for (const dbFile of snapshot.dbFiles || []) {
    files.push(mirrorSnapshotEntry('db', dbFile));
    for (const sidecar of dbFile.sidecars || []) files.push(mirrorSnapshotEntry('sidecar', sidecar));
  }
  return files.sort((a, b) => a.relative.localeCompare(b.relative) || a.kind.localeCompare(b.kind));
}

async function preserveMirrorCopyMtime(target, item = {}) {
  const mtimeMs = Number(item.mtimeMs || 0);
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return;
  const date = new Date(mtimeMs);
  await fsp.utimes(target, date, date);
}

async function copyMirrorFileWithSignal(source, target, { signal = null, onProgress = null } = {}) {
  throwIfDiscoveryAborted(signal);
  const sourceStat = await fsp.stat(source);
  const input = fs.createReadStream(source);
  let bytesRead = 0;
  let lastProgressAt = 0;
  const emitProgress = (force = false) => {
    if (typeof onProgress !== 'function') return;
    const now = Date.now();
    if (!force && now - lastProgressAt < 800) return;
    lastProgressAt = now;
    try {
      onProgress({
        bytes_read: bytesRead,
        total_bytes: Math.max(0, Number(sourceStat.size || 0) || 0),
        percent: sourceStat.size ? Math.min(100, Math.round((bytesRead / sourceStat.size) * 100)) : 100,
      });
    } catch {}
  };
  input.on('data', chunk => {
    bytesRead += Buffer.byteLength(chunk);
    emitProgress(false);
  });
  try {
    await pipeline(
      input,
      fs.createWriteStream(target, { flags: 'wx', mode: sourceStat.mode & 0o777 }),
      signal ? { signal } : {},
    );
    emitProgress(true);
  } catch (error) {
    await fsp.rm(target, { force: true }).catch(() => {});
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : discoveryAbortError();
    throw error;
  }
  throwIfDiscoveryAborted(signal);
}

function mirrorHardlinkFallbackError(error = null) {
  return ['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'EINVAL', 'EMLINK'].includes(String(error?.code || ''));
}

async function linkOrCopyMirrorFile(source, target, { signal = null, onProgress = null } = {}) {
  throwIfDiscoveryAborted(signal);
  try {
    await fsp.link(source, target);
    const linked = await fsp.lstat(target);
    if (!linked.isFile() || linked.isSymbolicLink()) {
      await fsp.rm(target, { force: true }).catch(() => {});
      throw Object.assign(new Error('镜像硬链接目标不是普通文件。'), { code: 'wxdb_mirror_hardlink_invalid' });
    }
    throwIfDiscoveryAborted(signal);
    return { linked: true, stat: linked };
  } catch (error) {
    if (!mirrorHardlinkFallbackError(error)) throw error;
  }
  await copyMirrorFileWithSignal(source, target, { signal, onProgress });
  const copied = await fsp.lstat(target);
  if (!copied.isFile() || copied.isSymbolicLink()) {
    await fsp.rm(target, { force: true }).catch(() => {});
    throw Object.assign(new Error('镜像复制目标不是普通文件。'), { code: 'wxdb_mirror_copy_target_invalid' });
  }
  throwIfDiscoveryAborted(signal);
  return { linked: false, stat: copied };
}

function mirrorSnapshotEntryMatchesPayload(kind = '', item = {}, payloadFile = null) {
  const current = mirrorSnapshotEntry(kind, item);
  const previous = mirrorSnapshotEntryFromPayload(payloadFile);
  if (!previous || mirrorSnapshotEntryKey(current) !== mirrorSnapshotEntryKey(previous)) return false;
  return ['bytes', 'mtimeMs', 'ctimeMs', 'birthtimeMs', 'dev', 'ino']
    .every(key => Number(current[key] || 0) === Number(previous[key] || 0));
}

function mirrorSnapshotPayloadFilesByKey(payload = null) {
  const out = new Map();
  for (const file of Array.isArray(payload?.files) ? payload.files : []) {
    const entry = mirrorSnapshotEntryFromPayload(file);
    if (entry) out.set(mirrorSnapshotEntryKey(entry), file);
  }
  return out;
}

async function reuseProjectMirrorFileInStaging(existingTargetDbStorage, targetDbStorage, relative = '', item = {}, { signal = null, publishedFile = null } = {}) {
  throwIfDiscoveryAborted(signal);
  const existingRoot = path.resolve(existingTargetDbStorage || '');
  const stagingRoot = path.resolve(targetDbStorage || '');
  const source = path.resolve(existingRoot, relative);
  const target = path.resolve(stagingRoot, relative);
  assertMirrorStagingTarget(existingRoot, source);
  assertMirrorStagingTarget(stagingRoot, target);
  const st = await fsp.lstat(source).catch(e => {
    if (e?.code === 'ENOENT') return null;
    throw e;
  });
  if (!st?.isFile() || st.isSymbolicLink()) return null;
  const sourceTarget = {
    is_file: true,
    is_symbolic_link: false,
    bytes: st.size,
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    birthtimeMs: st.birthtimeMs,
    dev: st.dev,
    ino: st.ino,
  };
  if (!mirrorTargetSnapshotFileMatches(sourceTarget, item)) return null;
  const publishedIdentityCurrent = mirrorTargetIdentityMatches(sourceTarget, publishedFile || {});
  if (sameRealPath(existingRoot, stagingRoot)) {
    const stat = await fsp.stat(source).catch(() => null);
    return stat ? { stat, trusted_content_hash: publishedIdentityCurrent } : null;
  }
  await ensureSafeMirrorDir(path.dirname(target));
  const transferred = await linkOrCopyMirrorFile(source, target, { signal });
  if (!transferred.linked) await preserveMirrorCopyMtime(target, item);
  throwIfDiscoveryAborted(signal);
  const targetStat = await fsp.stat(target).catch(() => null);
  if (!targetStat) return null;
  const linkedIdentityStable = transferred.linked
    && Number(targetStat.dev || 0) === Number(st.dev || 0)
    && Number(targetStat.ino || 0) === Number(st.ino || 0)
    && Number(targetStat.size || 0) === Number(st.size || 0)
    && Math.abs(Number(targetStat.mtimeMs || 0) - Number(st.mtimeMs || 0)) <= 2;
  return {
    stat: targetStat,
    trusted_content_hash: publishedIdentityCurrent && linkedIdentityStable,
  };
}

async function pruneReusedMirrorStagingFiles(targetDbStorage = '', reuseSnapshotPayload = null, snapshot = {}, { signal = null } = {}) {
  const root = path.resolve(targetDbStorage || '');
  const wanted = new Set(mirrorSnapshotRelativeFiles(snapshot));
  for (const file of Array.isArray(reuseSnapshotPayload?.files) ? reuseSnapshotPayload.files : []) {
    throwIfDiscoveryAborted(signal);
    const relative = normalizeMirrorRelative(file?.relative || '');
    if (!relative || wanted.has(relative)) continue;
    const target = path.resolve(root, relative);
    assertMirrorStagingTarget(root, target);
    await fsp.rm(target, { force: true });
  }
}

async function copyMirrorDbFileSet({
  snapshot = {},
  sourceDbStorageReal = '',
  targetDbStorage = '',
  existingTargetDbStorage = '',
  reuseSnapshotPayload = null,
  allowProjectReuse = false,
  additionalRequiredBytes = 0,
  signal = null,
  progress = null,
  phase = 'mirror_copy_db',
  label = '检查本地数据 · 复制数据库文件',
} = {}) {
  const dbFiles = [...(snapshot.dbFiles || [])].sort((left, right) => {
    const rightTime = Math.max(Number(right?.mtimeMs || 0) || 0, ...(right?.sidecars || []).map(item => Number(item?.mtimeMs || 0) || 0));
    const leftTime = Math.max(Number(left?.mtimeMs || 0) || 0, ...(left?.sidecars || []).map(item => Number(item?.mtimeMs || 0) || 0));
    return rightTime - leftTime || String(left?.relative || '').localeCompare(String(right?.relative || ''));
  });
  const reuseExistingStaging = !!String(existingTargetDbStorage || '').trim()
    && sameRealPath(existingTargetDbStorage, targetDbStorage);
  const reusableByKey = allowProjectReuse ? mirrorSnapshotPayloadFilesByKey(reuseSnapshotPayload) : new Map();
  if (reuseExistingStaging) {
    await pruneReusedMirrorStagingFiles(targetDbStorage, reuseSnapshotPayload, snapshot, { signal });
  }
  const reusableEntry = (kind, item) => {
    const previous = reusableByKey.get(mirrorSnapshotEntryKey(mirrorSnapshotEntry(kind, item)));
    const sha256 = String(previous?.sha256 || '').trim().toLowerCase();
    if (!previous || !/^[a-f0-9]{64}$/.test(sha256) || !mirrorSnapshotEntryMatchesPayload(kind, item, previous)) return null;
    return { previous, sha256 };
  };
  const requiredSourceCopyBytes = dbFiles.reduce((sum, dbFile) => {
    const dbBytes = reusableEntry('db', dbFile) ? 0 : (Number(dbFile.bytes || 0) || 0);
    return sum + dbBytes + (dbFile.sidecars || []).reduce((sideSum, sidecar) => (
      sideSum + (reusableEntry('sidecar', sidecar) ? 0 : (Number(sidecar.bytes || 0) || 0))
    ), 0);
  }, 0);
  const requiredSnapshotBytes = dbFiles.reduce((sum, dbFile) => {
    const dbBytes = Number(dbFile.bytes || 0) || 0;
    return sum + dbBytes + (dbFile.sidecars || []).reduce((sideSum, sidecar) => (
      sideSum + (Number(sidecar.bytes || 0) || 0)
    ), 0);
  }, 0);
  const requiredStagingBytes = (reuseExistingStaging ? requiredSourceCopyBytes : requiredSnapshotBytes)
    + Math.max(0, Number(additionalRequiredBytes || 0) || 0);
  await assertAvailableDiskSpace(targetDbStorage, requiredStagingBytes, {
    code: 'wxdb_mirror_disk_space_insufficient',
    message: '项目数据目录所在磁盘可用空间不足，无法安全复制微信数据库工作副本。请清理磁盘空间后重试。',
  });
  const copied = [];
  let bytes = 0;
  let index = 0;
  let reusedDbCount = 0;
  let reusedFileCount = 0;
  let reusedCachedHashCount = 0;
  let sourceCopiedFileCount = 0;
  let reusedBytes = 0;
  let sourceCopiedBytes = 0;
  let fileIndex = 0;
  const totalFiles = dbFiles.reduce((sum, dbFile) => sum + 1 + (dbFile.sidecars || []).length, 0);
  const reusedContentHashes = new Map();
  const reusedContentIdentities = new Map();
  Object.defineProperty(reusedContentHashes, 'target_identities', { value: reusedContentIdentities });
  const copyFile = async (kind, item, sourcePath, target) => {
    fileIndex += 1;
    const relative = normalizeMirrorRelative(item.relative || '') || String(item.name || path.basename(sourcePath) || '数据库文件');
    const sizeLabel = formatMirrorBytes(Number(item.bytes || 0) || 0);
    const progressDetail = action => `${fileIndex}/${totalFiles} ${relative} · ${action}${sizeLabel ? ` · ${sizeLabel}` : ''}`;
    progress?.({
      phase: `${phase}_file_check`,
      label: '检查本地数据 · 检查所需文件',
      detail: progressDetail('检查项目副本是否可复用'),
      index: fileIndex,
      total: totalFiles,
      name: item.name || path.basename(sourcePath),
      relative,
      bytes: Number(item.bytes || 0) || 0,
    });
    const reusable = reusableEntry(kind, item);
    if (reusable) {
      const reused = await reuseProjectMirrorFileInStaging(existingTargetDbStorage, targetDbStorage, item.relative, item, {
        signal,
        publishedFile: reusable.previous,
      });
      if (reused) {
        const reusedStat = reused.stat;
        progress?.({
          phase: `${phase}_file_reuse_verify`,
          label: '检查本地数据 · 校验可复用文件',
          detail: progressDetail(reused.trusted_content_hash
            ? '发布文件身份一致，复用已有完整内容校验'
            : (reuseExistingStaging
              ? '复用上一轮临时工作数据，正在重新核对内容'
              : '已隔离复制项目副本，正在核对内容')),
          index: fileIndex,
          total: totalFiles,
          name: item.name || path.basename(sourcePath),
          relative,
          bytes: Number(reusedStat.size || item.bytes || 0) || 0,
          reused: true,
        });
        const reusedVerification = reused.trusted_content_hash
          ? {
              sha256: reusable.sha256,
              target_identity: mirrorTargetIdentityFieldsFromStat(reusedStat),
            }
          : await hashProjectMirrorCopyFile(target, { signal, includeIdentity: true });
        if (reusedVerification.sha256 === reusable.sha256) {
          if (reused.trusted_content_hash) reusedCachedHashCount += 1;
          reusedFileCount += 1;
          reusedBytes += Number(reusedStat.size || item.bytes || 0) || 0;
          const reusedRelative = normalizeMirrorRelative(item.relative || '');
          reusedContentHashes.set(reusedRelative, reusedVerification.sha256);
          reusedContentIdentities.set(reusedRelative, reusedVerification.target_identity);
          progress?.({
            phase: `${phase}_file_reused`,
            label: '检查本地数据 · 复用项目副本',
            detail: progressDetail(reused.trusted_content_hash
              ? '文件身份一致，沿用已发布完整校验，不读取微信源文件'
              : (reuseExistingStaging
                ? '已重新核对临时副本内容，不读取微信源文件'
                : '内容校验一致，不读取微信源文件')),
            index: fileIndex,
            total: totalFiles,
            name: item.name || path.basename(sourcePath),
            relative,
            bytes: Number(reusedStat.size || item.bytes || 0) || 0,
            reused: true,
          });
          return { stat: reusedStat, reused: true };
        }
        await fsp.rm(target, { force: true });
        progress?.({
          phase: `${phase}_file_reuse_invalid`,
          label: '检查本地数据 · 项目副本已变化',
          detail: progressDetail('内容与发布清单不一致，改从微信源目录重新复制'),
          index: fileIndex,
          total: totalFiles,
          name: item.name || path.basename(sourcePath),
          relative,
          bytes: Number(reusedStat.size || item.bytes || 0) || 0,
          reused: false,
        });
      }
    }
    progress?.({
      phase: `${phase}_file_copy`,
      label: '检查本地数据 · 复制变化文件',
      detail: progressDetail('从微信源目录只读复制到项目临时区'),
      index: fileIndex,
      total: totalFiles,
      name: item.name || path.basename(sourcePath),
      relative,
      bytes: Number(item.bytes || 0) || 0,
      reused: false,
    });
    if (reuseExistingStaging) await fsp.rm(target, { force: true });
    const stat = await copyMirrorSourceFileToProject(sourcePath, target, item, {
      sourceDbStorageReal,
      targetDbStorage,
      signal,
      onProgress: copyProgress => {
        const copiedBytes = Math.max(0, Number(copyProgress?.bytes_read || 0) || 0);
        progress?.({
          phase: `${phase}_file_copy_progress`,
          label: '检查本地数据 · 正在复制变化文件',
          detail: progressDetail(`从微信源目录只读复制到项目临时区 · 已复制 ${formatMirrorBytes(copiedBytes)}`),
          index: fileIndex,
          total: totalFiles,
          name: item.name || path.basename(sourcePath),
          relative,
          bytes: Number(item.bytes || 0) || 0,
          bytes_read: copiedBytes,
          total_bytes: Math.max(0, Number(copyProgress?.total_bytes || item.bytes || 0) || 0),
          percent: Number(copyProgress?.percent || 0) || 0,
          reused: false,
        });
      },
    });
    sourceCopiedFileCount += 1;
    sourceCopiedBytes += Number(stat?.size || item.bytes || 0) || 0;
    progress?.({
      phase: `${phase}_file_copied`,
      label: '检查本地数据 · 变化文件已复制',
      detail: progressDetail('已写入项目临时区'),
      index: fileIndex,
      total: totalFiles,
      name: item.name || path.basename(sourcePath),
      relative,
      bytes: Number(stat?.size || item.bytes || 0) || 0,
      reused: false,
    });
    return { stat, reused: false };
  };
  for (const dbFile of dbFiles) {
    throwIfDiscoveryAborted(signal);
    index += 1;
    const sourcePath = path.resolve(dbFile.path);
    await assertMirrorSourceDbSetMatchesSnapshot(sourceDbStorageReal, dbFile, { signal });
    const target = path.resolve(targetDbStorage, dbFile.relative);
    const copiedDb = await copyFile('db', dbFile, sourcePath, target);
    const copiedStat = copiedDb.stat;
    if (copiedDb.reused) reusedDbCount += 1;
    progress?.({
      phase,
      label,
      detail: `${index}/${dbFiles.length} ${dbFile.category}/${dbFile.name}`,
      index,
      total: dbFiles.length,
      name: dbFile.name,
    });
    const sidecars = [];
    for (const sidecar of dbFile.sidecars || []) {
      throwIfDiscoveryAborted(signal);
      const sideSource = path.resolve(sidecar.path);
      const sideTarget = path.resolve(targetDbStorage, sidecar.relative);
      const sideCopied = (await copyFile('sidecar', sidecar, sideSource, sideTarget)).stat;
      sidecars.push({ name: sidecar.name, bytes: sideCopied?.size || sidecar.bytes || 0 });
      bytes += Number(sideCopied?.size || sidecar.bytes || 0);
    }
    await assertMirrorSourceDbSetMatchesSnapshot(sourceDbStorageReal, dbFile, { signal });
    copied.push({
      category: dbFile.category,
      name: dbFile.name,
      bytes: copiedStat?.size || dbFile.bytes || 0,
      sidecars,
      last_write_time: dbFile.last_write_time || '',
    });
    bytes += Number(copiedStat?.size || dbFile.bytes || 0);
  }
  return {
    copied,
    bytes,
    reused_db_count: reusedDbCount,
    reused_file_count: reusedFileCount,
    reused_cached_hash_count: reusedCachedHashCount,
    source_copied_file_count: sourceCopiedFileCount,
    reused_bytes: reusedBytes,
    source_copied_bytes: sourceCopiedBytes,
    required_source_copy_bytes: requiredSourceCopyBytes,
    required_staging_bytes: requiredStagingBytes,
    reused_content_hashes: reusedContentHashes,
    captured_snapshot: snapshot,
  };
}

async function copyMirrorSourceFileToProject(sourcePath, target, item = {}, { sourceDbStorageReal = '', targetDbStorage = '', signal = null, onProgress = null } = {}) {
  throwIfDiscoveryAborted(signal);
  await assertMirrorSourceFile(sourceDbStorageReal, sourcePath);
  assertMirrorStagingTarget(targetDbStorage, target);
  await ensureSafeMirrorDir(path.dirname(target));
  const before = await statWxDbSourceFile(sourcePath, { signal });
  assertMirrorSourceFileMatchesSnapshot(before, item);
  await copyMirrorFileWithSignal(sourcePath, target, { signal, onProgress });
  const after = await statWxDbSourceFile(sourcePath, { signal });
  assertMirrorSourceFileMatchesSnapshot(after, item);
  const copied = await fsp.lstat(target).catch(() => null);
  if (!copied?.isFile() || copied.isSymbolicLink() || Number(copied.size || 0) !== Number(item.bytes || 0)) {
    await fsp.rm(target, { force: true }).catch(() => {});
    throw Object.assign(new Error('项目临时副本大小与源文件快照不一致，已停止本次更新。'), {
      status: 409,
      code: 'wxdb_mirror_staging_incomplete',
      public_code: 'wxdb_mirror_staging_incomplete',
    });
  }
  await preserveMirrorCopyMtime(target, item);
  throwIfDiscoveryAborted(signal);
  return fsp.stat(target).catch(() => null);
}

function mirrorSourceStatMatchesSnapshotItem(st = null, item = {}) {
  if (!st?.isFile?.() || st.isSymbolicLink?.()) return false;
  return ['size', 'mtimeMs', 'ctimeMs', 'birthtimeMs', 'dev', 'ino'].every(key => {
    const expectedKey = key === 'size' ? 'bytes' : key;
    return Number(st[key] || 0) === Number(item?.[expectedKey] || 0);
  });
}

function assertMirrorSourceFileMatchesSnapshot(st = null, item = {}) {
  if (st && (!st.isFile() || st.isSymbolicLink())) {
    throw Object.assign(new Error('源数据库文件清单包含非普通文件或符号链接，已拒绝更新本地工作数据。'), {
      status: 403,
      code: 'wxdb_source_not_regular_file',
      public_code: 'wxdb_source_not_regular_file',
    });
  }
  if (!mirrorSourceStatMatchesSnapshotItem(st, item)) throw mirrorSourceChangedDuringCopyError();
}

async function assertMirrorSourceDbSetMatchesSnapshot(sourceDbStorageReal, dbFile = {}, { signal = null } = {}) {
  throwIfDiscoveryAborted(signal);
  const sourcePath = path.resolve(String(dbFile.path || ''));
  await assertMirrorSourceFile(sourceDbStorageReal, sourcePath);
  const dbStat = await statWxDbSourceFile(sourcePath, { signal });
  assertMirrorSourceFileMatchesSnapshot(dbStat, dbFile);

  const expectedSidecars = new Map();
  for (const sidecar of dbFile.sidecars || []) {
    const suffix = String(sidecar?.suffix || '').toLowerCase();
    const expectedPath = path.resolve(`${sourcePath}${suffix}`);
    if (!SQLITE_PERSISTED_SIDECAR_SUFFIXES.includes(suffix)
      || expectedSidecars.has(suffix)
      || path.resolve(String(sidecar?.path || '')) !== expectedPath) {
      throw mirrorSourceChangedDuringCopyError();
    }
    expectedSidecars.set(suffix, sidecar);
  }

  for (const suffix of SQLITE_PERSISTED_SIDECAR_SUFFIXES) {
    throwIfDiscoveryAborted(signal);
    const sidePath = path.resolve(`${sourcePath}${suffix}`);
    const expected = expectedSidecars.get(suffix) || null;
    const sideStat = await statWxDbSourceSidecar(sidePath, { signal });
    if (!expected) {
      if (!sideStat) continue;
      await assertMirrorSourceFile(sourceDbStorageReal, sidePath);
      throw mirrorSourceChangedDuringCopyError();
    }
    await assertMirrorSourceFile(sourceDbStorageReal, sidePath);
    assertMirrorSourceFileMatchesSnapshot(sideStat, expected);
  }
}

async function hashVerifiedMirrorStagingCopy(targetDbStorage, snapshot = {}, {
  signal = null,
  progress = null,
  knownHashes = null,
  phase = 'mirror_copy_hash',
  label = '检查本地数据 · 校验项目副本内容',
} = {}) {
  progress?.({
    phase,
    label,
    detail: '只读取项目临时副本并计算内容校验，不打开或查询微信源数据库',
  });
  const hashes = await mirrorProjectContentHashMap(targetDbStorage, snapshot, {
    signal,
    knownHashes,
    onProgress: data => progress?.({ ...data, phase: `${phase}_progress`, label }),
  });
  progress?.({
    phase: `${phase}_done`,
    label,
    detail: `已校验 ${hashes.size} 个项目副本文件`,
  });
  return hashes;
}

function mirrorSnapshotRelativeFiles(snapshot = {}) {
  const out = [];
  for (const dbFile of snapshot.dbFiles || []) {
    const dbRelative = normalizeMirrorRelative(dbFile.relative || '');
    if (dbRelative) out.push(dbRelative);
    for (const sidecar of dbFile.sidecars || []) {
      const sideRelative = normalizeMirrorRelative(sidecar.relative || '');
      if (sideRelative) out.push(sideRelative);
    }
  }
  return out;
}

async function mirrorProjectContentHashMap(targetDbStorage, snapshot = {}, { signal = null, onProgress = null, knownHashes = null } = {}) {
  const out = new Map();
  const known = knownHashes instanceof Map ? knownHashes : new Map();
  const targetIdentities = new Map();
  Object.defineProperty(out, 'target_identities', { value: targetIdentities });
  const root = path.resolve(targetDbStorage || '');
  const files = mirrorSnapshotManifest(snapshot);
  const totalBytes = files.reduce((sum, file) => sum + Math.max(0, Number(file.bytes || 0) || 0), 0);
  let completedBytes = 0;
  let index = 0;
  for (const file of files) {
    throwIfDiscoveryAborted(signal);
    index += 1;
    const relative = file.relative;
    const target = path.resolve(root, relative);
    assertMirrorStagingTarget(root, target);
    const fileBytes = Math.max(0, Number(file.bytes || 0) || 0);
    const knownHash = String(known.get(relative) || '').trim().toLowerCase();
    if (/^[a-f0-9]{64}$/.test(knownHash)) {
      const knownIdentity = known?.target_identities instanceof Map ? known.target_identities.get(relative) : null;
      const stat = await fsp.lstat(target).catch(() => null);
      const targetInfo = stat ? {
        is_file: stat.isFile(),
        is_symbolic_link: stat.isSymbolicLink(),
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        birthtimeMs: stat.birthtimeMs,
        dev: stat.dev,
        ino: stat.ino,
      } : null;
      if (mirrorTargetSnapshotFileMatches(targetInfo, file) && mirrorTargetIdentityMatches(targetInfo, knownIdentity)) {
        out.set(relative, knownHash);
        targetIdentities.set(relative, mirrorTargetIdentityFieldsFromStat(stat));
        completedBytes += fileBytes;
        continue;
      }
    }
    const verification = await hashProjectMirrorCopyFile(target, {
      signal,
      includeIdentity: true,
      onProgress: progress => {
        if (typeof onProgress !== 'function') return;
        const currentBytes = Math.min(totalBytes, completedBytes + Math.max(0, Number(progress?.bytes_read || 0) || 0));
        try {
          onProgress({
            phase: 'mirror_reuse_verify_hash_progress',
            label: '检查本地数据 · 完整校验本地工作数据',
            detail: `${index}/${files.length} ${relative} · ${formatMirrorBytes(currentBytes)}/${formatMirrorBytes(totalBytes)}`,
            index,
            total: files.length,
            bytes_read: currentBytes,
            total_bytes: totalBytes,
            percent: totalBytes ? Math.min(100, Math.round((currentBytes / totalBytes) * 100)) : 0,
          });
        } catch {}
      },
    });
    out.set(relative, verification.sha256);
    targetIdentities.set(relative, verification.target_identity);
    completedBytes += fileBytes;
  }
  return out;
}

async function hashProjectMirrorCopyFile(file, { signal = null, onProgress = null, includeIdentity = false } = {}) {
  throwIfDiscoveryAborted(signal);
  const before = await fsp.lstat(file);
  throwIfDiscoveryAborted(signal);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('project mirror copy path is not a regular file');
  const sha256 = await hashFileContentSha256(file, { signal, onProgress, totalBytes: before.size });
  const after = await fsp.lstat(file);
  throwIfDiscoveryAborted(signal);
  if (!after.isFile() || after.isSymbolicLink() || !mirrorFileStatIdentityMatches(before, after)) {
    throw Object.assign(new Error('项目副本文件在内容校验期间发生变化，已拒绝使用不一致的哈希结果。'), {
      status: 409,
      code: 'wxdb_mirror_hash_raced',
      public_code: 'wxdb_mirror_hash_raced',
    });
  }
  if (!includeIdentity) return sha256;
  return {
    sha256,
    target_identity: mirrorTargetIdentityFieldsFromStat(after),
  };
}

function mirrorFileStatIdentityMatches(left = {}, right = {}) {
  return Number(left.size || 0) === Number(right.size || 0)
    && Math.abs(Number(left.mtimeMs || 0) - Number(right.mtimeMs || 0)) <= 2
    && Math.abs(Number(left.ctimeMs || 0) - Number(right.ctimeMs || 0)) <= 2
    && Math.abs(Number(left.birthtimeMs || 0) - Number(right.birthtimeMs || 0)) <= 2
    && Number(left.dev || 0) === Number(right.dev || 0)
    && Number(left.ino || 0) === Number(right.ino || 0);
}

async function hashFileContentSha256(file, { signal = null, onProgress = null, totalBytes = 0 } = {}) {
  throwIfDiscoveryAborted(signal);
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    let bytesRead = 0;
    let lastProgressAt = 0;
    const total = Math.max(0, Number(totalBytes || 0) || 0);
    const emitProgress = (force = false) => {
      if (typeof onProgress !== 'function') return;
      const now = Date.now();
      if (!force && now - lastProgressAt < 800) return;
      lastProgressAt = now;
      try {
        onProgress({
          bytes_read: bytesRead,
          total_bytes: total,
          percent: total ? Math.min(100, Math.round((bytesRead / total) * 100)) : 0,
        });
      } catch {}
    };
    const onAbort = () => {
      stream.destroy(signal.reason instanceof Error ? signal.reason : discoveryAbortError());
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    stream.on('data', chunk => {
      bytesRead += Buffer.byteLength(chunk);
      hash.update(chunk);
      emitProgress(false);
    });
    stream.on('error', reject);
    stream.on('end', () => {
      emitProgress(true);
      resolve();
    });
    stream.on('close', () => signal?.removeEventListener?.('abort', onAbort));
  });
  throwIfDiscoveryAborted(signal);
  return hash.digest('hex');
}

function mirrorTargetUnreadableError(message, error = null) {
  return Object.assign(new Error(message), {
    status: 409,
    code: 'wxdb_mirror_target_unreadable',
    public_code: 'wxdb_mirror_target_unreadable',
    cause: error || undefined,
  });
}

async function statMirrorTargetDbStorage(targetDbStorage, { signal = null } = {}) {
  throwIfDiscoveryAborted(signal);
  await assertSafeMirrorTargetRoot(targetDbStorage);
  let st = null;
  try {
    st = await fsp.lstat(targetDbStorage);
  } catch (e) {
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return null;
    throw mirrorTargetUnreadableError(`微信本地工作数据目录不可读，已拒绝复用或覆盖旧数据：${e?.message || String(e)}`, e);
  }
  throwIfDiscoveryAborted(signal);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw mirrorTargetUnreadableError('微信本地工作数据目录不是普通目录，已拒绝复用或覆盖旧数据。');
  }
  return st;
}

async function mirrorTargetMatchesSourceSnapshot(targetDbStorage, snapshot = {}, { signal = null, allowExtra = false, extraScopeCategories = [] } = {}) {
  const dbFiles = Array.isArray(snapshot.dbFiles) ? snapshot.dbFiles : [];
  if (!dbFiles.length) return false;
  const expectedFiles = new Map();
  for (const dbFile of dbFiles) {
    const dbRelative = normalizeMirrorRelative(dbFile.relative || '');
    if (!dbRelative) return false;
    expectedFiles.set(dbRelative, dbFile);
    throwIfDiscoveryAborted(signal);
    for (const sidecar of dbFile.sidecars || []) {
      const sideRelative = normalizeMirrorRelative(sidecar.relative || '');
      if (!sideRelative) return false;
      expectedFiles.set(sideRelative, sidecar);
      throwIfDiscoveryAborted(signal);
    }
  }
  const targetFiles = await collectMirrorTargetSnapshotFiles(targetDbStorage, { signal });
  if (allowExtra) {
    if (targetFiles.size < expectedFiles.size) return false;
    const scopedCategories = new Set((Array.isArray(extraScopeCategories) ? extraScopeCategories : [])
      .map(value => String(value || '').trim())
      .filter(Boolean));
    if (scopedCategories.size) {
      for (const relative of targetFiles.keys()) {
        if (expectedFiles.has(relative)) continue;
        const category = normalizeMirrorRelative(relative).split('/')[0] || '';
        if (scopedCategories.has(category)) return false;
      }
    }
  } else if (targetFiles.size !== expectedFiles.size) {
    return false;
  }
  for (const [relative, item] of expectedFiles.entries()) {
    throwIfDiscoveryAborted(signal);
    if (!mirrorTargetSnapshotFileMatches(targetFiles.get(relative), item)) return false;
  }
  return true;
}

async function collectMirrorTargetSnapshotFiles(targetDbStorage, { signal = null } = {}) {
  const root = path.resolve(targetDbStorage || '');
  const out = new Map();
  async function visit(dir) {
    throwIfDiscoveryAborted(signal);
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(e => {
      if (e?.code === 'ENOENT') return [];
      throw Object.assign(new Error(`微信本地工作数据目录不可读，已拒绝复用旧数据：${e?.message || String(e)}`), {
        status: 409,
        code: 'wxdb_mirror_target_unreadable',
        public_code: 'wxdb_mirror_target_unreadable',
        cause: e,
      });
    });
    for (const entry of entries) {
      throwIfDiscoveryAborted(signal);
      const full = path.resolve(dir, entry.name);
      assertMirrorStagingTarget(root, full);
      if (entry.isDirectory()) {
        await visit(full);
        continue;
      }
      if (!isMirrorDatabaseCopyName(entry.name)) continue;
      const st = await fsp.lstat(full).catch(e => {
        if (e?.code === 'ENOENT') return null;
        throw Object.assign(new Error(`微信本地工作数据文件不可读，已拒绝复用旧数据：${e?.message || String(e)}`), {
          status: 409,
          code: 'wxdb_mirror_target_unreadable',
          public_code: 'wxdb_mirror_target_unreadable',
          cause: e,
        });
      });
      const relative = normalizeMirrorRelative(path.relative(root, full));
      out.set(relative, {
        is_file: !!st?.isFile(),
        is_symbolic_link: !!st?.isSymbolicLink(),
        bytes: Number(st?.size || 0) || 0,
        mtimeMs: Number(st?.mtimeMs || 0) || 0,
        ctimeMs: Number(st?.ctimeMs || 0) || 0,
        birthtimeMs: Number(st?.birthtimeMs || 0) || 0,
        dev: Number(st?.dev || 0) || 0,
        ino: Number(st?.ino || 0) || 0,
      });
    }
  }
  await visit(root);
  return out;
}

function mirrorTargetSnapshotFileMatches(target = null, item = {}) {
  const expectedMtimeMs = Number(item?.mtimeMs || 0) || 0;
  const actualMtimeMs = Number(target?.mtimeMs || 0) || 0;
  return !!target
    && target.is_file
    && !target.is_symbolic_link
    && Number(target.bytes || 0) === Number(item.bytes || 0)
    && (!expectedMtimeMs || Math.abs(actualMtimeMs - expectedMtimeMs) <= 2);
}

function isMirrorDatabaseCopyName(name = '') {
  return /\.db(?:-(?:wal|shm|journal))?$/i.test(String(name || ''));
}

function normalizeMirrorRelative(relativePath = '') {
  const raw = String(relativePath || '').trim();
  if (!raw || path.isAbsolute(raw)) return '';
  const normalized = raw.split(/[\\/]+/).filter(Boolean).join('/');
  if (!normalized || normalized === '.' || normalized.split('/').includes('..')) return '';
  return normalized;
}

async function assertSafeMirrorTargetRoot(targetRoot) {
  const root = path.resolve(WXDB_MIRROR_ROOT);
  const target = path.resolve(targetRoot || '');
  if (!isInside(root, target) || target === root) {
    throw Object.assign(new Error('微信本地工作数据目标路径越界，已拒绝更新。'), { status: 403, code: 'wxdb_mirror_target_outside_project', public_code: 'wxdb_mirror_target_outside_project' });
  }
  const { rootReal } = await assertMirrorRootReady();
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  let current = root;
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    const st = await fsp.lstat(current).catch(e => {
      if (e?.code === 'ENOENT') return null;
      throw e;
    });
    if (!st) break;
    if (st.isSymbolicLink()) {
      throw Object.assign(new Error('微信本地工作数据路径包含链接或重解析点，已拒绝更新。'), { status: 403, code: 'wxdb_mirror_reparse_point', public_code: 'wxdb_mirror_reparse_point' });
    }
    if (!st.isDirectory()) {
      throw Object.assign(new Error('微信本地工作数据路径不是普通目录，已拒绝更新。'), { status: 403, code: 'wxdb_mirror_target_not_directory', public_code: 'wxdb_mirror_target_not_directory' });
    }
    const real = await fsp.realpath(current).catch(() => '');
    if (!real || !isInside(rootReal, real)) {
      throw Object.assign(new Error('微信本地工作数据真实路径越界，已拒绝更新。'), { status: 403, code: 'wxdb_mirror_realpath_outside_project', public_code: 'wxdb_mirror_realpath_outside_project' });
    }
  }
}

async function ensureSafeMirrorDir(dirPath) {
  await assertSafeMirrorTargetRoot(dirPath);
  await ensureDir(dirPath);
  await assertSafeMirrorTargetRoot(dirPath);
}

function assertMirrorStagingTarget(stagingDbStorage, target) {
  const root = path.resolve(stagingDbStorage || '');
  const resolved = path.resolve(target || '');
  if (!isInside(root, resolved)) {
    throw Object.assign(new Error('微信本地工作数据临时工作区路径越界，已拒绝复制。'), { status: 403, code: 'wxdb_mirror_staging_outside_project', public_code: 'wxdb_mirror_staging_outside_project' });
  }
}

async function assertMirrorRootReady() {
  await ensureDir(DATA_DIR);
  const root = path.resolve(WXDB_MIRROR_ROOT);
  const dataReal = await fsp.realpath(DATA_DIR).catch(() => '');
  const parentReal = await fsp.realpath(path.dirname(root)).catch(() => '');
  if (!dataReal || !parentReal || !isInside(dataReal, parentReal)) {
    throw Object.assign(new Error('微信本地工作数据根目录父路径不在项目 data 内，已拒绝操作。'), { status: 403, code: 'wxdb_mirror_root_outside_project', public_code: 'wxdb_mirror_root_outside_project' });
  }
  let rootStat = await fsp.lstat(root).catch(e => {
    if (e?.code === 'ENOENT') return null;
    throw e;
  });
  if (!rootStat) {
    await fsp.mkdir(root).catch(e => {
      if (e?.code !== 'EEXIST') throw e;
    });
    rootStat = await fsp.lstat(root);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw Object.assign(new Error('微信本地工作数据根目录必须是项目内普通目录，不能是链接或重解析点。'), { status: 403, code: 'wxdb_mirror_root_reparse_point', public_code: 'wxdb_mirror_root_reparse_point' });
  }
  const rootReal = await fsp.realpath(root).catch(() => '');
  if (!rootReal || path.resolve(rootReal) === path.resolve(dataReal) || !isInside(dataReal, rootReal)) {
    throw Object.assign(new Error('微信本地工作数据根目录真实路径不在项目 data 内，已拒绝操作。'), { status: 403, code: 'wxdb_mirror_root_realpath_outside_project', public_code: 'wxdb_mirror_root_realpath_outside_project' });
  }
  return { root, rootReal };
}

async function assertNoMirrorSymlinkTree(rootPath) {
  await assertSafeMirrorTargetRoot(rootPath);
  const root = path.resolve(rootPath || '');
  const st = await fsp.lstat(root).catch(e => {
    if (e?.code === 'ENOENT') return null;
    throw e;
  });
  if (!st) return;
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw Object.assign(new Error('微信本地工作数据目录必须是普通目录，不能是链接或重解析点。'), { status: 403, code: 'wxdb_mirror_reparse_point', public_code: 'wxdb_mirror_reparse_point' });
  }
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(e => {
      if (e?.code === 'ENOENT') return [];
      throw e;
    });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const entryStat = await fsp.lstat(full).catch(e => {
        if (e?.code === 'ENOENT') return null;
        throw e;
      });
      if (!entryStat) continue;
      if (entryStat.isSymbolicLink()) {
        throw Object.assign(new Error('微信本地工作数据目录树包含链接或重解析点，已拒绝更新或删除。'), { status: 403, code: 'wxdb_mirror_reparse_point', public_code: 'wxdb_mirror_reparse_point' });
      }
      if (entryStat.isDirectory()) stack.push(full);
      else if (!entryStat.isFile()) {
        throw Object.assign(new Error('微信本地工作数据目录树包含非普通文件，已拒绝更新或删除。'), { status: 403, code: 'wxdb_mirror_non_regular_file', public_code: 'wxdb_mirror_non_regular_file' });
      }
    }
  }
}

async function removeSafeMirrorRoot(rootPath) {
  const st = await fsp.lstat(rootPath).catch(e => {
    if (e?.code === 'ENOENT') return null;
    throw e;
  });
  if (!st) return;
  await assertNoMirrorSymlinkTree(rootPath);
  await fsp.rm(rootPath, { recursive: true, force: true });
}

function isTransientMirrorCopyError(error) {
  const code = String(error?.code || '');
  if (['wxdb_source_snapshot_unstable', 'wxdb_source_changed_during_mirror_copy'].includes(code)) return true;
  if (['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(code)) return true;
  return /being used|busy|no such file|permission|access|正在写入|快照不一致/i.test(String(error?.message || ''));
}

function mirrorCopyPublicErrorCode(error = null) {
  const publicCode = String(error?.public_code || '').trim();
  if (/^wxdb_[a-z0-9_:-]{1,80}$/.test(publicCode)) return publicCode;
  const code = String(error?.code || '').trim();
  if (/^wxdb_[a-z0-9_:-]{1,80}$/.test(code)) return code;
  const errno = String(error?.errno || code || '').trim().toUpperCase();
  if (errno === 'EBUSY') return 'wxdb_source_file_busy';
  if (errno === 'EPERM' || errno === 'EACCES') return 'wxdb_source_access_denied';
  if (errno === 'ENOENT') return 'wxdb_source_file_missing';
  return 'wxdb_source_snapshot_unstable';
}

function mirrorCopyDiagnosticErrno(error = null) {
  const errno = String(error?.errno || error?.code || '').trim().toUpperCase();
  return ['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(errno) ? errno : '';
}

function mirrorDiskSpaceError(error = null) {
  if (String(error?.code || '') === 'wxdb_mirror_disk_space_insufficient') return error;
  const err = Object.assign(new Error('项目数据目录所在磁盘可用空间不足，无法安全更新微信数据库工作副本。请清理磁盘空间后重试。'), {
    status: 507,
    code: 'wxdb_mirror_disk_space_insufficient',
    public_code: 'wxdb_mirror_disk_space_insufficient',
  });
  for (const field of ['required_bytes', 'reserve_bytes', 'available_bytes']) {
    if (Number.isFinite(Number(error?.[field]))) err[field] = Number(error[field]);
  }
  return err;
}

function mirrorSourceChangedDuringCopyError() {
  return Object.assign(new Error('微信数据库文件在复制期间发生变化；本次临时副本已丢弃，程序会自动重新捕获该版本。'), {
    status: 409,
    code: 'wxdb_source_changed_during_mirror_copy',
    public_code: 'wxdb_source_changed_during_mirror_copy',
  });
}

function mirrorCopyRetryDelayMs(attempt) {
  const index = Math.max(0, Math.min(WXDB_MIRROR_RETRY_DELAYS_MS.length - 1, Math.floor(Number(attempt || 0) || 0)));
  return WXDB_MIRROR_RETRY_DELAYS_MS[index];
}

function normalizeMirrorCopyAttempts(value = WXDB_MIRROR_STABLE_COPY_ATTEMPTS) {
  const attempts = Math.trunc(Number(value || 0) || 0);
  return Math.max(1, Math.min(WXDB_MIRROR_STABLE_COPY_ATTEMPTS, attempts || WXDB_MIRROR_STABLE_COPY_ATTEMPTS));
}

function mirrorCopyRetryWaitBudgetMs(attempts = WXDB_MIRROR_STABLE_COPY_ATTEMPTS) {
  const totalAttempts = normalizeMirrorCopyAttempts(attempts);
  return Array.from({ length: totalAttempts - 1 }, (_, attempt) => mirrorCopyRetryDelayMs(attempt))
    .reduce((sum, delayMs) => sum + delayMs, 0);
}

function mirrorCopyRetryExhaustedError(error = null, attempts = WXDB_MIRROR_STABLE_COPY_ATTEMPTS) {
  const totalAttempts = normalizeMirrorCopyAttempts(attempts);
  const waitMs = mirrorCopyRetryWaitBudgetMs(totalAttempts);
  const publicCode = mirrorCopyPublicErrorCode(error);
  const diagnosticErrno = mirrorCopyDiagnosticErrno(error);
  const err = Object.assign(new Error(`某个微信数据库或 WAL 文件集持续写入，程序已自动尝试 ${totalAttempts} 次（等待窗口约 ${(waitMs / 1000).toFixed(1)} 秒）仍未能捕获完整副本；本次临时数据已丢弃，旧副本未覆盖。请保持微信运行并稍后再试。`), error || {}, {
    status: Number(error?.status || 0) || 409,
    code: publicCode,
    public_code: publicCode,
    retry_attempts: totalAttempts,
    retry_wait_ms: waitMs,
    cause: error || undefined,
  });
  if (diagnosticErrno) {
    err.wxdb_diagnostics = {
      ...(error?.wxdb_diagnostics && typeof error.wxdb_diagnostics === 'object' ? error.wxdb_diagnostics : {}),
      source_copy_errno: diagnosticErrno,
    };
  }
  return err;
}

async function sleepForMirrorCopyRetry(attempt, { signal = null, onProgress = null, phase = 'mirror_copy_retry_wait', attempts = WXDB_MIRROR_STABLE_COPY_ATTEMPTS } = {}) {
  throwIfDiscoveryAborted(signal);
  const totalAttempts = normalizeMirrorCopyAttempts(attempts);
  const delayMs = mirrorCopyRetryDelayMs(attempt);
  const waitLabel = delayMs >= 1000
    ? `${(delayMs / 1000).toFixed(delayMs % 1000 ? 1 : 0)} 秒`
    : `${delayMs} 毫秒`;
  notifyMirrorProgress(onProgress, {
    phase,
    label: '检查本地数据 · 等待微信写入稳定',
    detail: `源数据库仍在变化；${waitLabel}后自动进行第 ${attempt + 2}/${totalAttempts} 次一致性捕获`,
    retry_index: attempt + 1,
    next_attempt: attempt + 2,
    total_attempts: totalAttempts,
    delay_ms: delayMs,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      reject(signal?.reason instanceof Error ? signal.reason : discoveryAbortError());
    };
    function done() {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  throwIfDiscoveryAborted(signal);
}

function processMayBeAlive(pid) {
  const value = Number(pid || 0);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

function selfProcessStartIdentityFallback() {
  return `epoch-ms:${WXDB_MIRROR_SELF_PROCESS_START_EPOCH_MS}`;
}

function processStartIdentityEpochMs(identity = '') {
  const clean = String(identity || '').trim();
  const epochMatch = /^epoch-ms:(\d{10,})$/.exec(clean);
  if (epochMatch) return Number(epochMatch[1]);
  const windowsMatch = /^win:(\d{10,})$/.exec(clean);
  if (!windowsMatch) return NaN;
  try {
    const unixEpochTicks = 621355968000000000n;
    const ticks = BigInt(windowsMatch[1]);
    if (ticks <= unixEpochTicks) return NaN;
    return Number((ticks - unixEpochTicks) / 10_000n);
  } catch {
    return NaN;
  }
}

function processStartIdentityMatches(expected, actual) {
  const cleanExpected = String(expected || '').trim();
  const cleanActual = String(actual || '').trim();
  if (!cleanExpected || !cleanActual) return false;
  if (cleanExpected === cleanActual) return true;
  const expectedEpochMs = processStartIdentityEpochMs(cleanExpected);
  const actualEpochMs = processStartIdentityEpochMs(cleanActual);
  return Number.isFinite(expectedEpochMs)
    && Number.isFinite(actualEpochMs)
    && Math.abs(expectedEpochMs - actualEpochMs) <= PROCESS_START_IDENTITY_EPOCH_TOLERANCE_MS;
}

export async function processStartIdentity(pid) {
  const value = Number(pid || 0);
  if (!Number.isInteger(value) || value <= 0) return '';
  if (value === process.pid && WXDB_MIRROR_SELF_PROCESS_START_ID) return WXDB_MIRROR_SELF_PROCESS_START_ID;
  let identity = '';
  try {
    if (process.platform === 'win32') {
      if (WINDOWS_POWERSHELL_EXE) {
        const output = await execFileText(WINDOWS_POWERSHELL_EXE, [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$p = Get-Process -Id ${value} -ErrorAction Stop; [Console]::Write($p.StartTime.ToUniversalTime().Ticks)`,
        ]);
        const ticks = String(output || '').trim();
        if (/^\d{10,}$/.test(ticks)) identity = `win:${ticks}`;
      }
    } else if (process.platform === 'linux') {
      const [stat, bootId] = await Promise.all([
        fsp.readFile(`/proc/${value}/stat`, 'utf-8'),
        fsp.readFile('/proc/sys/kernel/random/boot_id', 'utf-8').catch(() => ''),
      ]);
      const close = stat.lastIndexOf(')');
      const fields = close >= 0 ? stat.slice(close + 2).trim().split(/\s+/) : [];
      const startTicks = String(fields[19] || '').trim();
      if (/^\d+$/.test(startTicks)) identity = `linux:${String(bootId || '').trim()}:${startTicks}`;
    } else {
      const output = await execFileText('/bin/ps', ['-o', 'lstart=', '-p', String(value)]);
      const started = String(output || '').trim().replace(/\s+/g, ' ');
      if (started) identity = `${process.platform}:${started}`;
    }
  } catch {}
  if (value === process.pid && !identity && process.platform === 'win32') identity = selfProcessStartIdentityFallback();
  if (value === process.pid && identity) WXDB_MIRROR_SELF_PROCESS_START_ID = identity;
  return identity;
}

export async function processOwnerState(owner = null, {
  processAlive = processMayBeAlive,
  processStartIdentityFn = processStartIdentity,
} = {}) {
  const pid = Number(owner?.pid || 0);
  if (!Number.isInteger(pid) || pid <= 0) return 'invalid';
  let alive = false;
  try {
    alive = processAlive(pid);
  } catch {
    return 'unknown';
  }
  if (!alive) return 'dead';
  const expected = String(owner?.process_start_id || '').trim();
  if (!expected) return 'unknown';
  let actual = '';
  try {
    actual = await processStartIdentityFn(pid);
  } catch {
    return 'unknown';
  }
  if (!actual) return 'unknown';
  return processStartIdentityMatches(expected, actual) ? 'same' : 'different';
}

async function wxDbMirrorProcessOwnerState(owner = null, dependencies = {}) {
  return processOwnerState(owner, dependencies);
}

async function wxDbMirrorProcessOwnerMatches(owner = null, _observed = null, dependencies = {}) {
  const state = await wxDbMirrorProcessOwnerState(owner, dependencies);
  return state === 'same' || state === 'unknown';
}

async function waitForMirrorProcessLockRetry(signal, delayMs = 180) {
  throwIfDiscoveryAborted(signal);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(done, Math.max(1, Number(delayMs || 0) || 180));
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      reject(signal?.reason instanceof Error ? signal.reason : discoveryAbortError());
    };
    function done() {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function wxDbMirrorProcessLockTimeoutError() {
  return Object.assign(new Error('本地工作数据仍被另一个任务或 wx-summary 进程占用；等待超过 10 分钟，已停止本次操作。请等待当前任务完成，或关闭重复运行的服务后重试。'), {
    status: 503,
    code: 'wxdb_mirror_process_lock_timeout',
    public_code: 'wxdb_mirror_process_lock_timeout',
  });
}

function wxDbMirrorLockDeadlineAt(deadlineAt = 0, now = Date.now()) {
  const maximum = now + WXDB_MIRROR_PROCESS_LOCK_WAIT_MS;
  const requested = Number(deadlineAt || 0);
  if (!Number.isFinite(requested) || requested <= 0) return maximum;
  return Math.min(requested, maximum);
}

async function readWxDbMirrorProcessLock(lockFile = WXDB_MIRROR_PROCESS_LOCK) {
  const st = await fsp.lstat(lockFile).catch(e => {
    if (e?.code === 'ENOENT') return null;
    throw e;
  });
  if (!st) return null;
  if (!st.isFile() || st.isSymbolicLink()) {
    throw Object.assign(new Error('本地工作数据跨进程锁不是普通文件，已拒绝继续操作。'), {
      status: 403,
      code: 'wxdb_mirror_process_lock_unsafe',
      public_code: 'wxdb_mirror_process_lock_unsafe',
    });
  }
  const raw = await fsp.readFile(lockFile, 'utf-8').catch(e => {
    if (e?.code === 'ENOENT') return '';
    throw e;
  });
  let owner = null;
  try {
    const parsed = JSON.parse(raw);
    owner = plainObject(parsed) ? parsed : null;
  } catch {}
  return { st, raw, owner };
}

function wxDbMirrorProcessLockIsFresh(observed, now = Date.now()) {
  if (!observed?.st) return false;
  const acquiredAt = Number(observed.owner?.acquired_at || 0) || 0;
  const heartbeatAt = Math.max(Number(observed.st.mtimeMs || 0) || 0, acquiredAt);
  const ageMs = Number(now || 0) - heartbeatAt;
  return ageMs < WXDB_MIRROR_PROCESS_LOCK_STALE_GRACE_MS;
}

function wxDbMirrorProcessLockBlockedError(observed, ownerState = 'unknown', now = Date.now()) {
  const pid = Number(observed?.owner?.pid || 0) || 0;
  const acquiredAt = Number(observed?.owner?.acquired_at || 0) || 0;
  const heartbeatAt = Math.max(Number(observed?.st?.mtimeMs || 0) || 0, acquiredAt);
  const ageMs = heartbeatAt ? Math.max(0, Number(now || Date.now()) - heartbeatAt) : 0;
  const ownerUnknown = ownerState === 'unknown';
  const err = new Error(ownerUnknown
    ? `本地工作数据锁的心跳已停止，但无法确认持有进程${pid ? `（PID ${pid}）` : ''}是否仍是原进程；为避免两个服务同时改写项目副本，本次操作已立即停止。请关闭重复服务，或确认该进程结束后重试。`
    : `持有本地工作数据锁的进程${pid ? `（PID ${pid}）` : ''}仍在运行，但锁心跳已停止；本次操作已立即停止。请等待该进程恢复，或确认并结束无响应的重复服务后重试。`);
  err.status = 423;
  err.code = ownerUnknown
    ? 'wxdb_mirror_process_lock_owner_unknown'
    : 'wxdb_mirror_process_lock_owner_unresponsive';
  err.public_code = err.code;
  err.lock_owner_pid = pid;
  err.lock_heartbeat_age_ms = ageMs;
  return err;
}

function wxDbMirrorProcessLockIncompleteError(lockFile = WXDB_MIRROR_PROCESS_LOCK) {
  const relativeLock = `data/${path.basename(lockFile)}`;
  return Object.assign(new Error(`本地工作数据跨进程锁 ${relativeLock} 缺少可信的 PID 或 token；为避免并发改写，程序不会按文件年龄自动删除它。请先完全退出 wx-summary，确认任务管理器中没有该服务，再删除这个锁文件后重新启动；不要在服务运行时删除。`), {
    status: 423,
    code: 'wxdb_mirror_process_lock_owner_incomplete',
    public_code: 'wxdb_mirror_process_lock_owner_incomplete',
  });
}

async function removeStaleWxDbMirrorProcessLock(observed, lockFile = WXDB_MIRROR_PROCESS_LOCK) {
  if (!observed?.st) return false;
  if (wxDbMirrorProcessLockIsFresh(observed)) return false;
  const ownerComplete = atomicProcessLockOwnerIsComplete(observed.owner);
  const legacyDeadReclaimable = atomicProcessLockOwnerIsLegacyDeadReclaimable(observed.owner);
  if (!ownerComplete && !legacyDeadReclaimable) throw wxDbMirrorProcessLockIncompleteError(lockFile);
  const ownerState = await wxDbMirrorProcessOwnerState(observed.owner);
  if (ownerState === 'same' || ownerState === 'unknown') {
    throw wxDbMirrorProcessLockBlockedError(observed, ownerState);
  }
  return reclaimAtomicProcessLockFile(lockFile, observed, {
    ownerState,
    readLock: () => readWxDbMirrorProcessLock(lockFile),
    allowLegacyDeadOwner: !ownerComplete && ownerState === 'dead',
  });
}

function wxDbMirrorProcessLockPath(lockKey = WXDB_MIRROR_INDEX_LOCK_KEY) {
  if (lockKey === WXDB_MIRROR_INDEX_LOCK_KEY) return WXDB_MIRROR_PROCESS_LOCK;
  const segment = safeMirrorSegment(lockKey || 'default');
  return path.join(DATA_DIR, `.wxdb-mirror.${segment}.lock`);
}

async function acquireWxDbMirrorProcessLock({ signal = null, deadlineAt = 0, lockKey = WXDB_MIRROR_INDEX_LOCK_KEY } = {}) {
  const lockDeadlineAt = wxDbMirrorLockDeadlineAt(deadlineAt);
  const lockFile = wxDbMirrorProcessLockPath(lockKey);
  throwIfDiscoveryAborted(signal);
  await ensureDir(DATA_DIR);
  const token = crypto.randomBytes(16).toString('hex');
  const processStartId = await processStartIdentity(process.pid);
  while (true) {
    throwIfDiscoveryAborted(signal);
    if (Date.now() >= lockDeadlineAt) throw wxDbMirrorProcessLockTimeoutError();
    let acquisition = null;
    let handle = null;
    let heartbeat = null;
    try {
      acquisition = await publishAtomicProcessLock({
        lockPath: lockFile,
        mode: 0o600,
        owner: {
          version: 1,
          pid: process.pid,
          process_start_id: processStartId,
          token,
          acquired_at: Date.now(),
          lock_key: lockKey,
        },
      });
      handle = acquisition.handle;
      heartbeat = setInterval(() => {
        const now = new Date();
        void handle?.utimes(now, now).catch(() => {});
      }, WXDB_MIRROR_PROCESS_LOCK_HEARTBEAT_MS);
      heartbeat.unref?.();
      return async () => {
        clearInterval(heartbeat);
        heartbeat = null;
        await handle?.close().catch(() => {});
        handle = null;
        await releaseAtomicProcessLockFile(lockFile, token, {
          readLock: () => readWxDbMirrorProcessLock(lockFile),
        });
      };
    } catch (e) {
      clearInterval(heartbeat);
      await handle?.close().catch(() => {});
      if (acquisition) {
        await releaseAtomicProcessLockFile(lockFile, token, {
          readLock: () => readWxDbMirrorProcessLock(lockFile),
        }).catch(() => {});
      }
      if (e?.code !== 'EEXIST') {
        throw e;
      }
      const observed = await readWxDbMirrorProcessLock(lockFile);
      if (await removeStaleWxDbMirrorProcessLock(observed, lockFile)) continue;
      const remainingMs = lockDeadlineAt - Date.now();
      if (remainingMs <= 0) throw wxDbMirrorProcessLockTimeoutError();
      const retryDelayMs = 160 + Math.floor(Math.random() * 120);
      await waitForMirrorProcessLockRetry(signal, Math.min(retryDelayMs, remainingMs));
    }
  }
}

async function runWithWxDbMirrorProcessLock(action, { signal = null, deadlineAt = 0, lockKey = WXDB_MIRROR_INDEX_LOCK_KEY } = {}) {
  const lockDeadlineAt = wxDbMirrorLockDeadlineAt(deadlineAt);
  const release = await acquireWxDbMirrorProcessLock({ signal, deadlineAt: lockDeadlineAt, lockKey });
  try {
    throwIfDiscoveryAborted(signal);
    if (Date.now() >= lockDeadlineAt) throw wxDbMirrorProcessLockTimeoutError();
    return await action();
  } finally {
    await release();
  }
}

export async function withWxDbMirrorReadLock(accountId, action, { signal = null } = {}) {
  return runWithWxDbMirrorLock(accountId, action, { signal });
}

async function runWithWxDbMirrorLock(accountId, action, { signal = null, deadlineAt = 0 } = {}) {
  const key = accountId === WXDB_MIRROR_INDEX_LOCK_KEY
    ? WXDB_MIRROR_INDEX_LOCK_KEY
    : safeMirrorSegment(accountId || 'default');
  const held = WXDB_MIRROR_LOCK_CONTEXT.getStore();
  if (held?.has(key)) return action();
  if (key !== WXDB_MIRROR_INDEX_LOCK_KEY && held?.has(WXDB_MIRROR_INDEX_LOCK_KEY)) {
    throw Object.assign(new Error('本地工作数据锁顺序错误：共享索引锁内不能再获取账号副本锁。'), {
      status: 500,
      code: 'wxdb_mirror_lock_order_violation',
      public_code: 'wxdb_mirror_lock_order_violation',
    });
  }
  const inheritedOptions = WXDB_MIRROR_LOCK_OPTIONS_CONTEXT.getStore();
  const effectiveSignal = signal || inheritedOptions?.signal || null;
  const lockDeadlineAt = wxDbMirrorLockDeadlineAt(deadlineAt || inheritedOptions?.deadlineAt || 0);
  throwIfDiscoveryAborted(effectiveSignal);
  if (Date.now() >= lockDeadlineAt) throw wxDbMirrorProcessLockTimeoutError();
  let state = WXDB_MIRROR_IMPORT_LOCKS.get(key);
  if (!state) {
    state = { active: false, queue: [] };
    WXDB_MIRROR_IMPORT_LOCKS.set(key, state);
  }
  if (state.queue.length >= WXDB_MIRROR_LOCK_QUEUE_LIMIT) {
    throw Object.assign(new Error('本地工作数据任务过多，请等待当前刷新完成后重试。'), {
      status: 429,
      code: 'wxdb_mirror_queue_full',
      public_code: 'wxdb_mirror_queue_full',
    });
  }
  return new Promise((resolve, reject) => {
    const entry = {
      action,
      deadlineAt: lockDeadlineAt,
      held,
      onAbort: null,
      onTimeout: null,
      reject,
      resolve,
      signal: effectiveSignal,
      timeout: null,
    };
    const clearEntryWaiters = current => {
      clearTimeout(current.timeout);
      current.timeout = null;
      current.signal?.removeEventListener?.('abort', current.onAbort);
    };
    const drain = () => {
      if (state.active) return;
      let next = state.queue.shift();
      while (next && (next.signal?.aborted || Date.now() >= next.deadlineAt)) {
        clearEntryWaiters(next);
        next.reject(next.signal?.aborted
          ? (next.signal.reason instanceof Error ? next.signal.reason : discoveryAbortError())
          : wxDbMirrorProcessLockTimeoutError());
        next = state.queue.shift();
      }
      if (!next) {
        if (!state.active && WXDB_MIRROR_IMPORT_LOCKS.get(key) === state) WXDB_MIRROR_IMPORT_LOCKS.delete(key);
        return;
      }
      state.active = true;
      clearEntryWaiters(next);
      const nextHeld = new Set(next.held || []);
      nextHeld.add(key);
      const runAction = () => WXDB_MIRROR_LOCK_CONTEXT.run(nextHeld, () => (
        WXDB_MIRROR_LOCK_OPTIONS_CONTEXT.run({
          signal: next.signal,
          deadlineAt: next.deadlineAt,
        }, next.action)
      ));
      Promise.resolve()
        .then(() => runWithWxDbMirrorProcessLock(runAction, {
          signal: next.signal,
          deadlineAt: next.deadlineAt,
          lockKey: key,
        }))
        .then(next.resolve, next.reject)
        .finally(() => {
          state.active = false;
          drain();
        });
    };
    entry.onAbort = () => {
      const index = state.queue.indexOf(entry);
      if (index < 0) return;
      state.queue.splice(index, 1);
      clearEntryWaiters(entry);
      reject(effectiveSignal?.reason instanceof Error ? effectiveSignal.reason : discoveryAbortError());
      if (!state.active) drain();
    };
    entry.onTimeout = () => {
      const index = state.queue.indexOf(entry);
      if (index < 0) return;
      state.queue.splice(index, 1);
      clearEntryWaiters(entry);
      reject(wxDbMirrorProcessLockTimeoutError());
      if (!state.active) drain();
    };
    state.queue.push(entry);
    effectiveSignal?.addEventListener?.('abort', entry.onAbort, { once: true });
    entry.timeout = setTimeout(entry.onTimeout, Math.max(1, lockDeadlineAt - Date.now()));
    if (effectiveSignal?.aborted) {
      entry.onAbort();
      return;
    }
    drain();
  });
}

async function runWithWxDbMirrorIndexWriteLock(action, { signal = null, deadlineAt = 0 } = {}) {
  const held = WXDB_MIRROR_LOCK_CONTEXT.getStore();
  const inheritedOptions = WXDB_MIRROR_LOCK_OPTIONS_CONTEXT.getStore();
  const effectiveSignal = signal || inheritedOptions?.signal || null;
  const effectiveDeadlineAt = deadlineAt || inheritedOptions?.deadlineAt || 0;
  if (!held?.has(WXDB_MIRROR_INDEX_LOCK_KEY)) {
    return runWithWxDbMirrorLock(
      WXDB_MIRROR_INDEX_LOCK_KEY,
      () => runWithWxDbMirrorIndexWriteLock(action, {
        signal: effectiveSignal,
        deadlineAt: effectiveDeadlineAt,
      }),
      {
        signal: effectiveSignal,
        deadlineAt: effectiveDeadlineAt,
      },
    );
  }
  if (WXDB_MIRROR_INDEX_WRITE_CONTEXT.getStore()) return action();
  return WXDB_MIRROR_INDEX_WRITE_CONTEXT.run(true, action);
}

async function discoverSourceWxAccountsResult({ signal = null } = {}) {
  throwIfDiscoveryAborted(signal);
  try {
    const dataRootDiscovery = await discoverDataRootsResult({ signal });
    const sourceDiscovery = await sourceWxAccountDiscoveryFromDataRoots(dataRootDiscovery.roots, { signal });
    return {
      accounts: sourceDiscovery.accounts,
      unreadable: [...dataRootDiscovery.unreadable, ...sourceDiscovery.unreadable],
    };
  } catch (error) {
    if (isDiscoveryAbort(error, signal) || error?.code !== 'wxdb_source_directory_unreadable') throw error;
    return {
      accounts: [],
      unreadable: [sourceDiscoveryIssue(error, { scope: 'all_roots' })],
    };
  }
}

async function sourceWxAccountsFromDataRoots(dataRoots, { signal = null } = {}) {
  const result = await sourceWxAccountDiscoveryFromDataRoots(dataRoots, { signal });
  if (!result.accounts.length && result.unreadable.length) {
    throw sourceDiscoveryAggregateError(result.unreadable, '微信账号目录均不可读');
  }
  return result.accounts;
}

async function sourceWxAccountDiscoveryFromDataRoots(dataRoots, { signal = null } = {}) {
  const accounts = [];
  const unreadable = [];
  for (const root of dataRoots) {
    throwIfDiscoveryAborted(signal);
    let xwechatFiles;
    let accountDirs;
    try {
      xwechatFiles = path.join(root, 'xwechat_files');
      let st = await statWxDbSourceDir(xwechatFiles, { signal, label: '微信账号根目录' });
      if (!st?.isDirectory()) {
        xwechatFiles = root;
        st = await statWxDbSourceDir(xwechatFiles, { signal, label: '微信账号根目录' });
        if (!st?.isDirectory()) continue;
      }
      accountDirs = await readWxDbDirEntries(xwechatFiles, { signal, label: '微信账号根目录' });
    } catch (error) {
      if (!collectSourceDiscoveryError(unreadable, error, signal, {
        scope: 'root',
        data_root: root,
        xwechat_files: xwechatFiles,
      })) throw error;
      continue;
    }
    for (const entry of accountDirs) {
      throwIfDiscoveryAborted(signal);
      if (!entry.isDirectory() || entry.name.toLowerCase() === 'all_users') continue;
      const accountRoot = path.join(xwechatFiles, entry.name);
      const dbStorage = path.join(accountRoot, 'db_storage');
      try {
        const dbStat = await statWxDbSourceDir(dbStorage, { signal, label: `微信账号数据库目录 ${entry.name}` });
        if (!dbStat?.isDirectory()) continue;
        const summary = await sourceAccountDirectorySummary(dbStorage, { dbStat, signal });
        const dbStorageRealpath = await realpathWxDbSourceDir(dbStorage, {
          signal,
          label: `微信账号数据库目录 ${entry.name}`,
        });
        const lastWriteTime = summary.last_write_time || '';
        const wxid = accountNameToWxid(entry.name);
        accounts.push({
          account_id: accountOpaqueId(dbStorageRealpath),
          id: entry.name,
          legacy_id: entry.name,
          wxid,
          display_name: accountNameToDisplay(entry.name),
          account_aliases: [...new Set([entry.name, wxid].filter(Boolean))],
          account_root: accountRoot,
          db_storage: dbStorage,
          db_storage_realpath: dbStorageRealpath,
          last_write_time: lastWriteTime,
          summary,
        });
      } catch (error) {
        if (!collectSourceDiscoveryError(unreadable, error, signal, {
          scope: 'account',
          data_root: root,
          xwechat_files: xwechatFiles,
          account_name: entry.name,
          account_root: accountRoot,
          db_storage: dbStorage,
          account_id: unreadableSourceAccountId(dbStorage),
        })) throw error;
      }
    }
  }
  const uniqueAccounts = dedupeSourceAccountsByStorage(accounts);
  uniqueAccounts.sort(compareAccountsByLastWriteDesc);
  return { accounts: uniqueAccounts, unreadable };
}

function dedupeSourceAccountsByStorage(accounts = []) {
  const byStorage = new Map();
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const storage = String(account?.db_storage_realpath || account?.db_storage || '').trim();
    const key = storage ? platformPathIdentity(path.resolve(storage)) : String(account?.account_id || '').trim();
    if (!key) continue;
    const previous = byStorage.get(key);
    if (!previous) {
      byStorage.set(key, {
        ...account,
        account_aliases: [...new Set([
          ...(Array.isArray(account?.account_aliases) ? account.account_aliases : []),
          account?.account_id,
          account?.id,
          account?.legacy_id,
          account?.wxid,
        ].map(value => String(value || '').trim()).filter(Boolean))],
      });
      continue;
    }
    const preferred = compareAccountsByLastWriteDesc(previous, account) <= 0 ? previous : account;
    byStorage.set(key, {
      ...previous,
      ...preferred,
      account_aliases: [...new Set([
        ...(Array.isArray(previous.account_aliases) ? previous.account_aliases : []),
        ...(Array.isArray(account?.account_aliases) ? account.account_aliases : []),
        previous.account_id,
        previous.id,
        previous.legacy_id,
        previous.wxid,
        account?.account_id,
        account?.id,
        account?.legacy_id,
        account?.wxid,
      ].map(value => String(value || '').trim()).filter(Boolean))],
    });
  }
  return [...byStorage.values()];
}

async function sourceAccountDirectorySummary(dbStorage, { dbStat = null, signal = null } = {}) {
  const summary = await summarizeDbStorage(dbStorage, { signal });
  const fallbackLastWriteTime = dbStat?.mtime?.toISOString?.() || '';
  return {
    ...summary,
    last_write_time: summary.last_write_time || fallbackLastWriteTime,
    db_storage: dbStorage,
    discovery_only: true,
    metadata_only: true,
    account_dir_only: false,
  };
}

async function statWxDbSourceDir(dir, { signal = null, label = '微信数据库目录' } = {}) {
  throwIfDiscoveryAborted(signal);
  try {
    return await fsp.stat(dir);
  } catch (e) {
    if (isDiscoveryAbort(e, signal)) throw e;
    if (e?.code === 'ENOENT') return null;
    throw Object.assign(new Error(`${label}状态读取失败，已拒绝把不可读目录当作空目录：${e?.message || String(e)}`), {
      status: 409,
      code: 'wxdb_source_directory_unreadable',
      public_code: 'wxdb_source_directory_unreadable',
      cause: e,
    });
  }
}

async function realpathWxDbSourceDir(dir, { signal = null, label = '微信数据库目录' } = {}) {
  throwIfDiscoveryAborted(signal);
  try {
    return await fsp.realpath(dir);
  } catch (e) {
    if (isDiscoveryAbort(e, signal)) throw e;
    throw Object.assign(new Error(`${label}物理路径解析失败，已拒绝按词法路径生成新的账号身份：${e?.message || String(e)}`), {
      status: 409,
      code: 'wxdb_source_directory_unreadable',
      public_code: 'wxdb_source_directory_unreadable',
      cause: e,
    });
  }
}

function sourceDirectoryUnreadableError(label = '微信数据目录', cause = null) {
  const detail = String(cause?.message || cause || '未知错误').replace(/\s+/g, ' ').trim();
  return Object.assign(new Error(`${label}不可读，已拒绝把权限错误当作空目录：${detail}`), {
    status: 409,
    code: 'wxdb_source_directory_unreadable',
    public_code: 'wxdb_source_directory_unreadable',
    cause,
  });
}

function sourceDiscoveryIssue(error = null, context = {}) {
  return {
    scope: String(context?.scope || 'root').trim() || 'root',
    data_root: String(context?.data_root || '').trim(),
    xwechat_files: String(context?.xwechat_files || '').trim(),
    account_name: String(context?.account_name || '').trim(),
    account_root: String(context?.account_root || '').trim(),
    db_storage: String(context?.db_storage || '').trim(),
    account_id: String(context?.account_id || '').trim(),
    configuration_file: String(context?.configuration_file || '').trim(),
    error,
  };
}

function unreadableSourceAccountsFromDiscovery(unreadable = []) {
  const accounts = [];
  const seen = new Set();
  for (const issue of Array.isArray(unreadable) ? unreadable : []) {
    if (issue?.scope !== 'account') continue;
    const accountId = String(issue.account_id || '').trim();
    const accountName = String(issue.account_name || '').trim();
    const dbStorage = String(issue.db_storage || '').trim();
    if (!accountId || !accountName || !dbStorage || seen.has(accountId)) continue;
    seen.add(accountId);
    const wxid = accountNameToWxid(accountName);
    accounts.push({
      account_id: accountId,
      id: accountName,
      legacy_id: accountName,
      wxid,
      display_name: accountNameToDisplay(accountName),
      account_aliases: [...new Set([accountId, accountName, wxid].filter(Boolean))],
      account_root: String(issue.account_root || '').trim(),
      db_storage: dbStorage,
      last_write_time: '',
      summary: null,
      source: 'source-unreadable',
      source_available: false,
      source_status: 'unreadable',
      source_status_label: mirrorSourceStatusLabel('unreadable'),
    });
  }
  return accounts;
}

function collectSourceDiscoveryError(errors = [], error = null, signal = null, context = {}) {
  if (isDiscoveryAbort(error, signal)) throw error;
  if (error?.code !== 'wxdb_source_directory_unreadable') return false;
  errors.push(sourceDiscoveryIssue(error, context));
  return true;
}

function sourceDiscoveryAggregateError(errors = [], fallback = '微信数据目录不可读') {
  const items = (Array.isArray(errors) ? errors : [])
    .map(item => item?.error || item)
    .filter(Boolean);
  if (items.length === 1) return items[0];
  const error = sourceDirectoryUnreadableError(`${fallback}（${items.length} 处）`, items[0]);
  error.discovery_error_count = items.length;
  return error;
}

async function assertMirrorSourceFile(sourceRootReal, sourceFile) {
  let st = null;
  try {
    st = await fsp.lstat(sourceFile);
  } catch (e) {
    const missing = e?.code === 'ENOENT';
    throw Object.assign(new Error(missing
      ? '源数据库文件在校验期间消失，已拒绝用不完整快照更新本地工作数据。'
      : `源数据库文件状态读取失败，已拒绝刷新本地工作数据：${e?.message || String(e)}`), {
      status: missing ? 409 : 403,
      code: missing ? 'wxdb_source_snapshot_unstable' : 'wxdb_source_file_unreadable',
      public_code: missing ? 'wxdb_source_snapshot_unstable' : 'wxdb_source_file_unreadable',
      cause: e,
    });
  }
  if (!st.isFile() || st.isSymbolicLink()) {
    throw Object.assign(new Error('微信数据库源文件必须是普通文件，不能是符号链接。'), { status: 403, code: 'wxdb_source_not_regular_file', public_code: 'wxdb_source_not_regular_file' });
  }
  const real = await fsp.realpath(sourceFile).catch(() => '');
  if (!sourceRootReal || !real || !isInside(sourceRootReal, real)) {
    throw Object.assign(new Error('微信数据库源文件真实路径不在账号 db_storage 内，已拒绝刷新。'), { status: 403, code: 'wxdb_source_outside_account', public_code: 'wxdb_source_outside_account' });
  }
}

async function optionalMirrorSourceSidecarExists(sourceRootReal, sourceFile, { signal = null } = {}) {
  throwIfDiscoveryAborted(signal);
  const st = await statWxDbSourceSidecar(sourceFile, { signal });
  if (!st) return false;
  await assertMirrorSourceFile(sourceRootReal, sourceFile);
  return true;
}

async function readMirrorIndex() {
  try {
    const index = await readJson(WXDB_MIRROR_INDEX, { accounts: {} }, { strict: true });
    if (!plainObject(index)) {
      throw Object.assign(new Error('wxdb mirror index must contain a JSON object'), { code: 'wxdb_mirror_index_invalid_shape' });
    }
    if (Object.hasOwn(index, 'accounts') && !plainObject(index.accounts)) {
      throw Object.assign(new Error('wxdb mirror index accounts must contain a JSON object'), { code: 'wxdb_mirror_index_invalid_shape' });
    }
    assertMirrorIndexAccountDirectoryBindings(index.accounts || {});
    WXDB_MIRROR_INDEX_INVALID_INFO = null;
    return { ...index, accounts: plainObject(index.accounts) ? index.accounts : {} };
  } catch (e) {
    if (e?.code === 'ENOENT') {
      WXDB_MIRROR_INDEX_INVALID_INFO = null;
      return { accounts: {} };
    }
    const recoverable = e instanceof SyntaxError || ['wxdb_mirror_index_invalid_shape', 'wxdb_mirror_index_invalid_semantics'].includes(e?.code);
    if (!recoverable) throw e;
    if (!WXDB_MIRROR_INDEX_WRITE_CONTEXT.getStore()) {
      return runWithWxDbMirrorIndexWriteLock(() => readMirrorIndex());
    }
    const backup = await backupInvalidMirrorIndex();
    WXDB_MIRROR_INDEX_INVALID_INFO = mirrorIndexInvalidPublicInfo(e, backup);
    return { accounts: {}, mirror_index: WXDB_MIRROR_INDEX_INVALID_INFO };
  }
}

function assertMirrorIndexAccountDirectoryBindings(accounts = {}) {
  const usedSegments = new Set();
  for (const [rawAccountId, item] of Object.entries(accounts)) {
    const accountId = String(rawAccountId || '').trim().toLowerCase();
    const recordAccountId = String(item?.account_id || '').trim().toLowerCase();
    const mirrorSegment = String(item?.mirror_segment || '').trim().toLowerCase();
    const validAccountId = /^wxacc_[a-f0-9]{16}$/.test(accountId);
    if (!plainObject(item) || !validAccountId || recordAccountId !== accountId || mirrorSegment !== accountId || usedSegments.has(mirrorSegment)) {
      throw Object.assign(new Error('wxdb mirror index account_id and mirror_segment must form a unique one-to-one directory binding'), {
        code: 'wxdb_mirror_index_invalid_semantics',
      });
    }
    usedSegments.add(mirrorSegment);
  }
}

function mirrorIndexBackupTimestamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function backupInvalidMirrorIndex(file = WXDB_MIRROR_INDEX) {
  const base = file.replace(/\.json$/i, `.invalid.${mirrorIndexBackupTimestamp(new Date())}`);
  for (let i = 1; i <= 20; i++) {
    const backup = i === 1 ? `${base}.json` : `${base}.${i}.json`;
    const exists = await fsp.lstat(backup).then(() => true).catch(e => {
      if (e?.code === 'ENOENT') return false;
      throw e;
    });
    if (exists) continue;
    await renameAtomicWithRetry(file, backup).catch(e => {
      if (e?.code === 'ENOENT') return;
      throw e;
    });
    return backup;
  }
  return '';
}

function mirrorIndexInvalidPublicInfo(error = null, backupPath = '') {
  const backupRelativePath = backupPath
    ? path.relative(DATA_DIR, backupPath).split(path.sep).join('/')
    : '';
  return {
    status: 'invalid_rebuilding',
    backup_relative_path: backupRelativePath ? `data/${backupRelativePath}` : '',
    error: String(error?.message || error || 'mirror index invalid').slice(0, 240),
  };
}

function safeMirrorSegment(value = '') {
  const text = String(value || '').trim();
  if (/^wxacc_[a-f0-9]{16}$/i.test(text)) return text.toLowerCase();
  return `wxacc_${crypto.createHash('sha256').update(text || crypto.randomUUID()).digest('hex').slice(0, 16)}`;
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export async function summarizeDbStorage(dbStorage, { signal = null } = {}) {
  throwIfDiscoveryAborted(signal);
  const categories = [];
  const generationFiles = [];
  let totalBytes = 0;
  let last = 0;
  const dirs = await readWxDbDirEntries(dbStorage, { signal, label: '微信数据库摘要根目录' });
  for (const dir of dirs) {
    throwIfDiscoveryAborted(signal);
    if (!dir.isDirectory()) continue;
    const full = path.join(dbStorage, dir.name);
    const files = (await readWxDbDirEntries(full, { signal, label: `微信数据库摘要分类目录 ${dir.name}` }))
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.db'));
    let categoryBytes = 0;
    let categoryLast = 0;
    for (const file of files) {
      throwIfDiscoveryAborted(signal);
      const dbPath = path.join(full, file.name);
      const st = await statWxDbSourceFile(dbPath, { signal });
      if (!st?.isFile() || st.isSymbolicLink()) continue;
      categoryBytes += st.size;
      categoryLast = Math.max(categoryLast, st.mtimeMs);
      generationFiles.push({
        relative: normalizeMirrorRelative(path.relative(dbStorage, dbPath)),
        kind: 'db',
        bytes: st.size,
        mtime_ms: st.mtimeMs,
        ctime_ms: st.ctimeMs,
        birthtime_ms: st.birthtimeMs,
        dev: String(st.dev ?? ''),
        ino: String(st.ino ?? ''),
      });
      for (const suffix of SQLITE_PERSISTED_SIDECAR_SUFFIXES) {
        throwIfDiscoveryAborted(signal);
        const sidecar = await statWxDbSourceSidecar(`${dbPath}${suffix}`, { signal });
        if (!sidecar?.isFile() || sidecar.isSymbolicLink()) continue;
        categoryBytes += sidecar.size;
        categoryLast = Math.max(categoryLast, sidecar.mtimeMs);
        generationFiles.push({
          relative: normalizeMirrorRelative(path.relative(dbStorage, `${dbPath}${suffix}`)),
          kind: suffix === '-wal' ? 'wal' : 'journal',
          bytes: sidecar.size,
          mtime_ms: sidecar.mtimeMs,
          ctime_ms: sidecar.ctimeMs,
          birthtime_ms: sidecar.birthtimeMs,
          dev: String(sidecar.dev ?? ''),
          ino: String(sidecar.ino ?? ''),
        });
      }
    }
    totalBytes += categoryBytes;
    last = Math.max(last, categoryLast);
    categories.push({
      name: dir.name,
      db_count: files.length,
      bytes: categoryBytes,
      last_write_time: categoryLast ? new Date(categoryLast).toISOString() : null,
    });
  }
  return {
    categories,
    db_count: categories.reduce((sum, c) => sum + c.db_count, 0),
    bytes: totalBytes,
    last_write_time: last ? new Date(last).toISOString() : null,
    generation_hash: sourceAccountGenerationHash({ generation_files: generationFiles }),
  };
}

export async function discoverWeixinEnvironment({ signal = null } = {}) {
  throwIfDiscoveryAborted(signal);
  const [processes, dataRootDiscovery] = await Promise.all([
    getWeixinProcesses({ signal }),
    discoverDataRootsResult({ signal }),
  ]);
  const data_roots = dataRootDiscovery.roots;
  const accounts = await discoverWxAccounts({
    signal,
    data_roots,
    data_root_unreadable: dataRootDiscovery.unreadable,
  });
  throwIfDiscoveryAborted(signal);
  const main = preferredWeixinProcess(processes);
  const processEnumerationFailed = processes.process_enumeration_failed === true;
  const processEnumerationError = String(processes.process_enumeration_error || '').trim();
  return {
    running: processEnumerationFailed ? null : processes.length > 0,
    process_count: processes.length,
    process_enumeration_failed: processEnumerationFailed,
    process_enumeration_error: processEnumerationError,
    main_process: main,
    main_process_confirmed: isConfirmedMainWeixinProcess(main),
    processes,
    data_roots,
    accounts,
    mirror_index: WXDB_MIRROR_INDEX_INVALID_INFO,
    message: weixinEnvironmentMessage({ processes, accounts, processEnumerationFailed, processEnumerationError }),
  };
}

function weixinProcessLabel() {
  return process.platform === 'darwin' ? 'Mac 微信' : 'Weixin.exe';
}

function weixinEnvironmentMessage({ processes = [], accounts = [], processEnumerationFailed = false, processEnumerationError = '' } = {}) {
  const label = weixinProcessLabel();
  if (processEnumerationFailed) {
    return `微信进程探测失败，暂不能判断 ${label} 是否运行${processEnumerationError ? `：${processEnumerationError}` : ''}`;
  }
  if (accounts.length) {
    const mirrorCount = accounts.filter(account => account?.source === 'project-mirror').length;
    if (mirrorCount === accounts.length) {
      return processes.length
        ? `已检测到 ${accounts.length} 个微信本地工作数据账号。`
        : `已检测到 ${accounts.length} 个微信本地工作数据账号；当前未检测到正在运行的 ${label}。`;
    }
    return processes.length
      ? `已检测到 ${accounts.length} 个微信 v4 数据目录。`
      : `已检测到 ${accounts.length} 个微信 v4 数据目录；当前未检测到正在运行的 ${label}。`;
  }
  if (processes.length) return `已检测到 ${label}，但暂未发现 db_storage 数据目录。`;
  return process.platform === 'darwin'
    ? '未检测到 Mac 微信，也暂未发现微信 v4 数据目录。'
    : '未检测到 Weixin.exe，请先登录微信。';
}

function discoveryAbortError() {
  return Object.assign(new Error('请求已取消'), { name: 'AbortError', status: 499 });
}

function throwIfDiscoveryAborted(signal) {
  if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : discoveryAbortError());
}

function isDiscoveryAbort(error, signal = null) {
  return !!signal?.aborted
    || error?.name === 'AbortError'
    || error?.status === 499
    || error?.code === 'ABORT_ERR';
}

export async function getWeixinBinaryEvidence({ signal = null } = {}) {
  throwIfDiscoveryAborted(signal);
  const processes = await getWeixinProcesses({ signal });
  throwIfDiscoveryAborted(signal);
  const processEnumerationFailed = processes.process_enumeration_failed === true;
  const processEnumerationError = String(processes.process_enumeration_error || '').trim();
  if (processEnumerationFailed) {
    return {
      ok: false,
      running: null,
      process_count: 0,
      process_enumeration_failed: true,
      process_enumeration_error: processEnumerationError,
      captured_at: new Date().toISOString(),
      reason: `微信进程探测失败，暂不能判断 ${weixinProcessLabel()} 是否运行${processEnumerationError ? `：${processEnumerationError}` : ''}`,
    };
  }
  const main = preferredWeixinProcess(processes);
  if (!main?.path) {
    return {
      ok: false,
      running: processes.length > 0,
      process_count: processes.length,
      captured_at: new Date().toISOString(),
      reason: processes.length
        ? (process.platform === 'darwin'
          ? '未识别到可读取的 WeChat 进程路径。'
          : '未识别到可读取的 Weixin.exe 进程路径。')
        : (process.platform === 'darwin'
          ? '未检测到 Mac 微信。'
          : '未检测到 Weixin.exe。'),
    };
  }
  const file = await hashFileSha256(main.path, { signal });
  return {
    ok: true,
    running: true,
    process_count: processes.length,
    main_process_confirmed: isConfirmedMainWeixinProcess(main),
    captured_at: new Date().toISOString(),
    pid: main.pid,
    path: main.path,
    ...file,
  };
}

async function hashFileSha256(file, { signal = null } = {}) {
  throwIfDiscoveryAborted(signal);
  const st = await fsp.stat(file);
  throwIfDiscoveryAborted(signal);
  if (!st.isFile()) throw new Error(`${weixinProcessLabel()} path is not a file`);
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    const onAbort = () => {
      stream.destroy(signal.reason instanceof Error ? signal.reason : discoveryAbortError());
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.on('close', () => signal?.removeEventListener?.('abort', onAbort));
  });
  throwIfDiscoveryAborted(signal);
  return {
    bytes: st.size,
    modified_at: st.mtime.toISOString(),
    sha256: hash.digest('hex'),
  };
}

export async function getWeixinModuleEvidence({ signal = null } = {}) {
  throwIfDiscoveryAborted(signal);
  if (process.platform !== 'win32') {
    const processes = await getWeixinProcesses({ signal });
    const processEnumerationFailed = processes.process_enumeration_failed === true;
    const processEnumerationError = String(processes.process_enumeration_error || '').trim();
    return {
      ok: false,
      running: processEnumerationFailed ? null : processes.length > 0,
      process_count: processes.length,
      process_enumeration_failed: processEnumerationFailed,
      process_enumeration_error: processEnumerationError,
      db_pattern_set: MODULE_DB_PATTERNS,
      db_related_modules: [],
      reason: 'module evidence is only available on Windows',
    };
  }
  const processes = await getWeixinProcesses({ signal });
  throwIfDiscoveryAborted(signal);
  const processEnumerationFailed = processes.process_enumeration_failed === true;
  const processEnumerationError = String(processes.process_enumeration_error || '').trim();
  if (processEnumerationFailed) {
    return {
      ok: false,
      running: null,
      process_count: 0,
      process_enumeration_failed: true,
      process_enumeration_error: processEnumerationError,
      captured_at: new Date().toISOString(),
      db_pattern_set: MODULE_DB_PATTERNS,
      db_related_modules: [],
      reason: `微信进程探测失败，暂不能判断 ${weixinProcessLabel()} 是否运行${processEnumerationError ? `：${processEnumerationError}` : ''}`,
    };
  }
  const main = preferredWeixinProcess(processes);
  if (!main?.pid) {
    return {
      ok: false,
      running: processes.length > 0,
      process_count: processes.length,
      main_process_confirmed: isConfirmedMainWeixinProcess(main),
      captured_at: new Date().toISOString(),
      db_pattern_set: MODULE_DB_PATTERNS,
      db_related_modules: [],
      reason: processes.length ? '未识别到可扫描的 Weixin.exe 进程。' : '未检测到 Weixin.exe。',
    };
  }
  try {
    const modules = await listProcessModules(main.pid, { signal });
    throwIfDiscoveryAborted(signal);
    const installRoot = main.path ? path.dirname(main.path).toLowerCase() : '';
    const weixinModules = modules
      .filter(mod => isWeixinOwnedModule(mod.file_name, installRoot))
      .filter(mod => isInterestingDbModuleName(mod.name))
      .slice(0, 24);
    const scanned = [];
    for (const mod of weixinModules) {
      throwIfDiscoveryAborted(signal);
      const hits = await scanModuleDbStringHits(mod.file_name, mod, { signal }).catch(e => {
        if (isDiscoveryAbort(e, signal)) throw e;
        return { error: e?.message || String(e) };
      });
      scanned.push({
        ...mod,
        db_string_hit_total: hits.total || 0,
        db_string_hits: hits.hits || {},
        db_string_address_hits: hits.address_hits || [],
        crypto_string_hit_total: hits.crypto_string_hit_total || 0,
        crypto_string_hits: hits.crypto_string_hits || {},
        crypto_string_address_hits: hits.crypto_address_hits || [],
        crypto_string_sections: hits.crypto_string_sections || {},
        pe_import_summary: hits.pe_import_summary || null,
        pe_export_summary: hits.pe_export_summary || null,
        string_cluster_summary: hits.string_cluster_summary || [],
        static_string_xref_summary: hits.static_string_xref_summary || null,
        ...(hits.error ? { scan_error: hits.error } : {}),
      });
    }
    scanned.sort((a, b) => b.db_string_hit_total - a.db_string_hit_total || a.name.localeCompare(b.name));
    return {
      ok: true,
      running: true,
      process_count: processes.length,
      main_process_confirmed: isConfirmedMainWeixinProcess(main),
      captured_at: new Date().toISOString(),
      main_pid: main.pid,
      main_path: main.path || '',
      module_count: modules.length,
      db_pattern_set: MODULE_DB_PATTERNS,
      db_related_modules: scanned,
    };
  } catch (e) {
    if (isDiscoveryAbort(e, signal)) throw e;
    return {
      ok: false,
      running: true,
      process_count: processes.length,
      captured_at: new Date().toISOString(),
      main_pid: main.pid,
      main_path: main.path || '',
      db_pattern_set: MODULE_DB_PATTERNS,
      db_related_modules: [],
      error: e?.message || String(e),
    };
  }
}

async function listProcessModules(pid, { signal = null } = {}) {
  throwIfDiscoveryAborted(signal);
  if (!WINDOWS_POWERSHELL_EXE) throw new Error('trusted Windows PowerShell is unavailable');
  const out = await execFileText(WINDOWS_POWERSHELL_EXE, [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; Get-Process -Id ${Number(pid)} | Select-Object -ExpandProperty Modules | Select-Object ModuleName,FileName,@{Name='BaseAddress';Expression={$_.BaseAddress.ToInt64()}},ModuleMemorySize | ConvertTo-Json -Compress`,
  ], { signal });
  throwIfDiscoveryAborted(signal);
  if (!out.trim()) return [];
  const parsed = JSON.parse(out);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map(mod => ({
    name: String(mod.ModuleName || ''),
    file_name: String(mod.FileName || ''),
    base_address: Number(mod.BaseAddress || 0),
    base_address_hex: numberToHex(Number(mod.BaseAddress || 0)),
    module_memory_size: Number(mod.ModuleMemorySize || 0),
  })).filter(mod => mod.name && mod.file_name);
}

function isWeixinOwnedModule(fileName, installRoot) {
  const file = String(fileName || '').toLowerCase();
  if (!file) return false;
  if (installRoot && file.startsWith(installRoot)) return true;
  return /[\\/]weixin[\\/]/i.test(String(fileName || ''));
}

function isInterestingDbModuleName(name) {
  return /weixin|wx|wc|sqlite|sql|cipher|db|storage|mm|owl|ilink/i.test(String(name || ''));
}

async function scanModuleDbStringHits(file, mod = {}, { signal = null } = {}) {
  throwIfDiscoveryAborted(signal);
  const st = await fsp.stat(file);
  throwIfDiscoveryAborted(signal);
  if (!st.isFile()) return { total: 0, hits: {} };
  if (st.size > 260 * 1024 * 1024) return { total: 0, hits: {}, error: 'module_too_large' };
  const buf = await fsp.readFile(file);
  throwIfDiscoveryAborted(signal);
  const pe = readPeSections(buf);
  const baseAddress = Number(mod.base_address || 0);
  const hits = {};
  const addressHits = [];
  const cryptoAddressHits = [];
  const cryptoHits = {};
  let total = 0;
  for (const pattern of MODULE_DB_PATTERNS) {
    throwIfDiscoveryAborted(signal);
    const asciiOffsets = findBufferPatternOffsets(buf, Buffer.from(pattern, 'ascii'));
    const utf16Offsets = findBufferPatternOffsets(buf, Buffer.from(pattern, 'utf16le'));
    const count = asciiOffsets.length + utf16Offsets.length;
    if (count) {
      const key = pattern.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      hits[key] = (hits[key] || 0) + count;
      total += count;
      for (const offset of asciiOffsets) {
        addModuleStringAddressHit(addressHits, pe, baseAddress, pattern, 'ascii', offset);
      }
      for (const offset of utf16Offsets) {
        addModuleStringAddressHit(addressHits, pe, baseAddress, pattern, 'utf16le', offset);
      }
    }
  }
  let cryptoTotal = 0;
  for (const pattern of MODULE_CRYPTO_PATTERNS) {
    throwIfDiscoveryAborted(signal);
    const asciiOffsets = findBufferPatternOffsets(buf, Buffer.from(pattern, 'ascii'));
    const utf16Offsets = findBufferPatternOffsets(buf, Buffer.from(pattern, 'utf16le'));
    const count = asciiOffsets.length + utf16Offsets.length;
    if (!count) continue;
    const key = pattern.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    cryptoHits[key] = (cryptoHits[key] || 0) + count;
    cryptoTotal += count;
    for (const offset of asciiOffsets) {
      addModuleStringAddressHit(cryptoAddressHits, pe, baseAddress, pattern, 'ascii', offset, MAX_MODULE_CRYPTO_ADDRESS_HITS);
    }
    for (const offset of utf16Offsets) {
      addModuleStringAddressHit(cryptoAddressHits, pe, baseAddress, pattern, 'utf16le', offset, MAX_MODULE_CRYPTO_ADDRESS_HITS);
    }
  }
  const importSummary = summarizePeImports(buf, pe);
  const exportSummary = summarizePeExports(buf, pe);
  return {
    total,
    hits,
    address_hits: addressHits,
    crypto_string_hit_total: cryptoTotal,
    crypto_string_hits: cryptoHits,
    crypto_address_hits: cryptoAddressHits,
    crypto_string_sections: summarizeStringSections(cryptoAddressHits),
    pe_import_summary: importSummary,
    pe_export_summary: exportSummary,
    string_cluster_summary: summarizeStringClusters(addressHits, cryptoAddressHits),
    static_string_xref_summary: summarizeStaticStringXrefs(buf, pe, addressHits, cryptoAddressHits),
  };
}

function findBufferPatternOffsets(buf, pattern) {
  const offsets = [];
  if (!pattern.length) return offsets;
  let pos = buf.indexOf(pattern);
  while (pos >= 0) {
    offsets.push(pos);
    pos = buf.indexOf(pattern, pos + 1);
  }
  return offsets;
}

function addModuleStringAddressHit(out, pe, baseAddress, pattern, encoding, fileOffset, limit = MAX_MODULE_STRING_ADDRESS_HITS) {
  if (out.length >= limit) return;
  const mapped = fileOffsetToRva(pe, fileOffset);
  if (!mapped) return;
  const virtualAddress = baseAddress && mapped.rva >= 0 ? baseAddress + mapped.rva : 0;
  out.push({
    pattern,
    encoding,
    file_offset: fileOffset,
    file_offset_hex: numberToHex(fileOffset),
    rva: mapped.rva,
    rva_hex: numberToHex(mapped.rva),
    virtual_address: virtualAddress,
    virtual_address_hex: numberToHex(virtualAddress),
    section: mapped.section,
  });
}

function readPeSections(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 0x100) return { sections: [], size_of_headers: 0 };
  if (buf.readUInt16LE(0) !== 0x5a4d) return { sections: [], size_of_headers: 0 };
  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset <= 0 || peOffset + 0x108 > buf.length) return { sections: [], size_of_headers: 0 };
  if (buf.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') return { sections: [], size_of_headers: 0 };
  const numberOfSections = buf.readUInt16LE(peOffset + 6);
  const optionalHeaderSize = buf.readUInt16LE(peOffset + 20);
  const optionalHeaderOffset = peOffset + 24;
  const optionalMagic = optionalHeaderOffset + 2 <= buf.length ? buf.readUInt16LE(optionalHeaderOffset) : 0;
  const isPe64 = optionalMagic === 0x20b;
  const sizeOfHeaders = optionalHeaderOffset + 64 <= buf.length ? buf.readUInt32LE(optionalHeaderOffset + 60) : 0;
  const numberOfRvaAndSizesOffset = optionalHeaderOffset + (isPe64 ? 108 : 92);
  const dataDirectoryOffset = optionalHeaderOffset + (isPe64 ? 112 : 96);
  const numberOfRvaAndSizes = numberOfRvaAndSizesOffset + 4 <= buf.length ? buf.readUInt32LE(numberOfRvaAndSizesOffset) : 0;
  const dataDirectories = {};
  const directoryNames = ['export', 'import', 'resource', 'exception', 'certificate', 'base_relocation', 'debug', 'architecture', 'global_ptr', 'tls', 'load_config', 'bound_import', 'iat', 'delay_import', 'clr_runtime'];
  const directoryCount = Math.min(numberOfRvaAndSizes, directoryNames.length);
  for (let i = 0; i < directoryCount; i++) {
    const off = dataDirectoryOffset + i * 8;
    if (off + 8 > buf.length) break;
    const rva = buf.readUInt32LE(off);
    const size = buf.readUInt32LE(off + 4);
    dataDirectories[directoryNames[i]] = { rva, size };
  }
  const sectionOffset = optionalHeaderOffset + optionalHeaderSize;
  const sections = [];
  for (let i = 0; i < numberOfSections; i++) {
    const off = sectionOffset + i * 40;
    if (off + 40 > buf.length) break;
    const nul = buf.indexOf(0, off);
    const nameEnd = nul >= off && nul < off + 8 ? nul : off + 8;
    const name = buf.toString('ascii', off, nameEnd);
    const virtual_size = buf.readUInt32LE(off + 8);
    const virtual_address = buf.readUInt32LE(off + 12);
    const size_of_raw_data = buf.readUInt32LE(off + 16);
    const pointer_to_raw_data = buf.readUInt32LE(off + 20);
    const characteristics = buf.readUInt32LE(off + 36);
    sections.push({ name, virtual_size, virtual_address, size_of_raw_data, pointer_to_raw_data, characteristics });
  }
  return { sections, size_of_headers: sizeOfHeaders, is_pe64: isPe64, optional_magic: optionalMagic, data_directories: dataDirectories };
}

function fileOffsetToRva(pe, fileOffset) {
  const offset = Number(fileOffset || 0);
  if (pe?.size_of_headers && offset >= 0 && offset < pe.size_of_headers) {
    return { rva: offset, section: 'headers' };
  }
  for (const section of pe?.sections || []) {
    const rawStart = Number(section.pointer_to_raw_data || 0);
    const rawSize = Number(section.size_of_raw_data || 0);
    if (!rawSize || offset < rawStart || offset >= rawStart + rawSize) continue;
    return {
      rva: Number(section.virtual_address || 0) + (offset - rawStart),
      section: section.name || '',
    };
  }
  return null;
}

function rvaToFileOffset(pe, rva) {
  const value = Number(rva || 0);
  if (!Number.isFinite(value) || value < 0) return -1;
  if (pe?.size_of_headers && value >= 0 && value < pe.size_of_headers) return value;
  for (const section of pe?.sections || []) {
    const virtualStart = Number(section.virtual_address || 0);
    const virtualSize = Math.max(Number(section.virtual_size || 0), Number(section.size_of_raw_data || 0));
    if (!virtualSize || value < virtualStart || value >= virtualStart + virtualSize) continue;
    const rawStart = Number(section.pointer_to_raw_data || 0);
    const rawOffset = rawStart + (value - virtualStart);
    const rawSize = Number(section.size_of_raw_data || 0);
    if (rawOffset < rawStart || rawOffset >= rawStart + rawSize) return -1;
    return rawOffset;
  }
  return -1;
}

function summarizePeImports(buf, pe) {
  const dir = pe?.data_directories?.import;
  const offset = dir?.rva ? rvaToFileOffset(pe, dir.rva) : -1;
  if (offset < 0 || offset + 20 > buf.length) {
    return {
      dll_count: 0,
      function_count: 0,
      interesting_dlls: [],
      interesting_function_total: 0,
      crypto_api_import_count: 0,
      db_api_import_count: 0,
    };
  }
  const dlls = [];
  let dllCount = 0;
  let functionCount = 0;
  let cryptoApiImportCount = 0;
  let dbApiImportCount = 0;
  for (let descriptorOffset = offset, descriptorIndex = 0; descriptorIndex < MAX_IMPORT_DLLS; descriptorIndex++, descriptorOffset += 20) {
    if (descriptorOffset + 20 > buf.length) break;
    const originalFirstThunk = buf.readUInt32LE(descriptorOffset);
    const nameRva = buf.readUInt32LE(descriptorOffset + 12);
    const firstThunk = buf.readUInt32LE(descriptorOffset + 16);
    if (!originalFirstThunk && !nameRva && !firstThunk) break;
    const dllName = readCStringAtRva(buf, pe, nameRva, 160);
    if (!dllName) continue;
    dllCount++;
    const thunkRva = originalFirstThunk || firstThunk;
    const functions = readImportThunkNames(buf, pe, thunkRva);
    functionCount += functions.length;
    const interestingFunctions = functions.filter(name => isInterestingImportOrExportName(name));
    cryptoApiImportCount += functions.filter(name => isCryptoImportOrExportName(name)).length;
    dbApiImportCount += functions.filter(name => isDbImportOrExportName(name)).length;
    if (isInterestingImportDll(dllName) || interestingFunctions.length) {
      dlls.push({
        dll: dllName,
        function_count: functions.length,
        interesting_functions: interestingFunctions.slice(0, MAX_INTERESTING_IMPORT_FUNCTIONS_PER_DLL),
        sample_functions: functions.slice(0, MAX_IMPORT_FUNCTIONS_PER_DLL),
      });
    }
  }
  const interestingFunctionTotal = dlls.reduce((sum, item) => sum + item.interesting_functions.length, 0);
  return {
    dll_count: dllCount,
    interesting_dll_count: dlls.length,
    function_count: functionCount,
    interesting_dlls: dlls,
    interesting_function_total: interestingFunctionTotal,
    crypto_api_import_count: cryptoApiImportCount,
    db_api_import_count: dbApiImportCount,
  };
}

function readImportThunkNames(buf, pe, thunkRva) {
  const out = [];
  const entrySize = pe?.is_pe64 ? 8 : 4;
  const ordinalFlag = pe?.is_pe64 ? 0x8000000000000000n : 0x80000000n;
  let off = rvaToFileOffset(pe, thunkRva);
  if (off < 0) return out;
  for (let i = 0; i < 4096; i++, off += entrySize) {
    if (off + entrySize > buf.length) break;
    const value = pe?.is_pe64 ? buf.readBigUInt64LE(off) : BigInt(buf.readUInt32LE(off));
    if (value === 0n) break;
    if ((value & ordinalFlag) !== 0n) {
      out.push(`#${Number(value & 0xffffn)}`);
      continue;
    }
    const nameOffset = rvaToFileOffset(pe, Number(value));
    if (nameOffset < 0 || nameOffset + 2 >= buf.length) continue;
    const name = readCString(buf, nameOffset + 2, 240);
    if (name) out.push(name);
  }
  return out;
}

function summarizePeExports(buf, pe) {
  const dir = pe?.data_directories?.export;
  const offset = dir?.rva ? rvaToFileOffset(pe, dir.rva) : -1;
  if (offset < 0 || offset + 40 > buf.length) {
    return {
      named_export_count: 0,
      interesting_export_count: 0,
      interesting_export_names: [],
    };
  }
  const numberOfNames = buf.readUInt32LE(offset + 24);
  const addressOfNamesRva = buf.readUInt32LE(offset + 32);
  const namesOffset = rvaToFileOffset(pe, addressOfNamesRva);
  if (namesOffset < 0) {
    return {
      named_export_count: 0,
      interesting_export_count: 0,
      interesting_export_names: [],
    };
  }
  const names = [];
  for (let i = 0; i < Math.min(numberOfNames, MAX_EXPORT_NAMES); i++) {
    const nameRvaOffset = namesOffset + i * 4;
    if (nameRvaOffset + 4 > buf.length) break;
    const name = readCStringAtRva(buf, pe, buf.readUInt32LE(nameRvaOffset), 240);
    if (name && isInterestingImportOrExportName(name)) names.push(name);
  }
  return {
    named_export_count: numberOfNames,
    interesting_export_count: names.length,
    interesting_export_names: names,
  };
}

function readCStringAtRva(buf, pe, rva, maxBytes = 256) {
  const offset = rvaToFileOffset(pe, rva);
  return offset >= 0 ? readCString(buf, offset, maxBytes) : '';
}

function readCString(buf, offset, maxBytes = 256) {
  if (!Number.isInteger(offset) || offset < 0 || offset >= buf.length) return '';
  const endLimit = Math.min(buf.length, offset + maxBytes);
  let end = offset;
  while (end < endLimit && buf[end] !== 0) end++;
  if (end === offset) return '';
  return buf.toString('utf-8', offset, end).replace(/[^\x20-\x7E]/g, '').trim();
}

function isInterestingImportDll(name) {
  return /bcrypt|crypt|ncrypt|advapi|sqlite|sqlcipher|wcdb|crypto|ssl|openssl|libsodium|mbedtls/i.test(String(name || ''));
}

function isInterestingImportOrExportName(name) {
  return isCryptoImportOrExportName(name) || isDbImportOrExportName(name);
}

function isCryptoImportOrExportName(name) {
  return /bcrypt|crypt|aes|sha1|sha256|sha512|hmac|pbkdf|hkdf|derive|decrypt|encrypt|evp|mbedtls|openssl|sodium/i.test(String(name || ''));
}

function isDbImportOrExportName(name) {
  return /sqlite|sqlcipher|wcdb|codec|cipher|rekey|sqlite3_key|xwechat|db_storage/i.test(String(name || ''));
}

function summarizeStringSections(addressHits) {
  const sections = {};
  for (const hit of addressHits || []) {
    const key = hit.section || 'unknown';
    sections[key] = (sections[key] || 0) + 1;
  }
  return sections;
}

function summarizeStringClusters(dbAddressHits, cryptoAddressHits) {
  const buckets = new Map();
  for (const hit of dbAddressHits || []) addStringClusterHit(buckets, hit, 'db');
  for (const hit of cryptoAddressHits || []) addStringClusterHit(buckets, hit, 'crypto');
  return [...buckets.values()]
    .map(item => ({
      section: item.section,
      rva_bucket_hex: numberToHex(item.rva_bucket),
      hit_count: item.hit_count,
      db_hit_count: item.db_hit_count,
      crypto_hit_count: item.crypto_hit_count,
      patterns: [...item.patterns].sort().slice(0, 24),
      db_patterns: [...item.db_patterns].sort().slice(0, 16),
      crypto_patterns: [...item.crypto_patterns].sort().slice(0, 16),
    }))
    .filter(item => item.db_hit_count > 0 && item.crypto_hit_count > 0)
    .sort((a, b) => b.crypto_hit_count - a.crypto_hit_count || b.db_hit_count - a.db_hit_count || b.hit_count - a.hit_count)
    .slice(0, MAX_STRING_CLUSTERS);
}

function summarizeStaticStringXrefs(buf, pe, dbAddressHits, cryptoAddressHits) {
  const targets = buildStaticStringXrefTargets(dbAddressHits, cryptoAddressHits);
  if (!targets.length) {
    return {
      scan_mode: 'best_effort_x64_rip_relative',
      source_bucket_bytes: 0x1000,
      source_region_bytes: 0x10000,
      target_count: 0,
      xref_count: 0,
      executable_section_count: executablePeSections(pe).length,
      source_buckets: [],
      source_regions: [],
      function_summary: null,
      target_patterns: [],
      mixed_source_buckets: [],
      mixed_source_regions: [],
    };
  }
  const targetBuckets = bucketStaticStringTargets(targets);
  const xrefs = [];
  for (const section of executablePeSections(pe)) {
    if (xrefs.length >= MAX_STATIC_STRING_XREFS) break;
    const rawStart = Number(section.pointer_to_raw_data || 0);
    const rawSize = Number(section.size_of_raw_data || 0);
    const rawEnd = Math.min(buf.length, rawStart + rawSize);
    if (!rawSize || rawStart < 0 || rawStart >= buf.length) continue;
    const sectionRva = Number(section.virtual_address || 0);
    for (let raw = rawStart; raw + 7 <= rawEnd && xrefs.length < MAX_STATIC_STRING_XREFS; raw++) {
      const sourceRva = sectionRva + (raw - rawStart);
      const targetRva = decodeRipRelativeTargetRva(buf, raw, sourceRva);
      if (!targetRva) continue;
      const target = findStaticStringTarget(targetBuckets, targetRva);
      if (!target) continue;
      xrefs.push({
        source_section: section.name || 'unknown',
        source_rva: sourceRva,
        source_raw_offset: raw,
        source_rva_bucket: Math.floor(sourceRva / 0x1000) * 0x1000,
        target_rva_bucket: Math.floor(target.start / 0x1000) * 0x1000,
        target_section: target.section || 'unknown',
        pattern: target.pattern,
        kind: target.kind,
      });
    }
  }
  return summarizeStaticStringXrefHits(buf, pe, targets, xrefs, executablePeSections(pe).length);
}

function buildStaticStringXrefTargets(dbAddressHits, cryptoAddressHits) {
  const dbMap = new Map();
  const cryptoMap = new Map();
  for (const hit of dbAddressHits || []) addStaticStringTarget(dbMap, hit, 'db');
  for (const hit of cryptoAddressHits || []) addStaticStringTarget(cryptoMap, hit, 'crypto');
  const sortTargets = targets => [...targets.values()]
    .sort((a, b) => patternXrefWeight(b.pattern) - patternXrefWeight(a.pattern) || a.start - b.start);
  const dbTargets = sortTargets(dbMap);
  const cryptoTargets = sortTargets(cryptoMap);
  const dbLimit = Math.min(dbTargets.length, Math.ceil(MAX_STATIC_STRING_XREF_TARGETS * 0.58));
  const cryptoLimit = Math.min(cryptoTargets.length, MAX_STATIC_STRING_XREF_TARGETS - dbLimit);
  const selected = [...dbTargets.slice(0, dbLimit), ...cryptoTargets.slice(0, cryptoLimit)];
  if (selected.length < MAX_STATIC_STRING_XREF_TARGETS) {
    const used = new Set(selected.map(target => `${target.kind}:${target.start}:${target.pattern}:${target.encoding}`));
    for (const target of [...dbTargets.slice(dbLimit), ...cryptoTargets.slice(cryptoLimit)]) {
      const key = `${target.kind}:${target.start}:${target.pattern}:${target.encoding}`;
      if (used.has(key)) continue;
      selected.push(target);
      used.add(key);
      if (selected.length >= MAX_STATIC_STRING_XREF_TARGETS) break;
    }
  }
  return selected;
}

function addStaticStringTarget(map, hit, kind) {
  const start = Number(hit?.rva || 0);
  if (!Number.isFinite(start) || start <= 0) return;
  const pattern = String(hit.pattern || '').slice(0, 96);
  const encoding = hit.encoding === 'utf16le' ? 'utf16le' : 'ascii';
  const byteLength = encoding === 'utf16le' ? pattern.length * 2 : pattern.length;
  const end = start + Math.max(2, Math.min(192, byteLength + 2));
  const key = `${start}:${kind}:${pattern}:${encoding}`;
  if (map.has(key)) return;
  map.set(key, {
    start,
    end,
    section: hit.section || 'unknown',
    pattern,
    encoding,
    kind,
  });
}

function bucketStaticStringTargets(targets) {
  const buckets = new Map();
  for (const target of targets) {
    const startBucket = Math.floor(target.start / 0x1000);
    const endBucket = Math.floor(Math.max(target.start, target.end - 1) / 0x1000);
    for (let bucket = startBucket; bucket <= endBucket; bucket++) {
      const list = buckets.get(bucket) || [];
      list.push(target);
      buckets.set(bucket, list);
    }
  }
  return buckets;
}

function findStaticStringTarget(targetBuckets, rva) {
  const bucket = Math.floor(Number(rva || 0) / 0x1000);
  for (const target of targetBuckets.get(bucket) || []) {
    if (rva >= target.start && rva < target.end) return target;
  }
  return null;
}

function executablePeSections(pe) {
  return (pe?.sections || []).filter(section => {
    const characteristics = Number(section.characteristics || 0);
    return (characteristics & 0x20000000) !== 0 || /^\.text/i.test(String(section.name || ''));
  });
}

function decodeRipRelativeTargetRva(buf, rawOffset, sourceRva) {
  let i = rawOffset;
  let prefixCount = 0;
  while (i < buf.length && prefixCount < 4 && isInstructionPrefix(buf[i])) {
    i++;
    prefixCount++;
  }
  if (i + 6 > buf.length) return 0;
  const opcode = buf[i];
  if (isSimpleRipRelativeOpcode(opcode)) {
    return decodeRipRelativeModRmTarget(buf, i + 1, sourceRva, (i - rawOffset) + 2 + 4);
  }
  if (opcode === 0x0f && i + 7 <= buf.length && isTwoByteRipRelativeOpcode(buf[i + 1])) {
    return decodeRipRelativeModRmTarget(buf, i + 2, sourceRva, (i - rawOffset) + 3 + 4);
  }
  return 0;
}

function decodeRipRelativeModRmTarget(buf, modRmOffset, sourceRva, instrLen) {
  if (modRmOffset + 5 > buf.length) return 0;
  const modrm = buf[modRmOffset];
  if ((modrm & 0xc7) !== 0x05) return 0;
  const disp = buf.readInt32LE(modRmOffset + 1);
  const target = Number(sourceRva || 0) + Number(instrLen || 0) + disp;
  return target > 0 ? target : 0;
}

function isInstructionPrefix(value) {
  return (value >= 0x40 && value <= 0x4f)
    || value === 0x66
    || value === 0x67
    || value === 0x2e
    || value === 0x36
    || value === 0x3e
    || value === 0x26
    || value === 0x64
    || value === 0x65;
}

function isSimpleRipRelativeOpcode(opcode) {
  return opcode === 0x8d
    || opcode === 0x8b
    || opcode === 0x8a
    || opcode === 0x39
    || opcode === 0x3b
    || opcode === 0x85
    || opcode === 0x89
    || opcode === 0x88;
}

function isTwoByteRipRelativeOpcode(opcode) {
  return opcode === 0xb6
    || opcode === 0xb7
    || opcode === 0xbe
    || opcode === 0xbf
    || opcode === 0x84
    || opcode === 0x85;
}

function summarizeStaticStringXrefHits(buf, pe, targets, xrefs, executableSectionCount) {
  const sourceBuckets = new Map();
  const patternBuckets = new Map();
  for (const xref of xrefs) {
    const sourceKey = `${xref.source_section}:${xref.source_rva_bucket}`;
    let source = sourceBuckets.get(sourceKey);
    if (!source) {
      source = {
        source_section: xref.source_section,
        source_rva_bucket: xref.source_rva_bucket,
        xref_count: 0,
        db_xref_count: 0,
        crypto_xref_count: 0,
        target_patterns: new Set(),
        target_sections: new Set(),
        target_rva_buckets: new Set(),
      };
      sourceBuckets.set(sourceKey, source);
    }
    source.xref_count++;
    if (xref.kind === 'crypto') source.crypto_xref_count++;
    else source.db_xref_count++;
    source.target_patterns.add(`${xref.kind}:${xref.pattern}`);
    source.target_sections.add(xref.target_section);
    source.target_rva_buckets.add(xref.target_rva_bucket);

    const patternKey = `${xref.kind}:${xref.pattern}`;
    let pattern = patternBuckets.get(patternKey);
    if (!pattern) {
      pattern = {
        kind: xref.kind,
        pattern: xref.pattern,
        xref_count: 0,
        source_sections: new Set(),
        source_rva_buckets: new Set(),
        target_rva_buckets: new Set(),
      };
      patternBuckets.set(patternKey, pattern);
    }
    pattern.xref_count++;
    pattern.source_sections.add(xref.source_section);
    pattern.source_rva_buckets.add(xref.source_rva_bucket);
    pattern.target_rva_buckets.add(xref.target_rva_bucket);
  }
  const buckets = [...sourceBuckets.values()]
    .map(item => ({
      source_section: item.source_section,
      source_rva_bucket_hex: numberToHex(item.source_rva_bucket),
      xref_count: item.xref_count,
      db_xref_count: item.db_xref_count,
      crypto_xref_count: item.crypto_xref_count,
      target_patterns: [...item.target_patterns].sort().slice(0, 24),
      target_sections: [...item.target_sections].sort(),
      target_rva_buckets: [...item.target_rva_buckets].sort((a, b) => a - b).slice(0, 16).map(numberToHex),
    }))
    .sort((a, b) => b.xref_count - a.xref_count || b.crypto_xref_count - a.crypto_xref_count)
    .slice(0, MAX_STATIC_STRING_XREF_BUCKETS);
  const patterns = [...patternBuckets.values()]
    .map(item => ({
      kind: item.kind,
      pattern: item.pattern,
      xref_count: item.xref_count,
      source_sections: [...item.source_sections].sort(),
      source_bucket_count: item.source_rva_buckets.size,
      target_bucket_count: item.target_rva_buckets.size,
    }))
    .sort((a, b) => b.xref_count - a.xref_count || targetKindWeight(b.kind) - targetKindWeight(a.kind) || patternXrefWeight(b.pattern) - patternXrefWeight(a.pattern))
    .slice(0, MAX_STATIC_STRING_XREF_PATTERNS);
  return {
    scan_mode: 'best_effort_x64_rip_relative',
    source_bucket_bytes: 0x1000,
    source_region_bytes: 0x10000,
    target_count: targets.length,
    xref_count: xrefs.length,
    executable_section_count: executableSectionCount,
    source_buckets: buckets,
    source_regions: summarizeStaticStringXrefRegions(xrefs),
    function_summary: summarizeStaticXrefFunctions(buf, pe, xrefs),
    target_patterns: patterns,
    mixed_source_buckets: buckets.filter(item => item.db_xref_count > 0 && item.crypto_xref_count > 0).slice(0, 24),
    mixed_source_regions: summarizeStaticStringXrefRegions(xrefs).filter(item => item.db_xref_count > 0 && item.crypto_xref_count > 0).slice(0, 24),
  };
}

function summarizeStaticStringXrefRegions(xrefs) {
  const regions = new Map();
  for (const xref of xrefs) {
    const sourceRegion = Math.floor(Number(xref.source_rva || 0) / 0x10000) * 0x10000;
    const key = `${xref.source_section}:${sourceRegion}`;
    let region = regions.get(key);
    if (!region) {
      region = {
        source_section: xref.source_section,
        source_rva_region: sourceRegion,
        xref_count: 0,
        db_xref_count: 0,
        crypto_xref_count: 0,
        target_patterns: new Set(),
        source_bucket_count: new Set(),
      };
      regions.set(key, region);
    }
    region.xref_count++;
    if (xref.kind === 'crypto') region.crypto_xref_count++;
    else region.db_xref_count++;
    region.target_patterns.add(`${xref.kind}:${xref.pattern}`);
    region.source_bucket_count.add(xref.source_rva_bucket);
  }
  return [...regions.values()]
    .map(item => ({
      source_section: item.source_section,
      source_rva_region_hex: numberToHex(item.source_rva_region),
      xref_count: item.xref_count,
      db_xref_count: item.db_xref_count,
      crypto_xref_count: item.crypto_xref_count,
      source_bucket_count: item.source_bucket_count.size,
      target_patterns: [...item.target_patterns].sort().slice(0, 32),
    }))
    .sort((a, b) => b.xref_count - a.xref_count || b.crypto_xref_count - a.crypto_xref_count)
    .slice(0, MAX_STATIC_STRING_XREF_BUCKETS);
}

function summarizeStaticXrefFunctions(buf, pe, xrefs) {
  const functions = new Map();
  const directCallTargets = new Map();
  const functionCallCache = new Map();
  for (const xref of xrefs || []) {
    const sourceRaw = Number(xref.source_raw_offset || -1);
    const sourceRva = Number(xref.source_rva || 0);
    if (sourceRaw < 0 || !sourceRva) continue;
    const fn = findNearestX64FunctionStart(buf, pe, sourceRaw, sourceRva);
    const fnRva = fn?.rva || Math.floor(sourceRva / 0x1000) * 0x1000;
    const fnKey = `${xref.source_section}:${Math.floor(fnRva / 0x100) * 0x100}`;
    let item = functions.get(fnKey);
    if (!item) {
      item = {
        source_section: xref.source_section,
        function_rva_bucket: Math.floor(fnRva / 0x100) * 0x100,
        function_rva_region: Math.floor(fnRva / 0x10000) * 0x10000,
        xref_count: 0,
        db_xref_count: 0,
        crypto_xref_count: 0,
        target_patterns: new Set(),
        direct_call_target_regions: new Set(),
        direct_call_target_count: 0,
      };
      functions.set(fnKey, item);
      const callTargets = scanDirectCallTargetsNearXref(buf, pe, sourceRaw, sourceRva, fn);
      functionCallCache.set(fnKey, callTargets);
      for (const target of callTargets) {
        const targetRegion = Math.floor(target / 0x10000) * 0x10000;
        if (targetRegion <= 0) continue;
        item.direct_call_target_regions.add(targetRegion);
        item.direct_call_target_count++;
        const callKey = numberToHex(targetRegion);
        const existing = directCallTargets.get(callKey) || { target_rva_region: targetRegion, call_count: 0, source_function_count: new Set(), source_patterns: new Set() };
        existing.call_count++;
        existing.source_function_count.add(fnKey);
        directCallTargets.set(callKey, existing);
      }
    }
    item.xref_count++;
    if (xref.kind === 'crypto') item.crypto_xref_count++;
    else item.db_xref_count++;
    item.target_patterns.add(`${xref.kind}:${xref.pattern}`);
    for (const target of functionCallCache.get(fnKey) || []) {
      const targetRegion = Math.floor(target / 0x10000) * 0x10000;
      if (targetRegion <= 0) continue;
      const callKey = numberToHex(targetRegion);
      const existing = directCallTargets.get(callKey);
      if (existing) existing.source_patterns.add(`${xref.kind}:${xref.pattern}`);
    }
  }
  const functionList = [...functions.values()]
    .map(item => ({
      source_section: item.source_section,
      function_rva_bucket_hex: numberToHex(item.function_rva_bucket),
      function_rva_region_hex: numberToHex(item.function_rva_region),
      xref_count: item.xref_count,
      db_xref_count: item.db_xref_count,
      crypto_xref_count: item.crypto_xref_count,
      direct_call_target_count: item.direct_call_target_count,
      direct_call_target_regions: [...item.direct_call_target_regions].sort((a, b) => a - b).slice(0, 16).map(numberToHex),
      target_patterns: [...item.target_patterns].sort().slice(0, 24),
    }))
    .sort((a, b) => b.xref_count - a.xref_count || b.crypto_xref_count - a.crypto_xref_count || b.direct_call_target_count - a.direct_call_target_count)
    .slice(0, MAX_STATIC_XREF_FUNCTIONS);
  const callTargetList = [...directCallTargets.values()]
    .map(item => ({
      target_rva_region_hex: numberToHex(item.target_rva_region),
      call_count: item.call_count,
      source_function_count: item.source_function_count.size,
      source_patterns: [...item.source_patterns].sort().slice(0, 24),
    }))
    .sort((a, b) => b.call_count - a.call_count || b.source_function_count - a.source_function_count)
    .slice(0, MAX_STATIC_XREF_CALL_TARGETS);
  return {
    scan_mode: 'heuristic_x64_prologue_and_rel32_calls',
    function_count: functions.size,
    direct_call_target_region_count: directCallTargets.size,
    functions: functionList,
    direct_call_target_regions: callTargetList,
    priority_call_graph: summarizePriorityStaticCallGraph(buf, pe, functions, functionCallCache, xrefs),
    mixed_functions: functionList.filter(item => item.db_xref_count > 0 && item.crypto_xref_count > 0).slice(0, 24),
  };
}

function summarizePriorityStaticCallGraph(buf, pe, functions, functionCallCache, xrefs) {
  const sourceRegionPatterns = summarizeXrefPatternsBySourceRegion(xrefs);
  const sourceBucketPatterns = summarizeXrefPatternsBySourceBucket(xrefs);
  const rel32CallIndex = buildStaticRel32CallIndex(buf, pe);
  const regionFunctionMap = summarizeStaticFunctionsByRegion(functions, rel32CallIndex);
  const secondHopCache = new Map();
  const sharedFirstHopRegions = new Map();
  const sharedSecondHopRegions = new Map();
  const priorityFunctions = [...functions.entries()]
    .map(([key, item]) => ({ key, item, score: staticFunctionPriorityScore(item) }))
    .filter(entry => entry.item.db_xref_count > 0 || hasSqlCipherPattern(entry.item.target_patterns))
    .sort((a, b) => b.score - a.score || b.item.xref_count - a.item.xref_count)
    .slice(0, MAX_STATIC_XREF_PRIORITY_GRAPH_FUNCTIONS);
  const graphFunctions = [];
  for (const { key, item } of priorityFunctions) {
    const firstHopRegions = new Map();
    const secondHopRegions = new Map();
    const directTargets = (functionCallCache.get(key) || []).filter(target => Number(target || 0) > 0);
    for (const targetRva of directTargets) {
      const firstRegion = Math.floor(targetRva / 0x10000) * 0x10000;
      if (firstRegion <= 0) continue;
      addCallGraphRegion(firstHopRegions, firstRegion, key, 1, sourceRegionPatterns);
      addCallGraphRegion(sharedFirstHopRegions, firstRegion, key, 1, sourceRegionPatterns);
      const secondTargets = getSecondHopTargetsForRva(buf, pe, targetRva, secondHopCache);
      for (const secondTarget of secondTargets) {
        const secondRegion = Math.floor(secondTarget / 0x10000) * 0x10000;
        if (secondRegion <= 0) continue;
        addCallGraphRegion(secondHopRegions, secondRegion, key, 1, sourceRegionPatterns);
        addCallGraphRegion(sharedSecondHopRegions, secondRegion, key, 1, sourceRegionPatterns);
      }
    }
    graphFunctions.push({
      source_section: item.source_section,
      function_rva_bucket_hex: numberToHex(item.function_rva_bucket),
      function_rva_region_hex: numberToHex(item.function_rva_region),
      xref_count: item.xref_count,
      db_xref_count: item.db_xref_count,
      crypto_xref_count: item.crypto_xref_count,
      target_patterns: [...item.target_patterns].sort().slice(0, 24),
      first_hop_target_regions: formatCallGraphRegions(firstHopRegions, MAX_STATIC_XREF_PRIORITY_FIRST_HOPS),
      second_hop_target_regions: formatCallGraphRegions(secondHopRegions, MAX_STATIC_XREF_PRIORITY_SECOND_HOPS),
    });
  }
  return {
    scan_mode: 'heuristic_two_hop_rel32_call_graph',
    priority_function_count: graphFunctions.length,
    first_hop_region_count: sharedFirstHopRegions.size,
    second_hop_region_count: sharedSecondHopRegions.size,
    functions: graphFunctions,
    shared_first_hop_target_regions: formatCallGraphRegions(sharedFirstHopRegions, MAX_STATIC_XREF_PRIORITY_FIRST_HOPS),
    shared_second_hop_target_regions: formatCallGraphRegions(sharedSecondHopRegions, MAX_STATIC_XREF_PRIORITY_SECOND_HOPS),
    rel32_call_index_summary: {
      scan_mode: rel32CallIndex.scan_mode,
      call_count: rel32CallIndex.call_count,
      source_region_count: rel32CallIndex.by_source_region.size,
      source_bucket_count: rel32CallIndex.by_source_bucket.size,
      target_region_count: rel32CallIndex.by_target_region.size,
      target_bucket_count: rel32CallIndex.by_target_bucket.size,
    },
    candidate_key_derivation_regions: rankCandidateKeyDerivationRegions(sharedFirstHopRegions, sharedSecondHopRegions, regionFunctionMap, rel32CallIndex, sourceRegionPatterns, sourceBucketPatterns, buf, pe, functionCallCache),
  };
}

function summarizeXrefPatternsBySourceRegion(xrefs) {
  const regions = new Map();
  for (const xref of xrefs || []) {
    const sourceRegion = Math.floor(Number(xref.source_rva || 0) / 0x10000) * 0x10000;
    if (sourceRegion <= 0) continue;
    const key = numberToHex(sourceRegion);
    let item = regions.get(key);
    if (!item) {
      item = {
        db_xref_count: 0,
        crypto_xref_count: 0,
        target_patterns: new Set(),
      };
      regions.set(key, item);
    }
    if (xref.kind === 'crypto') item.crypto_xref_count++;
    else item.db_xref_count++;
    item.target_patterns.add(`${xref.kind}:${xref.pattern}`);
  }
  return regions;
}

function summarizeXrefPatternsBySourceBucket(xrefs) {
  const buckets = new Map();
  for (const xref of xrefs || []) {
    const sourceBucket = Math.floor(Number(xref.source_rva || 0) / 0x100) * 0x100;
    if (sourceBucket <= 0) continue;
    const key = numberToHex(sourceBucket);
    let item = buckets.get(key);
    if (!item) {
      item = {
        db_xref_count: 0,
        crypto_xref_count: 0,
        target_patterns: new Set(),
      };
      buckets.set(key, item);
    }
    if (xref.kind === 'crypto') item.crypto_xref_count++;
    else item.db_xref_count++;
    item.target_patterns.add(`${xref.kind}:${xref.pattern}`);
  }
  return buckets;
}

function addCallGraphRegion(regions, regionRva, sourceFunctionKey, callCount, sourceRegionPatterns) {
  const key = numberToHex(regionRva);
  if (!key) return;
  let item = regions.get(key);
  if (!item) {
    const patterns = sourceRegionPatterns.get(key) || null;
    item = {
      target_rva_region: regionRva,
      call_count: 0,
      source_functions: new Set(),
      target_db_xref_count: patterns?.db_xref_count || 0,
      target_crypto_xref_count: patterns?.crypto_xref_count || 0,
      target_patterns: new Set(patterns ? [...patterns.target_patterns] : []),
    };
    regions.set(key, item);
  }
  item.call_count += callCount;
  item.source_functions.add(sourceFunctionKey);
}

function formatCallGraphRegions(regions, limit) {
  return [...regions.values()]
    .map(item => ({
      target_rva_region_hex: numberToHex(item.target_rva_region),
      call_count: item.call_count,
      source_function_count: item.source_functions.size,
      target_db_xref_count: item.target_db_xref_count,
      target_crypto_xref_count: item.target_crypto_xref_count,
      target_patterns: [...item.target_patterns].sort().slice(0, 20),
    }))
    .sort((a, b) => b.call_count - a.call_count || b.source_function_count - a.source_function_count || b.target_db_xref_count - a.target_db_xref_count || b.target_crypto_xref_count - a.target_crypto_xref_count)
    .slice(0, limit);
}

function summarizeStaticFunctionsByRegion(functions, rel32CallIndex) {
  const regions = new Map();
  for (const item of functions.values()) {
    const regionKey = numberToHex(item.function_rva_region);
    if (!regionKey) continue;
    const list = regions.get(regionKey) || [];
    list.push({
      source_section: item.source_section,
      function_rva_bucket_hex: numberToHex(item.function_rva_bucket),
      xref_count: item.xref_count,
      db_xref_count: item.db_xref_count,
      crypto_xref_count: item.crypto_xref_count,
      direct_call_target_count: item.direct_call_target_count,
      direct_call_target_regions: [...item.direct_call_target_regions].sort((a, b) => a - b).slice(0, 8).map(numberToHex),
      target_patterns: [...item.target_patterns].sort().slice(0, 18),
      incoming_call_summary: formatIncomingCallSummary(rel32CallIndex.by_target_bucket.get(numberToHex(item.function_rva_bucket)), MAX_STATIC_XREF_INCOMING_CALLERS),
    });
    regions.set(regionKey, list);
  }
  for (const [key, list] of regions) {
    regions.set(key, list.sort((a, b) => b.xref_count - a.xref_count || b.db_xref_count - a.db_xref_count || b.crypto_xref_count - a.crypto_xref_count).slice(0, MAX_STATIC_XREF_CANDIDATE_REGION_FUNCTIONS));
  }
  return regions;
}

function rankCandidateKeyDerivationRegions(firstHopRegions, secondHopRegions, regionFunctionMap, rel32CallIndex, sourceRegionPatterns, sourceBucketPatterns, buf, pe, functionCallCache) {
  const keys = new Set([...firstHopRegions.keys(), ...secondHopRegions.keys()]);
  return [...keys].map(key => {
    const first = firstHopRegions.get(key) || null;
    const second = secondHopRegions.get(key) || null;
    const targetPatterns = new Set([...(first?.target_patterns || []), ...(second?.target_patterns || [])]);
    const targetDbXrefs = Math.max(Number(first?.target_db_xref_count || 0), Number(second?.target_db_xref_count || 0));
    const targetCryptoXrefs = Math.max(Number(first?.target_crypto_xref_count || 0), Number(second?.target_crypto_xref_count || 0));
    const score = candidateKeyRegionScore({ first, second, targetDbXrefs, targetCryptoXrefs, targetPatterns });
    const regionFunctions = regionFunctionMap.get(key) || [];
    const cryptoBridgePaths = findCryptoBridgePaths(key, rel32CallIndex, sourceRegionPatterns);
    const candidateBridgeCallsitePaths = findCandidateBridgeCallsitePaths(cryptoBridgePaths, rel32CallIndex, sourceRegionPatterns, sourceBucketPatterns);
    return {
      target_rva_region_hex: key,
      priority_score: score,
      first_hop_call_count: Number(first?.call_count || 0),
      first_hop_source_function_count: first?.source_functions?.size || 0,
      second_hop_call_count: Number(second?.call_count || 0),
      second_hop_source_function_count: second?.source_functions?.size || 0,
      target_db_xref_count: targetDbXrefs,
      target_crypto_xref_count: targetCryptoXrefs,
      target_patterns: [...targetPatterns].sort().slice(0, 24),
      selection_reasons: candidateKeyRegionReasons({ first, second, targetDbXrefs, targetCryptoXrefs, targetPatterns }),
      first_hop_source_functions: formatSourceFunctionRefs(first?.source_functions, MAX_STATIC_XREF_CANDIDATE_SOURCE_FUNCTIONS),
      second_hop_source_functions: formatSourceFunctionRefs(second?.source_functions, MAX_STATIC_XREF_CANDIDATE_SOURCE_FUNCTIONS),
      incoming_call_summary: formatIncomingCallSummary(rel32CallIndex.by_target_region.get(key), MAX_STATIC_XREF_INCOMING_CALLERS),
      outgoing_call_summary: formatOutgoingCallSummary(rel32CallIndex.by_source_region.get(key), MAX_STATIC_XREF_OUTGOING_REGIONS, sourceRegionPatterns),
      crypto_bridge_paths: cryptoBridgePaths,
      candidate_bridge_callsite_paths: candidateBridgeCallsitePaths,
      candidate_bridge_resolved_function_paths: resolveCandidateBridgeCallsiteFunctionPaths(candidateBridgeCallsitePaths, buf, pe, sourceBucketPatterns, sourceRegionPatterns),
      candidate_bridge_function_paths: findCandidateBridgeFunctionPaths(regionFunctions, cryptoBridgePaths, rel32CallIndex, buf, pe, functionCallCache, sourceRegionPatterns, sourceBucketPatterns),
      region_functions: regionFunctions,
    };
  })
    .filter(item => item.priority_score > 0)
    .sort((a, b) => b.priority_score - a.priority_score || b.second_hop_source_function_count - a.second_hop_source_function_count || b.first_hop_source_function_count - a.first_hop_source_function_count)
    .slice(0, MAX_STATIC_XREF_CANDIDATE_REGIONS);
}

function candidateKeyRegionScore({ first, second, targetDbXrefs, targetCryptoXrefs, targetPatterns }) {
  let score = 0;
  score += Number(first?.call_count || 0) * 6;
  score += Number(second?.call_count || 0) * 3;
  score += (first?.source_functions?.size || 0) * 20;
  score += (second?.source_functions?.size || 0) * 12;
  score += Math.min(targetDbXrefs, 240) * 5;
  score += Math.min(targetCryptoXrefs, 160) * 4;
  for (const pattern of targetPatterns || []) {
    const weight = patternXrefWeight(pattern);
    if (weight >= 100) score += 160;
    else if (weight >= 70) score += 90;
    else if (weight >= 40) score += 35;
  }
  return score;
}

function candidateKeyRegionReasons({ first, second, targetDbXrefs, targetCryptoXrefs, targetPatterns }) {
  const reasons = [];
  if (first?.call_count) reasons.push('first_hop');
  if (second?.call_count) reasons.push('second_hop');
  if ((first?.source_functions?.size || 0) + (second?.source_functions?.size || 0) >= 8) reasons.push('shared_by_many_priority_functions');
  if (targetDbXrefs > 0) reasons.push('db_xref_region');
  if (targetCryptoXrefs > 0) reasons.push('crypto_xref_region');
  if (hasSqlCipherPattern(targetPatterns)) reasons.push('sqlcipher_or_wcdb_patterns');
  return reasons;
}

function formatSourceFunctionRefs(functionKeys, limit) {
  return [...(functionKeys || [])]
    .map(parseSourceFunctionKey)
    .filter(Boolean)
    .sort((a, b) => a.function_rva_bucket - b.function_rva_bucket)
    .slice(0, limit)
    .map(item => ({
      source_section: item.source_section,
      function_rva_bucket_hex: numberToHex(item.function_rva_bucket),
    }));
}

function parseSourceFunctionKey(key) {
  const value = String(key || '');
  const idx = value.lastIndexOf(':');
  if (idx <= 0) return null;
  const bucket = Number(value.slice(idx + 1));
  if (!Number.isFinite(bucket) || bucket <= 0) return null;
  return {
    source_section: value.slice(0, idx) || 'unknown',
    function_rva_bucket: bucket,
  };
}

function buildStaticRel32CallIndex(buf, pe) {
  const bySourceBucket = new Map();
  const bySourceRegionBuckets = new Map();
  const byTargetRegion = new Map();
  const byTargetBucket = new Map();
  const bySourceRegion = new Map();
  let callCount = 0;
  for (const section of executablePeSections(pe)) {
    const rawStart = Number(section.pointer_to_raw_data || 0);
    const rawSize = Number(section.size_of_raw_data || 0);
    const rawEnd = Math.min(buf.length, rawStart + rawSize);
    if (!rawSize || rawStart < 0 || rawStart >= buf.length) continue;
    const sectionRva = Number(section.virtual_address || 0);
    const sourceSection = section.name || 'unknown';
    for (let raw = rawStart; raw + 5 <= rawEnd; raw++) {
      if (buf[raw] !== 0xe8 && buf[raw] !== 0xe9) continue;
      const rel = buf.readInt32LE(raw + 1);
      const sourceRva = sectionRva + (raw - rawStart);
      const targetRva = sourceRva + 5 + rel;
      if (targetRva <= 0 || !isRvaInExecutableSection(pe, targetRva)) continue;
      callCount++;
      const sourceBucket = Math.floor(sourceRva / 0x100) * 0x100;
      const sourceRegion = Math.floor(sourceRva / 0x10000) * 0x10000;
      const targetBucket = Math.floor(targetRva / 0x100) * 0x100;
      const targetRegion = Math.floor(targetRva / 0x10000) * 0x10000;
      addIncomingCallIndex(byTargetBucket, numberToHex(targetBucket), sourceSection, sourceBucket, sourceRegion);
      addIncomingCallIndex(byTargetRegion, numberToHex(targetRegion), sourceSection, sourceBucket, sourceRegion);
      addOutgoingCallIndex(bySourceRegion, numberToHex(sourceRegion), targetRegion);
      addOutgoingBucketCallIndex(bySourceBucket, sourceSection, sourceBucket, sourceRegion, targetBucket, targetRegion);
      addSourceBucketRegionIndex(bySourceRegionBuckets, sourceRegion, sourceBucket);
    }
  }
  return {
    scan_mode: 'whole_module_rel32_callsite_buckets',
    call_count: callCount,
    by_source_bucket: bySourceBucket,
    by_source_region_buckets: bySourceRegionBuckets,
    by_source_region: bySourceRegion,
    by_target_region: byTargetRegion,
    by_target_bucket: byTargetBucket,
  };
}

function addIncomingCallIndex(map, targetKey, sourceSection, sourceBucket, sourceRegion) {
  if (!targetKey) return;
  let item = map.get(targetKey);
  if (!item) {
    item = { call_count: 0, caller_buckets: new Map(), caller_regions: new Map() };
    map.set(targetKey, item);
  }
  item.call_count++;
  addIncomingCaller(item.caller_buckets, `${sourceSection}:${sourceBucket}`, sourceSection, sourceBucket, 'bucket');
  addIncomingCaller(item.caller_regions, `${sourceSection}:${sourceRegion}`, sourceSection, sourceRegion, 'region');
}

function addIncomingCaller(map, key, sourceSection, sourceRva, kind) {
  let item = map.get(key);
  if (!item) {
    item = {
      source_section: sourceSection || 'unknown',
      source_rva: sourceRva,
      call_count: 0,
      kind,
    };
    map.set(key, item);
  }
  item.call_count++;
}

function addOutgoingCallIndex(map, sourceKey, targetRegion) {
  if (!sourceKey) return;
  let item = map.get(sourceKey);
  if (!item) {
    item = { call_count: 0, target_regions: new Map() };
    map.set(sourceKey, item);
  }
  item.call_count++;
  const targetKey = numberToHex(targetRegion);
  if (!targetKey) return;
  let target = item.target_regions.get(targetKey);
  if (!target) {
    target = { target_rva_region: targetRegion, call_count: 0 };
    item.target_regions.set(targetKey, target);
  }
  target.call_count++;
}

function addOutgoingBucketCallIndex(map, sourceSection, sourceBucket, sourceRegion, targetBucket, targetRegion) {
  const sourceKey = numberToHex(sourceBucket);
  if (!sourceKey) return;
  let item = map.get(sourceKey);
  if (!item) {
    item = {
      source_section: sourceSection || 'unknown',
      source_rva_bucket: sourceBucket,
      source_rva_region: sourceRegion,
      call_count: 0,
      target_buckets: new Map(),
      target_regions: new Map(),
    };
    map.set(sourceKey, item);
  }
  item.call_count++;
  const targetBucketKey = numberToHex(targetBucket);
  if (targetBucketKey) {
    let target = item.target_buckets.get(targetBucketKey);
    if (!target) {
      target = { target_rva_bucket: targetBucket, target_rva_region: targetRegion, call_count: 0 };
      item.target_buckets.set(targetBucketKey, target);
    }
    target.call_count++;
  }
  const targetRegionKey = numberToHex(targetRegion);
  if (targetRegionKey) {
    let region = item.target_regions.get(targetRegionKey);
    if (!region) {
      region = { target_rva_region: targetRegion, call_count: 0 };
      item.target_regions.set(targetRegionKey, region);
    }
    region.call_count++;
  }
}

function addSourceBucketRegionIndex(map, sourceRegion, sourceBucket) {
  const regionKey = numberToHex(sourceRegion);
  const bucketKey = numberToHex(sourceBucket);
  if (!regionKey || !bucketKey) return;
  let buckets = map.get(regionKey);
  if (!buckets) {
    buckets = new Set();
    map.set(regionKey, buckets);
  }
  buckets.add(bucketKey);
}

function formatIncomingCallSummary(item, limit) {
  if (!item) return null;
  return {
    call_count: item.call_count,
    caller_bucket_count: item.caller_buckets.size,
    caller_region_count: item.caller_regions.size,
    caller_buckets: formatIncomingCallers(item.caller_buckets, limit, 'caller_rva_bucket_hex'),
    caller_regions: formatIncomingCallers(item.caller_regions, limit, 'caller_rva_region_hex'),
  };
}

function formatIncomingCallers(map, limit, rvaField) {
  return [...map.values()]
    .map(item => ({
      source_section: item.source_section,
      [rvaField]: numberToHex(item.source_rva),
      call_count: item.call_count,
    }))
    .sort((a, b) => b.call_count - a.call_count || String(a[rvaField]).localeCompare(String(b[rvaField])))
    .slice(0, limit);
}

function formatOutgoingCallSummary(item, limit, sourceRegionPatterns) {
  if (!item) return null;
  return {
    call_count: item.call_count,
    target_region_count: item.target_regions.size,
    target_regions: [...item.target_regions.values()]
      .map(target => {
        const key = numberToHex(target.target_rva_region);
        const patterns = sourceRegionPatterns.get(key) || null;
        return {
          target_rva_region_hex: key,
          call_count: target.call_count,
          target_db_xref_count: patterns?.db_xref_count || 0,
          target_crypto_xref_count: patterns?.crypto_xref_count || 0,
          target_patterns: patterns ? [...patterns.target_patterns].sort().slice(0, 12) : [],
        };
      })
      .sort((a, b) => b.call_count - a.call_count || b.target_crypto_xref_count - a.target_crypto_xref_count || b.target_db_xref_count - a.target_db_xref_count)
      .slice(0, limit),
  };
}

function findCryptoBridgePaths(startRegionKey, rel32CallIndex, sourceRegionPatterns) {
  if (!startRegionKey || !rel32CallIndex?.by_source_region?.has(startRegionKey)) return [];
  const paths = [];
  const queue = [{ region: startRegionKey, path: [startRegionKey], edgeCounts: [], minEdgeCallCount: Infinity }];
  const bestDepth = new Map([[startRegionKey, 0]]);
  while (queue.length && paths.length < MAX_STATIC_XREF_CRYPTO_BRIDGE_PATHS * 4) {
    const current = queue.shift();
    const depth = current.path.length - 1;
    if (depth > 0 && isCryptoXrefRegion(current.region, sourceRegionPatterns)) {
      paths.push(formatCryptoBridgePath(current, sourceRegionPatterns));
      continue;
    }
    if (depth >= MAX_STATIC_XREF_CRYPTO_BRIDGE_DEPTH) continue;
    const outgoing = rel32CallIndex.by_source_region.get(current.region);
    if (!outgoing) continue;
    const nextTargets = [...outgoing.target_regions.values()]
      .sort((a, b) => b.call_count - a.call_count)
      .slice(0, MAX_STATIC_XREF_OUTGOING_REGIONS * 2);
    for (const target of nextTargets) {
      const nextKey = numberToHex(target.target_rva_region);
      if (!nextKey || current.path.includes(nextKey)) continue;
      const nextDepth = depth + 1;
      const knownDepth = bestDepth.get(nextKey);
      if (knownDepth !== undefined && knownDepth <= nextDepth && !isCryptoXrefRegion(nextKey, sourceRegionPatterns)) continue;
      bestDepth.set(nextKey, nextDepth);
      queue.push({
        region: nextKey,
        path: [...current.path, nextKey],
        edgeCounts: [...current.edgeCounts, target.call_count],
        minEdgeCallCount: Math.min(current.minEdgeCallCount, target.call_count),
      });
    }
  }
  return paths
    .sort((a, b) => b.terminal_crypto_xref_count - a.terminal_crypto_xref_count || b.min_edge_call_count - a.min_edge_call_count || a.hop_count - b.hop_count)
    .slice(0, MAX_STATIC_XREF_CRYPTO_BRIDGE_PATHS);
}

function findCandidateBridgeCallsitePaths(regionBridgePaths, rel32CallIndex, sourceRegionPatterns, sourceBucketPatterns) {
  if (!regionBridgePaths?.length || !rel32CallIndex?.by_source_bucket) return [];
  const paths = [];
  for (const bridge of regionBridgePaths.slice(0, MAX_STATIC_XREF_CRYPTO_BRIDGE_PATHS)) {
    const regions = Array.isArray(bridge.path_regions) ? bridge.path_regions.filter(Boolean) : [];
    if (regions.length < 2) continue;
    const edgeChoices = [];
    for (let i = 0; i < regions.length - 1; i++) {
      const choices = bridgeCallsiteEdgeChoices(regions[i], regions[i + 1], rel32CallIndex, sourceBucketPatterns);
      if (!choices.length) {
        edgeChoices.length = 0;
        break;
      }
      edgeChoices.push(choices.slice(0, 4));
    }
    if (!edgeChoices.length) continue;
    const combos = combineBridgeCallsiteEdges(edgeChoices, MAX_STATIC_XREF_BRIDGE_FUNCTION_PATHS * 2);
    for (const combo of combos) {
      const terminalRegionKey = regions[regions.length - 1];
      const terminalRegion = sourceRegionPatterns.get(terminalRegionKey) || null;
      paths.push({
        hop_count: regions.length - 1,
        path_regions: regions,
        edge_source_callsite_buckets: combo.map(edge => edge.source_bucket_hex),
        edge_target_buckets: combo.map(edge => edge.target_bucket_hex),
        edge_call_counts: combo.map(edge => edge.call_count),
        min_edge_call_count: Math.min(...combo.map(edge => edge.call_count)),
        terminal_region_db_xref_count: terminalRegion?.db_xref_count || 0,
        terminal_region_crypto_xref_count: terminalRegion?.crypto_xref_count || 0,
        terminal_patterns: terminalRegion ? [...terminalRegion.target_patterns].sort().slice(0, 18) : [],
      });
    }
  }
  return paths
    .sort((a, b) => b.terminal_region_crypto_xref_count - a.terminal_region_crypto_xref_count
      || b.min_edge_call_count - a.min_edge_call_count
      || a.hop_count - b.hop_count
      || String(a.edge_source_callsite_buckets?.[0] || '').localeCompare(String(b.edge_source_callsite_buckets?.[0] || '')))
    .slice(0, MAX_STATIC_XREF_BRIDGE_FUNCTION_PATHS);
}

function bridgeCallsiteEdgeChoices(sourceRegionKey, targetRegionKey, rel32CallIndex, sourceBucketPatterns) {
  const bucketKeys = rel32CallIndex.by_source_region_buckets?.get(sourceRegionKey) || [];
  const choices = [];
  for (const bucketKey of bucketKeys) {
    const source = rel32CallIndex.by_source_bucket.get(bucketKey);
    if (!source) continue;
    const targetRegion = source.target_regions.get(targetRegionKey);
    if (!targetRegion?.call_count) continue;
    const targetBuckets = [...source.target_buckets.values()]
      .filter(target => numberToHex(target.target_rva_region) === targetRegionKey)
      .sort((a, b) => b.call_count - a.call_count || a.target_rva_bucket - b.target_rva_bucket);
    const topTarget = targetBuckets[0];
    if (!topTarget) continue;
    const patterns = sourceBucketPatterns.get(bucketKey) || null;
    choices.push({
      source_bucket_hex: bucketKey,
      target_bucket_hex: numberToHex(topTarget.target_rva_bucket),
      call_count: targetRegion.call_count,
      source_db_xref_count: patterns?.db_xref_count || 0,
      source_crypto_xref_count: patterns?.crypto_xref_count || 0,
    });
  }
  return choices.sort((a, b) => b.call_count - a.call_count
    || b.source_db_xref_count - a.source_db_xref_count
    || b.source_crypto_xref_count - a.source_crypto_xref_count
    || String(a.source_bucket_hex).localeCompare(String(b.source_bucket_hex)));
}

function combineBridgeCallsiteEdges(edgeChoices, limit) {
  let combos = [[]];
  for (const choices of edgeChoices) {
    const next = [];
    for (const combo of combos) {
      for (const choice of choices) next.push([...combo, choice]);
    }
    combos = next
      .sort((a, b) => Math.min(...b.map(item => item.call_count)) - Math.min(...a.map(item => item.call_count)))
      .slice(0, limit);
  }
  return combos.slice(0, limit);
}

function resolveCandidateBridgeCallsiteFunctionPaths(callsitePaths, buf, pe, sourceBucketPatterns, sourceRegionPatterns) {
  if (!callsitePaths?.length || !buf || !pe) return [];
  const out = [];
  for (const path of callsitePaths.slice(0, MAX_STATIC_XREF_BRIDGE_FUNCTION_PATHS * 2)) {
    const sourceBuckets = Array.isArray(path.edge_source_callsite_buckets) ? path.edge_source_callsite_buckets : [];
    const targetBuckets = Array.isArray(path.edge_target_buckets) ? path.edge_target_buckets : [];
    if (!sourceBuckets.length || sourceBuckets.length !== targetBuckets.length) continue;
    const sourceFunctions = sourceBuckets.map(bucket => resolveEnclosingFunctionBucket(buf, pe, bucket));
    const targetFunctions = targetBuckets.map(bucket => resolveTargetFunctionBucket(buf, pe, bucket));
    const pathFunctionBuckets = [sourceFunctions[0], ...targetFunctions].filter(Boolean);
    if (pathFunctionBuckets.length < 2) continue;
    let continuous = 0;
    for (let i = 0; i + 1 < targetFunctions.length; i++) {
      if (targetFunctions[i] && sourceFunctions[i + 1] && targetFunctions[i] === sourceFunctions[i + 1]) continuous++;
    }
    const terminalFunction = targetFunctions[targetFunctions.length - 1] || '';
    const terminalRegion = path.path_regions?.[path.path_regions.length - 1] || bucketRegionKey(terminalFunction);
    const terminalFunctionPatterns = sourceBucketPatterns.get(terminalFunction) || null;
    const terminalRegionPatterns = sourceRegionPatterns.get(terminalRegion) || null;
    out.push({
      hop_count: sourceBuckets.length,
      path_regions: path.path_regions || [],
      path_function_buckets: pathFunctionBuckets,
      source_function_buckets: sourceFunctions,
      target_function_buckets: targetFunctions,
      edge_source_callsite_buckets: sourceBuckets,
      edge_target_buckets: targetBuckets,
      edge_call_counts: path.edge_call_counts || [],
      continuous_function_hop_count: continuous,
      is_fully_function_continuous: continuous === Math.max(0, sourceBuckets.length - 1),
      terminal_function_db_xref_count: terminalFunctionPatterns?.db_xref_count || 0,
      terminal_function_crypto_xref_count: terminalFunctionPatterns?.crypto_xref_count || 0,
      terminal_region_db_xref_count: terminalRegionPatterns?.db_xref_count || path.terminal_region_db_xref_count || 0,
      terminal_region_crypto_xref_count: terminalRegionPatterns?.crypto_xref_count || path.terminal_region_crypto_xref_count || 0,
      terminal_patterns: [...new Set([...(terminalFunctionPatterns?.target_patterns || []), ...(terminalRegionPatterns?.target_patterns || [])])].sort().slice(0, 18),
      path_function_xref_summary: summarizePathFunctionXrefs(pathFunctionBuckets, sourceBucketPatterns),
    });
  }
  return out
    .sort((a, b) => Number(b.is_fully_function_continuous) - Number(a.is_fully_function_continuous)
      || b.continuous_function_hop_count - a.continuous_function_hop_count
      || b.terminal_function_crypto_xref_count - a.terminal_function_crypto_xref_count
      || b.terminal_region_crypto_xref_count - a.terminal_region_crypto_xref_count
      || b.hop_count - a.hop_count
      || String(a.path_function_buckets?.[0] || '').localeCompare(String(b.path_function_buckets?.[0] || '')))
    .slice(0, MAX_STATIC_XREF_BRIDGE_FUNCTION_PATHS);
}

function resolveEnclosingFunctionBucket(buf, pe, bucketHex) {
  const bucket = parseHexRva(bucketHex);
  if (!bucket) return '';
  const section = findPeSectionByRva(pe, bucket);
  if (!section) return bucketHex || '';
  const probeRva = bucket + 0x80;
  const raw = rvaToRawInSection(section, probeRva) || rvaToRawInSection(section, bucket);
  if (!raw) return bucketHex || '';
  const fn = findNearestX64FunctionStart(buf, pe, raw, probeRva) || null;
  if (!fn?.rva) return bucketHex || '';
  return numberToHex(Math.floor(Number(fn.rva) / 0x100) * 0x100);
}

function resolveTargetFunctionBucket(buf, pe, bucketHex) {
  const bucket = parseHexRva(bucketHex);
  if (!bucket) return '';
  const section = findPeSectionByRva(pe, bucket);
  if (!section) return bucketHex || '';
  const rawStart = rvaToRawInSection(section, bucket);
  const rawEnd = rvaToRawInSection(section, bucket + 0xff);
  if (rawStart && rawEnd && rawEnd >= rawStart) {
    for (let raw = rawStart; raw <= rawEnd && raw + 8 < buf.length; raw++) {
      if (!looksLikeX64FunctionPrologue(buf, raw)) continue;
      const rva = rawToRvaInSection(section, raw);
      if (rva) return numberToHex(Math.floor(rva / 0x100) * 0x100);
    }
  }
  return resolveEnclosingFunctionBucket(buf, pe, bucketHex);
}

function findCandidateBridgeFunctionPaths(regionFunctions, regionBridgePaths, rel32CallIndex, buf, pe, functionCallCache, sourceRegionPatterns, sourceBucketPatterns) {
  if (!regionFunctions?.length || !regionBridgePaths?.length || !buf || !pe) return [];
  const paths = [];
  const starts = [...regionFunctions]
    .map(item => ({
      item,
      bucket_rva: parseHexRva(item.function_rva_bucket_hex),
      score: bridgeFunctionStartScore(item),
    }))
    .filter(entry => entry.bucket_rva > 0)
    .sort((a, b) => b.score - a.score || a.bucket_rva - b.bucket_rva)
    .slice(0, MAX_STATIC_XREF_BRIDGE_FUNCTION_STARTS);
  for (const bridge of regionBridgePaths.slice(0, MAX_STATIC_XREF_CRYPTO_BRIDGE_PATHS)) {
    const bridgeRegions = Array.isArray(bridge.path_regions) ? bridge.path_regions.filter(Boolean) : [];
    if (bridgeRegions.length < 2) continue;
    const indexedStarts = bridgeStartBucketsForRegionPath(bridgeRegions, starts, rel32CallIndex, sourceBucketPatterns);
    for (const start of indexedStarts) {
      const startBucketKey = start.source_bucket_hex;
      let states = [{
        current_bucket: startBucketKey,
        path_buckets: [startBucketKey],
        path_regions: [bridgeRegions[0]],
        edge_counts: [],
      }];
      for (let hop = 1; hop < bridgeRegions.length && states.length; hop++) {
        const nextRegion = bridgeRegions[hop];
        const nextStates = [];
        for (const state of states) {
          const sourceBucket = rel32CallIndex?.by_source_bucket?.get(state.current_bucket);
          const targets = sortBridgeBucketTargets(sourceBucket?.target_buckets?.values?.() ? [...sourceBucket.target_buckets.values()] : [], sourceRegionPatterns, sourceBucketPatterns)
            .filter(target => numberToHex(target.target_rva_region) === nextRegion)
            .slice(0, MAX_STATIC_XREF_BRIDGE_FUNCTION_TARGETS);
          for (const target of targets) {
            const targetBucket = numberToHex(target.target_rva_bucket);
            if (!targetBucket || state.path_buckets.includes(targetBucket)) continue;
            nextStates.push({
              current_bucket: targetBucket,
              path_buckets: [...state.path_buckets, targetBucket],
              path_regions: [...state.path_regions, nextRegion],
              edge_counts: [...state.edge_counts, target.call_count],
            });
          }
        }
        states = nextStates.slice(0, MAX_STATIC_XREF_BRIDGE_FUNCTION_TARGETS * 2);
      }
      for (const state of states) {
        const terminalBucket = state.path_buckets[state.path_buckets.length - 1];
        const terminalRegion = state.path_regions[state.path_regions.length - 1];
        if (!isCryptoXrefFunctionOrRegion(terminalBucket, terminalRegion, sourceBucketPatterns, sourceRegionPatterns)) continue;
        paths.push(formatCandidateBridgeFunctionPath(state, sourceBucketPatterns, sourceRegionPatterns));
        if (paths.length >= MAX_STATIC_XREF_BRIDGE_FUNCTION_PATHS * 4) break;
      }
      if (paths.length >= MAX_STATIC_XREF_BRIDGE_FUNCTION_PATHS * 4) break;
    }
    if (paths.length >= MAX_STATIC_XREF_BRIDGE_FUNCTION_PATHS * 4) break;
  }
  if (paths.length) {
    return paths
      .sort((a, b) => b.terminal_function_crypto_xref_count - a.terminal_function_crypto_xref_count
        || b.terminal_region_crypto_xref_count - a.terminal_region_crypto_xref_count
        || a.hop_count - b.hop_count
        || String(a.path_function_buckets?.[0] || '').localeCompare(String(b.path_function_buckets?.[0] || '')))
      .slice(0, MAX_STATIC_XREF_BRIDGE_FUNCTION_PATHS);
  }
  for (const start of starts) {
    const startKey = sourceFunctionKeyFromSummary(start.item);
    const startBucketKey = numberToHex(start.bucket_rva);
    const startRegionKey = bucketRegionKey(startBucketKey);
    const directTargets = directTargetsForFunctionSummary(start.item, buf, pe, functionCallCache);
    const sortedDirectTargets = sortBridgeTargets(directTargets, sourceRegionPatterns, sourceBucketPatterns)
      .slice(0, MAX_STATIC_XREF_BRIDGE_FUNCTION_TARGETS);
    const queue = sortedDirectTargets.map(targetRva => {
      const targetBucket = numberToHex(Math.floor(targetRva / 0x100) * 0x100);
      const targetRegion = bucketRegionKey(targetBucket);
      return {
        current_rva: targetRva,
        path_buckets: [startBucketKey, targetBucket],
        path_regions: [startRegionKey, targetRegion],
        edge_counts: [1],
      };
    });
    const seen = new Set(queue.map(item => `${startKey}:${item.path_buckets.join('>')}`));
    while (queue.length && paths.length < MAX_STATIC_XREF_BRIDGE_FUNCTION_PATHS * 4) {
      const current = queue.shift();
      const terminalBucket = current.path_buckets[current.path_buckets.length - 1];
      const terminalRegion = current.path_regions[current.path_regions.length - 1];
      const depth = current.path_buckets.length - 1;
      if (depth > 0 && isCryptoXrefFunctionOrRegion(terminalBucket, terminalRegion, sourceBucketPatterns, sourceRegionPatterns)) {
        paths.push(formatCandidateBridgeFunctionPath(current, sourceBucketPatterns, sourceRegionPatterns));
        continue;
      }
      if (depth >= MAX_STATIC_XREF_CRYPTO_BRIDGE_DEPTH) continue;
      const nextTargets = sortBridgeTargets(getSecondHopTargetsForRva(buf, pe, current.current_rva, functionCallCache), sourceRegionPatterns, sourceBucketPatterns)
        .slice(0, MAX_STATIC_XREF_BRIDGE_FUNCTION_TARGETS);
      for (const targetRva of nextTargets) {
        const targetBucket = numberToHex(Math.floor(targetRva / 0x100) * 0x100);
        const targetRegion = bucketRegionKey(targetBucket);
        if (!targetBucket || current.path_buckets.includes(targetBucket)) continue;
        const key = `${startKey}:${[...current.path_buckets, targetBucket].join('>')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push({
          current_rva: targetRva,
          path_buckets: [...current.path_buckets, targetBucket],
          path_regions: [...current.path_regions, targetRegion],
          edge_counts: [...current.edge_counts, 1],
        });
      }
    }
  }
  return paths
    .sort((a, b) => b.terminal_function_crypto_xref_count - a.terminal_function_crypto_xref_count
      || b.terminal_region_crypto_xref_count - a.terminal_region_crypto_xref_count
      || a.hop_count - b.hop_count
      || String(a.path_function_buckets?.[0] || '').localeCompare(String(b.path_function_buckets?.[0] || '')))
    .slice(0, MAX_STATIC_XREF_BRIDGE_FUNCTION_PATHS);
}

function bridgeFunctionStartScore(item) {
  let score = Number(item?.xref_count || 0) * 2 + Number(item?.db_xref_count || 0) * 6 + Number(item?.crypto_xref_count || 0) * 3 + Number(item?.direct_call_target_count || 0);
  if (hasSqlCipherPattern(item?.target_patterns || [])) score += 120;
  return score;
}

function bridgeStartBucketsForRegionPath(bridgeRegions, priorityStarts, rel32CallIndex, sourceBucketPatterns) {
  const startRegion = bridgeRegions[0];
  const nextRegion = bridgeRegions[1];
  const priorityBuckets = new Set(priorityStarts.map(item => numberToHex(item.bucket_rva)).filter(Boolean));
  const starts = [];
  for (const item of rel32CallIndex?.by_source_bucket?.values?.() || []) {
    if (numberToHex(item.source_rva_region) !== startRegion) continue;
    let callsToNextRegion = 0;
    for (const target of item.target_regions.values()) {
      if (numberToHex(target.target_rva_region) === nextRegion) callsToNextRegion += target.call_count;
    }
    if (!callsToNextRegion) continue;
    const bucketKey = numberToHex(item.source_rva_bucket);
    const patterns = sourceBucketPatterns.get(bucketKey) || null;
    starts.push({
      source_bucket_hex: bucketKey,
      calls_to_next_region: callsToNextRegion,
      is_priority_xref_bucket: priorityBuckets.has(bucketKey),
      db_xref_count: patterns?.db_xref_count || 0,
      crypto_xref_count: patterns?.crypto_xref_count || 0,
    });
  }
  return starts
    .sort((a, b) => Number(b.is_priority_xref_bucket) - Number(a.is_priority_xref_bucket)
      || b.calls_to_next_region - a.calls_to_next_region
      || b.db_xref_count - a.db_xref_count
      || b.crypto_xref_count - a.crypto_xref_count
      || String(a.source_bucket_hex).localeCompare(String(b.source_bucket_hex)))
    .slice(0, MAX_STATIC_XREF_BRIDGE_FUNCTION_STARTS);
}

function sourceFunctionKeyFromSummary(item) {
  const bucket = parseHexRva(item?.function_rva_bucket_hex);
  if (!bucket) return '';
  return `${item?.source_section || 'unknown'}:${bucket}`;
}

function directTargetsForFunctionSummary(item, buf, pe, functionCallCache) {
  const key = sourceFunctionKeyFromSummary(item);
  if (key && functionCallCache?.has(key)) return functionCallCache.get(key) || [];
  const bucket = parseHexRva(item?.function_rva_bucket_hex);
  if (!bucket) return [];
  const section = findPeSectionByRva(pe, bucket);
  if (!section) return [];
  const raw = rvaToRawInSection(section, bucket);
  if (!raw) return [];
  const targets = scanDirectCallTargetsForFunction(buf, pe, { raw, rva: bucket });
  if (key && functionCallCache) functionCallCache.set(key, targets);
  return targets;
}

function sortBridgeTargets(targets, sourceRegionPatterns, sourceBucketPatterns) {
  return [...new Set((targets || []).filter(target => Number(target || 0) > 0))]
    .sort((a, b) => bridgeTargetScore(b, sourceRegionPatterns, sourceBucketPatterns) - bridgeTargetScore(a, sourceRegionPatterns, sourceBucketPatterns) || a - b);
}

function sortBridgeBucketTargets(targets, sourceRegionPatterns, sourceBucketPatterns) {
  return [...(targets || [])]
    .filter(target => Number(target?.target_rva_bucket || 0) > 0)
    .sort((a, b) => Number(b.call_count || 0) - Number(a.call_count || 0)
      || bridgeTargetScore(Number(b.target_rva_bucket || 0), sourceRegionPatterns, sourceBucketPatterns) - bridgeTargetScore(Number(a.target_rva_bucket || 0), sourceRegionPatterns, sourceBucketPatterns)
      || Number(a.target_rva_bucket || 0) - Number(b.target_rva_bucket || 0));
}

function bridgeTargetScore(targetRva, sourceRegionPatterns, sourceBucketPatterns) {
  const bucketKey = numberToHex(Math.floor(Number(targetRva || 0) / 0x100) * 0x100);
  const regionKey = bucketRegionKey(bucketKey);
  const bucket = sourceBucketPatterns.get(bucketKey) || null;
  const region = sourceRegionPatterns.get(regionKey) || null;
  let score = 1;
  score += Number(bucket?.crypto_xref_count || 0) * 120;
  score += Number(region?.crypto_xref_count || 0) * 80;
  score += Number(bucket?.db_xref_count || 0) * 24;
  score += Number(region?.db_xref_count || 0) * 12;
  for (const pattern of [...(bucket?.target_patterns || []), ...(region?.target_patterns || [])]) {
    const weight = patternXrefWeight(pattern);
    if (weight >= 100) score += 80;
    else if (weight >= 70) score += 40;
    else if (weight >= 40) score += 24;
  }
  return score;
}

function isCryptoXrefFunctionOrRegion(bucketKey, regionKey, sourceBucketPatterns, sourceRegionPatterns) {
  const bucket = sourceBucketPatterns.get(bucketKey);
  if (Number(bucket?.crypto_xref_count || 0) > 0) return true;
  return isCryptoXrefRegion(regionKey, sourceRegionPatterns);
}

function formatCandidateBridgeFunctionPath(path, sourceBucketPatterns, sourceRegionPatterns) {
  const terminalBucketKey = path.path_buckets[path.path_buckets.length - 1];
  const terminalRegionKey = path.path_regions[path.path_regions.length - 1];
  const terminalBucket = sourceBucketPatterns.get(terminalBucketKey) || null;
  const terminalRegion = sourceRegionPatterns.get(terminalRegionKey) || null;
  return {
    hop_count: path.path_buckets.length - 1,
    path_function_buckets: path.path_buckets,
    path_regions: path.path_regions,
    edge_observed_counts: path.edge_counts,
    terminal_function_db_xref_count: terminalBucket?.db_xref_count || 0,
    terminal_function_crypto_xref_count: terminalBucket?.crypto_xref_count || 0,
    terminal_region_db_xref_count: terminalRegion?.db_xref_count || 0,
    terminal_region_crypto_xref_count: terminalRegion?.crypto_xref_count || 0,
    terminal_patterns: [...new Set([...(terminalBucket?.target_patterns || []), ...(terminalRegion?.target_patterns || [])])].sort().slice(0, 18),
    path_function_xref_summary: summarizePathFunctionXrefs(path.path_buckets, sourceBucketPatterns),
  };
}

function summarizePathFunctionXrefs(functionBuckets, sourceBucketPatterns) {
  const functions = uniqueHexBucketList(functionBuckets).slice(0, MAX_STATIC_XREF_FUNCTION_XREF_FUNCTIONS);
  const aggregate = new Map();
  const functionSummaries = [];
  for (const functionBucket of functions) {
    const functionRva = parseHexRva(functionBucket);
    if (!functionRva) continue;
    const nearby = [];
    for (const [bucketKey, patterns] of sourceBucketPatterns || []) {
      const bucketRva = parseHexRva(bucketKey);
      if (!bucketRva) continue;
      const distance = Math.abs(bucketRva - functionRva);
      if (distance > STATIC_XREF_FUNCTION_XREF_NEIGHBOR_RADIUS) continue;
      nearby.push({ bucketKey, bucketRva, distance, patterns });
      if (!aggregate.has(bucketKey)) aggregate.set(bucketKey, patterns);
    }
    nearby.sort((a, b) => a.distance - b.distance
      || patternSetScore(b.patterns?.target_patterns) - patternSetScore(a.patterns?.target_patterns)
      || String(a.bucketKey).localeCompare(String(b.bucketKey)));
    functionSummaries.push({
      function_rva_bucket_hex: functionBucket,
      nearby_xref_bucket_count: nearby.length,
      nearest_xref_buckets: nearby.slice(0, MAX_STATIC_XREF_FUNCTION_XREF_NEIGHBOR_BUCKETS).map(item => ({
        source_rva_bucket_hex: item.bucketKey,
        distance_bytes: item.distance,
        db_xref_count: item.patterns?.db_xref_count || 0,
        crypto_xref_count: item.patterns?.crypto_xref_count || 0,
        target_patterns: sortXrefPatternList(item.patterns?.target_patterns, 10),
      })),
    });
  }
  const targetPatterns = new Set();
  let dbXrefCount = 0;
  let cryptoXrefCount = 0;
  for (const patterns of aggregate.values()) {
    dbXrefCount += Number(patterns?.db_xref_count || 0);
    cryptoXrefCount += Number(patterns?.crypto_xref_count || 0);
    for (const pattern of patterns?.target_patterns || []) targetPatterns.add(pattern);
  }
  return {
    function_bucket_count: functions.length,
    nearby_xref_bucket_count: aggregate.size,
    db_xref_count: dbXrefCount,
    crypto_xref_count: cryptoXrefCount,
    sqlcipher_pattern_count: [...targetPatterns].filter(pattern => patternXrefWeight(pattern) >= 70).length,
    crypto_pattern_count: [...targetPatterns].filter(pattern => /aes|hmac|sha|hkdf|derive|encrypt|decrypt/i.test(String(pattern || ''))).length,
    target_patterns: sortXrefPatternList(targetPatterns, 18),
    functions: functionSummaries.filter(item => item.nearby_xref_bucket_count > 0).slice(0, MAX_STATIC_XREF_FUNCTION_XREF_FUNCTIONS),
  };
}

function uniqueHexBucketList(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const rva = parseHexRva(value);
    if (!rva) continue;
    const key = numberToHex(rva);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function sortXrefPatternList(patterns, limit) {
  return [...(patterns || [])]
    .sort((a, b) => patternXrefWeight(b) - patternXrefWeight(a) || String(a).localeCompare(String(b)))
    .slice(0, limit);
}

function patternSetScore(patterns) {
  let score = 0;
  for (const pattern of patterns || []) score += patternXrefWeight(pattern);
  return score;
}

function bucketRegionKey(bucketKey) {
  const bucket = parseHexRva(bucketKey);
  return bucket > 0 ? numberToHex(Math.floor(bucket / 0x10000) * 0x10000) : '';
}

function isCryptoXrefRegion(regionKey, sourceRegionPatterns) {
  const patterns = sourceRegionPatterns.get(regionKey);
  return Number(patterns?.crypto_xref_count || 0) > 0;
}

function formatCryptoBridgePath(path, sourceRegionPatterns) {
  const terminal = sourceRegionPatterns.get(path.region) || null;
  return {
    hop_count: path.path.length - 1,
    path_regions: path.path,
    edge_call_counts: path.edgeCounts,
    min_edge_call_count: Number.isFinite(path.minEdgeCallCount) ? path.minEdgeCallCount : 0,
    terminal_db_xref_count: terminal?.db_xref_count || 0,
    terminal_crypto_xref_count: terminal?.crypto_xref_count || 0,
    terminal_patterns: terminal ? [...terminal.target_patterns].sort().slice(0, 16) : [],
  };
}

function getSecondHopTargetsForRva(buf, pe, targetRva, cache) {
  const section = findPeSectionByRva(pe, targetRva);
  if (!section) return [];
  const targetRaw = rvaToRawInSection(section, targetRva);
  if (!targetRaw) return [];
  const fn = findNearestX64FunctionStart(buf, pe, targetRaw, targetRva) || { raw: targetRaw, rva: targetRva };
  const key = `${section.name || 'unknown'}:${Math.floor(Number(fn.rva || targetRva) / 0x100) * 0x100}`;
  if (!cache.has(key)) cache.set(key, scanDirectCallTargetsForFunction(buf, pe, fn));
  return cache.get(key) || [];
}

function scanDirectCallTargetsForFunction(buf, pe, fn) {
  const sourceRva = Number(fn?.rva || 0);
  const sourceRaw = Number(fn?.raw || -1);
  if (sourceRaw < 0 || sourceRva <= 0) return [];
  const section = findPeSectionByRva(pe, sourceRva);
  if (!section) return [];
  const rawStart = Number(section.pointer_to_raw_data || 0);
  const rawEnd = Math.min(buf.length, rawStart + Number(section.size_of_raw_data || 0));
  const start = Math.max(rawStart, sourceRaw);
  const end = Math.min(rawEnd, start + 0x900);
  const sectionRva = Number(section.virtual_address || 0);
  return scanDirectCallTargetsInRange(buf, pe, start, end, rawStart, sectionRva);
}

function scanDirectCallTargetsInRange(buf, pe, start, end, sectionRawStart, sectionRva) {
  const targets = new Set();
  for (let raw = start; raw + 5 <= end; raw++) {
    if (buf[raw] !== 0xe8 && buf[raw] !== 0xe9) continue;
    const rel = buf.readInt32LE(raw + 1);
    const callSourceRva = sectionRva + (raw - sectionRawStart);
    const target = callSourceRva + 5 + rel;
    if (target <= 0 || !isRvaInExecutableSection(pe, target)) continue;
    targets.add(target);
  }
  return [...targets];
}

function staticFunctionPriorityScore(item) {
  let score = Number(item.xref_count || 0) * 2 + Number(item.db_xref_count || 0) * 4 + Number(item.crypto_xref_count || 0) * 3 + Number(item.direct_call_target_count || 0);
  for (const pattern of item.target_patterns || []) score += patternXrefWeight(pattern) >= 70 ? 20 : patternXrefWeight(pattern) >= 40 ? 8 : 0;
  return score;
}

function hasSqlCipherPattern(patterns) {
  for (const pattern of patterns || []) {
    if (/sqlcipher|cipher|wcdb|pbkdf|hmac_sha|sqlite3_key|kdf_iter/i.test(String(pattern || ''))) return true;
  }
  return false;
}

function findNearestX64FunctionStart(buf, pe, sourceRaw, sourceRva) {
  const section = findPeSectionByRva(pe, sourceRva);
  const minRaw = section ? Number(section.pointer_to_raw_data || 0) : Math.max(0, sourceRaw - 0x800);
  const start = Math.max(minRaw, sourceRaw - 0x800);
  let best = null;
  for (let raw = sourceRaw; raw >= start; raw--) {
    if (!looksLikeX64FunctionPrologue(buf, raw)) continue;
    const rva = rawToRvaInSection(section, raw);
    if (!rva) continue;
    best = { raw, rva };
    break;
  }
  return best;
}

function findPeSectionByRva(pe, rva) {
  const value = Number(rva || 0);
  for (const section of pe?.sections || []) {
    const start = Number(section.virtual_address || 0);
    const size = Math.max(Number(section.virtual_size || 0), Number(section.size_of_raw_data || 0));
    if (size && value >= start && value < start + size) return section;
  }
  return null;
}

function rawToRvaInSection(section, raw) {
  if (!section) return 0;
  const rawStart = Number(section.pointer_to_raw_data || 0);
  const rawSize = Number(section.size_of_raw_data || 0);
  if (!rawSize || raw < rawStart || raw >= rawStart + rawSize) return 0;
  return Number(section.virtual_address || 0) + (raw - rawStart);
}

function rvaToRawInSection(section, rva) {
  if (!section) return 0;
  const sectionRva = Number(section.virtual_address || 0);
  const rawStart = Number(section.pointer_to_raw_data || 0);
  const rawSize = Number(section.size_of_raw_data || 0);
  const virtualSize = Number(section.virtual_size || rawSize || 0);
  const size = Math.max(rawSize, virtualSize);
  if (!size || rva < sectionRva || rva >= sectionRva + size) return 0;
  const raw = rawStart + (rva - sectionRva);
  return raw >= rawStart && raw < rawStart + rawSize ? raw : 0;
}

function looksLikeX64FunctionPrologue(buf, raw) {
  if (raw < 0 || raw + 8 >= buf.length) return false;
  const b0 = buf[raw];
  const b1 = buf[raw + 1];
  const b2 = buf[raw + 2];
  const b3 = buf[raw + 3];
  const b4 = buf[raw + 4];
  if (b0 === 0x40 && (b1 === 0x53 || b1 === 0x55 || b1 === 0x56 || b1 === 0x57)) return true;
  if (b0 === 0x48 && b1 === 0x83 && b2 === 0xec) return true;
  if (b0 === 0x48 && b1 === 0x81 && b2 === 0xec) return true;
  if (b0 === 0x48 && b1 === 0x89 && (b2 === 0x5c || b2 === 0x6c || b2 === 0x74 || b2 === 0x7c)) return true;
  if (b0 === 0x48 && b1 === 0x8b && b2 === 0xc4) return true;
  if (b0 === 0x4c && b1 === 0x8b && b2 === 0xdc) return true;
  if (b0 === 0x55 && b1 === 0x48 && b2 === 0x8b && b3 === 0xec) return true;
  if (b0 === 0x55 && b1 === 0x56 && b2 === 0x57) return true;
  if (b0 === 0x48 && b1 === 0x89 && b2 === 0x4c && b3 === 0x24 && b4 <= 0x78) return true;
  return false;
}

function scanDirectCallTargetsNearXref(buf, pe, sourceRaw, sourceRva, fn) {
  const section = findPeSectionByRva(pe, sourceRva);
  const rawStart = section ? Number(section.pointer_to_raw_data || 0) : Math.max(0, sourceRaw - 0x400);
  const rawEnd = section ? rawStart + Number(section.size_of_raw_data || 0) : Math.min(buf.length, sourceRaw + 0x400);
  const start = Math.max(rawStart, fn?.raw ? fn.raw : sourceRaw - 0x260);
  const end = Math.min(rawEnd, sourceRaw + 0x300, start + 0x900);
  const sectionRva = section ? Number(section.virtual_address || 0) : sourceRva - (sourceRaw - rawStart);
  return scanDirectCallTargetsInRange(buf, pe, start, end, rawStart, sectionRva);
}

function isRvaInExecutableSection(pe, rva) {
  const section = findPeSectionByRva(pe, rva);
  if (!section) return false;
  return executablePeSections(pe).includes(section);
}

function targetKindWeight(kind) {
  return kind === 'db' ? 2 : 1;
}

function patternXrefWeight(pattern) {
  const text = String(pattern || '').toLowerCase();
  if (/sqlcipher|sqlite3_key|cipher_page_size|cipher_hmac|cipher_kdf|pbkdf|hmac_sha|wcdb/.test(text)) return 100;
  if (/sqlite|pragma|cipher|db_storage|xwechat|message_|contact\.db|session\.db/.test(text)) return 70;
  if (/aes|hmac|sha|hkdf|derive|encrypt|decrypt/.test(text)) return 40;
  return 1;
}

function addStringClusterHit(buckets, hit, kind) {
  const rva = Number(hit?.rva || 0);
  if (!Number.isFinite(rva) || rva <= 0) return;
  const section = hit.section || 'unknown';
  const bucketRva = Math.floor(rva / 0x1000) * 0x1000;
  const key = `${section}:${bucketRva}`;
  let item = buckets.get(key);
  if (!item) {
    item = {
      section,
      rva_bucket: bucketRva,
      hit_count: 0,
      db_hit_count: 0,
      crypto_hit_count: 0,
      patterns: new Set(),
      db_patterns: new Set(),
      crypto_patterns: new Set(),
    };
    buckets.set(key, item);
  }
  item.hit_count++;
  const pattern = String(hit.pattern || '').slice(0, 80);
  if (pattern) item.patterns.add(pattern);
  if (kind === 'crypto') {
    item.crypto_hit_count++;
    if (pattern) item.crypto_patterns.add(pattern);
  } else {
    item.db_hit_count++;
    if (pattern) item.db_patterns.add(pattern);
  }
}

function numberToHex(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `0x${Math.trunc(n).toString(16)}`;
}

function parseHexRva(value) {
  const text = String(value || '').trim();
  if (!/^0x[0-9a-f]+$/i.test(text)) return 0;
  const n = Number.parseInt(text.slice(2), 16);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function pickAccount(accounts, accountId = '') {
  if (!accounts?.length) return null;
  const requested = String(accountId || '').trim();
  if (requested) {
    const matches = accounts.filter(a => accountMatchesId(a, requested));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw Object.assign(new Error('账号标识不唯一，请在页面右上角重新选择微信账号后再试。'), {
        status: 400,
        code: 'account_selection_ambiguous',
        public_code: 'account_selection_ambiguous',
      });
    }
    return null;
  }
  if (accounts.length === 1) return accounts[0];
  throw Object.assign(new Error('检测到多个微信账号，请先在右上角明确选择账号后再继续。'), {
    status: 400,
    code: 'account_required',
    public_code: 'account_required',
  });
}

function accountOpaqueId(dbStorage = '') {
  const normalized = platformPathIdentity(path.resolve(String(dbStorage || ''))
    .replace(/[\\/]+$/g, ''));
  const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return `wxacc_${hash}`;
}

function unreadableSourceAccountId(dbStorage = '') {
  const normalized = platformPathIdentity(path.resolve(String(dbStorage || ''))
    .replace(/[\\/]+$/g, ''));
  const hash = crypto.createHash('sha256').update(`unreadable\0${normalized}`).digest('hex').slice(0, 16);
  return `wxunreadable_${hash}`;
}

function accountMatchesId(account = {}, requested = '') {
  const needle = String(requested || '').trim();
  if (!needle) return false;
  return [
    account.account_id,
    account.id,
    account.legacy_id,
    account.wxid,
    account.account,
    ...(Array.isArray(account.account_aliases) ? account.account_aliases : []),
  ].some(value => String(value || '').trim() === needle);
}

function mirrorSegmentForRequestedOfflineAccount(indexJson = {}, requested = '') {
  const needle = String(requested || '').trim().toLowerCase();
  if (!needle) return '';
  const matches = Object.entries(indexJson?.accounts || {}).filter(([key, item]) => {
    const candidate = { ...(plainObject(item) ? item : {}), account_id: key, id: key };
    return [
      candidate.account_id,
      candidate.id,
      candidate.legacy_id,
      candidate.wxid,
      candidate.account,
      ...(Array.isArray(candidate.account_aliases) ? candidate.account_aliases : []),
    ].some(value => String(value || '').trim().toLowerCase() === needle);
  });
  if (matches.length > 1) {
    throw Object.assign(new Error('当前请求对应多个本地工作数据账号，已拒绝按别名猜测离线副本。请明确选择账号后重试。'), {
      status: 409,
      code: 'wxdb_source_account_ambiguous',
      public_code: 'wxdb_source_account_ambiguous',
    });
  }
  return matches.length === 1
    ? safeMirrorSegment(matches[0][1]?.mirror_segment || matches[0][0])
    : '';
}

async function readWxDbDirEntries(dir, { signal = null, label = '数据库目录' } = {}) {
  throwIfDiscoveryAborted(signal);
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (isDiscoveryAbort(e, signal)) throw e;
    if (e?.code === 'ENOENT') return [];
    throw Object.assign(new Error(`${label}读取失败，已拒绝把不可读目录当作空目录更新本地工作数据：${e?.message || String(e)}`), {
      status: 409,
      code: 'wxdb_source_directory_unreadable',
      public_code: 'wxdb_source_directory_unreadable',
      cause: e,
    });
  }
}

async function statWxDbSourceFile(file, { signal = null } = {}) {
  throwIfDiscoveryAborted(signal);
  try {
    return await fsp.lstat(file);
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw Object.assign(new Error(`源数据库文件状态读取失败，已拒绝生成部分源快照：${e?.message || String(e)}`), {
      status: 409,
      code: 'wxdb_source_file_unreadable',
      public_code: 'wxdb_source_file_unreadable',
      cause: e,
    });
  }
}

async function statWxDbSourceSidecar(file, { signal = null } = {}) {
  throwIfDiscoveryAborted(signal);
  try {
    return await fsp.lstat(file);
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw Object.assign(new Error(`源数据库 WAL 状态读取失败，已拒绝生成部分源快照：${e?.message || String(e)}`), {
      status: 409,
      code: 'wxdb_source_sidecar_unreadable',
      public_code: 'wxdb_source_sidecar_unreadable',
      cause: e,
    });
  }
}

export async function listDbFiles(account, category = '', { signal = null, strictSnapshot = false } = {}) {
  throwIfDiscoveryAborted(signal);
  if (!account?.db_storage) return [];
  const roots = [];
  if (category) roots.push(path.join(account.db_storage, category));
  else {
    const dirs = await readWxDbDirEntries(account.db_storage, { signal, label: '微信数据库根目录' });
    throwIfDiscoveryAborted(signal);
    for (const entry of dirs) if (entry.isDirectory()) roots.push(path.join(account.db_storage, entry.name));
  }
  const files = [];
  for (const root of roots) {
    throwIfDiscoveryAborted(signal);
    const entries = await readWxDbDirEntries(root, { signal, label: `微信数据库分类目录 ${path.basename(root)}` });
    throwIfDiscoveryAborted(signal);
    for (const entry of entries) {
      throwIfDiscoveryAborted(signal);
      if (!entry.name.toLowerCase().endsWith('.db')) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        if (strictSnapshot) {
          throw Object.assign(new Error(`源数据库文件清单包含非普通文件或符号链接，已拒绝更新本地工作数据：${entry.name}`), {
            status: 403,
            code: 'wxdb_source_not_regular_file',
            public_code: 'wxdb_source_not_regular_file',
          });
        }
        continue;
      }
      const full = path.join(root, entry.name);
      const st = await statWxDbSourceFile(full, { signal });
      throwIfDiscoveryAborted(signal);
      if (!st) {
        if (strictSnapshot) {
          throw Object.assign(new Error(`源数据库文件在快照枚举期间消失，已拒绝用不完整快照更新本地工作数据：${entry.name}`), {
            status: 409,
            code: 'wxdb_source_snapshot_unstable',
            public_code: 'wxdb_source_snapshot_unstable',
          });
        }
        continue;
      }
      if (!st.isFile() || st.isSymbolicLink()) {
        if (strictSnapshot) {
          throw Object.assign(new Error(`源数据库文件清单包含非普通文件或符号链接，已拒绝更新本地工作数据：${entry.name}`), {
            status: 403,
            code: 'wxdb_source_not_regular_file',
            public_code: 'wxdb_source_not_regular_file',
          });
        }
        continue;
      }
      const sidecars = await listDbSidecarStats(full, { signal });
      const effectiveMtimeMs = Math.max(st.mtimeMs, ...sidecars.map(item => Number(item.mtime_ms || 0) || 0));
      files.push({
        path: full,
        category: path.basename(root),
        name: entry.name,
        bytes: st.size,
        last_write_time: new Date(effectiveMtimeMs).toISOString(),
        db_last_write_time: st.mtime.toISOString(),
        sidecars,
      });
    }
  }
  files.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  return files;
}

async function listDbSidecarStats(dbPath, { signal = null } = {}) {
  const out = [];
  for (const suffix of SQLITE_PERSISTED_SIDECAR_SUFFIXES) {
    throwIfDiscoveryAborted(signal);
    const file = `${dbPath}${suffix}`;
    const st = await statWxDbSourceSidecar(file, { signal });
    if (!st?.isFile() || st.isSymbolicLink()) continue;
    out.push({
      name: path.basename(file),
      path: file,
      suffix,
      bytes: st.size,
      mtime_ms: st.mtimeMs,
      last_write_time: st.mtime.toISOString(),
    });
  }
  return out;
}

export function existsSyncSafe(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

function accountNameToWxid(name) {
  return String(name || '').replace(/_[0-9a-f]{4}$/i, '');
}

function accountNameToDisplay(name) {
  return accountNameToWxid(name).replace(/^wxid_/, 'wxid_');
}

function execFileText(file, args, { signal = null } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : discoveryAbortError());
      return;
    }
    const options = { windowsHide: true, timeout: 10000 };
    if (signal) options.signal = signal;
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve(stdout || stderr || '');
    });
  });
}

export const __discoveryInternals = {
  accountOpaqueId,
  acquireWxDbMirrorProcessLock,
  assertMirrorSourceDbSetMatchesSnapshot,
  collectMirrorSourceSnapshot,
  confirmMirrorSourceSnapshotStillStable,
  copyExistingMirrorCategoriesToStaging,
  copyMirrorDbFileSet,
  dedupeSourceAccountsByStorage,
  discoverDataRootsFromCandidates,
  mirrorCopyRetryDelayMs,
  mirrorCopyRetryExhaustedError,
  mirrorCopyRetryWaitBudgetMs,
  mirrorCopyAttemptsForRequest,
  mirrorIdentityFieldsForRefresh,
  mirrorRefreshIdentityAnchorCurrent,
  mirrorSourceBusyIdentityAnchorCurrent,
  mirrorSourceSnapshotCategoryMetadataMatches,
  mirrorSnapshotCategoryContentHashesMatch,
  bindMirrorPayloadTargetIdentityFromPublishedManifest,
  mirrorReusablePayloadFromSourceScopes,
  mergeMirrorSnapshotPayloadCategories,
  mirrorIndexedScopeRecord,
  mirrorIndexedSnapshotForScope,
  projectIndexedMirrorPayloadToSnapshot,
  mirrorScopeSnapshotHash,
  mirrorSnapshotEntryMatchesPayload,
  mirrorSnapshotIndexPayloadForTarget,
  mirrorPublishedManifestForTarget,
  mirrorPublishedManifestHash,
  rebindPublishedMirrorTargetMetadataAfterCleanup,
  readWindowsConfiguredDataRootEntries,
  reboundPublishedMirrorManifest,
  previousMirrorRootMatchesIndexedContent,
  mirrorSourceScopesForWrite,
  mirrorScopeForReason,
  mirrorScopeAllowsDbFile,
  wxDbMirrorIdentityProofSufficient,
  wxDbMirrorScopeCoverageCandidates,
  wxDbMirrorScopeRecordsForRead,
  mirrorTargetContentHashFresh,
  mirrorTargetContentVerifiedAt,
  mirrorTargetHasCategoryBackups,
  mirrorTargetIdentityMatches,
  mirrorTargetIdentityRecorded,
  offlineMirrorTargetIdentityMatches,
  verifyOfflineMirrorContent,
  mirrorTargetMatchesSourceSnapshot,
  linkOrCopyMirrorFile,
  recoverStalePreviousMirrorDirs,
  replaceMirrorRootFromStaging,
  rollbackMirrorRootReplacement,
  runWithWxDbMirrorLock,
  runWithWxDbMirrorIndexWriteLock,
  sleepForMirrorCopyRetry,
  safeMirrorSourceAccountResolution,
  sourceDiscoveryErrorForRequestedAccount,
  sourceDiscoveryErrorForMirrorRequest,
  sourceDiscoveryIssueMatchesMirror,
  sourceWxAccountDiscoveryFromDataRoots,
  sourceWxAccountsFromDataRoots,
  unreadableSourceAccountsFromDiscovery,
  sourceBusyMirrorReusePolicy,
  selfProcessStartIdentityFallback,
  processStartIdentityMatches,
  mirrorReadinessToken,
  mirrorSourceAccountResolution,
  mirrorIdentitySourceGenerationCurrent,
  sourceAccountGenerationHash,
  uniqueMirrorSourceAccount,
  unreadableSourceAccountId,
  verifiedMirrorScopeCandidate,
  wxDbMirrorProcessOwnerMatches,
  wxDbMirrorProcessOwnerState,
  wxDbMirrorProcessLockBlockedError,
  wxDbMirrorProcessLockIsFresh,
};
