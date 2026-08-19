export function revealHistoryDetailStatus(statusElement, {
  isActive = () => true,
  schedule = globalThis.requestAnimationFrame || (callback => setTimeout(callback, 0)),
} = {}) {
  if (!statusElement || typeof schedule !== 'function') return false;
  schedule(() => {
    if (!isActive() || statusElement.isConnected === false) return;
    try {
      statusElement.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch {}
  });
  return true;
}
