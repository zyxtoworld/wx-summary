const DETAIL_ACTION_PATTERN = /^[a-z0-9_-]+$/;

function focusElement(element) {
  if (!element?.focus || element.isConnected === false) return false;
  try { element.focus({ preventScroll: true }); } catch { element.focus(); }
  return true;
}

export function captureHistoryDetailActionFocus({
  detail = null,
  documentTarget = globalThis.document,
} = {}) {
  const active = documentTarget?.activeElement;
  if (!active || !detail?.actionsSlot?.contains?.(active)) return '';
  const actionName = String(active.dataset?.historyDetailAction || '').trim().toLowerCase();
  return DETAIL_ACTION_PATTERN.test(actionName) ? actionName : '';
}

export function setHistoryDetailActionBusy({
  detail = null,
  busy = false,
  restoreFocus = true,
  isActive = () => true,
  documentTarget = globalThis.document,
  schedule = globalThis.requestAnimationFrame || (callback => setTimeout(callback, 0)),
} = {}) {
  if (!detail) return false;
  const nextBusy = busy === true;
  const wasBusy = detail.busy === true;
  if (nextBusy && !wasBusy) {
    detail.busyFocusAction = captureHistoryDetailActionFocus({ detail, documentTarget });
  }
  detail.busy = nextBusy;
  for (const button of detail.actionsSlot?.querySelectorAll?.('button') || []) {
    button.disabled = nextBusy || button.dataset?.disabledReason === '1';
  }
  if (!nextBusy && wasBusy) {
    const focusedAction = String(detail.busyFocusAction || '');
    detail.busyFocusAction = '';
    if (focusedAction && restoreFocus === true) {
      restoreHistoryDetailActionFocus({
        detail,
        action: focusedAction,
        isActive,
        documentTarget,
        schedule,
      });
    }
  }
  return true;
}

// 详情内容更新会替换原触发按钮；内层弹窗关闭后按语义定位新按钮恢复焦点。
export function restoreHistoryDetailActionFocus({
  detail = null,
  action = '',
  isActive = () => true,
  documentTarget = globalThis.document,
  schedule = globalThis.requestAnimationFrame || (callback => setTimeout(callback, 0)),
  force = false,
} = {}) {
  const actionName = String(action || '').trim().toLowerCase();
  if (!detail || !DETAIL_ACTION_PATTERN.test(actionName) || typeof schedule !== 'function') return false;
  schedule(() => {
    if (!isActive()) return;
    const active = documentTarget?.activeElement;
    const explicitFocus = active
      && active !== documentTarget?.body
      && active !== documentTarget?.documentElement
      && active.isConnected !== false;
    if (explicitFocus && force !== true) return;
    const target = detail.actionsSlot?.querySelector?.(`[data-history-detail-action="${actionName}"]`);
    if (target?.disabled !== true && focusElement(target)) return;
    focusElement(detail.modal?.el);
  });
  return true;
}
