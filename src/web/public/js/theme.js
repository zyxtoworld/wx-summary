// 主题管理:三态(亮 / 暗 / 跟随系统),偏好保存在 localStorage。
const THEME_STORAGE_KEY = 'wx-summary:theme';
const THEME_VALUES = new Set(['light', 'dark', 'auto']);

let mediaQuery = null;
let initialized = false;
let transientTheme = null;
const listeners = new Set();

function reportThemeListenerError(error) {
  const message = 'theme listener failed';
  const consoleTarget = globalThis.console;
  try {
    if (typeof consoleTarget?.error === 'function') {
      consoleTarget.error(message, error);
      return;
    }
  } catch {}
  try {
    if (typeof consoleTarget?.warn === 'function') {
      consoleTarget.warn(message, error);
      return;
    }
  } catch {}
  try { globalThis.reportError?.(error); } catch {}
}

export function storedTheme() {
  if (THEME_VALUES.has(transientTheme)) return transientTheme;
  try {
    const value = String(localStorage.getItem(THEME_STORAGE_KEY) || '').trim();
    return THEME_VALUES.has(value) ? value : 'auto';
  } catch {
    return THEME_VALUES.has(transientTheme) ? transientTheme : 'auto';
  }
}

export function resolvedTheme(theme = storedTheme()) {
  if (theme !== 'auto') return theme;
  try {
    return globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function applyThemeAttribute() {
  const theme = storedTheme();
  const resolved = resolvedTheme(theme);
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themeResolved = resolved;
  return { theme, resolved };
}

function notifyThemeChange(theme, resolved) {
  for (const listener of [...listeners]) {
    try { listener(theme, resolved); } catch (error) { reportThemeListenerError(error); }
  }
}

function syncThemeFromEnvironment() {
  const current = applyThemeAttribute();
  notifyThemeChange(current.theme, current.resolved);
  return current;
}

export function getTheme() {
  return storedTheme();
}

export function setTheme(value) {
  const theme = THEME_VALUES.has(String(value || '').trim()) ? String(value).trim() : 'auto';
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    transientTheme = null;
  } catch {
    // 存储不可用时仍立即应用本次选择;下次加载无法持久化,跨标签事件会清掉临时值。
    transientTheme = theme;
  }
  const current = applyThemeAttribute();
  notifyThemeChange(current.theme, current.resolved);
  return theme;
}

export function onThemeChange(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// 尽早调用:避免首屏主题闪烁。
export function initTheme() {
  applyThemeAttribute();
  if (initialized) return;
  initialized = true;
  try {
    mediaQuery = globalThis.matchMedia?.('(prefers-color-scheme: dark)') || null;
    mediaQuery?.addEventListener?.('change', () => {
      if (storedTheme() === 'auto') syncThemeFromEnvironment();
    });
  } catch {}
  try {
    globalThis.addEventListener?.('storage', event => {
      if (event?.key !== THEME_STORAGE_KEY && event?.key !== null) return;
      if (event?.storageArea && event.storageArea !== globalThis.localStorage) return;
      transientTheme = null;
      syncThemeFromEnvironment();
    });
  } catch {}
}

// 供 Canvas 长图渲染使用:返回当前实际生效的主题名。
export function currentResolvedTheme() {
  return resolvedTheme();
}
