import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DATA_DIR, DEFAULT_DIGESTS_DIR, OUTPUTS_DIR, PROJECT_ROOT, TMP_DIR, assertRealOutputDir, ensureOrdinaryDataDir, ensureOrdinaryTmpDir, isInside, outputDirFromSettings, resolveInsideTmp } from '../lib/paths.js';
import { PRIVATE_FILE_MODE, cloneJson, deepMerge, ensureDir, syncDirectory, writeFileAtomic, writeJsonAtomic } from '../lib/json-store.js';
import { readFileHandleBounded } from '../lib/bounded-read.js';
import { preserveInvalidFileBackup } from '../lib/invalid-backup.js';
import { protectText, secretProtectionUnavailable, unprotectToText } from './dpapi.js';
import { toWellFormedText } from '../web/public/js/unicode-text.js';

export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const SECRETS_FILE = path.join(DATA_DIR, 'secrets.bin');
export const CURSORS_FILE = path.join(DATA_DIR, 'cursors.json');
export const MAX_SCHEDULER_INTERVAL_MS = 24 * 86_400_000;
export const MAX_SCHEDULER_DIGEST_WINDOW_MS = 24 * 86_400_000;
export const MAX_AI_CONCURRENCY = 8;
export const MAX_LLM_API_KEY_CHARS = 8192;
export const MAX_DIGEST_MIN_MESSAGES = 9999;
export const MAX_GROUP_WHITELIST_REFS = 500;
export const MAX_PER_GROUP_OVERRIDES = 200;
export const DEFAULT_LINK_PREVIEW_MAX_LINKS = 30;
export const MAX_LINK_PREVIEW_LINKS = 120;
const DEFAULT_LOG_FILE = './outputs/.tmp/wx-summary.log';
let SETTINGS_SAVE_QUEUE = Promise.resolve();
const SETTINGS_SAVE_CONTEXT = new AsyncLocalStorage();
let SETTINGS_WRITE_REQUEST_COUNT = 0;
let SETTINGS_WRITE_REQUEST_IDLE = Promise.resolve();
let RESOLVE_SETTINGS_WRITE_REQUEST_IDLE = null;
const SECRETS_RECOVERY_STATE = new Map();
const SETTINGS_RECOVERY_STATE = new Map();
const MAX_SETTINGS_TRANSACTION_JOURNAL_BYTES = 256 * 1024;
const MAX_SETTINGS_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SECRETS_FILE_BYTES = 16 * 1024 * 1024;

export function defaultSettings() {
  return {
    llm: {
      provider: 'openai',
      base_url: '',
      model: '',
      long_context_model: '',
      available_models: [],
      models_fetched_at: null,
      capabilities: {},
      temperature: 0.3,
      timeout_ms: 120000,
      max_input_chars: 60000,
      max_messages_per_call: 800,
      max_image_chars_per_call: 300000,
      ai_concurrency: 2,
      custom_model: false,
      custom_long_context_model: false,
    },
    privacy: { redact_phone: true, redact_id_card: true, redact_bank_card: true, redact_email: false, attach_media_content: false },
    link_preview: { enabled: true, ai_web_search: true, max_links: DEFAULT_LINK_PREVIEW_MAX_LINKS, allow_private_networks: false, timeout_ms: 8000, max_bytes: 262144, max_chars_per_link: 2000, max_related_links: 3, max_related_bytes: 98304, max_related_chars: 800 },
    groups: { whitelist: [], overrides: [], recent: [] },
    scheduler: { enabled: false, disabled_reason: '', disabled_at: '', default_interval: '30m', digest_window: '4h', min_messages_per_digest: 30, per_group: [] },
    output: { dir: './outputs/digests', retention_days: 0, filename_pattern: '{group}__{since}_{until}__{id8}.png' },
    render: { default_theme: 'auto', default_font_size: 'normal' },
    web: { host: '127.0.0.1', port: 7788, open_browser: true },
    wechat: { manual_key_set: false },
    logging: { level: 'info', file: DEFAULT_LOG_FILE, max_mb: 50 },
  };
}

export async function ensureRuntimeDirs(settings = defaultSettings()) {
  await ensureOrdinaryDataDir();
  await ensureDir(OUTPUTS_DIR);
  await ensureOrdinaryTmpDir();
  await ensureDir(DEFAULT_DIGESTS_DIR);
  await assertRealOutputDir(outputDirFromSettings(settings), { ensure: true });
}

export async function clearTmpDir({ preserve = [], deferLockedLogs = false } = {}) {
  await ensureOrdinaryTmpDir();
  const preserved = preservedTmpPaths(preserve);
  const deferredLockedLogs = [];
  const entries = await fsp.readdir(TMP_DIR, { withFileTypes: true });
  await Promise.all(entries.map(async entry => {
    const full = path.join(TMP_DIR, entry.name);
    if (!isInside(TMP_DIR, full)) return;
    try {
      await removeTmpEntryExceptPreserved(full, preserved);
    } catch (error) {
      if (deferLockedLogs && entry.isFile() && isDeferredTmpLogLockError(full, error)) {
        deferredLockedLogs.push(full);
        return;
      }
      throw error;
    }
  }));
  await ensureOrdinaryTmpDir();
  return { deferred_locked_logs: deferredLockedLogs };
}

function isDeferredTmpLogLockError(entryPath, error = {}) {
  const code = String(error?.code || '').trim();
  return ['EBUSY', 'EPERM', 'EACCES'].includes(code)
    && /\.log$/i.test(path.basename(String(entryPath || '')));
}

function preservedTmpPaths(paths = []) {
  const list = Array.isArray(paths) ? paths : [paths];
  const out = new Set();
  for (const item of list) {
    const text = String(item || '').trim();
    if (!text) continue;
    const resolved = path.resolve(text);
    if (isInside(TMP_DIR, resolved)) out.add(resolved);
  }
  return [...out];
}

async function removeTmpEntryExceptPreserved(entryPath, preserved = []) {
  const resolved = path.resolve(entryPath);
  if (!isInside(TMP_DIR, resolved)) return;
  let stat = null;
  try {
    stat = await fsp.lstat(resolved);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!stat) return;
  if (stat?.isSymbolicLink?.()) {
    await fsp.rm(resolved, { recursive: true, force: true });
    return;
  }
  if (isPreservedTmpPath(resolved, preserved)) return;
  if (!tmpEntryContainsPreservedPath(resolved, preserved)) {
    await fsp.rm(resolved, { recursive: true, force: true });
    return;
  }
  if (!stat.isDirectory()) {
    await fsp.rm(resolved, { force: true });
    return;
  }
  const children = await fsp.readdir(resolved, { withFileTypes: true });
  for (const child of children) {
    await removeTmpEntryExceptPreserved(path.join(resolved, child.name), preserved);
  }
}

function isPreservedTmpPath(target, preserved = []) {
  const resolved = path.resolve(target);
  return preserved.some(item => path.resolve(item) === resolved);
}

function tmpEntryContainsPreservedPath(entryPath, preserved = []) {
  const resolved = path.resolve(entryPath);
  return preserved.some(item => isInside(resolved, path.resolve(item)));
}

export function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function maskSecret(value) {
  if (!value) return '';
  const s = String(value);
  const prefix = s.startsWith('sk-') ? 'sk-' : '';
  const body = prefix ? s.slice(prefix.length) : s;
  if (body.length <= 8) return `${prefix}…${'*'.repeat(Math.max(4, body.length))}`;
  return `${prefix}…${body.slice(-4)}`;
}

export function splitManualKeys(value) {
  const text = String(value || '');
  const out = [];
  const seen = new Set();
  const add = token => {
    for (const key of normalizeManualKeyTokens(token)) {
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  };
  manualKeyTextMatches(text).forEach(item => add(item.token));
  return out;
}

function manualKeyCandidateMatches(value) {
  const text = String(value || '');
  const matches = [];
  const explicit = /[xX]'([a-fA-F0-9]{64,192})'|0[xX]([a-fA-F0-9]{64,192})/g;
  let match;
  while ((match = explicit.exec(text))) {
    const token = match[1] || match[2];
    matches.push({ index: match.index, end: match.index + match[0].length, token });
  }
  const bare = /[a-fA-F0-9]{64,192}/g;
  while ((match = bare.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    const before = start > 0 ? text.charCodeAt(start - 1) : 0;
    const after = end < text.length ? text.charCodeAt(end) : 0;
    if (isHexCharCode(before) || isHexCharCode(after)) continue;
    matches.push({ index: start, end, token: match[0] });
  }
  return matches.sort((a, b) => a.index - b.index);
}

function manualKeyTextMatches(value) {
  return manualKeyCandidateMatches(value)
    .filter(item => normalizeManualKeyTokens(item.token).length > 0);
}

function manualKeyContextLine(line = '') {
  const clean = String(line || '').trim();
  if (!clean) return true;
  if (/^[{}\[\],]+$/.test(clean)) return true;
  if (/^(?:\/\/|#)/.test(clean)) return true;
  if (/^["']?[\w .:/\\@-]+["']?\s*:\s*(?:["'][^"']{0,200}["']|[{}\[\],]|null|true|false|\d+)?\s*,?$/.test(clean)) return true;
  if (/^[\w .:/\\@_]+,?$/.test(clean) && /(?:all_keys|manual_key|message|contact|session|database|db|salt|hmac|note|export)/i.test(clean)) return true;
  return false;
}

function manualKeyInvalidFragments(value) {
  const text = String(value || '');
  const matches = manualKeyTextMatches(text);
  const invalid = [];
  const seen = new Set();
  const addInvalid = value => {
    const compact = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!compact || seen.has(compact)) return;
    seen.add(compact);
    invalid.push(invalid.length + 1);
  };
  for (const item of manualKeyCandidateMatches(text)) {
    if (normalizeManualKeyTokens(item.token).length > 0) continue;
    addInvalid(item.token);
  }
  let offset = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const lineStart = offset;
    const lineEnd = offset + rawLine.length;
    offset = lineEnd + 1;
    const clean = rawLine.trim();
    if (!clean) continue;
    const hasKey = matches.some(item => item.index < lineEnd && item.end > lineStart);
    if (hasKey || manualKeyContextLine(clean)) continue;
    addInvalid(clean);
  }
  return invalid;
}

export function normalizeManualKeysText(value) {
  const text = String(value || '').trim();
  const keys = splitManualKeys(value);
  const invalid = text ? manualKeyInvalidFragments(value) : [];
  if (invalid.length) {
    const err = new Error(`手动密钥里检测到 ${invalid.length} 处未识别的行或片段。为避免泄露密钥，错误信息不会回显原文；请删除无效内容，或填写 64/96/128/160/192 位 hex、all_keys.json、导出 blob、x'...' / 0x... 片段。`);
    err.status = 400;
    err.code = 'manual_key_unrecognized_fragments';
    err.public_code = 'manual_key_unrecognized_fragments';
    err.invalid_fragment_count = invalid.length;
    throw err;
  }
  if (text && !keys.length) {
    const err = new Error("手动密钥必须包含 64/96/128/160/192 位 hex，或可自动提取的 all_keys.json、导出 blob、x'...' / 0x... 片段。");
    err.status = 400;
    err.code = 'manual_key_no_extractable_key';
    err.public_code = 'manual_key_no_extractable_key';
    throw err;
  }
  return keys.join('\n');
}

function normalizeManualKeyTokens(value) {
  const text = String(value || '').trim().toLowerCase().replace(/^['"`]+|['"`]+$/g, '');
  if (/^[a-f0-9]{192}$/.test(text)) {
    return [text];
  }
  return /^(?:[a-f0-9]{64}|[a-f0-9]{96}|[a-f0-9]{128}|[a-f0-9]{160})$/.test(text) ? [text] : [];
}

function isHexCharCode(code) {
  return (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x46)
    || (code >= 0x61 && code <= 0x66);
}

function stripSensitive(settings) {
  const clean = cloneJson(settings);
  delete clean.llm.api_key;
  delete clean.llm.api_key_set;
  delete clean.llm.api_key_display;
  delete clean.llm.clear_api_key;
  delete clean.wechat.manual_key;
  delete clean.wechat.manual_key_legacy;
  delete clean.wechat.manual_keys_by_account;
  delete clean.wechat.manual_key_account_fingerprints_by_account;
  delete clean.wechat.manual_key_verifications_by_account;
  delete clean.wechat.manual_key_set;
  delete clean.wechat.manual_key_legacy_set;
  delete clean.wechat.manual_key_account_ids;
  delete clean.wechat.manual_key_account_count;
  delete clean.wechat.manual_key_orphaned_account_ids;
  delete clean.wechat.manual_key_orphaned_account_count;
  delete clean.wechat.manual_key_verified_account_ids;
  delete clean.wechat.manual_key_verified_account_count;
  delete clean.wechat.manual_key_verified_account_fingerprints_by_account;
  delete clean.wechat.manual_key_clear_account_fingerprints_by_account;
  delete clean.wechat.manual_key_account_fingerprint;
  delete clean.wechat.manual_key_account_id;
  delete clean.wechat.manual_key_account_aliases;
  delete clean.wechat.clear_manual_key_account_id;
  delete clean.wechat.clear_manual_key_account_aliases;
  delete clean.wechat.clear_legacy_manual_key;
  delete clean.wechat.account_id;
  delete clean.wechat.clear_manual_key;
  delete clean.wechat.key_auto_scan_state;
  delete clean.wechat.key_auto_scan_supported;
  delete clean.wechat.key_auto_scan_can_attempt;
  delete clean.wechat.key_auto_scan_reason;
  delete clean.settings_revision;
  delete clean.scheduler_runtime_revision;
  delete clean.scheduler_schedule_revision;
  delete clean.export_policy_revision;
  delete clean.base_settings_revision;
  delete clean.expected_settings_revision;
  delete clean.expected_export_policy_revision;
  delete clean.settings_ops;
  delete clean._settings_ops;
  delete clean._secrets_invalid;
  delete clean._secrets_invalid_info;
  delete clean._settings_invalid;
  delete clean._settings_recovered;
  return clean;
}

export async function loadSecrets({ file = SECRETS_FILE } = {}) {
  const key = recoveryStateKey(file);
  try {
    const encrypted = await readSettingsStorageFile(file, 'secrets');
    const text = await unprotectToText(encrypted);
    const parsed = JSON.parse(text || '{}');
    SECRETS_RECOVERY_STATE.delete(key);
    return { secrets: normalizeSecrets(parsed), invalid: false };
  } catch (e) {
    if (e?.code === 'ENOENT') {
      const recovered = SECRETS_RECOVERY_STATE.get(key);
      return recovered
        ? { secrets: emptySecrets(), invalid: true, ...recovered }
        : { secrets: emptySecrets(), invalid: false };
    }
    if (settingsStorageReadMustFailClosed(e)) throw e;
    if (secretProtectionUnavailable(e)) {
      const preserved = await preserveInvalidFileBackup(file, {
        maxBytes: MAX_SECRETS_FILE_BYTES,
        mode: PRIVATE_FILE_MODE,
      }).catch(() => ({
        original_path: path.resolve(file),
        backup_path: '',
        backup_available: false,
        original_preserved: true,
      }));
      const recovered = rememberRecoveryState(SECRETS_RECOVERY_STATE, file, {
        backup_path: preserved.backup_path || '',
        backup_relative_path: preserved.backup_path ? toProjectRelativeSafe(preserved.backup_path) : '',
        error: e?.message || String(e),
        transient: true,
        unavailable: true,
      });
      return { secrets: emptySecrets(), invalid: true, ...recovered };
    }
    const backup = await backupInvalidSecretsFile(file).catch(() => '');
    const recovered = rememberRecoveryState(SECRETS_RECOVERY_STATE, file, {
      backup_path: backup,
      backup_relative_path: backup ? toProjectRelativeSafe(backup) : '',
      error: e?.message || String(e),
    });
    return { secrets: emptySecrets(), invalid: true, ...recovered };
  }
}

function emptySecrets() {
  return { api_key: '', manual_key: '', manual_keys_by_account: {}, manual_key_account_fingerprints_by_account: {}, manual_key_verifications_by_account: {} };
}

function normalizeSecrets(value = {}) {
  const manualKeysByAccount = normalizeManualKeysByAccount(value?.manual_keys_by_account);
  const manualKeyVerificationsByAccount = normalizeManualKeyVerificationsByAccount(value?.manual_key_verifications_by_account);
  return {
    api_key: String(value?.api_key || '').trim(),
    manual_key: splitManualKeys(value?.manual_key).join('\n'),
    manual_keys_by_account: manualKeysByAccount,
    manual_key_account_fingerprints_by_account: normalizeManualKeyAccountFingerprintsByAccount(
      value?.manual_key_account_fingerprints_by_account,
      manualKeyVerificationsByAccount,
      manualKeysByAccount,
    ),
    manual_key_verifications_by_account: manualKeyVerificationsByAccount,
  };
}

async function backupInvalidSecretsFile(file) {
  await ensureDir(path.dirname(file));
  const backup = file.replace(/\.bin$/i, `.invalid.${settingsBackupTimestamp(new Date())}.bin`);
  await fsp.rename(file, backup).catch(e => {
    if (e?.code !== 'ENOENT') throw e;
  });
  return backup;
}

async function loadSettingsFile(file = SETTINGS_FILE) {
  const key = recoveryStateKey(file);
  try {
    const raw = (await readSettingsStorageFile(file, 'settings')).toString('utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw Object.assign(new Error('settings.json must contain a JSON object'), { code: 'SETTINGS_INVALID_SHAPE' });
    }
    SETTINGS_RECOVERY_STATE.delete(key);
    return { raw: parsed, invalid: null };
  } catch (e) {
    if (e?.code === 'ENOENT') {
      const recovered = SETTINGS_RECOVERY_STATE.get(key);
      return recovered ? { raw: {}, invalid: recovered } : { raw: {}, invalid: null };
    }
    if (settingsStorageReadMustFailClosed(e)) throw e;
    const backup = await backupInvalidSettingsFile(file);
    const recovered = rememberRecoveryState(SETTINGS_RECOVERY_STATE, file, {
      backup_path: backup,
      backup_relative_path: toProjectRelativeSafe(backup),
      error: e?.message || String(e),
    });
    return { raw: {}, invalid: recovered };
  }
}

async function backupInvalidSettingsFile(file) {
  await ensureDir(path.dirname(file));
  const backup = file.replace(/\.json$/i, `.invalid.${settingsBackupTimestamp(new Date())}.json`);
  await fsp.rename(file, backup).catch(e => {
    if (e?.code !== 'ENOENT') throw e;
  });
  return backup;
}

function settingsBackupTimestamp(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function recoveryStateKey(file) {
  return path.resolve(file);
}

function rememberRecoveryState(store, file, info = {}) {
  const recovered = {
    backup_path: info.backup_path || '',
    backup_relative_path: info.backup_relative_path || (info.backup_path ? toProjectRelativeSafe(info.backup_path) : ''),
    error: info.error || '',
    transient: info.transient === true,
    unavailable: info.unavailable === true || info.transient === true,
  };
  store.set(recoveryStateKey(file), recovered);
  return recovered;
}

function publicRecoveryInfo(info = null) {
  if (!info) return null;
  return {
    backup_relative_path: info.backup_relative_path || (info.backup_path ? toProjectRelativeSafe(info.backup_path) : ''),
    error: redactRecoveryError(info.error || ''),
    transient: info.transient === true,
    unavailable: info.unavailable === true || info.transient === true,
  };
}

function invalidSecretsReplacementConfirmationError(info = null) {
  const err = new Error('当前本机密钥库无法解密；保存新密钥会建立一份全新的密钥库，未重新填写的其他账号密钥不会自动迁移。请确认已归档旧密文后再重试。');
  err.status = 428;
  err.code = 'secrets_replacement_confirmation_required';
  err.public_code = 'secrets_replacement_confirmation_required';
  err.backup_relative_path = info?.backup_relative_path || '';
  return err;
}

function invalidSecretsReplacementBackupError(cause = null) {
  const err = new Error('当前本机密钥库无法解密，且旧密文尚未完成安全备份；已拒绝建立新密钥库。请检查 data 目录权限后重试。');
  err.status = 503;
  err.code = 'secrets_replacement_backup_required';
  err.public_code = 'secrets_replacement_backup_required';
  if (cause) err.cause = cause;
  return err;
}

async function assertInvalidSecretsReplacementConfirmed(file = SECRETS_FILE, confirmed = false) {
  const key = recoveryStateKey(file);
  const currentRecovery = SECRETS_RECOVERY_STATE.get(key) || null;
  if (confirmed !== true) throw invalidSecretsReplacementConfirmationError(currentRecovery);
  let backupPath = String(currentRecovery?.backup_path || '').trim();
  if (!backupPath) {
    let preserved;
    try {
      preserved = await preserveInvalidFileBackup(file, {
        maxBytes: MAX_SECRETS_FILE_BYTES,
        mode: PRIVATE_FILE_MODE,
      });
    } catch (e) {
      throw invalidSecretsReplacementBackupError(e);
    }
    backupPath = String(preserved?.backup_path || '').trim();
    if (backupPath) {
      rememberRecoveryState(SECRETS_RECOVERY_STATE, file, {
        ...(currentRecovery || {}),
        backup_path: backupPath,
        backup_relative_path: toProjectRelativeSafe(backupPath),
      });
    }
  }
  let backupStat = null;
  try {
    backupStat = backupPath ? await fsp.lstat(backupPath) : null;
  } catch (e) {
    throw invalidSecretsReplacementBackupError(e);
  }
  if (!backupStat?.isFile?.() || backupStat.isSymbolicLink?.() || backupStat.size > MAX_SECRETS_FILE_BYTES) {
    throw invalidSecretsReplacementBackupError();
  }
  return backupPath;
}

function redactRecoveryError(value = '') {
  return String(value || '')
    .replaceAll(PROJECT_ROOT, '[redacted-path]')
    .replace(/[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/g, '[redacted-path]')
    .slice(0, 500);
}

function toProjectRelativeSafe(file) {
  return path.relative(PROJECT_ROOT, file).replaceAll(path.sep, '/');
}

function settingsFileForSecretsFile(file = SECRETS_FILE) {
  return path.join(path.dirname(file), path.basename(SETTINGS_FILE));
}

function settingsTransactionId() {
  return `settings-txn-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

function settingsTransactionJournalPath(settingsFile = SETTINGS_FILE, secretsFile = SECRETS_FILE) {
  const id = crypto.createHash('sha256')
    .update(path.resolve(settingsFile))
    .update('\0')
    .update(path.resolve(secretsFile))
    .digest('hex')
    .slice(0, 16);
  return path.join(path.dirname(settingsFile), `.settings-secrets-${id}.txn.json`);
}

function settingsTransactionBackupPath(file, txnId, kind) {
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  return path.join(path.dirname(file), `${base}.${txnId}.${kind}.bak${ext || ''}`);
}

async function createSettingsTransactionFileEntry(file, kind, txnId) {
  const resolved = path.resolve(file);
  try {
    const data = await readSettingsStorageFile(resolved, kind);
    const backup = settingsTransactionBackupPath(resolved, txnId, kind);
    await writeFileAtomic(backup, data, { mode: kind === 'secrets' ? PRIVATE_FILE_MODE : undefined });
    return { kind, file: resolved, existed: true, backup: path.resolve(backup) };
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
    return { kind, file: resolved, existed: false, backup: '' };
  }
}

async function writeSettingsTransactionJournal(txn) {
  await writeJsonAtomic(txn.journal, {
    version: 1,
    id: txn.id,
    state: txn.state,
    created_at: txn.created_at,
    settings_file: txn.settings_file,
    secrets_file: txn.secrets_file,
    entries: txn.entries,
  }, { mode: PRIVATE_FILE_MODE, maxBytes: MAX_SETTINGS_TRANSACTION_JOURNAL_BYTES });
}

async function beginSettingsSecretsTransaction(settingsFile = SETTINGS_FILE, secretsFile = SECRETS_FILE) {
  await ensureDir(path.dirname(settingsFile));
  await ensureDir(path.dirname(secretsFile));
  const id = settingsTransactionId();
  const txn = {
    version: 1,
    id,
    state: 'prepared',
    created_at: new Date().toISOString(),
    journal: settingsTransactionJournalPath(settingsFile, secretsFile),
    settings_file: path.resolve(settingsFile),
    secrets_file: path.resolve(secretsFile),
    entries: [],
  };
  try {
    txn.entries.push(await createSettingsTransactionFileEntry(settingsFile, 'settings', id));
    txn.entries.push(await createSettingsTransactionFileEntry(secretsFile, 'secrets', id));
    await writeSettingsTransactionJournal(txn);
    return txn;
  } catch (e) {
    await cleanupSettingsTransaction(txn).catch(() => {});
    throw e;
  }
}

function normalizeSettingsTransaction(raw, { settingsFile = SETTINGS_FILE, secretsFile = SECRETS_FILE, journal = '' } = {}) {
  if (!plainObject(raw) || !Array.isArray(raw.entries)) {
    throw Object.assign(new Error('settings transaction journal is invalid'), { code: 'settings_transaction_journal_invalid' });
  }
  const expectedSettingsFile = path.resolve(settingsFile);
  const expectedSecretsFile = path.resolve(secretsFile);
  const id = String(raw.id || '').trim();
  const state = String(raw.state || '').trim();
  if (raw.version !== 1
    || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(id)
    || !['prepared', 'committed', 'rolled_back'].includes(state)
    || path.resolve(String(raw.settings_file || '')) !== expectedSettingsFile
    || path.resolve(String(raw.secrets_file || '')) !== expectedSecretsFile) {
    throw Object.assign(new Error('settings transaction journal metadata is invalid'), { code: 'settings_transaction_journal_invalid' });
  }
  const allowed = new Map([
    ['settings', expectedSettingsFile],
    ['secrets', expectedSecretsFile],
  ]);
  const entries = raw.entries.map(entry => {
    if (!plainObject(entry)) throw Object.assign(new Error('settings transaction entry is invalid'), { code: 'settings_transaction_journal_invalid' });
    const kind = String(entry.kind || '');
    const expectedFile = allowed.get(kind);
    const file = path.resolve(String(entry.file || ''));
    if (!expectedFile || file !== expectedFile) {
      throw Object.assign(new Error('settings transaction entry target is invalid'), { code: 'settings_transaction_journal_invalid' });
    }
    const existed = entry.existed === true;
    const backup = existed ? path.resolve(String(entry.backup || '')) : '';
    const expectedBackup = existed ? path.resolve(settingsTransactionBackupPath(file, id, kind)) : '';
    if ((existed && backup !== expectedBackup) || (!existed && String(entry.backup || '').trim())) {
      throw Object.assign(new Error('settings transaction backup target is invalid'), { code: 'settings_transaction_journal_invalid' });
    }
    return { kind, file, existed, backup };
  });
  const seenKinds = new Set(entries.map(entry => entry.kind));
  if (entries.length !== 2 || !seenKinds.has('settings') || !seenKinds.has('secrets')) {
    throw Object.assign(new Error('settings transaction journal is incomplete'), { code: 'settings_transaction_journal_invalid' });
  }
  return {
    version: 1,
    id,
    state,
    created_at: String(raw.created_at || ''),
    journal: path.resolve(journal || settingsTransactionJournalPath(settingsFile, secretsFile)),
    settings_file: path.resolve(settingsFile),
    secrets_file: path.resolve(secretsFile),
    entries,
  };
}

function settingsTransactionFileLimit(kind) {
  if (kind === 'journal') return MAX_SETTINGS_TRANSACTION_JOURNAL_BYTES;
  if (kind === 'secrets') return MAX_SECRETS_FILE_BYTES;
  return MAX_SETTINGS_FILE_BYTES;
}

function settingsStorageError(message, code, status, details = {}) {
  return Object.assign(new Error(message), { code, public_code: code, status, ...details });
}

function settingsStorageReadMustFailClosed(error) {
  return ['settings_storage_file_not_regular', 'settings_storage_file_too_large'].includes(String(error?.code || ''));
}

async function readSettingsStorageFile(file, kind) {
  const resolved = path.resolve(file);
  const limit = settingsTransactionFileLimit(kind);
  const linkStat = await fsp.lstat(resolved);
  if (!linkStat.isFile() || linkStat.isSymbolicLink()) {
    throw settingsStorageError('设置存储路径不是普通文件。', 'settings_storage_file_not_regular', 403, { kind });
  }
  if (linkStat.size > limit) {
    throw settingsStorageError('设置存储文件超过安全读取上限。', 'settings_storage_file_too_large', 413, {
      kind,
      bytes: linkStat.size,
      max_bytes: limit,
    });
  }
  let handle = null;
  try {
    handle = await fsp.open(resolved, 'r');
    const handleStat = await handle.stat();
    if (!handleStat.isFile()) {
      throw settingsStorageError('设置存储路径不是普通文件。', 'settings_storage_file_not_regular', 403, { kind });
    }
    return await readFileHandleBounded(handle, limit, {
      createTooLargeError: bytes => settingsStorageError(
        '设置存储文件超过安全读取上限。',
        'settings_storage_file_too_large',
        413,
        { kind, bytes, max_bytes: limit },
      ),
    });
  } finally {
    await handle?.close?.().catch(() => {});
  }
}

function settingsTransactionRecoveryUnsafeError(cause = null) {
  const err = new Error('检测到无法安全恢复的设置保存事务。为避免混用不同版本的设置与密钥，服务已停止读取配置；事务日志和备份均已保留。');
  err.code = 'settings_transaction_recovery_unsafe';
  err.public_code = 'settings_transaction_recovery_unsafe';
  err.status = 503;
  if (cause) err.cause = cause;
  return err;
}

async function recoverSettingsTransaction(settingsFile = SETTINGS_FILE, secretsFile = SECRETS_FILE) {
  const journal = settingsTransactionJournalPath(settingsFile, secretsFile);
  let raw;
  try {
    raw = JSON.parse((await readSettingsStorageFile(journal, 'journal')).toString('utf-8'));
  } catch (e) {
    if (e?.code === 'ENOENT') return false;
    throw settingsTransactionRecoveryUnsafeError(e);
  }
  let txn;
  try {
    txn = normalizeSettingsTransaction(raw, { settingsFile, secretsFile, journal });
  } catch (e) {
    throw settingsTransactionRecoveryUnsafeError(e);
  }
  if (txn.state === 'committed' || txn.state === 'rolled_back') {
    await cleanupSettingsTransaction(txn);
    return true;
  }
  await rollbackSettingsTransaction(txn);
  return true;
}

async function restoreSettingsTransactionEntry(entry, backupData = null) {
  if (!entry.existed) {
    await fsp.rm(entry.file, { force: true }).catch(() => {});
    await syncDirectory(path.dirname(entry.file)).catch(() => {});
    return;
  }
  await writeFileAtomic(entry.file, backupData, { mode: entry.kind === 'secrets' ? PRIVATE_FILE_MODE : undefined });
}

async function rollbackSettingsTransaction(txn) {
  const backupData = new Map();
  try {
    for (const entry of txn.entries) {
      if (entry.existed) backupData.set(entry.kind, await readSettingsStorageFile(entry.backup, entry.kind));
    }
  } catch (e) {
    throw settingsTransactionRecoveryUnsafeError(e);
  }
  for (const entry of txn.entries) await restoreSettingsTransactionEntry(entry, backupData.get(entry.kind) || null);
  txn.state = 'rolled_back';
  await writeSettingsTransactionJournal(txn);
  await cleanupSettingsTransaction(txn);
}

async function commitSettingsSecretsTransaction(txn) {
  txn.state = 'committed';
  await writeSettingsTransactionJournal(txn);
  await cleanupSettingsTransaction(txn);
}

async function cleanupSettingsTransaction(txn, { removeJournal = true } = {}) {
  const dirs = new Set();
  for (const entry of txn.entries || []) {
    if (entry.backup) {
      dirs.add(path.dirname(entry.backup));
      await fsp.rm(entry.backup, { force: true }).catch(() => {});
    }
  }
  if (removeJournal && txn.journal) {
    dirs.add(path.dirname(txn.journal));
    await fsp.rm(txn.journal, { force: true }).catch(() => {});
  }
  for (const dir of dirs) await syncDirectory(dir).catch(() => {});
}

export async function saveSecrets(secrets, { file = SECRETS_FILE, settingsFile = settingsFileForSecretsFile(file) } = {}) {
  await recoverSettingsTransaction(settingsFile, file);
  const tmp = await stageSecretsFile(secrets, file);
  try {
    await fsp.rename(tmp, file);
    await syncDirectory(path.dirname(file));
    SECRETS_RECOVERY_STATE.delete(recoveryStateKey(file));
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

async function stageSecretsFile(secrets, file = SECRETS_FILE) {
  await ensureDir(path.dirname(file));
  const manualKeysByAccount = normalizeManualKeysByAccount(secrets.manual_keys_by_account);
  const manualKeyVerificationsByAccount = normalizeManualKeyVerificationsByAccount(secrets.manual_key_verifications_by_account);
  const filtered = {
    api_key: secrets.api_key || '',
    manual_key: splitManualKeys(secrets.manual_key).join('\n'),
    manual_keys_by_account: manualKeysByAccount,
    manual_key_account_fingerprints_by_account: normalizeManualKeyAccountFingerprintsByAccount(
      secrets.manual_key_account_fingerprints_by_account,
      manualKeyVerificationsByAccount,
      manualKeysByAccount,
    ),
    manual_key_verifications_by_account: manualKeyVerificationsByAccount,
  };
  const encrypted = await protectText(JSON.stringify(filtered));
  const encryptedBytes = Buffer.byteLength(encrypted);
  if (encryptedBytes > MAX_SECRETS_FILE_BYTES) {
    throw settingsStorageError('密钥配置超过安全写入上限。', 'settings_storage_file_too_large', 413, {
      kind: 'secrets',
      bytes: encryptedBytes,
      max_bytes: MAX_SECRETS_FILE_BYTES,
    });
  }
  const tmp = path.join(path.dirname(file), `secrets.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    await writeFileAtomic(tmp, encrypted, { mode: PRIVATE_FILE_MODE });
    return tmp;
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

export async function loadSettings(options = {}) {
  if (!SETTINGS_SAVE_CONTEXT.getStore()) await SETTINGS_SAVE_QUEUE;
  return loadSettingsUnlocked(options);
}

async function loadSettingsUnlocked({ includeSecrets = false, settingsFile = SETTINGS_FILE, secretsFile = SECRETS_FILE } = {}) {
  await recoverSettingsTransaction(settingsFile, secretsFile);
  const { raw, invalid } = await loadSettingsFile(settingsFile);
  const recovered = settingsRecoveredFields(raw);
  const merged = normalizeSettings(deepMerge(defaultSettings(), raw));
  const secretState = await loadSecrets({ file: secretsFile });
  merged.settings_revision = await settingsStorageRevision(settingsFile, secretsFile, secretState.secrets);
  merged.export_policy_revision = settingsExportPolicyRevision(merged);
  merged.llm.api_key_set = !!secretState.secrets.api_key;
  merged.llm.api_key_display = maskSecret(secretState.secrets.api_key);
  const manualKeysByAccount = normalizeManualKeysByAccount(secretState.secrets.manual_keys_by_account);
  const legacyManualKey = splitManualKeys(secretState.secrets.manual_key).join('\n');
  const manualKeyVerificationsByAccount = normalizeManualKeyVerificationsByAccount(secretState.secrets.manual_key_verifications_by_account);
  const manualKeyAccountFingerprintsByAccount = normalizeManualKeyAccountFingerprintsByAccount(
    secretState.secrets.manual_key_account_fingerprints_by_account,
    manualKeyVerificationsByAccount,
    manualKeysByAccount,
  );
  const manualKeyAccountIds = Object.keys(manualKeysByAccount).filter(accountId => !!manualKeyAccountFingerprintsByAccount[accountId]);
  const manualKeyOrphanedAccountIds = Object.keys(manualKeysByAccount).filter(accountId => !manualKeyAccountFingerprintsByAccount[accountId]);
  const manualKeyVerifiedAccountIds = verifiedManualKeyAccountIds(manualKeysByAccount, manualKeyVerificationsByAccount);
  const manualKeyVerifiedAccountFingerprints = verifiedManualKeyAccountFingerprints(manualKeysByAccount, manualKeyVerificationsByAccount);
  merged.wechat.manual_key_set = !!legacyManualKey || manualKeyAccountIds.length > 0;
  merged.wechat.manual_key_legacy_set = !!legacyManualKey;
  merged.wechat.manual_key_account_ids = manualKeyAccountIds;
  merged.wechat.manual_key_account_count = manualKeyAccountIds.length;
  merged.wechat.manual_key_orphaned_account_ids = manualKeyOrphanedAccountIds;
  merged.wechat.manual_key_orphaned_account_count = manualKeyOrphanedAccountIds.length;
  merged.wechat.manual_key_verified_account_ids = manualKeyVerifiedAccountIds;
  merged.wechat.manual_key_verified_account_count = manualKeyVerifiedAccountIds.length;
  merged.wechat.manual_key_verified_account_fingerprints_by_account = manualKeyVerifiedAccountFingerprints;
  merged.wechat.manual_key_clear_account_fingerprints_by_account = manualKeyAccountFingerprintsByAccount;
  merged._secrets_invalid = !!secretState.invalid;
  const schedulerRevisionSettings = {
    ...merged,
    llm: {
      ...merged.llm,
      api_key: secretState.secrets.api_key,
    },
    wechat: {
      ...merged.wechat,
      manual_keys_by_account: manualKeysByAccount,
      manual_key_account_fingerprints_by_account: manualKeyAccountFingerprintsByAccount,
      manual_key_verifications_by_account: manualKeyVerificationsByAccount,
    },
  };
  merged.scheduler_runtime_revision = settingsSchedulerRuntimeRevision(schedulerRevisionSettings);
  merged.scheduler_schedule_revision = settingsSchedulerScheduleRevision(schedulerRevisionSettings);
  if (secretState.invalid) {
    merged._secrets_invalid_info = publicRecoveryInfo(secretState);
  }
  if (invalid) merged._settings_invalid = publicRecoveryInfo(invalid);
  else if (recovered) merged._settings_invalid = recovered;
  if (includeSecrets) {
    merged.llm.api_key = secretState.secrets.api_key;
    merged.wechat.manual_key = legacyManualKey;
    merged.wechat.manual_key_legacy = legacyManualKey;
    merged.wechat.manual_keys_by_account = manualKeysByAccount;
    merged.wechat.manual_key_account_fingerprints_by_account = manualKeyAccountFingerprintsByAccount;
    merged.wechat.manual_key_verifications_by_account = manualKeyVerificationsByAccount;
  }
  return merged;
}

function settingsRecoveredFields(raw = {}) {
  if (!plainObject(raw)) return null;
  const fields = [];
  if (plainObject(raw.output) && Object.hasOwn(raw.output, 'dir') && !outputDirIsSafe(raw.output.dir)) {
    fields.push({
      path: 'output.dir',
      message: '输出目录不在项目 outputs 子目录内，或指向 outputs/.tmp；已临时恢复为默认输出目录。',
      recovered_value: './outputs/digests',
      rejected_value: redactRecoveryError(String(raw.output.dir || '')),
    });
  }
  if (!fields.length) return null;
  return {
    kind: 'field_recovery',
    error: fields.map(field => `${field.path}: ${field.message}`).join('; '),
    fields,
  };
}

export async function publicSettings(options = {}) {
  return stripRuntime(await loadSettings(options));
}

export function stripRuntime(settings) {
  const s = cloneJson(settings);
  delete s.llm.api_key;
  delete s.wechat.manual_key;
  delete s.wechat.manual_key_legacy;
  delete s.wechat.manual_keys_by_account;
  delete s.wechat.manual_key_account_fingerprints_by_account;
  delete s.wechat.manual_key_verifications_by_account;
  delete s.wechat.manual_key_account_fingerprint;
  if (s.output && Object.hasOwn(s.output, 'dir')) {
    s.output.dir = publicOutputDir(s.output.dir);
  }
  return s;
}

function publicOutputDir(value) {
  try {
    const dir = outputDirFromSettings({ output: { dir: value } });
    const rel = path.relative(PROJECT_ROOT, dir).replaceAll(path.sep, '/');
    return rel ? `./${rel}` : './outputs/digests';
  } catch {
    return './outputs/digests';
  }
}

export function normalizeSettings(settings) {
  const s = cloneJson(settings);
  const defaults = defaultSettings();
  s.llm = plainObject(s.llm) ? s.llm : cloneJson(defaults.llm);
  s.privacy = plainObject(s.privacy) ? s.privacy : cloneJson(defaults.privacy);
  s.link_preview = plainObject(s.link_preview) ? s.link_preview : cloneJson(defaults.link_preview);
  s.groups = plainObject(s.groups) ? s.groups : cloneJson(defaults.groups);
  s.scheduler = plainObject(s.scheduler) ? s.scheduler : cloneJson(defaults.scheduler);
  s.output = plainObject(s.output) ? s.output : cloneJson(defaults.output);
  s.render = plainObject(s.render) ? s.render : cloneJson(defaults.render);
  s.web = plainObject(s.web) ? s.web : cloneJson(defaults.web);
  s.wechat = plainObject(s.wechat) ? s.wechat : cloneJson(defaults.wechat);
  s.logging = plainObject(s.logging) ? s.logging : cloneJson(defaults.logging);
  delete s.cache;
  delete s.export_policy_revision;
  delete s.expected_export_policy_revision;
  if (s.llm) delete s.llm.clear_api_key;
  if (s.wechat) delete s.wechat.clear_manual_key;
  if (s.wechat) delete s.wechat.clear_manual_key_account_id;
  if (s.wechat) delete s.wechat.clear_manual_key_account_aliases;
  if (s.wechat) delete s.wechat.clear_legacy_manual_key;
  if (s.wechat) delete s.wechat.manual_key_account_id;
  if (s.wechat) delete s.wechat.manual_key_account_aliases;
  if (s.wechat) delete s.wechat.account_id;
  if (s.wechat) delete s.wechat.data_source;
  if (s.wechat) delete s.wechat.key_auto_scan_state;
  if (s.wechat) delete s.wechat.key_auto_scan_supported;
  if (s.wechat) delete s.wechat.key_auto_scan_can_attempt;
  if (s.wechat) delete s.wechat.key_auto_scan_reason;
  s.llm.provider = ['openai', 'anthropic'].includes(s.llm.provider) ? s.llm.provider : 'openai';
  s.llm.base_url = normalizeBaseUrl(s.llm.base_url);
  s.llm.temperature = finiteNumber(s.llm.temperature, 0.3, 0, 2);
  s.llm.timeout_ms = finiteInteger(s.llm.timeout_ms, 120000, 1000, 600000);
  s.llm.max_input_chars = finiteInteger(s.llm.max_input_chars, 60000, 1000, 1000000);
  s.llm.max_messages_per_call = finiteInteger(s.llm.max_messages_per_call, 800, 1, 20000);
  s.llm.max_image_chars_per_call = finiteInteger(s.llm.max_image_chars_per_call, 300000, 100000, 2 * 1024 * 1024);
  s.llm.ai_concurrency = finiteInteger(s.llm.ai_concurrency, 2, 1, MAX_AI_CONCURRENCY);
  s.llm.available_models = normalizeAvailableModels(s.llm.available_models);
  s.llm.models_fetched_at = s.llm.models_fetched_at ? String(s.llm.models_fetched_at).trim() : null;
  s.llm.capabilities = normalizeLlmCapabilities(s.llm.capabilities);
  s.privacy = s.privacy && typeof s.privacy === 'object' ? s.privacy : {};
  s.privacy.redact_phone = s.privacy.redact_phone !== false;
  s.privacy.redact_id_card = s.privacy.redact_id_card !== false;
  s.privacy.redact_bank_card = s.privacy.redact_bank_card !== false;
  s.privacy.redact_email = s.privacy.redact_email === true;
  s.privacy.attach_media_content = s.privacy.attach_media_content === true;
  s.link_preview = s.link_preview && typeof s.link_preview === 'object' ? s.link_preview : {};
  s.link_preview.enabled = s.link_preview.enabled !== false;
  s.link_preview.ai_web_search = s.link_preview.ai_web_search !== false;
  s.link_preview.max_links = finitePositiveIntegerOrDefault(s.link_preview.max_links, DEFAULT_LINK_PREVIEW_MAX_LINKS, MAX_LINK_PREVIEW_LINKS);
  s.link_preview.allow_private_networks = s.link_preview.allow_private_networks === true;
  s.link_preview.timeout_ms = finiteInteger(s.link_preview.timeout_ms, 8000, 1000, 60000);
  s.link_preview.max_bytes = finiteInteger(s.link_preview.max_bytes, 262144, 8192, 2 * 1024 * 1024);
  s.link_preview.max_chars_per_link = finiteInteger(s.link_preview.max_chars_per_link, 2000, 200, 10000);
  s.link_preview.max_related_links = finiteInteger(s.link_preview.max_related_links, 3, 0, 10);
  s.link_preview.max_related_bytes = finiteInteger(s.link_preview.max_related_bytes, 98304, 8192, 1024 * 1024);
  s.link_preview.max_related_chars = finiteInteger(s.link_preview.max_related_chars, 800, 200, 5000);
  s.groups = s.groups && typeof s.groups === 'object' ? s.groups : {};
  s.groups.whitelist = normalizeGroupRefs(s.groups.whitelist, Number.POSITIVE_INFINITY, { allowLegacyStrings: true });
  s.groups.overrides = Array.isArray(s.groups.overrides) ? s.groups.overrides : [];
  s.groups.recent = mergeRecentGroupRefs(s.groups.recent, [], 5);
  s.scheduler = s.scheduler && typeof s.scheduler === 'object' ? s.scheduler : {};
  s.scheduler.enabled = !!s.scheduler.enabled;
  s.scheduler.disabled_reason = s.scheduler.enabled ? '' : normalizeSchedulerDisabledReason(s.scheduler.disabled_reason);
  s.scheduler.disabled_at = s.scheduler.enabled ? '' : normalizeIsoText(s.scheduler.disabled_at);
  s.scheduler.default_interval = normalizeDurationText(s.scheduler.default_interval, '30m', { max_ms: MAX_SCHEDULER_INTERVAL_MS });
  s.scheduler.digest_window = normalizeDurationText(s.scheduler.digest_window, '4h', { max_ms: MAX_SCHEDULER_DIGEST_WINDOW_MS });
  s.scheduler.min_messages_per_digest = finiteInteger(s.scheduler.min_messages_per_digest, 30, 1, MAX_DIGEST_MIN_MESSAGES);
  s.scheduler.per_group = normalizePerGroupOverrides([
    ...(Array.isArray(s.scheduler.per_group) ? s.scheduler.per_group : []),
    ...(Array.isArray(s.groups.overrides) ? s.groups.overrides : []),
  ]);
  s.groups.overrides = [];
  if (!outputDirIsSafe(s.output.dir)) s.output.dir = defaults.output.dir;
  s.output.retention_days = finiteInteger(s.output.retention_days, 0, 0, 3650);
  s.output.filename_pattern = normalizeFilenamePattern(s.output.filename_pattern, defaults.output.filename_pattern);
  delete s.render.width_px;
  delete s.render.dpi_scale;
  s.web.host = '127.0.0.1';
  s.web.port = finiteInteger(s.web.port, 7788, 1024, 65535);
  s.web.open_browser = s.web.open_browser !== false;
  s.logging = s.logging && typeof s.logging === 'object' ? s.logging : {};
  s.logging.level = ['debug', 'info', 'warn', 'error'].includes(s.logging.level) ? s.logging.level : 'info';
  s.logging.max_mb = finiteInteger(s.logging.max_mb, 50, 1, 500);
  try {
    const logFile = resolveInsideTmp(s.logging.file || DEFAULT_LOG_FILE, 'logging.file');
    if (path.resolve(logFile) === path.resolve(TMP_DIR)) throw new Error('logging.file must be a file inside outputs/.tmp');
    s.logging.file = String(s.logging.file || DEFAULT_LOG_FILE);
  } catch {
    s.logging.file = DEFAULT_LOG_FILE;
  }
  return s;
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeIsoText(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function normalizeSchedulerDisabledReason(value = '') {
  const reason = String(value || '').trim();
  return [
    'user_disabled',
    'setup_required',
    'secrets_invalid',
    'llm_not_configured',
    'llm_base_url_missing',
    'llm_api_key_missing',
    'llm_model_missing',
    'wechat_manual_key_required',
    'manual_key_unverified',
    'scheduler_no_targets',
    'scheduler_unscoped_targets',
    'scheduler_targets_need_review',
    'reschedule_setup_required',
  ].includes(reason) ? reason : '';
}

function normalizeManualKeyAccountId(value = '') {
  return String(value || '').trim().slice(0, 200);
}

function normalizeManualKeyAccountAliases(value = []) {
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const alias = normalizeManualKeyAccountId(item);
    if (!alias || seen.has(alias)) continue;
    seen.add(alias);
    out.push(alias);
    if (out.length >= 32) break;
  }
  return out;
}

function normalizeManualKeyAccountFingerprint(value = '') {
  const text = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : '';
}

function platformPathIdentity(value = '') {
  const text = String(value || '').trim();
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

function accountIdentityPathHash(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  return crypto.createHash('sha256').update(platformPathIdentity(path.resolve(text))).digest('hex');
}

export function manualKeyAccountFingerprint(account = {}) {
  if (!plainObject(account)) return '';
  const mirror = plainObject(account.mirror) ? account.mirror : {};
  const accountId = normalizeManualKeyAccountId(account.account_id || account.id || account.wxid || '');
  // This identifies the account's source data, not the temporary project mirror or
  // the current verification phase. Those values change during a normal first copy.
  const sourceDbStorageHash = accountIdentityPathHash(account.source_db_storage || mirror.source_db_storage || account.db_storage || '');
  const sourceAccountRootHash = accountIdentityPathHash(account.source_account_root || mirror.source_account_root || account.account_root || '');
  if (!accountId || !(sourceDbStorageHash || sourceAccountRootHash)) return '';
  return crypto.createHash('sha256').update(stableJson({
    v: 4,
    account_id: accountId,
    wxid: String(account.wxid || '').trim(),
    legacy_id: String(account.legacy_id || account.id || '').trim(),
    source_db_storage_hash: sourceDbStorageHash,
    source_account_root_hash: sourceAccountRootHash,
  })).digest('hex');
}

function normalizeManualKeysByAccount(value = {}) {
  if (!plainObject(value)) return {};
  const out = {};
  for (const [rawAccountId, rawText] of Object.entries(value)) {
    const accountId = normalizeManualKeyAccountId(rawAccountId);
    const text = splitManualKeys(rawText).join('\n');
    if (!accountId || !text) continue;
    out[accountId] = text;
  }
  return out;
}

function normalizeManualKeyAccountFingerprintsByAccount(value = {}, verifications = {}, manualKeys = {}) {
  const out = {};
  if (plainObject(value)) {
    for (const [rawAccountId, rawFingerprint] of Object.entries(value)) {
      const accountId = normalizeManualKeyAccountId(rawAccountId);
      const fingerprint = normalizeManualKeyAccountFingerprint(rawFingerprint);
      if (accountId && fingerprint) out[accountId] = fingerprint;
    }
  }
  const verified = normalizeManualKeyVerificationsByAccount(verifications);
  const keys = normalizeManualKeysByAccount(manualKeys);
  for (const [accountId, record] of Object.entries(verified)) {
    if (!out[accountId]
      && record?.account_fingerprint
      && record.key_hash === manualKeyFingerprint(keys[accountId])) {
      out[accountId] = record.account_fingerprint;
    }
  }
  return out;
}

function normalizeManualKeyVerificationRecord(value = {}) {
  if (!plainObject(value)) return null;
  const keyHash = String(value.key_hash || value.hash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(keyHash)) return null;
  const sampleVerified = value.message_sample_verified === true || value.message_db_verified === true;
  if (!sampleVerified) return null;
  const coverageVerified = value.message_coverage_verified === true || value.message_db_verified === true;
  const verifiedAt = String(value.verified_at || '').trim();
  const accountFingerprint = normalizeManualKeyAccountFingerprint(value.account_fingerprint || value.account_hash || '');
  const checkedCount = Math.max(0, Number(value.message_db_checked_count || 0) || 0);
  const totalCount = Math.max(0, Number(value.message_db_total_count || 0) || 0);
  return {
    key_hash: keyHash,
    account_fingerprint: accountFingerprint,
    message_sample_verified: true,
    message_db_verified: coverageVerified,
    message_coverage_verified: coverageVerified,
    message_db_checked_count: checkedCount,
    message_db_total_count: totalCount,
    verified_at: verifiedAt && !Number.isNaN(Date.parse(verifiedAt)) ? new Date(verifiedAt).toISOString() : '',
  };
}

function normalizeManualKeyVerificationsByAccount(value = {}) {
  if (!plainObject(value)) return {};
  const out = {};
  for (const [rawAccountId, rawRecord] of Object.entries(value)) {
    const accountId = normalizeManualKeyAccountId(rawAccountId);
    const record = normalizeManualKeyVerificationRecord(rawRecord);
    if (!accountId || !record) continue;
    out[accountId] = record;
  }
  return out;
}

function manualKeyFingerprint(value = '') {
  const text = splitManualKeys(value).join('\n');
  return text ? crypto.createHash('sha256').update(text).digest('hex') : '';
}

export function manualKeyFullValidationProofMatches({
  manual_key_text = '',
  account_id = '',
  account_aliases = [],
  account_fingerprint = '',
  proof = null,
} = {}) {
  if (!plainObject(proof)) return false;
  const candidateHash = manualKeyFingerprint(manual_key_text);
  const accountId = normalizeManualKeyAccountId(account_id);
  const accountFingerprint = normalizeManualKeyAccountFingerprint(account_fingerprint);
  const proofAccountId = normalizeManualKeyAccountId(proof.account_id);
  const proofAccountFingerprint = normalizeManualKeyAccountFingerprint(proof.account_fingerprint);
  const proofCandidateHash = manualKeyFingerprint(proof.expected_manual_key_text);
  const aliases = normalizeManualKeyAccountAliases([accountId, ...(Array.isArray(account_aliases) ? account_aliases : [])]);
  const proofAliases = normalizeManualKeyAccountAliases([
    proofAccountId,
    ...(Array.isArray(proof.account_aliases) ? proof.account_aliases : []),
  ]);
  const checkedCount = Math.max(0, Number(proof.message_db_checked_count || 0) || 0);
  const totalCount = Math.max(0, Number(proof.message_db_total_count || 0) || 0);
  return !!candidateHash
    && !!accountId
    && proofAccountId === accountId
    && aliases.includes(accountId)
    && proofAliases.includes(accountId)
    && !!accountFingerprint
    && proofAccountFingerprint === accountFingerprint
    && proofCandidateHash === candidateHash
    && proof.message_db_verified === true
    && proof.message_coverage_verified === true
    && totalCount > 0
    && checkedCount >= totalCount;
}

function verifiedManualKeyAccountIds(manualKeysByAccount = {}, verificationsByAccount = {}) {
  const keys = normalizeManualKeysByAccount(manualKeysByAccount);
  const verifications = normalizeManualKeyVerificationsByAccount(verificationsByAccount);
  return Object.keys(keys)
    .filter(accountId => {
      const record = verifications[accountId];
      return !!record
        && !!record.account_fingerprint
        && record.message_coverage_verified === true
        && record.key_hash === manualKeyFingerprint(keys[accountId]);
    });
}

function verifiedManualKeyAccountFingerprints(manualKeysByAccount = {}, verificationsByAccount = {}) {
  const keys = normalizeManualKeysByAccount(manualKeysByAccount);
  const verifications = normalizeManualKeyVerificationsByAccount(verificationsByAccount);
  const out = {};
  for (const accountId of Object.keys(keys)) {
    const record = verifications[accountId];
    if (!record?.account_fingerprint) continue;
    if (record.message_coverage_verified !== true) continue;
    if (record.key_hash !== manualKeyFingerprint(keys[accountId])) continue;
    out[accountId] = record.account_fingerprint;
  }
  return out;
}

function manualKeyRecordForAccount(settings = {}, accountId = '', accountAliases = [], accountFingerprint = '') {
  const account = normalizeManualKeyAccountId(accountId);
  const expectedFingerprint = normalizeManualKeyAccountFingerprint(accountFingerprint);
  if (!account || !expectedFingerprint) return null;
  const byAccount = normalizeManualKeysByAccount(settings?.wechat?.manual_keys_by_account);
  const fingerprints = normalizeManualKeyAccountFingerprintsByAccount(
    settings?.wechat?.manual_key_account_fingerprints_by_account,
    settings?.wechat?.manual_key_verifications_by_account,
    byAccount,
  );
  if (byAccount[account] && fingerprints[account] === expectedFingerprint) {
    return { account_id: account, text: byAccount[account], aliased: false };
  }

  // Only a server-confirmed canonical identity may recover a pre-identity alias.
  // A single exact fingerprint match keeps this fallback deterministic and fail-closed.
  if (!/^wxacct_[a-f0-9]{24}$/.test(account)) return null;
  const candidates = normalizeManualKeyAccountAliases(accountAliases)
    .filter(alias => alias !== account && byAccount[alias] && fingerprints[alias] === expectedFingerprint)
    .map(alias => ({ account_id: alias, text: byAccount[alias], aliased: true }));
  return candidates.length === 1 ? candidates[0] : null;
}

export function manualKeysForAccount(settings = {}, accountId = '', accountAliases = [], accountFingerprint = '') {
  return manualKeyRecordForAccount(settings, accountId, accountAliases, accountFingerprint)?.text || '';
}

export function manualKeyVerifiedForAccount(settings = {}, accountId = '', accountAliases = [], accountFingerprint = '') {
  const account = normalizeManualKeyAccountId(accountId);
  if (!account) return false;
  const expectedFingerprint = normalizeManualKeyAccountFingerprint(accountFingerprint);
  if (!expectedFingerprint) return false;
  const publicFingerprints = plainObject(settings?.wechat?.manual_key_verified_account_fingerprints_by_account)
    ? settings.wechat.manual_key_verified_account_fingerprints_by_account
    : {};
  if (normalizeManualKeyAccountFingerprint(publicFingerprints[account]) === expectedFingerprint) return true;
  if (/^wxacct_[a-f0-9]{24}$/.test(account)) {
    const verifiedAliases = normalizeManualKeyAccountAliases(accountAliases)
      .filter(alias => alias !== account
        && normalizeManualKeyAccountFingerprint(publicFingerprints[alias]) === expectedFingerprint);
    if (verifiedAliases.length === 1) return true;
  }
  const record = manualKeyRecordForAccount(settings, account, accountAliases, expectedFingerprint);
  const text = record?.text || '';
  const fingerprint = manualKeyFingerprint(text);
  if (!fingerprint) return false;
  const verifications = normalizeManualKeyVerificationsByAccount(settings?.wechat?.manual_key_verifications_by_account);
  const verification = verifications[record?.account_id || account];
  return verification?.key_hash === fingerprint
    && verification?.message_coverage_verified === true
    && verification?.account_fingerprint === expectedFingerprint;
}

function normalizeStringList(value, limit) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))].slice(0, limit);
}

function normalizeAvailableModels(value, limit = 1000) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const id = String((typeof item === 'string' ? item : item?.id) || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id: id.slice(0, 300) });
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeGroupRefs(value, limit, { allowLegacyStrings = true } = {}) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const ref = normalizeGroupRef(item, { allowLegacyStrings });
    if (!ref) continue;
    const key = typeof ref === 'string'
      ? `legacy:${ref}`
      : `ref:${ref.account_id || '*'}:${ref.group_id || ref.group_name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
    if (out.length >= limit) break;
  }
  return out;
}

export function mergeRecentGroupRefs(refs = [], previous = [], limit = 5) {
  const perAccountLimit = Math.max(1, Math.min(50, Number(limit || 5) || 5));
  const normalized = normalizeGroupRefs(
    [...(Array.isArray(refs) ? refs : []), ...(Array.isArray(previous) ? previous : [])],
    500,
    { allowLegacyStrings: false },
  );
  const counts = new Map();
  const out = [];
  for (const ref of normalized) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) continue;
    const accountId = String(ref.account_id || ref.account || '').trim();
    const bucket = accountId || '__unscoped__';
    const count = counts.get(bucket) || 0;
    if (count >= perAccountLimit) continue;
    counts.set(bucket, count + 1);
    out.push(ref);
  }
  return out;
}

function normalizeGroupRef(item, { allowLegacyStrings = true } = {}) {
  if (typeof item === 'string') {
    const legacy = item.trim();
    if (!allowLegacyStrings || !legacy || /^\[object\s+Object\]$/i.test(legacy)) return null;
    return legacy;
  }
  if (!plainObject(item)) return null;
  const accountId = String(item.account_id || item.account || '').trim();
  const groupId = String(item.group_id || item.id || '').trim();
  const groupName = String(item.group_name || item.name || '').trim();
  const legacyGroup = String(item.group || '').trim();
  if (!groupId && !groupName && legacyGroup) {
    if (!allowLegacyStrings && !accountId) return null;
    if (!accountId) return legacyGroup;
    const ref = { account_id: accountId.slice(0, 200) };
    if (looksLikeGroupId(legacyGroup)) ref.group_id = legacyGroup.slice(0, 300);
    else ref.group_name = legacyGroup.slice(0, 300);
    return ref;
  }
  if (!groupId && !groupName) return null;
  const ref = {};
  if (accountId) ref.account_id = accountId.slice(0, 200);
  if (groupId) ref.group_id = groupId.slice(0, 300);
  if (groupName) ref.group_name = groupName.slice(0, 300);
  return ref;
}

function normalizePerGroupOverrides(value) {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .map(item => {
      const accountId = String(item?.account_id || item?.account || '').trim();
      const groupId = String(item?.group_id || item?.id || '').trim();
      const groupName = String(item?.group_name || item?.name || '').trim();
      const group = String(item?.group || groupId || groupName || '').trim();
      const keywords = Array.isArray(item?.keywords)
        ? item.keywords.map(x => String(x || '').trim()).filter(Boolean)
        : String(item?.keywords || '').split(/[,，]/).map(x => x.trim()).filter(Boolean);
      const min = finiteInteger(item?.min_messages ?? item?.min_messages_per_digest, 0, 0, MAX_DIGEST_MIN_MESSAGES);
      if (!group && !groupId && !groupName) return null;
      const out = {
        group: group || groupId || groupName,
        keywords: [...new Set(keywords)].slice(0, 20),
        min_messages: min,
      };
      if (accountId) out.account_id = accountId.slice(0, 200);
      if (groupId) out.group_id = groupId.slice(0, 300);
      else if (!groupName && accountId && looksLikeGroupId(group)) out.group_id = group.slice(0, 300);
      if (groupName) out.group_name = groupName.slice(0, 300);
      return out;
    })
    .filter(item => item && (item.keywords.length || item.min_messages > 0));
  const byRef = new Map();
  for (const item of normalized) byRef.set(perGroupOverrideKey(item), item);
  return [...byRef.values()];
}

function looksLikeGroupId(value = '') {
  return /@chatroom$/i.test(String(value || '').trim());
}

function perGroupOverrideKey(item = {}) {
  const accountId = String(item.account_id || item.account || '').trim();
  const groupId = String(item.group_id || item.id || '').trim();
  const groupName = String(item.group_name || item.name || '').trim();
  const group = String(item.group || '').trim();
  return `${accountId || '*'}::${groupId ? `id:${groupId}` : groupName ? `name:${groupName}` : `legacy:${group}`}`;
}

function normalizeLlmCapabilities(value) {
  if (!plainObject(value)) return {};
  const out = {};
  const provider = String(value.provider || '').trim();
  if (['openai', 'anthropic'].includes(provider)) out.provider = provider;
  const baseUrl = normalizeBaseUrl(value.base_url || '');
  if (baseUrl) out.base_url = baseUrl;
  const model = String(value.model || '').trim();
  if (model) out.model = model.slice(0, 200);
  const longContextModel = String(value.long_context_model || value.long_context?.model || '').trim();
  if (longContextModel) out.long_context_model = longContextModel.slice(0, 200);
  const checkedAt = String(value.checked_at || '').trim();
  if (checkedAt && !Number.isNaN(Date.parse(checkedAt))) out.checked_at = new Date(checkedAt).toISOString();
  copyLlmCapabilityItems(value, out);
  const longContext = normalizeLlmCapabilityGroup(value.long_context);
  if (Object.keys(longContext).length) {
    if (!longContext.model && out.long_context_model) longContext.model = out.long_context_model;
    out.long_context = longContext;
  }
  return out;
}

function normalizeLlmCapabilityGroup(value) {
  if (!plainObject(value)) return {};
  const out = {};
  const model = String(value.model || '').trim();
  if (model) out.model = model.slice(0, 200);
  const checkedAt = String(value.checked_at || '').trim();
  if (checkedAt && !Number.isNaN(Date.parse(checkedAt))) out.checked_at = new Date(checkedAt).toISOString();
  copyLlmCapabilityItems(value, out);
  return out;
}

function copyLlmCapabilityItems(source, out) {
  for (const key of ['summary_json', 'chat', 'responses', 'responses_web_search', 'messages']) {
    const value = source || {};
    const item = value[key];
    if (!plainObject(item) || typeof item.ok !== 'boolean') continue;
    out[key] = {
      ok: !!item.ok,
      latency_ms: finiteInteger(item.latency_ms, 0, 0, 600000),
    };
    const error = String(item.error || '').trim();
    if (error && !item.ok) out[key].error = error.slice(0, 300);
  }
}

function finiteNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function finiteInteger(value, fallback, min, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function finitePositiveIntegerOrDefault(value, fallback, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, n);
}

export function durationToMs(value) {
  const match = String(value || '').trim().match(/^(\d+)\s*([mhd])$/i);
  if (!match) return 0;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const unit = match[2].toLowerCase();
  const scale = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * scale;
}

function normalizeDurationText(value, fallback, { max_ms = 0 } = {}) {
  const raw = String(value || '').trim().toLowerCase();
  const ms = durationToMs(raw);
  if (!ms) return fallback;
  if (max_ms && ms > max_ms) return clampDurationText(raw, max_ms, fallback);
  return raw;
}

function clampDurationText(raw, maxMs, fallback) {
  const match = String(raw || '').trim().toLowerCase().match(/^(\d+)\s*([mhd])$/);
  if (!match) return fallback;
  const unit = match[2];
  const scale = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  const amount = Math.max(1, Math.floor(Number(maxMs || 0) / scale));
  return amount ? `${amount}${unit}` : fallback;
}

function outputDirIsSafe(value) {
  try {
    outputDirFromSettings({ output: { dir: value } });
    return true;
  } catch {
    return false;
  }
}

function normalizeFilenamePattern(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw || toWellFormedText(raw) !== raw || [...raw].length > 160) return fallback;
  if (/[\\/]|(?:^|[.])\.(?:[.]|$)|[<>:"|?*\x00-\x1F]/.test(raw)) return fallback;
  if (!/\{id8\}|\{group\}|\{since\}|\{until\}/.test(raw)) return fallback;
  return /\.png$/i.test(raw) ? raw : `${raw}.png`;
}

export function validateSettingsObject(settings, { requireBaseUrl = false } = {}) {
  const errors = [];
  if (!['openai', 'anthropic'].includes(settings.llm.provider)) errors.push('llm.provider must be openai or anthropic');
  if (settings.llm.base_url || requireBaseUrl) {
    try {
      const u = new URL(settings.llm.base_url);
      if (!['http:', 'https:'].includes(u.protocol)) errors.push('llm.base_url must be http(s)');
    } catch {
      errors.push('llm.base_url must be a valid URL');
    }
  }
  if (!outputDirIsSafe(settings.output?.dir)) {
    errors.push('output.dir must stay inside outputs/ and outside outputs/.tmp');
  }
  if (settings.web.host !== '127.0.0.1') errors.push('web.host is locked to 127.0.0.1');
  const schedulerIntervalMs = durationToMs(settings.scheduler.default_interval);
  if (!schedulerIntervalMs) errors.push('scheduler.default_interval must look like 30m, 4h, or 1d');
  else if (schedulerIntervalMs > MAX_SCHEDULER_INTERVAL_MS) errors.push('scheduler.default_interval must be 24d or less');
  const schedulerDigestWindowMs = durationToMs(settings.scheduler.digest_window);
  if (!schedulerDigestWindowMs) errors.push('scheduler.digest_window must look like 30m, 4h, or 1d');
  else if (schedulerDigestWindowMs > MAX_SCHEDULER_DIGEST_WINDOW_MS) errors.push('scheduler.digest_window must be 24d or less');
  return errors;
}

function settingsCollectionLimitError(message, code, currentCount, maxCount) {
  const err = new Error(message);
  err.status = 422;
  err.code = code;
  err.public_code = code;
  err.current_count = currentCount;
  err.max_count = maxCount;
  return err;
}

function assertStrictIntegerSettingsPatch(patch = {}) {
  const fields = [
    { owner: patch.llm, key: 'ai_concurrency', min: 1, max: MAX_AI_CONCURRENCY, label: `llm.ai_concurrency must be an integer from 1 to ${MAX_AI_CONCURRENCY}` },
    { owner: patch.output, key: 'retention_days', min: 0, max: 3650, label: 'output.retention_days must be an integer from 0 to 3650' },
  ];
  for (const field of fields) {
    if (!plainObject(field.owner) || !Object.hasOwn(field.owner, field.key)) continue;
    const value = field.owner[field.key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= field.min && value <= field.max) continue;
    const err = new Error(field.label);
    err.status = 400;
    err.code = 'settings_integer_invalid';
    err.public_code = 'settings_integer_invalid';
    throw err;
  }
}

function assertTouchedSettingsCollectionsFit(patch = {}, merged = {}) {
  const touchesWhitelist = plainObject(patch.groups) && Object.hasOwn(patch.groups, 'whitelist');
  const touchesPerGroup = (plainObject(patch.scheduler) && Object.hasOwn(patch.scheduler, 'per_group'))
    || (plainObject(patch.groups) && Object.hasOwn(patch.groups, 'overrides'));
  const whitelistCount = Array.isArray(merged.groups?.whitelist) ? merged.groups.whitelist.length : 0;
  const perGroupCount = Array.isArray(merged.scheduler?.per_group) ? merged.scheduler.per_group.length : 0;
  if (touchesWhitelist && whitelistCount > MAX_GROUP_WHITELIST_REFS) {
    throw settingsCollectionLimitError(
      `白名单共有 ${whitelistCount} 条，超过上限 ${MAX_GROUP_WHITELIST_REFS} 条；本次设置未保存。请先移除不再使用的群。`,
      'settings_whitelist_limit_exceeded',
      whitelistCount,
      MAX_GROUP_WHITELIST_REFS,
    );
  }
  if (touchesPerGroup && perGroupCount > MAX_PER_GROUP_OVERRIDES) {
    throw settingsCollectionLimitError(
      `每群自动检查规则共有 ${perGroupCount} 条，超过上限 ${MAX_PER_GROUP_OVERRIDES} 条；本次设置未保存。请先移除不再使用的规则。`,
      'settings_per_group_limit_exceeded',
      perGroupCount,
      MAX_PER_GROUP_OVERRIDES,
    );
  }
}

export async function saveSettingsPatch(patch, options = {}) {
  return withSettingsSaveLock(() => saveSettingsPatchUnlocked(patch, options));
}

export async function withSettingsSaveTransaction(action) {
  return withSettingsSaveLock(action);
}

export function beginSettingsWriteRequest() {
  if (SETTINGS_WRITE_REQUEST_COUNT === 0) {
    SETTINGS_WRITE_REQUEST_IDLE = new Promise(resolve => {
      RESOLVE_SETTINGS_WRITE_REQUEST_IDLE = resolve;
    });
  }
  SETTINGS_WRITE_REQUEST_COUNT += 1;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    SETTINGS_WRITE_REQUEST_COUNT = Math.max(0, SETTINGS_WRITE_REQUEST_COUNT - 1);
    if (SETTINGS_WRITE_REQUEST_COUNT !== 0) return;
    const resolve = RESOLVE_SETTINGS_WRITE_REQUEST_IDLE;
    RESOLVE_SETTINGS_WRITE_REQUEST_IDLE = null;
    resolve?.();
  };
}

export async function waitForSettingsSavesToSettle() {
  if (SETTINGS_SAVE_CONTEXT.getStore()) return;
  while (true) {
    const requestIdle = SETTINGS_WRITE_REQUEST_IDLE;
    await requestIdle.catch(() => {});
    const pending = SETTINGS_SAVE_QUEUE;
    await pending.catch(() => {});
    if (SETTINGS_WRITE_REQUEST_COUNT === 0
      && requestIdle === SETTINGS_WRITE_REQUEST_IDLE
      && pending === SETTINGS_SAVE_QUEUE) return;
  }
}

export async function withSettledSettingsWrites(action) {
  if (SETTINGS_SAVE_CONTEXT.getStore()) return action();
  while (true) {
    await waitForSettingsSavesToSettle();
    let retry = false;
    const result = await withSettingsSaveLock(async () => {
      if (SETTINGS_WRITE_REQUEST_COUNT > 0) {
        retry = true;
        return undefined;
      }
      return action();
    });
    if (!retry) return result;
  }
}

export async function saveSettingsPatchInTransaction(patch, options = {}) {
  return saveSettingsPatchUnlocked(patch, options);
}

export async function saveManualKeyVerificationForAccount({ account_id = '', account_aliases = [], account_fingerprint = '', previous_account_fingerprint = '', expected_manual_key_text = '', expected_revision = '', message_db_verified = false, message_db_checked_count = 0, message_db_total_count = 0, settingsFile = SETTINGS_FILE, secretsFile = SECRETS_FILE } = {}) {
  return withSettingsSaveLock(() => saveManualKeyVerificationForAccountUnlocked({ account_id, account_aliases, account_fingerprint, previous_account_fingerprint, expected_manual_key_text, expected_revision, message_db_verified, message_db_checked_count, message_db_total_count, settingsFile, secretsFile }));
}

export async function saveLegacyManualKeyForAccount({ account_id = '', account_aliases = [], account_fingerprint = '', expected_manual_key_text = '', expected_revision = '', message_db_verified = false, message_db_checked_count = 0, message_db_total_count = 0, settingsFile = SETTINGS_FILE, secretsFile = SECRETS_FILE } = {}) {
  return withSettingsSaveLock(() => saveLegacyManualKeyForAccountUnlocked({ account_id, account_aliases, account_fingerprint, expected_manual_key_text, expected_revision, message_db_verified, message_db_checked_count, message_db_total_count, settingsFile, secretsFile }));
}

async function withSettingsSaveLock(action) {
  if (SETTINGS_SAVE_CONTEXT.getStore()) return action();
  const run = SETTINGS_SAVE_QUEUE.then(
    () => SETTINGS_SAVE_CONTEXT.run(true, action),
    () => SETTINGS_SAVE_CONTEXT.run(true, action),
  );
  SETTINGS_SAVE_QUEUE = run.catch(() => {});
  return run;
}

async function saveManualKeyVerificationForAccountUnlocked({ account_id = '', account_aliases = [], account_fingerprint = '', previous_account_fingerprint = '', expected_manual_key_text = '', expected_revision = '', message_db_verified = false, message_db_checked_count = 0, message_db_total_count = 0, settingsFile = SETTINGS_FILE, secretsFile = SECRETS_FILE } = {}) {
  const accountId = normalizeManualKeyAccountId(account_id);
  const aliases = normalizeManualKeyAccountAliases([accountId, ...(Array.isArray(account_aliases) ? account_aliases : [])]);
  if (!accountId || !aliases.length) {
    const err = new Error('记录手动数据库密钥验证结果必须带当前微信账号。');
    err.status = 428;
    err.code = 'manual_key_account_required';
    err.public_code = 'manual_key_account_required';
    throw err;
  }
  const accountFingerprint = normalizeManualKeyAccountFingerprint(account_fingerprint);
  if (!accountFingerprint) {
    const err = new Error('记录手动数据库密钥验证结果必须带当前账号的项目副本指纹。');
    err.status = 428;
    err.code = 'manual_key_account_fingerprint_required';
    err.public_code = 'manual_key_account_fingerprint_required';
    throw err;
  }
  const current = await loadSettings({ includeSecrets: true, settingsFile, secretsFile });
  const expectedRevision = String(expected_revision || '').trim();
  if (expectedRevision && current.settings_revision && expectedRevision !== current.settings_revision) {
    const err = new Error('设置已被另一个页面或请求更新，请刷新设置页后再验证手动数据库密钥。');
    err.status = 409;
    err.code = 'settings_revision_conflict';
    err.current_settings_revision = current.settings_revision;
    throw err;
  }
  // Identity confirmation can change the derived wxid in an otherwise unchanged account.
  // The caller supplies the pre-validation fingerprint only after proving the same mirror/account.
  const previousAccountFingerprint = normalizeManualKeyAccountFingerprint(previous_account_fingerprint);
  const manualRecord = manualKeyRecordForAccount(current, accountId, aliases, accountFingerprint)
    || (previousAccountFingerprint && previousAccountFingerprint !== accountFingerprint
      ? manualKeyRecordForAccount(current, accountId, aliases, previousAccountFingerprint)
      : null);
  const manualText = manualRecord?.text || '';
  const keyHash = manualKeyFingerprint(manualText);
  if (!keyHash) {
    const err = new Error('当前微信账号没有可记录验证状态的手动数据库密钥候选。');
    err.status = 428;
    err.code = 'manual_key_account_required';
    err.public_code = 'manual_key_account_required';
    throw err;
  }
  const expectedKeyHash = manualKeyFingerprint(expected_manual_key_text);
  if (expectedKeyHash && expectedKeyHash !== keyHash) {
    const err = new Error('手动数据库密钥候选已在验证过程中被修改；本次验证结果未写入。请重新验证当前已保存候选。');
    err.status = 409;
    err.code = 'manual_key_changed_during_validation';
    err.public_code = 'manual_key_changed_during_validation';
    throw err;
  }
  const messageCoverageVerified = message_db_verified === true;
  const nextSecrets = {
    api_key: current.llm.api_key || '',
    manual_key: current.wechat.manual_key_legacy || current.wechat.manual_key || '',
    manual_keys_by_account: normalizeManualKeysByAccount(current.wechat.manual_keys_by_account),
    manual_key_account_fingerprints_by_account: normalizeManualKeyAccountFingerprintsByAccount(current.wechat.manual_key_account_fingerprints_by_account, current.wechat.manual_key_verifications_by_account, current.wechat.manual_keys_by_account),
    manual_key_verifications_by_account: normalizeManualKeyVerificationsByAccount(current.wechat.manual_key_verifications_by_account),
  };
  const sourceAccountId = normalizeManualKeyAccountId(manualRecord?.account_id);
  const previousVerification = nextSecrets.manual_key_verifications_by_account[accountId]
    || (sourceAccountId ? nextSecrets.manual_key_verifications_by_account[sourceAccountId] : null);
  const preserveFullVerification = messageCoverageVerified !== true
    && previousVerification?.key_hash === keyHash
    && previousVerification?.account_fingerprint === accountFingerprint
    && previousVerification?.message_coverage_verified === true;
  for (const alias of normalizeManualKeyAccountAliases([accountId, sourceAccountId, ...aliases])) {
    delete nextSecrets.manual_keys_by_account[alias];
    delete nextSecrets.manual_key_account_fingerprints_by_account[alias];
    delete nextSecrets.manual_key_verifications_by_account[alias];
  }
  nextSecrets.manual_keys_by_account[accountId] = manualText;
  nextSecrets.manual_key_account_fingerprints_by_account[accountId] = accountFingerprint;
  nextSecrets.manual_key_verifications_by_account[accountId] = preserveFullVerification
    ? previousVerification
    : {
        key_hash: keyHash,
        account_fingerprint: accountFingerprint,
        message_sample_verified: true,
        message_db_verified: messageCoverageVerified,
        message_coverage_verified: messageCoverageVerified,
        message_db_checked_count: Math.max(0, Number(message_db_checked_count || 0) || 0),
        message_db_total_count: Math.max(0, Number(message_db_total_count || 0) || 0),
        verified_at: new Date().toISOString(),
      };
  await saveSecrets(nextSecrets, { file: secretsFile, settingsFile });
  return publicSettings({ settingsFile, secretsFile });
}

async function saveLegacyManualKeyForAccountUnlocked({ account_id = '', account_aliases = [], account_fingerprint = '', expected_manual_key_text = '', expected_revision = '', message_db_verified = false, message_db_checked_count = 0, message_db_total_count = 0, settingsFile = SETTINGS_FILE, secretsFile = SECRETS_FILE } = {}) {
  const accountId = normalizeManualKeyAccountId(account_id);
  const aliases = normalizeManualKeyAccountAliases([accountId, ...(Array.isArray(account_aliases) ? account_aliases : [])]);
  if (!accountId || !aliases.length) {
    const err = new Error('迁移旧版全局手动数据库密钥必须带当前微信账号。');
    err.status = 428;
    err.code = 'manual_key_account_required';
    err.public_code = 'manual_key_account_required';
    throw err;
  }
  const accountFingerprint = normalizeManualKeyAccountFingerprint(account_fingerprint);
  if (!accountFingerprint) {
    const err = new Error('迁移旧版全局手动数据库密钥必须带当前账号的项目副本指纹。');
    err.status = 428;
    err.code = 'manual_key_account_fingerprint_required';
    err.public_code = 'manual_key_account_fingerprint_required';
    throw err;
  }
  if (message_db_verified !== true) {
    const err = new Error('旧版全局手动数据库密钥只有在当前账号全部消息库分片验证通过后才能绑定；本次未修改本机密钥设置。');
    err.status = 428;
    err.code = 'manual_key_full_validation_required';
    err.public_code = 'manual_key_full_validation_required';
    throw err;
  }
  const current = await loadSettings({ includeSecrets: true, settingsFile, secretsFile });
  const expectedRevision = String(expected_revision || '').trim();
  if (expectedRevision && current.settings_revision && expectedRevision !== current.settings_revision) {
    const err = new Error('设置已被另一个页面或请求更新，请刷新设置页后再验证手动数据库密钥。');
    err.status = 409;
    err.code = 'settings_revision_conflict';
    err.current_settings_revision = current.settings_revision;
    throw err;
  }
  const existingAccountText = normalizeManualKeysText(manualKeysForAccount(current, accountId, aliases, accountFingerprint));
  const legacyText = normalizeManualKeysText(current.wechat.manual_key_legacy || current.wechat.manual_key || '');
  if (!legacyText) return publicSettings({ settingsFile, secretsFile });
  const expectedText = normalizeManualKeysText(expected_manual_key_text || '');
  if (expectedText && expectedText !== legacyText) {
    const err = new Error('旧版全局手动数据库密钥在验证期间已变化，已停止自动绑定到当前账号。');
    err.status = 409;
    err.code = 'manual_key_changed_during_validation';
    err.public_code = 'manual_key_changed_during_validation';
    throw err;
  }
  const mergedText = normalizeManualKeysText([existingAccountText, legacyText].filter(Boolean).join('\n'));
  if (!mergedText) return publicSettings({ settingsFile, secretsFile });
  const messageCoverageVerified = message_db_verified === true;
  const nextSecrets = {
    api_key: current.llm.api_key || '',
    manual_key: legacyText,
    manual_keys_by_account: normalizeManualKeysByAccount(current.wechat.manual_keys_by_account),
    manual_key_account_fingerprints_by_account: normalizeManualKeyAccountFingerprintsByAccount(current.wechat.manual_key_account_fingerprints_by_account, current.wechat.manual_key_verifications_by_account, current.wechat.manual_keys_by_account),
    manual_key_verifications_by_account: normalizeManualKeyVerificationsByAccount(current.wechat.manual_key_verifications_by_account),
  };
  for (const alias of aliases) {
    delete nextSecrets.manual_keys_by_account[alias];
    delete nextSecrets.manual_key_account_fingerprints_by_account[alias];
    delete nextSecrets.manual_key_verifications_by_account[alias];
  }
  const keyHash = manualKeyFingerprint(mergedText);
  nextSecrets.manual_keys_by_account[accountId] = mergedText;
  nextSecrets.manual_key_account_fingerprints_by_account[accountId] = accountFingerprint;
  if (keyHash) {
    nextSecrets.manual_key_verifications_by_account[accountId] = {
      key_hash: keyHash,
      account_fingerprint: accountFingerprint,
      message_sample_verified: true,
      message_db_verified: messageCoverageVerified,
      message_coverage_verified: messageCoverageVerified,
      message_db_checked_count: Math.max(0, Number(message_db_checked_count || 0) || 0),
      message_db_total_count: Math.max(0, Number(message_db_total_count || 0) || 0),
      verified_at: new Date().toISOString(),
    };
  }
  await saveSecrets(nextSecrets, { file: secretsFile, settingsFile });
  return publicSettings({ settingsFile, secretsFile });
}

async function saveSettingsPatchUnlocked(patch, {
  settingsFile = SETTINGS_FILE,
  secretsFile = SECRETS_FILE,
  expected_revision = '',
  verified_manual_key = null,
  storage_transaction = null,
} = {}) {
  if (storage_transaction !== null && typeof storage_transaction?.run !== 'function') {
    throw Object.assign(new Error('settings storage transaction participant is invalid'), {
      code: 'settings_storage_transaction_invalid',
      public_code: 'settings_storage_transaction_invalid',
      status: 500,
    });
  }
  const settingsExisted = await fsp.stat(settingsFile).then(
    stat => stat.isFile(),
    e => {
      if (e?.code === 'ENOENT') return false;
      throw e;
    },
  );
  const current = await loadSettings({ includeSecrets: true, settingsFile, secretsFile });
  const nextPatch = cloneJson(patch || {});
  assertStrictIntegerSettingsPatch(nextPatch);
  const requestContext = plainObject(nextPatch._request_context || nextPatch.request_context)
    ? cloneJson(nextPatch._request_context || nextPatch.request_context)
    : {};
  const replaceInvalidSecrets = requestContext.replace_invalid_secrets === true;
  const requestAccountFingerprint = normalizeManualKeyAccountFingerprint(
    requestContext.account_fingerprint
      || nextPatch.wechat?.manual_key_account_fingerprint
      || nextPatch.wechat?.account_fingerprint
      || '',
  );
  const patchExpectedRevision = String(nextPatch.base_settings_revision || nextPatch.settings_revision || nextPatch.expected_settings_revision || '').trim();
  const expectedRevision = String(expected_revision || patchExpectedRevision || '').trim();
  if (expectedRevision && current.settings_revision && expectedRevision !== current.settings_revision) {
    const err = new Error('设置已被另一个页面或请求更新，请刷新设置页后再保存。');
    err.status = 409;
    err.code = 'settings_revision_conflict';
    err.current_settings_revision = current.settings_revision;
    throw err;
  }
  const patchOps = normalizeSettingsPatchOperations(nextPatch.settings_ops || nextPatch._settings_ops);
  delete nextPatch.base_settings_revision;
  delete nextPatch.expected_settings_revision;
  delete nextPatch.settings_revision;
  delete nextPatch.settings_ops;
  delete nextPatch._settings_ops;
  delete nextPatch.request_context;
  delete nextPatch._request_context;
  const nextSecrets = {
    api_key: current.llm.api_key || '',
    manual_key: current.wechat.manual_key_legacy || current.wechat.manual_key || '',
    manual_keys_by_account: normalizeManualKeysByAccount(current.wechat.manual_keys_by_account),
    manual_key_account_fingerprints_by_account: normalizeManualKeyAccountFingerprintsByAccount(current.wechat.manual_key_account_fingerprints_by_account, current.wechat.manual_key_verifications_by_account, current.wechat.manual_keys_by_account),
    manual_key_verifications_by_account: normalizeManualKeyVerificationsByAccount(current.wechat.manual_key_verifications_by_account),
  };
  let secretsChanged = false;

  if (nextPatch.wechat?.clear_orphaned_manual_key === true
    && (Object.hasOwn(nextPatch.wechat, 'manual_key')
      || nextPatch.wechat?.clear_manual_key
      || nextPatch.wechat?.clear_legacy_manual_key === true)) {
    const err = new Error('孤立手动密钥只能单独清除；已拒绝混合清除请求，避免扩大删除范围。');
    err.status = 400;
    err.code = 'manual_key_orphaned_clear_scope_conflict';
    err.public_code = 'manual_key_orphaned_clear_scope_conflict';
    throw err;
  }

  if (nextPatch.llm && Object.hasOwn(nextPatch.llm, 'api_key')) {
    const value = String(nextPatch.llm.api_key || '').trim();
    if (!value) {
      if (nextPatch.llm.clear_api_key === true) {
        delete nextPatch.llm.api_key;
      } else {
      const err = new Error('API Key 为空不会自动清除已保存 Key；请点击清除按钮或提交 clear_api_key。');
      err.status = 400;
      err.code = 'ai_api_key_empty';
      err.public_code = 'ai_api_key_empty';
      throw err;
      }
    }
    if (value) {
      if (value.length > MAX_LLM_API_KEY_CHARS) {
        const err = new Error('API Key 太长；请只粘贴单个 Key，不要粘贴 JSON、诊断包或多 Key 文件。');
        err.status = 400;
        err.code = 'ai_api_key_invalid';
        throw err;
      }
      nextSecrets.api_key = value;
      secretsChanged = true;
      delete nextPatch.llm.api_key;
    }
  }
  if (nextPatch.llm?.clear_api_key) {
    nextSecrets.api_key = '';
    secretsChanged = true;
    nextPatch.llm.available_models = [];
    nextPatch.llm.models_fetched_at = null;
    nextPatch.llm.capabilities = {};
    delete nextPatch.llm.clear_api_key;
  }
  if (nextPatch.wechat && Object.hasOwn(nextPatch.wechat, 'manual_key')) {
    const accountId = normalizeManualKeyAccountId(
      nextPatch.wechat.manual_key_account_id
      || nextPatch.wechat.clear_manual_key_account_id
      || nextPatch.wechat.account_id
      || nextPatch.account_id,
    );
    if (!accountId) {
      const err = new Error('保存手动数据库密钥必须带当前微信账号。请先确认右上角账号后再保存。');
      err.status = 428;
      err.code = 'manual_key_account_required';
      err.public_code = 'manual_key_account_required';
      throw err;
    }
    const accountAliases = normalizeManualKeyAccountAliases([
      accountId,
      ...(Array.isArray(nextPatch.wechat.manual_key_account_aliases) ? nextPatch.wechat.manual_key_account_aliases : []),
    ]);
    if (!requestAccountFingerprint) {
      const err = new Error('保存手动数据库密钥必须带当前账号的本地数据指纹。请刷新账号列表后重试。');
      err.status = 428;
      err.code = 'manual_key_account_fingerprint_required';
      err.public_code = 'manual_key_account_fingerprint_required';
      throw err;
    }
    const value = normalizeManualKeysText(nextPatch.wechat.manual_key);
    if (!value) {
      if (nextPatch.wechat.clear_manual_key === true) {
        delete nextPatch.wechat.manual_key;
      } else {
        const err = new Error('手动数据库密钥为空不会自动清除已保存候选；请点击清除当前账号手动密钥或提交 clear_manual_key。');
        err.status = 400;
        err.code = 'manual_key_empty';
        err.public_code = 'manual_key_empty';
        throw err;
      }
    }
    if (value) {
      const currentKeyHash = manualKeyFingerprint(manualKeysForAccount(current, accountId, accountAliases, requestAccountFingerprint));
      const currentVerifications = normalizeManualKeyVerificationsByAccount(current.wechat.manual_key_verifications_by_account);
      const previousVerification = accountAliases
        .map(alias => currentVerifications[alias])
        .find(record => record?.key_hash && record.key_hash === currentKeyHash) || null;
      const nextKeyHash = manualKeyFingerprint(value);
      const verifiedManualKey = plainObject(verified_manual_key) ? verified_manual_key : null;
      const verifiedManualKeyAccountId = normalizeManualKeyAccountId(verifiedManualKey?.account_id || '');
      const verifiedManualKeyFingerprint = normalizeManualKeyAccountFingerprint(verifiedManualKey?.account_fingerprint || '');
      const verifiedManualKeyMessageCoverageVerified = verifiedManualKey?.message_coverage_verified === true && verifiedManualKey?.message_db_verified === true;
      const verifiedManualKeyAliases = normalizeManualKeyAccountAliases([
        verifiedManualKeyAccountId,
        ...(Array.isArray(verifiedManualKey?.account_aliases) ? verifiedManualKey.account_aliases : []),
      ]);
      const verifiedManualKeyHash = manualKeyFingerprint(verifiedManualKey?.expected_manual_key_text || '');
      const verifiedManualKeyMatchesAccount = verifiedManualKeyAliases.length
        && accountAliases.some(alias => verifiedManualKeyAliases.includes(alias));
      const verifiedManualKeyMatchesFingerprint = !!verifiedManualKeyFingerprint
        && !!requestAccountFingerprint
        && verifiedManualKeyFingerprint === requestAccountFingerprint;
      const existingFullVerificationMatches = previousVerification?.key_hash === nextKeyHash
        && previousVerification?.account_fingerprint === requestAccountFingerprint
        && previousVerification?.message_coverage_verified === true;
      const submittedFullVerificationMatches = manualKeyFullValidationProofMatches({
        manual_key_text: value,
        account_id: accountId,
        account_aliases: accountAliases,
        account_fingerprint: requestAccountFingerprint,
        proof: verifiedManualKey,
      });
      if (!existingFullVerificationMatches && !submittedFullVerificationMatches) {
        const err = new Error('新的手动数据库密钥候选尚未通过当前账号全部消息库分片验证；本次没有替换已保存候选。请先验证当前输入后再保存。');
        err.status = 428;
        err.code = 'manual_key_full_validation_required';
        err.public_code = 'manual_key_full_validation_required';
        throw err;
      }
      for (const alias of accountAliases) delete nextSecrets.manual_keys_by_account[alias];
      for (const alias of accountAliases) delete nextSecrets.manual_key_account_fingerprints_by_account[alias];
      for (const alias of accountAliases) delete nextSecrets.manual_key_verifications_by_account[alias];
      nextSecrets.manual_keys_by_account[accountId] = value;
      nextSecrets.manual_key_account_fingerprints_by_account[accountId] = requestAccountFingerprint;
      if (submittedFullVerificationMatches && verifiedManualKeyHash && verifiedManualKeyHash === nextKeyHash && verifiedManualKeyMatchesAccount && verifiedManualKeyMatchesFingerprint && verifiedManualKeyMessageCoverageVerified) {
        nextSecrets.manual_key_verifications_by_account[accountId] = {
          key_hash: nextKeyHash,
          account_fingerprint: verifiedManualKeyFingerprint,
          message_sample_verified: true,
          message_db_verified: true,
          message_coverage_verified: true,
          message_db_checked_count: Math.max(0, Number(verifiedManualKey.message_db_checked_count || 0) || 0),
          message_db_total_count: Math.max(0, Number(verifiedManualKey.message_db_total_count || 0) || 0),
          verified_at: new Date().toISOString(),
        };
      } else if (requestAccountFingerprint
        && previousVerification?.key_hash === nextKeyHash
        && previousVerification?.account_fingerprint === requestAccountFingerprint) {
        nextSecrets.manual_key_verifications_by_account[accountId] = previousVerification;
      }
      secretsChanged = true;
      delete nextPatch.wechat.manual_key;
      delete nextPatch.wechat.manual_key_account_id;
      delete nextPatch.wechat.manual_key_account_aliases;
      delete nextPatch.wechat.manual_key_account_fingerprint;
      delete nextPatch.wechat.account_fingerprint;
      delete nextPatch.wechat.account_id;
      delete nextPatch.account_id;
    }
  }
  delete nextPatch.account_id;
  delete nextPatch.account;
  delete nextPatch.account_aliases;
  if (nextPatch.wechat?.clear_orphaned_manual_key === true) {
    const orphanedAccountId = normalizeManualKeyAccountId(nextPatch.wechat.clear_orphaned_manual_key_account_id);
    if (!orphanedAccountId) {
      const err = new Error('清除孤立手动密钥必须带存储中的精确账号 ID。');
      err.status = 428;
      err.code = 'manual_key_orphaned_account_required';
      err.public_code = 'manual_key_orphaned_account_required';
      throw err;
    }
    const orphanedKey = String(nextSecrets.manual_keys_by_account[orphanedAccountId] || '').trim();
    const orphanedFingerprint = normalizeManualKeyAccountFingerprint(
      nextSecrets.manual_key_account_fingerprints_by_account[orphanedAccountId]
        || nextSecrets.manual_key_verifications_by_account[orphanedAccountId]?.account_fingerprint
        || '',
    );
    if (!orphanedKey) {
      const err = new Error('指定账号没有孤立手动密钥候选；请刷新设置页后重试。');
      err.status = 409;
      err.code = 'manual_key_orphaned_account_not_found';
      err.public_code = 'manual_key_orphaned_account_not_found';
      throw err;
    }
    if (orphanedFingerprint) {
      const err = new Error('指定候选已经绑定本地数据指纹，不能按孤立记录清除；请使用当前账号清除操作。');
      err.status = 409;
      err.code = 'manual_key_orphaned_clear_scope_changed';
      err.public_code = 'manual_key_orphaned_clear_scope_changed';
      throw err;
    }
    delete nextSecrets.manual_keys_by_account[orphanedAccountId];
    delete nextSecrets.manual_key_account_fingerprints_by_account[orphanedAccountId];
    delete nextSecrets.manual_key_verifications_by_account[orphanedAccountId];
    secretsChanged = true;
    delete nextPatch.wechat.clear_orphaned_manual_key;
    delete nextPatch.wechat.clear_orphaned_manual_key_account_id;
  }
  if (nextPatch.wechat?.clear_legacy_manual_key === true && !nextPatch.wechat?.clear_manual_key) {
    nextSecrets.manual_key = '';
    secretsChanged = true;
    delete nextPatch.wechat.clear_legacy_manual_key;
  }
  if (nextPatch.wechat?.clear_manual_key) {
    const clearAccountId = normalizeManualKeyAccountId(
      nextPatch.wechat.clear_manual_key_account_id
      || nextPatch.wechat.manual_key_account_id
      || nextPatch.wechat.account_id
      || nextPatch.account_id,
    );
    const clearAccountAliases = normalizeManualKeyAccountAliases([
      clearAccountId,
      ...(Array.isArray(nextPatch.wechat.clear_manual_key_account_aliases) ? nextPatch.wechat.clear_manual_key_account_aliases : []),
      ...(Array.isArray(nextPatch.wechat.manual_key_account_aliases) ? nextPatch.wechat.manual_key_account_aliases : []),
    ]);
    if (!clearAccountId && !clearAccountAliases.length) {
      const err = new Error('清除手动数据库密钥必须带当前微信账号。已拒绝执行全量清除，避免误删其他账号候选。');
      err.status = 428;
      err.code = 'manual_key_account_required';
      err.public_code = 'manual_key_account_required';
      throw err;
    }
    if (!requestAccountFingerprint) {
      const err = new Error('清除手动数据库密钥必须带当前账号的本地数据指纹。请刷新账号列表后重试。');
      err.status = 428;
      err.code = 'manual_key_account_fingerprint_required';
      err.public_code = 'manual_key_account_fingerprint_required';
      throw err;
    }
    if (clearAccountId && !manualKeysForAccount(current, clearAccountId, clearAccountAliases, requestAccountFingerprint)) {
      const err = new Error('当前账号本地数据身份已变化，未清除旧身份下保存的手动数据库密钥。请刷新账号列表后重试。');
      err.status = 409;
      err.code = 'manual_key_account_fingerprint_changed';
      err.public_code = 'manual_key_account_fingerprint_changed';
      throw err;
    }
    for (const alias of clearAccountAliases) {
      delete nextSecrets.manual_keys_by_account[alias];
      delete nextSecrets.manual_key_account_fingerprints_by_account[alias];
      delete nextSecrets.manual_key_verifications_by_account[alias];
    }
    if (nextPatch.wechat.clear_legacy_manual_key === true) nextSecrets.manual_key = '';
    secretsChanged = true;
    delete nextPatch.wechat.clear_manual_key;
    delete nextPatch.wechat.clear_manual_key_account_id;
    delete nextPatch.wechat.clear_manual_key_account_aliases;
    delete nextPatch.wechat.manual_key_account_fingerprint;
    delete nextPatch.wechat.account_fingerprint;
    delete nextPatch.wechat.clear_legacy_manual_key;
  }
  if (nextPatch.llm && Object.keys(nextPatch.llm).length === 0) delete nextPatch.llm;
  if (nextPatch.wechat && Object.keys(nextPatch.wechat).length === 0) delete nextPatch.wechat;

  if (nextPatch.output && Object.hasOwn(nextPatch.output, 'dir') && !outputDirIsSafe(nextPatch.output.dir)) {
    const err = new Error('output.dir must stay inside outputs/ and outside outputs/.tmp');
    err.status = 400;
    throw err;
  }
  if (nextPatch.llm && Object.hasOwn(nextPatch.llm, 'available_models')) {
    const models = normalizeAvailableModels(nextPatch.llm.available_models);
    nextPatch.llm.available_models = models;
    if (!Object.hasOwn(nextPatch.llm, 'models_fetched_at')) {
      nextPatch.llm.models_fetched_at = models.length ? new Date().toISOString() : null;
    }
  }
  preserveUnscopedLegacyCollections(current, nextPatch, patchOps);
  const merged = normalizeSettings(applySettingsPatchOperations(deepMerge(stripSensitive(current), nextPatch), patchOps));
  assertTouchedSettingsCollectionsFit(nextPatch, merged);
  const validationErrors = validateSettingsObject(merged, { requireBaseUrl: !!nextPatch.llm });
  if (validationErrors.length) {
    const err = new Error(validationErrors.join('; '));
    err.status = 400;
    throw err;
  }
  if (secretsChanged && current._secrets_invalid) {
    await assertInvalidSecretsReplacementConfirmed(secretsFile, replaceInvalidSecrets);
  }

  await ensureRuntimeDirs(merged);
  await assertRealOutputDir(outputDirFromSettings(merged));
  const persistSettingsStorage = async () => {
    let stagedSecrets = '';
    let transaction = null;
    let settingsWritten = false;
    try {
      if (secretsChanged) {
        transaction = await beginSettingsSecretsTransaction(settingsFile, secretsFile);
        stagedSecrets = await stageSecretsFile(nextSecrets, secretsFile);
      }
      await writeJsonAtomic(settingsFile, stripSensitive(merged), { maxBytes: MAX_SETTINGS_FILE_BYTES });
      settingsWritten = true;
      SETTINGS_RECOVERY_STATE.delete(recoveryStateKey(settingsFile));
      if (stagedSecrets) {
        await fsp.rename(stagedSecrets, secretsFile);
        await syncDirectory(path.dirname(secretsFile));
        stagedSecrets = '';
        SECRETS_RECOVERY_STATE.delete(recoveryStateKey(secretsFile));
      }
      if (transaction) {
        await commitSettingsSecretsTransaction(transaction);
        transaction = null;
      }
    } catch (e) {
      if (stagedSecrets) await fsp.rm(stagedSecrets, { force: true }).catch(() => {});
      if (transaction) await rollbackSettingsTransaction(transaction).catch(() => {});
      else if (settingsWritten) await rollbackSettingsFile(settingsFile, current, settingsExisted).catch(() => {});
      throw e;
    }
  };
  if (storage_transaction) await storage_transaction.run(persistSettingsStorage);
  else await persistSettingsStorage();
  return publicSettings({ settingsFile, secretsFile });
}

async function settingsStorageRevision(settingsFile = SETTINGS_FILE, secretsFile = SECRETS_FILE, secrets = {}) {
  const parts = await Promise.all([
    settingsRevisionSettingsFilePart(settingsFile),
    settingsRevisionSecretsPart(secretsFile, secrets),
  ]);
  return crypto.createHash('sha256').update(stableJson(parts)).digest('hex').slice(0, 16);
}

export function settingsExportPolicyRevision(settings = {}) {
  return crypto.createHash('sha256').update(stableJson(settingsExportPrivacyPolicyPayload(settings))).digest('hex').slice(0, 16);
}

export function settingsSchedulerRuntimeRevision(settings = {}) {
  const fingerprints = normalizeManualKeyAccountFingerprintsByAccount(
    settings?.wechat?.manual_key_account_fingerprints_by_account,
    settings?.wechat?.manual_key_verifications_by_account,
    settings?.wechat?.manual_keys_by_account,
  );
  const verifications = normalizeManualKeyVerificationsByAccount(settings?.wechat?.manual_key_verifications_by_account);
  const verificationProofs = {};
  for (const [accountId, record] of Object.entries(verifications)) {
    verificationProofs[accountId] = {
      key_hash: record.key_hash,
      account_fingerprint: record.account_fingerprint,
      message_sample_verified: record.message_sample_verified === true,
      message_coverage_verified: record.message_coverage_verified === true,
      message_db_checked_count: record.message_db_checked_count,
      message_db_total_count: record.message_db_total_count,
    };
  }
  const normalized = normalizeSettings(deepMerge(defaultSettings(), plainObject(settings) ? settings : {}));
  const manualKeys = normalizeManualKeysByAccount(settings?.wechat?.manual_keys_by_account);
  const manualKeyHashes = Object.fromEntries(Object.entries(manualKeys).map(([accountId, text]) => [
    accountId,
    crypto.createHash('sha256').update(String(text || '')).digest('hex'),
  ]));
  const llm = normalized.llm || {};
  const scheduler = normalized.scheduler || {};
  return crypto.createHash('sha256').update(stableJson({
    v: 2,
    llm: {
      provider: String(llm.provider || ''),
      base_url: normalizeBaseUrl(llm.base_url || ''),
      model: String(llm.model || ''),
      long_context_model: String(llm.long_context_model || ''),
      temperature: Number(llm.temperature),
      timeout_ms: Number(llm.timeout_ms),
      max_input_chars: Number(llm.max_input_chars),
      max_messages_per_call: Number(llm.max_messages_per_call),
      max_image_chars_per_call: Number(llm.max_image_chars_per_call),
      ai_concurrency: Number(llm.ai_concurrency),
      capabilities: llm.capabilities || {},
      api_key_hash: llm.api_key
        ? crypto.createHash('sha256').update(String(llm.api_key)).digest('hex')
        : (llm.api_key_set === true ? 'configured' : ''),
    },
    privacy: normalized.privacy,
    link_preview: normalized.link_preview,
    groups: {
      whitelist: normalized.groups?.whitelist || [],
      overrides: normalized.groups?.overrides || [],
    },
    scheduler: {
      enabled: scheduler.enabled === true,
      default_interval: String(scheduler.default_interval || ''),
      digest_window: String(scheduler.digest_window || ''),
      min_messages_per_digest: Number(scheduler.min_messages_per_digest),
      per_group: scheduler.per_group || [],
    },
    output: normalized.output,
    render: normalized.render,
    wechat: {
      secrets_invalid: settings?._secrets_invalid === true,
      manual_key_hashes_by_account: manualKeyHashes,
      manual_key_account_fingerprints_by_account: fingerprints,
      manual_key_verifications_by_account: verificationProofs,
    },
  })).digest('hex').slice(0, 16);
}

export function settingsSchedulerScheduleRevision(settings = {}) {
  const normalized = normalizeSettings(deepMerge(defaultSettings(), plainObject(settings) ? settings : {}));
  return crypto.createHash('sha256').update(stableJson({
    v: 1,
    scheduler: {
      enabled: normalized.scheduler?.enabled === true,
      default_interval: String(normalized.scheduler?.default_interval || ''),
    },
  })).digest('hex').slice(0, 16);
}

export function settingsLegacyExportPolicyRevision(settings = {}, outputDir = '') {
  const payload = settingsExportPrivacyPolicyPayload(settings);
  const s = normalizeSettings(deepMerge(defaultSettings(), settings && typeof settings === 'object' ? settings : {}));
  const dir = outputDir || s.output?.dir || defaultSettings().output.dir;
  return crypto.createHash('sha256').update(stableJson({
    ...payload,
    v: 1,
    output: {
      dir: publicOutputDir(dir),
    },
  })).digest('hex').slice(0, 16);
}

export function settingsExportPolicyRevisionMatches(settings = {}, revision = '', { outputDir = '' } = {}) {
  const expected = String(revision || '').trim();
  if (!expected) return false;
  if (expected === settingsExportPolicyRevision(settings)) return true;
  return expected === settingsLegacyExportPolicyRevision(settings, outputDir);
}

function settingsExportPrivacyPolicyPayload(settings = {}) {
  const s = normalizeSettings(deepMerge(defaultSettings(), settings && typeof settings === 'object' ? settings : {}));
  const privacy = s.privacy || {};
  return {
    v: 2,
    privacy: {
      redact_phone: privacy.redact_phone !== false,
      redact_id_card: privacy.redact_id_card !== false,
      redact_bank_card: privacy.redact_bank_card !== false,
      redact_email: privacy.redact_email === true,
    },
  };
}

async function settingsRevisionSettingsFilePart(file) {
  const data = await readSettingsStorageFile(file, 'settings').catch(e => {
    if (e?.code === 'ENOENT') return null;
    throw e;
  });
  if (!data) return { kind: 'settings', file: path.basename(file), missing: true };
  return settingsRevisionSettingsPart(file, data);
}

function settingsRevisionSecretsPart(file, secrets = {}) {
  const normalized = normalizeSecrets(secrets);
  return {
    kind: 'secrets',
    file: path.basename(file),
    json: stableJson({
      api_key: normalized.api_key,
      manual_key: normalized.manual_key,
      manual_keys_by_account: normalized.manual_keys_by_account,
    }),
  };
}

function settingsRevisionSettingsPart(file, data) {
  const fileName = path.basename(file);
  const text = data.toString('utf-8');
  try {
    const clean = stripSettingsRevisionVolatileFields(JSON.parse(text || '{}'));
    return { kind: 'settings', file: fileName, json: stableJson(clean) };
  } catch {
    return {
      kind: 'settings',
      file: fileName,
      raw_sha256: crypto.createHash('sha256').update(data).digest('hex'),
    };
  }
}

function stripSettingsRevisionVolatileFields(value) {
  const clean = cloneJson(plainObject(value) ? value : {});
  delete clean.settings_revision;
  delete clean.scheduler_runtime_revision;
  delete clean.scheduler_schedule_revision;
  delete clean.export_policy_revision;
  delete clean.base_settings_revision;
  delete clean.expected_settings_revision;
  delete clean.expected_export_policy_revision;
  if (plainObject(clean.groups)) delete clean.groups.recent;
  return clean;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeSettingsPatchOperations(value = {}) {
  const explicit = plainObject(value) ? value : {};
  const migration = plainObject(explicit.legacy_account_scope_migration)
    ? explicit.legacy_account_scope_migration
    : {};
  const migrationTarget = String(migration.to || '').trim().toLowerCase();
  const migrationSources = [...new Set((Array.isArray(migration.from) ? migration.from : [])
    .map(scope => String(scope || '').trim())
    .filter(scope => scope && scope !== migrationTarget))].slice(0, 50);
  return {
    clear_all_whitelist: explicit.clear_all_whitelist === true,
    replace_all_whitelist: explicit.replace_all_whitelist === true,
    remove_unscoped_legacy_whitelist: explicit.remove_unscoped_legacy_whitelist === true,
    remove_unscoped_legacy_per_group: explicit.remove_unscoped_legacy_per_group === true,
    legacy_account_scope_migration: /^wxacct_[a-f0-9]{24}$/.test(migrationTarget) && migrationSources.length
      ? { from: migrationSources, to: migrationTarget }
      : null,
  };
}

function preserveUnscopedLegacyCollections(current = {}, nextPatch = {}, operations = {}) {
  const replaceLegacyCollections = operations.clear_all_whitelist === true
    || operations.replace_all_whitelist === true;
  if (plainObject(nextPatch.groups)
    && Object.hasOwn(nextPatch.groups, 'whitelist')
    && !replaceLegacyCollections
    && operations.remove_unscoped_legacy_whitelist !== true) {
    const submitted = Array.isArray(nextPatch.groups.whitelist) ? nextPatch.groups.whitelist : [];
    const preserved = normalizeGroupRefs(current.groups?.whitelist, Number.POSITIVE_INFINITY)
      .filter(settingsGroupRefIsUnscoped);
    nextPatch.groups.whitelist = normalizeGroupRefs(
      [...preserved, ...submitted],
      Number.POSITIVE_INFINITY,
    );
  }
  if (plainObject(nextPatch.scheduler)
    && Object.hasOwn(nextPatch.scheduler, 'per_group')
    && !replaceLegacyCollections
    && operations.remove_unscoped_legacy_per_group !== true) {
    const submitted = Array.isArray(nextPatch.scheduler.per_group) ? nextPatch.scheduler.per_group : [];
    const preserved = normalizePerGroupOverrides(current.scheduler?.per_group)
      .filter(settingsPerGroupRefIsUnscoped);
    nextPatch.scheduler.per_group = normalizePerGroupOverrides([...preserved, ...submitted]);
  }
}

function applySettingsPatchOperations(settings, operations = {}) {
  const clearAllWhitelist = operations.clear_all_whitelist === true;
  const replaceAllWhitelist = operations.replace_all_whitelist === true;
  const scopeMigration = plainObject(operations.legacy_account_scope_migration)
    ? operations.legacy_account_scope_migration
    : null;
  if (!clearAllWhitelist && !replaceAllWhitelist && !operations.remove_unscoped_legacy_whitelist && !operations.remove_unscoped_legacy_per_group && !scopeMigration) return settings;
  const next = cloneJson(settings || {});
  if (scopeMigration) {
    const sources = new Set(scopeMigration.from || []);
    const target = String(scopeMigration.to || '').trim().toLowerCase();
    if (sources.size && target) {
      if (Array.isArray(next.groups?.whitelist)) {
        next.groups.whitelist = next.groups.whitelist.map(ref => migrateSettingsRuleAccountScope(ref, sources, target));
      }
      if (Array.isArray(next.scheduler?.per_group)) {
        next.scheduler.per_group = next.scheduler.per_group.map(item => migrateSettingsRuleAccountScope(item, sources, target));
      }
      if (Array.isArray(next.groups?.overrides)) {
        next.groups.overrides = next.groups.overrides.map(item => migrateSettingsRuleAccountScope(item, sources, target));
      }
    }
  }
  if (clearAllWhitelist && next.groups) {
    next.groups.whitelist = [];
  } else if ((replaceAllWhitelist || operations.remove_unscoped_legacy_whitelist) && Array.isArray(next.groups?.whitelist)) {
    next.groups.whitelist = next.groups.whitelist.filter(ref => !settingsGroupRefIsUnscoped(ref));
  }
  if ((clearAllWhitelist || replaceAllWhitelist || operations.remove_unscoped_legacy_per_group) && Array.isArray(next.scheduler?.per_group)) {
    next.scheduler.per_group = next.scheduler.per_group.filter(item => !settingsPerGroupRefIsUnscoped(item));
  }
  if ((clearAllWhitelist || replaceAllWhitelist || operations.remove_unscoped_legacy_per_group) && Array.isArray(next.groups?.overrides)) {
    next.groups.overrides = next.groups.overrides.filter(item => !settingsPerGroupRefIsUnscoped(item));
  }
  return next;
}

function migrateSettingsRuleAccountScope(item, sources, target) {
  if (!plainObject(item)) return item;
  const scope = String(item.account_id || item.account || '').trim();
  if (!scope || !sources.has(scope)) return item;
  const migrated = { ...item, account_id: target };
  delete migrated.account;
  return migrated;
}

function settingsGroupRefIsUnscoped(ref) {
  if (typeof ref === 'string') return true;
  if (!plainObject(ref)) return false;
  return !String(ref.account_id || ref.account || '').trim();
}

function settingsPerGroupRefIsUnscoped(item = {}) {
  if (typeof item === 'string') return true;
  if (!plainObject(item)) return false;
  return !String(item.account_id || item.account || '').trim();
}

async function rollbackSettingsFile(settingsFile, previousSettings, existed) {
  if (!existed) {
    await fsp.rm(settingsFile, { force: true }).catch(() => {});
    return;
  }
  await writeJsonAtomic(settingsFile, stripSensitive(previousSettings), { maxBytes: MAX_SETTINGS_FILE_BYTES });
}

export function projectRoot() {
  return PROJECT_ROOT;
}
