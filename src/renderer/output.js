import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { outputDirFromSettings, PROJECT_ROOT, OUTPUTS_DIR, toProjectRelative, isInside } from '../lib/paths.js';
import { ensureDir, readJson, writeJsonAtomic } from '../lib/json-store.js';

export function historyIndexPath(settings) {
  return path.join(outputDirFromSettings(settings), 'index.json');
}

export async function saveRenderedPng({ settings, digest, png_data_url }) {
  const base = outputDirFromSettings(settings);
  const buffer = pngBufferFromDataUrl(png_data_url);

  const createdAt = digest.created_at ? new Date(digest.created_at) : new Date();
  const day = localDate(createdAt);
  const dir = path.join(base, day);
  await ensureDir(dir);
  const filename = await uniqueFilename(dir, buildFilename(digest));
  const filePath = path.join(dir, filename);
  const digestPath = digestJsonPathForPng(filePath);
  await writeBinaryAtomic(filePath, buffer);
  await writeDigestJson(digestPath, digest);

  const item = {
    digest_id: digest.digest_id,
    group: digest.group,
    since: digest.since,
    until: digest.until,
    file_path: filePath,
    relative_path: toProjectRelative(filePath),
    digest_path: digestPath,
    digest_relative_path: toProjectRelative(digestPath),
    model: digest.model,
    message_count: digest.message_count,
    created_at: digest.created_at || new Date().toISOString(),
  };
  await upsertHistory(settings, item);
  return item;
}

export async function listHistory(settings) {
  const list = await readJson(historyIndexPath(settings), []);
  return Array.isArray(list) ? list.slice(0, 50) : [];
}

export async function cleanupOldDigests(settings) {
  const days = Number(settings.output?.retention_days || 0);
  if (!Number.isFinite(days) || days <= 0) return { removed: 0 };

  const base = outputDirFromSettings(settings);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const list = await readJson(historyIndexPath(settings), []);
  const kept = [];
  let removed = 0;

  for (const item of Array.isArray(list) ? list : []) {
    const created = new Date(item.created_at || 0).getTime();
    const filePath = path.resolve(item.file_path || '');
    const digestPath = resolveDigestPath(base, item);
    const expired = Number.isFinite(created) && created > 0 && created < cutoff;
    if (expired && isInside(base, filePath)) {
      await fsp.rm(filePath, { force: true }).catch(() => {});
      if (digestPath) await fsp.rm(digestPath, { force: true }).catch(() => {});
      removed++;
      continue;
    }
    kept.push(item);
  }

  if (removed) await writeJsonAtomic(historyIndexPath(settings), kept);
  return { removed };
}

export async function findHistoryItem(settings, digestId) {
  const list = await listHistory(settings);
  return list.find(item => item.digest_id === digestId) || null;
}

export async function readHistoryDigest(settings, digestId) {
  const item = await findHistoryItem(settings, digestId);
  if (!item) return null;
  const base = outputDirFromSettings(settings);
  const digestPath = resolveDigestPath(base, item);
  if (!digestPath) return null;
  const digest = await readJson(digestPath, null);
  return digest && typeof digest === 'object' && !Array.isArray(digest) ? digest : null;
}

export async function overwriteRenderedPng({ settings, item, digest, png_data_url }) {
  const base = outputDirFromSettings(settings);
  const target = await assertRevealable(settings, item?.file_path || '', { extensions: ['.png'] });
  const buffer = pngBufferFromDataUrl(png_data_url);
  const digestPath = resolveDigestPath(base, item) || digestJsonPathForPng(target);
  await writeBinaryAtomic(target, buffer);
  await writeDigestJson(digestPath, digest);
  const next = {
    ...item,
    digest_path: digestPath,
    digest_relative_path: toProjectRelative(digestPath),
    rerendered_at: new Date().toISOString(),
  };
  await upsertHistory(settings, next);
  return next;
}

export async function savePreviewMarkdown({ title = '文本预览', markdown }) {
  const text = String(markdown || '').replace(/\r\n/g, '\n');
  if (!text.trim()) {
    const err = new Error('markdown is empty');
    err.status = 400;
    throw err;
  }
  if (Buffer.byteLength(text, 'utf-8') > 2 * 1024 * 1024) {
    const err = new Error('markdown is too large');
    err.status = 413;
    throw err;
  }
  const dir = path.join(OUTPUTS_DIR, 'previews');
  await ensureDir(dir);
  const filename = await uniqueFilename(dir, `${sanitizeName(title || '文本预览')}__${timestampForFilename(new Date())}.md`);
  const filePath = path.join(dir, filename);
  await fsp.writeFile(filePath, text.endsWith('\n') ? text : `${text}\n`, 'utf-8');
  return {
    file_path: filePath,
    relative_path: toProjectRelative(filePath),
  };
}

export async function assertRevealable(settings, targetPath, { extensions = [] } = {}) {
  const base = outputDirFromSettings(settings);
  const resolved = path.resolve(targetPath || '');
  if (!isInside(base, resolved)) {
    const err = new Error('path outside output dir');
    err.status = 403;
    throw err;
  }
  const allowed = Array.isArray(extensions) ? extensions.map(ext => String(ext || '').toLowerCase()).filter(Boolean) : [];
  if (allowed.length && !allowed.includes(path.extname(resolved).toLowerCase())) {
    const err = new Error(`file must be ${allowed.join(' or ')}`);
    err.status = 400;
    throw err;
  }
  const st = await fsp.stat(resolved).catch(() => null);
  if (!st?.isFile()) {
    const err = new Error('file not found');
    err.status = 404;
    throw err;
  }
  return resolved;
}

function pngBufferFromDataUrl(png_data_url) {
  const match = String(png_data_url || '').match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    const err = new Error('png_data_url must be a PNG data URL');
    err.status = 400;
    throw err;
  }
  const buffer = Buffer.from(match[1], 'base64');
  if (buffer.length < 32 || buffer.readUInt32BE(0) !== 0x89504e47) {
    const err = new Error('Invalid PNG payload');
    err.status = 400;
    throw err;
  }
  return buffer;
}

function digestJsonPathForPng(filePath) {
  return filePath.replace(/\.png$/i, '.digest.json');
}

async function writeDigestJson(filePath, digest) {
  await writeJsonAtomic(filePath, persistedDigest(digest));
}

function persistedDigest(digest = {}) {
  return {
    digest_id: String(digest.digest_id || ''),
    group: String(digest.group || ''),
    since: String(digest.since || ''),
    until: String(digest.until || ''),
    message_count: Number(digest.message_count || 0),
    input_message_count: Number(digest.input_message_count || digest.message_count || 0),
    scanned_message_count: Number(digest.scanned_message_count || digest.message_count || 0),
    truncated: !!digest.truncated,
    source_label: String(digest.source_label || ''),
    model: String(digest.model || ''),
    headline: String(digest.headline || ''),
    mentions_me: [],
    todos: cleanTodos(digest.todos),
    topics: cleanTopics(digest.topics),
    links: cleanLinks(digest.links),
    __render: cleanRender(digest.__render),
    created_at: String(digest.created_at || new Date().toISOString()),
  };
}

function cleanRender(value) {
  const render = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const theme = ['light', 'dark'].includes(render.theme) ? render.theme : '';
  const fontSize = render.font_size === 'large' ? 'large' : render.font_size === 'normal' ? 'normal' : '';
  const accentColor = /^#[0-9a-fA-F]{6}$/.test(String(render.accent_color || '')) ? String(render.accent_color).toUpperCase() : '';
  return {
    theme,
    font_size: fontSize,
    accent_color: accentColor,
  };
}

function cleanTodos(value) {
  return Array.isArray(value) ? value.map(item => ({
    owner: String(item?.owner || ''),
    item: String(item?.item || ''),
    deadline: String(item?.deadline || ''),
  })).filter(item => item.item).slice(0, 100) : [];
}

function cleanTopics(value) {
  return Array.isArray(value) ? value.map(item => ({
    title: String(item?.title || ''),
    participants: Array.isArray(item?.participants) ? item.participants.map(x => String(x || '')).filter(Boolean).slice(0, 12) : [],
    summary: String(item?.summary || ''),
    need_followup: !!item?.need_followup,
  })).filter(item => item.title || item.summary).slice(0, 100) : [];
}

function cleanLinks(value) {
  return Array.isArray(value) ? value.map(item => ({
    title: String(item?.title || ''),
    url: String(item?.url || ''),
    summary: cleanLinkSummary(item?.summary || ''),
    from: String(item?.from || ''),
    time: String(item?.time || ''),
  })).filter(item => isAnalyzableWebLinkUrl(item.url)).slice(0, 100) : [];
}

function cleanLinkSummary(value) {
  return String(value || '').replace(/群内反馈访问时返回\s*HTTP?\s*(\d{3})/gi, '本程序打开该链接时返回 HTTP $1')
    .replace(/群内反馈访问时返回\s*(\d{3})/g, '本程序打开该链接时返回 HTTP $1')
    .replace(/群内反馈访问返回\s*HTTP?\s*(\d{3})/gi, '本程序打开该链接时返回 HTTP $1')
    .replace(/群内反馈访问返回\s*(\d{3})/g, '本程序打开该链接时返回 HTTP $1');
}

const DIRECT_MEDIA_URL_RE = /\.(?:avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp|mp4|m4v|mov|avi|mkv|webm|3gp|mp3|wav|m4a|aac|oga?|flac|amr|silk)(?:$|[?#])/i;

function isAnalyzableWebLinkUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    return ['http:', 'https:'].includes(parsed.protocol) && !DIRECT_MEDIA_URL_RE.test(parsed.href);
  } catch {
    return false;
  }
}

async function writeBinaryAtomic(filePath, buffer) {
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, buffer);
    await fsp.rename(tmp, filePath);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

function resolveDigestPath(base, item = {}) {
  const explicit = item.digest_path ? path.resolve(item.digest_path) : '';
  if (explicit && isInside(base, explicit)) return explicit;
  const pngPath = item.file_path ? path.resolve(item.file_path) : '';
  const inferred = pngPath && isInside(base, pngPath) ? digestJsonPathForPng(pngPath) : '';
  return inferred && isInside(base, inferred) ? inferred : '';
}

async function upsertHistory(settings, item) {
  const file = historyIndexPath(settings);
  const list = await readJson(file, []);
  const next = [item, ...list.filter(x => x.digest_id !== item.digest_id)].slice(0, 200);
  await writeJsonAtomic(file, next);
}

function buildFilename(digest) {
  const group = sanitizeName(digest.group || 'digest');
  const since = compactTime(digest.since);
  const until = compactTime(digest.until);
  const id8 = String(digest.digest_id || '00000000').slice(0, 8);
  return `${group}__${since}_${until}__${id8}.png`;
}

function sanitizeName(name) {
  return String(name || 'digest')
    .replace(/[^\p{Unified_Ideograph}a-zA-Z0-9_]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'digest';
}

function compactTime(value) {
  if (!value || value === 'now') return formatDate(new Date());
  const normalized = String(value).replace(' ', 'T');
  const date = new Date(normalized);
  if (!Number.isNaN(date.getTime())) return formatDate(date);
  return String(value).replace(/[^\d]/g, '').slice(0, 12) || formatDate(new Date());
}

function localDate(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function formatDate(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

function timestampForFilename(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

async function uniqueFilename(dir, filename) {
  const ext = path.extname(filename);
  const base = filename.slice(0, -ext.length);
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? filename : `${base}_${i + 1}${ext}`;
    try {
      await fsp.access(path.join(dir, candidate));
    } catch {
      return candidate;
    }
  }
  return `${base}_${Date.now()}${ext}`;
}
