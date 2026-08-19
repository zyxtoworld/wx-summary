// 账号数据身份发生变化时,所有页面都使用同一组服务端公开错误码。
const ACCOUNT_CONTEXT_REFRESH_CODES = new Set([
  'account_context_changed',
  'account_context_refresh_required',
]);

export function accountContextErrorCode(error = {}) {
  return String(error?.code || error?.public_code || '').trim();
}

export function isAccountContextRefreshError(error = {}) {
  return Number(error?.status) === 409
    && ACCOUNT_CONTEXT_REFRESH_CODES.has(accountContextErrorCode(error));
}

export function publicAccountId(account = {}) {
  return String(account?.id || account?.account_id || '').trim();
}

export function publicAccountFingerprint(account = {}) {
  return String(account?.manual_key_account_fingerprint || '').trim().toLowerCase();
}

export function requirePublicAccountList(payload) {
  const valid = Array.isArray(payload)
    && payload.every(account => account && typeof account === 'object' && publicAccountId(account));
  if (!valid) {
    const error = new Error('账号列表响应无效，请重新检测账号。');
    error.code = 'account_list_response_invalid';
    error.status = 502;
    throw error;
  }
  return payload;
}

export function publicAccountAliases(account = {}) {
  return [...new Set([
    publicAccountId(account),
    account?.account_id,
    account?.legacy_id,
    account?.wxid,
    ...(Array.isArray(account?.account_aliases) ? account.account_aliases : []),
  ].map(value => String(value || '').trim()).filter(Boolean))];
}

export function findPublicAccountByIdentity(accounts = [], reference = null) {
  if (!reference) return null;
  const referenceAliases = new Set(publicAccountAliases(reference));
  if (!referenceAliases.size) return null;
  return (Array.isArray(accounts) ? accounts : []).find(candidate =>
    publicAccountAliases(candidate).some(alias => referenceAliases.has(alias))) || null;
}

export function validatePublicAccountIdentityUpgrade(payload = {}, {
  accountId = '',
  fingerprint = '',
} = {}) {
  const proof = payload?.account_identity_upgrade;
  const account = payload?.account;
  if (!proof || !account) return { status: 'not_upgrade' };
  const previousFingerprint = String(proof.previous_fingerprint || '').trim().toLowerCase();
  const nextFingerprint = String(proof.next_fingerprint || '').trim().toLowerCase();
  const expectedFingerprint = String(fingerprint || '').trim().toLowerCase();
  const requestedAccountId = String(accountId || '').trim();
  if (!requestedAccountId
    || !expectedFingerprint
    || previousFingerprint !== expectedFingerprint
    || !nextFingerprint
    || nextFingerprint === previousFingerprint
    || publicAccountFingerprint(account) !== nextFingerprint
    || !publicAccountAliases(account).includes(requestedAccountId)
    || String(payload?.account_id || '').trim() !== publicAccountId(account)
    || String(payload?.account_fingerprint || '').trim().toLowerCase() !== nextFingerprint) {
    return { status: 'invalid' };
  }
  return { status: 'valid', account, nextFingerprint };
}

export async function refreshPublicAccountIdentityUpgrade(payload = {}, {
  accountId = '',
  fingerprint = '',
  refreshAccounts = null,
  isCurrent = () => true,
} = {}) {
  const upgrade = validatePublicAccountIdentityUpgrade(payload, { accountId, fingerprint });
  if (upgrade.status !== 'valid') return upgrade;
  try {
    if (isCurrent() !== true) return { status: 'stale' };
  } catch {
    return { status: 'stale' };
  }
  if (typeof refreshAccounts !== 'function') return { status: 'blocked' };
  let refreshed;
  try {
    refreshed = await refreshAccounts({ forceDetect: true });
  } catch (error) {
    try {
      if (isCurrent() !== true) return { status: 'stale' };
    } catch {
      return { status: 'stale' };
    }
    return { status: 'refresh_failed', error };
  }
  try {
    if (isCurrent() !== true) return { status: 'stale' };
  } catch {
    return { status: 'stale' };
  }
  const current = refreshed?.account || null;
  const upgradeAliases = new Set(publicAccountAliases(upgrade.account));
  if (publicAccountFingerprint(current) !== upgrade.nextFingerprint
    || !publicAccountAliases(current).some(alias => upgradeAliases.has(alias))) {
    return { status: 'unconfirmed' };
  }
  return { status: 'upgraded', account: current };
}
