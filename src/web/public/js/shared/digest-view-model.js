const RENDER_LINK_LIMIT = 12;
const RENDER_HIGHLIGHT_LIMIT = 6;
const RENDER_QUOTE_LIMIT = 8;
const RENDER_TODO_LIMIT = 5;

export const RENDER_TOPIC_LIMIT = 100;
export const RENDER_TOPIC_PARTICIPANT_LIMIT = 12;
export const DIGEST_RENDERER_VERSION = 1;
export const DIGEST_RENDERER_ENGINE_BROWSER = 'browser_canvas';
export const DIGEST_RENDERER_ENGINE_SERVER = 'powershell_system_drawing';

export function digestTopicCategory(topic = {}) {
  const explicit = digestRenderText(topic?.category || '');
  if (explicit && explicit.length <= 16) return explicit;
  const haystack = `${digestRenderText(topic?.title || '')} ${digestRenderText(topic?.summary || '')}`;
  if (/github|文档|教程|链接|仓库|资料|入口|官网|下载/i.test(haystack)) return '资源分享';
  if (/观点|理念|趋势|行业|能力|效率|未来|职业|工作流|认知|思考|争议|看法/.test(haystack)) return '观点讨论';
  if (/确认|跟进|修复|处理|任务|目标|goal|迁移|发布|上线|测试|排查|付款|领取|结果|待确认/i.test(haystack)) return '后续讨论';
  return '聊天主线';
}

export function groupedDigestTopics(topics = []) {
  const sections = [];
  const byLabel = new Map();
  for (const rawTopic of Array.isArray(topics) ? topics : []) {
    const topic = sanitizeDigestTopicForRender(rawTopic);
    if (!topic || typeof topic !== 'object') continue;
    const label = digestTopicCategory(topic);
    if (!byLabel.has(label)) {
      byLabel.set(label, []);
      sections.push({ label, topics: byLabel.get(label) });
    }
    byLabel.get(label).push(topic);
  }
  return sections.filter(section => section.topics.length);
}

export function firstDigestSentence(value = '') {
  const text = digestRenderText(value);
  const match = text.match(/^(.{8,90}?[。！？；;]|.{8,90})(?:\s|$)/);
  return (match?.[1] || text.slice(0, 90)).trim();
}

export function digestHighlightsForRender(digest = {}) {
  const fromDigest = Array.isArray(digest.highlights) ? digest.highlights : [];
  const fallback = [
    digest.headline,
    ...(Array.isArray(digest.topics) ? digest.topics.map(topic => firstDigestSentence(topic?.summary || topic?.title)) : []),
  ];
  const out = [];
  for (const value of [...fromDigest, ...fallback]) {
    const text = digestRenderText(value);
    if (!text || out.includes(text)) continue;
    out.push(text.length > 90 ? `${text.slice(0, 89)}…` : text);
    if (out.length >= RENDER_HIGHLIGHT_LIMIT) break;
  }
  return out;
}

export function digestQuotesForRender(digest = {}) {
  return (Array.isArray(digest.quotes) ? digest.quotes : [])
    .map(item => {
      if (typeof item === 'string') return { speaker: '', text: digestRenderText(item), context: '' };
      return sanitizeDigestQuoteForRender(item);
    })
    .filter(item => item.text)
    .slice(0, RENDER_QUOTE_LIMIT);
}

export function isSuccessfulDigestLink(link = {}) {
  const status = String(link.preview_status || link.status || '').trim().toLowerCase();
  return !status || status === 'ok';
}

export function isRenderableDigestUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (host === 'mp.weixin.qq.com' && (pathname.startsWith('/mp/wappoc_appmsgcaptcha') || pathname.startsWith('/mp/waerrpage'))) return false;
    if (host === 'support.weixin.qq.com' && (pathname.startsWith('/cgi-bin/mmsupport-bin/readtemplate') || pathname.startsWith('/update'))) return false;
    if (host === 'wxapp.tenpay.com' && pathname.startsWith('/mmpayhb/')) return false;
    return true;
  } catch {
    return false;
  }
}

export function isLowValueDigestLink(link = {}) {
  if (!link || !isRenderableDigestUrl(link.url)) return true;
  const summary = String(link.summary || '');
  if (summary.includes('该网页链接出现在本分段原始消息中；分段模型失败')) return true;
  if (summary.includes('该网页链接已保留，但当前没有可靠中文摘要')) return true;
  if (summary.includes('聊天上下文不足，当前只能确认：')
      && (/Tip|Favorites|环境异常|加载中|打开超时/.test(summary))) {
    return true;
  }
  return false;
}

export function digestLinkScore(link = {}) {
  const summary = String(link.summary || '');
  let score = 0;
  if (!isSuccessfulDigestLink(link)) score -= 20;
  if (/群里|群聊|聊天|上下文|前文|后文|发来|发出|发送|询问|讨论|针对|回应/.test(summary)) score += 8;
  if (/本程序打开该链接时返回|打开超时|加载中|环境异常|没有可靠中文摘要|分段模型失败|聊天上下文不足/.test(summary)) score -= 5;
  if (/报价|文档|官网|仓库|注册|入口|教程|新闻|快讯|公告|优惠|充值|支付|模型|API|代码|下载/.test(`${link.title || ''} ${summary}`)) score += 3;
  if (/^https?:\/\//i.test(String(link.title || '').trim())) score -= 2;
  return score;
}

export function digestLinksForRender(digest = {}) {
  return (Array.isArray(digest.links) ? digest.links : [])
    .map(link => sanitizeDigestLinkForRender(link))
    .filter(link => link && !isLowValueDigestLink(link))
    .sort((a, b) => digestLinkScore(b) - digestLinkScore(a))
    .slice(0, RENDER_LINK_LIMIT);
}

export function compactDigestUrl(value, maxChars = 130) {
  const text = digestRenderText(value);
  if (text.length <= maxChars) return text;
  try {
    const parsed = new URL(text);
    const short = `${parsed.origin}${parsed.pathname}${parsed.search ? '?...' : ''}`;
    return short.length <= maxChars ? short : `${short.slice(0, maxChars - 1)}…`;
  } catch {
    return `${text.slice(0, maxChars - 1)}…`;
  }
}

export function digestLinkTitle(link = {}) {
  const title = digestRenderText(link.title || '');
  if (title && !/^https?:\/\//i.test(title)) return title.length > 90 ? `${title.slice(0, 89)}…` : title;
  return compactDigestUrl(link.url || link.summary || '', 90);
}

export function cleanTodoMetaForRender(value) {
  const text = digestRenderText(value);
  return /^(待认领|未指定|无|暂无|不明确|待定|未定|待确认)$/.test(text) ? '' : text;
}

export function isStrongTodoForRender(todo = {}) {
  const item = digestRenderText(todo.item || '');
  if (!item) return false;
  if (/持续关注|继续关注|保持关注|观察|对比|评估|确认是否|验证.*稳定性|排查.*原因|优化.*速度|准备.*方案|确定.*路线/.test(item)) return false;
  const owner = cleanTodoMetaForRender(todo.owner);
  const deadline = cleanTodoMetaForRender(todo.deadline);
  if (owner || deadline) return true;
  return /报名|付款|提交|联系|交付|报销|补发|回复|注册|开通|关闭|领取|上传|发布|更新|迁移|修复|整理|收集|安排/.test(item)
    && /请|需要|要|待|明天|今天|今晚|本周|下周|尽快|继续|统一|群里|大家|管理员|负责人/.test(item);
}

export function digestTodosForRender(digest = {}) {
  return (Array.isArray(digest.todos) ? digest.todos : [])
    .map(todo => sanitizeDigestTodoForRender(todo))
    .filter(todo => todo && isStrongTodoForRender(todo))
    .slice(0, RENDER_TODO_LIMIT);
}

export function digestMessageFilterDetail(digest = {}) {
  const finalCount = Math.max(0, Number(digest.message_count || digest.input_message_count || 0) || 0);
  const preFilter = Math.max(0, Number(digest.pre_filter_message_count || 0) || 0);
  if (!digest.filter_active || !preFilter) return '';
  const filteredOut = Math.max(0, Number(digest.filtered_out_message_count || 0) || (preFilter > finalCount ? preFilter - finalCount : 0));
  return filteredOut
    ? `筛选前 ${preFilter} 条，筛选后 ${finalCount} 条，过滤 ${filteredOut} 条`
    : `筛选前 ${preFilter} 条，筛选后 ${finalCount} 条`;
}

export function digestTruncatedDetail(digest = {}) {
  if (!digest.truncated) return '';
  return `已从 ${digest.scanned_message_count || digest.message_count || 0} 条中截取 ${digest.input_message_count || digest.message_count || 0} 条`;
}

export function digestMessageCountLabel(digest = {}, unit = '条消息') {
  const count = Math.max(0, Number(digest.message_count || digest.input_message_count || 0) || 0);
  return count > 0 ? `${count} ${String(unit || '条消息').trim() || '条消息'}` : '消息数未记录';
}

export function digestMessageCountRow(digest = {}) {
  const details = [digestMessageFilterDetail(digest), digestTruncatedDetail(digest)].filter(Boolean);
  const countLabel = digestMessageCountLabel(digest, '条');
  const base = countLabel === '消息数未记录' ? '消息：未记录' : `消息：${countLabel}`;
  return `${base}${details.length ? `；${details.join('；')}` : ''}`;
}

export function digestSourceSuffix(digest = {}, separator = ' · ') {
  const details = [digestMessageFilterDetail(digest), digestTruncatedDetail(digest)].filter(Boolean);
  return details.length ? `${separator}${details.join(separator)}` : '';
}

export function digestMediaStatusRow(mediaStatus = null) {
  if (!mediaStatus || typeof mediaStatus !== 'object') return '';
  const mediaMessages = Number(mediaStatus.media_messages || 0);
  const metadataOnly = Number(mediaStatus.metadata_only || 0);
  const attached = Number(mediaStatus.attached || 0);
  if (!mediaMessages) return '';
  return metadataOnly
    ? `媒体：${mediaMessages} 条，其中 ${metadataOnly} 条仅按元信息总结${attached ? `，${attached} 条已附给 AI` : ''}`
    : `媒体：${mediaMessages} 条，均已附给 AI 或按可用内容处理`;
}

export function digestMediaModelStatusRow(status = null) {
  if (!status || typeof status !== 'object' || status.fallback_to_text !== true) return '';
  const imageCount = Math.max(0, Number(status.image_count || 0) || 0);
  const audioCount = Math.max(0, Number(status.audio_count || 0) || 0);
  if (!imageCount && !audioCount) return '';
  const parts = [
    imageCount ? `${imageCount} 张图片/视频关键帧` : '',
    audioCount ? `${audioCount} 条语音/音频` : '',
  ].filter(Boolean).join('、');
  return `AI 媒体：${parts}未被模型可靠识别，本次只按文件名、时长、尺寸等元信息和聊天上下文总结`;
}

export function digestLinkStatusRow(linkStatus = null) {
  if (!linkStatus || typeof linkStatus !== 'object') return '';
  const links = Number(linkStatus.links || 0);
  if (!links) return '';
  const parts = [
    `链接：处理 ${Number(linkStatus.processed || 0)}/${links}`,
    `成功 ${Number(linkStatus.succeeded || 0)}`,
  ];
  const failed = Number(linkStatus.failed || 0);
  const skipped = Number(linkStatus.skipped || 0);
  if (failed) parts.push(`失败 ${failed}`);
  if (skipped) parts.push(`跳过 ${skipped}`);
  const aiRequested = Number(linkStatus.ai_research_requested || 0);
  if (aiRequested) parts.push(`AI 查链 ${Number(linkStatus.ai_researched || 0)}/${aiRequested}`);
  if (linkStatus.ai_research_skipped) parts.push('AI 查链已跳过');
  const failedBatches = Number(linkStatus.ai_research_failed_batches || 0);
  if (failedBatches) parts.push(`AI 查链失败 ${failedBatches} 批`);
  return parts.join('，');
}

export function digestDataRows(digest = {}) {
  const renderedLinks = digestLinksForRender(digest);
  const renderedTodos = digestTodosForRender(digest);
  const mediaRow = digestMediaStatusRow(digest.media_status);
  const mediaModelRow = digestMediaModelStatusRow(digest.media_model_status);
  const linkRow = digestLinkStatusRow(digest.link_status);
  return [
    `时间：${digest.since || '未知'} ~ ${digest.until || 'now'}`,
    digestMessageCountRow(digest),
    mediaRow,
    mediaModelRow,
    linkRow,
    `内容：${Array.isArray(digest.topics) ? digest.topics.length : 0} 条聊天主线，${renderedLinks.length} 个链接资料，${renderedTodos.length} 个后续关注，${digestQuotesForRender(digest).length} 条群里金句`,
    `来源：${digest.source_label || '本机数据'}；模型：${digest.model || '未记录'}`,
  ].filter(Boolean);
}

export function digestRenderViewModel(digest = {}) {
  const source = sanitizeDigestForRender(digest);
  const topicSections = groupedDigestTopics(source.topics || []);
  const links = digestLinksForRender(source);
  const todos = digestTodosForRender(source);
  const quotes = digestQuotesForRender(source);
  const highlights = digestHighlightsForRender(source);
  return {
    topicSections,
    highlights,
    links,
    todos,
    quotes,
    coverageRows: digestDataRows(source),
  };
}

export function normalizeDigestForRender(digest = {}) {
  const source = sanitizeDigestForRender(digest);
  const view = digestRenderViewModel(source);
  return {
    ...source,
    highlights: view.highlights,
    quotes: view.quotes,
    links: view.links,
    todos: view.todos,
    __topic_sections: view.topicSections,
    __render_links: view.links,
    __render_todos: view.todos,
    __render_quotes: view.quotes,
    __coverage_rows: view.coverageRows,
    __message_count_label: digestMessageCountLabel(source),
  };
}

export function digestRenderText(value = '') {
  return redactMarkdownSecrets(String(value || '')).replace(/\r\n/g, '\n').trim();
}

function sanitizeDigestStringListForRender(values = []) {
  return (Array.isArray(values) ? values : []).map(value => digestRenderText(value)).filter(Boolean);
}

function sanitizeDigestTopicForRender(topic = {}) {
  if (!topic || typeof topic !== 'object' || Array.isArray(topic)) return null;
  const safe = sanitizeDigestValueForRender(topic);
  return {
    ...safe,
    title: digestRenderText(topic.title || ''),
    category: digestRenderText(topic.category || ''),
    summary: digestRenderText(topic.summary || ''),
    participants: sanitizeDigestStringListForRender(topic.participants).slice(0, RENDER_TOPIC_PARTICIPANT_LIMIT),
    need_followup: topic.need_followup === true,
  };
}

function sanitizeDigestLinkForRender(link = {}) {
  if (!link || typeof link !== 'object' || Array.isArray(link)) return null;
  const safe = sanitizeDigestValueForRender(link);
  return {
    ...safe,
    title: digestRenderText(link.title || ''),
    url: digestRenderText(link.url || ''),
    summary: digestRenderText(link.summary || ''),
    from: digestRenderText(link.from || ''),
    time: digestRenderText(link.time || ''),
    preview_error: digestRenderText(link.preview_error || ''),
  };
}

function sanitizeDigestTodoForRender(todo = {}) {
  if (!todo || typeof todo !== 'object' || Array.isArray(todo)) return null;
  const safe = sanitizeDigestValueForRender(todo);
  return {
    ...safe,
    item: digestRenderText(todo.item || ''),
    owner: digestRenderText(todo.owner || ''),
    deadline: digestRenderText(todo.deadline || ''),
  };
}

function sanitizeDigestQuoteForRender(quote = {}) {
  if (!quote || typeof quote !== 'object' || Array.isArray(quote)) return null;
  const safe = sanitizeDigestValueForRender(quote);
  return {
    ...safe,
    speaker: digestRenderText(quote.speaker || quote.from || quote.sender || ''),
    text: digestRenderText(quote.text || quote.quote || quote.content || ''),
    context: digestRenderText(quote.context || quote.reason || ''),
  };
}

export function sanitizeDigestForRender(digest = {}) {
  const source = digest && typeof digest === 'object' && !Array.isArray(digest) ? digest : {};
  const safeSource = sanitizeDigestValueForRender(source);
  return {
    ...safeSource,
    group: digestRenderText(source.group || ''),
    group_name: digestRenderText(source.group_name || ''),
    source_label: digestRenderText(source.source_label || ''),
    since: digestRenderText(source.since || ''),
    until: digestRenderText(source.until || ''),
    model: digestRenderText(source.model || ''),
    headline: digestRenderText(source.headline || ''),
    created_at: digestRenderText(source.created_at || ''),
    highlights: sanitizeDigestStringListForRender(source.highlights),
    topics: (Array.isArray(source.topics) ? source.topics : [])
      .map(sanitizeDigestTopicForRender)
      .filter(Boolean)
      .slice(0, RENDER_TOPIC_LIMIT),
    links: (Array.isArray(source.links) ? source.links : []).map(sanitizeDigestLinkForRender).filter(Boolean),
    todos: (Array.isArray(source.todos) ? source.todos : []).map(sanitizeDigestTodoForRender).filter(Boolean),
    quotes: (Array.isArray(source.quotes) ? source.quotes : []).map(item => (
      typeof item === 'string'
        ? digestRenderText(item)
        : sanitizeDigestQuoteForRender(item)
    )).filter(Boolean),
  };
}

function sanitizeDigestValueForRender(value) {
  if (typeof value === 'string') return digestRenderText(value);
  if (Array.isArray(value)) return value.map(item => sanitizeDigestValueForRender(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeDigestValueForRender(item)]));
}

const SENSITIVE_URL_QUERY_KEY_RE = /(?:^|[_-])(?:token|access[_-]?token|auth|authorization|credential|credentials|signature|sig|secret|api[_-]?key|apikey|key|password|passwd|pwd|session|sid|jwt|code|ticket|policy|share[_-]?token|download[_-]?token|security[_-]?token|ossaccesskeyid|x[_-]?amz[_-]?(?:signature|credential|security[_-]?token|expires|date)|awsaccesskeyid|expires?)(?:$|[_-])/i;
const JWT_LIKE_VALUE_RE = /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function cleanMarkdownUrlCandidate(value = '') {
  let text = String(value || '').trim();
  while (/[),.;:!?，。；：！？、》”’\]}]+$/.test(text)) text = text.slice(0, -1);
  return text;
}

function normalizeMarkdownHttpUrl(value = '') {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return '';
  }
}

function markdownUrlQueryParamSensitive(key = '', value = '') {
  return SENSITIVE_URL_QUERY_KEY_RE.test(String(key || ''))
    || JWT_LIKE_VALUE_RE.test(String(value || '').trim());
}

function redactSensitiveMarkdownUrl(value = '') {
  const normalized = normalizeMarkdownHttpUrl(value);
  if (!normalized) return String(value || '').trim();
  try {
    const parsed = new URL(normalized);
    let changed = false;
    const nextParams = new URLSearchParams();
    for (const [key, val] of parsed.searchParams.entries()) {
      if (markdownUrlQueryParamSensitive(key, val)) {
        nextParams.append(key, 'redacted');
        changed = true;
      } else {
        nextParams.append(key, val);
      }
    }
    if (!changed) return normalized;
    parsed.search = nextParams.toString();
    return parsed.href;
  } catch {
    return normalized;
  }
}

function redactSensitiveMarkdownUrlsInText(value = '') {
  return String(value || '').replace(/https?:\/\/[^\s<>"'`]+/gi, raw => {
    const cleaned = cleanMarkdownUrlCandidate(raw);
    return `${redactSensitiveMarkdownUrl(cleaned)}${raw.slice(cleaned.length)}`;
  });
}

function redactMarkdownSecrets(value = '') {
  const redacted = String(value || '')
    .replace(/data:[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, '[redacted-data-url]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-[redacted]')
    .replace(/\b(?:[a-fA-F0-9]{192}|[a-fA-F0-9]{160}|[a-fA-F0-9]{128}|[a-fA-F0-9]{96}|[a-fA-F0-9]{64})\b/g, '[redacted-hex-secret]');
  return redactSensitiveMarkdownUrlsInText(redacted);
}

export function markdownText(value = '') {
  return redactMarkdownSecrets(value).slice(0, 1200).replace(/\r\n/g, '\n').trim();
}

export function markdownList(values = []) {
  return (Array.isArray(values) ? values : [])
    .map(item => markdownText(item))
    .filter(Boolean);
}

export function markdownTopicTitle(topic = {}, index = 0) {
  const title = markdownText(topic.title || topic.category || `主题 ${index + 1}`);
  return `${index + 1}. ${title}`;
}

export function markdownDigestLinkTitle(link = {}) {
  return markdownText(link.title || link.url || '链接');
}

export function markdownDigestUrl(url = '') {
  return redactSensitiveMarkdownUrl(String(url || '').replace(/[<>\s]/g, '').trim());
}

export function digestHighlightsForMarkdown(digest = {}) {
  return digestHighlightsForRender(digest).map(item => markdownText(item)).filter(Boolean);
}

export function digestQuotesForMarkdown(digest = {}) {
  return digestQuotesForRender(digest)
    .map(item => ({
      speaker: markdownText(item?.speaker || ''),
      text: markdownText(item?.text || ''),
      context: markdownText(item?.context || ''),
    }))
    .filter(item => item.text)
    .slice(0, RENDER_QUOTE_LIMIT);
}

export function digestLinksForMarkdown(digest = {}) {
  return (Array.isArray(digest.links) ? digest.links : [])
    .map(link => (link && typeof link === 'object' ? { ...link, url: link.url || link.final_url || '' } : null))
    .filter(link => link && !isLowValueDigestLink(link))
    .sort((a, b) => digestLinkScore(b) - digestLinkScore(a))
    .slice(0, RENDER_LINK_LIMIT);
}

export function compactDigestMarkdownUrl(value = '', maxChars = 130) {
  return compactDigestUrl(markdownDigestUrl(value), maxChars);
}

export function digestMarkdownLinkTitle(link = {}) {
  const title = markdownText(link.title || '');
  if (title && !/^https?:\/\//i.test(title)) return title.length > 90 ? `${title.slice(0, 89)}…` : title;
  return compactDigestMarkdownUrl(link.url || link.summary || '', 90);
}

export function cleanTodoMetaForMarkdown(value = '') {
  return cleanTodoMetaForRender(markdownText(value));
}

export function isStrongTodoForMarkdown(todo = {}) {
  return isStrongTodoForRender({
    ...todo,
    owner: markdownText(todo?.owner || ''),
    item: markdownText(todo?.item || ''),
    deadline: markdownText(todo?.deadline || ''),
  });
}

export function digestTodosForMarkdown(digest = {}) {
  return digestTodosForRender(digest)
    .map(todo => ({
      ...todo,
      owner: markdownText(todo?.owner || ''),
      item: markdownText(todo?.item || ''),
      deadline: markdownText(todo?.deadline || ''),
    }))
    .filter(todo => todo.item)
    .slice(0, RENDER_TODO_LIMIT);
}

export function digestDataRowsForMarkdown(digest = {}) {
  return digestDataRows(digest).map(row => markdownText(row)).filter(Boolean);
}

export function digestMarkdown(digest = {}) {
  const d = digest && typeof digest === 'object' && !Array.isArray(digest) ? digest : {};
  const group = markdownText(d.group || '历史摘要');
  const headline = markdownText(d.headline);
  const highlights = digestHighlightsForMarkdown(d).filter(item => item !== headline);
  const topicSections = groupedDigestTopics(d.topics || []);
  const links = digestLinksForMarkdown(d);
  const quotes = digestQuotesForMarkdown(d);
  const todos = digestTodosForMarkdown(d);
  const source = markdownText(d.source_label || '');
  const sourceSuffix = digestSourceSuffix(d);
  const lines = [
    `# ${group}`,
    '',
    `${markdownText(d.since)} ~ ${markdownText(d.until)} · ${digestMessageCountLabel(d)} · ${markdownText(d.model) || '未记录'}`,
  ];
  if (source || sourceSuffix) lines.push(`${source || '本机数据'}${sourceSuffix}`);
  lines.push('', '## 群聊速览');
  if (headline) lines.push(headline);
  for (const item of highlights) lines.push(`- ${item}`);
  for (const section of topicSections) {
    lines.push('', `## ${markdownText(section.label) || '聊天主线'}`);
    section.topics.forEach((topic, index) => {
      const title = markdownText(topic.title || topic.category || `主题 ${index + 1}`);
      const participants = markdownList(topic.participants);
      const summary = markdownText(topic.summary || topic.text || '');
      const body = [
        `${index + 1}. ${title}`,
        participants.length ? `   参与：${participants.join('、')}` : '',
        summary ? `   ${summary}` : '',
      ].filter(Boolean).join('\n');
      if (body) lines.push(body);
      if (index < section.topics.length - 1) lines.push('');
    });
  }
  if (links.length) {
    lines.push('', '## 链接资料');
    for (const link of links) {
      if (!link || typeof link !== 'object') continue;
      const parts = [digestMarkdownLinkTitle(link)];
      const summary = markdownText(link.summary || link.description || '');
      const linkUrl = compactDigestMarkdownUrl(link.url || link.final_url || '');
      if (summary) parts.push(`：${summary}`);
      if (linkUrl) parts.push(` <${linkUrl}>`);
      const from = markdownText(link.from);
      const time = markdownText(link.time);
      if (from) parts.push(` 发送人：${from}`);
      if (time) parts.push(` 时间：${time}`);
      lines.push(`- ${parts.join('')}`);
    }
  }
  if (quotes.length) {
    lines.push('', '## 群里金句');
    for (const quote of quotes) {
      const speaker = markdownText(quote.speaker);
      const text = markdownText(quote.text);
      const context = markdownText(quote.context);
      if (text) lines.push(`- ${speaker ? `${speaker}：` : ''}${text}${context ? `（${context}）` : ''}`);
    }
  }
  if (todos.length) {
    lines.push('', '## 后续关注');
    for (const todo of todos) {
      const item = markdownText(todo.item);
      if (!item) continue;
      const owner = cleanTodoMetaForMarkdown(todo.owner);
      const deadline = cleanTodoMetaForMarkdown(todo.deadline);
      lines.push(`- ${owner ? `${owner}：` : ''}${item}${deadline ? `（${deadline}）` : ''}`);
    }
  }
  lines.push('', '## 数据概览');
  for (const row of digestDataRowsForMarkdown(d)) lines.push(`- ${row}`);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function digestMarkdownForDigests(digests = []) {
  return (Array.isArray(digests) ? digests : []).filter(Boolean).map(digestMarkdown).join('\n\n---\n\n');
}
