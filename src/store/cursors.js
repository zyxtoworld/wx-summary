import { CURSORS_FILE } from '../config/settings.js';
import { readJson, writeJsonAtomic } from '../lib/json-store.js';

export async function loadCursors() {
  const raw = await readJson(CURSORS_FILE, {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
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
