import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createSharedRequestLease } from '../src/web/public/js/shared-request-lease.js';

const source = await fs.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const clearStart = source.indexOf('function clearDigestGroupCache');
const clearEnd = source.indexOf('\n}\n', clearStart) + 3;
const start = source.indexOf('function digestGroupCacheKey');
const end = source.indexOf('\nfunction groupRefForPayload', start);
assert.ok(clearStart >= 0 && clearEnd > clearStart && start >= 0 && end > start,
  'digest group-cache implementation must remain available');

const implementation = `${source.slice(clearStart, clearEnd)}\n${source.slice(start, end)}`;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function createHarness(gates = []) {
  const calls = [];
  let refreshImplementation = async () => ({ error: null });
  const sandbox = {
    Array,
    Date,
    Error,
    Map,
    Promise,
    String,
    DIGEST_GROUP_CACHE: new Map(),
    DIGEST_GROUP_CACHE_TTL_MS: 30_000,
    _appAccounts: [],
    selectedAccountId: () => 'account-1',
    accountForSelectionValue: () => null,
    accountCacheFingerprint: () => '',
    digestAbortError: message => Object.assign(new Error(message), { name: 'AbortError', status: 499 }),
    fetchGroupsApi: async (_accountId, options = {}) => {
      calls.push({
        forceGroups: options.forceGroups === true,
        forceMirror: options.forceMirror === true,
        signal: options.signal,
        groupRequestLease: options.groupRequestLease,
      });
      const gate = gates.shift();
      if (!gate) throw new Error('unexpected group fetch');
      if (options.signal?.aborted) throw options.signal.reason;
      return await new Promise((resolve, reject) => {
        const onAbort = () => {
          cleanup();
          reject(options.signal.reason);
        };
        const cleanup = () => options.signal?.removeEventListener?.('abort', onAbort);
        options.signal?.addEventListener?.('abort', onAbort, { once: true });
        gate.promise.then(
          value => {
            cleanup();
            resolve(value);
          },
          error => {
            cleanup();
            reject(error);
          },
        );
      });
    },
    accountContextRefreshRequired: () => false,
    refreshTopbarAccounts: options => refreshImplementation(options),
    accountsReferToSameAccount: () => true,
    accountFingerprintForValue: () => 'fingerprint-1',
    apiPlainObject: value => !!value && typeof value === 'object' && !Array.isArray(value),
    createSharedRequestLease,
  };
  vm.runInNewContext(`${implementation}\nglobalThis.__fetchGroups = fetchDigestGroups; globalThis.__groupCache = getDigestGroupCache; globalThis.__clearGroupCache = clearDigestGroupCache;`, sandbox, { timeout: 1_000 });
  return {
    sandbox,
    calls,
    setRefreshImplementation(next) {
      refreshImplementation = next;
    },
  };
}

async function verifyForceRefreshDoesNotReuseWeakInFlightRead() {
  const weak = deferred();
  const fresh = deferred();
  const { sandbox, calls } = createHarness([weak, fresh]);

  const weakRead = sandbox.__fetchGroups('account-1');
  await waitFor(() => calls.length === 1, 'weak group read did not start');
  assert.equal(calls[0].forceGroups, false);
  assert.equal(calls[0].forceMirror, false);

  const forcedRead = sandbox.__fetchGroups('account-1', { force: true });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls.length, 1, 'forced refresh should wait for the existing read before starting a second request');

  weak.resolve({ groups: [{ id: 'weak' }], mirrorReadiness: { source_busy: false } });
  assert.equal((await weakRead)[0].id, 'weak');
  await waitFor(() => calls.length === 2, 'forced refresh did not run after the weak read settled');
  assert.equal(calls[1].forceGroups, true);
  assert.equal(calls[1].forceMirror, false);

  fresh.resolve({ groups: [{ id: 'fresh' }], mirrorReadiness: { source_busy: false } });
  assert.equal((await forcedRead)[0].id, 'fresh', 'an explicit force refresh must not reuse a weak in-flight result');
}

async function verifyRevalidationBypassesOnlyTheBrowserCache() {
  const initial = deferred();
  const revalidated = deferred();
  const { sandbox, calls } = createHarness([initial, revalidated]);

  const initialRead = sandbox.__fetchGroups('account-1');
  await waitFor(() => calls.length === 1, 'initial group read did not start');
  initial.resolve({ groups: [{ id: 'cached' }], mirrorReadiness: { source_busy: false } });
  assert.equal((await initialRead)[0].id, 'cached');

  assert.equal((await sandbox.__fetchGroups('account-1'))[0].id, 'cached');
  assert.equal(calls.length, 1, 'a normal read should reuse a fresh browser cache');

  const revalidation = sandbox.__fetchGroups('account-1', { revalidate: true });
  await waitFor(() => calls.length === 2, 'revalidation did not enter the server');
  assert.equal(calls[1].forceGroups, false);
  assert.equal(calls[1].forceMirror, false, 'revalidation should let the server reuse an unchanged snapshot-bound group result');
  revalidated.resolve({ groups: [{ id: 'revalidated' }], mirrorReadiness: { source_busy: false } });
  assert.equal((await revalidation)[0].id, 'revalidated');
}

async function verifyRevalidationSharesAnExistingServerRead() {
  const pending = deferred();
  const { sandbox, calls } = createHarness([pending]);

  const initialRead = sandbox.__fetchGroups('account-1');
  await waitFor(() => calls.length === 1, 'shared group read did not start');
  const revalidation = sandbox.__fetchGroups('account-1', { revalidate: true });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls.length, 1, 'revalidation should share an existing server read instead of duplicating mirror checks');

  pending.resolve({ groups: [{ id: 'shared' }], mirrorReadiness: { source_busy: false } });
  assert.equal((await initialRead)[0].id, 'shared');
  assert.equal((await revalidation)[0].id, 'shared');
}

async function verifyDetachedCacheKeepsCurrentRequestCompletionTime() {
  const gate = deferred();
  const { sandbox, calls } = createHarness([gate]);
  const request = sandbox.__fetchGroups('account-1', { force: true });
  await waitFor(() => calls.length === 1, 'group request did not start');

  const detachedCache = sandbox.__groupCache('account-1');
  sandbox.__clearGroupCache('账号身份已由当前请求更新', { preserveLease: detachedCache.promiseLease });
  assert.equal(detachedCache.promiseLease.signal.aborted, false,
    'the request that proved an account identity transition must survive detaching its obsolete cache generation');
  gate.resolve({ groups: [{ id: 'current' }], mirrorReadiness: { source_busy: false } });
  assert.equal((await request)[0].id, 'current');
  assert.ok(Number(detachedCache.completedAt || 0) > 0, 'a detached request must retain its completion time for the current batch');
  assert.equal(detachedCache.groups.length, 0, 'a detached request must not republish rows into a cache scope that account refresh invalidated');
  assert.equal(detachedCache.mirrorReadiness?.source_busy, false,
    'the current batch must retain the exact server readiness evidence even when account refresh detaches its cache object');
}

async function verifyDetachedCacheKeepsAuthoritativeGroupContext() {
  const gate = deferred();
  const { sandbox, calls } = createHarness([gate]);
  const request = sandbox.__fetchGroups('account-1', { force: true });
  await waitFor(() => calls.length === 1, 'group-context request did not start');

  const detachedCache = sandbox.__groupCache('account-1');
  sandbox.__clearGroupCache('账号身份已由当前请求更新', { preserveLease: detachedCache.promiseLease });
  const groupContext = {
    id: 'dgc_authoritative_context',
    fetched_at_ms: Date.now(),
    stale: true,
    source_busy: true,
    offline: false,
  };
  gate.resolve({
    groups: [{ id: 'current' }],
    mirrorReadiness: { stale: true, source_busy: true, offline: false },
    groupContext,
  });
  await request;
  assert.equal(detachedCache.groupContext?.id, groupContext.id,
    'the current batch must retain the server-issued context id instead of rebuilding a trusted context from a client timestamp');
  assert.equal(detachedCache.groupContext?.fetched_at_ms, groupContext.fetched_at_ms);
  assert.equal(detachedCache.groupContext?.stale, true);
  assert.equal(detachedCache.groupContext?.source_busy, true);
  assert.equal(detachedCache.groupContext?.offline, false);
  assert.equal(sandbox.DIGEST_GROUP_CACHE.size, 0,
    'retaining request-local evidence must not republish a detached result into the invalidated global cache');
}

async function verifyCacheInvalidationAbortsDetachedWork() {
  const gate = deferred();
  const { sandbox, calls } = createHarness([gate]);
  const request = sandbox.__fetchGroups('account-1', { force: true });
  await waitFor(() => calls.length === 1, 'group request did not start before cache invalidation');

  const cache = sandbox.__groupCache('account-1');
  const lease = cache.promiseLease;
  sandbox.__clearGroupCache('账号上下文已变化');
  await assert.rejects(request, error => error?.name === 'AbortError' && /账号上下文已变化/.test(error.message));
  assert.equal(lease.signal.aborted, true,
    'invalidating the last cache consumer must abort the underlying HTTP read');
}

async function verifyAccountContextRecoveryPreservesItsOwnLease() {
  const stale = deferred();
  const recovered = deferred();
  const harness = createHarness([stale, recovered]);
  const { sandbox, calls } = harness;
  sandbox.accountContextRefreshRequired = error => error?.code === 'account_context_refresh_required';
  harness.setRefreshImplementation(async options => {
    assert.ok(options.preserveGroupRequestLease, 'account recovery must identify the request lease it owns');
    sandbox.__clearGroupCache('账号身份已由当前请求更新', {
      preserveLease: options.preserveGroupRequestLease,
    });
    assert.equal(options.preserveGroupRequestLease.signal.aborted, false,
      'account recovery must not cancel the request that is refreshing its own identity');
    return { error: null };
  });

  const request = sandbox.__fetchGroups('account-1', { force: true });
  await waitFor(() => calls.length === 1, 'initial group request did not start');
  stale.reject(Object.assign(new Error('account context changed'), { code: 'account_context_refresh_required' }));
  await waitFor(() => calls.length === 2, 'group request did not retry after account context refresh');
  assert.equal(calls[1].signal.aborted, false);
  recovered.resolve({ groups: [{ id: 'recovered' }], mirrorReadiness: { source_busy: false } });
  assert.equal((await request)[0].id, 'recovered');
}

await verifyForceRefreshDoesNotReuseWeakInFlightRead();
await verifyRevalidationBypassesOnlyTheBrowserCache();
await verifyRevalidationSharesAnExistingServerRead();
await verifyDetachedCacheKeepsCurrentRequestCompletionTime();
await verifyDetachedCacheKeepsAuthoritativeGroupContext();
await verifyCacheInvalidationAbortsDetachedWork();
await verifyAccountContextRecoveryPreservesItsOwnLease();
console.log('digest group-cache race tests passed');
