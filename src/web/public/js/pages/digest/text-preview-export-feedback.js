// 文本导出把“文件已写入”和“本地动作核对完成”作为两个独立状态呈现。
export function textPreviewExportFeedback({ recovery = 'pending', path = '', redacted = false } = {}) {
  const displayPath = String(path || '').trim() || '(路径未知)';
  const privacyNote = redacted === true ? '内容已按隐私设置脱敏' : '';
  if (recovery === 'verified') {
    const status = `已导出:${displayPath}${privacyNote ? `(${privacyNote})` : ''}`;
    return { type: 'success', toast: `已导出:${displayPath}`, status };
  }
  const notes = [privacyNote, '核对待完成'].filter(Boolean).join(';');
  return {
    type: 'warn',
    toast: 'Markdown 已写入,但本地服务未能完成核对;请在历史页或输出目录确认。',
    status: `已写入:${displayPath}(${notes})`,
  };
}
