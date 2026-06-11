import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { outputDirFromSettings, PROJECT_ROOT, OUTPUTS_DIR, toProjectRelative, isInside } from '../lib/paths.js';
import { ensureDir, readJson, writeJsonAtomic } from '../lib/json-store.js';

let historyWriteQueue = Promise.resolve();

export function historyIndexPath(settings) {
  return path.join(outputDirFromSettings(settings), 'index.json');
}

async function readHistoryIndex(settings) {
  const file = historyIndexPath(settings);
  try {
    const raw = await fsp.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw Object.assign(new Error('history index is not an array'), { code: 'HISTORY_INDEX_INVALID' });
    }
    return parsed;
  } catch (e) {
    if (e?.code === 'ENOENT') return [];
    return recoverHistoryIndex(settings, file, e);
  }
}

async function recoverHistoryIndex(settings, file, cause) {
  const base = outputDirFromSettings(settings);
  const backup = file.replace(/\.json$/i, `.invalid.${timestampForFilename(new Date())}.json`);
  await ensureDir(path.dirname(file));
  await fsp.rename(file, backup).catch(e => {
    if (e?.code !== 'ENOENT') throw e;
  });
  const rebuilt = await rebuildHistoryIndexFromDigests(base);
  if (!rebuilt.length && cause) {
    const err = new Error(`历史索引损坏，已备份为 ${toProjectRelative(backup)}，但未找到可重建的摘要文件。`);
    err.status = 500;
    err.cause = cause;
    throw err;
  }
  await writeJsonAtomic(file, rebuilt);
  return rebuilt;
}

async function rebuildHistoryIndexFromDigests(base) {
  const digestFiles = [];
  await collectDigestJsonFiles(base, digestFiles);
  const items = [];
  for (const digestPath of digestFiles) {
    const digest = await readJson(digestPath, null, { strict: false });
    if (!digest || typeof digest !== 'object' || Array.isArray(digest)) continue;
    const filePath = digestPath.replace(/\.digest\.json$/i, '.png');
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat?.isFile?.()) continue;
    const digestId = String(digest.digest_id || '').trim();
    if (!digestId) continue;
    items.push({
      digest_id: digestId,
      group: String(digest.group || '摘要'),
      since: String(digest.since || ''),
      until: String(digest.until || ''),
      file_path: filePath,
      relative_path: toProjectRelative(filePath),
      digest_path: digestPath,
      digest_relative_path: toProjectRelative(digestPath),
      model: String(digest.model || ''),
      message_count: Number(digest.message_count || 0),
      created_at: String(digest.created_at || stat.mtime.toISOString()),
    });
  }
  return items
    .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
    .slice(0, 200);
}

async function collectDigestJsonFiles(dir, out) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(e => {
    if (e?.code === 'ENOENT') return [];
    throw e;
  });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectDigestJsonFiles(full, out);
    } else if (entry.isFile() && /\.digest\.json$/i.test(entry.name)) {
      out.push(full);
    }
  }
}

export async function saveRenderedPng({ settings, digest, png_data_url, signal = null }) {
  throwIfOutputAborted(signal);
  const base = outputDirFromSettings(settings);
  const buffer = pngBufferFromDataUrl(png_data_url);
  throwIfOutputAborted(signal);

  const createdAt = digest.created_at ? new Date(digest.created_at) : new Date();
  const day = localDate(createdAt);
  const dir = path.join(base, day);
  let filePath = '';
  let digestPath = '';
  try {
    await ensureDir(dir);
    throwIfOutputAborted(signal);
    const filename = await uniqueFilename(dir, buildFilename(digest, settings.output?.filename_pattern));
    filePath = path.join(dir, filename);
    digestPath = digestJsonPathForPng(filePath);
    throwIfOutputAborted(signal);
    await writeBinaryAtomic(filePath, buffer);
    throwIfOutputAborted(signal);
    await writeDigestJson(digestPath, digest);
    throwIfOutputAborted(signal);
  } catch (e) {
    if (isOutputAbortError(e)) await cleanupRenderedPair(filePath, digestPath);
    throw e;
  }

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
  try {
    await upsertHistory(settings, item, { signal });
  } catch (e) {
    if (isOutputAbortError(e)) {
      await removeHistoryItem(settings, item.digest_id).catch(() => {});
      await cleanupRenderedPair(filePath, digestPath);
    }
    throw e;
  }
  return item;
}

export async function discardRenderedHistoryItem(settings, item) {
  const base = outputDirFromSettings(settings);
  const errors = [];
  const digestId = String(item?.digest_id || '');
  let canRemoveFiles = true;
  if (digestId) {
    await removeHistoryItem(settings, digestId).catch(e => {
      canRemoveFiles = false;
      errors.push(e);
    });
  }
  const filePath = item?.file_path ? path.resolve(item.file_path) : '';
  const digestPath = resolveDigestPath(base, item);
  const targets = [...new Set([
    filePath && path.extname(filePath).toLowerCase() === '.png' ? filePath : '',
    digestPath,
  ].filter(Boolean))].filter(target => isInside(base, target));
  if (canRemoveFiles) {
    for (const target of targets) {
      await fsp.rm(target, { force: true }).catch(e => errors.push(e));
    }
  }
  if (errors.length) {
    const err = new Error(`failed to discard rendered history item: ${errors.map(e => e?.message || String(e)).join('; ')}`);
    err.cause = errors[0];
    throw err;
  }
}

export async function listHistory(settings) {
  const base = outputDirFromSettings(settings);
  const items = (await readHistoryIndex(settings)).slice(0, 50);
  return Promise.all(items.map(item => historyItemWithFileStatus(base, item)));
}

async function historyItemWithFileStatus(base, item = {}) {
  const filePath = item.file_path ? path.resolve(item.file_path) : '';
  const digestPath = resolveDigestPath(base, item);
  return {
    ...item,
    file_exists: await regularFileExistsInside(base, filePath, '.png'),
    digest_exists: await regularFileExistsInside(base, digestPath, '.digest.json'),
  };
}

async function regularFileExistsInside(base, targetPath, extension = '') {
  if (!targetPath || !isInside(base, targetPath)) return false;
  if (extension && !targetPath.toLowerCase().endsWith(extension)) return false;
  const stat = await fsp.stat(targetPath).catch(() => null);
  return !!stat?.isFile?.();
}

export async function cleanupOldDigests(settings) {
  const days = Number(settings.output?.retention_days || 0);
  if (!Number.isFinite(days) || days <= 0) return { removed: 0 };

  const base = outputDirFromSettings(settings);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const list = await readHistoryIndex(settings);
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

  if (removed) await withHistoryWriteLock(() => writeJsonAtomic(historyIndexPath(settings), kept));
  return { removed };
}

export async function findHistoryItem(settings, digestId) {
  const list = await readHistoryIndex(settings);
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
  const target = await writableHistoryPngTarget(settings, item?.file_path || '');
  const buffer = pngBufferFromDataUrl(png_data_url);
  const digestPath = resolveDigestPath(base, item) || digestJsonPathForPng(target);
  const next = {
    ...item,
    file_path: target,
    relative_path: toProjectRelative(target),
    digest_path: digestPath,
    digest_relative_path: toProjectRelative(digestPath),
    rerendered_at: new Date().toISOString(),
  };
  const rollback = await snapshotFilesForRollback([target, digestPath]);
  try {
    await writeBinaryAtomic(target, buffer);
    await writeDigestJson(digestPath, digest);
    await upsertHistory(settings, next);
    return next;
  } catch (e) {
    try {
      await restoreFileSnapshots(rollback);
    } catch (restoreError) {
      e.rollback_error = restoreError?.message || String(restoreError);
    }
    throw e;
  }
}

export async function savePreviewMarkdown({ settings, title = '文本预览', markdown }) {
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
  const dir = path.join(outputDirFromSettings(settings), 'previews');
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
  const [realBase, realTarget] = await Promise.all([
    fsp.realpath(base).catch(() => ''),
    fsp.realpath(resolved).catch(() => ''),
  ]);
  if (!realBase || !realTarget || !isInside(realBase, realTarget)) {
    const err = new Error('path outside output dir');
    err.status = 403;
    throw err;
  }
  return resolved;
}

async function writableHistoryPngTarget(settings, targetPath) {
  const base = outputDirFromSettings(settings);
  const resolved = path.resolve(targetPath || '');
  if (!isInside(base, resolved)) {
    const err = new Error('path outside output dir');
    err.status = 403;
    throw err;
  }
  if (path.extname(resolved).toLowerCase() !== '.png') {
    const err = new Error('file must be .png');
    err.status = 400;
    throw err;
  }
  const existing = await fsp.stat(resolved).catch(e => {
    if (e?.code === 'ENOENT') return null;
    throw e;
  });
  if (existing) return assertRevealable(settings, resolved, { extensions: ['.png'] });
  await ensureDir(path.dirname(resolved));
  const [realBase, realParent] = await Promise.all([
    fsp.realpath(base).catch(() => ''),
    fsp.realpath(path.dirname(resolved)).catch(() => ''),
  ]);
  if (!realBase || !realParent || !isInside(realBase, realParent)) {
    const err = new Error('path outside output dir');
    err.status = 403;
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

function throwIfOutputAborted(signal) {
  if (!signal?.aborted) return;
  throw Object.assign(new Error('请求已取消'), { status: 499, name: 'AbortError' });
}

function isOutputAbortError(error) {
  return error?.status === 499 || error?.name === 'AbortError';
}

async function cleanupRenderedPair(filePath, digestPath) {
  if (filePath) await fsp.rm(filePath, { force: true }).catch(() => {});
  if (digestPath) await fsp.rm(digestPath, { force: true }).catch(() => {});
}

async function snapshotFilesForRollback(paths) {
  const seen = new Set();
  const snapshots = [];
  for (const filePath of paths) {
    if (!filePath) continue;
    const resolved = path.resolve(filePath);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const stat = await fsp.stat(resolved).catch(e => {
      if (e?.code === 'ENOENT') return null;
      throw e;
    });
    if (!stat) {
      snapshots.push({ filePath: resolved, existed: false });
    } else if (stat.isFile()) {
      snapshots.push({ filePath: resolved, existed: true, data: await fsp.readFile(resolved) });
    } else {
      snapshots.push({ filePath: resolved, existed: true, nonFile: true });
    }
  }
  return snapshots;
}

async function restoreFileSnapshots(snapshots) {
  for (const snapshot of [...snapshots].reverse()) {
    if (snapshot.nonFile) continue;
    if (snapshot.existed) await writeBinaryAtomic(snapshot.filePath, snapshot.data);
    else await fsp.rm(snapshot.filePath, { force: true }).catch(() => {});
  }
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
    media_status: cleanMediaStatus(digest.media_status),
    link_status: cleanLinkStatus(digest.link_status),
    model: String(digest.model || ''),
    headline: String(digest.headline || ''),
    highlights: cleanHighlights(digest.highlights),
    mentions_me: [],
    todos: cleanTodos(digest.todos),
    topics: cleanTopics(digest.topics),
    links: cleanLinks(digest.links),
    quotes: cleanQuotes(digest.quotes),
    __render: cleanRender(digest.__render),
    created_at: String(digest.created_at || new Date().toISOString()),
  };
}

function cleanMediaStatus(value) {
  const status = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!status) return null;
  const mediaMessages = Math.max(0, Number(status.media_messages || 0) || 0);
  if (!mediaMessages) return null;
  return {
    media_messages: mediaMessages,
    attached: Math.max(0, Number(status.attached || 0) || 0),
    metadata_only: Math.max(0, Number(status.metadata_only || 0) || 0),
    omitted: Math.max(0, Number(status.omitted || 0) || 0),
  };
}

function cleanLinkStatus(value) {
  const status = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!status) return null;
  const links = Math.max(0, Number(status.links || 0) || 0);
  if (!links) return null;
  return {
    links,
    processed: Math.max(0, Number(status.processed || 0) || 0),
    succeeded: Math.max(0, Number(status.succeeded || 0) || 0),
    failed: Math.max(0, Number(status.failed || 0) || 0),
    skipped: Math.max(0, Number(status.skipped || 0) || 0),
    ai_research_requested: Math.max(0, Number(status.ai_research_requested || 0) || 0),
    ai_researched: Math.max(0, Number(status.ai_researched || 0) || 0),
    ai_research_failed_batches: Math.max(0, Number(status.ai_research_failed_batches || 0) || 0),
    ai_research_skipped: !!status.ai_research_skipped,
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
    owner: cleanTodoMeta(item?.owner),
    item: String(item?.item || ''),
    deadline: cleanTodoMeta(item?.deadline),
  })).filter(item => item.item && isStrongTodoForRender(item)).slice(0, 20) : [];
}

function cleanTodoMeta(value) {
  const text = String(value || '').trim();
  return /^(待认领|未指定|无|暂无|不明确|待定|未定|待确认)$/.test(text) ? '' : text;
}

function isStrongTodoForRender(todo = {}) {
  const item = String(todo.item || '').trim();
  if (!item) return false;
  if (/持续关注|继续关注|保持关注|观察|对比|评估|确认是否|验证.*稳定性|排查.*原因|优化.*速度|准备.*方案|确定.*路线/.test(item)) return false;
  if (todo.owner || todo.deadline) return true;
  return /报名|付款|提交|联系|交付|报销|补发|回复|注册|开通|关闭|领取|上传|发布|更新|迁移|修复|整理|收集|安排/.test(item)
    && /请|需要|要|待|明天|今天|今晚|本周|下周|尽快|继续|统一|群里|大家|管理员|负责人/.test(item);
}

function cleanHighlights(value) {
  return Array.isArray(value) ? value.map(item => String(item || '').trim()).filter(Boolean).slice(0, 12) : [];
}

function cleanTopics(value) {
  return Array.isArray(value) ? value.map(item => ({
    title: String(item?.title || ''),
    category: String(item?.category || ''),
    participants: Array.isArray(item?.participants) ? item.participants.map(x => String(x || '')).filter(Boolean).slice(0, 12) : [],
    summary: String(item?.summary || ''),
    need_followup: !!item?.need_followup,
  })).filter(item => item.title || item.summary).slice(0, 100) : [];
}

function cleanQuotes(value) {
  return Array.isArray(value) ? value.map(item => {
    if (typeof item === 'string') return { speaker: '', text: item, context: '' };
    return {
      speaker: String(item?.speaker || item?.from || item?.sender || ''),
      text: String(item?.text || item?.quote || item?.content || ''),
      context: String(item?.context || item?.reason || ''),
    };
  }).filter(item => item.text).slice(0, 20) : [];
}

function cleanLinks(value) {
  return publicDigestLinks(Array.isArray(value) ? value.map(item => ({
    title: String(item?.title || ''),
    url: String(item?.url || ''),
    summary: cleanLinkSummary(item?.summary || ''),
    from: String(item?.from || ''),
    time: String(item?.time || ''),
    preview_status: String(item?.preview_status || ''),
    preview_error: String(item?.preview_error || ''),
  })).filter(item => isAnalyzableWebLinkUrl(item.url)) : []);
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
    return ['http:', 'https:'].includes(parsed.protocol) && !DIRECT_MEDIA_URL_RE.test(parsed.href) && !isIgnoredWebLinkUrl(parsed);
  } catch {
    return false;
  }
}

function publicDigestLinks(links, limit = 12) {
  return links
    .sort((a, b) => digestLinkScore(b) - digestLinkScore(a))
    .slice(0, limit);
}

function digestLinkScore(link = {}) {
  const summary = String(link.summary || '');
  let score = 0;
  if (/群里|群聊|聊天|上下文|前文|后文|发来|发出|发送|询问|讨论|针对|回应/.test(summary)) score += 8;
  if (/本程序打开该链接时返回|打开超时|加载中|环境异常|没有可靠中文摘要|分段模型失败|聊天上下文不足/.test(summary)) score -= 5;
  if (/报价|文档|官网|仓库|注册|入口|教程|新闻|快讯|公告|优惠|充值|支付|模型|API|代码|下载/.test(`${link.title || ''} ${summary}`)) score += 3;
  if (/^https?:\/\//i.test(String(link.title || '').trim())) score -= 2;
  return score;
}

function isIgnoredWebLinkUrl(parsed) {
  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();
  if (host === 'mp.weixin.qq.com' && (pathname.startsWith('/mp/wappoc_appmsgcaptcha') || pathname.startsWith('/mp/waerrpage'))) return true;
  if (host === 'support.weixin.qq.com' && (pathname.startsWith('/cgi-bin/mmsupport-bin/readtemplate') || pathname.startsWith('/update'))) return true;
  if (host === 'wxapp.tenpay.com' && pathname.startsWith('/mmpayhb/')) return true;
  return false;
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
  if (explicit && isInside(base, explicit) && /\.digest\.json$/i.test(explicit)) return explicit;
  const pngPath = item.file_path ? path.resolve(item.file_path) : '';
  const inferred = pngPath && isInside(base, pngPath) ? digestJsonPathForPng(pngPath) : '';
  return inferred && isInside(base, inferred) ? inferred : '';
}

async function upsertHistory(settings, item, { signal = null } = {}) {
  await withHistoryWriteLock(async () => {
    throwIfOutputAborted(signal);
    const file = historyIndexPath(settings);
    const list = await readHistoryIndex(settings);
    const next = [item, ...list.filter(x => x.digest_id !== item.digest_id)].slice(0, 200);
    throwIfOutputAborted(signal);
    await writeJsonAtomic(file, next);
    throwIfOutputAborted(signal);
  });
}

async function removeHistoryItem(settings, digestId) {
  const id = String(digestId || '');
  if (!id) return;
  await withHistoryWriteLock(async () => {
    const file = historyIndexPath(settings);
    const list = await readHistoryIndex(settings);
    const next = list.filter(item => item.digest_id !== id);
    if (next.length !== list.length) await writeJsonAtomic(file, next);
  });
}

function withHistoryWriteLock(action) {
  const run = historyWriteQueue.then(action, action);
  historyWriteQueue = run.catch(() => {});
  return run;
}

function buildFilename(digest, pattern = '') {
  const id8 = String(digest.digest_id || '00000000').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || '00000000';
  const tokens = {
    group: sanitizeName(digest.group || 'digest'),
    since: compactTime(digest.since),
    until: compactTime(digest.until),
    id8,
  };
  const template = String(pattern || '{group}__{since}_{until}__{id8}.png').trim();
  const rendered = template.replace(/\{(group|since|until|id8)\}/g, (_, key) => tokens[key] || '');
  const safe = sanitizeFilename(rendered || `${tokens.group}__${tokens.since}_${tokens.until}__${tokens.id8}.png`);
  return /\.png$/i.test(safe) ? safe : `${safe}.png`;
}

function sanitizeName(name) {
  return String(name || 'digest')
    .replace(/[^\p{Unified_Ideograph}a-zA-Z0-9_]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'digest';
}

function sanitizeFilename(name) {
  const ext = path.extname(String(name || '')).toLowerCase() === '.png' ? '.png' : '';
  const stem = String(name || '')
    .replace(/\.[pP][nN][gG]$/, '')
    .replace(/[\\/]+/g, '_')
    .replace(/[<>:"|?*\x00-\x1F]+/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .replace(/_+/g, '_')
    .slice(0, 120)
    .replace(/^_+|_+$/g, '') || 'digest';
  return `${stem}${ext}`;
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
