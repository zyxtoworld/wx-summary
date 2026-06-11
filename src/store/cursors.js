import fsp from 'node:fs/promises';
import path from 'node:path';
import { CURSORS_FILE } from '../config/settings.js';
import { readJson, writeJsonAtomic } from '../lib/json-store.js';

let cursorStoreInvalid = null;

export async function loadCursors({ file = CURSORS_FILE } = {}) {
  const isDefaultStore = path.resolve(file) === path.resolve(CURSORS_FILE);
  if (isDefaultStore && cursorStoreInvalid) throw cursorStoreInvalid;
  try {
    const raw = await readJson(file, {}, { strict: true });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw Object.assign(new Error('cursors.json must contain a JSON object'), { code: 'CURSORS_INVALID_SHAPE' });
    }
    validateCursorStore(raw);
    return raw;
  } catch (e) {
    if (e?.code === 'ENOENT') return {};
    const backup = await backupInvalidCursorsFile(file).catch(() => '');
    const message = backup
      ? `自动摘要游标文件损坏，已备份为 ${projectRelativePath(backup)}。请检查 data/cursors.json 后重启服务。`
      : '自动摘要游标文件损坏。请检查 data/cursors.json 后重启服务。';
    const error = Object.assign(new Error(message), {
      status: 500,
      code: 'CURSORS_INVALID',
      cause: e,
      backup_path: backup,
    });
    if (isDefaultStore) cursorStoreInvalid = error;
    throw error;
  }
}

async function backupInvalidCursorsFile(file) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const backup = file.replace(/\.json$/i, `.invalid.${cursorBackupTimestamp(new Date())}.json`);
  await fsp.copyFile(file, backup);
  return backup;
}

function cursorBackupTimestamp(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function projectRelativePath(file) {
  return path.relative(process.cwd(), file).replaceAll(path.sep, '/');
}

export async function getGroupCursor(groupId) {
  const key = normalizeGroupId(groupId);
  if (!key) return '';
  const cursors = await loadCursors();
  return normalizeCursorState(cursors[key]).last_seq;
}

export async function getGroupCursorState(groupId) {
  const key = normalizeGroupId(groupId);
  if (!key) return emptyCursorState();
  const cursors = await loadCursors();
  return normalizeCursorState(cursors[key]);
}

export async function setGroupCursor(groupId, lastSeq) {
  const key = normalizeGroupId(groupId);
  if (!key) throw Object.assign(new Error('group_id is required'), { status: 400 });
  const value = normalizeCursorValue(lastSeq);
  if (!value) throw Object.assign(new Error('last_seq is required'), { status: 400 });
  const cursors = await loadCursors();
  cursors[key] = value;
  await writeJsonAtomic(CURSORS_FILE, sortObject(cursors));
  return { group_id: key, last_seq: value };
}

export async function setGroupCursorState(groupId, state = {}) {
  const key = normalizeGroupId(groupId);
  if (!key) throw Object.assign(new Error('group_id is required'), { status: 400 });
  const normalized = normalizeCursorState({
    ...state,
    last_seq: state.last_seq || state.lastSeq || state.cursor || state.latest_cursor,
  });
  if (!normalized.last_seq) throw Object.assign(new Error('last_seq is required'), { status: 400 });
  const cursors = await loadCursors();
  cursors[key] = {
    version: 2,
    last_seq: normalized.last_seq,
    seen: normalized.seen,
    updated_at: normalizeCursorText(state.updated_at || new Date().toISOString(), 64),
    window_since: normalizeCursorText(state.window_since, 32),
    window_until: normalizeCursorText(state.window_until, 32),
    message_count: Math.max(0, Math.trunc(Number(state.message_count || normalized.seen.length || 0)) || 0),
  };
  await writeJsonAtomic(CURSORS_FILE, sortObject(cursors));
  return { group_id: key, ...cursors[key] };
}

export async function clearGroupCursor(groupId) {
  const key = normalizeGroupId(groupId);
  if (!key) return false;
  const cursors = await loadCursors();
  const existed = Object.hasOwn(cursors, key);
  delete cursors[key];
  if (existed) await writeJsonAtomic(CURSORS_FILE, sortObject(cursors));
  return existed;
}

function normalizeGroupId(value) {
  return String(value || '').trim();
}

function emptyCursorState() {
  return { last_seq: '', seen: [], updated_at: '', window_since: '', window_until: '', message_count: 0 };
}

function validateCursorStore(store = {}) {
  for (const [key, value] of Object.entries(store)) {
    if (!normalizeGroupId(key)) {
      throw Object.assign(new Error('cursor entry key must not be empty'), { code: 'CURSORS_INVALID_ENTRY', cursor_key: key });
    }
    validateCursorEntry(key, value);
  }
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
  if (!lastSeq) {
    throw Object.assign(new Error(`cursor entry ${key} is missing last_seq`), { code: 'CURSORS_INVALID_ENTRY', cursor_key: key });
  }
  for (const listKey of ['seen', 'message_ids', 'messages']) {
    if (Object.hasOwn(value, listKey) && value[listKey] != null && !Array.isArray(value[listKey])) {
      throw Object.assign(new Error(`cursor entry ${key}.${listKey} must be an array`), { code: 'CURSORS_INVALID_ENTRY', cursor_key: key });
    }
  }
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
    message_count: Math.max(0, Math.trunc(Number(value.message_count || 0)) || 0),
  };
}

function normalizeSeenList(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const item = normalizeCursorText(value, 80);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= 20000) break;
  }
  return out;
}

function normalizeCursorValue(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return raw.replace(/[^\w:.-]/g, '').slice(0, 256);
}

function normalizeCursorText(value, maxLength) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return raw.replace(/[^\w:.,@+ -]/g, '').slice(0, maxLength);
}

function sortObject(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}
