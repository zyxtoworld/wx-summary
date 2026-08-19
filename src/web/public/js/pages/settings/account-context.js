// 设置页账号安全上下文：展示字段刷新不算切换，数据库身份变化必须算切换。
export function settingsAccountContextIdentity(account) {
  const accountId = String(account?.id || account?.account_id || '').trim();
  const fingerprint = String(account?.manual_key_account_fingerprint || '').trim().toLowerCase();
  if (accountId) return `id:${accountId}|fingerprint:${fingerprint}`;
  return fingerprint ? `fingerprint:${fingerprint}` : '';
}

export function createSettingsAccountContextTracker(initialAccount = null) {
  let identity = settingsAccountContextIdentity(initialAccount);

  return {
    identity() {
      return identity;
    },
    update(account) {
      const nextIdentity = settingsAccountContextIdentity(account);
      if (nextIdentity === identity) {
        return { changed: false, identity, previousIdentity: identity };
      }
      const previousIdentity = identity;
      identity = nextIdentity;
      return { changed: true, identity, previousIdentity };
    },
  };
}

// 账号切换是安全边界：一个分区重绘失败不能阻断其他分区清理旧账号数据。
// 完成全部通知后再抛出首个异常，交给 store 的既有监听器错误边界记录。
export function notifySettingsSectionsAccountChanged(sections, account, previous, change) {
  let firstError = null;
  for (const section of sections || []) {
    try {
      section?.onAccountChanged?.(account, previous, change);
    } catch (error) {
      firstError ||= error;
    }
  }
  if (firstError) throw firstError;
}

// state 是设置页各分区共享的服务端快照；一个分区重绘失败不能阻断后续
// 分区同步。完成全部通知后再抛出首个异常，交给 store 的监听器边界记录。
export function notifySettingsSectionsStateChanged(sections, state) {
  let firstError = null;
  for (const section of sections || []) {
    try {
      section?.onStateChanged?.(state);
    } catch (error) {
      firstError ||= error;
    }
  }
  if (firstError) throw firstError;
}

// 账号安全上下文变化会使页面内所有旧 action 失效。请求可能忽略 abort，
// 因此这里必须同步释放 action 所有权；旧请求的 finally 随后只能 no-op。
export function invalidateSettingsActionsForAccountChange(
  state,
  reason = '账号上下文已变化',
  { onActionsReleased = null } = {},
) {
  if (!state || state.destroyed) return 0;
  state.generation = Number(state.generation || 0) + 1;
  let released = 0;
  for (const action of [...(state.actions || [])]) {
    const cleanup = action?.cleanup;
    if (action) action.cleanup = null;
    try { action?.signal?.removeEventListener?.('abort', cleanup); } catch {}
    try { cleanup?.(); } catch {}
    if (!action?.controller?.signal?.aborted) {
      try { action?.controller?.abort(new DOMException(reason, 'AbortError')); } catch {}
    }
    if (state.actions?.delete?.(action) === true) released += 1;
  }
  if (released > 0) {
    try { onActionsReleased?.(); } catch {}
  }
  return released;
}
