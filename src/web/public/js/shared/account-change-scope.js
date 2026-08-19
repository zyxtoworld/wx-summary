function normalizeAccountId(value) {
  return String(value || '').trim();
}

// 账号切换后,所有旧请求都只能观察结果,不能再写当前页面。
export function createAccountChangeScope(initialAccountId = '') {
  let revision = 0;
  let accountId = normalizeAccountId(initialAccountId);

  function capture(id = accountId) {
    return Object.freeze({
      revision,
      accountId: normalizeAccountId(id),
    });
  }

  return {
    capture,

    ensure(nextAccountId = '') {
      const next = normalizeAccountId(nextAccountId);
      if (next !== accountId) {
        accountId = next;
        revision += 1;
      }
      return capture();
    },

    switchTo(nextAccountId = '') {
      accountId = normalizeAccountId(nextAccountId);
      revision += 1;
      return capture();
    },

    isCurrent(token, currentAccountId = accountId) {
      const current = normalizeAccountId(currentAccountId);
      return !!token
        && token.revision === revision
        && token.accountId === accountId
        && current === accountId;
    },

    currentAccountId() {
      return accountId;
    },
  };
}
