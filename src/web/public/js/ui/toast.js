// 右上角滑入的通知条。type: info | success | warn | error。
const TYPE_LABEL = { info: '提示', success: '成功', warn: '注意', error: '错误' };
const MOBILE_SIDEBAR_MAX_WIDTH = 760;
const DEFAULT_TOAST_TOP = 16;
const MOBILE_SIDEBAR_GAP = 8;

export function toastViewportTop({
  viewportWidth = 0,
  sidebarBottom = 0,
  accountMenuBottom = 0,
} = {}) {
  const width = Number(viewportWidth);
  const bottom = Math.max(Number(sidebarBottom) || 0, Number(accountMenuBottom) || 0);
  if (Number.isFinite(width)
    && width > 0
    && width <= MOBILE_SIDEBAR_MAX_WIDTH
    && Number.isFinite(bottom)
    && bottom > 0) {
    return Math.ceil(bottom + MOBILE_SIDEBAR_GAP);
  }
  return DEFAULT_TOAST_TOP;
}

export function syncToastViewportOffset(root = globalThis.document?.getElementById?.('toast-root')) {
  if (!root) return;
  const sidebarBottom = globalThis.document?.querySelector?.('.sidebar')?.getBoundingClientRect?.().bottom || 0;
  const accountMenu = globalThis.document?.querySelector?.('.account-menu');
  const accountMenuBottom = accountMenu && accountMenu.hidden !== true
    ? accountMenu.getBoundingClientRect?.().bottom || 0
    : 0;
  root.style.setProperty('--toast-top', `${toastViewportTop({
    viewportWidth: globalThis.innerWidth,
    sidebarBottom,
    accountMenuBottom,
  })}px`);
}

function toastRoot() {
  let root = document.getElementById('toast-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'toast-root';
    root.className = 'toast-root';
    document.body.appendChild(root);
  }
  syncToastViewportOffset(root);
  if (root.dataset.viewportOffsetBound !== 'true') {
    root.dataset.viewportOffsetBound = 'true';
    globalThis.addEventListener?.('resize', () => syncToastViewportOffset(root), { passive: true });
  }
  return root;
}

function adjacentToastClose(toastEl) {
  let sibling = toastEl?.nextElementSibling || null;
  while (sibling) {
    const close = sibling.querySelector?.('.toast-close');
    if (close) return close;
    sibling = sibling.nextElementSibling;
  }
  sibling = toastEl?.previousElementSibling || null;
  while (sibling) {
    const close = sibling.querySelector?.('.toast-close');
    if (close) return close;
    sibling = sibling.previousElementSibling;
  }
  return null;
}

function toastIsLeaving(closeEl) {
  let owner = closeEl?.parentElement || null;
  while (owner) {
    const classes = String(owner.className || '').split(/\s+/).filter(Boolean);
    if (classes.includes('toast')) return classes.includes('toast-leaving');
    owner = owner.parentElement || null;
  }
  return false;
}

export function toast(message, { type = 'info', duration = 3600 } = {}) {
  const text = String(message || '').trim();
  if (!text) return null;
  const root = toastRoot();
  const normalizedType = TYPE_LABEL[type] ? type : 'info';
  const el = document.createElement('div');
  el.className = `toast toast-${normalizedType}`;
  el.setAttribute('role', normalizedType === 'error' ? 'alert' : 'status');
  el.setAttribute('aria-live', normalizedType === 'error' ? 'assertive' : 'polite');
  el.setAttribute('aria-atomic', 'true');

  const dot = document.createElement('span');
  dot.className = 'toast-dot';
  dot.setAttribute('aria-hidden', 'true');

  const body = document.createElement('div');
  body.className = 'toast-body';
  const label = document.createElement('strong');
  label.textContent = TYPE_LABEL[type] || TYPE_LABEL.info;
  const textEl = document.createElement('span');
  textEl.textContent = text;
  body.append(label, textEl);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', '关闭通知');
  close.textContent = '×';

  el.append(dot, body, close);
  root.appendChild(el);

  let removed = false;
  let autoDismissTimer = null;
  const dismiss = () => {
    if (removed) return;
    removed = true;
    if (autoDismissTimer !== null) {
      clearTimeout(autoDismissTimer);
      autoDismissTimer = null;
    }
    const restoreFocus = el.contains(document.activeElement);
    const focusTarget = restoreFocus ? adjacentToastClose(el) : null;
    el.classList.add('toast-leaving');
    setTimeout(() => {
      el.remove();
      if (!focusTarget?.isConnected || toastIsLeaving(focusTarget)) return;
      if (document.activeElement !== document.body
        && document.activeElement !== document.documentElement) return;
      focusTarget.focus({ preventScroll: false });
    }, 180);
  };
  close.addEventListener('click', dismiss);
  const ms = Math.max(0, Number(duration) || 0);
  if (ms > 0) {
    autoDismissTimer = setTimeout(() => {
      autoDismissTimer = null;
      dismiss();
    }, ms);
  }
  return { dismiss, el };
}

export const toastSuccess = (message, options = {}) => toast(message, { ...options, type: 'success' });
export const toastWarn = (message, options = {}) => toast(message, { ...options, type: 'warn' });
export const toastError = (message, options = {}) => toast(message, { ...options, type: 'error' });
