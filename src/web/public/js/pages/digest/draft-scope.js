// 总结草稿的账号/项目 scope 生命周期。
// 只有 scope 就绪且真正变化时才读草稿；state 的普通刷新不得覆盖当前编辑。
export function createDigestDraftScopeLifecycle({
  readDraft,
  writeDraft,
  resetDraft,
  applyDraft,
  snapshot,
  isMeaningful = () => false,
} = {}) {
  if (typeof readDraft !== 'function'
    || typeof writeDraft !== 'function'
    || typeof resetDraft !== 'function'
    || typeof applyDraft !== 'function'
    || typeof snapshot !== 'function') {
    throw new TypeError('总结草稿 scope 生命周期需要完整回调');
  }

  let boundScope = '';
  let waitingForScope = true;
  let editVersion = 0;
  let restoredEditVersion = 0;
  let persistenceFailed = false;
  let activeAccountIdentity = '';
  let baselineScope = '';
  let baselineSnapshotKey = '';
  let baselineReady = false;

  function draftIsMeaningful(draft) {
    try { return isMeaningful(draft) === true; } catch { return true; }
  }

  function meaningfulSnapshot() {
    try { return draftIsMeaningful(snapshot()); } catch { return true; }
  }

  function canonicalSnapshot(value, stack = new Set()) {
    if (value === null || typeof value !== 'object') return value;
    if (stack.has(value)) throw new TypeError('草稿快照不能包含循环引用');
    stack.add(value);
    let result;
    if (Array.isArray(value)) {
      result = value.map(item => canonicalSnapshot(item, stack));
    } else {
      result = {};
      for (const key of Object.keys(value).sort()) {
        result[key] = canonicalSnapshot(value[key], stack);
      }
    }
    stack.delete(value);
    return result;
  }

  function snapshotSignature(value = snapshot()) {
    try {
      return { ok: true, key: JSON.stringify(canonicalSnapshot(value)) };
    } catch {
      return { ok: false, key: '' };
    }
  }

  function clearBaseline() {
    baselineScope = '';
    baselineSnapshotKey = '';
    baselineReady = false;
  }

  function captureBaseline(scope) {
    const signature = snapshotSignature();
    baselineScope = scope;
    baselineSnapshotKey = signature.key;
    baselineReady = signature.ok;
    return signature.ok;
  }

  function boundScopeIsDirty() {
    const signature = snapshotSignature();
    return !signature.ok || signature.key !== baselineSnapshotKey;
  }

  function hasPendingPersistence() {
    if (boundScope && baselineReady && baselineScope === boundScope) {
      // 绑定 scope 的风险取决于当前快照相对最后成功读/写基线是否净变化，
      // 而不是当前内容是否“有意义”。这样既保住清空失败，也允许用户
      // 从默认值编辑后恢复默认值。
      return boundScopeIsDirty();
    }
    // 尚未绑定可恢复的 scope 时，没有基线可比较；沿用安全的未绑定语义。
    return meaningfulSnapshot() && (editVersion !== restoredEditVersion || persistenceFailed);
  }

  function persistenceRisk() {
    return persistenceFailed === true && hasPendingPersistence();
  }

  function persist(scope, accountFingerprint = '') {
    const draft = snapshot();
    const signature = snapshotSignature(draft);
    let persisted = false;
    try {
      persisted = writeDraft(scope, draft, { accountFingerprint }) === true;
    } catch {
      persisted = false;
    }
    if (persisted) {
      restoredEditVersion = editVersion;
      baselineScope = scope;
      baselineSnapshotKey = signature.key;
      baselineReady = signature.ok;
      persistenceFailed = !signature.ok;
    } else if (boundScope && baselineReady && baselineScope === scope) {
      persistenceFailed = boundScopeIsDirty();
    } else {
      persistenceFailed = draftIsMeaningful(draft);
    }
    return { persisted, persistenceFailed };
  }

  return {
    markEdited() {
      editVersion += 1;
    },

    beginContextChange(accountIdentity = '') {
      const nextIdentity = String(accountIdentity || '').trim();
      if (nextIdentity && activeAccountIdentity === nextIdentity) {
        return { status: 'unchanged', accountIdentity: activeAccountIdentity };
      }
      if (activeAccountIdentity && hasPendingPersistence()) {
        return {
          status: 'blocked',
          accountIdentity: activeAccountIdentity,
          persistenceFailed,
        };
      }
      // changed 表示旧上下文已经可以被替换；空身份也必须写入，
      // 否则 A -> 无选择 -> A 会把最后一次 A 误判成 unchanged。
      activeAccountIdentity = nextIdentity;
      boundScope = '';
      waitingForScope = true;
      clearBaseline();
      restoredEditVersion = editVersion;
      persistenceFailed = false;
      resetDraft();
      return { status: 'changed', accountIdentity: activeAccountIdentity };
    },

    reconcile(scope = '', { accountFingerprint = '', accountIdentity = '' } = {}) {
      const nextScope = String(scope || '').trim();
      const nextIdentity = String(accountIdentity || '').trim();
      if (!activeAccountIdentity && nextIdentity) activeAccountIdentity = nextIdentity;
      if (activeAccountIdentity && nextIdentity && activeAccountIdentity !== nextIdentity) {
        return {
          status: 'context-mismatch',
          scope: boundScope,
          accountIdentity: activeAccountIdentity,
          persistenceFailed,
        };
      }
      if (!nextScope) {
        // 已经绑定的页面遇到一次空 state 时保留当前绑定；待同一 scope 回来时不重放草稿。
        if (!boundScope) waitingForScope = true;
        return { status: 'waiting', scope: boundScope, persistenceFailed };
      }

      const changed = boundScope !== nextScope;
      if (!waitingForScope && !changed) {
        return { status: 'unchanged', scope: boundScope, persistenceFailed };
      }

      const userEditedWhileWaiting = editVersion !== restoredEditVersion;
      boundScope = nextScope;
      waitingForScope = false;
      if (userEditedWhileWaiting) {
        const result = persist(nextScope, accountFingerprint);
        restoredEditVersion = editVersion;
        return {
          status: 'preserved',
          scope: boundScope,
          restored: false,
          ...result,
        };
      }

      resetDraft();
      let restored;
      try {
        restored = readDraft(nextScope, { accountFingerprint });
      } catch {
        restored = { ok: false, draft: null };
      }
      restoredEditVersion = editVersion;
      if (!restored?.ok) {
        clearBaseline();
        persistenceFailed = meaningfulSnapshot();
        return { status: 'read-failed', scope: boundScope, persistenceFailed };
      }
      if (restored.draft) {
        applyDraft(restored.draft);
      }
      const baselineCaptured = captureBaseline(boundScope);
      persistenceFailed = !baselineCaptured;
      return {
        status: restored.draft ? 'restored' : 'default',
        scope: boundScope,
        restored: Boolean(restored.draft),
        persistenceFailed,
      };
    },

    persist(scope = '', { accountFingerprint = '' } = {}) {
      const nextScope = String(scope || '').trim();
      if (!nextScope) {
        // state 尚未绑定可写入的 project/account scope 时，不能把有意义的
        // 当前编辑当成已处理；离开保护必须继续 fail-closed，直到 scope 就绪
        // 后真正写入或用户放弃这些编辑。若已有绑定基线，则按净脏状态
        // 判断；默认快照覆盖有意义基线失败同样必须阻断。
        persistenceFailed = boundScope && baselineReady && baselineScope === boundScope
          ? boundScopeIsDirty()
          : meaningfulSnapshot();
        return { persisted: false, ready: false, persistenceFailed };
      }
      const result = persist(nextScope, accountFingerprint);
      return { ...result, ready: true };
    },

    hasPendingPersistence() {
      return hasPendingPersistence();
    },

    persistenceRisk() {
      return persistenceRisk();
    },

    boundScope() {
      return boundScope;
    },

    accountIdentity() {
      return activeAccountIdentity;
    },
  };
}
