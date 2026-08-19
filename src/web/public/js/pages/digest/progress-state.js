export function formatElapsedProgress(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒` : `${seconds} 秒`;
}

export function saveProgressMessage(phase = 'idle', { reason = '' } = {}) {
  if (phase === 'saving') return '正在保存 PNG…';
  if (phase === 'confirmed') return 'PNG 已保存并完成历史记录提交。';
  if (phase === 'warning') return `PNG 已写入,但历史记录复核需要注意${reason ? `:${reason}` : ''}。`;
  if (phase === 'unknown') return '保存结果未知(请求超时);请核对输出目录后再决定是否重试。';
  if (phase === 'failed') return `保存失败${reason ? `:${reason}` : ''}`;
  return '';
}

export function createRenderProgressTracker({
  label = '正在渲染长图',
  onUpdate = null,
  now = () => Date.now(),
  intervalMs = 1000,
} = {}) {
  let timer = null;
  let startedAt = 0;
  const update = () => {
    if (!startedAt) return;
    try { onUpdate?.(`${label}…${formatElapsedProgress(now() - startedAt)}`); } catch {}
  };
  return {
    start() {
      if (startedAt) return;
      startedAt = Number(now()) || 0;
      update();
      timer = setInterval(update, Math.max(50, Number(intervalMs) || 1000));
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      const elapsedMs = startedAt ? Math.max(0, Number(now()) - startedAt) : 0;
      startedAt = 0;
      return elapsedMs;
    },
    isRunning() { return !!startedAt; },
  };
}
