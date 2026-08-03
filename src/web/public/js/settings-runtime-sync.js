const MANUAL_KEY_RUNTIME_FIELDS = [
  'manual_key_verified_account_ids',
  'manual_key_verified_account_count',
  'manual_key_verified_account_fingerprints_by_account',
  'manual_key_clear_account_fingerprints_by_account',
];

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clonePublicValue(value) {
  if (Array.isArray(value)) return value.map(clonePublicValue);
  if (plainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clonePublicValue(item)]));
  }
  return value;
}

function settingsRevisionFromRuntimePayload(data = null) {
  return String(data?.settings_revision || data?.settings?.settings_revision || '').trim();
}

export function schedulerRuntimeRevisionFromPayload(data = null) {
  return String(
    data?.scheduler_runtime_revision
    || data?.settings?.scheduler_runtime_revision
    || data?.scheduler?.scheduler_runtime_revision
    || '',
  ).trim();
}

export function mergeManualKeyRuntimeSettings(current = {}, fresh = {}) {
  if (!plainObject(current) || !plainObject(fresh)) return current;
  const currentSettingsRevision = settingsRevisionFromRuntimePayload(current);
  const freshSettingsRevision = settingsRevisionFromRuntimePayload(fresh);
  const currentRuntimeRevision = schedulerRuntimeRevisionFromPayload(current);
  const freshRuntimeRevision = schedulerRuntimeRevisionFromPayload(fresh);
  if (!currentSettingsRevision
    || !freshSettingsRevision
    || currentSettingsRevision !== freshSettingsRevision
    || !freshRuntimeRevision
    || freshRuntimeRevision === currentRuntimeRevision
    || !plainObject(fresh.wechat)) return current;

  const nextWechat = { ...(plainObject(current.wechat) ? current.wechat : {}) };
  for (const field of MANUAL_KEY_RUNTIME_FIELDS) {
    if (Object.hasOwn(fresh.wechat, field)) nextWechat[field] = clonePublicValue(fresh.wechat[field]);
  }
  return {
    ...current,
    scheduler_runtime_revision: freshRuntimeRevision,
    wechat: nextWechat,
  };
}

export function createLatestManualKeyRuntimeSync({
  getCurrent,
  fetchFresh,
  applyMerged,
  isActive = () => true,
  onError = () => {},
} = {}) {
  if (typeof getCurrent !== 'function' || typeof fetchFresh !== 'function' || typeof applyMerged !== 'function') {
    throw new TypeError('latest manual-key runtime sync requires getCurrent, fetchFresh and applyMerged callbacks');
  }
  let desiredRevision = '';
  let desiredGeneration = 0;
  let handledGeneration = 0;
  let activePromise = null;
  let disposed = false;

  const active = () => !disposed && isActive() !== false;
  const observe = value => {
    const revision = schedulerRuntimeRevisionFromPayload(value);
    if (!revision) return '';
    const currentRevision = schedulerRuntimeRevisionFromPayload(getCurrent());
    if (revision !== desiredRevision || handledGeneration >= desiredGeneration) {
      desiredRevision = revision;
      desiredGeneration += 1;
    }
    if (revision === currentRevision) handledGeneration = desiredGeneration;
    return revision;
  };
  const drain = async () => {
    let changed = false;
    while (active() && handledGeneration < desiredGeneration) {
      const targetGeneration = desiredGeneration;
      const targetRevision = desiredRevision;
      if (schedulerRuntimeRevisionFromPayload(getCurrent()) === targetRevision) {
        handledGeneration = targetGeneration;
        continue;
      }
      let fresh;
      try {
        fresh = await fetchFresh();
      } catch (error) {
        handledGeneration = Math.max(handledGeneration, targetGeneration);
        try { onError(error); } catch {}
        break;
      }
      if (!active()) break;
      const freshRevision = schedulerRuntimeRevisionFromPayload(fresh);
      if (targetGeneration !== desiredGeneration && freshRevision !== desiredRevision) {
        continue;
      }
      const current = getCurrent();
      const merged = mergeManualKeyRuntimeSettings(current, fresh);
      if (merged !== current) {
        applyMerged(merged);
        changed = true;
      }
      if (targetGeneration === desiredGeneration) {
        if (freshRevision) desiredRevision = freshRevision;
        handledGeneration = targetGeneration;
      } else if (freshRevision && freshRevision === desiredRevision) {
        handledGeneration = desiredGeneration;
      }
    }
    return changed;
  };
  const ensureActivePromise = () => {
    if (activePromise) return activePromise;
    const run = drain();
    const tracked = run.finally(() => {
      if (activePromise === tracked) activePromise = null;
      if (active() && handledGeneration < desiredGeneration) queueMicrotask(ensureActivePromise);
    });
    activePromise = tracked;
    return tracked;
  };
  return {
    request(observed) {
      observe(observed);
      if (!active() || handledGeneration >= desiredGeneration) return activePromise || Promise.resolve(false);
      return ensureActivePromise();
    },
    dispose() {
      disposed = true;
    },
  };
}

export function createLatestSettingsRevisionProbe({
  fetchFresh,
  applyFresh,
  isActive = () => true,
} = {}) {
  if (typeof fetchFresh !== 'function' || typeof applyFresh !== 'function') {
    throw new TypeError('latest settings revision probe requires fetchFresh and applyFresh callbacks');
  }
  let activePromise = null;
  let rerunRequested = false;
  let disposed = false;

  const active = () => !disposed && isActive() !== false;
  const drain = async () => {
    let applied = false;
    do {
      rerunRequested = false;
      if (!active()) break;
      const fresh = await fetchFresh();
      if (!active()) break;
      await applyFresh(fresh);
      applied = true;
    } while (rerunRequested && active());
    return applied;
  };

  return {
    request() {
      if (!active()) return Promise.resolve(false);
      if (activePromise) {
        rerunRequested = true;
        return activePromise;
      }
      const run = drain();
      const tracked = run.finally(() => {
        if (activePromise === tracked) activePromise = null;
      });
      activePromise = tracked;
      return tracked;
    },
    dispose() {
      disposed = true;
      rerunRequested = false;
    },
  };
}
