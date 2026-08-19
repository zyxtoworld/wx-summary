import { makeScrollableRegion } from '/js/shared/scroll-region.js';

export function createZoomRegion(content, {
  document = globalThis.document,
  className = 'zoom-wrap',
} = {}) {
  if (!document?.createElement || !content) return null;
  const region = document.createElement('div');
  region.className = String(className || 'zoom-wrap');
  region.appendChild(content);
  return makeScrollableRegion(region, { label: '100% 长图滚动区域' });
}
