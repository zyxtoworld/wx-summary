import crypto from 'node:crypto';
import net from 'node:net';
import { normalizeBaseUrl, rememberModels } from '../config/settings.js';

const DEFAULT_FALLBACK_MAX_MESSAGES_PER_CALL = 800;
const DEFAULT_FALLBACK_MAX_INPUT_CHARS = 60_000;
const DEFAULT_MAX_IMAGE_DATA_URL_CHARS_PER_CALL = 300_000;
const MAX_IMAGE_DATA_URL_CHARS_PER_CALL = 2 * 1024 * 1024;
const ADAPTIVE_CHUNK_MAX_MESSAGES = 450;
const ADAPTIVE_CHUNK_MAX_INPUT_CHARS = 80_000;
const DEFAULT_DIGEST_CHUNK_CONCURRENCY = 2;
const AI_LINK_RESEARCH_URLS_PER_CALL = 8;
const DEFAULT_LINK_RESEARCH_CONCURRENCY = 2;
const MESSAGE_CONTEXT_NEIGHBORS = 2;
const MESSAGE_CONTEXT_SNIPPET_CHARS = 90;
const MESSAGE_CONTEXT_TOTAL_CHARS = 420;
const DEFAULT_AI_REQUEST_CONCURRENCY = 2;
const DEFAULT_CONNECTIVITY_TEST_TIMEOUT_MS = 15000;
const CHUNK_RECOVERY_MAX_DEPTH = 3;
const MERGE_PARTS_PER_CALL = 10;
const MERGE_RECOVERY_MAX_DEPTH = 2;
const DEFAULT_LINK_PREVIEW = {
  enabled: true,
  ai_web_search: true,
  max_links: 0,
  allow_private_networks: false,
  timeout_ms: 8000,
  max_bytes: 256 * 1024,
  max_chars_per_link: 2000,
  max_related_links: 3,
  max_related_bytes: 96 * 1024,
  max_related_chars: 800,
};
const ATTACHMENT_DATA_KEYS = new Set(['data_url', 'frame_data_url', 'audio_data_url']);
let ACTIVE_AI_REQUESTS = 0;
let CONFIGURED_AI_REQUEST_CONCURRENCY = DEFAULT_AI_REQUEST_CONCURRENCY;
const AI_WAIT_QUEUE = [];
const AI_WEB_SEARCH_CAPABILITY_CACHE = new Map();

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

async function withAiRequestSlot({ signal = null, onProgress = null, label = 'AI 总结 · 等待 AI', detail = '等待 AI 队列空闲', limit = CONFIGURED_AI_REQUEST_CONCURRENCY } = {}, action) {
  const release = await acquireAiRequestSlot({ signal, onProgress, label, detail, limit });
  try {
    notifyProgress(onProgress, {
      phase: 'ai_request',
      label: label.includes('等待') ? label.replace('等待', '请求') : label,
      detail: detail
        .replace('等待模型请求', '正在请求模型')
        .replace('等待 AI 队列空闲', '已获得 AI 队列名额'),
    });
    return await action();
  } finally {
    release();
  }
}

function normalizedAiRequestConcurrency(value = DEFAULT_AI_REQUEST_CONCURRENCY) {
  const raw = Number(value);
  return Math.max(1, Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_AI_REQUEST_CONCURRENCY);
}

function aiRequestConcurrency(value = CONFIGURED_AI_REQUEST_CONCURRENCY) {
  const env = Number(process.env.WX_SUMMARY_AI_CONCURRENCY || 0);
  if (Number.isFinite(env) && env > 0) return normalizedAiRequestConcurrency(env);
  return normalizedAiRequestConcurrency(value);
}

function configureAiRequestConcurrency(settings = {}) {
  CONFIGURED_AI_REQUEST_CONCURRENCY = normalizedAiRequestConcurrency(settings?.llm?.ai_concurrency);
  drainAiRequestQueue();
}

function acquireAiRequestSlot({ signal = null, onProgress = null, label = 'AI 总结 · 等待 AI', detail = '等待 AI 队列空闲', limit = CONFIGURED_AI_REQUEST_CONCURRENCY } = {}) {
  throwIfAborted(signal);
  const requestLimit = aiRequestConcurrency(limit);
  if (ACTIVE_AI_REQUESTS < requestLimit) {
    ACTIVE_AI_REQUESTS++;
    return Promise.resolve(releaseAiRequestSlot);
  }
  notifyProgress(onProgress, {
    phase: 'ai_queue',
    label,
    detail: `${detail} · 前面 ${AI_WAIT_QUEUE.length + ACTIVE_AI_REQUESTS} 个 AI 请求`,
  });
  return new Promise((resolve, reject) => {
    const item = { resolve, reject, signal, limit: requestLimit, onAbort: null };
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
  while (AI_WAIT_QUEUE.length) {
    const index = AI_WAIT_QUEUE.findIndex(item => ACTIVE_AI_REQUESTS < aiRequestConcurrency(item.limit));
    if (index < 0) return;
    const item = AI_WAIT_QUEUE.splice(index, 1)[0];
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

export async function listModels({ provider, base_url, api_key, timeout_ms = 30000, persist = false }) {
  const normalizedBase = normalizeBaseUrl(base_url);
  if (!['openai', 'anthropic'].includes(provider)) throw httpError(400, 'Unsupported provider');
  if (!normalizedBase) throw httpError(400, 'Missing base_url');
  if (!api_key) throw httpError(400, 'Missing api_key');

  const headers = provider === 'openai'
    ? { Authorization: `Bearer ${api_key}` }
    : { 'x-api-key': api_key, 'anthropic-version': '2023-06-01' };
  const json = await fetchJson(`${normalizedBase}/models`, { method: 'GET', headers, timeout_ms, api_key });
  const models = normalizeModelList(json);
  if (persist) await rememberModels({ provider, base_url: normalizedBase, models }).catch(() => {});
  return { ok: true, models };
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
        ['responses_web_search', () => testOpenAiResponsesWebSearch({ base_url: normalizedBase, api_key, model, timeout_ms: cappedTimeout })],
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
    checked_at: new Date().toISOString(),
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
  const choice = json?.choices?.[0] || {};
  const finishReason = String(choice.finish_reason || '').toLowerCase();
  if (finishReason === 'length' || finishReason === 'max_tokens') {
    throw httpError(502, 'Model output was truncated by token limit');
  }
  const text = choice.message?.content;
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

async function testOpenAiResponsesWebSearch({ base_url, api_key, model, timeout_ms }) {
  const json = await fetchJson(`${base_url}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${api_key}` },
    body: {
      model,
      temperature: 0,
      tools: [{ type: 'web_search_preview' }],
      input: '请使用可用的网页搜索/打开工具查看 https://example.com/ ，用一句简体中文回答它是什么页面。无法访问也要用中文说明。',
    },
    timeout_ms,
    api_key,
  });
  const text = extractResponsesText(json);
  if (!text) throw httpError(502, 'Responses web_search returned empty content');
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
  configureAiRequestConcurrency(settings);
  const sourceMessages = Array.isArray(messages) ? messages : [];
  if (!sourceMessages.length) throw httpError(400, '所选时间范围内没有可总结的消息，请换一个时间范围或群聊。');
  const llm = settings.llm;
  const apiKey = llm.api_key;
  if (!apiKey) throw httpError(400, 'API key is not configured');
  if (!llm.base_url) throw httpError(400, 'Base URL is not configured');
  const model = llm.model || llm.available_models?.[0]?.id;
  if (!model) throw httpError(400, 'Model is not configured');

  notifyProgress(onProgress, {
    phase: 'prepare',
    label: 'AI 总结 · 准备输入',
    detail: `${sourceMessages.length} 条消息`,
  });
  const normalized = sourceMessages.map(m => redactStructuredValue(m, settings.privacy));
  const enriched = await enrichMessagesWithLinkPreviews(normalized, settings.link_preview, settings, signal, onProgress);
  const linkPreviewStatus = enriched.__link_preview_status || null;
  const linkPreviewStatusByUrl = enriched.__link_preview_by_url || new Map();
  const linkPolicy = { allow_private_networks: linkPreviewAllowsPrivateNetworks(settings.link_preview) };
  throwIfAborted(signal);
  notifyProgress(onProgress, {
    phase: 'prepare_context',
    label: 'AI 总结 · 整理上下文',
    detail: [
      `${enriched.length} 条消息`,
      linkPreviewStatus ? linkPreviewProgressDetail(linkPreviewStatus) : '',
    ].filter(Boolean).join(' · '),
  });
  const contextualMessages = attachGlobalNearbyContexts(enriched);
  const chunkableMessages = prepareMessagesForChunking(contextualMessages, llm);
  let raw;
  try {
    notifyProgress(onProgress, {
      phase: 'llm_full',
      label: 'AI 总结 · 全量请求',
      detail: `${sourceMessages.length} 条消息一次发送`,
    });
    raw = await callJsonModel({
      settings,
      model,
      groupName,
      since,
      until,
      messageBundle: formatMessageBundle(contextualMessages),
      mode: 'final/full',
      signal,
      onProgress,
    });
  } catch (firstError) {
    const limits = digestChunkLimits(llm);
    const chunks = splitMessages(chunkableMessages, limits.maxMessages, limits.maxChars, limits.maxMediaChars);
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

  raw = await ensureDigestVisibleTextChinese({
    raw,
    settings,
    model: llm.long_context_model || model,
    signal,
    onProgress,
  });
  raw = await ensureDigestHumanGroupChatStyle({
    raw,
    settings,
    model: llm.long_context_model || model,
    signal,
    onProgress,
  });
  notifyProgress(onProgress, {
    phase: 'llm_quality',
    label: 'AI 总结 · 成稿质检',
    detail: '检查空摘要、兜底痕迹、语言和链接字段',
  });
  assertDigestPublishable(raw, { messageCount: sourceMessages.length, ...linkPolicy });

  const digest = normalizeDigest(raw, {
    groupName,
    since,
    until,
    messageCount: sourceMessages.length,
    model,
    linkPreviewCount: linkPreviewStatus?.succeeded || enriched.reduce((n, msg) => n + (msg.link_previews?.length || 0), 0),
    link_status: linkPreviewStatus,
    linkPreviewStatusByUrl,
    ...linkPolicy,
  });
  notifyProgress(onProgress, {
    phase: 'llm_ready',
    label: 'AI 总结 · 摘要结构已完成',
    detail: [
      `${digest.topics?.length || 0} 条主线`,
      `${digest.links?.length || 0} 个链接`,
      digest.quotes?.length ? `${digest.quotes.length} 条金句` : '',
      digest.todos?.length ? `${digest.todos.length} 个后续关注` : '',
    ].filter(Boolean).join(' · '),
  });
  return digest;
}

async function summarizeMessageChunks({ settings, model, groupName, since, until, chunks, signal, onProgress }) {
  const concurrency = digestChunkConcurrency(settings);
  const parts = new Array(chunks.length);
  let completed = 0;
  notifyProgress(onProgress, {
    phase: 'llm_chunks',
    label: 'AI 总结 · 分段总结',
    detail: `${chunks.length} 段 · 并发 ${concurrency} 路`,
  });
  const mediaRetryState = createMediaRetryState();
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
      mediaRetryState,
    });
    parts[index] = part;
    completed++;
    notifyProgress(onProgress, {
      phase: 'llm_chunk',
      label: 'AI 总结 · 分段总结',
      detail: `已完成 ${completed}/${chunks.length} 段 · 并发 ${concurrency} 路`,
    });
  });
  const finalParts = await recoverFallbackChunkSummaries({
    settings,
    model,
    groupName,
    since,
    until,
    chunks,
    parts,
    signal,
    onProgress,
    mediaRetryState,
  });
  return mergeDigestParts({
    settings,
    model: settings.llm.long_context_model || model,
    groupName,
    since,
    until,
    parts: finalParts,
    signal,
    onProgress,
    depth: 0,
  });
}

async function mergeDigestParts({ settings, model, groupName, since, until, parts, signal, onProgress, depth = 0 }) {
  const finalParts = arrayOf(parts).filter(Boolean);
  const summaries = finalParts.map((part, index) => `分段 ${index + 1}${part?._fallback_chunk ? '（原始时间线兜底）' : ''}: ${JSON.stringify(part)}`);
  notifyProgress(onProgress, {
    phase: 'llm_merge',
    label: 'AI 总结 · 合并分段',
    detail: depth ? `${finalParts.length} 段中间摘要继续合并` : `${finalParts.length} 段摘要合并为群纪要`,
  });
  try {
    return await callJsonModel({
      settings,
      model,
      groupName,
      since,
      until,
      messageBundle: { text: summaries.join('\n\n'), images: [] },
      mode: depth ? `merge/${depth}` : 'merge',
      signal,
      onProgress,
    });
  } catch (err) {
    if (err?.status === 499 || signal?.aborted) throw err;
    if (!isLikelyRecoverableChunkFailure(err)) throw err;
    if (finalParts.length > MERGE_PARTS_PER_CALL && depth < MERGE_RECOVERY_MAX_DEPTH) {
      const groups = chunkArray(finalParts, MERGE_PARTS_PER_CALL);
      notifyProgress(onProgress, {
        phase: 'llm_merge_recovery',
        label: 'AI 总结 · 合并分组重试',
        detail: `最终合并返回异常，改为 ${groups.length} 组小合并`,
      });
      const groupParts = [];
      for (let index = 0; index < groups.length; index++) {
        throwIfAborted(signal);
        notifyProgress(onProgress, {
          phase: 'llm_merge_recovery',
          label: 'AI 总结 · 合并分组重试',
          detail: `正在合并第 ${index + 1}/${groups.length} 组`,
        });
        groupParts.push(await mergeDigestParts({
          settings,
          model,
          groupName,
          since,
          until,
          parts: groups[index],
          signal,
          onProgress,
          depth: depth + 1,
        }));
      }
      return mergeDigestParts({
        settings,
        model,
        groupName,
        since,
        until,
        parts: groupParts,
        signal,
        onProgress,
        depth: depth + 1,
      });
    }
    notifyProgress(onProgress, {
      phase: 'llm_merge_fallback',
      label: 'AI 总结 · 合并兜底',
      detail: '合并分段返回空内容，已改用本地分段结果合并',
    });
    return mergeChunkSummariesLocally({ parts: finalParts, groupName, since, until, error: err, allowFallbackParts: true });
  }
}

async function recoverFallbackChunkSummaries({ settings, model, groupName, since, until, chunks, parts, signal, onProgress, mediaRetryState }) {
  const fallbackIndexes = parts
    .map((part, index) => (part?._fallback_chunk ? index : -1))
    .filter(index => index >= 0);
  if (!fallbackIndexes.length) return parts.filter(Boolean);

  notifyProgress(onProgress, {
    phase: 'llm_chunk_recovery',
    label: 'AI 总结 · 失败段重试',
    detail: `${fallbackIndexes.length}/${parts.length} 段未返回可用摘要，正在拆小重试`,
  });

  const out = [];
  let recovered = 0;
  for (let index = 0; index < parts.length; index++) {
    throwIfAborted(signal);
    const part = parts[index];
    if (!part?._fallback_chunk) {
      if (part) out.push(part);
      continue;
    }
    const recoveredParts = await recoverFallbackChunkPart({
      settings,
      model,
      groupName,
      since,
      until,
      chunk: chunks[index] || [],
      fallback: part,
      originalIndex: index,
      originalTotal: chunks.length,
      signal,
      onProgress,
      mediaRetryState,
      depth: 0,
    });
    if (!recoveredParts.some(item => item?._fallback_chunk)) recovered++;
    out.push(...recoveredParts.filter(Boolean));
  }

  notifyProgress(onProgress, {
    phase: 'llm_chunk_recovery',
    label: 'AI 总结 · 失败段重试',
    detail: `已补回 ${recovered}/${fallbackIndexes.length} 个失败分段`,
  });
  return out;
}

async function recoverFallbackChunkPart({ settings, model, groupName, since, until, chunk, fallback, originalIndex, originalTotal, signal, onProgress, mediaRetryState, depth }) {
  if (depth >= CHUNK_RECOVERY_MAX_DEPTH || !Array.isArray(chunk) || chunk.length <= 1) return [fallback];
  const subChunks = splitChunkForRecovery(chunk, settings?.llm, depth);
  if (subChunks.length <= 1) return [fallback];

  notifyProgress(onProgress, {
    phase: 'llm_chunk_recovery',
    label: 'AI 总结 · 失败段重试',
    detail: `第 ${originalIndex + 1}/${originalTotal} 段拆成 ${subChunks.length} 小段重试`,
  });

  const recoveredGroups = new Array(subChunks.length);
  await mapWithConcurrency(subChunks, Math.min(2, subChunks.length), async (subChunk, subIndex) => {
    throwIfAborted(signal);
    const part = await summarizeChunkWithFallback({
      settings,
      model,
      groupName,
      since,
      until,
      chunk: subChunk,
      index: subIndex,
      total: subChunks.length,
      signal,
      onProgress,
      mediaRetryState,
    });
    recoveredGroups[subIndex] = part?._fallback_chunk
      ? await recoverFallbackChunkPart({
        settings,
        model,
        groupName,
        since,
        until,
        chunk: subChunk,
        fallback: part,
        originalIndex,
        originalTotal,
        signal,
        onProgress,
        mediaRetryState,
        depth: depth + 1,
      })
      : [part];
  });

  const recoveredParts = recoveredGroups.flat().filter(Boolean);
  return recoveredParts.length ? recoveredParts : [fallback];
}

function splitChunkForRecovery(chunk, llm = {}, depth = 0) {
  if (!Array.isArray(chunk) || chunk.length <= 1) return [chunk];
  const limits = digestChunkLimits(llm);
  const factor = Math.min(8, 2 ** (Math.max(0, Number(depth) || 0) + 1));
  const targetParts = chunk.length >= 80 ? 4 : 2;
  const targetSize = Math.max(1, Math.ceil(chunk.length / targetParts));
  const maxMessages = Math.max(1, Math.min(targetSize, Math.floor(limits.maxMessages / factor) || 1));
  const maxChars = Math.max(1000, Math.floor(limits.maxChars / factor));
  const maxMediaChars = Math.max(100000, Math.floor(limits.maxMediaChars / factor));
  const costChunks = splitMessages(chunk, maxMessages, maxChars, maxMediaChars);
  if (costChunks.length > 1) return costChunks;

  const size = targetSize;
  const out = [];
  for (let i = 0; i < chunk.length; i += size) out.push(chunk.slice(i, i + size));
  return out;
}

function mergeChunkSummariesLocally({ parts, groupName, since, until, error, allowFallbackParts = false }) {
  const validParts = arrayOf(parts).filter(part => part && typeof part === 'object');
  const fallbackParts = validParts.filter(part => part._fallback_chunk);
  if (fallbackParts.length && !allowFallbackParts) {
    throw httpError(
      502,
      `AI 分段有 ${fallbackParts.length}/${Math.max(1, validParts.length)} 段未返回可用摘要，合并阶段也未能补回；为避免生成不完整或误导性的群总结，本次未保存长图。可稍后重试，或缩短时间范围再生成。`,
    );
  }
  if (fallbackParts.length && allowFallbackParts) {
    const fallbackLimit = Math.max(1, Math.floor(validParts.length * 0.08));
    const totalWeight = validParts.reduce((n, part) => n + chunkImportanceOfPart(part), 0);
    const fallbackWeight = fallbackParts.reduce((n, part) => n + chunkImportanceOfPart(part), 0);
    const fallbackWeightRatio = totalWeight ? fallbackWeight / totalWeight : 1;
    const fallbackLinkCount = fallbackParts.reduce((n, part) => n + arrayOf(part.links).length, 0);
    const fallbackMediaCount = fallbackParts.reduce((n, part) => {
      const meta = part?._chunk_importance || part?._fallback_weight || {};
      return n + Number(meta.image_count || 0) + Number(meta.audio_count || 0);
    }, 0);
    if (
      fallbackParts.length > fallbackLimit
      || fallbackParts.length === validParts.length
      || fallbackWeightRatio > 0.12
      || fallbackLinkCount > 0
      || fallbackMediaCount > 0
    ) {
      throw httpError(
        502,
        `AI 分段仍有 ${fallbackParts.length}/${Math.max(1, validParts.length)} 段只剩原始时间线兜底，约占输入权重 ${Math.round(fallbackWeightRatio * 100)}%${fallbackLinkCount ? `，含 ${fallbackLinkCount} 个链接` : ''}${fallbackMediaCount ? `，含 ${fallbackMediaCount} 条媒体` : ''}；为避免生成不完整或误导性的群总结，本次未保存。可稍后重试，或缩短时间范围再生成。`,
      );
    }
  }
  const topics = [];
  const seenTopics = new Set();
  for (const part of validParts) {
    if (part._fallback_chunk) continue;
    for (const topic of arrayOf(part.topics)) {
      const normalized = normalizeTopic(topic);
      if (!normalized.summary && normalized.title === '未命名议题') continue;
      const key = `${normalized.title}\n${normalized.summary.slice(0, 120)}`;
      if (seenTopics.has(key)) continue;
      seenTopics.add(key);
      topics.push(normalized);
    }
  }
  for (const part of fallbackParts) {
    const fallbackTopic = fallbackTopicFromPart(part);
    if (!fallbackTopic) continue;
    const key = `${fallbackTopic.title}\n${fallbackTopic.summary.slice(0, 120)}`;
    if (seenTopics.has(key)) continue;
    seenTopics.add(key);
    topics.push(fallbackTopic);
  }
  const todos = dedupeByJson(validParts.flatMap(part => arrayOf(part.todos)).map(normalizeTodo).filter(Boolean)).slice(0, 24);
  const links = publicDigestLinks(dedupeLinks(validParts.flatMap(part => arrayOf(part.links))));
  const quotes = dedupeByJson(validParts.flatMap(part => arrayOf(part.quotes)).map(normalizeQuote).filter(Boolean)).slice(0, 8);
  if (!topics.length && !todos.length && !links.length && !quotes.length) {
    throw httpError(
      502,
      `AI 分段摘要已完成，但合并阶段返回空内容，本地合并也没有提炼出可用事项；为避免生成空摘要，本次未保存长图。错误：${sanitizeText(error?.message || String(error))}`,
    );
  }

  return {
    headline: pickLocalMergeHeadline(validParts) || '本时间窗已按分段摘要整理，重点见下方。',
    highlights: pickLocalMergeHighlights(validParts),
    topics: topics.slice(0, 24),
    todos,
    links,
    quotes,
  };
}

function fallbackTopicFromPart(part = {}) {
  const rawTimeline = cleanFallbackTimeline(part._raw_timeline);
  const sourceTopic = arrayOf(part.topics)[0] || {};
  const participants = arrayOf(sourceTopic.participants).map(cleanField).filter(Boolean).slice(0, 12);
  const scope = cleanField(sourceTopic.summary).match(/范围：([^。]+)。/)?.[1] || '';
  const media = cleanField(sourceTopic.summary).match(/包含\s*([^。]+)。/)?.[1] || '';
  const visibleLines = rawTimeline.slice(0, 6);
  const details = [
    scope ? `时间范围：${scope}` : '',
    media ? `涉及内容：${media}` : '',
    visibleLines.length ? `可见文字线索：${visibleLines.join('；')}` : '',
    '这小段聊天未被模型稳定提炼，已保留可见文字、发送人、时间、链接和媒体元信息；图片、视频或语音未成功识别时不会编造内容。',
  ].filter(Boolean).join(' ');
  if (!details) return null;
  return {
    title: '少量消息仅保留元信息',
    category: '聊天主线',
    participants,
    summary: details,
    need_followup: false,
  };
}

function cleanFallbackTimeline(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map(line => cleanPublicText(line)
      .replace(/（对应图片块触发模型空响应[^）]*）/g, '')
      .replace(/（对应视频关键帧触发模型空响应[^）]*）/g, '')
      .replace(/（对应音频块触发模型空响应[^）]*）/g, '')
      .replace(/（下一块[^）]+）/g, '')
      .trim())
    .filter(line => line && !/链接打开结果|_raw_timeline|_fallback_chunk|分段错误|Model returned empty content/i.test(line))
    .filter(line => !/^[-–—\s]*$/.test(line))
    .slice(0, 12);
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

function publicDigestLinks(links, limit = 12, cfg = {}) {
  return arrayOf(links)
    .filter(link => isAnalyzableWebLinkUrl(link?.url, cfg))
    .sort((a, b) => digestLinkScore(b) - digestLinkScore(a))
    .slice(0, limit);
}

function digestLinkScore(link = {}) {
  const summary = cleanField(link.summary);
  let score = 0;
  if (hasChatContextSignal(summary)) score += 8;
  if (/本程序打开该链接时返回|打开超时|加载中|环境异常|没有可靠中文摘要|分段模型失败|聊天上下文不足/.test(summary)) score -= 5;
  if (/报价|文档|官网|仓库|注册|入口|教程|新闻|快讯|公告|优惠|充值|支付|模型|API|代码|下载/.test(`${link.title || ''} ${summary}`)) score += 3;
  if (/^https?:\/\//i.test(cleanField(link.title))) score -= 2;
  return score;
}

function isLowValueDigestLink(link = {}) {
  const url = normalizeHttpUrl(link.url);
  if (!url || !isAnalyzableWebLinkUrl(url)) return true;
  const summary = cleanField(link.summary);
  if (/该网页链接出现在本分段原始消息中；分段模型失败/.test(summary)) return true;
  if (/该网页链接已保留，但当前没有可靠中文摘要/.test(summary)) return true;
  if (/聊天上下文不足，当前只能确认：(?:环境异常|加载中|打开超时|Tip|Favorites)/.test(summary)) return true;
  return false;
}

async function summarizeChunkWithFallback({ settings, model, groupName, since, until, chunk, index, total, signal, onProgress, mediaRetryState = null }) {
  const mode = `chunk ${index + 1}/${total}`;
  const bundle = formatMessageBundle(chunk);
  try {
    const part = await callJsonModel({
      settings,
      model,
      groupName,
      since,
      until,
      messageBundle: bundle,
      mode,
      signal,
      onProgress,
      mediaRetryState,
    });
    return attachChunkImportance(part, chunk, bundle);
  } catch (err) {
    if (err?.status === 499 || signal?.aborted) throw err;
    if (!isLikelyRecoverableChunkFailure(err)) throw err;
    const fallback = attachChunkImportance(buildFallbackChunkDigest({ chunk, index, error: err }), chunk, bundle);
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
  const weight = estimateChunkImportance(chunk, bundle);
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
    _fallback_weight: weight,
    _raw_timeline: bundle.text,
  };
}

function chunkMediaStats(bundle = {}) {
  return {
    images: Number(bundle.imageCount || 0),
    audio: Number(bundle.audioCount || 0),
  };
}

function createMediaRetryState() {
  return {
    forceTextOnly: false,
    unsupportedMediaFailures: 0,
  };
}

function rememberUnsupportedMediaFailure(mediaRetryState, err) {
  if (!mediaRetryState || !isLikelyModelWideUnsupportedMediaError(err)) return false;
  mediaRetryState.unsupportedMediaFailures = Number(mediaRetryState.unsupportedMediaFailures || 0) + 1;
  if (mediaRetryState.unsupportedMediaFailures < 2) return false;
  mediaRetryState.forceTextOnly = true;
  return true;
}

function attachChunkImportance(part, chunk, bundle = null) {
  if (!part || typeof part !== 'object') return part;
  try {
    Object.defineProperty(part, '_chunk_importance', {
      value: estimateChunkImportance(chunk, bundle),
      enumerable: false,
      configurable: true,
    });
  } catch {}
  return part;
}

function estimateChunkImportance(chunk = [], bundle = null) {
  const effectiveBundle = bundle || formatMessageBundle(chunk);
  const textChars = effectiveBundle.text?.length || estimateMessageTextChars(chunk);
  const linkCount = chunk.reduce((n, msg) => {
    const previewCount = Array.isArray(msg.link_previews) ? msg.link_previews.length : 0;
    return n + previewCount + extractUrlsFromText(msg.content).length + extractUrlsFromText(msg.media?.url).length;
  }, 0);
  const media = chunkMediaStats(effectiveBundle);
  const messages = Array.isArray(chunk) ? chunk.length : 0;
  return {
    messages,
    text_chars: textChars,
    image_count: media.images,
    audio_count: media.audio,
    link_count: linkCount,
    weight: chunkImportanceWeight({ messages, text_chars: textChars, image_count: media.images, audio_count: media.audio, link_count: linkCount }),
  };
}

function chunkImportanceWeight(stats = {}) {
  const messages = Math.max(0, Number(stats.messages || 0));
  const textChars = Math.max(0, Number(stats.text_chars || stats.textChars || 0));
  const imageCount = Math.max(0, Number(stats.image_count || stats.images || 0));
  const audioCount = Math.max(0, Number(stats.audio_count || stats.audio || 0));
  const linkCount = Math.max(0, Number(stats.link_count || stats.links || 0));
  return Math.max(1, Math.ceil(messages / 8) + Math.ceil(textChars / 2400) + imageCount * 4 + audioCount * 4 + linkCount * 3);
}

function chunkImportanceOfPart(part = {}) {
  const meta = part?._chunk_importance || part?._fallback_weight || {};
  return Math.max(1, Number(meta.weight || chunkImportanceWeight(meta)) || 1);
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

function digestChunkLimits(llm = {}) {
  return {
    maxMessages: Math.min(
      Math.max(1, Number(llm.max_messages_per_call || DEFAULT_FALLBACK_MAX_MESSAGES_PER_CALL)),
      ADAPTIVE_CHUNK_MAX_MESSAGES,
    ),
    maxChars: Math.min(
      Math.max(1000, Number(llm.max_input_chars || DEFAULT_FALLBACK_MAX_INPUT_CHARS)),
      ADAPTIVE_CHUNK_MAX_INPUT_CHARS,
    ),
    maxMediaChars: Math.min(
      Math.max(100000, Number(llm.max_image_chars_per_call || DEFAULT_MAX_IMAGE_DATA_URL_CHARS_PER_CALL)),
      MAX_IMAGE_DATA_URL_CHARS_PER_CALL,
    ),
  };
}

function prepareMessagesForChunking(messages = [], llm = {}) {
  const limits = digestChunkLimits(llm);
  const out = [];
  for (let index = 0; index < messages.length; index++) {
    out.push(...splitOversizedMessageForChunking(trimOversizedMediaPayloads(messages, index, limits), index, limits));
  }
  return out;
}

function trimOversizedMediaPayloads(messages = [], index = 0, limits = digestChunkLimits()) {
  const msg = messages[index] || {};
  const media = msg.media || {};
  if (!media || typeof media !== 'object') return messages;
  const maxSinglePayloadChars = Math.max(12000, Math.floor(Number(limits.maxMediaChars || DEFAULT_MAX_IMAGE_DATA_URL_CHARS_PER_CALL) * 0.85));
  const replacements = [];
  const nextMedia = { ...media };
  for (const key of ATTACHMENT_DATA_KEYS) {
    const value = typeof media[key] === 'string' ? media[key] : '';
    if (!value || value.length <= maxSinglePayloadChars) continue;
    const kind = mediaPayloadKeyLabel(key, msg);
    replacements.push(`${kind}${formatApproxPayloadSize(value.length)}`);
    delete nextMedia[key];
    if (key === 'frame_data_url') delete nextMedia.frame_mime;
  }
  if (!replacements.length) return messages;
  const next = [...messages];
  const content = String(msg.content || '').trim();
  next[index] = {
    ...msg,
    media: {
      ...nextMedia,
      payload_omitted_reason: `附件过大，已改为只发送元信息：${replacements.join('、')}`,
    },
    content,
  };
  return next;
}

function mediaPayloadKeyLabel(key, msg = {}) {
  if (key === 'audio_data_url') return '音频';
  if (key === 'frame_data_url') return '视频关键帧';
  if (msg.type === 'image') return '图片';
  return '媒体';
}

function formatApproxPayloadSize(chars) {
  const bytes = Math.floor(Number(chars || 0) * 0.75);
  if (bytes >= 1024 * 1024) return `约${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `约${Math.round(bytes / 1024)}KB`;
  return bytes ? `约${bytes}B` : '';
}

function splitOversizedMessageForChunking(messages = [], index = 0, limits = digestChunkLimits()) {
  const msg = messages[index] || {};
  const refsCost = estimateMessageBundleItemCost(messages, index, { imageCount: 0, audioCount: 0 });
  if (refsCost.textChars <= limits.maxChars) return [msg];
  if (!canSplitMessageForChunking(msg)) return [msg];

  const emptyMsg = { ...msg, content: '', link_previews: [] };
  const baseCost = estimateMessageBundleItemCost([emptyMsg], 0, { imageCount: 0, audioCount: 0 }).textChars;
  const payloadLimit = Math.max(600, limits.maxChars - baseCost - 260);
  if (payloadLimit < 600) return [msg];

  const contentParts = splitLongTextForChunking(msg.content, payloadLimit);
  const previewGroups = splitLinkPreviewsForChunking(msg.link_previews, payloadLimit);
  if (contentParts.length <= 1 && previewGroups.length <= 1) return [msg];

  const parts = [];
  for (const text of contentParts) {
    if (!cleanField(text)) continue;
    parts.push({ kind: 'content', msg: { ...msg, content: text, link_previews: [] } });
  }
  const contentHint = truncateText(cleanContextText(msg.content), 180);
  for (const previews of previewGroups) {
    if (!previews.length) continue;
    parts.push({
      kind: 'links',
      msg: {
        ...msg,
        content: contentHint
          ? `同一条长消息的链接打开结果；原消息片段=${contentHint}`
          : '同一条长消息的链接打开结果',
        link_previews: previews,
      },
    });
  }
  if (parts.length <= 1) return [msg];

  const total = parts.length;
  return parts.map((part, partIndex) => ({
    ...part.msg,
    id: msg.id ? `${msg.id}:chunk-${partIndex + 1}` : `${msg.time || 'message'}:${partIndex + 1}`,
    content: part.kind === 'content'
      ? `（同一条长消息第 ${partIndex + 1}/${total} 段）${part.msg.content}`
      : `（同一条长消息第 ${partIndex + 1}/${total} 段，链接打开结果）${part.msg.content}`,
  }));
}

function canSplitMessageForChunking(msg = {}) {
  const type = msg.type || 'text';
  return (!type || type === 'text') && mediaPayloadChars(msg) === 0;
}

function splitLongTextForChunking(value, maxChars) {
  const text = String(value || '');
  const limit = Math.max(600, Number(maxChars) || 4000);
  if (!text || text.length <= limit) return text ? [text] : [];
  const out = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + limit);
    if (end < text.length) {
      const window = text.slice(start, end);
      const boundary = Math.max(
        window.lastIndexOf('\n'),
        window.lastIndexOf('。'),
        window.lastIndexOf('！'),
        window.lastIndexOf('？'),
        window.lastIndexOf('；'),
        window.lastIndexOf(';'),
      );
      if (boundary > Math.floor(limit * 0.5)) end = start + boundary + 1;
    }
    out.push(text.slice(start, end));
    start = end;
  }
  return out;
}

function splitLinkPreviewsForChunking(previews, maxChars) {
  const items = arrayOf(previews);
  if (!items.length) return [];
  const limit = Math.max(600, Number(maxChars) || 4000);
  const groups = [];
  let current = [];
  let chars = 0;
  for (const preview of items) {
    const cost = formatLinkPreviewLines([preview]).length + 1;
    if (current.length && chars + cost > limit) {
      groups.push(current);
      current = [];
      chars = 0;
    }
    current.push(preview);
    chars += cost;
  }
  if (current.length) groups.push(current);
  return groups;
}

function estimateMessageTextChars(messages) {
  return estimateMessageBundleStats(messages).textChars;
}

function estimateMediaPayloadChars(messages) {
  return messages.reduce((n, msg) => n + mediaPayloadChars(msg), 0);
}

function estimateMessageBundleStats(messages = []) {
  let textChars = 0;
  let imageChars = 0;
  let audioChars = 0;
  let imageCount = 0;
  let audioCount = 0;
  let linkPreviewCount = 0;
  for (let index = 0; index < messages.length; index++) {
    const cost = estimateMessageBundleItemCost(messages, index, { imageCount, audioCount });
    textChars += cost.textChars;
    imageChars += cost.imageChars;
    audioChars += cost.audioChars;
    imageCount += cost.imageCount;
    audioCount += cost.audioCount;
    linkPreviewCount += cost.linkPreviewCount;
  }
  return {
    messages: messages.length,
    textChars,
    mediaChars: imageChars + audioChars,
    imageChars,
    audioChars,
    imageCount,
    audioCount,
    linkPreviewCount,
  };
}

function estimateMessageBundleItemCost(messages = [], index = 0, counters = {}) {
  const msg = messages[index] || {};
  const refs = messageBundleRefs(msg, counters.imageCount || 0, counters.audioCount || 0);
  const context = messageContextForBundle(messages, index);
  const line = formatMessageLine(msg, { imageRef: refs.imageRef, audioRef: refs.audioRef, context });
  return {
    textChars: line.length + 1,
    imageChars: refs.visualUrl ? refs.visualUrl.length : 0,
    audioChars: refs.audioDataUrl ? refs.audioDataUrl.length : 0,
    imageCount: refs.imageRef ? 1 : 0,
    audioCount: refs.audioRef ? 1 : 0,
    linkPreviewCount: Array.isArray(msg.link_previews) ? msg.link_previews.length : 0,
  };
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

function splitMessages(messages, maxMessages, maxChars, maxMediaChars = DEFAULT_MAX_IMAGE_DATA_URL_CHARS_PER_CALL) {
  const chunks = [];
  let cur = [];
  let chars = 0;
  let mediaChars = 0;
  let imageCount = 0;
  let audioCount = 0;
  const messageLimit = Math.max(1, Number(maxMessages || 800));
  const charLimit = Math.max(1000, Number(maxChars || 60000));
  const mediaCharLimit = Math.max(100000, Number(maxMediaChars || DEFAULT_MAX_IMAGE_DATA_URL_CHARS_PER_CALL));

  for (let index = 0; index < messages.length; index++) {
    const msg = messages[index];
    const cost = estimateMessageBundleItemCost(messages, index, { imageCount, audioCount });
    const dataUrlChars = cost.imageChars + cost.audioChars;
    const shouldSplit = cur.length && (
      cur.length >= messageLimit
      || chars + cost.textChars > charLimit
      || (dataUrlChars > 0 && mediaChars + dataUrlChars > mediaCharLimit)
    );
    if (shouldSplit) {
      chunks.push(cur);
      cur = [];
      chars = 0;
      mediaChars = 0;
      imageCount = 0;
      audioCount = 0;
    }
    const activeCost = shouldSplit
      ? estimateMessageBundleItemCost(messages, index, { imageCount, audioCount })
      : cost;
    cur.push(msg);
    chars += activeCost.textChars;
    mediaChars += activeCost.imageChars + activeCost.audioChars;
    imageCount += activeCost.imageCount;
    audioCount += activeCost.audioCount;
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
    const refs = messageBundleRefs(msg, imageCount, audioCount);
    const context = messageContextForBundle(messages, index);
    const line = formatMessageLine(msg, { imageRef: refs.imageRef, audioRef: refs.audioRef, context });
    lines.push(line);
    textBuffer.push(line);
    if (refs.imageRef) {
      flushText();
      blocks.push({
        kind: 'image',
        ref: refs.imageRef,
        data_url: refs.visualUrl,
        mime: refs.visualMime,
      });
      imageCount++;
      imageChars += refs.visualUrl.length;
    }
    if (refs.audioRef) {
      flushText();
      blocks.push({
        kind: 'audio',
        ref: refs.audioRef,
        data_url: refs.audioDataUrl,
        mime: refs.audioMime,
        format: refs.audioFormat,
      });
      audioCount++;
      audioChars += refs.audioDataUrl.length;
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

function messageBundleRefs(msg = {}, imageCount = 0, audioCount = 0) {
  const dataUrl = msg.media?.data_url || '';
  const frameDataUrl = msg.media?.frame_data_url || '';
  const audioDataUrl = msg.media?.audio_data_url || '';
  const canAttachImage = msg.type === 'image' && dataUrl;
  const canAttachFrame = (msg.type === 'video' || isVideoLikeMedia(msg.media)) && frameDataUrl;
  const audioFormat = chatAudioFormatForModel(dataUrlMime(audioDataUrl) || msg.media?.mime);
  const canAttachAudio = audioDataUrl && audioFormat && (msg.type === 'voice' || isAudioLikeMedia(msg.media));
  const visualUrl = canAttachImage ? dataUrl : (canAttachFrame ? frameDataUrl : '');
  const imageRef = canAttachImage ? `图片${imageCount + 1}` : (canAttachFrame ? `视频关键帧${imageCount + 1}` : '');
  const audioRef = canAttachAudio ? `音频${audioCount + 1}` : '';
  return {
    imageRef,
    audioRef,
    visualUrl,
    visualMime: (canAttachImage ? msg.media?.mime : msg.media?.frame_mime) || dataUrlMime(visualUrl),
    audioDataUrl: canAttachAudio ? audioDataUrl : '',
    audioMime: msg.media?.mime || dataUrlMime(audioDataUrl),
    audioFormat,
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

function attachGlobalNearbyContexts(messages = []) {
  if (!Array.isArray(messages) || !messages.length) return [];
  return messages.map((msg, index) => {
    if (!messageNeedsContext(msg)) return msg;
    const context = buildNearbyChatContext(messages, index);
    if (!context) return msg;
    return { ...msg, _global_context_hint: context };
  });
}

function messageContextForBundle(messages = [], index = 0) {
  const msg = messages[index] || {};
  if (!messageNeedsContext(msg)) return '';
  return cleanField(msg._global_context_hint) || buildNearbyChatContext(messages, index);
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
  } else if (m.media?.payload_omitted_reason) {
    const detail = mediaMetadataSummary(m.media);
    suffix = `（${m.media.payload_omitted_reason}${detail ? `；媒体元信息=${detail}` : ''}；不要假装看过画面或听过语音内容）`;
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
    mediaMetadataSummary(media),
    media?.url ? '网页链接' : '',
  ].filter(Boolean).join('，');
}

function mediaMetadataSummary(media = {}) {
  const parts = [];
  if (media?.width && media?.height) parts.push(`尺寸 ${media.width}x${media.height}`);
  if (media?.size) parts.push(`大小 ${formatBytesForPrompt(media.size)}`);
  if (media?.duration_ms) parts.push(`时长 ${Math.round(Number(media.duration_ms) / 1000)}秒`);
  else if (media?.duration_s) parts.push(`时长 ${media.duration_s}秒`);
  if (media?.ext) parts.push(`扩展名 ${media.ext}`);
  if (media?.mime) parts.push(`格式 ${media.mime}`);
  if (media?.local_path_hint) parts.push(`本地文件 ${media.local_path_hint}`);
  return parts.filter(Boolean).join('，');
}

function formatBytesForPrompt(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${Math.round(bytes)}B`;
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

  const targets = extractMessageLinkTargets(messages, cfg);
  if (!targets.length) return messages;

  const uniqueUrls = [...new Set(targets.map(t => t.url))];
  notifyProgress(onProgress, {
    phase: 'link_preview',
    label: 'AI 总结 · 打开网页',
    detail: `${uniqueUrls.length} 个网页链接`,
  });
  const previewByUrl = new Map();
  const linkStatus = createLinkPreviewStatus(uniqueUrls.length);
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
      recordLinkPreviewStatus(linkStatus, preview);
      completed++;
      if (completed === uniqueUrls.length || completed % 5 === 0) {
        notifyProgress(onProgress, {
          phase: 'link_preview',
          label: 'AI 总结 · 打开网页',
          detail: linkPreviewProgressDetail(linkStatus),
        });
      }
    }
  });
  await Promise.all(workers);

  const researchUrls = uniqueUrls.filter(url => isSuccessfulLinkPreview(previewByUrl.get(url), cfg));
  let aiResearch = new Map();
  try {
    aiResearch = await fetchAiLinkResearchForUrls(researchUrls, settings, cfg, signal, onProgress);
  } catch (err) {
    if (err?.status === 499 || signal?.aborted) throw err;
    linkStatus.ai_research_failed_batches++;
  }
  mergeAiLinkResearchStatus(linkStatus, aiResearch.__link_research_status);
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

  const enriched = messages.map((msg, index) => {
    const urls = urlsByMessage.get(index);
    if (!urls?.length) return msg;
    const previews = urls.map(url => previewByUrl.get(url)).filter(preview => isTimelineLinkPreview(preview, cfg));
    return previews.length ? { ...msg, link_previews: previews } : msg;
  });
  attachLinkPreviewMeta(enriched, linkStatus, previewByUrl);
  return enriched;
}

function createLinkPreviewStatus(total = 0) {
  return {
    links: Math.max(0, Number(total || 0)),
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    ai_research_requested: 0,
    ai_researched: 0,
    ai_research_failed_batches: 0,
    ai_research_skipped: false,
  };
}

function recordLinkPreviewStatus(status, preview = {}) {
  if (!status) return;
  status.processed++;
  const previewStatus = String(preview?.status || 'ok');
  if (previewStatus === 'ok') status.succeeded++;
  else if (previewStatus === 'failed') status.failed++;
  else status.skipped++;
}

function linkPreviewProgressDetail(status = {}) {
  const parts = [
    `已处理 ${status.processed || 0}/${status.links || 0} 个网页链接`,
    `成功 ${status.succeeded || 0}`,
    status.failed ? `失败 ${status.failed}` : '',
    status.skipped ? `跳过 ${status.skipped}` : '',
  ].filter(Boolean);
  return parts.join('，');
}

function mergeAiLinkResearchStatus(linkStatus, aiStatus = null) {
  if (!linkStatus || !aiStatus) return;
  linkStatus.ai_research_requested = Number(aiStatus.requested || 0);
  linkStatus.ai_researched = Number(aiStatus.succeeded || 0);
  linkStatus.ai_research_failed_batches += Number(aiStatus.failed_batches || 0);
  linkStatus.ai_research_skipped = !!aiStatus.unsupported;
}

function attachLinkPreviewMeta(messages, linkStatus, previewByUrl) {
  Object.defineProperty(messages, '__link_preview_status', {
    value: linkStatus,
    enumerable: false,
  });
  Object.defineProperty(messages, '__link_preview_by_url', {
    value: linkPreviewStatusMap(previewByUrl),
    enumerable: false,
  });
}

function linkPreviewStatusMap(previewByUrl = new Map()) {
  const map = new Map();
  for (const [url, preview] of previewByUrl.entries()) {
    const normalized = normalizeHttpUrl(url) || String(url || '');
    if (!normalized) continue;
    const item = {
      status: String(preview?.status || 'ok'),
      error: cleanField(preview?.error || '').slice(0, 160),
      final_url: cleanField(preview?.final_url || ''),
      content_type: cleanField(preview?.content_type || ''),
    };
    map.set(normalized, item);
    const finalUrl = normalizeHttpUrl(preview?.final_url);
    if (finalUrl) map.set(finalUrl, item);
  }
  return map;
}

function extractMessageLinkTargets(messages, cfg = {}) {
  const targets = [];
  for (let index = 0; index < messages.length; index++) {
    const msg = messages[index];
    const urls = new Set([
      ...extractUrlsFromText(msg.content, cfg),
      ...extractUrlsFromText(msg.media?.url, cfg),
    ]);
    for (const url of urls) targets.push({ index, url, time: msg.time, sender: msg.sender });
  }
  return targets;
}

function extractUrlsFromText(text, cfg = {}) {
  const value = String(text || '');
  const matches = value.match(/https?:\/\/[^\s<>"'`]+/gi) || [];
  return matches
    .map(cleanUrlCandidate)
    .map(normalizeHttpUrl)
    .filter(url => url && isAnalyzableWebLinkUrl(url, cfg));
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

function linkPreviewAllowsPrivateNetworks(cfg = {}) {
  return cfg.allow_private_networks === true || cfg.allow_private_networks === 'true';
}

function isAnalyzableWebLinkUrl(value, cfg = {}) {
  const url = normalizeHttpUrl(value);
  return !!url && !DIRECT_MEDIA_URL_RE.test(url) && !isIgnoredWebLinkUrl(url, cfg);
}

function isIgnoredWebLinkUrl(value, cfg = {}) {
  try {
    const parsed = new URL(String(value || '').trim());
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    if (!linkPreviewAllowsPrivateNetworks(cfg) && isPrivateOrLocalHost(host)) return true;
    if (host === 'mp.weixin.qq.com' && (pathname.startsWith('/mp/wappoc_appmsgcaptcha') || pathname.startsWith('/mp/waerrpage'))) return true;
    if (host === 'support.weixin.qq.com' && (pathname.startsWith('/cgi-bin/mmsupport-bin/readtemplate') || pathname.startsWith('/update'))) return true;
    if (host === 'wxapp.tenpay.com' && pathname.startsWith('/mmpayhb/')) return true;
    return false;
  } catch {
    return true;
  }
}

function isPrivateOrLocalHost(hostname = '') {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host === 'localhost.localdomain' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === 'metadata.google.internal') return true;
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    const parts = host.split('.').map(Number);
    const [a, b] = parts;
    return a === 0
      || a === 10
      || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)
      || a >= 224;
  }
  if (ipVersion === 6) {
    return host === '::1'
      || host === '::'
      || host.startsWith('fc')
      || host.startsWith('fd')
      || host.startsWith('fe80:')
      || host.startsWith('ff');
  }
  return false;
}

function isMediaContentType(contentType = '') {
  return /^(?:image|audio|video)\//i.test(String(contentType || '').trim());
}

function isAnalyzableLinkPreview(preview, cfg = {}) {
  return isSuccessfulLinkPreview(preview, cfg);
}

function isSuccessfulLinkPreview(preview, cfg = {}) {
  if (!preview || String(preview.status || 'ok') !== 'ok') return false;
  return isAnalyzableWebLinkUrl(preview.url, cfg) && (!preview.final_url || isAnalyzableWebLinkUrl(preview.final_url, cfg));
}

function isTimelineLinkPreview(preview, cfg = {}) {
  if (!preview) return false;
  const status = String(preview.status || 'ok');
  if (status === 'skipped' || status === 'skipped_media') return false;
  return isAnalyzableWebLinkUrl(preview.url, cfg) && (!preview.final_url || isAnalyzableWebLinkUrl(preview.final_url, cfg));
}

async function fetchLinkPreview(targetUrl, cfg, signal = null) {
  throwIfAborted(signal);
  const url = normalizeHttpUrl(targetUrl);
  if (!url) return { url: targetUrl, status: 'skipped', error: '不是 http(s) 链接' };
  if (!isAnalyzableWebLinkUrl(url, cfg)) {
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
  if (!shouldUseAiLinkResearch(urls, settings, cfg)) {
    const out = new Map();
    Object.defineProperty(out, '__link_research_status', {
      value: {
        requested: 0,
        batches: 0,
        succeeded: 0,
        failed_batches: 0,
        unsupported: Array.isArray(urls) && urls.length > 0,
      },
      enumerable: false,
    });
    return out;
  }
  throwIfAborted(signal);
  const uniqueUrls = [...new Set(urls.map(normalizeHttpUrl).filter(Boolean))];
  const chunks = chunkArray(uniqueUrls, AI_LINK_RESEARCH_URLS_PER_CALL);
  const concurrency = Math.min(DEFAULT_LINK_RESEARCH_CONCURRENCY, chunks.length || 1);
  const out = new Map();
  const status = {
    requested: uniqueUrls.length,
    batches: chunks.length,
    succeeded: 0,
    failed_batches: 0,
    unsupported: false,
  };
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
      status.succeeded += batch.size;
    } catch (err) {
      if (err?.status === 499 || signal?.aborted) throw err;
      if (isLikelyUnsupportedWebSearchError(err)) {
        rememberAiWebSearchSupport(settings, false);
        status.unsupported = true;
        notifyProgress(onProgress, {
          phase: 'ai_link_research_skip',
          label: 'AI 总结 · AI 查链接',
          detail: '当前 AI 端点不支持 Responses 联网工具，本次后续链接只使用本地打开结果',
        });
      }
      status.failed_batches++;
      // Local link previews remain attached to the timeline if web-search research fails.
    }
    completed++;
    notifyProgress(onProgress, {
      phase: 'ai_link_research',
      label: 'AI 总结 · AI 查链接',
      detail: `已完成 ${completed}/${chunks.length} 批链接核查`,
    });
  });
  Object.defineProperty(out, '__link_research_status', {
    value: status,
    enumerable: false,
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
    limit: settings.llm.ai_concurrency,
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
  const runtimeSupport = aiWebSearchRuntimeSupport(settings);
  if (runtimeSupport === false) return false;
  const savedSupport = savedAiWebSearchSupport(settings);
  if (savedSupport === false) return false;
  return true;
}

function aiWebSearchCapabilityKey(settings = {}) {
  return [
    settings?.llm?.provider || '',
    normalizeBaseUrl(settings?.llm?.base_url || ''),
    settings?.llm?.long_context_model || settings?.llm?.model || '',
  ].join('|');
}

function aiWebSearchRuntimeSupport(settings = {}) {
  const key = aiWebSearchCapabilityKey(settings);
  return key ? AI_WEB_SEARCH_CAPABILITY_CACHE.get(key) : undefined;
}

function rememberAiWebSearchSupport(settings = {}, supported) {
  const key = aiWebSearchCapabilityKey(settings);
  if (key) AI_WEB_SEARCH_CAPABILITY_CACHE.set(key, !!supported);
}

function savedAiWebSearchSupport(settings = {}) {
  const cap = settings?.llm?.capabilities;
  if (!cap || typeof cap !== 'object') return undefined;
  const baseModel = settings?.llm?.model || '';
  const longModel = settings?.llm?.long_context_model || baseModel;
  const sameIdentity = cap.provider === settings?.llm?.provider
    && normalizeBaseUrl(cap.base_url || '') === normalizeBaseUrl(settings?.llm?.base_url || '')
    && (!cap.model || cap.model === baseModel);
  if (!sameIdentity) return undefined;
  const source = longModel && longModel !== baseModel ? cap.long_context : cap;
  if (longModel && longModel !== baseModel && (!source || typeof source !== 'object' || source.model !== longModel)) return undefined;
  const item = source.responses_web_search || source.web_search_preview || source.web_search;
  if (!item || typeof item !== 'object' || typeof item.ok !== 'boolean') return undefined;
  return item.ok;
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

async function callJsonModel({ settings, model, groupName, since, until, messageBundle, mode, signal = null, onProgress = null, mediaRetryState = null }) {
  throwIfAborted(signal);
  const messagesText = messageBundle?.text || '';
  const imageCount = messageBundle?.imageCount || 0;
  const audioCount = messageBundle?.audioCount || 0;
  const blocks = (imageCount || audioCount) ? (messageBundle?.blocks || []) : [];
  const mergeMode = String(mode || '').startsWith('merge');
  const system = [
    '你是一个微信群聊日报助手。总结给群内所有成员看，只输出严格 JSON，不要 Markdown，不要解释。',
    'JSON 字段必须包含 headline、highlights、topics、todos、links、quotes。',
    '这不是项目周报、工作汇报、行动清单或复盘材料。首要目标是让没爬楼的群友快速知道大家都聊了什么、哪些信息有用、哪些观点有意思、哪些链接/图片/文件引发了讨论。',
    'headline 不超过 50 个中文字符；highlights 返回 3-6 条给只看第一屏的人看的聊天速览，每条 15-60 个中文字符，按群友最关心的聊天线索排序。写清主要话题和有用信息；有明确结果才写结果，不要把每条都写成“待确认/仍需处理”。',
    'topics 每项包含 title、category、participants、summary、need_followup。category 是你根据当天内容自拟的中文分组标题，4-12 个字，像群聊栏目名，例如“工具踩坑”“资源分享”“观点争论”“账号支付”“轻松闲聊”；不要套工作汇报模板。',
    '总结正文必须使用简体中文：headline、topics.summary、todos.item、todos.deadline、links.summary 这些解释性内容要中文表达。URL、代码标识、项目名、模型名、链接原始标题和群成员昵称可以保留原文，但不要输出英文说明句、英文连接词或英文错误原文。',
    'summary 要像自然的群聊总结：先说明这条聊天主线里大家在聊什么、争论点或有用信息是什么，再补充明确结论、分歧或未定点。不要强行把普通聊天改写成“结果/风险/待确认/下一步”。',
    '可以写“大家主要聊了...”“这个话题集中在...”“群里有人分享...”，但必须合并提炼，不要按消息流水账照抄。只有真的形成明确结论时，才写“结论/结果”；只有真的需要继续做事时，才写“后续”。',
    '不要把每个议题都写成工作状态报告；少用“受阻、待验证、仍待确认、需处理、尚未恢复、持续排查”这类汇报腔，除非聊天核心就是问题处理。',
    '不要按消息顺序逐条照抄；相同事项必须合并成一个议题。title 要是“群友读完就知道这条讲什么”的事项标题，不要只写关键词。',
    '如果议题来自链接、图片、视频、语音或文件，summary 必须把内容和发送时间、发送人、前后聊天上下文关联起来：说明它在群聊里被用来证明什么、询问什么、推进什么或引出什么结论。上下文不足时必须写“聊天上下文不足，只能确认...”，不要写成脱离群聊的网页介绍或图片说明。',
    'todos/links 没有内容时返回空数组。',
    '只要输入里有任何消息行，就不得写“没有消息、无消息、没有可总结内容、聊天内容为空”这类说法；如果内容零散，也必须基于可见消息概括出大家聊了什么，最多说明“没有形成明确结论”。',
    'quotes 表示“代表性说法”，从聊天原文中挑 0-5 条对群成员有公共价值、能代表情绪或观点的短句；每项包含 speaker、text、context。不要编造原话，不要摘取隐私或只对单个人有意义的话。',
    'todos 表示“后续关注”，不是待办清单。只有聊天里明确有人要做、明确要报名/付款/提交/联系/交付，或全群明确约定下一步时才写，通常 0-3 条，最多 5 条。普通信息点、猜测、可再验证、链接清单、工具状态、泛泛的“持续关注/排查/优化/确认”不要写进 todos，而应写在 topics 里。',
    '不要输出面向单个账号的提醒栏目；有人被点名时，只有对全群有公共价值才写进 topics 或 todos，并使用群昵称。',
    'links 每项包含 title、url、summary、from、time；summary 必须说明这个网页链接是干什么的、和聊天上下文有什么关系，不能只重复 URL。',
    'links.summary 也要结果导向：说明这个网页能提供什么结论/入口/证据，以及群里为什么需要它；不要只写“用于讨论某话题”。',
    'links.summary 必须优先使用“前后聊天上下文”和发链接那条消息来判断用途。格式上先写群聊用途或上下文状态，再补网页本身用途；例如“群里把它作为某配置的参考文档；网页本身是...”。如果前后没有任何可判断用途的消息，写“聊天上下文不足，当前只能确认该链接本身是...”。',
    'links 只允许真实 http(s) 网页链接；不要把图片、视频、音频直链、文件名、截图内容或没有 URL 的媒体内容写进 links。',
    '如果时间线里有“链接打开结果”，那是本地服务实际访问链接后得到的页面标题、描述和正文片段；总结 links 时必须优先基于这些打开结果。',
    '如果链接打开结果里出现 403、404、超时等失败状态，只能表述为“本程序/本地服务打开链接失败”，不要写成“群内反馈访问失败”或“群友访问失败”，除非聊天原文明确有人这么说。',
    '不要把 raw_timeline、_raw_timeline、_fallback_chunk、Model returned empty content、Encrypted content could not be decrypted、error 等内部字段或错误原文写入任何可见字段；如需说明，只能用中文写“部分消息仅保留了时间、发送人和媒体/链接元信息，内容仍待人工确认”。',
    '如果消息附带图片或视频关键帧，请结合视觉内容进行判断；如果接口支持音频输入并收到音频块，可以结合音频内容；如果只是文件或未转写语音，只能根据文件名、扩展名、时长和上下文判断，不要假装读取或听过正文。',
    mergeMode ? '当前输入是全量请求失败后的多个分段 JSON 摘要。你正在合并分段摘要，必须综合所有分段；不要因为后段覆盖前段而丢掉链接、待办、参与人、来源时间、代表性说法或有公共价值的聊天主线。links/topics/quotes 要从各分段去重保留，todos 要保留每段明确行动，冲突时合并信息而不是删除。合并时把分段里的工作汇报腔改成自然的群聊日报口吻；todos 只保留明确行动，不要把每个未定点都变成待办。' : '',
    mergeMode ? '如果某段带有 _fallback_chunk 或 _raw_timeline，表示该分段模型请求返回空内容或异常。你必须把 _raw_timeline 当作该段原始聊天时间线继续纳入总结，保留其中的时间、发送人、文件/链接/媒体元信息；但不能编造未成功识别的图片画面或语音内容。' : '',
  ].join('\n');
  const intro = [
    `群名：${groupName}`,
    `时间窗：${since} ~ ${until}`,
    `任务模式：${mode}`,
    mergeMode ? '输入内容是“分段 N: {...}”形式的中间摘要，不是原始聊天。请保留每个分段里出现过的重要聊天主线、网页链接、发送人、时间、图片/文件/语音相关信息；只做去重、归并和提炼，不得省略独立话题。明确行动才进 todos，普通未定点写进 topics。' : '',
    imageCount ? `多模态消息数：${imageCount} 张图片。下面内容按消息时间顺序排列；图片块紧跟它对应的消息行，请把图片与该行的时间、发送人、前后聊天上下文关联；不要只描述画面，要说明图片在聊天里承担的含义或待确认点。` : '',
    audioCount ? `音频消息数：${audioCount} 条。若后续内容包含音频块，请尝试听取；若模型接口不支持音频，仍需保留该语音消息的时间、发送人和元信息，不要编造语音内容。` : '',
    messageBundle?.linkPreviewCount ? `链接打开结果：${messageBundle.linkPreviewCount} 个。每个结果都附在对应消息行下方；对应消息行可能带有“前后聊天上下文”。请优先根据前后聊天上下文判断链接为什么被发，再结合页面内容总结用途；失败状态只代表本程序访问该网页失败，不代表群内成员反馈。` : '',
    '请按群聊日报视角提炼真正有用的信息，写给没爬楼但想快速跟上大家聊了什么的群成员。优先保留聊天主线、观点、资源、吐槽、经验和有趣说法；有明确结论就写结论，没有结论就自然说明分歧或还没定，不要强行制造待办。',
  ].filter(Boolean).join('\n');
  const user = [
    intro,
    '',
    messagesText || '（没有消息）',
  ].join('\n');

  let lastError;
  let activeBlocks = mediaRetryState?.forceTextOnly && blocks.some(block => block.kind === 'image' || block.kind === 'audio')
    ? withoutMediaBlocksForTextOnlyRetry(blocks)
    : blocks;
  let audioRetryUsed = false;
  let mediaTextRetryUsed = !!mediaRetryState?.forceTextOnly;
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
      if (
        (imageCount || audioCount)
        && !mediaTextRetryUsed
        && activeBlocks.some(block => block.kind === 'image' || block.kind === 'audio')
        && (isModelEmptyContentError(e) || isLikelyUnsupportedMediaError(e))
      ) {
        activeBlocks = withoutMediaBlocksForTextOnlyRetry(activeBlocks);
        mediaTextRetryUsed = true;
        audioRetryUsed = true;
        const futureTextOnly = rememberUnsupportedMediaFailure(mediaRetryState, e);
        notifyProgress(onProgress, {
          phase: 'llm_media_retry',
          label: 'AI 总结 · 媒体兜底',
          detail: `任务 ${mode || 'summary'} 当前媒体请求失败，改用文本和媒体元信息重试${futureTextOnly ? '；连续确认端点不支持媒体，后续分段将直接走文本兜底' : ''}`,
        });
        continue;
      }
      if (
        (imageCount || audioCount)
        && !mediaTextRetryUsed
        && attempt >= 1
        && activeBlocks.some(block => block.kind === 'image' || block.kind === 'audio')
        && isTransientError(e)
      ) {
        activeBlocks = withoutMediaBlocksForTextOnlyRetry(activeBlocks);
        mediaTextRetryUsed = true;
        audioRetryUsed = true;
        notifyProgress(onProgress, {
          phase: 'llm_media_retry',
          label: 'AI 总结 · 媒体兜底',
          detail: `任务 ${mode || 'summary'} 媒体分段临时不可用，改用文本和媒体元信息重试`,
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

async function ensureDigestHumanGroupChatStyle({ raw, settings, model, signal = null, onProgress = null }) {
  const locallyCleaned = cleanupDigestStyleLocally(raw);
  if (!digestNeedsHumanGroupChatStyle(locallyCleaned)) return locallyCleaned;
  notifyProgress(onProgress, {
    phase: 'llm_style_polish',
    label: 'AI 总结 · 成稿自检',
    detail: '检测到摘要仍像工作汇报，正在改成群聊日报口吻',
  });
  try {
    const polished = await rewriteDigestToHumanGroupChatStyle({ raw: locallyCleaned, settings, model, signal, onProgress });
    return cleanupDigestStyleLocally(polished);
  } catch (err) {
    if (err?.status === 499 || signal?.aborted) throw err;
    notifyProgress(onProgress, {
      phase: 'llm_style_polish_fallback',
      label: 'AI 总结 · 成稿润色兜底',
      detail: '润色请求失败，改用本地规则去掉模板化表达',
    });
    return locallyCleaned;
  }
}

async function rewriteDigestToHumanGroupChatStyle({ raw, settings, model, signal = null, onProgress = null }) {
  throwIfAborted(signal);
  const system = [
    '你是微信群聊日报的成稿编辑。只输出严格 JSON，不要 Markdown，不要解释。',
    '输入已经是摘要 JSON。你的任务不是重新总结，不新增事实，不删除重要话题、链接、金句，只把可见正文改成像群友手工整理的群聊总结。',
    '必须保留顶层结构 headline、highlights、topics、todos、links、quotes；每个数组元素结构不变。允许把不明确的泛泛待办从 todos 删除，因为普通“验证/排查/持续关注”应该写在 topics 里，不要像工作清单。',
    '去掉 AI 味和模板味：不要出现“根据聊天记录、以下是、总结如下、整体来看、值得注意的是、该议题、本时间窗、主要围绕、综合来看、从内容看、可以看出、需处理、待确认、仍待验证、持续关注、风险：、结果：、结论：、现状：”这类套话。URL、产品名、模型名和群昵称可保留原文。',
    '语气要像群里真人整理给大家看的日报：自然、具体、短句优先；可以写“大家聊到/群里主要聊/这条线索/这个话题/后面还没定”，但不要油腻、不要营销、不要装熟。',
    'headline/highlights 写“大家都聊了什么和有什么有用信息”，不要写成 OKR、项目状态或行动计划。',
    'topics.summary 保留信息密度，但不要每条都强行写结果、风险和下一步；没有明确结论时自然写“还没聊出统一说法/这块还没定”。',
    'links.summary 仍要说明链接是干什么的以及群里为什么发它；如果上下文不足，写“前后聊天没给出更多信息，只能看出...”。',
    'quotes 必须保持原话，不要改写 quote.text；只可清理 context 的模板味。',
  ].join('\n');
  const user = [
    '请把下面摘要 JSON 润色成自然群聊日报，保留事实和 JSON schema：',
    JSON.stringify(raw || {}, null, 2),
  ].join('\n');
  const text = settings.llm.provider === 'anthropic'
    ? await callAnthropic({ settings, model, system, user, intro: '群聊日报成稿润色', blocks: [], signal, onProgress, mode: 'rewrite/style' })
    : await callOpenAI({ settings, model, system, user, intro: '群聊日报成稿润色', blocks: [], signal, onProgress, mode: 'rewrite/style' });
  return parseJsonModelText(text);
}

function cleanupDigestStyleLocally(raw = {}) {
  const next = clonePlainObject(raw);
  next.headline = cleanupAiStyleText(next.headline);
  next.highlights = arrayOf(next.highlights).map(cleanupAiStyleText).filter(Boolean);
  next.topics = arrayOf(next.topics).map(topic => ({
    ...topic,
    title: cleanupAiStyleText(topic?.title),
    category: cleanupAiStyleText(topic?.category),
    summary: cleanupAiStyleText(topic?.summary),
    participants: arrayOf(topic?.participants).map(cleanField).filter(Boolean),
  }));
  next.todos = arrayOf(next.todos)
    .map(todo => ({
      ...todo,
      owner: cleanupAiStyleText(todo?.owner),
      item: cleanupAiStyleText(todo?.item),
      deadline: cleanupAiStyleText(todo?.deadline),
    }))
    .filter(todo => isStrongGroupFollowup(todo.item, todo.owner, todo.deadline));
  next.links = arrayOf(next.links).map(link => ({
    ...link,
    title: cleanupAiStyleText(link?.title),
    summary: cleanupAiStyleText(link?.summary || link?.description || link?.context),
    from: cleanField(link?.from),
    time: cleanField(link?.time),
  }));
  next.quotes = arrayOf(next.quotes).map(quote => {
    if (typeof quote === 'string') return quote;
    return {
      ...quote,
      speaker: cleanField(quote?.speaker),
      text: cleanField(quote?.text),
      context: cleanupAiStyleText(quote?.context),
    };
  });
  return next;
}

function clonePlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? JSON.parse(JSON.stringify(value)) : {};
}

function cleanupAiStyleText(value) {
  let text = cleanPublicText(value);
  if (!text) return '';
  text = text
    .replace(/^(?:根据聊天记录|根据群聊内容|以下是(?:本次)?(?:群聊)?总结|总结如下|整体来看|综合来看|从聊天(?:内容)?看|从内容看)[：:，,\s]*/g, '')
    .replace(/本时间窗/g, '这段时间')
    .replace(/该议题/g, '这个话题')
    .replace(/主要围绕/g, '主要聊')
    .replace(/值得注意的是[，,：:]?/g, '')
    .replace(/可以看出[，,：:]?/g, '')
    .replace(/群内成员/g, '群友')
    .replace(/^进展跟踪$/g, '后续讨论')
    .replace(/^仍需确认$/g, '未确认')
    .replace(/^工具运维问题$/g, '工具使用')
    .replace(/需处理事项/g, '后续关注')
    .replace(/需处理/g, '后面可以看下')
    .replace(/仍待验证/g, '还没完全定')
    .replace(/待验证/g, '还没完全定')
    .replace(/仍待确认/g, '还没定')
    .replace(/待确认/g, '还没定')
    .replace(/持续关注/g, '后面再看')
    .replace(/聊天上下文不足，当前只能确认[:：]?/g, '前后聊天没给出更多信息，只能看出')
    .replace(/^(结果|结论|现状|风险|待确认|后续)[:：]\s*/g, '');
  return text.replace(/\s+/g, ' ').trim();
}

function assertDigestPublishable(raw = {}, context = {}) {
  const report = digestPublishabilityReport(raw, context);
  if (!report.blocked) return;
  throw httpError(
    502,
    `AI 输出未通过成品质量检查（${report.reason}）；为避免生成空洞或误导性的群总结，本次未保存。可稍后重试，或缩短时间范围再生成。`,
  );
}

function digestPublishabilityReport(raw = {}, context = {}) {
  const topics = arrayOf(raw?.topics);
  const links = arrayOf(raw?.links);
  const quotes = arrayOf(raw?.quotes);
  const highlights = arrayOf(raw?.highlights).map(cleanField).filter(Boolean);
  const effectiveTodos = arrayOf(raw?.todos).map(normalizeTodo).filter(Boolean);
  const messageCount = Number(context.messageCount || 0);
  const visibleTexts = digestQualityVisibleTexts(raw);
  const leakCount = visibleTexts.filter(text => DIGEST_FALLBACK_LEAK_RE.test(text)).length;
  const fallbackTopicCount = topics.filter(topic => DIGEST_FALLBACK_TOPIC_RE.test(`${topic?.title || ''} ${topic?.category || ''} ${topic?.summary || ''}`)).length;
  const badHeadline = DIGEST_BAD_HEADLINE_RE.test(cleanField(raw?.headline));
  const falseEmptyClaimCount = messageCount > 0
    ? visibleTexts.filter(text => DIGEST_FALSE_EMPTY_RE.test(text)).length
    : 0;
  const effectiveTopics = topics.filter(topic => cleanField(topic?.title).length >= 2 && cleanField(topic?.summary).length >= 12);
  const effectiveLinks = links.filter(link => isAnalyzableWebLinkUrl(link?.url, context));
  const effectiveQuotes = quotes.filter(quote => cleanField(typeof quote === 'string' ? quote : quote?.text).length >= 4);
  const sparse = messageCount >= 5
    && effectiveTopics.length === 0
    && effectiveLinks.length === 0
    && effectiveQuotes.length === 0
    && effectiveTodos.length === 0
    && highlights.length === 0;
  const veryThin = messageCount >= 20
    && effectiveTopics.length === 0
    && effectiveLinks.length === 0
    && effectiveQuotes.length === 0
    && effectiveTodos.length === 0
    && highlights.length < 2;
  const repeatedFallback = fallbackTopicCount >= 3 || (fallbackTopicCount >= 2 && fallbackTopicCount >= Math.ceil(Math.max(1, topics.length) * 0.25));
  const blocked = sparse || veryThin || falseEmptyClaimCount > 0 || (badHeadline && leakCount > 0) || repeatedFallback || leakCount >= 4;
  const reason = [
    sparse ? '模型返回内容过空' : '',
    veryThin ? '话题提炼不足' : '',
    falseEmptyClaimCount ? `AI 把已读取到的 ${messageCount} 条消息写成无消息` : '',
    badHeadline ? '标题像分段兜底' : '',
    leakCount ? `正文命中 ${leakCount} 处兜底/原始时间线痕迹` : '',
    fallbackTopicCount ? `${fallbackTopicCount}/${Math.max(1, topics.length)} 个话题像失败分段` : '',
  ].filter(Boolean).join('，') || '命中成品质量闸门';
  return { blocked, reason, leakCount, fallbackTopicCount, badHeadline, falseEmptyClaimCount };
}

function digestQualityVisibleTexts(raw = {}) {
  return [
    raw?.headline,
    ...arrayOf(raw?.highlights),
    ...arrayOf(raw?.topics).flatMap(item => [item?.title, item?.category, item?.summary]),
    ...arrayOf(raw?.todos).flatMap(item => [item?.owner, item?.item, item?.deadline]),
    ...arrayOf(raw?.links).flatMap(item => [item?.title, item?.summary || item?.description || item?.context]),
    ...arrayOf(raw?.quotes).flatMap(item => (typeof item === 'string' ? [item] : [item?.text, item?.context])),
  ].map(cleanField).filter(Boolean);
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

function withoutMediaBlocksForTextOnlyRetry(blocks = []) {
  return blocks.map(block => {
    if (block.kind === 'image') {
      return {
        kind: 'text',
        text: `（${block.ref || '图片/视频关键帧'}：当前 AI 端点无法直接处理该媒体或返回空内容，已改为仅按对应消息行的时间、发送人、文件名、尺寸等元信息和上下文总结；不要编造画面细节。）`,
      };
    }
    if (block.kind === 'audio') {
      return {
        kind: 'text',
        text: `（${block.ref || '音频'}：当前 AI 端点无法直接处理该媒体或返回空内容，已改为仅按对应消息行的时间、发送人、文件名、时长等元信息和上下文总结；不要编造语音内容。）`,
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
    limit: settings.llm.ai_concurrency,
  }, () => fetchJson(`${settings.llm.base_url}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.llm.api_key}` },
    body,
    timeout_ms: settings.llm.timeout_ms,
    api_key: settings.llm.api_key,
    signal,
  }));
  const choice = json?.choices?.[0] || {};
  const finishReason = String(choice.finish_reason || '').toLowerCase();
  if (finishReason === 'length' || finishReason === 'max_tokens') {
    throw httpError(502, 'Model output was truncated by token limit');
  }
  const text = choice.message?.content;
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
    limit: settings.llm.ai_concurrency,
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
  const stopReason = String(json?.stop_reason || '').toLowerCase();
  if (stopReason === 'max_tokens') {
    throw httpError(502, 'Model output was truncated by token limit');
  }
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
    .map(link => normalizeLink(link, meta))
    .filter(l => isAnalyzableWebLinkUrl(l.url, meta));
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
    links: publicDigestLinks(links, 12, meta),
    link_status: cleanDigestLinkStatus(meta.link_status),
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

function digestNeedsHumanGroupChatStyle(raw) {
  const visibleTexts = digestStyleVisibleTexts(raw);
  if (!visibleTexts.length) return false;
  let score = 0;
  for (const text of visibleTexts) {
    if (DIGEST_WORK_REPORT_RE.test(text)) score += 2;
    if (/^(?:结果|结论|现状|风险|待确认|后续)[:：]\s*/.test(text)) score += 2;
    if (/(?:下一步|行动项|责任人|处理进度|任务清单|工作汇报|OKR)/i.test(text)) score += 1;
    if (text.length >= 160 && /(?:风险|结果|结论|待确认|需处理|下一步|follow[- ]?up)/i.test(text)) score += 1;
  }

  const topics = arrayOf(raw?.topics);
  const todos = arrayOf(raw?.todos);
  const followupTopics = topics.filter(topic => !!topic?.need_followup).length;
  const weakTodos = todos.filter(todo => !isStrongGroupFollowup(todo?.item, todo?.owner, todo?.deadline)).length;
  if (todos.length >= 5) score += 2;
  else if (todos.length >= 3) score += 1;
  if (weakTodos >= 2) score += 2;
  else if (weakTodos === 1) score += 1;
  if (topics.length >= 4 && followupTopics >= Math.ceil(topics.length * 0.6)) score += 2;
  else if (followupTopics >= 3) score += 1;

  return score >= 2;
}

function digestStyleVisibleTexts(raw) {
  return [
    raw?.headline,
    ...arrayOf(raw?.highlights),
    ...arrayOf(raw?.topics).flatMap(item => [item?.title, item?.category, item?.summary]),
    ...arrayOf(raw?.todos).flatMap(item => [item?.owner, item?.item, item?.deadline]),
    ...arrayOf(raw?.links).flatMap(item => [item?.title, item?.summary || item?.description || item?.context]),
    ...arrayOf(raw?.quotes).flatMap(item => (typeof item === 'string' ? [] : [item?.context])),
  ].map(cleanField).filter(Boolean);
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

function cleanField(value) {
  return String(value || '').trim();
}

const INTERNAL_VISIBLE_ERROR_RE = /(?:_?raw_timeline|_fallback_chunk|Model returned empty content|Messages returned empty content|Encrypted content could not be decrypted|分段错误|raw timeline)/i;
const DIGEST_WORK_REPORT_RE = /(?:根据聊天记录|根据群聊内容|以下是|总结如下|整体来看|综合来看|从聊天(?:内容)?看|从内容看|值得注意的是|可以看出|本时间窗|该议题|主要围绕|需处理|待确认|仍待确认|待验证|仍待验证|持续关注|继续关注|保持关注|风险[:：]|结果[:：]|结论[:：]|现状[:：]|行动清单|工作汇报|任务清单|处理事项|进展跟踪|仍需确认|工具运维问题)/i;
const DIGEST_FALLBACK_LEAK_RE = /(?:_raw_timeline|raw_timeline|_fallback_chunk|分段兜底|原始时间线|少量消息仅保留元信息|本地文件待解封|md5=|未被模型稳定提炼|模型请求返回空内容|按分段摘要整理|无可直接附加的媒体块|时间范围：\d{4}-\d{2}-\d{2}.*?共\s*\d+\s*条消息|涉及内容：\d+\s*张图片\/视频关键帧)/i;
const DIGEST_FALLBACK_TOPIC_RE = /(?:少量消息仅保留元信息|原始时间线|待合并|失败分段|未被模型稳定提炼|无可直接附加的媒体块|本地文件待解封|md5=)/i;
const DIGEST_BAD_HEADLINE_RE = /(?:按分段摘要整理|重点见下方|原始时间线|分段摘要|分段兜底)/i;
const DIGEST_FALSE_EMPTY_RE = /(?:没有|没(?:有|什么)?|无|暂无|未见|未看到).{0,10}(?:消息|聊天内容|可总结内容|可提炼内容|有效内容|重点内容)|聊天内容为空|没有(?:可总结|可提炼|值得总结)的?(?:内容|信息|消息)/i;
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
  if (!isStrongGroupFollowup(item, owner, deadline)) return null;
  return {
    owner: isEnglishHeavyText(owner) || TODO_PLACEHOLDER_RE.test(owner) ? '' : owner,
    item,
    deadline: isEnglishHeavyText(deadline) || TODO_PLACEHOLDER_RE.test(deadline) ? '' : deadline,
  };
}

function isStrongGroupFollowup(item, owner = '', deadline = '') {
  const text = cleanField(item);
  if (!text) return false;
  if (/持续关注|继续关注|保持关注|观察|对比|评估|确认是否|验证.*稳定性|排查.*原因|优化.*速度|准备.*方案|确定.*路线/.test(text)) return false;
  if (cleanField(owner) && !TODO_PLACEHOLDER_RE.test(cleanField(owner))) return true;
  if (cleanField(deadline) && !TODO_PLACEHOLDER_RE.test(cleanField(deadline))) return true;
  if (/(?:跟进|确认|查看|处理|同步|回复|联系).{0,8}(?:报价|订单|进度|结果|问题|客户|供应商|合同|发票|报名|付款|交付|资料|链接|需求)|(?:报价|订单|进度|结果|问题|客户|供应商|合同|发票|报名|付款|交付|资料|链接|需求).{0,8}(?:跟进|确认|查看|处理|同步|回复|联系)/.test(text)) return true;
  return /报名|付款|提交|联系|交付|报销|补发|回复|注册|开通|关闭|领取|上传|发布|更新|迁移|修复|整理|收集|安排/.test(text)
    && /请|需要|要|待|明天|今天|今晚|本周|下周|尽快|继续|统一|群里|大家|管理员|负责人/.test(text);
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
  if (/github|文档|教程|链接|仓库|资料|入口|官网|下载/.test(haystack)) return '资源分享';
  if (/观点|理念|趋势|行业|能力|效率|未来|职业|工作流|认知|思考|争议|看法/.test(haystack)) return '观点讨论';
  if (/确认|跟进|修复|处理|任务|目标|goal|迁移|发布|上线|测试|排查|付款|领取|结果|待确认/.test(haystack)) return '后续讨论';
  return '聊天主线';
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

function normalizeLink(link = {}, meta = {}) {
  const url = cleanField(link.url);
  const preview = linkPreviewStatusForUrl(meta.linkPreviewStatusByUrl, url);
  const previewStatus = cleanField(link.preview_status || link.status || preview?.status || '').slice(0, 40);
  const previewError = cleanField(link.preview_error || link.error || preview?.error || '').slice(0, 160);
  const fallbackSummary = previewStatus && previewStatus !== 'ok'
    ? linkPreviewFailureSummary(previewStatus, previewError)
    : '';
  const summary = ensureLinkSummaryHasContext(cleanLinkSummary(link.summary || link.description || link.context || fallbackSummary));
  const title = cleanPublicLinkTitle(link.title) || '网页链接';
  return {
    title,
    url,
    summary,
    from: cleanField(link.from),
    time: cleanField(link.time),
    preview_status: previewStatus && previewStatus !== 'ok' ? previewStatus : '',
    preview_error: previewStatus && previewStatus !== 'ok' ? previewError : '',
  };
}

function linkPreviewStatusForUrl(map, url) {
  if (!map || !url) return null;
  const normalized = normalizeHttpUrl(url);
  if (normalized && typeof map.get === 'function') return map.get(normalized) || null;
  return typeof map.get === 'function' ? map.get(url) || null : null;
}

function linkPreviewFailureSummary(status, error) {
  if (status === 'failed') return `本程序打开该链接失败${error ? `：${error}` : ''}，未把它当成成功网页预览。`;
  return `本程序未把该链接作为普通网页预览${error ? `：${error}` : ''}。`;
}

function cleanDigestLinkStatus(value = null) {
  const status = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!status || !Number(status.links || 0)) return null;
  return {
    links: Math.max(0, Number(status.links || 0) || 0),
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
    category: '未识别消息',
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
  const status = Number(err?.status || 0);
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  const message = String(err?.message || '').toLowerCase();
  return /temporarily unavailable|temporary unavailable|service unavailable|api_error|overload|capacity|timeout|timed out|网络请求失败|服务暂时不可用|临时不可用|暂时不可用/.test(message);
}

function isLikelyChunkableFailure(err) {
  const status = Number(err?.status || 0);
  const message = String(err?.message || '').toLowerCase();
  const inputTooLarge = /context|token|too large|payload|request entity|length|maximum|max(?:imum)?\s*(?:context|tokens?|input)|上下文|输入过大|内容过长/.test(message);
  const providerConfigError = /response_format|json_schema|schema|tool_choice|unsupported|not supported|does not support|invalid (?:parameter|value|type)|unknown parameter|unrecognized|api key|authentication|permission|credentials|base url|endpoint|鉴权|权限|不支持/.test(message);
  if ([413, 414].includes(status)) return true;
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  if ([400, 422].includes(status)) return inputTooLarge && !providerConfigError;
  return inputTooLarge || /timeout|timed out|rate|overload|capacity|temporarily unavailable|service unavailable|api_error|网络请求失败|服务暂时不可用|临时不可用|暂时不可用/.test(message);
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
    && /audio|input_audio|voice|sound|speech/.test(message)
    && /unsupported|invalid.*content|content.*type|format|does not support/.test(message);
}

function isLikelyUnsupportedMediaError(err) {
  const status = Number(err?.status || 0);
  const message = String(err?.message || '').toLowerCase();
  return [400, 415, 422].includes(status)
    && /image|image_url|input_image|audio|input_audio|vision|multimodal|media|unsupported|invalid.*content|content.*type|format|does not support/.test(message);
}

function isLikelyUnsupportedWebSearchError(err) {
  const status = Number(err?.status || 0);
  const message = String(err?.message || '').toLowerCase();
  return [400, 404, 405, 415, 422, 501].includes(status)
    && /responses|web[_ -]?search|web_search_preview|tool|tools|unsupported|not supported|unknown parameter|invalid.*tool|not found|no such endpoint/.test(message);
}

function isLikelyModelWideUnsupportedMediaError(err) {
  if (!isLikelyUnsupportedMediaError(err)) return false;
  const message = String(err?.message || '').toLowerCase();
  return /model.*(?:does not support|doesn't support|not support).*?(?:image|audio|vision|multimodal|media|input_image|input_audio)/.test(message)
    || /(?:image|audio|vision|multimodal|media|input_image|input_audio).*?(?:not supported|unsupported by.*model|does not support|doesn't support)/.test(message)
    || /unsupported (?:content|media) type/.test(message)
    || /content type.*(?:not supported|unsupported)/.test(message);
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
  prepareMessagesForChunking,
  attachGlobalNearbyContexts,
  estimateMessageBundleStats,
  splitMessages,
  splitChunkForRecovery,
  openAiUserContent,
  anthropicUserContent,
  chatAudioFormatForModel,
  extractResponsesText,
  extractMessageLinkTargets,
  enrichMessagesWithLinkPreviews,
  createLinkPreviewStatus,
  recordLinkPreviewStatus,
  linkPreviewProgressDetail,
  linkPreviewStatusMap,
  isSuccessfulLinkPreview,
  isTimelineLinkPreview,
  cleanDigestLinkStatus,
  isTransientError,
  isLikelyChunkableFailure,
  isLikelyRecoverableChunkFailure,
  isModelEmptyContentError,
  isLikelyUnsupportedAudioError,
  isLikelyUnsupportedMediaError,
  isLikelyUnsupportedWebSearchError,
  isJsonParseError,
  shouldUseAiLinkResearch,
  cleanupAiStyleText,
  cleanupDigestStyleLocally,
  digestNeedsHumanGroupChatStyle,
  digestPublishabilityReport,
  assertDigestPublishable,
};
