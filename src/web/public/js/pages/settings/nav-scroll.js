export function settingsNavScrollDelta({
  navLeft = 0,
  navRight = 0,
  itemLeft = 0,
  itemRight = 0,
  inset = 0,
} = {}) {
  const values = [navLeft, navRight, itemLeft, itemRight, inset].map(Number);
  if (values.some(value => !Number.isFinite(value))) return 0;
  const [left, right, targetLeft, targetRight, rawInset] = values;
  const safeInset = Math.max(0, rawInset);
  const visibleLeft = left + safeInset;
  const visibleRight = right - safeInset;
  if (targetLeft < visibleLeft) return targetLeft - visibleLeft;
  if (targetRight > visibleRight) return targetRight - visibleRight;
  return 0;
}

export function scrollSettingsNavItemIntoView(nav, item) {
  if (!nav?.getBoundingClientRect || !item?.getBoundingClientRect) return 0;
  const navRect = nav.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  let inset = 0;
  try {
    const style = globalThis.getComputedStyle?.(nav);
    inset = Number.parseFloat(style?.scrollPaddingInlineStart || style?.scrollPaddingInline || '0') || 0;
  } catch {}
  const delta = settingsNavScrollDelta({
    navLeft: navRect.left,
    navRight: navRect.right,
    itemLeft: itemRect.left,
    itemRight: itemRect.right,
    inset,
  });
  if (delta) nav.scrollLeft += delta;
  return delta;
}

export function activateSettingsNavItem(nav, item, activate) {
  if (typeof activate !== 'function') {
    throw new TypeError('设置分区激活需要回调');
  }
  activate();
  return scrollSettingsNavItemIntoView(nav, item);
}
