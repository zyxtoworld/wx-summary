export function requireHistoryListItems(payload) {
  const validPayload = payload && typeof payload === 'object' && !Array.isArray(payload);
  const items = validPayload ? payload.items : null;
  const validItems = Array.isArray(items)
    && items.every(item => item && typeof item === 'object' && !Array.isArray(item));
  if (!validItems) {
    const error = new Error('历史列表响应格式无效，请重试。');
    error.status = 502;
    error.code = 'history_list_response_invalid';
    throw error;
  }
  return items;
}

export function historyItemMatchesFilter(item, filter = 'ok') {
  if (filter === 'all') return true;
  const hasIssue = item?.has_blocking_issue === true;
  return filter === 'issues' ? hasIssue : !hasIssue;
}

export function historyListStatusTransition(currentItem, nextItem, filter = 'ok') {
  if (!currentItem || !nextItem) {
    return { action: 'ignore', totalDelta: 0, okDelta: 0, issueDelta: 0 };
  }
  const currentIssue = currentItem.has_blocking_issue === true;
  const nextIssue = nextItem.has_blocking_issue === true;
  const statusChanged = currentIssue !== nextIssue;
  const visible = historyItemMatchesFilter(nextItem, filter);
  return {
    action: visible ? 'replace' : 'remove',
    totalDelta: visible ? 0 : -1,
    okDelta: statusChanged ? (nextIssue ? -1 : 1) : 0,
    issueDelta: statusChanged ? (nextIssue ? 1 : -1) : 0,
  };
}
