export function createHistoryZoomToggle(image, {
  document = globalThis.document,
} = {}) {
  if (!image?.classList || !document?.createElement) return null;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-ghost btn-sm history-zoom-toggle';

  const sync = () => {
    const fitted = image.classList.contains('fit');
    const action = fitted ? '查看 100% 原图' : '按宽度适应原图';
    button.textContent = fitted ? '查看 100%' : '适应宽度';
    button.setAttribute('aria-label', action);
    button.setAttribute('aria-pressed', fitted ? 'false' : 'true');
    image.title = `点击${action}`;
  };
  const toggle = () => {
    image.classList.toggle('fit');
    sync();
  };

  button.addEventListener('click', toggle);
  image.addEventListener('click', toggle);
  sync();
  return button;
}
