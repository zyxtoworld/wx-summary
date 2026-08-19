// 释放设置页动作；页面卸载后不得再触碰已释放的 DOM 或焦点。
export function completeSettingsAction({
  actions,
  token,
  destroyed,
  syncBusy,
  restoreFocus,
} = {}) {
  if (!token) return false;
  const cleanup = token.cleanup;
  token.cleanup = null;
  try { cleanup?.(); } catch {}
  const owned = actions?.delete?.(token) === true;
  if (!owned) return false;
  if (destroyed) return false;
  syncBusy?.();
  restoreFocus?.();
  return true;
}
