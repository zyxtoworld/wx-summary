import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const mainSource = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

const classifierStart = mainSource.indexOf('const LOCAL_ACTION_CAPABILITY_EXECUTION_FAILURE_CODES');
const classifierEnd = mainSource.indexOf('\nfunction invalidateLocalActionCapabilityCache(', classifierStart);
assert.ok(classifierStart >= 0 && classifierEnd > classifierStart, 'capability execution-failure classifier must exist');

const classifierContext = vm.createContext({});
vm.runInContext(
  `${mainSource.slice(classifierStart, classifierEnd)}\n`
    + 'globalThis.shouldInvalidate = localActionExecutionFailureInvalidatesCapabilityCache;',
  classifierContext,
);

assert.equal(classifierContext.shouldInvalidate({ code: 'opener_exited_early', status: 500 }), true);
assert.equal(classifierContext.shouldInvalidate({ code: 'local_action_process_missing', status: 501 }), true);
assert.equal(classifierContext.shouldInvalidate({ code: 'reveal_result_invalid', status: 500 }), true);
assert.equal(classifierContext.shouldInvalidate({ code: 'system_clipboard_image_unsupported', status: 501 }), true);
assert.equal(classifierContext.shouldInvalidate({ code: 'local_action_busy', status: 429 }), false);
assert.equal(classifierContext.shouldInvalidate({ code: 'local_action_outcome_unknown', status: 500 }), false);
assert.equal(classifierContext.shouldInvalidate({ name: 'AbortError', status: 499 }), false);
assert.equal(classifierContext.shouldInvalidate({ code: 'history_file_changed', status: 409 }), false);
assert.equal(classifierContext.shouldInvalidate({ code: 'opener_failed', status: 500 }, { committed: true }), false);

const probeSource = mainSource.slice(
  mainSource.indexOf('async function probeLocalActionCapabilitySnapshot('),
  mainSource.indexOf('async function localActionCapabilitySnapshot('),
);
const snapshotSource = mainSource.slice(
  mainSource.indexOf('async function localActionCapabilitySnapshot('),
  mainSource.indexOf('function localActionCapabilitySnapshotCacheMs('),
);
const invalidationSource = mainSource.slice(
  mainSource.indexOf('function invalidateLocalActionCapabilityCache('),
  mainSource.indexOf('function localActionCapabilityByName('),
);

assert.ok(mainSource.includes('let LOCAL_ACTION_CAPABILITY_CACHE_GENERATION = 0'));
assert.ok(mainSource.includes('const LOCAL_ACTION_CAPABILITY_PRODUCERS = new Set()'));
assert.ok(!probeSource.includes('LOCAL_ACTION_CAPABILITY_CACHE = {'), 'raw probes must not publish their own stale result');
assert.ok(snapshotSource.includes('generation: cacheGeneration'));
assert.ok(snapshotSource.includes('controller: new AbortController()'));
assert.ok(snapshotSource.includes('probeLocalActionCapabilitySnapshot({ signal: entry.controller.signal })'));
assert.ok(snapshotSource.includes('cacheGeneration === LOCAL_ACTION_CAPABILITY_CACHE_GENERATION'));
assert.ok(snapshotSource.includes('return localActionCapabilitySnapshot({ force: true, signal })'));
assert.ok(invalidationSource.includes('LOCAL_ACTION_CAPABILITY_CACHE_GENERATION += 1'));
assert.ok(invalidationSource.includes("LOCAL_ACTION_CAPABILITY_CACHE = { at: 0, platform: '', snapshot: null }"));
assert.ok(invalidationSource.includes('error.local_action_capability_invalidated = true'));
assert.ok(invalidationSource.includes('async function runLocalActionWithCapabilityCacheGuard('));
assert.ok(invalidationSource.includes('function localActionLateFailureCallback('));

const raceContext = vm.createContext({ AbortController, Date, Promise, Set, process: { platform: 'win32' } });
vm.runInContext(`
  let SHUTDOWN_REQUESTED = false;
  let SHUTTING_DOWN = false;
  let LOCAL_ACTION_CAPABILITY_CACHE = { at: 0, platform: '', snapshot: null };
  let LOCAL_ACTION_CAPABILITY_CACHE_GENERATION = 0;
  let LOCAL_ACTION_CAPABILITY_IN_FLIGHT = null;
  const LOCAL_ACTION_CAPABILITY_PRODUCERS = new Set();
  const probeResolvers = [];
  function requestAbortError(message) { const error = new Error(message); error.name = 'AbortError'; return error; }
  function throwIfRequestSignalAborted() {}
  function localActionCapabilitySnapshotCacheMs(snapshot) { return snapshot ? 600000 : 0; }
  function probeLocalActionCapabilitySnapshot() {
    return new Promise(resolve => probeResolvers.push(resolve));
  }
  function awaitOperationWithSignal(promise) { return promise; }
  ${snapshotSource}
  globalThis.readSnapshot = localActionCapabilitySnapshot;
  globalThis.invalidate = () => {
    LOCAL_ACTION_CAPABILITY_CACHE_GENERATION += 1;
    LOCAL_ACTION_CAPABILITY_CACHE = { at: 0, platform: '', snapshot: null };
  };
  globalThis.probeCount = () => probeResolvers.length;
  globalThis.resolveProbe = (index, value) => probeResolvers[index](value);
  globalThis.cachedSnapshot = () => LOCAL_ACTION_CAPABILITY_CACHE.snapshot;
`, raceContext);

const racedRead = raceContext.readSnapshot();
await new Promise(resolve => setImmediate(resolve));
assert.equal(raceContext.probeCount(), 1);
raceContext.invalidate();
raceContext.resolveProbe(0, { id: 'stale' });
await new Promise(resolve => setImmediate(resolve));
assert.equal(raceContext.probeCount(), 2, 'a stale in-flight result must trigger a fresh generation probe');
raceContext.resolveProbe(1, { id: 'fresh' });
assert.equal((await racedRead).id, 'fresh');
assert.equal(raceContext.cachedSnapshot().id, 'fresh');

assert.ok((mainSource.match(/runLocalActionWithCapabilityCacheGuard\('reveal_in_folder'/g) || []).length >= 2);
assert.ok((mainSource.match(/runLocalActionWithCapabilityCacheGuard\('system_clipboard_text'/g) || []).length >= 2);
assert.ok(mainSource.includes("runLocalActionWithCapabilityCacheGuard('system_clipboard_image'"));
assert.ok(mainSource.includes("runLocalActionWithCapabilityCacheGuard('open_output'"));
assert.ok((mainSource.match(/localActionLateFailureCallback\('reveal_in_folder'/g) || []).length >= 2);
assert.ok(mainSource.includes("localActionLateFailureCallback('open_output'"));
assert.ok(mainSource.includes('local_action_capability_invalidated: error?.local_action_capability_invalidated === true'));

const apiErrorSource = mainSource.slice(mainSource.indexOf('function apiError('), mainSource.indexOf('\nfunction sendProviderErrorResponse('));
assert.ok(apiErrorSource.includes('err?.local_action_capability_invalidated === true'));
assert.ok(apiErrorSource.includes('body.local_action_capability_invalidated = true'));

console.log('local action capability cache invalidation tests passed');
