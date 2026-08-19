import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const readinessStart = source.indexOf('async function ensureDigestBatchMirrorReadiness(');
const start = source.indexOf('async function forceDigestBatchMirrorReadiness(');
const end = source.indexOf('\nconst TRUSTED_POSIX_SYSTEM_COMMAND_PATHS', start);
assert.ok(readinessStart >= 0 && start > readinessStart && end > start, 'batch mirror readiness helpers must remain available');

const readinessImplementation = source.slice(readinessStart, start);
const implementation = source.slice(start, end);
assert.match(
  readinessImplementation,
  /const mirrorController = digestBatchMirrorReadinessController\(entry, cleanAccountId\);[\s\S]*?signal: mirrorController\.signal,[\s\S]*?awaitDigestBatchMirrorOperation\(entry, cleanAccountId, 'readiness', shared, signal\);/,
  'the initial shared copy must belong to the batch while each request can stop waiting independently',
);
assert.match(
  readinessImplementation,
  /const pendingRecovery = entry\.mirror_recovery_in_flight_by_account\.get\(cleanAccountId\) \|\| null;[\s\S]*?await awaitDigestBatchMirrorOperation\(entry, cleanAccountId, 'recovery', pendingRecovery, signal\);[\s\S]*?assertDigestBatchMirrorReadinessAuthorization\(readiness, allowStaleAccount\)/,
  'a request waiting for another group\'s forced recovery must stop promptly on cancellation and recheck authorization before reuse',
);
assert.match(
  implementation,
  /const recoveryWasAborted = requestSignalAborted\(null, error\);/,
  'a cancelled owner request must be identified before caching a batch recovery failure',
);
assert.match(
  implementation,
  /if \(!recoveryWasAborted && DIGEST_BATCH_SETTINGS\.get\(id\) === entry\) \{\s*entry\.mirror_recovery_by_account\.set\(cleanAccountId, \{ error \}\);/s,
  'only a non-cancellation recovery failure may become shared batch state',
);
assert.match(
  implementation,
  /for \(let attempt = 0; attempt < 2; attempt \+= 1\) \{[\s\S]*?if \(signal\?\.aborted\) throw signal\.reason instanceof Error \? signal\.reason : error;[\s\S]*?if \(attempt > 0 \|\| !requestSignalAborted\(null, error\)\) throw error;/,
  'a surviving group must retry once after an unexpected forced shared mirror recovery cancellation',
);
assert.match(
  implementation,
  /const recoveryController = digestBatchMirrorRecoveryController\(entry, cleanAccountId\);[\s\S]*?signal: recoveryController\.signal,[\s\S]*?awaitDigestBatchMirrorOperation\(entry, cleanAccountId, 'recovery', shared, signal\);/,
  'the shared forced copy must belong to the batch while each request can stop waiting independently',
);
assert.match(
  source,
  /function abortDigestBatchMirrorRecoveries\(entry,/,
  'batch-owned forced mirror copies must have an explicit cancellation helper',
);
assert.match(
  source,
  /entry\?\.mirror_readiness_controllers_by_account,[\s\S]*?entry\?\.mirror_recovery_controllers_by_account,/,
  'batch cleanup must stop both initial and forced mirror copies',
);
assert.match(
  source,
  /if \(shouldAbortSaves\) \{\s*abortDigestBatchMirrorRecoveries\(DIGEST_BATCH_SETTINGS\.get\(id\),/,
  'hard cancellation must also stop a batch-owned forced mirror copy',
);
const abortActiveDigestBatchStart = source.indexOf('function abortActiveDigestBatch(');
const abortActiveDigestBatchEnd = source.indexOf('\nfunction digestBatchHasActiveSave(', abortActiveDigestBatchStart);
assert.ok(abortActiveDigestBatchStart >= 0 && abortActiveDigestBatchEnd > abortActiveDigestBatchStart, 'single-batch cancellation helper must remain available');
const abortActiveDigestBatchSource = source.slice(abortActiveDigestBatchStart, abortActiveDigestBatchEnd);
assert.match(
  abortActiveDigestBatchSource,
  /abortControllerQuietly\(ACTIVE_DIGEST_BATCH_START_CONTROLLERS\.get\(id\), cleanReason\)/,
  'user cancellation must also stop an in-flight batch-start preflight before any group request exists',
);
const cancelActiveDigestWorkStart = source.indexOf('function cancelActiveDigestWork(');
const cancelActiveDigestWorkEnd = source.indexOf('\nfunction activeTaskAgeMs(', cancelActiveDigestWorkStart);
assert.ok(cancelActiveDigestWorkStart >= 0 && cancelActiveDigestWorkEnd > cancelActiveDigestWorkStart, 'global digest cancellation helper must remain available');
const cancelActiveDigestWorkSource = source.slice(cancelActiveDigestWorkStart, cancelActiveDigestWorkEnd);
assert.match(cancelActiveDigestWorkSource, /clearDigestBatchSettings\(cleanReason, \{ preserveTerminalResults \}\);/, 'global digest cancellation must release batch-owned mirror recovery controllers while honoring shutdown-only terminal-result preservation');
assert.doesNotMatch(cancelActiveDigestWorkSource, /DIGEST_BATCH_SETTINGS\.clear\(\);/, 'global digest cancellation must not bypass batch cleanup hooks');
assert.match(
  cancelActiveDigestWorkSource,
  /const cachedBatchSettings = cleanAccountId[\s\S]*?\? clearDigestBatchSettingsForAccount\(cleanAccountId, cleanReason, \{ preserveTerminalResults \}\)[\s\S]*?: clearDigestBatchSettings\(cleanReason, \{ preserveTerminalResults \}\);[\s\S]*?cached_batch_settings: cachedBatchSettings/,
  'digest cancellation should clear only the active account snapshots when scoped, preserve the global fallback, and report the single cleanup result',
);
assert.match(cancelActiveDigestWorkSource, /ACTIVE_DIGEST_BATCH_START_CONTROLLERS\.keys\(\)/, 'global digest cancellation must include batch-start requests that have not yet registered a group request');
assert.match(cancelActiveDigestWorkSource, /const controller = ACTIVE_DIGEST_BATCH_START_CONTROLLERS\.get\(id\);[\s\S]*?abortControllerQuietly\(controller, message\)/, 'settings changes must abort an in-flight batch-start preflight instead of only marking its lease cancelled');
assert.match(cancelActiveDigestWorkSource, /return \{ requests, saves, starts, leases, batches: batches\.size, aborted, cached_batch_settings: cachedBatchSettings \};/, 'batch-start cancellation must be reported alongside active generation and save work');
const batchSettingsStart = source.indexOf('async function createDigestBatchSettings(');
const batchSettingsEnd = source.indexOf('\nfunction digestBatchPreflightWarnings(', batchSettingsStart);
assert.ok(batchSettingsStart >= 0 && batchSettingsEnd > batchSettingsStart, 'batch settings snapshot creator must remain available');
const batchSettingsSource = source.slice(batchSettingsStart, batchSettingsEnd);
assert.ok(
  batchSettingsSource.lastIndexOf("throwIfDigestBatchCancelled(id, '生成已取消，已停止创建批次设置。');")
    > batchSettingsSource.indexOf('const preflightWarnings = await inspectDigestLlmModelsAvailable(snapshot, { signal });')
    && batchSettingsSource.lastIndexOf("throwIfDigestBatchCancelled(id, '生成已取消，已停止创建批次设置。');")
      < batchSettingsSource.indexOf('DIGEST_BATCH_SETTINGS.set(id, {'),
  'a batch-start preflight must recheck cancellation before publishing an old settings snapshot',
);
const batchStartRouteStart = source.indexOf("if (pathname === '/api/digest-batch-start' && req.method === 'POST')");
const batchStartRouteEnd = source.indexOf("\n  if (pathname === '/api/digest-batch-finish'", batchStartRouteStart);
assert.ok(batchStartRouteStart >= 0 && batchStartRouteEnd > batchStartRouteStart, 'digest batch-start route must remain available');
const batchStartRouteSource = source.slice(batchStartRouteStart, batchStartRouteEnd);
assert.match(batchStartRouteSource, /ACTIVE_DIGEST_BATCH_START_CONTROLLERS\.set\(activeBatchStartId, abort\.controller\);/, 'batch-start route must register its abort controller for settings changes');
assert.match(batchStartRouteSource, /ACTIVE_DIGEST_BATCH_START_CONTROLLERS\.delete\(activeBatchStartId\);/, 'batch-start route must release its controller after finishing');
assert.ok(
  batchStartRouteSource.indexOf('settings = await createDigestBatchSettings')
    < batchStartRouteSource.indexOf("throwIfDigestBatchCancelled(batchId, '生成已取消。', { token: owner.token });"),
  'batch-start route must recheck cancellation after the async settings snapshot creator returns',
);
assert.match(
  source,
  /while \(\(ACTIVE_DIGEST_REQUESTS\.size \|\| ACTIVE_DIGEST_SAVES\.size \|\| ACTIVE_DIGEST_BATCH_STARTS\.size\) && Date\.now\(\) < deadline\)/,
  'digest settlement waits must include batch-start requests before clearing key caches or shutdown files',
);
const abortControllerStart = source.indexOf('function abortControllerQuietly(');
const abortControllerEnd = source.indexOf('\nfunction digestBatchHasActiveSave(', abortControllerStart);
assert.ok(abortControllerStart >= 0 && abortControllerEnd > abortControllerStart, 'batch abort helpers must remain available');
const batchCancelSandbox = {
  AbortController,
  Map,
  Error,
  ACTIVE_DIGEST_BATCH_START_CONTROLLERS: new Map(),
  ACTIVE_DIGEST_REQUESTS: new Map(),
  ACTIVE_DIGEST_SAVES: new Map(),
  normalizeDigestBatchId: value => String(value || '').trim(),
  sanitizeText: value => String(value || ''),
  requestAbortError: message => Object.assign(new Error(message), { name: 'AbortError', status: 499 }),
};
vm.runInNewContext(`${source.slice(abortControllerStart, abortControllerEnd)}\nglobalThis.__abortBatch = abortActiveDigestBatch;`, batchCancelSandbox, { timeout: 1_000 });
const batchStartController = new AbortController();
batchCancelSandbox.ACTIVE_DIGEST_BATCH_START_CONTROLLERS.set('batch-start-cancel', batchStartController);
assert.equal(batchCancelSandbox.__abortBatch('batch-start-cancel', 'user_cancelled'), 1, 'single-batch cancellation should count the batch-start controller');
assert.equal(batchStartController.signal.aborted, true, 'single-batch cancellation should abort a batch-start preflight immediately');
const digestRuntimeCommitStart = source.indexOf("if (digestRuntimeChanged) {", source.indexOf('const outputDirChanged = settingsPatchChangesOutputDir'));
const digestRuntimeCommitEnd = source.indexOf('\n        try {', digestRuntimeCommitStart);
assert.ok(digestRuntimeCommitStart >= 0 && digestRuntimeCommitEnd > digestRuntimeCommitStart, 'settings runtime-change cleanup block must remain available');
const digestRuntimeCommitSource = source.slice(digestRuntimeCommitStart, digestRuntimeCommitEnd);
assert.match(digestRuntimeCommitSource, /const cancelled = cancelActiveDigestWork\('digest_runtime_changed'/, 'settings changes must cancel active digest work through the shared lifecycle entry point');
assert.ok(
  digestRuntimeCommitSource.indexOf("cancelActiveDigestWork('digest_runtime_changed'")
    < digestRuntimeCommitSource.indexOf("clearDigestBatchSettings('digest_runtime_changed')"),
  'settings changes must clear remaining batch controllers only after request cancellation starts',
);
assert.match(digestRuntimeCommitSource, /cancelled\.cached_batch_settings/, 'settings warning text must use the cleanup count returned by the shared lifecycle entry point');
assert.match(
  digestRuntimeCommitSource,
  /const cachedBatchCount = Math\.max\(0, Number\(cancelled\.cached_batch_settings \|\| 0\) \|\| 0\)\s*\+ Math\.max\(0, Number\(postCancelBatchCount \|\| 0\) \|\| 0\);/,
  'separate pre- and post-cancellation snapshot sweeps must report their combined count',
);

function abortError(message = 'cancelled') {
  return Object.assign(new Error(message), { name: 'AbortError', status: 499 });
}

function awaitWithSignal(operation, signal = null) {
  if (!signal) return Promise.resolve(operation);
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : abortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      action(value);
    };
    const onAbort = () => finish(reject, signal.reason instanceof Error ? signal.reason : abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(
      value => finish(resolve, value),
      error => finish(reject, error),
    );
  });
}

const readinessHelperStart = source.indexOf('function digestBatchMirrorOperationMaps(');
assert.ok(readinessHelperStart >= 0 && readinessHelperStart < start, 'batch-owned initial mirror controller helper must remain available');
const isolatedRecoverySource = `${source.slice(readinessHelperStart, end)}\nglobalThis.__ensure = ensureDigestBatchMirrorReadiness;\nglobalThis.__force = forceDigestBatchMirrorReadiness;`;
const pendingMirrors = [];
const batchEntries = new Map();
let enforceReadinessIdentity = false;
const sandbox = {
  AbortController,
  Error,
  Map,
  Promise,
  Date,
  DIGEST_BATCH_SETTINGS: batchEntries,
  normalizeDigestBatchId: value => String(value || '').trim(),
  cleanupDigestBatchSettings: () => {},
  DIGEST_BATCH_MIRROR_RECHECK_INTERVAL_MS: 10 * 60 * 1000,
  requestValidationError: (message, status = 400, code = '') => Object.assign(new Error(message), { status, code, public_code: code }),
  digestBatchMirrorReadinessIdentity: value => !!value?.snapshot,
  digestBatchMirrorReadinessError: (previous, current) => enforceReadinessIdentity && previous?.snapshot !== current?.snapshot
    ? Object.assign(new Error('snapshot changed'), { status: 409, code: 'wxdb_mirror_readiness_changed' })
    : null,
  digestBatchMirrorReadinessFromMirrorResult: result => result,
  requestSignalAborted: (_signal, error = null) => error?.name === 'AbortError' || error?.status === 499,
  throwIfRequestSignalAborted: (signal, message) => {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError(message);
  },
  awaitOperationWithSignal: awaitWithSignal,
  abortControllerQuietly: (controller, message) => {
    if (!controller || controller.signal.aborted) return false;
    controller.abort(abortError(message));
    return true;
  },
  ensureWxDbMirror: options => new Promise((resolve, reject) => {
    const pending = { options, resolve, reject };
    pendingMirrors.push(pending);
    options.signal?.addEventListener('abort', () => reject(options.signal.reason instanceof Error ? options.signal.reason : abortError()), { once: true });
  }),
};
vm.runInNewContext(isolatedRecoverySource, sandbox, { timeout: 1_000 });

const normalBatchEntry = {
  mirror_readiness_by_account: new Map(),
  mirror_in_flight_by_account: new Map(),
  mirror_readiness_prepared_at_by_account: new Map(),
  mirror_recovery_by_account: new Map(),
  mirror_recovery_in_flight_by_account: new Map(),
};
batchEntries.set('batch-normal', normalBatchEntry);
const normalDisconnectedCaller = new AbortController();
const normalSurvivingCaller = new AbortController();
const normalFirstWaiter = sandbox.__ensure('batch-normal', 'account-1', { signal: normalDisconnectedCaller.signal });
assert.equal(pendingMirrors.length, 1, 'the first normal readiness call should start exactly one mirror copy');
assert.notEqual(pendingMirrors[0].options.signal, normalDisconnectedCaller.signal, 'the initial shared mirror copy must not use the first SSE request signal');
const normalSecondWaiter = sandbox.__ensure('batch-normal', 'account-1', { signal: normalSurvivingCaller.signal });
assert.equal(pendingMirrors.length, 1, 'a concurrent group should wait for the same initial mirror copy');

normalDisconnectedCaller.abort(abortError('first normal SSE disconnected'));
await assert.rejects(normalFirstWaiter, error => error?.name === 'AbortError', 'the disconnected normal group should stop waiting promptly');
assert.equal(pendingMirrors[0].options.signal.aborted, false, 'the initial shared mirror copy must continue after one SSE disconnects');
pendingMirrors[0].resolve({ snapshot: 'initial' });
assert.deepEqual(await normalSecondWaiter, { snapshot: 'initial' }, 'a surviving group must reuse the still-running initial batch-owned mirror copy');
assert.equal(pendingMirrors.length, 1, 'a surviving group must not launch a duplicate initial mirror copy after another caller disconnects');

const mixedAuthorizationEntry = {
  mirror_readiness_by_account: new Map(),
  mirror_in_flight_by_account: new Map(),
  mirror_readiness_prepared_at_by_account: new Map(),
  mirror_recovery_by_account: new Map(),
  mirror_recovery_in_flight_by_account: new Map(),
};
batchEntries.set('batch-mixed-authorization', mixedAuthorizationEntry);
const mixedMirrorIndex = pendingMirrors.length;
const staleAuthorizedWaiter = sandbox.__ensure('batch-mixed-authorization', 'account-1', { allowStaleAccount: true });
assert.equal(pendingMirrors.length, mixedMirrorIndex + 1, 'the stale-authorized request should start one batch-owned mirror preparation');
const strictWaiter = sandbox.__ensure('batch-mixed-authorization', 'account-1', { allowStaleAccount: false });
pendingMirrors[mixedMirrorIndex].resolve({ snapshot: 'stale-authorized', stale: true, offline: true });
assert.deepEqual(await staleAuthorizedWaiter, { snapshot: 'stale-authorized', stale: true, offline: true });
await assert.rejects(strictWaiter, error => error?.code === 'digest_batch_mirror_authorization_changed',
  'a strict request must not join or reuse a stale-authorized mirror operation in the same batch');

const strictCachedStaleEntry = {
  mirror_readiness_by_account: new Map([['account-1', { snapshot: 'cached-stale', stale: true, offline: true }]]),
  mirror_in_flight_by_account: new Map(),
  mirror_readiness_prepared_at_by_account: new Map([['account-1', Date.now()]]),
  mirror_recovery_by_account: new Map(),
  mirror_recovery_in_flight_by_account: new Map(),
};
batchEntries.set('batch-strict-cached-stale', strictCachedStaleEntry);
await assert.rejects(
  sandbox.__ensure('batch-strict-cached-stale', 'account-1', { allowStaleAccount: false }),
  error => error?.code === 'digest_batch_mirror_authorization_mismatch',
  'strict mode must reject stale/offline readiness even when legacy cache state lacks an authorization marker',
);

enforceReadinessIdentity = true;
const periodicPreparedAt = Date.now() - sandbox.DIGEST_BATCH_MIRROR_RECHECK_INTERVAL_MS - 1;
const periodicBatchEntry = {
  mirror_readiness_by_account: new Map([['account-1', { snapshot: 'periodic-stable' }]]),
  mirror_in_flight_by_account: new Map(),
  mirror_readiness_prepared_at_by_account: new Map([['account-1', periodicPreparedAt]]),
  mirror_recovery_by_account: new Map(),
  mirror_recovery_in_flight_by_account: new Map(),
};
batchEntries.set('batch-periodic', periodicBatchEntry);
const periodicMirrorIndex = pendingMirrors.length;
const periodicFirstProgress = [];
const periodicSecondProgress = [];
const periodicFirstWaiter = sandbox.__ensure('batch-periodic', 'account-1', {
  onProgress: progress => periodicFirstProgress.push(progress?.phase),
});
const periodicSecondWaiter = sandbox.__ensure('batch-periodic', 'account-1', {
  onProgress: progress => periodicSecondProgress.push(progress?.phase),
});
assert.equal(pendingMirrors.length, periodicMirrorIndex + 1, 'concurrent groups should share one periodic source-metadata recheck');
assert.ok(periodicFirstProgress.includes('fetch_mirror_batch_recheck'), 'the periodic recheck owner should report its concrete phase');
assert.ok(periodicSecondProgress.includes('fetch_mirror_batch_recheck_wait'), 'a concurrent group should report that it is waiting for the shared periodic recheck');
pendingMirrors[periodicMirrorIndex].resolve({ snapshot: 'periodic-stable' });
assert.deepEqual(await periodicFirstWaiter, { snapshot: 'periodic-stable' }, 'an unchanged periodic snapshot should remain usable by the batch');
assert.deepEqual(await periodicSecondWaiter, { snapshot: 'periodic-stable' }, 'all periodic recheck waiters should receive the same unchanged snapshot');
assert.ok(periodicBatchEntry.mirror_readiness_prepared_at_by_account.get('account-1') > periodicPreparedAt, 'a successful periodic recheck should advance the next recheck deadline');

const changedBatchEntry = {
  mirror_readiness_by_account: new Map([['account-1', { snapshot: 'before-change' }]]),
  mirror_in_flight_by_account: new Map(),
  mirror_readiness_prepared_at_by_account: new Map([['account-1', Date.now() - sandbox.DIGEST_BATCH_MIRROR_RECHECK_INTERVAL_MS - 1]]),
  mirror_recovery_by_account: new Map(),
  mirror_recovery_in_flight_by_account: new Map(),
};
batchEntries.set('batch-periodic-changed', changedBatchEntry);
const changedMirrorIndex = pendingMirrors.length;
const changedWaiter = sandbox.__ensure('batch-periodic-changed', 'account-1');
assert.equal(pendingMirrors.length, changedMirrorIndex + 1, 'an expired periodic check should inspect source metadata once');
pendingMirrors[changedMirrorIndex].resolve({ snapshot: 'after-change' });
await assert.rejects(changedWaiter, error => error?.code === 'wxdb_mirror_readiness_changed', 'a changed periodic snapshot must stop the batch instead of mixing old and new project copies');
assert.deepEqual(changedBatchEntry.mirror_readiness_by_account.get('account-1'), { snapshot: 'before-change' }, 'a rejected periodic recheck must not publish the changed snapshot into the current batch');
enforceReadinessIdentity = false;

const orphanBatchEntry = {
  mirror_readiness_by_account: new Map(),
  mirror_in_flight_by_account: new Map(),
  mirror_readiness_prepared_at_by_account: new Map(),
  mirror_recovery_by_account: new Map(),
  mirror_recovery_in_flight_by_account: new Map(),
};
batchEntries.set('batch-orphan', orphanBatchEntry);
const orphanCaller = new AbortController();
const orphanMirrorIndex = pendingMirrors.length;
const orphanWaiter = sandbox.__ensure('batch-orphan', 'account-1', { signal: orphanCaller.signal });
assert.equal(pendingMirrors.length, orphanMirrorIndex + 1, 'an orphan test should start one batch-owned mirror copy');
orphanCaller.abort(abortError('last SSE recovery window expired'));
await assert.rejects(orphanWaiter, error => error?.name === 'AbortError', 'the last cancelled waiter should stop waiting promptly');
assert.equal(pendingMirrors[orphanMirrorIndex].options.signal.aborted, true, 'the batch-owned mirror copy should stop when its last waiter is cancelled');

const batchEntry = {
  mirror_readiness_by_account: new Map(),
  mirror_readiness_prepared_at_by_account: new Map(),
  mirror_recovery_by_account: new Map(),
  mirror_recovery_in_flight_by_account: new Map(),
};
batchEntries.set('batch-1', batchEntry);
const disconnectedCaller = new AbortController();
const survivingCaller = new AbortController();
const forcedMirrorIndex = pendingMirrors.length;
const firstWaiter = sandbox.__force('batch-1', 'account-1', { snapshot: 'before' }, { signal: disconnectedCaller.signal });
assert.equal(pendingMirrors.length, forcedMirrorIndex + 1, 'the first forced recovery should start exactly one mirror copy');
assert.notEqual(pendingMirrors[forcedMirrorIndex].options.signal, disconnectedCaller.signal, 'the shared mirror copy must not use the first SSE request signal');
const secondWaiter = sandbox.__force('batch-1', 'account-1', { snapshot: 'before' }, { signal: survivingCaller.signal });
assert.equal(pendingMirrors.length, forcedMirrorIndex + 1, 'a concurrent group should wait for the same forced mirror copy');

disconnectedCaller.abort(abortError('first SSE disconnected'));
await assert.rejects(firstWaiter, error => error?.name === 'AbortError', 'the disconnected group should stop waiting promptly');
assert.equal(pendingMirrors[forcedMirrorIndex].options.signal.aborted, false, 'the shared mirror copy must continue after one SSE disconnects');
pendingMirrors[forcedMirrorIndex].resolve({ snapshot: 'after' });
assert.deepEqual(await secondWaiter, { snapshot: 'after' }, 'a surviving group must reuse the still-running batch-owned mirror copy');
assert.equal(pendingMirrors.length, forcedMirrorIndex + 1, 'a surviving group must not launch a duplicate mirror copy after another caller disconnects');

const staleBatchEntry = {
  mirror_readiness_by_account: new Map(),
  mirror_readiness_prepared_at_by_account: new Map(),
  mirror_recovery_by_account: new Map(),
  mirror_recovery_in_flight_by_account: new Map(),
};
batchEntries.set('batch-stale', staleBatchEntry);
const staleMirrorIndex = pendingMirrors.length;
const staleWaiter = sandbox.__force('batch-stale', 'account-1', { snapshot: 'before' });
assert.equal(pendingMirrors.length, staleMirrorIndex + 1, 'the stale-entry test should start one forced mirror copy');
batchEntries.delete('batch-stale');
staleBatchEntry.mirror_recovery_controllers_by_account.get('account-1').abort(abortError('batch cleanup'));
await assert.rejects(staleWaiter, error => error?.code === 'digest_batch_settings_missing', 'a deleted batch entry must not restart a forced mirror copy after shared cancellation');
assert.equal(pendingMirrors.length, staleMirrorIndex + 1, 'a deleted batch entry must not launch a replacement mirror copy');
