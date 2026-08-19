// 路由切换后的焦点入口。
// 页面内部已有可用焦点时保留它,避免刷新历史列表时打断用户操作。
export function focusRouteHeading(root, {
  documentTarget = globalThis.document,
} = {}) {
  if (!root) return false;
  const active = documentTarget?.activeElement;
  const body = documentTarget?.body;
  const documentElement = documentTarget?.documentElement;
  const activeInModal = !!active?.closest?.('[role="dialog"][aria-modal="true"]');
  if (activeInModal) return false;
  const activeInsidePage = active
    && active !== body
    && active !== documentElement
    && active !== root
    && root.contains?.(active);
  if (activeInsidePage) return false;

  const heading = root.querySelector?.('h1,[data-page-heading],h2');
  if (!heading || typeof heading.focus !== 'function') return false;
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
  return true;
}
