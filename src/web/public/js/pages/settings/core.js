// 设置页共享工具:DOM 小助手、时长/数字解析、账号上下文、下载与状态文案。
// 仅页面内部使用;不修改任何共享模块。
import { isMutationOutcomeUnknown } from '/js/api.js';
export {
  canonicalWhitelistRef,
  whitelistRefKey,
  whitelistRefLabel,
  groupRefFromGroup,
  groupDisplayName,
} from '/js/shared/whitelist-contract.js';

// 创建元素。attrs 支持:text / class / html(不用,避免注入) / value / type 等特性与 on* 事件。
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null) continue;
    if (key === 'text') node.textContent = String(value);
    else if (key === 'class') node.className = String(value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (typeof value === 'boolean') { if (value) node.setAttribute(key, ''); }
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

// 本地动作 ID 使用服务端接受的稳定格式。
export function createLocalActionId(kind = 'action') {
  const cleanKind = String(kind || 'action').replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'action';
  const bytes = new Uint8Array(6);
  try { globalThis.crypto?.getRandomValues?.(bytes); } catch {}
  const random = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('')
    || Math.random().toString(16).slice(2, 14);
  return `${cleanKind}_${Date.now().toString(36)}_${random}`;
}

// 微信验证进度 ID:须匹配服务端 /^[a-zA-Z0-9_-]{8,80}$/。
export function createWechatStatusProgressId() {
  if (globalThis.crypto?.randomUUID) {
    return `wst_${globalThis.crypto.randomUUID().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48)}`;
  }
  const bytes = new Uint8Array(8);
  try { globalThis.crypto?.getRandomValues?.(bytes); } catch {}
  const random = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('')
    || Math.random().toString(16).slice(2, 18);
  return `wst_${Date.now().toString(36)}_${random}`;
}

// ---------------------------------------------------------------------------
// 时长控件(与后端 durationToMs 对齐:^\d+\s*[mhd]$,上限 24d)
// ---------------------------------------------------------------------------
export const DURATION_MAX_MS = 24 * 86_400_000;

export function durationToMs(value) {
  const match = String(value || '').trim().match(/^(\d+)\s*([mhd])$/i);
  if (!match) return 0;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const unit = match[2].toLowerCase();
  const scale = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * scale;
}

export function msToDurationParts(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (!value) return { amount: '', unit: 'm' };
  if (value % 86_400_000 === 0) return { amount: String(value / 86_400_000), unit: 'd' };
  if (value % 3_600_000 === 0) return { amount: String(value / 3_600_000), unit: 'h' };
  return { amount: String(Math.max(1, Math.round(value / 60_000))), unit: 'm' };
}

export function parseDurationText(value) {
  const parts = msToDurationParts(0);
  const match = String(value || '').trim().toLowerCase().match(/^(\d+)\s*([mhd])$/);
  if (!match) return { ...parts, text: '' };
  return { amount: match[1], unit: match[2], text: `${Number(match[1])}${match[2]}` };
}

// ---------------------------------------------------------------------------
// 账号上下文(设置保存/密钥操作需要绑定当前账号)
// ---------------------------------------------------------------------------
export function accountIdOf(account) {
  return String(account?.id || account?.account_id || '').trim();
}

export function accountFingerprintOf(account) {
  return String(account?.manual_key_account_fingerprint || '').trim().toLowerCase();
}

export function accountAliasesOf(account) {
  const aliases = Array.isArray(account?.account_aliases) ? account.account_aliases : [];
  return [...new Set([accountIdOf(account), ...aliases]
    .map(value => String(value || '').trim())
    .filter(Boolean))];
}

// PUT /api/settings 的账号上下文;无账号时返回 null(调用方应阻止提交)。
export function settingsRequestContext(account) {
  const accountId = accountIdOf(account);
  if (!accountId) return null;
  const fingerprint = accountFingerprintOf(account);
  return {
    account_id: accountId,
    account_aliases: accountAliasesOf(account),
    ...(fingerprint ? {
      account_fingerprint: fingerprint,
      expected_account_fingerprint: fingerprint,
    } : {}),
  };
}

// ---------------------------------------------------------------------------
// 展示格式化
// ---------------------------------------------------------------------------
export function fmtDateTime(value, { empty = '—' } = {}) {
  const text = String(value || '').trim();
  if (!text) return empty;
  const ms = Number.isFinite(Number(text)) && Number(text) > 1e12 ? Number(text) : Date.parse(text);
  if (!Number.isFinite(ms) || ms <= 0) return empty;
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtIntervalMs(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (!value) return '—';
  if (value % 86_400_000 === 0) return `${value / 86_400_000} 天`;
  if (value % 3_600_000 === 0) return `${value / 3_600_000} 小时`;
  if (value % 60_000 === 0) return `${value / 60_000} 分钟`;
  return `${Math.round(value / 1000)} 秒`;
}

export function fmtBytes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// 浏览器内下载(JSON / Markdown)
// ---------------------------------------------------------------------------
export function downloadTextFile(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  let anchor = null;
  try {
    anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    try { anchor?.remove(); } catch {}
    setTimeout(() => {
      try { URL.revokeObjectURL(url); } catch {}
    }, 10_000);
  }
}

// ---------------------------------------------------------------------------
// 状态行小部件:每个操作区一个,带 ok/warn/err 级别
// ---------------------------------------------------------------------------
export function createStatusLine() {
  const node = el('div', { class: 'settings-status', role: 'status' });
  return {
    el: node,
    set(text = '', level = '') {
      node.textContent = text;
      node.classList.toggle('ok', level === 'ok');
      node.classList.toggle('warn', level === 'warn');
      node.classList.toggle('err', level === 'err');
    },
    clear() { this.set('', ''); },
  };
}

// 错误摘要:保留服务端中文文案;网络/超时写操作标注“结果未知”。
export function errorText(error, fallback = '操作失败') {
  if (!error) return fallback;
  if (isMutationOutcomeUnknown(error)) {
    return `${error.message || '请求超时或断连'}(结果未知,请核对后再决定是否重试)`;
  }
  return String(error.message || fallback);
}

export function isAbortError(error) {
  return error?.name === 'AbortError' || error?.status === 499;
}
