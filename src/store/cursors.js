import fsp from 'node:fs/promises';
import path from 'node:path';
import { CURSORS_FILE } from '../config/settings.js';
import { readJson, writeJsonAtomic } from '../lib/json-store.js';
import { preserveInvalidFileBackup } from '../lib/invalid-backup.js';
import { MAX_MESSAGE_SHARD_CURSOR_POSITIONS, isMessageShardCursorKey, normalizeMessageShardCursorPosition } from '../lib/message-shard-cursor.js';
import { PROJECT_ROOT, isInside } from '../lib/paths.js';

let cursorRecoveryInfo = null;
let CURSOR_WRITE_QUEUE = Promise.resolve();
const CURSOR_STORE_VERSION = 3;
const VERIFIED_ACCOUNT_ID_RE = /^wxacct_[a-f0-9]{24}$/;
export const CURSOR_STORE_MAX_BYTES = 16 * 1024 * 1024;
export const CURSOR_SEEN_WINDOW_MAX_BYTES = 2 * 1024 * 1024;

export async function loadCursors({ file = CURSORS_FILE, defaultStore = false, projectRoot = PROJECT_ROOT } = {}) {
  const cursorFile = cursorStoreFile(file);
  const recoveryProjectRoot = path.resolve(String(projectRoot || PROJECT_ROOT));
  const isDefaultStore = defaultStore === true || path.resolve(cursorFile) === path.resolve(CURSORS_FILE);
  if (isDefaultStore && cursorRecoveryInfo) {
    throw cursorStoreInvalidError(cursorRecoveryInfo, null);
  }
  try {
    const raw = await readJson(cursorFile, {}, { strict: true, maxBytes: CURSOR_STORE_MAX_BYTES });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw Object.assign(new Error('cursors.json must contain a JSON object'), { code: 'CURSORS_INVALID_SHAPE' });
    }
    return normalizeCursorStore(raw);
  } catch (e) {
    if (e?.code === 'ENOENT') return emptyCursorStore();
    const preserved = await backupInvalidCursorsFile(cursorFile, { preserveOriginal: isDefaultStore });
    const evidencePath = preserved.backup_path || preserved.original_path || cursorFile;
    const relativeBackup = projectRelativePath(evidencePath, recoveryProjectRoot);
    const recovery = {
      original_path: cursorFile,
      backup_path: evidencePath,
      backup_relative_path: relativeBackup,
      recovery_project_root: recoveryProjectRoot,
      backup_available: preserved.backup_available === true,
      original_preserved: preserved.original_preserved === true,
      error: e?.message || String(e),
    };
    if (isDefaultStore) {
      cursorRecoveryInfo = recovery;
      throw cursorStoreInvalidError(recovery, e, recoveryProjectRoot);
    }
    throw cursorStoreInvalidError(recovery, e, recoveryProjectRoot);
  }
}

function emptyCursorStore() {
  return {
    version: CURSOR_STORE_VERSION,
    accounts: {},
    legacy: {},
  };
}

function normalizeCursorStore(raw = {}) {
  if (raw?.version === CURSOR_STORE_VERSION) {
    validateCursorStoreV3(raw);
    return serializeCursorStore(raw);
  }
  validateLegacyCursorStore(raw);
  const store = emptyCursorStore();
  for (const [key, value] of Object.entries(raw)) {
    const scoped = parseVerifiedAccountCursorKey(key);
    if (scoped) {
      const account = store.accounts[scoped.account_identity_id] ||= { groups: {} };
      account.groups[scoped.group_id] = value;
    } else {
      store.legacy[key] = value;
    }
  }
  return serializeCursorStore(store);
}

function parseVerifiedAccountCursorKey(value = '') {
  const key = normalizeGroupId(value);
  const separator = key.indexOf('::');
  if (separator <= 0) return null;
  const accountIdentityId = key.slice(0, separator).toLowerCase();
  const groupId = normalizeGroupId(key.slice(separator + 2));
  if (!VERIFIED_ACCOUNT_ID_RE.test(accountIdentityId) || !groupId) return null;
  return { account_identity_id: accountIdentityId, group_id: groupId };
}

function cursorStoreFile(file = CURSORS_FILE) {
  return path.resolve(String(file || CURSORS_FILE));
}

async function backupInvalidCursorsFile(file, { preserveOriginal = false } = {}) {
  if (preserveOriginal) return preserveInvalidFileBackup(file, { maxBytes: CURSOR_STORE_MAX_BYTES });
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const base = file.replace(/\.json$/i, `.invalid.${cursorBackupTimestamp(new Date())}`);
  for (let i = 1; ; i += 1) {
    const backup = i === 1 ? `${base}.json` : `${base}.${i}.json`;
    const existing = await fsp.lstat(backup).catch(e => {
      if (e?.code === 'ENOENT') return null;
      throw e;
    });
    if (existing) continue;
    try {
      await fsp.rename(file, backup);
      return { original_path: path.resolve(file), backup_path: path.resolve(backup), backup_available: true, original_preserved: false };
    } catch (e) {
      if (e?.code === 'ENOENT') return { original_path: path.resolve(file), backup_path: '', backup_available: false, original_preserved: false };
      if (e?.code !== 'EEXIST') throw e;
    }
  }
}

function cursorStoreInvalidError(recovery = {}, cause = null, projectRoot = recovery.recovery_project_root || PROJECT_ROOT) {
  const relativeBackup = recovery.backup_relative_path || projectRelativePath(recovery.backup_path || CURSORS_FILE, projectRoot);
  const evidenceMessage = recovery.backup_available === true
    ? `已按内容备份为 ${relativeBackup}`
    : `原文件已保留在 ${relativeBackup}`;
  return Object.assign(new Error(`自动摘要游标文件损坏，${evidenceMessage}；已停止全部自动检查，避免所有群重复生成。请修复 data/cursors.json 后在“群与调度”中重新检查。`), {
    status: 500,
    code: 'CURSORS_INVALID',
    public_code: 'cursors_invalid',
    cause: cause || undefined,
    backup_path: recovery.backup_path || '',
    backup_relative_path: relativeBackup,
    backup_available: recovery.backup_available === true,
    original_preserved: recovery.original_preserved === true,
  });
}

function cursorBackupTimestamp(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function projectRelativePath(file, projectRoot = PROJECT_ROOT) {
  const resolved = path.resolve(file);
  const resolvedProjectRoot = path.resolve(String(projectRoot || PROJECT_ROOT));
  if (!isInside(resolvedProjectRoot, resolved)) return path.basename(resolved);
  return path.relative(resolvedProjectRoot, resolved).replaceAll(path.sep, '/');
}

export function getCursorRecoveryInfo() {
  if (!cursorRecoveryInfo) return null;
  return {
    backup_relative_path: cursorRecoveryInfo.backup_relative_path || (cursorRecoveryInfo.backup_path
      ? projectRelativePath(cursorRecoveryInfo.backup_path, cursorRecoveryInfo.recovery_project_root || PROJECT_ROOT)
      : ''),
    backup_available: cursorRecoveryInfo.backup_available === true,
    original_preserved: cursorRecoveryInfo.original_preserved === true,
    error: redactCursorRecoveryError(cursorRecoveryInfo.error || ''),
  };
}

export function clearCursorRecoveryInfo() {
  cursorRecoveryInfo = null;
}

export async function revalidateCursorStore() {
  return withCursorWriteLock(async () => {
    if (!cursorRecoveryInfo) return { revalidated: false, status: 'already_valid' };
    const previousRecovery = cursorRecoveryInfo;
    const cursorFile = path.resolve(previousRecovery.original_path || CURSORS_FILE);
    let stat = null;
    try {
      stat = await fsp.lstat(cursorFile);
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e;
    }
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw Object.assign(new Error('data/cursors.json 尚未恢复为普通文件；为避免把缺失文件当成空游标，自动检查仍保持停止。'), {
        status: 409,
        code: 'cursor_store_revalidation_file_missing',
        public_code: 'cursor_store_revalidation_file_missing',
      });
    }
    cursorRecoveryInfo = null;
    try {
      const store = await loadCursors({
        file: cursorFile,
        defaultStore: true,
        projectRoot: previousRecovery.recovery_project_root || PROJECT_ROOT,
      });
      const afterStat = await fsp.lstat(cursorFile).catch(() => null);
      if (!cursorFileSnapshotMatches(stat, afterStat)) {
        throw Object.assign(new Error('重新检查期间 data/cursors.json 又发生变化；为避免按不一致快照恢复，自动检查仍保持停止。'), {
          status: 409,
          code: 'cursor_store_revalidation_changed',
          public_code: 'cursor_store_revalidation_changed',
        });
      }
      return {
        revalidated: true,
        status: 'valid',
        account_count: Object.keys(store.accounts || {}).length,
        legacy_count: Object.keys(store.legacy || {}).length,
      };
    } catch (e) {
      if (!cursorRecoveryInfo) cursorRecoveryInfo = previousRecovery;
      throw e;
    }
  });
}

function cursorFileSnapshotMatches(before = null, after = null) {
  if (!before?.isFile?.() || before.isSymbolicLink?.() || !after?.isFile?.() || after.isSymbolicLink?.()) return false;
  return Number(before.dev || 0) === Number(after.dev || 0)
    && Number(before.ino || 0) === Number(after.ino || 0)
    && Number(before.size || 0) === Number(after.size || 0)
    && Number(before.mtimeMs || 0) === Number(after.mtimeMs || 0);
}

function redactCursorRecoveryError(value = '') {
  return String(value || '')
    .replaceAll(PROJECT_ROOT, '[redacted-path]')
    .replace(/[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n]+[\\/])*[^\\/:*?"<>|\r\n]*/g, '[redacted-path]')
    .slice(0, 500);
}

export async function getGroupCursor(groupId, options = {}) {
  const key = normalizeGroupId(groupId);
  if (!key) return '';
  const store = await loadCursors(options);
  return normalizeCursorState(store.legacy[key]).last_seq;
}

export async function getGroupCursorState(groupId, options = {}) {
  const key = normalizeGroupId(groupId);
  if (!key) return emptyCursorState();
  const store = await loadCursors(options);
  return normalizeCursorState(store.legacy[key]);
}

export async function getAccountGroupCursorState(accountIdentityId, groupId, options = {}) {
  const accountId = normalizeVerifiedAccountId(accountIdentityId);
  const key = normalizeGroupId(groupId);
  if (!accountId || !key) return emptyCursorState();
  const store = await loadCursors(options);
  return normalizeCursorState(store.accounts[accountId]?.groups?.[key]);
}

export async function setGroupCursor(groupId, lastSeq, options = {}) {
  return withCursorWriteLock(async () => {
    const file = cursorStoreFile(options.file);
    const key = normalizeGroupId(groupId);
    if (!key) throw Object.assign(new Error('group_id is required'), { status: 400 });
    const value = normalizeCursorValue(lastSeq);
    if (!value) throw Object.assign(new Error('last_seq is required'), { status: 400 });
    const store = await loadCursors({ file, defaultStore: options.defaultStore === true });
    store.legacy[key] = value;
    await writeCursorStore(file, store);
    return { group_id: key, last_seq: value };
  });
}

export async function setGroupCursorState(groupId, state = {}, options = {}) {
  return withCursorWriteLock(async () => {
    const file = cursorStoreFile(options.file);
    const key = normalizeGroupId(groupId);
    if (!key) throw Object.assign(new Error('group_id is required'), { status: 400 });
    const normalized = normalizeCursorState({
      ...state,
      last_seq: state.last_seq || state.lastSeq || state.cursor || state.latest_cursor,
    });
    if (!cursorStateHasPosition(normalized)) {
      throw Object.assign(new Error('last_seq or scheduled_window_until is required'), { status: 400 });
    }
    const store = await loadCursors({ file, defaultStore: options.defaultStore === true });
    store.legacy[key] = storedCursorState(state, normalized);
    await writeCursorStore(file, store);
    return { group_id: key, ...store.legacy[key] };
  });
}

export async function setAccountGroupCursorState(accountIdentityId, groupId, state = {}, options = {}) {
  return withCursorWriteLock(async () => {
    const file = cursorStoreFile(options.file);
    const accountId = requireVerifiedAccountId(accountIdentityId);
    const key = normalizeGroupId(groupId);
    if (!key) throw Object.assign(new Error('group_id is required'), { status: 400 });
    const normalized = normalizeCursorState({
      ...state,
      last_seq: state.last_seq || state.lastSeq || state.cursor || state.latest_cursor,
    });
    if (!cursorStateHasPosition(normalized)) {
      throw Object.assign(new Error('last_seq or scheduled_window_until is required'), { status: 400 });
    }
    const store = await loadCursors({ file, defaultStore: options.defaultStore === true });
    const account = store.accounts[accountId] ||= { groups: {} };
    account.groups[key] = storedCursorState(state, normalized);
    await writeCursorStore(file, store);
    return { account_identity_id: accountId, group_id: key, ...account.groups[key] };
  });
}

export async function clearGroupCursor(groupId, options = {}) {
  return withCursorWriteLock(async () => {
    const file = cursorStoreFile(options.file);
    const key = normalizeGroupId(groupId);
    if (!key) return false;
    const store = await loadCursors({ file, defaultStore: options.defaultStore === true });
    const existed = Object.hasOwn(store.legacy, key);
    delete store.legacy[key];
    if (existed) {
      await writeCursorStore(file, store);
    }
    return existed;
  });
}

export async function clearAccountGroupCursor(accountIdentityId, groupId, options = {}) {
  return withCursorWriteLock(async () => {
    const file = cursorStoreFile(options.file);
    const accountId = requireVerifiedAccountId(accountIdentityId);
    const key = normalizeGroupId(groupId);
    if (!key) return false;
    const store = await loadCursors({ file, defaultStore: options.defaultStore === true });
    const groups = store.accounts[accountId]?.groups;
    const existed = !!groups && Object.hasOwn(groups, key);
    if (!existed) return false;
    delete groups[key];
    if (!Object.keys(groups).length) delete store.accounts[accountId];
    await writeCursorStore(file, store);
    return true;
  });
}

function storedCursorState(state = {}, normalized = normalizeCursorState(state)) {
  return {
    version: 2,
    last_seq: normalized.last_seq,
    seen: normalized.seen,
    updated_at: normalizeCursorText(state.updated_at || new Date().toISOString(), 64),
    window_since: normalizeCursorText(state.window_since, 32),
    window_until: normalizeCursorText(state.window_until, 32),
    scheduled_window_since: normalizeCursorText(state.scheduled_window_since, 32),
    scheduled_window_until: normalizeCursorText(state.scheduled_window_until, 32),
    late_sync_grace_minutes: Math.max(0, Math.trunc(Number(state.late_sync_grace_minutes || normalized.late_sync_grace_minutes || 0)) || 0),
    late_sync_lookback_hours: Math.max(0, Math.trunc(Number(state.late_sync_lookback_hours || normalized.late_sync_lookback_hours || 0)) || 0),
    shard_row_positions_initialized: state.shard_row_positions_initialized === true || normalized.shard_row_positions_initialized === true,
    shard_row_positions: normalizeShardRowPositions(state.shard_row_positions || normalized.shard_row_positions),
    rule_fingerprint: normalizeCursorValue(state.rule_fingerprint || normalized.rule_fingerprint),
    message_count: Math.max(0, Math.trunc(Number(state.message_count || normalized.seen.length || 0)) || 0),
  };
}

function withCursorWriteLock(action) {
  const run = CURSOR_WRITE_QUEUE.then(action, action);
  CURSOR_WRITE_QUEUE = run.catch(() => {});
  return run;
}

function normalizeGroupId(value) {
  return String(value || '').trim();
}

function normalizeVerifiedAccountId(value) {
  const id = String(value || '').trim().toLowerCase();
  return VERIFIED_ACCOUNT_ID_RE.test(id) ? id : '';
}

function requireVerifiedAccountId(value) {
  const id = normalizeVerifiedAccountId(value);
  if (id) return id;
  throw Object.assign(new Error('verified account_identity_id is required'), {
    status: 400,
    code: 'CURSOR_ACCOUNT_IDENTITY_REQUIRED',
  });
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function emptyCursorState() {
  return {
    last_seq: '',
    seen: [],
    updated_at: '',
    window_since: '',
    window_until: '',
    scheduled_window_since: '',
    scheduled_window_until: '',
    late_sync_grace_minutes: 0,
    late_sync_lookback_hours: 0,
    shard_row_positions_initialized: false,
    shard_row_positions: {},
    rule_fingerprint: '',
    message_count: 0,
  };
}

function validateLegacyCursorStore(store = {}) {
  for (const [key, value] of Object.entries(store)) {
    if (!normalizeGroupId(key)) {
      throw Object.assign(new Error('cursor entry key must not be empty'), { code: 'CURSORS_INVALID_ENTRY', cursor_key: key });
    }
    validateCursorEntry(key, value);
  }
}

function validateCursorStoreV3(store = {}) {
  if (!plainObject(store.accounts) || !plainObject(store.legacy)) {
    throw Object.assign(new Error('cursor v3 store requires accounts and legacy objects'), { code: 'CURSORS_INVALID_SHAPE' });
  }
  const topLevelKeys = Object.keys(store).sort();
  if (topLevelKeys.join(',') !== 'accounts,legacy,version') {
    throw Object.assign(new Error('cursor v3 store contains unknown top-level fields'), { code: 'CURSORS_INVALID_SHAPE' });
  }
  for (const [accountId, account] of Object.entries(store.accounts)) {
    if (!normalizeVerifiedAccountId(accountId) || !plainObject(account) || !plainObject(account.groups)) {
      throw Object.assign(new Error(`cursor account ${accountId} is invalid`), { code: 'CURSORS_INVALID_ENTRY', cursor_key: accountId });
    }
    if (Object.keys(account).some(key => key !== 'groups')) {
      throw Object.assign(new Error(`cursor account ${accountId} contains unknown fields`), { code: 'CURSORS_INVALID_ENTRY', cursor_key: accountId });
    }
    for (const [groupId, value] of Object.entries(account.groups)) {
      if (!normalizeGroupId(groupId)) {
        throw Object.assign(new Error(`cursor account ${accountId} has an empty group id`), { code: 'CURSORS_INVALID_ENTRY', cursor_key: accountId });
      }
      validateCursorEntry(`${accountId}::${groupId}`, value);
    }
  }
  validateLegacyCursorStore(store.legacy);
}

function validateCursorEntry(key, value) {
  if (typeof value === 'string' || typeof value === 'number') {
    if (!normalizeCursorValue(value)) {
      throw Object.assign(new Error(`cursor entry ${key} has an empty last_seq`), { code: 'CURSORS_INVALID_ENTRY', cursor_key: key });
    }
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error(`cursor entry ${key} must be a cursor string or object`), { code: 'CURSORS_INVALID_ENTRY', cursor_key: key });
  }
  const lastSeq = normalizeCursorValue(value.last_seq || value.lastSeq || value.cursor || value.latest_cursor);
  const hasPosition = !!lastSeq
    || !!normalizeCursorText(value.scheduled_window_until, 32)
    || !!normalizeCursorText(value.window_until, 32);
  if (!hasPosition) {
    throw Object.assign(new Error(`cursor entry ${key} is missing last_seq or scheduled_window_until`), { code: 'CURSORS_INVALID_ENTRY', cursor_key: key });
  }
  for (const listKey of ['seen', 'message_ids', 'messages']) {
    if (Object.hasOwn(value, listKey) && value[listKey] != null && !Array.isArray(value[listKey])) {
      throw Object.assign(new Error(`cursor entry ${key}.${listKey} must be an array`), { code: 'CURSORS_INVALID_ENTRY', cursor_key: key });
    }
  }
  if (Object.hasOwn(value, 'shard_row_positions') && !plainObject(value.shard_row_positions)) {
    throw Object.assign(new Error(`cursor entry ${key}.shard_row_positions must be an object`), { code: 'CURSORS_INVALID_ENTRY', cursor_key: key });
  }
  normalizeShardRowPositions(value.shard_row_positions);
}

function normalizeCursorState(value) {
  if (!value) return emptyCursorState();
  if (typeof value === 'string' || typeof value === 'number') {
    return { ...emptyCursorState(), last_seq: normalizeCursorValue(value) };
  }
  if (typeof value !== 'object' || Array.isArray(value)) return emptyCursorState();
  return {
    last_seq: normalizeCursorValue(value.last_seq || value.lastSeq || value.cursor || value.latest_cursor),
    seen: normalizeSeenList(value.seen || value.message_ids || value.messages),
    updated_at: normalizeCursorText(value.updated_at, 64),
    window_since: normalizeCursorText(value.window_since, 32),
    window_until: normalizeCursorText(value.window_until, 32),
    scheduled_window_since: normalizeCursorText(value.scheduled_window_since, 32),
    scheduled_window_until: normalizeCursorText(value.scheduled_window_until, 32),
    late_sync_grace_minutes: Math.max(0, Math.trunc(Number(value.late_sync_grace_minutes || 0)) || 0),
    late_sync_lookback_hours: Math.max(0, Math.trunc(Number(value.late_sync_lookback_hours || 0)) || 0),
    shard_row_positions_initialized: value.shard_row_positions_initialized === true,
    shard_row_positions: normalizeShardRowPositions(value.shard_row_positions),
    rule_fingerprint: normalizeCursorValue(value.rule_fingerprint),
    message_count: Math.max(0, Math.trunc(Number(value.message_count || 0)) || 0),
  };
}

function normalizeShardRowPositions(value = {}) {
  if (!plainObject(value)) return {};
  const entries = Object.entries(value);
  if (entries.length > MAX_MESSAGE_SHARD_CURSOR_POSITIONS) {
    throw Object.assign(new Error(`cursor shard_row_positions exceeds ${MAX_MESSAGE_SHARD_CURSOR_POSITIONS} entries`), { code: 'CURSORS_INVALID_ENTRY' });
  }
  const out = {};
  for (const [name, position] of entries) {
    const key = String(name || '').trim().toLowerCase();
    const normalized = normalizeMessageShardCursorPosition(position);
    if (!isMessageShardCursorKey(key) || normalized === null) {
      throw Object.assign(new Error('cursor shard_row_positions contains an invalid entry'), { code: 'CURSORS_INVALID_ENTRY' });
    }
    if (Object.hasOwn(out, key)) {
      throw Object.assign(new Error('cursor shard_row_positions contains duplicate normalized shard keys'), { code: 'CURSORS_INVALID_ENTRY' });
    }
    out[key] = normalized;
  }
  return out;
}

function cursorStateHasPosition(state = {}) {
  return !!(state?.last_seq || state?.scheduled_window_until || state?.window_until);
}

function normalizeSeenList(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const item = normalizeCursorValue(value);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  assertCursorSeenListFits(out);
  return out;
}

export function cursorSeenListBytes(values = []) {
  return (Array.isArray(values) ? values : []).reduce(
    (total, value) => total + Buffer.byteLength(String(value || ''), 'utf-8') + 3,
    2,
  );
}

export function assertCursorSeenListFits(values = []) {
  const bytes = cursorSeenListBytes(values);
  if (bytes <= CURSOR_SEEN_WINDOW_MAX_BYTES) return bytes;
  throw Object.assign(new Error(`调度消息去重窗口需要 ${Math.ceil(bytes / 1024)}KB，超过本地游标单群 2048KB 上限。已停止推进游标，避免静默丢弃去重记录后重复生成；请缩短摘要窗口或提高自动检查频率。`), {
    status: 413,
    code: 'CURSOR_SEEN_WINDOW_TOO_LARGE',
    public_code: 'scheduler_cursor_window_too_large',
    detail: 'scheduler_cursor_window_too_large',
    scheduler_no_retry: true,
    seen_bytes: bytes,
    seen_limit_bytes: CURSOR_SEEN_WINDOW_MAX_BYTES,
  });
}

async function writeCursorStore(file, store) {
  const payload = serializeCursorStore(store);
  assertCursorStorePayloadFits(payload);
  await writeJsonAtomic(file, payload);
}

export function assertCursorStorePayloadFits(payload = {}) {
  const bytes = Buffer.byteLength(JSON.stringify(payload, null, 2), 'utf-8');
  if (bytes > CURSOR_STORE_MAX_BYTES) {
    throw Object.assign(new Error(`自动摘要游标文件将达到 ${Math.ceil(bytes / 1024 / 1024)}MB，超过 16MB 安全上限。已拒绝写入，避免生成下次无法读取的游标文件。请减少启用自动摘要的群或缩短摘要窗口。`), {
      status: 413,
      code: 'CURSOR_STORE_TOO_LARGE',
      public_code: 'scheduler_cursor_store_too_large',
      detail: 'scheduler_cursor_store_too_large',
      scheduler_no_retry: true,
      cursor_store_bytes: bytes,
      cursor_store_limit_bytes: CURSOR_STORE_MAX_BYTES,
    });
  }
  return bytes;
}

function normalizeCursorValue(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return raw.replace(/[^\w:%.\-~!'()*]/g, '').slice(0, 256);
}

function normalizeCursorText(value, maxLength) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return raw.replace(/[^\w:.,@+ -]/g, '').slice(0, maxLength);
}

function sortObject(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

function serializeCursorStore(store = emptyCursorStore()) {
  const accounts = {};
  for (const [accountId, account] of Object.entries(store.accounts || {}).sort(([a], [b]) => a.localeCompare(b))) {
    const normalizedAccountId = normalizeVerifiedAccountId(accountId);
    if (!normalizedAccountId) continue;
    accounts[normalizedAccountId] = {
      groups: sortObject(plainObject(account?.groups) ? account.groups : {}),
    };
  }
  return {
    version: CURSOR_STORE_VERSION,
    accounts,
    legacy: sortObject(plainObject(store.legacy) ? store.legacy : {}),
  };
}
