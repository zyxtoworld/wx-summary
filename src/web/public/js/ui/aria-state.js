// 同步当前项的 aria-current 状态,避免只靠 CSS 表达位置。
export function setAriaCurrentState(item, current, value = 'page') {
  if (!item) return item;
  if (current === true) item.setAttribute?.('aria-current', value);
  else item.removeAttribute?.('aria-current');
  return item;
}
