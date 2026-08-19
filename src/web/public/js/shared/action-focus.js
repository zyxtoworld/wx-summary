// 异步操作禁用触发控件后,在操作结束时安全恢复键盘焦点。
export function captureActionFocus(buttons, activeElement) {
  const list = Array.isArray(buttons) ? buttons : [];
  return list.find(button => button && button === activeElement) || null;
}

export function restoreActionFocus(target, { activeElement, body, fallbackTargets = [] } = {}) {
  if (!target) return false;
  if (activeElement !== body && activeElement?.isConnected) return false;
  const candidates = [target, ...(Array.isArray(fallbackTargets) ? fallbackTargets : [])];
  const next = candidates.find(candidate => candidate?.isConnected && !candidate.disabled);
  if (!next) return false;
  try {
    next.focus({ preventScroll: true });
    return true;
  } catch {
    return false;
  }
}
