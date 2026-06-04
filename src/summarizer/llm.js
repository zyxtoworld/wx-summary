import crypto from 'node:crypto';
import { normalizeBaseUrl, rememberModels } from '../config/settings.js';

const MODEL_CACHE = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_FALLBACK_MAX_MESSAGES_PER_CALL = 800;
const DEFAULT_FALLBACK_MAX_INPUT_CHARS = 60_000;
const DEFAULT_MAX_IMAGE_DATA_URL_CHARS_PER_CALL = 300_000;
const ADAPTIVE_CHUNK_MESSAGE_THRESHOLD = 700;
const ADAPTIVE_CHUNK_TEXT_THRESHOLD = 120_000;
const ADAPTIVE_CHUNK_MEDIA_THRESHOLD = 900_000;
const ADAPTIVE_CHUNK_MAX_MESSAGES = 450;
const ADAPTIVE_CHUNK_MAX_INPUT_CHARS = 80_000;
const DEFAULT_DIGEST_CHUNK_CONCURRENCY = 2;
const AI_LINK_RESEARCH_URLS_PER_CALL = 8;
const DEFAULT_LINK_RESEARCH_CONCURRENCY = 2;
const DEFAULT_AI_REQUEST_CONCURRENCY = 1;
const DEFAULT_LINK_PREVIEW = {
  enabled: true,
  ai_web_search: true,
  max_links: 0,
  timeout_ms: 8000,
  max_bytes: 256 * 1024,
  max_chars_per_link: 2000,
  max_related_links: 3,
  max_related_bytes: 96 * 1024,
  max_related_chars: 800,
};
const ATTACHMENT_DATA_KEYS = new Set(['data_url', 'frame_data_url', 'audio_data_url']);
let ACTIVE_AI_REQUESTS = 0;
const AI_WAIT_QUEUE = [];

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw httpError(499, '请求已取消');
}

function linkAbortSignal(controller, signal) {
  if (!signal) return () => {};
  const onAbort = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

function notifyProgress(onProgress, data) {
  if (typeof onProgress !== 'function') return;
  try { onProgress(data); } catch {}
}

async function withAiRequestSlot({ signal = null, onProgress = null, label = 'AI 总结 · 等待 AI', detail = '等待 AI 队列空闲' } = {}, action) {
  const release = await acquireAiRequestSlot({ signal, onProgress, label, detail });
  try {
    return await action();
  } finally {
    release();
  }
}

function aiRequestConcurrency() {
  const raw = Number(process.env.WX_SUMMARY_AI_CONCURRENCY || DEFAULT_AI_REQUEST_CONCURRENCY);
  return Math.max(1, Math.min(2, Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_AI_REQUEST_CONCURRENCY));
}

function acquireAiRequestSlot({ signal = null, onProgress = null, label = 'AI 总结 · 等待 AI', detail = '等待 AI 队列空闲' } = {}) {
  throwIfAborted(signal);
  const limit = aiRequestConcurrency();
  if (ACTIVE_AI_REQUESTS < limit) {
    ACTIVE_AI_REQUESTS++;
    return Promise.resolve(releaseAiRequestSlot);
  }
  notifyProgress(onProgress, {
    phase: 'ai_queue',
    label,
    detail: `${detail} · 前面 ${AI_WAIT_QUEUE.length + ACTIVE_AI_REQUESTS} 个 AI 请求`,
  });
  return new Promise((resolve, reject) => {
    const item = { resolve, reject, signal, onAbort: null };
    item.onAbort = () => {
      const index = AI_WAIT_QUEUE.indexOf(item);
      if (index >= 0) AI_WAIT_QUEUE.splice(index, 1);
      reject(httpError(499, '请求已取消'));
    };
    if (signal) signal.addEventListener('abort', item.onAbort, { once: true });
    AI_WAIT_QUEUE.push(item);
    drainAiRequestQueue();
  });
}

function releaseAiRequestSlot() {
  ACTIVE_AI_REQUESTS = Math.max(0, ACTIVE_AI_REQUESTS - 1);
  drainAiRequestQueue();
}

function drainAiRequestQueue() {
  const limit = aiRequestConcurrency();
  while (ACTIVE_AI_REQUESTS < limit && AI_WAIT_QUEUE.length) {
    const item = AI_WAIT_QUEUE.shift();
    if (item.signal?.aborted) {
      item.signal.removeEventListener('abort', item.onAbort);
      item.reject(httpError(499, '请求已取消'));
      continue;
    }
    item.signal?.removeEventListener('abort', item.onAbort);
    ACTIVE_AI_REQUESTS++;
    item.resolve(releaseAiRequestSlot);
  }
}

export function sanitizeText(text, knownSecret = '') {
  let s = String(text || '');
  if (knownSecret) s = s.split(knownSecret).join('[redacted-api-key]');
  return redactSecrets(s).slice(0, 1200);
}

export function redactSecrets(text) {
  return String(text || '')
    .replace(/data:[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, '[redacted-data-url]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-[redacted]')
    .replace(/\b(?:[a-fA-F0-9]{96}|[a-fA-F0-9]{64})\b/g, '[redacted-hex-secret]');
}

export function redactContent(text, privacy = {}) {
  let s = redactSecrets(text);
  if (privacy.redact_phone !== false) s = s.replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[手机号]');
  if (privacy.redact_id_card !== false) s = s.replace(/(?<![0-9Xx])\d{6}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx](?![0-9Xx])/g, '[身份证号]');
  if (privacy.redact_bank_card !== false) s = s.replace(/(?<!\d)(?:\d[ -]?){16,19}(?!\d)/g, '[银行卡号]');
  if (privacy.redact_email === true) s = s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱]');
  return s;
}

export function redactStructuredValue(value, privacy = {}, key = '') {
  if (typeof value === 'string') {
    return ATTACHMENT_DATA_KEYS.has(key) ? value : redactContent(value, privacy);
  }
  if (Array.isArray(value)) return value.map(item => redactStructuredValue(item, privacy));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      redactStructuredValue(childValue, privacy, childKey),
    ]));
  }
  return value;
}

export async function listModels({ provider, base_url, api_key, refresh = false, timeout_ms = 30000, persist = false }) {
  const normalizedBase = normalizeBaseUrl(base_url);
  if (!['openai', 'anthropic'].includes(provider)) throw httpError(400, 'Unsupported provider');
  if (!normalizedBase) throw httpError(400, 'Missing base_url');
  if (!api_key) throw httpError(400, 'Missing api_key');

  const cacheKey = `${provider}:${normalizedBase}`;
  const cached = MODEL_CACHE.get(cacheKey);
  if (!refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    if (persist) await rememberModels({ provider, base_url: normalizedBase, models: cached.models }).catch(() => {});
    return { ok: true, models: cached.models, cached: true };
  }

  const headers = provider === 'openai'
    ? { Authorization: `Bearer ${api_key}` }
    : { 'x-api-key': api_key, 'anthropic-version': '2023-06-01' };
  const json = await fetchJson(`${normalizedBase}/models`, { method: 'GET', headers, timeout_ms, api_key });
  const models = normalizeModelList(json);
  MODEL_CACHE.set(cacheKey, { at: Date.now(), models });
  if (persist) await rememberModels({ provider, base_url: normalizedBase, models }).catch(() => {});
  return { ok: true, models, cached: false };
}

function normalizeModelList(json) {
  const raw = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : (Array.isArray(json?.models) ? json.models : []));
  return raw
    .map(item => {
      if (typeof item === 'string') return { id: item };
      if (!item?.id && !item?.name) return null;
      return {
        id: String(item.id || item.name),
        owned_by: item.owned_by || item.owner || undefined,
        context_window: item.context_window || item.context_length || undefined,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function summarizeDigest({ settings, groupName, since, until, messages, signal, onProgress }) {
  throwIfAborted(signal);
  const llm = settings.llm;
  const apiKey = llm.api_key;
  if (!apiKey) throw httpError(400, 'API key is not configured');
  if (!llm.base_url) throw httpError(400, 'Base URL is not configured');
  const model = llm.model || llm.available_models?.[0]?.id;
  if (!model) throw httpError(400, 'Model is not configured');

  notifyProgress(onProgress, {
    phase: 'prepare',
    label: 'AI 总结 · 准备输入',
    detail: `${messages.length} 条消息`,
  });
  const normalized = messages.map(m => redactStructuredValue(m, settings.privacy));
  const enriched = await enrichMessagesWithLinkPreviews(normalized, settings.link_preview, settings, signal, onProgress);
  throwIfAborted(signal);
  const plan = buildDigestChunkPlan(enriched, llm);
  let raw;
  if (plan.useChunks) {
    notifyProgress(onProgress, {
      phase: 'llm_chunk_plan',
      label: 'AI 总结 · 自动分段',
      detail: `${plan.chunks.length} 段 · ${plan.reason}`,
    });
    try {
      raw = await summarizeMessageChunks({
        settings,
        model,
        groupName,
        since,
        until,
        chunks: plan.chunks,
        signal,
        onProgress,
      });
    } catch (chunkError) {
      throw httpError(
        chunkError.status || 502,
        `已因输入较大自动分段；分段失败：${chunkError.message || String(chunkError)}`,
      );
    }
  } else {
    try {
      notifyProgress(onProgress, {
        phase: 'llm_full',
        label: 'AI 总结 · 全量请求',
        detail: `${messages.length} 条消息一次发送`,
      });
      raw = await callJsonModel({
        settings,
        model,
        groupName,
        since,
        until,
        messageBundle: formatMessageBundle(enriched),
        mode: 'final/full',
        signal,
        onProgress,
      });
    } catch (firstError) {
      const chunks = splitMessages(
        enriched,
        llm.max_messages_per_call || DEFAULT_FALLBACK_MAX_MESSAGES_PER_CALL,
        llm.max_input_chars || DEFAULT_FALLBACK_MAX_INPUT_CHARS,
        llm.max_image_chars_per_call || DEFAULT_MAX_IMAGE_DATA_URL_CHARS_PER_CALL,
      );
      if (!isLikelyChunkableFailure(firstError) || chunks.length <= 1) throw firstError;

      try {
        raw = await summarizeMessageChunks({
          settings,
          model,
          groupName,
          since,
          until,
          chunks,
          signal,
          onProgress,
        });
      } catch (fallbackError) {
        throw httpError(
          fallbackError.status || firstError.status || 502,
          `已尝试一次全量发送，失败后自动分段；分段也失败：${fallbackError.message || String(fallbackError)}`,
        );
      }
    }
  }

  return normalizeDigest(raw, {
    groupName,
    since,
    until,
    messageCount: messages.length,
    model,
    linkPreviewCount: enriched.reduce((n, msg) => n + (msg.link_previews?.length || 0), 0),
  });
}

async function summarizeMessageChunks({ settings, model, groupName, since, until, chunks, signal, onProgress }) {
  const concurrency = digestChunkConcurrency(settings);
  const summaries = new Array(chunks.length);
  let completed = 0;
  notifyProgress(onProgress, {
    phase: 'llm_chunks',
    label: 'AI 总结 · 分段总结',
    detail: `${chunks.length} 段 · 并发 ${concurrency} 路`,
  });
  await mapWithConcurrency(chunks, concurrency, async (chunk, index) => {
    throwIfAborted(signal);
    notifyProgress(onProgress, {
      phase: 'llm_chunk',
      label: 'AI 总结 · 分段总结',
      detail: `正在处理第 ${index + 1}/${chunks.length} 段 · 已完成 ${completed}/${chunks.length}`,
    });
    const part = await summarizeChunkWithFallback({
      settings,
      model,
      groupName,
      since,
      until,
      chunk,
      index,
      total: chunks.length,
      signal,
      onProgress,
    });
    summaries[index] = `分段 ${index + 1}${part?._fallback_chunk ? '（原始时间线兜底）' : ''}: ${JSON.stringify(part)}`;
    completed++;
    notifyProgress(onProgress, {
      phase: 'llm_chunk',
      label: 'AI 总结 · 分段总结',
      detail: `已完成 ${completed}/${chunks.length} 段 · 并发 ${concurrency} 路`,
    });
  });
  notifyProgress(onProgress, {
    phase: 'llm_merge',
    label: 'AI 总结 · 合并分段',
    detail: `${chunks.length} 段摘要合并为群纪要`,
  });
  return callJsonModel({
    settings,
    model: settings.llm.long_context_model || model,
    groupName,
    since,
    until,
    messageBundle: { text: summaries.join('\n\n'), images: [] },
    mode: 'merge',
    signal,
    onProgress,
  });
}

async function summarizeChunkWithFallback({ settings, model, groupName, since, until, chunk, index, total, signal, onProgress }) {
  const mode = `chunk ${index + 1}/${total}`;
  try {
    return await callJsonModel({
      settings,
      model,
      groupName,
      since,
      until,
      messageBundle: formatMessageBundle(chunk),
      mode,
      signal,
      onProgress,
    });
  } catch (err) {
    if (err?.status === 499 || signal?.aborted) throw err;
    if (!isLikelyRecoverableChunkFailure(err)) throw err;
    const fallback = buildFallbackChunkDigest({ chunk, index, error: err });
    notifyProgress(onProgress, {
      phase: 'llm_chunk_fallback',
      label: 'AI 总结 · 分段兜底',
      detail: `第 ${index + 1}/${total} 段模型返回异常，已把原始时间线交给合并阶段`,
    });
    return fallback;
  }
}

function buildFallbackChunkDigest({ chunk, index, error }) {
  const bundle = formatMessageBundle(chunk);
  const media = chunkMediaStats(bundle);
  const participants = [...new Set(chunk.map(msg => cleanField(msg.sender)).filter(Boolean))].slice(0, 20);
  const firstTime = chunk[0]?.time || '';
  const lastTime = chunk[chunk.length - 1]?.time || firstTime;
  const mediaText = [
    media.images ? `${media.images} 张图片/视频关键帧` : '',
    media.audio ? `${media.audio} 条音频` : '',
  ].filter(Boolean).join('、') || '无可直接附加的媒体块';
  return {
    headline: `第 ${index + 1} 段需按原始时间线合并`,
    topics: [{
      title: `第 ${index + 1} 段原始时间线待合并`,
      participants,
      summary: [
        '待确认：该分段的模型请求返回空内容或异常，最终合并阶段必须直接读取 _raw_timeline 中的原始消息文本、时间、发送人、文件名、链接打开结果和媒体元信息。',
        `范围：${firstTime || '未知时间'} ~ ${lastTime || '未知时间'}，共 ${chunk.length} 条消息，包含 ${mediaText}。`,
        '图片/视频/音频如果没有被模型成功识别，只能说明已保留元信息，不能编造画面或语音内容。',
        `分段错误：${sanitizeText(error?.message || String(error))}`,
      ].join(' '),
      need_followup: true,
    }],
    todos: [],
    links: fallbackLinksFromChunk(chunk),
    _fallback_chunk: true,
    _fallback_error: sanitizeText(error?.message || String(error)),
    _raw_timeline: bundle.text,
  };
}

function chunkMediaStats(bundle = {}) {
  return {
    images: Number(bundle.imageCount || 0),
    audio: Number(bundle.audioCount || 0),
  };
}

function fallbackLinksFromChunk(chunk = []) {
  const out = [];
  const seen = new Set();
  for (const msg of chunk) {
    for (const preview of arrayOf(msg.link_previews)) {
      const url = normalizeHttpUrl(preview.final_url || preview.url);
      if (!url || seen.has(url) || !isAnalyzableWebLinkUrl(url)) continue;
      seen.add(url);
      out.push({
        title: cleanField(preview.ai_title || preview.title || url).slice(0, 200),
        url,
        summary: cleanLinkSummary(preview.ai_summary || preview.description || preview.excerpt || preview.error || '该网页链接出现在本分段原始消息中；分段模型失败，最终合并需结合上下文判断用途。').slice(0, 1000),
        from: cleanField(msg.sender),
        time: cleanField(msg.time),
      });
    }
    const urls = [
      ...extractUrlsFromText(msg.content),
      ...extractUrlsFromText(msg.media?.url),
    ];
    for (const url of urls) {
      if (!url || seen.has(url) || !isAnalyzableWebLinkUrl(url)) continue;
      seen.add(url);
      out.push({
        title: url,
        url,
        summary: '该网页链接出现在本分段原始消息中；分段模型失败，最终合并需结合上下文判断用途。',
        from: cleanField(msg.sender),
        time: cleanField(msg.time),
      });
    }
  }
  return out;
}

function buildDigestChunkPlan(messages, llm = {}) {
  const stats = {
    messages: messages.length,
    textChars: estimateMessageTextChars(messages),
    mediaChars: estimateMediaPayloadChars(messages),
  };
  const reasons = [];
  if (stats.messages > ADAPTIVE_CHUNK_MESSAGE_THRESHOLD) reasons.push(`${stats.messages} 条消息`);
  if (stats.textChars > ADAPTIVE_CHUNK_TEXT_THRESHOLD) reasons.push(`约 ${stats.textChars} 字符输入`);
  if (stats.mediaChars > ADAPTIVE_CHUNK_MEDIA_THRESHOLD) reasons.push(`约 ${Math.round(stats.mediaChars / 1024)}KB 媒体附件`);
  if (!reasons.length) return { useChunks: false, chunks: [messages], stats, reason: '' };

  const maxMessages = Math.min(
    Math.max(1, Number(llm.max_messages_per_call || DEFAULT_FALLBACK_MAX_MESSAGES_PER_CALL)),
    ADAPTIVE_CHUNK_MAX_MESSAGES,
  );
  const maxChars = Math.min(
    Math.max(1000, Number(llm.max_input_chars || DEFAULT_FALLBACK_MAX_INPUT_CHARS)),
    ADAPTIVE_CHUNK_MAX_INPUT_CHARS,
  );
  const maxImageChars = Math.min(
    Math.max(100000, Number(llm.max_image_chars_per_call || DEFAULT_MAX_IMAGE_DATA_URL_CHARS_PER_CALL)),
    DEFAULT_MAX_IMAGE_DATA_URL_CHARS_PER_CALL,
  );
  const chunks = splitMessages(messages, maxMessages, maxChars, maxImageChars);
  return {
    useChunks: chunks.length > 1,
    chunks,
    stats,
    reason: reasons.join('，'),
  };
}

function estimateMessageTextChars(messages) {
  return messages.reduce((n, msg) => n + formatMessageLine(msg).length + 1, 0);
}

function estimateMediaPayloadChars(messages) {
  return messages.reduce((n, msg) => n + mediaPayloadChars(msg), 0);
}

function digestChunkConcurrency(settings = {}) {
  const value = Number(settings?.llm?.chunk_concurrency || DEFAULT_DIGEST_CHUNK_CONCURRENCY);
  return Math.max(1, Math.min(3, Number.isFinite(value) ? Math.floor(value) : DEFAULT_DIGEST_CHUNK_CONCURRENCY));
}

async function mapWithConcurrency(items, concurrency, worker) {
  let cursor = 0;
  const limit = Math.max(1, Math.min(Number(concurrency) || 1, items.length || 1));
  const workers = Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

function splitMessages(messages, maxMessages, maxChars, maxImageChars = DEFAULT_MAX_IMAGE_DATA_URL_CHARS_PER_CALL) {
  const chunks = [];
  let cur = [];
  let chars = 0;
  let imageChars = 0;
  const messageLimit = Math.max(1, Number(maxMessages || 800));
  const charLimit = Math.max(1000, Number(maxChars || 60000));
  const imageCharLimit = Math.max(100000, Number(maxImageChars || DEFAULT_MAX_IMAGE_DATA_URL_CHARS_PER_CALL));

  for (const msg of messages) {
    const line = formatMessageLine(msg);
    const dataUrlChars = mediaPayloadChars(msg);
    const shouldSplit = cur.length && (
      cur.length >= messageLimit
      || chars + line.length > charLimit
      || (dataUrlChars > 0 && imageChars + dataUrlChars > imageCharLimit)
    );
    if (shouldSplit) {
      chunks.push(cur);
      cur = [];
      chars = 0;
      imageChars = 0;
    }
    cur.push(msg);
    chars += line.length;
    imageChars += dataUrlChars;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function formatMessageBundle(messages) {
  const blocks = [];
  const lines = [];
  let textBuffer = [];
  let imageCount = 0;
  let audioCount = 0;
  let imageChars = 0;
  let audioChars = 0;

  function flushText() {
    if (!textBuffer.length) return;
    blocks.push({ kind: 'text', text: textBuffer.join('\n') });
    textBuffer = [];
  }

  for (const msg of messages) {
    const dataUrl = msg.media?.data_url || '';
    const frameDataUrl = msg.media?.frame_data_url || '';
    const audioDataUrl = msg.media?.audio_data_url || '';
    const canAttachImage = msg.type === 'image' && dataUrl;
    const canAttachFrame = (msg.type === 'video' || isVideoLikeMedia(msg.media)) && frameDataUrl;
    const audioFormat = chatAudioFormatForModel(dataUrlMime(audioDataUrl) || msg.media?.mime);
    const canAttachAudio = audioDataUrl && audioFormat && (msg.type === 'voice' || isAudioLikeMedia(msg.media));
    const imageRef = canAttachImage ? `图片${imageCount + 1}` : (canAttachFrame ? `视频关键帧${imageCount + 1}` : '');
    const audioRef = canAttachAudio ? `音频${audioCount + 1}` : '';
    const line = formatMessageLine(msg, { imageRef, audioRef });
    lines.push(line);
    textBuffer.push(line);
    if (canAttachImage || canAttachFrame) {
      flushText();
      const visualUrl = canAttachImage ? dataUrl : frameDataUrl;
      blocks.push({
        kind: 'image',
        ref: imageRef,
        data_url: visualUrl,
        mime: (canAttachImage ? msg.media.mime : msg.media.frame_mime) || dataUrlMime(visualUrl),
      });
      imageCount++;
      imageChars += visualUrl.length;
    }
    if (canAttachAudio) {
      flushText();
      blocks.push({
        kind: 'audio',
        ref: audioRef,
        data_url: audioDataUrl,
        mime: msg.media.mime || dataUrlMime(audioDataUrl),
        format: audioFormat,
      });
      audioCount++;
      audioChars += audioDataUrl.length;
    }
  }
  flushText();

  return {
    text: lines.join('\n'),
    blocks,
    imageCount,
    audioCount,
    imageChars,
    audioChars,
    linkPreviewCount: messages.reduce((n, msg) => n + (msg.link_previews?.length || 0), 0),
  };
}

function mediaPayloadChars(msg) {
  const media = msg?.media || {};
  return [
    media.data_url,
    media.frame_data_url,
    media.audio_data_url,
  ].reduce((n, value) => n + (value ? String(value).length : 0), 0);
}

function formatMessageLine(m, { imageRef = '', audioRef = '' } = {}) {
  const type = m.type && m.type !== 'text' ? `/${m.type}` : '';
  let suffix = '';
  if (m.type === 'image' && imageRef) {
    suffix = `（下一块就是这条消息对应的${imageRef}）`;
  } else if ((m.type === 'video' || isVideoLikeMedia(m.media)) && imageRef) {
    suffix = `（下一块就是这条视频/文件对应的${imageRef}）`;
  } else if ((m.type === 'voice' || isAudioLikeMedia(m.media)) && audioRef) {
    suffix = `（下一块尝试附上这条消息对应的${audioRef}；如果模型不支持音频，仍按本行元信息总结）`;
  } else if (m.type === 'image' && m.media?.local_available && !m.media?.data_url) {
    suffix = '（本地图片文件已定位，但当前格式暂不能直接解封为 JPG/PNG）';
  } else if ((m.type === 'video' || isVideoLikeMedia(m.media)) && m.media?.local_available && !m.media?.frame_data_url) {
    suffix = '（本地视频已定位，但当前未能抽取关键帧；不要假装看过视频内容）';
  } else if ((m.type === 'voice' || isAudioLikeMedia(m.media)) && m.media?.audio_data_url && !chatAudioFormatForModel(dataUrlMime(m.media.audio_data_url) || m.media?.mime)) {
    suffix = '（本地音频已定位，但格式不是当前 Chat Completions 音频块可直接识别的 wav/mp3；已保留时间、发送人、文件名和时长等元信息）';
  } else if ((m.type === 'voice' || isAudioLikeMedia(m.media)) && m.media?.local_available && !m.media?.audio_data_url) {
    suffix = '（本地语音/音频已定位，但当前模型接口未拿到可用音频；不要假装听过语音内容）';
  }
  if (m.type === 'file' && m.media?.file_name) {
    return `[${m.time}] ${m.sender}${type}: 文件名=${m.media.file_name}${m.media.size ? `，大小=${m.media.size}B` : ''}${m.media.ext ? `，扩展名=${m.media.ext}` : ''}${suffix}`;
  }
  if (m.type === 'quote' && m.media?.quote) {
    const quote = m.media.quote;
    const quoted = [quote.from, quote.content].filter(Boolean).join(': ');
    return `[${m.time}] ${m.sender}${type}: ${m.media.title || m.content}${quoted ? `；引用原文=${quoted}` : ''}`;
  }
  return `[${m.time}] ${m.sender}${type}: ${m.content}${suffix}${formatLinkPreviewLines(m.link_previews)}`;
}

function isVideoLikeMedia(media = {}) {
  const ext = String(media.ext || '').toLowerCase();
  const name = String(media.file_name || '').toLowerCase();
  return ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', '3gp'].some(item => ext === item || name.endsWith(`.${item}`));
}

function isAudioLikeMedia(media = {}) {
  const ext = String(media.ext || '').toLowerCase();
  const name = String(media.file_name || '').toLowerCase();
  return ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'webm', 'flac', 'amr', 'silk', 'aud'].some(item => ext === item || name.endsWith(`.${item}`));
}

function formatLinkPreviewLines(previews) {
  if (!Array.isArray(previews) || !previews.length) return '';
  return previews.map(preview => {
    const parts = [
      `URL=${preview.url}`,
      preview.final_url && preview.final_url !== preview.url ? `最终地址=${preview.final_url}` : '',
      preview.status === 'ok' ? `标题=${preview.title || '未识别'}` : '',
      preview.status === 'ok' && preview.description ? `页面描述=${preview.description}` : '',
      preview.status === 'ok' && preview.excerpt ? `正文片段=${preview.excerpt}` : '',
      preview.ai_summary ? `AI联网摘要=${preview.ai_summary}` : '',
      preview.ai_sources?.length ? `AI来源=${preview.ai_sources.join('，')}` : '',
      preview.status === 'ok' && preview.related_pages?.length ? `同站补充页面=${preview.related_pages.map(p => [
        p.anchor ? `锚文本:${p.anchor}` : '',
        p.title ? `标题:${p.title}` : '',
        p.url ? `URL:${p.url}` : '',
        p.excerpt ? `片段:${p.excerpt}` : '',
      ].filter(Boolean).join('，')).join(' | ')}` : '',
      preview.status !== 'ok' ? `本程序访问失败=${preview.error || preview.status || '未知原因'}（这只是 wx-summary 打开链接的结果，不代表群内成员反馈）` : '',
      preview.content_type ? `类型=${preview.content_type}` : '',
    ].filter(Boolean);
    return `\n  -> 链接打开结果：${parts.join('；')}`;
  }).join('');
}

export async function enrichMessagesWithLinkPreviews(messages, options = {}, settings = null, signal = null, onProgress = null) {
  const cfg = { ...DEFAULT_LINK_PREVIEW, ...(options || {}) };
  if (cfg.enabled === false) return messages;
  throwIfAborted(signal);

  const targets = extractMessageLinkTargets(messages);
  if (!targets.length) return messages;

  const uniqueUrls = [...new Set(targets.map(t => t.url))];
  notifyProgress(onProgress, {
    phase: 'link_preview',
    label: 'AI 总结 · 打开网页',
    detail: `${uniqueUrls.length} 个网页链接`,
  });
  const previewByUrl = new Map();
  let cursor = 0;
  let completed = 0;
  const workers = Array.from({ length: Math.min(4, uniqueUrls.length) }, async () => {
    while (cursor < uniqueUrls.length) {
      throwIfAborted(signal);
      const url = uniqueUrls[cursor++];
      let preview;
      try {
        preview = await fetchLinkPreview(url, cfg, signal);
      } catch (err) {
        if (err?.status === 499 || signal?.aborted) throw err;
        preview = {
          url,
          status: 'failed',
          error: cleanField(err?.message || String(err)).slice(0, 120),
        };
      }
      previewByUrl.set(url, preview);
      completed++;
      if (completed === uniqueUrls.length || completed % 5 === 0) {
        notifyProgress(onProgress, {
          phase: 'link_preview',
          label: 'AI 总结 · 打开网页',
          detail: `已打开 ${completed}/${uniqueUrls.length} 个网页链接`,
        });
      }
    }
  });
  await Promise.all(workers);

  const researchUrls = uniqueUrls.filter(url => isAnalyzableLinkPreview(previewByUrl.get(url)));
  let aiResearch = new Map();
  try {
    aiResearch = await fetchAiLinkResearchForUrls(researchUrls, settings, cfg, signal, onProgress);
  } catch (err) {
    if (err?.status === 499 || signal?.aborted) throw err;
  }
  for (const [url, research] of aiResearch.entries()) {
    const current = previewByUrl.get(url) || { url, status: 'ok' };
    previewByUrl.set(url, {
      ...current,
      ai_summary: research.summary,
      ai_title: research.title,
      ai_sources: research.sources,
    });
  }

  const urlsByMessage = new Map();
  for (const target of targets) {
    const arr = urlsByMessage.get(target.index) || [];
    arr.push(target.url);
    urlsByMessage.set(target.index, arr);
  }

  return messages.map((msg, index) => {
    const urls = urlsByMessage.get(index);
    if (!urls?.length) return msg;
    const previews = urls.map(url => previewByUrl.get(url)).filter(isAnalyzableLinkPreview);
    return previews.length ? { ...msg, link_previews: previews } : msg;
  });
}

function extractMessageLinkTargets(messages) {
  const targets = [];
  for (let index = 0; index < messages.length; index++) {
    const msg = messages[index];
    const urls = new Set([
      ...extractUrlsFromText(msg.content),
      ...extractUrlsFromText(msg.media?.url),
    ]);
    for (const url of urls) targets.push({ index, url, time: msg.time, sender: msg.sender });
  }
  return targets;
}

function extractUrlsFromText(text) {
  const value = String(text || '');
  const matches = value.match(/https?:\/\/[^\s<>"'`]+/gi) || [];
  return matches
    .map(cleanUrlCandidate)
    .map(normalizeHttpUrl)
    .filter(url => url && isAnalyzableWebLinkUrl(url));
}

function cleanUrlCandidate(value) {
  let s = String(value || '').trim();
  while (/[),.;:!?，。；：！？、》”’\]}]+$/.test(s)) s = s.slice(0, -1);
  return s;
}

function normalizeHttpUrl(value) {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return '';
  }
}

const DIRECT_MEDIA_URL_RE = /\.(?:avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp|mp4|m4v|mov|avi|mkv|webm|3gp|mp3|wav|m4a|aac|oga?|flac|amr|silk)(?:$|[?#])/i;

function isAnalyzableWebLinkUrl(value) {
  const url = normalizeHttpUrl(value);
  return !!url && !DIRECT_MEDIA_URL_RE.test(url);
}

function isMediaContentType(contentType = '') {
  return /^(?:image|audio|video)\//i.test(String(contentType || '').trim());
}

function isAnalyzableLinkPreview(preview) {
  if (!preview || preview.status === 'skipped_media') return false;
  return isAnalyzableWebLinkUrl(preview.url) && (!preview.final_url || isAnalyzableWebLinkUrl(preview.final_url));
}

async function fetchLinkPreview(targetUrl, cfg, signal = null) {
  throwIfAborted(signal);
  const url = normalizeHttpUrl(targetUrl);
  if (!url) return { url: targetUrl, status: 'skipped', error: '不是 http(s) 链接' };
  if (!isAnalyzableWebLinkUrl(url)) {
    return { url, status: 'skipped_media', error: '图片/音视频直链不做网页摘要' };
  }

  const github = parseGitHubRepoUrl(url);
  if (github) {
    const preview = await fetchGitHubRepoPreview(url, github, cfg, signal).catch(err => {
      if (err?.status === 499 || signal?.aborted) throw err;
      return null;
    });
    if (preview) return preview;
  }

  const controller = new AbortController();
  const unlinkAbort = linkAbortSignal(controller, signal);
  const timer = setTimeout(() => controller.abort(), cfg.timeout_ms);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'wx-summary/0.1 link-preview',
        Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.8,*/*;q=0.3',
      },
    });
    const contentType = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (isMediaContentType(contentType)) {
      return {
        url,
        final_url: res.url || url,
        status: 'skipped_media',
        error: '图片/音视频直链不做网页摘要',
        content_type: contentType,
      };
    }
    if (!res.ok) {
      return {
        url,
        final_url: res.url || url,
        status: 'failed',
        error: `HTTP ${res.status}`,
        content_type: contentType,
      };
    }
    const limited = await readLimitedResponse(res, cfg.max_bytes);
    if (!isTextLikeContent(contentType)) {
      return {
        url,
        final_url: res.url || url,
        status: 'ok',
        title: '',
        description: '',
        excerpt: `非文本链接，类型 ${contentType || '未知'}，无法直接读取正文。`,
        content_type: contentType,
      };
    }
    const html = new TextDecoder('utf-8', { fatal: false }).decode(limited);
    const preview = normalizeLinkPreview(url, res.url || url, contentType, html, cfg.max_chars_per_link);
    if (looksLikeHtml(contentType, html)) {
      const related = await fetchRelatedLinkPreviews(res.url || url, html, cfg, signal).catch(err => {
        if (err?.status === 499 || signal?.aborted) throw err;
        return [];
      });
      if (related.length) preview.related_pages = related;
    }
    return preview;
  } catch (e) {
    if (signal?.aborted) throwIfAborted(signal);
    return {
      url,
      status: 'failed',
      error: e?.name === 'AbortError' ? '打开超时' : cleanField(e?.message || String(e)).slice(0, 120),
    };
  } finally {
    unlinkAbort();
    clearTimeout(timer);
  }
}

function parseGitHubRepoUrl(value) {
  try {
    const parsed = new URL(value);
    if (!/^github\.com$/i.test(parsed.hostname)) return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const [owner, rawRepo] = parts;
    const repo = rawRepo.replace(/\.git$/i, '');
    const reserved = new Set(['about', 'account', 'apps', 'codespaces', 'collections', 'dashboard', 'events', 'explore', 'features', 'issues', 'login', 'marketplace', 'new', 'notifications', 'orgs', 'pricing', 'pulls', 'search', 'settings', 'signup', 'sponsors', 'topics', 'trending']);
    if (reserved.has(owner.toLowerCase()) || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
    return { owner, repo };
  } catch {
    return null;
  }
}

async function fetchGitHubRepoPreview(originalUrl, { owner, repo }, cfg, signal = null) {
  const apiBase = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const repoJson = await fetchGitHubJson(apiBase, cfg, signal);
  if (!repoJson?.full_name) return null;

  const [readmeJson, contentsJson] = await Promise.all([
    fetchGitHubJson(`${apiBase}/readme`, cfg, signal).catch(err => {
      if (err?.status === 499 || signal?.aborted) throw err;
      return null;
    }),
    fetchGitHubJson(`${apiBase}/contents?ref=${encodeURIComponent(repoJson.default_branch || 'HEAD')}`, cfg, signal).catch(err => {
      if (err?.status === 499 || signal?.aborted) throw err;
      return null;
    }),
  ]);
  const readmeText = decodeGitHubReadme(readmeJson);
  const rootFiles = Array.isArray(contentsJson)
    ? contentsJson.map(item => item?.name).filter(Boolean).slice(0, 30)
    : [];
  const facts = [
    `GitHub仓库=${repoJson.full_name}`,
    repoJson.description ? `描述=${repoJson.description}` : '',
    repoJson.language ? `主要语言=${repoJson.language}` : '',
    Number.isFinite(repoJson.stargazers_count) ? `stars=${repoJson.stargazers_count}` : '',
    Number.isFinite(repoJson.forks_count) ? `forks=${repoJson.forks_count}` : '',
    repoJson.default_branch ? `默认分支=${repoJson.default_branch}` : '',
    repoJson.license?.spdx_id ? `许可证=${repoJson.license.spdx_id}` : '',
    Array.isArray(repoJson.topics) && repoJson.topics.length ? `topics=${repoJson.topics.slice(0, 12).join(', ')}` : '',
    repoJson.homepage ? `homepage=${repoJson.homepage}` : '',
    rootFiles.length ? `根目录文件=${rootFiles.join(', ')}` : '',
    readmeText ? `README片段=${cleanField(markdownToPlainText(readmeText)).slice(0, Math.max(500, Number(cfg.max_chars_per_link || DEFAULT_LINK_PREVIEW.max_chars_per_link)))}` : '',
  ].filter(Boolean);

  return {
    url: originalUrl,
    final_url: repoJson.html_url || originalUrl,
    status: 'ok',
    title: `${repoJson.full_name}${repoJson.description ? ` - ${repoJson.description}` : ''}`.slice(0, 200),
    description: cleanField(repoJson.description || '').slice(0, 500),
    excerpt: facts.join('；'),
    content_type: 'application/vnd.github+json',
  };
}

async function fetchGitHubJson(url, cfg, signal = null) {
  throwIfAborted(signal);
  const controller = new AbortController();
  const unlinkAbort = linkAbortSignal(controller, signal);
  const timer = setTimeout(() => controller.abort(), Math.min(8000, Number(cfg.timeout_ms || DEFAULT_LINK_PREVIEW.timeout_ms)));
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'wx-summary/0.1 github-preview',
        Accept: 'application/vnd.github+json',
      },
    });
    const limited = await readLimitedResponse(res, cfg.max_bytes || DEFAULT_LINK_PREVIEW.max_bytes);
    if (!res.ok) return null;
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(limited));
    } catch {
      return null;
    }
  } finally {
    unlinkAbort();
    clearTimeout(timer);
  }
}

function decodeGitHubReadme(readmeJson) {
  if (!readmeJson?.content) return '';
  try {
    const normalized = String(readmeJson.content || '').replace(/\s+/g, '');
    return Buffer.from(normalized, 'base64').toString('utf-8');
  } catch {
    return '';
  }
}

function markdownToPlainText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/[#>*_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchAiLinkResearchForUrls(urls, settings, cfg, signal = null, onProgress = null) {
  if (!shouldUseAiLinkResearch(urls, settings, cfg)) return new Map();
  throwIfAborted(signal);
  const uniqueUrls = [...new Set(urls.map(normalizeHttpUrl).filter(Boolean))];
  const chunks = chunkArray(uniqueUrls, AI_LINK_RESEARCH_URLS_PER_CALL);
  const concurrency = Math.min(DEFAULT_LINK_RESEARCH_CONCURRENCY, chunks.length || 1);
  const out = new Map();
  let completed = 0;
  notifyProgress(onProgress, {
    phase: 'ai_link_research',
    label: 'AI 总结 · AI 查链接',
    detail: `${uniqueUrls.length} 个网页链接${chunks.length > 1 ? ` · ${chunks.length} 批` : ''}`,
  });
  await mapWithConcurrency(chunks, concurrency, async (chunk, index) => {
    throwIfAborted(signal);
    notifyProgress(onProgress, {
      phase: 'ai_link_research',
      label: 'AI 总结 · AI 查链接',
      detail: `正在核查第 ${index + 1}/${chunks.length} 批链接`,
    });
    try {
      const batch = await fetchAiLinkResearchBatch(chunk, settings, signal, onProgress);
      for (const [url, research] of batch.entries()) out.set(url, research);
    } catch (err) {
      if (err?.status === 499 || signal?.aborted) throw err;
      // Local link previews remain attached to the timeline if web-search research fails.
    }
    completed++;
    notifyProgress(onProgress, {
      phase: 'ai_link_research',
      label: 'AI 总结 · AI 查链接',
      detail: `已完成 ${completed}/${chunks.length} 批链接核查`,
    });
  });
  return out;
}

async function fetchAiLinkResearchBatch(urls, settings, signal = null, onProgress = null) {
  throwIfAborted(signal);
  const body = {
    model: settings.llm.long_context_model || settings.llm.model,
    temperature: 0,
    tools: [{ type: 'web_search_preview' }],
    text: {
      format: {
        type: 'json_schema',
        name: 'wx_summary_link_research',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            links: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  url: { type: 'string' },
                  title: { type: 'string' },
                  summary: { type: 'string' },
                  sources: { type: 'array', items: { type: 'string' } },
                  accessed: { type: 'boolean' },
                },
                required: ['url', 'title', 'summary', 'sources', 'accessed'],
              },
            },
          },
          required: ['links'],
        },
      },
    },
    input: [
      '你是链接研究助手。请用可用的联网搜索/打开能力核查下面这些聊天链接。',
      '每个链接都要尽量返回它是做什么的、和页面/仓库/文档的核心用途。不能访问时 summary 写空字符串，accessed=false。',
      '只输出符合 schema 的 JSON；sources 放实际依据 URL，不要编造。',
      '',
      ...urls.map((item, index) => `${index + 1}. ${item}`),
    ].join('\n'),
  };
  const json = await withAiRequestSlot({
    signal,
    onProgress,
    label: 'AI 总结 · 等待 AI 查链接',
    detail: `${urls.length} 个网页链接等待联网核查`,
  }, () => fetchJson(`${settings.llm.base_url}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.llm.api_key}` },
    body,
    timeout_ms: Math.max(30000, Math.min(Number(settings.llm.timeout_ms || 120000), 120000)),
    api_key: settings.llm.api_key,
    signal,
  }));
  const text = extractResponsesText(json);
  if (!text) return new Map();
  const parsed = parseJsonModelText(text);
  const out = new Map();
  for (const item of arrayOf(parsed?.links)) {
    const normalizedUrl = normalizeHttpUrl(item.url);
    if (!normalizedUrl || item.accessed === false || !cleanField(item.summary)) continue;
    out.set(normalizedUrl, {
      title: cleanField(item.title).slice(0, 200),
      summary: cleanField(item.summary).slice(0, 1000),
      sources: Array.isArray(item.sources) ? item.sources.map(cleanField).filter(Boolean).slice(0, 6) : [],
    });
  }
  return out;
}

function chunkArray(items, size) {
  const out = [];
  const limit = Math.max(1, Number(size) || 1);
  for (let i = 0; i < items.length; i += limit) out.push(items.slice(i, i + limit));
  return out;
}

function shouldUseAiLinkResearch(urls, settings, cfg) {
  if (cfg.ai_web_search === false || !Array.isArray(urls) || !urls.length) return false;
  if (settings?.llm?.provider !== 'openai') return false;
  if (!settings.llm.base_url || !settings.llm.api_key || !(settings.llm.long_context_model || settings.llm.model)) return false;
  try {
    const host = new URL(settings.llm.base_url).hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  } catch {
    return false;
  }
  return true;
}

function extractResponsesText(json) {
  if (typeof json?.output_text === 'string') return json.output_text;
  const chunks = [];
  for (const item of arrayOf(json?.output)) {
    for (const part of arrayOf(item?.content)) {
      if (typeof part?.text === 'string') chunks.push(part.text);
      else if (typeof part?.output_text === 'string') chunks.push(part.output_text);
    }
  }
  return chunks.join('\n').trim();
}

async function readLimitedResponse(res, maxBytes) {
  const limit = Math.max(1024, Number(maxBytes || DEFAULT_LINK_PREVIEW.max_bytes));
  if (!res.body?.getReader) {
    const data = Buffer.from(await res.arrayBuffer());
    return data.subarray(0, limit);
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    const remaining = limit - total;
    chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
    total += Math.min(chunk.length, remaining);
    if (chunk.length > remaining) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks);
}

function isTextLikeContent(contentType) {
  return !contentType
    || contentType.startsWith('text/')
    || contentType.includes('html')
    || contentType.includes('json')
    || contentType.includes('xml')
    || contentType.includes('javascript');
}

function looksLikeHtml(contentType, body) {
  return /html|xml/.test(String(contentType || '')) || /<\/?[a-z][\s\S]*>/i.test(body);
}

function normalizeLinkPreview(url, finalUrl, contentType, body, maxChars) {
  const isHtml = looksLikeHtml(contentType, body);
  const title = isHtml ? decodeHtml(extractHtmlTitle(body)) : '';
  const description = isHtml ? decodeHtml(extractMetaDescription(body)) : '';
  const text = isHtml ? htmlToText(body) : String(body || '');
  const excerpt = cleanField(text).slice(0, Math.max(200, Number(maxChars || DEFAULT_LINK_PREVIEW.max_chars_per_link)));
  return {
    url,
    final_url: finalUrl,
    status: 'ok',
    title: cleanField(title).slice(0, 200),
    description: cleanField(description).slice(0, 500),
    excerpt,
    content_type: contentType,
  };
}

async function fetchRelatedLinkPreviews(finalUrl, html, cfg, signal = null) {
  const candidates = extractRelatedLinks(finalUrl, html).slice(0, Math.max(0, Number(cfg.max_related_links || 0)));
  if (!candidates.length) return [];
  const out = [];
  for (const item of candidates) {
    throwIfAborted(signal);
    const controller = new AbortController();
    const unlinkAbort = linkAbortSignal(controller, signal);
    const timer = setTimeout(() => controller.abort(), Math.min(5000, Number(cfg.timeout_ms || DEFAULT_LINK_PREVIEW.timeout_ms)));
    try {
      const res = await fetch(item.url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': 'wx-summary/0.1 link-preview',
          Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.8,*/*;q=0.3',
        },
      });
      const contentType = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const limited = await readLimitedResponse(res, cfg.max_related_bytes || DEFAULT_LINK_PREVIEW.max_related_bytes);
      if (!res.ok || !isTextLikeContent(contentType)) continue;
      const body = new TextDecoder('utf-8', { fatal: false }).decode(limited);
      const preview = normalizeLinkPreview(item.url, res.url || item.url, contentType, body, cfg.max_related_chars || DEFAULT_LINK_PREVIEW.max_related_chars);
      out.push({
        url: preview.final_url || preview.url,
        anchor: item.anchor,
        title: preview.title,
        description: preview.description,
        excerpt: preview.excerpt,
      });
    } catch (err) {
      if (err?.status === 499 || signal?.aborted) throw err;
      // Related pages are optional context; the original link preview remains useful.
    } finally {
      unlinkAbort();
      clearTimeout(timer);
    }
  }
  return out;
}

function extractRelatedLinks(finalUrl, html) {
  let base;
  try {
    base = new URL(finalUrl);
  } catch {
    return [];
  }
  const links = [];
  const seen = new Set();
  const re = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(String(html || '')))) {
    const href = decodeHtml(match[2]);
    const anchor = cleanField(htmlToText(match[3])).slice(0, 120);
    let url;
    try {
      url = new URL(href, base.href);
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(url.protocol)) continue;
    url.hash = '';
    if (url.origin !== base.origin) continue;
    if (url.href === base.href || seen.has(url.href)) continue;
    seen.add(url.href);
    const score = relatedLinkScore(url, anchor);
    if (score <= 0) continue;
    links.push({ url: url.href, anchor, score });
  }
  return links.sort((a, b) => b.score - a.score);
}

function relatedLinkScore(url, anchor) {
  const haystack = `${url.pathname} ${url.search} ${anchor}`.toLowerCase();
  let score = 0;
  for (const word of ['docs', 'doc', 'guide', 'api', 'reference', 'manual', 'readme', 'wiki', 'help', 'start', 'quickstart', 'install', 'pricing', 'release', 'changelog', '文档', '说明', '指南', '帮助', '教程']) {
    if (haystack.includes(word)) score += 4;
  }
  if (anchor && anchor.length <= 60) score += 1;
  if (/\/(?:docs?|guide|api|wiki|help)(?:\/|$)/i.test(url.pathname)) score += 4;
  if (/\.(?:png|jpe?g|gif|webp|zip|pdf|mp4|mp3)$/i.test(url.pathname)) score -= 10;
  if (/login|signup|sign-in|register|account/i.test(haystack)) score -= 4;
  return score;
}

function extractHtmlTitle(html) {
  return String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
}

function extractMetaDescription(html) {
  const text = String(html || '');
  const tag = text.match(/<meta\b[^>]*(?:name|property)=["'](?:description|og:description|twitter:description)["'][^>]*>/i)?.[0]
    || text.match(/<meta\b[^>]*content=["'][^"']+["'][^>]*(?:name|property)=["'](?:description|og:description|twitter:description)["'][^>]*>/i)?.[0]
    || '';
  return tag.match(/\bcontent=(["'])([\s\S]*?)\1/i)?.[2] || '';
}

function htmlToText(html) {
  return decodeHtml(String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|main|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '));
}

function decodeHtml(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (_, name) => named[name.toLowerCase()] || `&${name};`)
    .replace(/\s+/g, ' ')
    .trim();
}

async function callJsonModel({ settings, model, groupName, since, until, messageBundle, mode, signal = null, onProgress = null }) {
  throwIfAborted(signal);
  const messagesText = messageBundle?.text || '';
  const imageCount = messageBundle?.imageCount || 0;
  const audioCount = messageBundle?.audioCount || 0;
  const blocks = (imageCount || audioCount) ? (messageBundle?.blocks || []) : [];
  const mergeMode = mode === 'merge';
  const system = [
    '你是一个微信群公共纪要助手。总结给群内所有成员看，只输出严格 JSON，不要 Markdown，不要解释。',
    'JSON 字段必须包含 headline、topics、todos、links。',
    'headline 不超过 50 个中文字符；topics 每项包含 title、participants、summary、need_followup。',
    '必须结果导向，不要只写“大家讨论了什么/分享了什么/有人说了什么”。headline 要写本时间窗最重要的结论或当前状态。',
    '每个 topics.summary 的第一句必须先写清结果、现状、结论、风险或待确认项；如果聊天没有形成明确结论，第一句要直接说明“未形成结论/仍待确认”，再说明分歧或缺口。',
    'topics.summary 不要以“群内讨论了”“围绕某话题”“成员分享了”“有人提到”等过程句开头；可以写“现状：...”“结果：...”“风险：...”“待确认：...”。',
    'topics.summary 后续再补充关键依据、影响范围和下一步，不要把过程流水账当成总结。优先回答：最后怎么样了、解决了吗、谁需要做什么、还卡在哪里、对群成员有什么用。',
    'todos/links 没有内容时返回空数组。',
    '不要输出面向单个账号的提醒栏目；有人被点名时，只有对全群有公共价值才写进 topics 或 todos，并使用群昵称。',
    'links 每项包含 title、url、summary、from、time；summary 必须说明这个网页链接是干什么的、和聊天上下文有什么关系，不能只重复 URL。',
    'links.summary 也要结果导向：说明这个网页能提供什么结论/入口/证据，以及群里为什么需要它；不要只写“用于讨论某话题”。',
    'links 只允许真实 http(s) 网页链接；不要把图片、视频、音频直链、文件名、截图内容或没有 URL 的媒体内容写进 links。',
    '如果时间线里有“链接打开结果”，那是本地服务实际访问链接后得到的页面标题、描述和正文片段；总结 links 时必须优先基于这些打开结果。',
    '如果链接打开结果里出现 403、404、超时等失败状态，只能表述为“本程序/本地服务打开链接失败”，不要写成“群内反馈访问失败”或“群友访问失败”，除非聊天原文明确有人这么说。',
    '如果消息附带图片或视频关键帧，请结合视觉内容进行判断；如果接口支持音频输入并收到音频块，可以结合音频内容；如果只是文件或未转写语音，只能根据文件名、扩展名、时长和上下文判断，不要假装读取或听过正文。',
    mergeMode ? '当前输入是全量请求失败后的多个分段 JSON 摘要。你正在合并分段摘要，必须综合所有分段；不要因为后段覆盖前段而丢掉链接、待办、参与人、来源时间或需要跟进议题。links/todos/topics 要从各分段去重保留，冲突时合并信息而不是删除。合并时必须把分段里的过程描述改写成全局结果、最终状态、未解决问题和下一步。' : '',
    mergeMode ? '如果某段带有 _fallback_chunk 或 _raw_timeline，表示该分段模型请求返回空内容或异常。你必须把 _raw_timeline 当作该段原始聊天时间线继续纳入总结，保留其中的时间、发送人、文件/链接/媒体元信息；但不能编造未成功识别的图片画面或语音内容。' : '',
  ].join('\n');
  const intro = [
    `群名：${groupName}`,
    `时间窗：${since} ~ ${until}`,
    `任务模式：${mode}`,
    mergeMode ? '输入内容是“分段 N: {...}”形式的中间摘要，不是原始聊天。请保留每个分段里出现过的明确待办、重要网页链接、发送人、时间、图片/文件/语音相关结论和后续跟进点；只做去重、归并和提炼，不得省略独立事项。' : '',
    imageCount ? `多模态消息数：${imageCount} 张图片。下面内容按消息时间顺序排列；图片块紧跟它对应的消息行，请把图片与该行的时间、发送人、前后聊天上下文关联。` : '',
    audioCount ? `音频消息数：${audioCount} 条。若后续内容包含音频块，请尝试听取；若模型接口不支持音频，仍需保留该语音消息的时间、发送人和元信息，不要编造语音内容。` : '',
    messageBundle?.linkPreviewCount ? `链接打开结果：${messageBundle.linkPreviewCount} 个。每个结果都附在对应消息行下方，请结合页面内容、发送时间、发送人和上下文总结链接用途；失败状态只代表本程序访问该网页失败，不代表群内成员反馈。` : '',
    '请按公共群纪要视角提炼真正有用的信息。每个议题先给结论/结果/现状，再给必要背景；没有结论就明确写“未形成结论/仍待确认”。保留明确的待办、重要网页链接及其用途说明、需要跟进的议题。',
  ].filter(Boolean).join('\n');
  const user = [
    intro,
    '',
    messagesText || '（没有消息）',
  ].join('\n');

  let lastError;
  let activeBlocks = blocks;
  let audioRetryUsed = false;
  let mediaEmptyRetryUsed = false;
  let parseRetryUsed = false;
  let parseRepairUsed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    throwIfAborted(signal);
    try {
      const text = settings.llm.provider === 'anthropic'
        ? await callAnthropic({ settings, model, system, user, intro, blocks: activeBlocks, signal, onProgress, mode })
        : await callOpenAI({ settings, model, system, user, intro, blocks: activeBlocks, signal, onProgress, mode });
      try {
        return parseJsonModelText(text);
      } catch (parseError) {
        if (!parseRepairUsed && isJsonParseError(parseError) && parseError.raw_model_text) {
          parseRepairUsed = true;
          const repairedText = await repairJsonModelText({
            settings,
            model,
            rawText: parseError.raw_model_text,
            parseMessage: parseError.message,
            signal,
            onProgress,
          });
          return parseJsonModelText(repairedText);
        }
        throw parseError;
      }
    } catch (e) {
      lastError = e;
      if (audioCount && !audioRetryUsed && activeBlocks.some(block => block.kind === 'audio') && isLikelyUnsupportedAudioError(e)) {
        activeBlocks = withoutAudioBlocksForRetry(activeBlocks);
        audioRetryUsed = true;
        continue;
      }
      if ((imageCount || audioCount) && !mediaEmptyRetryUsed && activeBlocks.some(block => block.kind === 'image' || block.kind === 'audio') && isModelEmptyContentError(e)) {
        activeBlocks = withoutMediaBlocksForEmptyContentRetry(activeBlocks);
        mediaEmptyRetryUsed = true;
        audioRetryUsed = true;
        notifyProgress(onProgress, {
          phase: 'llm_media_retry',
          label: 'AI 总结 · 媒体兜底',
          detail: `任务 ${mode || 'summary'} 带媒体返回空内容，改用文本和媒体元信息重试`,
        });
        continue;
      }
      if (!parseRetryUsed && isJsonParseError(e)) {
        parseRetryUsed = true;
        await sleep(300, signal);
        continue;
      }
      if (!isTransientError(e)) break;
      if (attempt < 2) await sleep(700 * (attempt + 1), signal);
    }
  }
  if ((imageCount || audioCount) && lastError) {
    throw httpError(
      lastError.status || 502,
      `${lastError.message}（该分段包含 ${imageCount} 张图片/视频关键帧、${audioCount} 条音频；为保证总结完整，未丢弃媒体消息元信息。）`,
    );
  }
  throw lastError;
}

async function repairJsonModelText({ settings, model, rawText, parseMessage, signal = null, onProgress = null }) {
  throwIfAborted(signal);
  const limitedRawText = String(rawText || '').slice(0, 120_000);
  const system = [
    '你是 JSON 修复器。只输出一个严格合法的 JSON 对象，不要 Markdown，不要解释。',
    '保留原输出中已经出现的信息，只修复 JSON 语法问题，例如缺逗号、引号、括号、尾逗号、代码块包裹或字符串转义。',
    '不要新增事实，不要扩写总结；无法确定的字段用空字符串或空数组。',
    '顶层必须包含 headline、topics、todos、links。',
    'topics 每项包含 title、participants、summary、need_followup；todos 每项包含 owner、item、deadline；links 每项包含 title、url、summary、from、time。',
  ].join('\n');
  const intro = '修复上一次模型返回的无效 JSON。';
  const user = [
    intro,
    `解析错误：${sanitizeText(parseMessage)}`,
    '',
    '待修复模型输出：',
    limitedRawText || '（空）',
  ].join('\n');
  return settings.llm.provider === 'anthropic'
    ? callAnthropic({ settings, model, system, user, intro, blocks: [], signal, onProgress, mode: 'repair' })
    : callOpenAI({ settings, model, system, user, intro, blocks: [], signal, onProgress, mode: 'repair' });
}

function withoutAudioBlocksForRetry(blocks = []) {
  return blocks
    .filter(block => block.kind !== 'audio')
    .map(block => {
      if (block.kind !== 'text') return block;
      return {
        ...block,
        text: String(block.text || '').replace(
          /（下一块尝试附上这条消息对应的音频\d+；如果模型不支持音频，仍按本行元信息总结）/g,
          '（音频块已被当前模型接口拒绝；仅按本行时间、发送人、文件名、时长等元信息总结，不要假装听过内容）',
        ),
      };
    });
}

function withoutMediaBlocksForEmptyContentRetry(blocks = []) {
  return blocks.map(block => {
    if (block.kind === 'image') {
      return {
        kind: 'text',
        text: `（${block.ref || '图片/视频关键帧'}：AI 端点带媒体请求返回空内容，已改为仅按对应消息行的时间、发送人、文件名、尺寸等元信息和上下文总结；不要编造画面细节。）`,
      };
    }
    if (block.kind === 'audio') {
      return {
        kind: 'text',
        text: `（${block.ref || '音频'}：AI 端点带媒体请求返回空内容，已改为仅按对应消息行的时间、发送人、文件名、时长等元信息和上下文总结；不要编造语音内容。）`,
      };
    }
    if (block.kind !== 'text') return block;
    return {
      ...block,
      text: String(block.text || '')
        .replace(/（下一块就是这条消息对应的图片\d+）/g, '（对应图片块触发模型空响应，已改为仅按元信息和上下文总结，不要编造画面细节）')
        .replace(/（下一块就是这条视频\/文件对应的视频关键帧\d+）/g, '（对应视频关键帧触发模型空响应，已改为仅按元信息和上下文总结，不要编造画面细节）')
        .replace(/（下一块尝试附上这条消息对应的音频\d+；如果模型不支持音频，仍按本行元信息总结）/g, '（对应音频块触发模型空响应，已改为仅按元信息和上下文总结，不要编造语音内容）'),
    };
  });
}

async function callOpenAI({ settings, model, system, user, intro, blocks = [], signal = null, onProgress = null, mode = '' }) {
  const body = {
    model,
    temperature: settings.llm.temperature,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: openAiUserContent(user, intro, blocks) },
    ],
  };
  const json = await withAiRequestSlot({
    signal,
    onProgress,
    label: 'AI 总结 · 等待 AI',
    detail: `任务 ${mode || 'summary'} 等待模型请求`,
  }, () => fetchJson(`${settings.llm.base_url}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.llm.api_key}` },
    body,
    timeout_ms: settings.llm.timeout_ms,
    api_key: settings.llm.api_key,
    signal,
  }));
  const text = json?.choices?.[0]?.message?.content;
  if (!text) throw httpError(502, 'Model returned empty content');
  return text;
}

async function callAnthropic({ settings, model, system, user, intro, blocks = [], signal = null, onProgress = null, mode = '' }) {
  const body = {
    model,
    max_tokens: 4096,
    temperature: settings.llm.temperature,
    system,
    messages: [{ role: 'user', content: anthropicUserContent(user, intro, blocks) }],
  };
  const json = await withAiRequestSlot({
    signal,
    onProgress,
    label: 'AI 总结 · 等待 AI',
    detail: `任务 ${mode || 'summary'} 等待模型请求`,
  }, () => fetchJson(`${settings.llm.base_url}/messages`, {
    method: 'POST',
    headers: { 'x-api-key': settings.llm.api_key, 'anthropic-version': '2023-06-01' },
    body,
    timeout_ms: settings.llm.timeout_ms,
    api_key: settings.llm.api_key,
    signal,
  }));
  const text = Array.isArray(json?.content)
    ? json.content.map(part => part.text || '').join('\n').trim()
    : '';
  if (!text) throw httpError(502, 'Model returned empty content');
  return text;
}

function openAiUserContent(user, intro, blocks) {
  if (!blocks.length) return user;
  return [
    { type: 'text', text: intro },
    ...blocks.map(block => {
      if (block.kind === 'image') {
        return {
          type: 'image_url',
          image_url: { url: block.data_url, detail: 'high' },
        };
      }
      if (block.kind === 'audio') {
        const parsed = parseDataUrl(block.data_url);
        return {
          type: 'input_audio',
          input_audio: {
            data: parsed.base64,
            format: block.format || chatAudioFormatForModel(parsed.mime || block.mime),
          },
        };
      }
      return { type: 'text', text: block.text || '' };
    }),
  ];
}

function anthropicUserContent(user, intro, blocks) {
  if (!blocks.length) return user;
  return [
    { type: 'text', text: intro },
    ...blocks.map(block => {
      if (block.kind === 'audio') return { type: 'text', text: `（${block.ref || '音频'}：当前 Anthropic 兼容接口未直接附加音频，仅保留时间线元信息。）` };
      if (block.kind !== 'image') return { type: 'text', text: block.text || '' };
      const parsed = parseDataUrl(block.data_url);
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: parsed.mime || block.mime || 'image/jpeg',
          data: parsed.base64,
        },
      };
    }),
  ];
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);
  return match ? { mime: match[1], base64: match[2] } : { mime: '', base64: '' };
}

function dataUrlMime(dataUrl) {
  return parseDataUrl(dataUrl).mime;
}

function chatAudioFormatForModel(mime) {
  const value = String(mime || '').toLowerCase();
  if (value.includes('wav')) return 'wav';
  if (value.includes('mpeg') || value.includes('mp3')) return 'mp3';
  return '';
}

async function fetchJson(url, { method, headers = {}, body, timeout_ms, api_key, signal = null }) {
  throwIfAborted(signal);
  const controller = new AbortController();
  const unlinkAbort = linkAbortSignal(controller, signal);
  const timer = setTimeout(() => controller.abort(), timeout_ms || 30000);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) {
      throw httpError(res.status, sanitizeText(providerErrorMessage(json, text || res.statusText), api_key));
    }
    return json ?? {};
  } catch (e) {
    if (e?.name === 'AbortError') {
      if (signal?.aborted) throwIfAborted(signal);
      throw httpError(504, 'LLM request timed out');
    }
    if (e?.status) throw e;
    const detail = [e?.message || String(e), e?.cause?.code, e?.cause?.message]
      .filter(Boolean)
      .join(' / ');
    throw httpError(502, sanitizeText(`LLM 网络请求失败：${detail || 'fetch failed'}`, api_key));
  } finally {
    unlinkAbort();
    clearTimeout(timer);
  }
}

function providerErrorMessage(json, fallback = '') {
  const detail = extractProviderError(json);
  if (detail.message || detail.code) {
    return [detail.code, detail.message].filter(Boolean).join('：');
  }
  if (typeof fallback === 'string') {
    const parsed = parseJsonObject(fallback);
    const parsedDetail = extractProviderError(parsed);
    if (parsedDetail.message || parsedDetail.code) {
      return [parsedDetail.code, parsedDetail.message].filter(Boolean).join('：');
    }
    const htmlDetail = htmlProviderErrorMessage(fallback);
    if (htmlDetail) return htmlDetail;
  }
  return fallback || 'LLM request failed';
}

function htmlProviderErrorMessage(text) {
  const raw = String(text || '');
  if (!/<(?:!doctype|html|head|body|title)\b/i.test(raw)) return '';
  const title = decodeHtml((raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  const code = raw.match(/\bError code\s*(\d{3})\b/i)?.[1]
    || title.match(/\b(\d{3})\b/)?.[1]
    || '';
  const phrase = /bad gateway/i.test(raw) ? 'Bad gateway'
    : /service unavailable/i.test(raw) ? 'Service unavailable'
      : /gateway timeout/i.test(raw) ? 'Gateway timeout'
        : title.replace(/^.*?\|\s*/, '').replace(/\b\d{3}\s*:\s*/g, '').trim();
  const host = title.includes('|') ? title.split('|')[0].trim() : '';
  const provider = host || 'AI 端点/代理';
  return [
    `${provider} 返回${code ? ` ${code}` : ''}${phrase ? ` ${phrase}` : ''}`,
    '这是 AI 端点或代理网关错误，不是微信消息解析失败；请稍后重试，或切换更稳定的 Base URL/模型。',
  ].join('。');
}

function extractProviderError(value) {
  if (!value || typeof value !== 'object') return {};
  if (typeof value.error === 'string') return { message: value.error };
  if (value.error && typeof value.error === 'object') {
    const nested = extractProviderError(value.error);
    return {
      code: nested.code || value.code || value.error.code || value.error.type,
      message: nested.message || value.message || value.error.message,
    };
  }
  return {
    code: value.code || value.type || value.error_code,
    message: value.message || value.error_message || value.msg,
  };
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(String(text || ''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonModelText(text) {
  const raw = String(text || '').trim();
  const candidates = [];
  if (raw) candidates.push(raw);
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));

  let lastError = null;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (e) {
      lastError = e;
    }
  }
  const err = httpError(502, `模型返回的 JSON 无法解析：${lastError?.message || '没有找到 JSON 对象'}`);
  err.name = 'JsonModelParseError';
  err.raw_model_text = raw;
  throw err;
}

function normalizeDigest(raw, meta) {
  const digestId = crypto.randomBytes(16).toString('hex');
  return {
    digest_id: digestId,
    group: meta.groupName,
    since: meta.since,
    until: meta.until,
    message_count: meta.messageCount,
    model: meta.model,
    headline: String(raw?.headline || '本时间窗没有提炼出明确结论。').slice(0, 120),
    mentions_me: [],
    todos: arrayOf(raw?.todos)
      .map(t => ({ owner: cleanField(t.owner), item: cleanField(t.item), deadline: cleanField(t.deadline) }))
      .filter(t => t.item),
    topics: arrayOf(raw?.topics).map(t => ({
      title: cleanField(t.title) || '未命名议题',
      participants: Array.isArray(t.participants) ? t.participants.map(cleanField).filter(Boolean).slice(0, 12) : [],
      summary: cleanField(t.summary),
      need_followup: !!t.need_followup,
    })).filter(t => t.summary || t.title !== '未命名议题'),
    links: arrayOf(raw?.links)
      .map(l => ({
        title: cleanField(l.title),
        url: cleanField(l.url),
        summary: cleanLinkSummary(l.summary || l.description || l.context),
        from: cleanField(l.from),
        time: cleanField(l.time),
      }))
      .filter(l => isAnalyzableWebLinkUrl(l.url)),
    created_at: new Date().toISOString(),
  };
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

function cleanField(value) {
  return String(value || '').trim();
}

function cleanLinkSummary(value) {
  return cleanField(value)
    .replace(/群内反馈访问时返回\s*HTTP?\s*(\d{3})/gi, '本程序打开该链接时返回 HTTP $1')
    .replace(/群内反馈访问时返回\s*(\d{3})/g, '本程序打开该链接时返回 HTTP $1')
    .replace(/群内反馈访问返回\s*HTTP?\s*(\d{3})/gi, '本程序打开该链接时返回 HTTP $1')
    .replace(/群内反馈访问返回\s*(\d{3})/g, '本程序打开该链接时返回 HTTP $1');
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function isTransientError(err) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(err?.status || 0));
}

function isLikelyChunkableFailure(err) {
  const status = Number(err?.status || 0);
  if ([400, 408, 413, 414, 422, 429, 500, 502, 503, 504].includes(status)) return true;
  const message = String(err?.message || '').toLowerCase();
  return /context|token|too large|payload|request entity|timeout|timed out|length|maximum|max|rate|overload|capacity|网络请求失败/.test(message);
}

function isLikelyRecoverableChunkFailure(err) {
  if (isModelEmptyContentError(err)) return true;
  if (isJsonParseError(err)) return true;
  return isLikelyChunkableFailure(err);
}

function isModelEmptyContentError(err) {
  const message = String(err?.message || '').toLowerCase();
  return /empty content|空内容|空响应/.test(message);
}

function isLikelyUnsupportedAudioError(err) {
  const status = Number(err?.status || 0);
  const message = String(err?.message || '').toLowerCase();
  return [400, 415, 422].includes(status)
    || /audio|input_audio|unsupported|invalid.*content|content.*type|format/.test(message);
}

function isJsonParseError(err) {
  const message = String(err?.message || '');
  return err?.name === 'JsonModelParseError'
    || err?.name === 'SyntaxError'
    || !!err?.raw_model_text
    || /JSON|Unexpected token|Unexpected end|unterminated string/i.test(message);
}

function sleep(ms, signal = null) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(httpError(499, '请求已取消'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

export const __llmInternals = {
  formatMessageBundle,
  splitMessages,
  buildDigestChunkPlan,
  openAiUserContent,
  anthropicUserContent,
  chatAudioFormatForModel,
  extractResponsesText,
  extractMessageLinkTargets,
  enrichMessagesWithLinkPreviews,
  isLikelyChunkableFailure,
  isLikelyRecoverableChunkFailure,
  isModelEmptyContentError,
  isLikelyUnsupportedAudioError,
  isJsonParseError,
};
