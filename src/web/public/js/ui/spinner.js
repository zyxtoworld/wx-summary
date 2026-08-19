// 加载态小件:spinner、骨架屏、全局进度条。

export function spinner(size = 16) {
  const el = document.createElement('span');
  el.className = 'spinner';
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.setAttribute('aria-hidden', 'true');
  return el;
}

// 骨架屏块:rows 行,用于列表加载占位。
export function skeletonRows(rows = 6, { className = '' } = {}) {
  const box = document.createElement('div');
  box.className = `skeleton-list ${className}`.trim();
  box.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < rows; i += 1) {
    const row = document.createElement('div');
    row.className = 'skeleton-row';
    row.style.animationDelay = `${i * 90}ms`;
    box.appendChild(row);
  }
  return box;
}

// 全局进度条(壳顶部):value 0~1,传 null/省略则不确定态滚动。
export function setGlobalProgress(visible, value = null) {
  const bar = document.getElementById('global-progress');
  if (!bar) return;
  bar.hidden = !visible;
  if (!visible) return;
  const inner = bar.querySelector('.global-progress-bar');
  if (!inner) return;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const pct = Math.max(0, Math.min(1, value));
    bar.classList.remove('indeterminate');
    inner.style.width = `${Math.round(pct * 1000) / 10}%`;
  } else {
    bar.classList.add('indeterminate');
    inner.style.width = '';
  }
}
