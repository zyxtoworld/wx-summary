import { historyStorageKeys } from './storage.js';

const FILTERS = new Set(['ok', 'issues', 'all']);
const ACCOUNT_SCOPES = new Set(['current', 'all']);
const FOCUS_ACTIONS = new Set(['card', 'related-markdown']);

function boundedText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

export function normalizeHistoryViewState(value = {}) {
  const focusKey = boundedText(value?.focusKey, 1024);
  const requestedAction = boundedText(value?.focusAction, 64);
  return {
    filter: FILTERS.has(value?.filter) ? value.filter : 'ok',
    accountScope: ACCOUNT_SCOPES.has(value?.accountScope) ? value.accountScope : 'current',
    q: boundedText(value?.q, 200),
    focusKey,
    focusAction: focusKey && FOCUS_ACTIONS.has(requestedAction) ? requestedAction : '',
  };
}

export function createHistoryViewStateStorage({
  storage = globalThis.localStorage,
  keys = historyStorageKeys(),
} = {}) {
  const key = String(keys?.view || '').trim();

  return {
    read() {
      if (!storage || !key) return null;
      try {
        const raw = storage.getItem(key);
        return raw ? normalizeHistoryViewState(JSON.parse(raw)) : null;
      } catch {
        try { storage.removeItem(key); } catch {}
        return null;
      }
    },

    write(value) {
      if (!storage || !key) return false;
      try {
        storage.setItem(key, JSON.stringify(normalizeHistoryViewState(value)));
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function historyListFocusSnapshot(container, activeElement = globalThis.document?.activeElement) {
  if (!container || !activeElement || !container.contains?.(activeElement)) return null;
  const target = activeElement.closest?.('[data-history-focus-key]');
  if (!target || !container.contains?.(target)) return null;
  const focusKey = boundedText(target.dataset?.historyFocusKey, 1024);
  const focusAction = boundedText(target.dataset?.historyFocusAction, 64);
  if (!focusKey || !FOCUS_ACTIONS.has(focusAction)) return null;
  return { focusKey, focusAction };
}

export function historyInitialFocusCanRestore({
  activeElement = globalThis.document?.activeElement,
  pageTitle = null,
  body = globalThis.document?.body,
  documentElement = globalThis.document?.documentElement,
} = {}) {
  return !activeElement
    || activeElement === pageTitle
    || activeElement === body
    || activeElement === documentElement
    || activeElement.isConnected === false;
}

export function findHistoryFocusTarget(container, focusKey, focusAction) {
  const key = boundedText(focusKey, 1024);
  const action = boundedText(focusAction, 64);
  if (!container || !key || !FOCUS_ACTIONS.has(action)) return null;
  return [...container.querySelectorAll('[data-history-focus-key]')]
    .find(candidate => String(candidate.dataset?.historyFocusKey || '') === key
      && String(candidate.dataset?.historyFocusAction || '') === action) || null;
}

export async function restoreHistoryListFocus({
  focusKey,
  focusAction,
  findTarget,
  canLoadMore,
  loadMore,
  focusHeading,
  isActive = () => true,
  maxLoads = 100,
} = {}) {
  const key = boundedText(focusKey, 1024);
  const action = boundedText(focusAction, 64);
  if (!key || !FOCUS_ACTIONS.has(action) || typeof findTarget !== 'function') {
    return { status: 'none', loadedPages: 0 };
  }

  let loadedPages = 0;
  while (true) {
    if (isActive() === false) return { status: 'cancelled', loadedPages };
    const target = findTarget(key, action);
    if (target && typeof target.focus === 'function') {
      target.focus({ preventScroll: false });
      return { status: 'restored', loadedPages };
    }
    if (loadedPages >= Math.max(0, Number(maxLoads) || 0)
      || typeof canLoadMore !== 'function'
      || !canLoadMore()
      || typeof loadMore !== 'function') break;
    if (await loadMore() !== true) break;
    if (isActive() === false) return { status: 'cancelled', loadedPages };
    loadedPages += 1;
  }

  if (isActive() === false) return { status: 'cancelled', loadedPages };
  if (typeof focusHeading === 'function') focusHeading();
  return { status: 'missing', loadedPages };
}

export function restoreHistoryPaginationFocus({
  trigger,
  container,
  firstNewIndex = 0,
  documentTarget = globalThis.document,
  focusHeading = null,
} = {}) {
  if (!trigger || !documentTarget) return 'none';
  const active = documentTarget.activeElement;
  const shouldRestore = !active
    || active === trigger
    || active === documentTarget.body
    || active === documentTarget.documentElement
    || active.isConnected === false;
  if (!shouldRestore) return 'preserved';

  if (trigger.isConnected !== false && trigger.hidden !== true && trigger.disabled !== true) {
    trigger.focus?.({ preventScroll: true });
    return 'trigger';
  }

  const cards = [...(container?.querySelectorAll?.('[data-history-focus-action="card"]') || [])];
  const target = cards[Math.max(0, Number(firstNewIndex) || 0)];
  if (target?.isConnected !== false && typeof target?.focus === 'function') {
    target.focus({ preventScroll: false });
    return 'appended';
  }

  if (typeof focusHeading === 'function') {
    focusHeading();
    return 'heading';
  }
  return 'none';
}

export function restoreHistoryRetryFocus({
  shouldRestore = false,
  container,
  documentTarget = globalThis.document,
  focusHeading = null,
} = {}) {
  if (!shouldRestore || !documentTarget) return 'none';
  const active = documentTarget.activeElement;
  const focusLost = !active
    || active === documentTarget.body
    || active === documentTarget.documentElement
    || active.isConnected === false;
  if (!focusLost) return 'preserved';

  const card = container?.querySelector?.('[data-history-focus-action="card"]');
  if (card?.isConnected !== false && typeof card?.focus === 'function') {
    card.focus({ preventScroll: false });
    return 'card';
  }
  const retry = container?.querySelector?.('.empty-state button');
  if (retry?.isConnected !== false && typeof retry?.focus === 'function') {
    retry.focus({ preventScroll: true });
    return 'retry';
  }
  if (typeof focusHeading === 'function') {
    focusHeading();
    return 'heading';
  }
  return 'none';
}
