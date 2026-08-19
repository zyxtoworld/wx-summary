export function digestGenerationGroupAdmission({
  locked = false,
  groupsStatus = 'idle',
  selectedCount = 0,
} = {}) {
  if (locked) return { allowed: false, reason: '' };
  const status = String(groupsStatus || 'idle').trim();
  if (status === 'loading') {
    return { allowed: false, reason: '群列表正在刷新，请等待完成后再生成。' };
  }
  if (status === 'error') {
    return { allowed: false, reason: '群列表读取失败，请先重试。' };
  }
  if (status !== 'ready') {
    return { allowed: false, reason: '群列表尚未准备完成，请等待刷新后再生成。' };
  }
  if (Math.max(0, Number(selectedCount || 0)) < 1) {
    return { allowed: false, reason: '请先选择至少一个群。' };
  }
  return { allowed: true, reason: '' };
}
