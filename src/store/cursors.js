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
  return normalizeCursorValue(cursors[key]);
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

function normalizeCursorValue(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return raw.replace(/[^\w:.-]/g, '').slice(0, 128);
}

function sortObject(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}
