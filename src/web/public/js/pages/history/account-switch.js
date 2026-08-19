// 历史页账号切换守卫:本地操作进行中时,旧详情不能继续绑定到新账号。
export function historyAccountSwitchBlockedMessage({
  destroyed = false,
  detailBusy = false,
  pendingRerender = 0,
} = {}) {
  if (destroyed) return '';
  if (detailBusy || Number(pendingRerender) > 0) {
    return '历史操作正在进行,请完成后再切换账号。';
  }
  return '';
}

export function historyActionResultAppliesToView({
  accountScope = 'current',
  currentAccountId = '',
  currentAccountFingerprint = '',
  actionAccountId = '',
  actionAccountFingerprint = '',
} = {}) {
  if (String(accountScope || '').trim() === 'all') return true;
  const current = String(currentAccountId || '').trim();
  const action = String(actionAccountId || '').trim();
  if (!current || !action || current !== action) return false;
  const currentFingerprint = String(currentAccountFingerprint || '').trim().toLowerCase();
  const actionFingerprint = String(actionAccountFingerprint || '').trim().toLowerCase();
  return currentFingerprint === actionFingerprint;
}

export function historyAccountContextIdentity(account) {
  const accountId = String(account?.id || account?.account_id || '').trim();
  const fingerprint = String(account?.manual_key_account_fingerprint || '').trim().toLowerCase();
  if (accountId) return `id:${accountId}|fingerprint:${fingerprint}`;
  return fingerprint ? `fingerprint:${fingerprint}` : '';
}

export function createHistoryAccountContextTracker(initialAccount = null) {
  let identity = historyAccountContextIdentity(initialAccount);

  return {
    identity() {
      return identity;
    },
    update(account) {
      const nextIdentity = historyAccountContextIdentity(account);
      if (nextIdentity === identity) {
        return { changed: false, identity, previousIdentity: identity };
      }
      const previousIdentity = identity;
      identity = nextIdentity;
      return { changed: true, identity, previousIdentity };
    },
  };
}
