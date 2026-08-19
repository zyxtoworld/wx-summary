function clean(value) {
  return String(value || '').trim();
}

export function formatGroupLastMessageLabel(lastMsgAt, status = '') {
  const normalized = clean(status).toLowerCase();
  if (normalized === 'untrusted_time') return '消息时间异常';
  if (normalized === 'unknown' || normalized === 'session_unavailable' || !normalized) {
    if (normalized) return '消息时间未知';
  }
  const stamp = Number(lastMsgAt);
  if (!Number.isFinite(stamp) || stamp <= 0) return '消息时间未知';
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return '消息时间未知';
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function digestGroupSessionWarning(groups = []) {
  const list = Array.isArray(groups) ? groups : [];
  const statuses = new Set(list.map(group => clean(group?.last_msg_status).toLowerCase()).filter(Boolean));
  const messages = [];
  if (statuses.has('untrusted_time')) {
    messages.push('部分群的消息时间异常,只影响排序;生成仍按所选范围读取消息。');
  } else if (statuses.has('unknown') || statuses.has('session_unavailable')) {
    messages.push('部分群的消息时间未知,只影响排序;生成仍按所选范围读取消息。');
  }
  if (list.some(group => clean(group?.source_detail) === 'session_only')) {
    messages.push('部分群名可能显示为原始 ID;生成仍按所选范围读取消息。');
  }
  return messages.join(' ');
}

export function digestWechatStatusMessageTone(wechat = {}) {
  const healthy = wechat?.running === true
    && Number(wechat?.account_count || 0) > 0
    && Number(wechat?.source_ambiguous_count || 0) === 0
    && Number(wechat?.source_unreadable_count || 0) === 0
    && Number(wechat?.mirror_without_source_count || 0) === 0;
  return healthy ? 'info' : 'warn';
}
