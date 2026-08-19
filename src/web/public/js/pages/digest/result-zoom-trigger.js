export function createResultZoomTrigger(canvas, {
  document = globalThis.document,
  label = '打开摘要长图预览',
  onOpen = null,
} = {}) {
  if (!canvas || !document?.createElement || typeof onOpen !== 'function') return null;
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'result-canvas-trigger';
  trigger.setAttribute('aria-label', String(label || '打开摘要长图预览'));
  trigger.appendChild(canvas);
  trigger.addEventListener('click', () => onOpen(canvas));
  return trigger;
}
