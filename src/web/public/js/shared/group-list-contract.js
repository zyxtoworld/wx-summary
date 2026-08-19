export function requireGroupList(payload) {
  const groups = payload?.groups;
  const valid = Array.isArray(groups)
    && groups.every(group => group && typeof group === 'object'
      && String(group.id || group.group_id || '').trim());
  if (!valid) {
    const error = new Error('群列表响应无效，请重新读取群列表。');
    error.code = 'group_list_response_invalid';
    error.status = 502;
    throw error;
  }
  return groups;
}
