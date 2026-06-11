import { discoverWeixinEnvironment } from '../wxenv/discovery.js';
import { probeWxKey, scanLocalWeixinKeyCandidates } from '../wxkey/index.js';
import { collectMessagesFromWxDb, listChatroomsFromWxDb } from '../wxdb/index.js';
import { loadSettings, splitManualKeys } from '../config/settings.js';
import { redactSecrets } from '../summarizer/llm.js';

let REAL_GROUP_CACHE = null;
let DB_KEY_CANDIDATE_CACHE = null;
let WEIXIN_ENV_CACHE = { at: 0, result: null, promise: null };
let VERIFIED_RAW_KEY_CACHE = [];
const DB_KEY_CANDIDATE_CACHE_MS = 2 * 60 * 1000;
const WEIXIN_ENV_CACHE_MS = 30 * 1000;
const MESSAGE_SEARCH_FIELDS = ['time', 'sender', 'type', 'content'];
const MEDIA_SEARCH_FIELDS = ['kind', 'file_name', 'ext', 'size', 'width', 'height', 'duration_ms', 'duration_s', 'format', 'url', 'title', 'desc'];
const QUOTE_SEARCH_FIELDS = ['from', 'content', 'type'];
const LINK_PREVIEW_SEARCH_FIELDS = ['url', 'final_url', 'title', 'description', 'summary', 'excerpt', 'site_name', 'status', 'error', 'ai_summary'];

function abortError() {
  return Object.assign(new Error('请求已取消'), { status: 499 });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function notifyProgress(onProgress, data) {
  if (typeof onProgress !== 'function') return;
  try { onProgress(data); } catch {}
}

export async function detectWeixin({ force = false } = {}) {
  if (!force && WEIXIN_ENV_CACHE.result && Date.now() - WEIXIN_ENV_CACHE.at < WEIXIN_ENV_CACHE_MS) {
    return WEIXIN_ENV_CACHE.result;
  }
  if (!force && WEIXIN_ENV_CACHE.promise) return WEIXIN_ENV_CACHE.promise;
  const promise = discoverWeixinEnvironment();
  WEIXIN_ENV_CACHE.promise = promise;
  try {
    const result = await promise;
    WEIXIN_ENV_CACHE = { at: Date.now(), result, promise: null };
    return result;
  } finally {
    if (WEIXIN_ENV_CACHE.promise === promise) WEIXIN_ENV_CACHE.promise = null;
  }
}

export async function listAccounts() {
  const env = await detectWeixin();
  if (env.accounts?.length) {
    return env.accounts.map(account => ({
      wxid: account.wxid,
      id: account.id,
      name: account.display_name,
      wechat_version: '4.x',
      source: 'wxdb-detected',
      db_storage: account.db_storage,
      note: env.message,
    }));
  }
  return [];
}

export function clearDbKeyRuntimeCache({ clearVerified = true } = {}) {
  REAL_GROUP_CACHE = null;
  DB_KEY_CANDIDATE_CACHE = null;
  if (clearVerified) VERIFIED_RAW_KEY_CACHE = [];
}

export async function listGroups({ account_id = '' } = {}) {
  const env = await detectWeixin();
  if (!env.accounts?.length) {
    throw Object.assign(new Error(env.running === false
      ? missingWeixinDataMessage()
      : `未找到可读取的微信 v4 数据目录：${env.message || '请确认微信已登录并完成初始化。'}`), { status: 503 });
  }

  try {
    const cacheKey = account_id || 'default';
    if (REAL_GROUP_CACHE?.key === cacheKey && Date.now() - REAL_GROUP_CACHE.at < 5 * 60 * 1000) {
      return REAL_GROUP_CACHE.groups;
    }
    const groups = await runWithDbKeys({
      dbName: 'contact.db',
      action: keyBundle => listChatroomsFromWxDb({ account_id, raw_keys: keyBundle.rawKeys }),
    });
    if (groups.length) {
      await rememberVerifiedRawKeys(groups.__verified_raw_keys);
      REAL_GROUP_CACHE = { key: cacheKey, at: Date.now(), groups };
      return groups;
    }
    throw Object.assign(new Error('未能从本机微信数据库读取群列表。'), { status: 502 });
  } catch (e) {
    const msg = e?.message ? `读取本机微信群列表失败：${e.message}` : '读取本机微信群列表失败。';
    throw Object.assign(new Error(msg), { status: e?.status || 502 });
  }
}

function missingWeixinDataMessage() {
  return process.platform === 'darwin'
    ? '未检测到 Mac 微信，也未找到可读取的微信 v4 数据目录；请先登录微信，或确认 xwechat_files 数据目录可访问。'
    : '未检测到 Weixin.exe，请先登录 Windows 微信后重试。';
}

export async function collectMessages({ account_id = '', group_id, group_name, since, until, filters = {}, min_messages = 1, signal, onProgress = null } = {}) {
  throwIfAborted(signal);
  if (!group_id) {
    throw Object.assign(new Error('请先选择一个本机微信会话。'), { status: 400 });
  }
  if (!since) {
    throw Object.assign(new Error('请先选择要总结的起始时间，避免误读全部历史消息。'), { status: 400 });
  }
  validateMessageTimeRange(since, until);

  try {
    throwIfAborted(signal);
    notifyProgress(onProgress, {
      phase: 'fetch_key',
      label: '拉取消息 · 准备数据库密钥',
      detail: '优先使用缓存/手动密钥，必要时只读扫描',
    });
    const real = await runWithDbKeys({
      dbName: '微信消息库',
      onProgress,
      action: bundle => collectMessagesFromWxDb({
        account_id,
        group_id,
        since,
        until,
        raw_keys: bundle.rawKeys,
        signal,
        onProgress,
        pre_media_filter: createPreMediaFilter(filters),
      }),
    });
    throwIfAborted(signal);
    if (real) {
      const rawMessages = Array.isArray(real.messages) ? real.messages : [];
      const filterActive = filtersAreActive(filters);
      const preFilterCount = Number(real.pre_filter_message_count || real.scanned_message_count || rawMessages.length) || rawMessages.length;
      notifyProgress(onProgress, {
        phase: 'fetch_filter',
        label: filterActive ? '拉取消息 · 应用筛选' : '拉取消息 · 整理消息',
        detail: filterActive ? `筛选前 ${preFilterCount} 条` : `读取到 ${rawMessages.length} 条`,
      });
      const filtered = applyFilters(rawMessages, filters).map(redactMessageSecrets);
      const mediaStatus = summarizeMediaStatus(filtered);
      notifyProgress(onProgress, {
        phase: 'fetch_ready',
        label: '拉取消息 · 准备送入 AI',
        detail: [
          `${filtered.length} 条可总结消息`,
          filterActive ? `筛选前 ${preFilterCount} 条` : '',
          mediaStatus ? `${mediaStatus.attached}/${mediaStatus.media_messages} 条媒体已附加` : '',
        ].filter(Boolean).join(' · '),
      });
      throwIfAborted(signal);
      return {
        source: 'wxdb',
        source_label: '微信本机数据库副本（只读）',
        group_name: group_name || group_id,
        since,
        until,
        messages: filtered,
        message_count: filtered.length,
        pre_filter_message_count: preFilterCount,
        scanned_message_count: real.scanned_message_count,
        table: real.table || '',
        searched_shard_count: real.searched_shard_count,
        readable_shard_count: real.readable_shard_count,
        matching_shard_count: real.matching_shard_count,
        query_time_bounds: real.query_time_bounds || null,
        message_table_time_range: real.message_table_time_range || null,
        truncated: !!real.truncated,
        media_status: mediaStatus,
        filter_active: filterActive,
        no_matching_filters: filterActive && preFilterCount > 0 && filtered.length === 0,
        below_minimum: Number(min_messages || 0) > 0 && filtered.length < Number(min_messages || 0),
      };
    }
    throw Object.assign(new Error('未能从本机微信数据库读取该会话消息。'), { status: 502 });
  } catch (e) {
    if (e?.status === 499) throw e;
    const msg = e?.message ? `读取本机微信数据库失败：${e.message}` : '读取本机微信数据库失败。';
    throw Object.assign(new Error(msg), { status: e?.status || 502 });
  }
}

function createPreMediaFilter(filters = {}) {
  const senders = normalizeFilterTerms(filters.senders || []);
  const excluded = new Set(filters.exclude_types || filters.excludeTypes || []);
  if (!senders.length && !excluded.size) return null;
  return message => {
    if (excluded.has(message?.type)) return false;
    if (!senders.length) return true;
    const sender = normalizeSearchText(message?.sender);
    return senders.some(term => sender === term || sender.includes(term));
  };
}

function validateMessageTimeRange(since, until) {
  const start = parseMessageDateTime(since, '起始时间');
  const end = parseMessageDateTime(until || 'now', '结束时间', { allowNow: true, endOfMinuteWhenSecondsMissing: true });
  if (start && end && start > end) {
    throw Object.assign(new Error('起始时间不能晚于结束时间。'), { status: 400 });
  }
}

function parseMessageDateTime(value, label, { allowNow = false, endOfMinuteWhenSecondsMissing = false } = {}) {
  const text = String(value || '').trim();
  if (allowNow && (!text || text === 'now')) return new Date();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    throw Object.assign(new Error(`${label}格式无效，请使用 YYYY-MM-DD HH:mm 或 YYYY-MM-DD HH:mm:ss。`), { status: 400 });
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
    throw Object.assign(new Error(`${label}格式无效，请使用真实存在的日期时间。`), { status: 400 });
  }
  return date;
}

function filtersAreActive(filters = {}) {
  return normalizeFilterTerms(filters.senders || []).length > 0
    || normalizeFilterTerms(filters.keywords || []).length > 0
    || new Set(filters.exclude_types || filters.excludeTypes || []).size > 0;
}

function redactMessageSecrets(message) {
  return {
    ...message,
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
    const sender = normalizeSearchText(m.sender);
    return senders.some(term => sender === term || sender.includes(term));
  });
  if (keywords.length) result = result.filter(m => {
    const text = messageSearchText(m);
    return keywords.some(k => text.includes(k));
  });
  if (excluded.size) result = result.filter(m => !excluded.has(m.type));
  return result;
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

function enrichDbKeyFailure(error, diagnostics, dbName) {
  const message = String(error?.message || '');
  if (!isDbKeyFailure(error)) return error;
  const d = diagnostics || {};
  const total = Number(d.total_candidate_count || 0);
  const memory = Number(d.memory_candidate_count || 0);
  const local = Number(d.local_candidate_count || 0);
  const manual = Number(d.manual_key_count || 0);
  const processes = Number(d.scan_process_count || 0);
  const readonly = d.read_only_handle_ok === true ? '只读句柄正常' : '只读句柄未确认';
  const detail = [
    process.platform === 'darwin'
      ? 'Mac 微信内存自动密钥扫描尚未适配，已尝试读取本地 key 缓存'
      : `自动密钥扫描已执行（${readonly}，扫描 ${processes || 0} 个微信进程）`,
    `共得到 ${total} 个候选：内存 ${memory}、本地配置 ${local}、手动 ${manual}`,
    `但这些候选都没有匹配 ${dbName}`,
    `原始验证错误：${message}`,
    ...(process.platform === 'darwin'
      ? ['如已用外部工具导出 key，可放到 ~/.wx-cli/all_keys.json、data/all_keys.json 或 data/wechat-keys.json，或在设置页填写 64/96 位 hex 手动密钥']
      : []),
  ].join('；');
  const enriched = Object.assign(new Error(`${detail}。当前需要填写有效手动密钥，或继续适配当前微信版本的 key 形态。`), {
    status: error?.status || 502,
    key_diagnostics: d,
  });
  return enriched;
}

function isDbKeyFailure(error) {
  return /no raw key matched|no candidate key opened|SQLCipher/i.test(String(error?.message || ''));
}

async function runWithDbKeys({ dbName, action, initialKeyBundle = null, onProgress = null } = {}) {
  notifyProgress(onProgress, {
    phase: 'fetch_key_quick',
    label: '拉取消息 · 校验数据库密钥',
    detail: `${dbName || '数据库'}：先试缓存和手动密钥`,
  });
  const quick = initialKeyBundle || await dbRawKeyCandidateBundle({ memoryScan: false });
  try {
    return await action(quick);
  } catch (e) {
    if (!isDbKeyFailure(e) || quick.diagnostics?.memory_scan_attempted) {
      throw enrichDbKeyFailure(e, quick.diagnostics, dbName);
    }
    notifyProgress(onProgress, {
      phase: 'fetch_key_scan',
      label: '拉取消息 · 扫描数据库密钥',
      detail: `${dbName || '数据库'}：缓存未命中，开始只读扫描候选密钥`,
    });
    const full = await dbRawKeyCandidateBundle({ memoryScan: true });
    try {
      return await action(full);
    } catch (fallbackError) {
      throw enrichDbKeyFailure(fallbackError, full.diagnostics, dbName);
    }
  }
}

async function dbRawKeyCandidates() {
  return (await dbRawKeyCandidateBundle()).rawKeys;
}

async function dbRawKeyCandidateBundle({ memoryScan = true } = {}) {
  const settings = await loadSettings({ includeSecrets: true }).catch(() => null);
  const manual = splitManualKeys(settings?.wechat?.manual_key);
  const shouldScanLocal = !manual.length || memoryScan;
  const local = shouldScanLocal
    ? await scanLocalWeixinKeyCandidates({ include_raw: true, cache: !memoryScan }).catch(() => null)
    : null;
  const cacheKey = JSON.stringify({
    platform: process.platform,
    memoryScan,
    manual_key_text: manual.join('\n'),
    verified_hashes: VERIFIED_RAW_KEY_CACHE.map(key => key.slice(0, 12)),
    local_hashes: local?.candidate_hashes || [],
    local_file_count: Number(local?.file_stats?.scanned || 0),
  });
  if (DB_KEY_CANDIDATE_CACHE
    && DB_KEY_CANDIDATE_CACHE.key === cacheKey
    && Date.now() - DB_KEY_CANDIDATE_CACHE.at < DB_KEY_CANDIDATE_CACHE_MS) {
    return {
      rawKeys: DB_KEY_CANDIDATE_CACHE.rawKeys,
      diagnostics: { ...DB_KEY_CANDIDATE_CACHE.diagnostics, cache_hit: true },
    };
  }
  const scan = memoryScan
    ? await probeWxKey({ scan: true, include_raw: true, scan_all_processes: false })
    : null;
  const rawKeys = uniqueStrings([...manual, ...VERIFIED_RAW_KEY_CACHE, ...(local?.raw_candidates || []), ...(scan?._raw_candidates || [])]);
  const diagnostics = {
    cache_hit: false,
    memory_scan_attempted: !!memoryScan,
    manual_key_count: manual.length,
    verified_key_count: VERIFIED_RAW_KEY_CACHE.length,
    local_candidate_count: Number(local?.unique_candidate_count || local?.candidate_count || 0),
    local_file_count: Number(local?.file_stats?.scanned || 0),
    memory_candidate_count: Number(scan?.unique_candidate_count || scan?.candidate_count || 0),
    scan_process_count: Number(scan?.scan_process_count || scan?.process_count || 0),
    read_only_handle_ok: scan?.read_only_handle_ok === true,
    total_candidate_count: rawKeys.length,
  };
  DB_KEY_CANDIDATE_CACHE = {
    key: cacheKey,
    at: Date.now(),
    rawKeys,
    diagnostics,
  };
  return {
    rawKeys,
    diagnostics,
  };
}

async function rememberVerifiedRawKeys(keys = []) {
  const verified = uniqueStrings(keys).filter(isPersistableManualKey);
  if (!verified.length) return;
  VERIFIED_RAW_KEY_CACHE = uniqueStrings([...verified, ...VERIFIED_RAW_KEY_CACHE])
    .filter(isPersistableManualKey)
    .slice(0, 50);
  if (!DB_KEY_CANDIDATE_CACHE) {
    DB_KEY_CANDIDATE_CACHE = {
      key: `verified:${Date.now()}`,
      at: Date.now(),
      rawKeys: verified.slice(0, 50),
      diagnostics: {
        cache_hit: false,
        memory_scan_attempted: false,
        manual_key_count: 0,
        local_candidate_count: verified.length,
        total_candidate_count: verified.length,
      },
    };
    return;
  }
  DB_KEY_CANDIDATE_CACHE.rawKeys = uniqueStrings([...verified, ...(DB_KEY_CANDIDATE_CACHE.rawKeys || [])])
    .filter(isPersistableManualKey)
    .slice(0, 50);
  DB_KEY_CANDIDATE_CACHE.at = Date.now();
  DB_KEY_CANDIDATE_CACHE.diagnostics = {
    ...(DB_KEY_CANDIDATE_CACHE.diagnostics || {}),
    verified_key_count: DB_KEY_CANDIDATE_CACHE.rawKeys.length,
    total_candidate_count: Math.max(Number(DB_KEY_CANDIDATE_CACHE.diagnostics?.total_candidate_count || 0), DB_KEY_CANDIDATE_CACHE.rawKeys.length),
  };
}

function isPersistableManualKey(key) {
  return /^[a-f0-9]{64}$/.test(String(key || '').trim().toLowerCase());
}

function uniqueStrings(items) {
  return [...new Set(items.map(item => String(item || '').trim()).filter(Boolean))];
}

export const __collectorInternals = {
  applyFilters,
  clearDbKeyRuntimeCache,
  createPreMediaFilter,
  dbRawKeyCandidateBundle,
  dbRawKeyCandidates,
  messageSearchText,
  normalizeSearchText,
  parseMessageDateTime,
  throwIfAborted,
  validateMessageTimeRange,
};
