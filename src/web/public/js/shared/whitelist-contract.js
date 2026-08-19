// 账号绑定的群白名单引用合同。
// 设置页与首次配置向导都只提交规范对象；字符串/无账号旧引用由服务端兼容保留。
export function canonicalWhitelistRef(ref, accountId = '') {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  const account = String(ref.account_id || accountId || '').trim();
  const groupId = String(ref.group_id || '').trim();
  const groupName = String(ref.group_name || '').trim();
  if (!account || (!groupId && !groupName)) return null;
  const out = { account_id: account };
  if (groupId) out.group_id = groupId;
  if (groupName) out.group_name = groupName;
  return out;
}

export function whitelistRefKey(ref) {
  if (typeof ref === 'string') return `legacy:${ref}`;
  const account = String(ref?.account_id || '').trim();
  const groupId = String(ref?.group_id || '').trim();
  const groupName = String(ref?.group_name || '').trim();
  return `${account}::${groupId ? `id:${groupId}` : `name:${groupName}`}`;
}

export function whitelistRefLabel(ref) {
  if (typeof ref === 'string') return ref;
  return String(ref?.group_name || ref?.group_id || '(未命名群)').trim() || '(未命名群)';
}

export function groupRefFromGroup(group, accountId) {
  const groupId = String(group?.id || '').trim();
  const groupName = String(group?.name || group?.id || '').trim();
  const account = String(accountId || '').trim();
  if (!account || !groupId) return null;
  return { account_id: account, group_id: groupId, group_name: groupName };
}

export function groupDisplayName(group) {
  return String(group?.name || group?.id || '(未命名群)').trim() || '(未命名群)';
}
