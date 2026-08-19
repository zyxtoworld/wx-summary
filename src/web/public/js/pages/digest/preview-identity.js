function clean(value) {
  return String(value || '').trim();
}

export function digestPreviewIdentityText({ previewGroup = '', processingGroup = '' } = {}) {
  const shown = clean(previewGroup);
  const processing = clean(processingGroup);
  if (shown && processing && shown !== processing) {
    return `当前显示：${shown}；正在处理：${processing}`;
  }
  if (shown) return `当前显示：${shown}`;
  if (processing) return `正在处理：${processing}`;
  return '';
}

export function syncDigestPreviewIdentity({
  identityElement = null,
  canvas = null,
  previewGroup = '',
  processingGroup = '',
} = {}) {
  const shown = clean(previewGroup);
  const processing = clean(processingGroup);
  const text = digestPreviewIdentityText({ previewGroup: shown, processingGroup: processing });
  if (identityElement) identityElement.textContent = text;
  if (shown) canvas?.setAttribute?.('aria-label', `${shown} 摘要长图`);
  else canvas?.removeAttribute?.('aria-label');
  return { previewGroup: shown, processingGroup: processing, text };
}
