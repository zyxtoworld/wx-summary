import { currentResolvedTheme } from '../../theme.js';

export const DIGEST_RENDERER_VERSION = 1;
export const DIGEST_RENDERER_ENGINE_BROWSER = 'browser_canvas';

export function normalizeDigestTheme(value = '') {
  const theme = String(value || '').trim().toLowerCase();
  return ['auto', 'light', 'dark'].includes(theme) ? theme : 'auto';
}
export function normalizeDigestFontSize(value = '') {
  return String(value || '').trim().toLowerCase() === 'large' ? 'large' : 'normal';
}

export function normalizeDigestAccentColor(value = '') {
  const color = String(value || '').trim().toUpperCase();
  return /^#[0-9A-F]{6}$/.test(color) ? color : '';
}

export function resolveDigestTheme(theme = 'auto', resolveTheme = currentResolvedTheme) {
  const normalized = normalizeDigestTheme(theme);
  if (normalized !== 'auto') return normalized;
  const resolved = typeof resolveTheme === 'function' ? resolveTheme() : 'light';
  return resolved === 'dark' ? 'dark' : 'light';
}

export function digestRenderPayload(selection = {}, {
  resolveTheme = currentResolvedTheme,
} = {}) {
  const source = selection && typeof selection === 'object' && !Array.isArray(selection)
    ? selection
    : {};
  const theme = resolveDigestTheme(source.theme, resolveTheme);
  return {
    theme,
    font_size: normalizeDigestFontSize(source.fontSize || source.font_size || source.fontsize),
    accent_color: normalizeDigestAccentColor(source.accentColor || source.accent_color) || '#07C160',
    renderer_version: DIGEST_RENDERER_VERSION,
    renderer_engine: DIGEST_RENDERER_ENGINE_BROWSER,
  };
}

export function freezeDigestRenderSelection(selection = {}, options = {}) {
  const payload = digestRenderPayload(selection, options);
  return {
    theme: payload.theme,
    fontSize: payload.font_size,
    accentColor: payload.accent_color,
    rendererVersion: payload.renderer_version,
    rendererEngine: payload.renderer_engine,
  };
}

export function digestRenderSelectionFromSaved(render = {}, fallback = {}, options = {}) {
  const source = render && typeof render === 'object' && !Array.isArray(render) ? render : {};
  const base = fallback && typeof fallback === 'object' && !Array.isArray(fallback) ? fallback : {};
  const theme = source.theme || base.theme || 'auto';
  const fontSize = source.fontSize || source.font_size || source.fontsize
    || base.fontSize || base.font_size || base.fontsize || 'normal';
  const accentColor = source.accentColor || source.accent_color
    || base.accentColor || base.accent_color || '';
  return freezeDigestRenderSelection({ theme, fontSize, accentColor }, options);
}

export function digestRenderPayloadKey(payload = {}, options = {}) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const normalized = digestRenderPayload(source, options);
  return JSON.stringify(normalized);
}
