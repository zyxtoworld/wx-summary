// 统一同步分段按钮的视觉状态与可访问状态。
export function setSegmentedButtonState(button, active) {
  if (!button) return button;
  const selected = active === true;
  button.classList?.toggle?.('active', selected);
  button.setAttribute?.('aria-pressed', String(selected));
  return button;
}
