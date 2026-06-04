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
const MESSAGE_CONTEXT_NEIGHBORS = 2;
const MESSAGE_CONTEXT_SNIPPET_CHARS = 90;
const MESSAGE_CONTEXT_TOTAL_CHARS = 420;
const DEFAULT_AI_REQUEST_CONCURRENCY = 1;
const DEFAULT_CONNECTIVITY_TEST_TIMEOUT_MS = 15000;
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

export async function testLlmConnectivity({ provider, base_url, api_key, model, timeout_ms = DEFAULT_CONNECTIVITY_TEST_TIMEOUT_MS }) {
  const normalizedBase = normalizeBaseUrl(base_url);
  if (!['openai', 'anthropic'].includes(provider)) throw httpError(400, 'Unsupported provider');
  if (!normalizedBase) throw httpError(400, 'Missing base_url');
  if (!api_key) throw httpError(400, 'Missing api_key');
  if (!model) throw httpError(400, 'Missing model');
  const cappedTimeout = Math.max(3000, Math.min(Number(timeout_ms) || DEFAULT_CONNECTIVITY_TEST_TIMEOUT_MS, DEFAULT_CONNECTIVITY_TEST_TIMEOUT_MS));
  const tests = provider === 'openai'
    ? [
        ['chat', () => testOpenAiChat({ base_url: normalizedBase, api_key, model, timeout_ms: cappedTimeout })],
        ['responses', () => testOpenAiResponses({ base_url: normalizedBase, api_key, model, timeout_ms: cappedTimeout })],
      ]
    : [
        ['messages', () => testAnthropicMessages({ base_url: normalizedBase, api_key, model, timeout_ms: cappedTimeout })],
      ];
  const results = await Promise.all(tests.map(([name, action]) => timedCapabilityTest(name, action, api_key)));
  return {
    ok: results.some(item => item.ok),
    provider,
    base_url: normalizedBase,
    model,
    latency_ms: Math.max(...results.map(item => item.latency_ms || 0)),
    capabilities: results,
  };
}

async function timedCapabilityTest(name, action, apiKey) {
  const started = Date.now();
  try {
    const sample = await action();
    return { name, ok: true, latency_ms: Date.now() - started, sample: cleanField(sample).slice(0, 40) };
  } catch (e) {
    return {
      name,
      ok: false,
      latency_ms: Date.now() - started,
      error: sanitizeText(e?.message || String(e), apiKey),
    };
  }
}

async function testOpenAiChat({ base_url, api_key, model, timeout_ms }) {
  const json = await fetchJson(`${base_url}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${api_key}` },
    body: {
      model,
      temperature: 0,
      messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
    },
    timeout_ms,
    api_key,
  });
  const text = json?.choices?.[0]?.message?.content;
  if (!text) throw httpError(502, 'Chat returned empty content');
  return text;
}

async function testOpenAiResponses({ base_url, api_key, model, timeout_ms }) {
  const json = await fetchJson(`${base_url}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${api_key}` },
    body: {
      model,
      temperature: 0,
      input: 'Reply with exactly OK.',
    },
    timeout_ms,
    api_key,
  });
  const text = extractResponsesText(json);
  if (!text) throw httpError(502, 'Responses returned empty content');
  return text;
}

async function testAnthropicMessages({ base_url, api_key, model, timeout_ms }) {
  const json = await fetchJson(`${base_url}/messages`, {
    method: 'POST',
    headers: { 'x-api-key': api_key, 'anthropic-version': '2023-06-01' },
    body: {
      model,
      max_tokens: 16,
      temperature: 0,
      messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
    },
    timeout_ms,
    api_key,
  });
  const text = Array.isArray(json?.content)
    ? json.content.map(part => part.text || '').join('\n').trim()
    : '';
  if (!text) throw httpError(502, 'Messages returned empty content');
  return text;
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

  raw = await ensureDigestVisibleTextChinese({
    raw,
    settings,
    model: llm.long_context_model || model,
    signal,
    onProgress,
  });

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
  const parts = new Array(chunks.length);
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
    parts[index] = part;
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
  try {
    return await callJsonModel({
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
  } catch (err) {
    if (err?.status === 499 || signal?.aborted) throw err;
    if (!isLikelyRecoverableChunkFailure(err)) throw err;
    notifyProgress(onProgress, {
      phase: 'llm_merge_fallback',
      label: 'AI 总结 · 合并兜底',
      detail: '合并分段返回空内容，已改用本地分段结果合并',
    });
    return mergeChunkSummariesLocally({ parts, groupName, since, until, error: err });
  }
}

function mergeChunkSummariesLocally({ parts, groupName, since, until, error }) {
  const validParts = arrayOf(parts).filter(part => part && typeof part === 'object');
  const fallbackParts = validParts.filter(part => part._fallback_chunk);
  const topics = [];
  const seenTopics = new Set();
  for (const part of validParts) {
    for (const topic of arrayOf(part.topics)) {
      const normalized = normalizeTopic(topic);
      if (!normalized.summary && normalized.title === '未命名议题') continue;
      const key = `${normalized.title}\n${normalized.summary.slice(0, 120)}`;
      if (seenTopics.has(key)) continue;
      seenTopics.add(key);
      topics.push(normalized);
    }
  }
  if (fallbackParts.length) {
    const fallbackMessages = fallbackParts
      .map(part => {
        const match = cleanField(part.topics?.[0]?.summary).match(/共\s*(\d+)\s*条消息/);
        return match ? Number(match[1]) : 0;
      })
      .reduce((sum, value) => sum + value, 0);
    const participants = [...new Set(fallbackParts.flatMap(part => arrayOf(part.topics?.[0]?.participants).map(cleanField).filter(Boolean)))].slice(0, 12);
    topics.push({
      title: '部分分段仅按原始时间线兜底',
      category: '仍需确认',
      participants,
      summary: [
        '待确认：部分分段的模型请求持续返回空内容，本地合并已保留这些分段的时间、发送人、文件/链接/媒体元信息。',
        fallbackMessages ? `涉及约 ${fallbackMessages} 条消息。` : '',
        '未被模型成功识别的图片画面或语音内容不会被编造，需要结合原聊天确认。',
      ].filter(Boolean).join(' '),
      need_followup: true,
    });
  }
  if (!topics.length) {
    topics.push({
      title: '分段摘要已完成但合并需确认',
      category: '仍需确认',
      participants: [],
      summary: `待确认：${groupName} 在 ${since} ~ ${until} 的分段摘要已生成，但 AI 合并阶段返回空内容；本地兜底没有提炼出明确议题。错误：${sanitizeText(error?.message || String(error))}`,
      need_followup: true,
    });
  }

  return {
    headline: pickLocalMergeHeadline(validParts) || '本时间窗分段摘要已生成，合并阶段使用本地兜底。',
    highlights: pickLocalMergeHighlights(validParts),
    topics: topics.slice(0, 24),
    todos: dedupeByJson(validParts.flatMap(part => arrayOf(part.todos)).map(normalizeTodo).filter(Boolean)).slice(0, 24),
    links: dedupeLinks(validParts.flatMap(part => arrayOf(part.links))).slice(0, 30),
    quotes: dedupeByJson(validParts.flatMap(part => arrayOf(part.quotes)).map(normalizeQuote).filter(Boolean)).slice(0, 8),
  };
}

function pickLocalMergeHeadline(parts) {
  for (const part of arrayOf(parts)) {
    const headline = cleanField(part.headline);
    if (!headline || /^第\s*\d+\s*段/.test(headline) || /原始时间线待合并|需按原始时间线合并/.test(headline)) continue;
    return headline.slice(0, 120);
  }
  return '';
}

function pickLocalMergeHighlights(parts) {
  const out = [];
  for (const part of arrayOf(parts)) {
    for (const item of arrayOf(part.highlights)) {
      const text = cleanPublicText(item).slice(0, 100);
      if (text && !out.includes(text)) out.push(text);
      if (out.length >= 6) return out;
    }
    for (const topic of arrayOf(part.topics)) {
      const text = firstSentence(cleanPublicText(topic.summary || topic.title)).slice(0, 100);
      if (text && !out.includes(text)) out.push(text);
      if (out.length >= 6) return out;
    }
  }
  return out;
}

function dedupeByJson(items) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function dedupeLinks(links) {
  const out = [];
  const seen = new Set();
  for (const link of links) {
    const url = normalizeHttpUrl(link.url);
    if (!url || seen.has(url) || !isAnalyzableWebLinkUrl(url)) continue;
    seen.add(url);
    out.push({
      title: cleanField(link.title),
      url,
      summary: cleanLinkSummary(link.summary || link.description || link.context || '该网页链接来自分段摘要；合并阶段使用本地兜底保留，请结合对应发送人、时间和上下文判断用途。'),
      from: cleanField(link.from),
      time: cleanField(link.time),
    });
  }
  return out;
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
      category: '仍需确认',
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

  for (let index = 0; index < messages.length; index++) {
    const msg = messages[index];
    const dataUrl = msg.media?.data_url || '';
    const frameDataUrl = msg.media?.frame_data_url || '';
    const audioDataUrl = msg.media?.audio_data_url || '';
    const canAttachImage = msg.type === 'image' && dataUrl;
    const canAttachFrame = (msg.type === 'video' || isVideoLikeMedia(msg.media)) && frameDataUrl;
    const audioFormat = chatAudioFormatForModel(dataUrlMime(audioDataUrl) || msg.media?.mime);
    const canAttachAudio = audioDataUrl && audioFormat && (msg.type === 'voice' || isAudioLikeMedia(msg.media));
    const imageRef = canAttachImage ? `图片${imageCount + 1}` : (canAttachFrame ? `视频关键帧${imageCount + 1}` : '');
    const audioRef = canAttachAudio ? `音频${audioCount + 1}` : '';
    const context = messageNeedsContext(msg) ? buildNearbyChatContext(messages, index) : '';
    const line = formatMessageLine(msg, { imageRef, audioRef, context });
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

function messageNeedsContext(msg = {}) {
  return !!(
    msg.link_previews?.length
    || msg.type === 'image'
    || msg.type === 'video'
    || msg.type === 'voice'
    || msg.type === 'file'
    || isVideoLikeMedia(msg.media)
    || isAudioLikeMedia(msg.media)
  );
}

function formatMessageLine(m, { imageRef = '', audioRef = '', context = '' } = {}) {
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
  const contextSuffix = context ? `；前后聊天上下文=${context}` : '';
  if (m.type === 'file' && m.media?.file_name) {
    return `[${m.time}] ${m.sender}${type}: 文件名=${m.media.file_name}${m.media.size ? `，大小=${m.media.size}B` : ''}${m.media.ext ? `，扩展名=${m.media.ext}` : ''}${suffix}${contextSuffix}`;
  }
  if (m.type === 'quote' && m.media?.quote) {
    const quote = m.media.quote;
    const quoted = [quote.from, quote.content].filter(Boolean).join(': ');
    return `[${m.time}] ${m.sender}${type}: ${m.media.title || m.content}${quoted ? `；引用原文=${quoted}` : ''}${contextSuffix}`;
  }
  return `[${m.time}] ${m.sender}${type}: ${m.content}${suffix}${contextSuffix}${formatLinkPreviewLines(m.link_previews)}`;
}

function buildNearbyChatContext(messages = [], index = 0) {
  const before = collectNearbyContext(messages, index, -1).reverse();
  const after = collectNearbyContext(messages, index, 1);
  const parts = [
    before.length ? `前文：${before.join(' / ')}` : '',
    after.length ? `后文：${after.join(' / ')}` : '',
  ].filter(Boolean);
  return truncateText(parts.join('；'), MESSAGE_CONTEXT_TOTAL_CHARS);
}

function collectNearbyContext(messages = [], index = 0, direction = 1) {
  const out = [];
  for (let step = 1; step <= messages.length && out.length < MESSAGE_CONTEXT_NEIGHBORS; step++) {
    const msg = messages[index + step * direction];
    if (!msg) break;
    const snippet = contextMessageSnippet(msg);
    if (snippet) out.push(snippet);
  }
  return out;
}

function contextMessageSnippet(msg = {}) {
  const sender = cleanField(msg.sender) || '未知发送人';
  const time = cleanField(msg.time);
  const text = cleanContextText(msg.content || mediaContextText(msg.media));
  if (!text) return '';
  return truncateText(`${time ? `${time} ` : ''}${sender}：${text}`, MESSAGE_CONTEXT_SNIPPET_CHARS);
}

function mediaContextText(media = {}) {
  return [
    media?.title,
    media?.desc,
    media?.file_name ? `文件 ${media.file_name}` : '',
    media?.url ? '网页链接' : '',
  ].filter(Boolean).join('，');
}

function cleanContextText(value) {
  return cleanField(value)
    .replace(/https?:\/\/\S+/gi, '[链接]')
    .replace(/data:[^;\s]+;base64,\S+/gi, '[媒体数据]')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateText(value, maxChars) {
  const text = cleanField(value);
  const limit = Math.max(20, Number(maxChars) || 120);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
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
      '每个链接都要尽量返回它是做什么的、和页面/仓库/文档的核心用途。summary 必须使用简体中文；URL、仓库名、产品名可以保留原文。不能访问时 summary 写空字符串，accessed=false。',
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
    'JSON 字段必须包含 headline、highlights、topics、todos、links、quotes。',
    'headline 不超过 50 个中文字符；highlights 返回 3-6 条给只看第一屏的人看的关键结论，每条 15-60 个中文字符，按重要性排序。highlights 要写“发生了什么、结果是什么、还差什么”，不要写“大家讨论了/有人分享了”。',
    'topics 每项包含 title、category、participants、summary、need_followup。category 是你根据当天内容自拟的中文分组标题，4-12 个字，像写给群友看的小标题；不要套固定模板，不要照搬参考日报栏目，不要为了分类而分类。',
    '总结正文必须使用简体中文：headline、topics.summary、todos.item、todos.deadline、links.summary 这些解释性内容要中文表达。URL、代码标识、项目名、模型名、链接原始标题和群成员昵称可以保留原文，但不要输出英文说明句、英文连接词或英文错误原文。',
    '必须结果导向，不要只写“大家讨论了什么/分享了什么/有人说了什么”。headline 要写本时间窗最重要的结论或当前状态。',
    '每个 topics.summary 的第一句必须先写清结果、现状、结论、风险或待确认项；如果聊天没有形成明确结论，第一句要直接说明“未形成结论/仍待确认”，再说明分歧或缺口。',
    'topics.summary 不要以“群内讨论了”“围绕某话题”“成员分享了”“有人提到”等过程句开头；可以写“现状：...”“结果：...”“风险：...”“待确认：...”。',
    'topics.summary 后续再补充关键依据、影响范围和下一步，不要把过程流水账当成总结。优先回答：最后怎么样了、解决了吗、谁需要做什么、还卡在哪里、对群成员有什么用。',
    '不要按消息顺序逐条照抄；相同事项必须合并成一个议题。title 要是“群友读完就知道这条讲什么”的事项标题，不要只写关键词。',
    '如果议题来自链接、图片、视频、语音或文件，summary 必须把内容和发送时间、发送人、前后聊天上下文关联起来：说明它在群聊里被用来证明什么、询问什么、推进什么或引出什么结论。上下文不足时必须写“聊天上下文不足，只能确认...”，不要写成脱离群聊的网页介绍或图片说明。',
    'todos/links 没有内容时返回空数组。',
    'quotes 表示“代表性说法”，从聊天原文中挑 0-5 条对群成员有公共价值、能代表情绪或观点的短句；每项包含 speaker、text、context。不要编造原话，不要摘取隐私或只对单个人有意义的话。',
    'todos 表示“还要处理”的事项，只有明确需要继续确认、处理、验证、报名、付款、交付或由某人/全群继续推进时才写；普通信息点、关键词列表、链接清单不要写进 todos。负责人不明确但确实要跟进时，owner 留空，不要写“待认领”。',
    '不要输出面向单个账号的提醒栏目；有人被点名时，只有对全群有公共价值才写进 topics 或 todos，并使用群昵称。',
    'links 每项包含 title、url、summary、from、time；summary 必须说明这个网页链接是干什么的、和聊天上下文有什么关系，不能只重复 URL。',
    'links.summary 也要结果导向：说明这个网页能提供什么结论/入口/证据，以及群里为什么需要它；不要只写“用于讨论某话题”。',
    'links.summary 必须优先使用“前后聊天上下文”和发链接那条消息来判断用途。格式上先写群聊用途或上下文状态，再补网页本身用途；例如“群里把它作为某配置的参考文档；网页本身是...”。如果前后没有任何可判断用途的消息，写“聊天上下文不足，当前只能确认该链接本身是...”。',
    'links 只允许真实 http(s) 网页链接；不要把图片、视频、音频直链、文件名、截图内容或没有 URL 的媒体内容写进 links。',
    '如果时间线里有“链接打开结果”，那是本地服务实际访问链接后得到的页面标题、描述和正文片段；总结 links 时必须优先基于这些打开结果。',
    '如果链接打开结果里出现 403、404、超时等失败状态，只能表述为“本程序/本地服务打开链接失败”，不要写成“群内反馈访问失败”或“群友访问失败”，除非聊天原文明确有人这么说。',
    '不要把 raw_timeline、_raw_timeline、_fallback_chunk、Model returned empty content、Encrypted content could not be decrypted、error 等内部字段或错误原文写入任何可见字段；如需说明，只能用中文写“部分消息仅保留了时间、发送人和媒体/链接元信息，内容仍待人工确认”。',
    '如果消息附带图片或视频关键帧，请结合视觉内容进行判断；如果接口支持音频输入并收到音频块，可以结合音频内容；如果只是文件或未转写语音，只能根据文件名、扩展名、时长和上下文判断，不要假装读取或听过正文。',
    mergeMode ? '当前输入是全量请求失败后的多个分段 JSON 摘要。你正在合并分段摘要，必须综合所有分段；不要因为后段覆盖前段而丢掉链接、后续处理事项、参与人、来源时间、代表性说法或需要跟进议题。links/todos/topics/quotes 要从各分段去重保留，冲突时合并信息而不是删除。合并时必须把分段里的过程描述改写成全局结果、最终状态、未解决问题和下一步。' : '',
    mergeMode ? '如果某段带有 _fallback_chunk 或 _raw_timeline，表示该分段模型请求返回空内容或异常。你必须把 _raw_timeline 当作该段原始聊天时间线继续纳入总结，保留其中的时间、发送人、文件/链接/媒体元信息；但不能编造未成功识别的图片画面或语音内容。' : '',
  ].join('\n');
  const intro = [
    `群名：${groupName}`,
    `时间窗：${since} ~ ${until}`,
    `任务模式：${mode}`,
    mergeMode ? '输入内容是“分段 N: {...}”形式的中间摘要，不是原始聊天。请保留每个分段里出现过的明确后续处理事项、重要网页链接、发送人、时间、图片/文件/语音相关结论和后续跟进点；只做去重、归并和提炼，不得省略独立事项。' : '',
    imageCount ? `多模态消息数：${imageCount} 张图片。下面内容按消息时间顺序排列；图片块紧跟它对应的消息行，请把图片与该行的时间、发送人、前后聊天上下文关联；不要只描述画面，要说明图片在聊天里承担的含义或待确认点。` : '',
    audioCount ? `音频消息数：${audioCount} 条。若后续内容包含音频块，请尝试听取；若模型接口不支持音频，仍需保留该语音消息的时间、发送人和元信息，不要编造语音内容。` : '',
    messageBundle?.linkPreviewCount ? `链接打开结果：${messageBundle.linkPreviewCount} 个。每个结果都附在对应消息行下方；对应消息行可能带有“前后聊天上下文”。请优先根据前后聊天上下文判断链接为什么被发，再结合页面内容总结用途；失败状态只代表本程序访问该网页失败，不代表群内成员反馈。` : '',
    '请按公共群纪要视角提炼真正有用的信息，写给没爬楼但需要快速跟上的群成员。每个议题先给结论/结果/现状，再给必要背景；没有结论就明确写“未形成结论/仍待确认”。保留明确的后续处理事项、重要网页链接及其用途说明、需要跟进的议题。',
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
    '顶层必须包含 headline、highlights、topics、todos、links、quotes。',
    'topics 每项包含 title、category、participants、summary、need_followup；highlights 为字符串数组；todos 每项包含 owner、item、deadline；links 每项包含 title、url、summary、from、time；quotes 每项包含 speaker、text、context。',
    '修复后的总结正文继续保持简体中文；URL、项目名、链接原始标题、昵称可保留原文；不要保留 raw_timeline、_fallback_chunk、Model returned empty content、error 等内部错误原文。',
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

async function ensureDigestVisibleTextChinese({ raw, settings, model, signal = null, onProgress = null }) {
  if (!digestNeedsChineseRewrite(raw)) return raw;
  notifyProgress(onProgress, {
    phase: 'llm_zh_rewrite',
    label: 'AI 总结 · 中文改写',
    detail: '检测到摘要正文包含英文说明，正在改写为中文',
  });
  try {
    return await rewriteDigestVisibleTextToChinese({ raw, settings, model, signal, onProgress });
  } catch (err) {
    if (err?.status === 499 || signal?.aborted) throw err;
    notifyProgress(onProgress, {
      phase: 'llm_zh_rewrite_fallback',
      label: 'AI 总结 · 中文改写兜底',
      detail: '中文改写失败，改用本地清洗避免内部英文原文进入长图',
    });
    return raw;
  }
}

async function rewriteDigestVisibleTextToChinese({ raw, settings, model, signal = null, onProgress = null }) {
  throwIfAborted(signal);
  const system = [
    '你是微信群公共纪要的中文改写编辑。只输出严格 JSON，不要 Markdown，不要解释。',
    '输入已经是摘要 JSON，不要新增事实，不要删除重要事实，只把面向读者的可见说明改写成自然简体中文。',
    '必须保留顶层结构 headline、highlights、topics、todos、links、quotes。',
    'headline、topics.summary、todos.item、todos.deadline、links.summary 必须尽量使用中文表达。',
    'URL、代码标识、仓库名、产品名、模型名、币种、股票代码、链接原始标题、群昵称可以保留原文；但解释句、结论句、链接用途、错误说明必须中文。',
    '改写 links.summary 时必须保留或补足聊天上下文关系：先说明群里为什么提到它、用它解决/证明/询问什么；如果上下文不足，明确写“聊天上下文不足”。不能只写网页本身介绍。',
    '不要保留 raw_timeline、_raw_timeline、_fallback_chunk、Model returned empty content、Encrypted content could not be decrypted、error 等内部字段或英文错误原文；如确需说明，用中文写“部分消息只保留了时间、发送人和媒体/链接元信息，内容仍待人工确认”。',
    'todos 只保留明确需要继续处理/确认/验证/报名/付款/交付/联系/修复/推进的事项；普通关键词列表、链接清单、信息点不要放入 todos。负责人不明确时 owner 留空。',
    'links.summary 必须说明网页链接是干什么的、和聊天上下文有什么关系；不能只复述 URL 或英文网页描述。',
  ].join('\n');
  const user = [
    '请把下面摘要 JSON 的可见正文改写成中文，保留事实和 JSON schema：',
    JSON.stringify(raw || {}, null, 2),
  ].join('\n');
  const text = settings.llm.provider === 'anthropic'
    ? await callAnthropic({ settings, model, system, user, intro: '中文改写摘要 JSON', blocks: [], signal, onProgress, mode: 'rewrite/zh' })
    : await callOpenAI({ settings, model, system, user, intro: '中文改写摘要 JSON', blocks: [], signal, onProgress, mode: 'rewrite/zh' });
  return parseJsonModelText(text);
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
  const highlights = normalizeHighlights(raw);
  const todos = arrayOf(raw?.todos).map(normalizeTodo).filter(Boolean);
  const topics = dedupeTopics(arrayOf(raw?.topics).map(normalizeTopic).filter(t => t.summary || t.title !== '未命名议题'));
  const links = arrayOf(raw?.links)
    .map(normalizeLink)
    .filter(l => isAnalyzableWebLinkUrl(l.url));
  const quotes = arrayOf(raw?.quotes).map(normalizeQuote).filter(Boolean).slice(0, 8);
  return {
    digest_id: digestId,
    group: meta.groupName,
    since: meta.since,
    until: meta.until,
    message_count: meta.messageCount,
    model: meta.model,
    headline: cleanHeadline(raw?.headline),
    highlights,
    mentions_me: [],
    todos,
    topics,
    links,
    quotes,
    created_at: new Date().toISOString(),
  };
}

function digestNeedsChineseRewrite(raw) {
  const visibleTexts = [
    raw?.headline,
    ...arrayOf(raw?.highlights),
    ...arrayOf(raw?.topics).flatMap(item => [item?.summary]),
    ...arrayOf(raw?.todos).flatMap(item => [item?.item, item?.deadline]),
    ...arrayOf(raw?.links).flatMap(item => [item?.summary || item?.description || item?.context]),
    ...arrayOf(raw?.quotes).flatMap(item => [typeof item === 'string' ? item : item?.text]),
  ].map(cleanField).filter(Boolean);
  return visibleTexts.some(text => isInternalVisibleText(text) || isEnglishHeavyText(text));
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

function cleanField(value) {
  return String(value || '').trim();
}

const INTERNAL_VISIBLE_ERROR_RE = /(?:_?raw_timeline|_fallback_chunk|Model returned empty content|Messages returned empty content|Encrypted content could not be decrypted|分段错误|raw timeline)/i;
const TODO_ACTION_RE = /确认|处理|跟进|补充|整理|报名|提交|付款|测试|验证|联系|修复|发布|更新|迁移|查看|统计|安排|提醒|复盘|决定|对齐|收集|申请|注册|认领|补发|回复|开通|关闭|领取|报销|交付|检查|排查|推进|落实|回访|同步/;
const CJK_RE = /[\u3400-\u9fff]/;
const TODO_PLACEHOLDER_RE = /^(待认领|未指定|无|暂无|不明确|待定|未定|待确认)$/;

function cleanHeadline(value) {
  const text = cleanPublicText(value).slice(0, 120);
  if (!text) return '本时间窗没有提炼出明确结论。';
  if (isEnglishHeavyText(text)) return '本时间窗重点见下方议题。';
  return text;
}

function normalizeTodo(todo = {}) {
  const item = cleanPublicText(todo.item);
  if (!item || isInternalVisibleText(item) || isEnglishHeavyText(item) || looksLikeKeywordOnlyTodo(item)) return null;
  const owner = cleanPublicText(todo.owner);
  const deadline = cleanPublicText(todo.deadline);
  return {
    owner: isEnglishHeavyText(owner) || TODO_PLACEHOLDER_RE.test(owner) ? '' : owner,
    item,
    deadline: isEnglishHeavyText(deadline) || TODO_PLACEHOLDER_RE.test(deadline) ? '' : deadline,
  };
}

function normalizeHighlights(raw = {}) {
  const fromModel = arrayOf(raw?.highlights)
    .map(item => cleanPublicSummary(item, ''))
    .filter(Boolean);
  const fallback = fromModel.length >= 3 ? [] : [
    cleanHeadline(raw?.headline),
    ...arrayOf(raw?.topics).map(topic => firstSentence(cleanPublicSummary(topic?.summary || topic?.title, ''))),
  ].filter(Boolean);
  const out = [];
  for (const text of [...fromModel, ...fallback]) {
    const normalized = text.slice(0, 120);
    if (normalized && !out.includes(normalized) && !isEnglishHeavyText(normalized)) out.push(normalized);
    if (out.length >= 6) break;
  }
  return out;
}

function normalizeTopic(topic = {}) {
  if (isInternalVisibleText(`${topic.title || ''} ${topic.summary || ''}`)) return publicFallbackTopic();
  const summary = cleanPublicSummary(
    topic.summary,
    '该议题包含较多英文说明，已保留标题和参与人；具体结论请结合原聊天确认。',
  );
  return {
    title: cleanPublicTopicTitle(topic.title) || '未命名议题',
    category: normalizeTopicCategory(topic.category, topic),
    participants: Array.isArray(topic.participants) ? topic.participants.map(cleanField).filter(Boolean).slice(0, 12) : [],
    summary,
    need_followup: !!topic.need_followup,
  };
}

function normalizeTopicCategory(value, topic = {}) {
  const text = cleanField(value);
  if (text && !isInternalVisibleText(text) && text.length <= 16) return text;
  const haystack = `${topic.title || ''} ${topic.summary || ''}`.toLowerCase();
  if (/确认|跟进|修复|处理|任务|目标|goal|迁移|发布|上线|测试|排查|付款|领取|结果|待确认/.test(haystack)) return '仍需确认';
  if (/github|文档|教程|链接|仓库|资料|入口|官网|下载/.test(haystack)) return '资料依据';
  if (/观点|理念|趋势|行业|能力|效率|未来|职业|工作流|认知|思考|争议|看法/.test(haystack)) return '观点判断';
  return '重点事项';
}

function normalizeQuote(value = {}) {
  if (typeof value === 'string') {
    const text = cleanPublicText(value);
    return text && !isInternalVisibleText(text) ? { speaker: '', text: text.slice(0, 160), context: '' } : null;
  }
  const text = cleanPublicText(value.text || value.quote || value.content);
  if (!text || isInternalVisibleText(text) || isEnglishHeavyText(text)) return null;
  return {
    speaker: cleanField(value.speaker || value.from || value.sender),
    text: text.slice(0, 180),
    context: cleanPublicText(value.context || value.reason || '').slice(0, 120),
  };
}

function normalizeLink(link = {}) {
  const url = cleanField(link.url);
  const summary = ensureLinkSummaryHasContext(cleanLinkSummary(link.summary || link.description || link.context));
  const title = cleanPublicLinkTitle(link.title) || '网页链接';
  return {
    title,
    url,
    summary,
    from: cleanField(link.from),
    time: cleanField(link.time),
  };
}

function ensureLinkSummaryHasContext(summary) {
  const text = cleanField(summary);
  if (!text) return '';
  if (hasChatContextSignal(text) || /^本程序打开该链接时返回/.test(text)) return text;
  if (/^聊天上下文不足/.test(text)) return text;
  return `聊天上下文不足，当前只能确认：${text}`;
}

function hasChatContextSignal(value) {
  return /群里|群聊|聊天|上下文|前文|后文|发来|发出|发送|发这个|发该|贴出|贴了|提到|询问|回复|讨论|针对|回应|延续|承接|前面|后面/.test(String(value || ''));
}

function publicFallbackTopic() {
  return {
    title: '部分消息仍待人工确认',
    category: '仍需确认',
    participants: [],
    summary: '部分分段的模型请求未返回可用内容，系统只保留了这些消息的时间、发送人、文件、链接和媒体元信息；未识别出的图片画面或语音内容需要结合原聊天确认。',
    need_followup: true,
  };
}

function dedupeTopics(items) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const key = `${item.title}\n${item.summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function cleanPublicText(value) {
  return cleanField(value)
    .replace(/_raw_timeline/gi, '原始时间线')
    .replace(/raw_timeline/gi, '原始时间线')
    .replace(/_fallback_chunk/gi, '分段兜底')
    .replace(/Model returned empty content/gi, '模型未返回可用内容')
    .replace(/Messages returned empty content/gi, '模型未返回可用内容')
    .replace(/Encrypted content could not be decrypted or parsed/gi, '部分加密消息未能解密或解析')
    .replace(/Encrypted content could not be decrypted/gi, '部分加密消息未能解密')
    .replace(/\berror\b/gi, '错误')
    .replace(/\bby\b/g, '发送人')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstSentence(value) {
  const text = cleanField(value);
  if (!text) return '';
  const match = text.match(/^(.{8,90}?[。！？；;]|.{8,90})(?:\s|$)/);
  return cleanField(match?.[1] || text.slice(0, 90));
}

function cleanPublicTopicTitle(value) {
  const text = cleanPublicText(value);
  if (!text) return '';
  if (isInternalVisibleText(text)) return '';
  return text;
}

function cleanPublicLinkTitle(value) {
  const text = cleanField(value);
  if (!text || isInternalVisibleText(text)) return '';
  return text;
}

function cleanPublicSummary(value, fallback) {
  const text = cleanPublicText(value);
  if (!text) return '';
  if (isInternalVisibleText(text)) return fallback;
  if (isEnglishHeavyText(text)) return fallback;
  return text;
}

function isInternalVisibleText(value) {
  return INTERNAL_VISIBLE_ERROR_RE.test(String(value || ''));
}

function looksLikeKeywordOnlyTodo(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  if (TODO_ACTION_RE.test(text)) return false;
  const separatorCount = (text.match(/[|/／,，、]/g) || []).length;
  return separatorCount >= 2 && (!CJK_RE.test(text) || !TODO_ACTION_RE.test(text));
}

function isEnglishHeavyText(value) {
  const text = cleanField(value).replace(/https?:\/\/\S+/gi, '').replace(/[0-9\s._:/@#?=&%+\-()|[\]]/g, '');
  if (text.length < 6) return false;
  const asciiLetters = (text.match(/[A-Za-z]/g) || []).length;
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
  return asciiLetters >= 6 && asciiLetters > cjk * 2;
}

function cleanLinkSummary(value) {
  const text = cleanPublicText(value)
    .replace(/群内反馈访问时返回\s*HTTP?\s*(\d{3})/gi, '本程序打开该链接时返回 HTTP $1')
    .replace(/群内反馈访问时返回\s*(\d{3})/g, '本程序打开该链接时返回 HTTP $1')
    .replace(/群内反馈访问返回\s*HTTP?\s*(\d{3})/gi, '本程序打开该链接时返回 HTTP $1')
    .replace(/群内反馈访问返回\s*(\d{3})/g, '本程序打开该链接时返回 HTTP $1');
  const statusOnly = text.match(/^HTTP?\s*(\d{3})$/i) || text.match(/^(\d{3})$/);
  if (statusOnly) return `本程序打开该链接时返回 ${statusOnly[1]}，未能提取页面内容。`;
  if (isEnglishHeavyText(text)) return '该网页链接已保留，但当前没有可靠中文摘要；请结合发送人、时间和聊天上下文判断用途。';
  return text;
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
