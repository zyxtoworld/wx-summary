const INVALID_BASE_URL_MESSAGE = 'Base URL 必须是 http(s) URL,且不能包含用户名、密码、query 或 fragment,例如 https://api.example.com/v1。';

export function validateAiBaseUrl(value) {
  const raw = String(value || '').trim();
  const normalized = canonicalAiBaseUrl(raw);
  if (!normalized) {
    return { ok: false, message: INVALID_BASE_URL_MESSAGE };
  }
  return { ok: true, value: normalized };
}

export function normalizeAiBaseUrl(value) {
  return validateAiBaseUrl(value).value || '';
}

function canonicalAiBaseUrl(raw) {
  if (!raw || /[?#]/.test(raw)) return '';
  try {
    const url = new URL(raw);
    const authorityMatch = raw.match(/^https?:\/\/([^\/?#]*)/i);
    const authority = authorityMatch?.[1] || '';
    if (!['http:', 'https:'].includes(url.protocol)
      || !url.hostname
      || !authorityMatch
      || !authority
      || authority.includes('@')
      || url.username
      || url.password) return '';
    const pathname = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${pathname}`;
  } catch {
    return '';
  }
}
