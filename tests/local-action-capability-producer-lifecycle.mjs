import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import vm from 'node:vm';

const source = await fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const start = source.indexOf('function localActionCapabilityProducerSnapshot(');
const end = source.indexOf('\nfunction localActionCapabilitySnapshotCacheMs(', start);
assert.ok(start >= 0 && end > start, 'local capability producer lifecycle helpers must be inspectable');

const sandbox = vm.createContext({ AbortController, Date, Error, Promise, Set, process: { platform: 'win32' } });
vm.runInContext(`
  let SHUTDOWN_REQUESTED = false;
  let SHUTTING_DOWN = false;
  let LOCAL_ACTION_CAPABILITY_CACHE = { at: 0, platform: '', snapshot: null };
  let LOCAL_ACTION_CAPABILITY_CACHE_GENERATION = 0;
  let LOCAL_ACTION_CAPABILITY_IN_FLIGHT = null;
  const LOCAL_ACTION_CAPABILITY_PRODUCERS = new Set();
  const probes = [];
  function requestAbortError(message) {
    const error = new Error(message);
    error.name = 'AbortError';
    error.code = 'request_aborted';
    return error;
  }
  function throwIfRequestSignalAborted(signal, message) {
    if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : requestAbortError(message));
  }
  function localActionCapabilitySnapshotCacheMs(snapshot) { return snapshot ? 600000 : 0; }
  function probeLocalActionCapabilitySnapshot({ signal } = {}) {
    return new Promise((resolve, reject) => {
      const probe = { signal, resolve, reject };
      probes.push(probe);
      signal?.addEventListener?.('abort', () => reject(signal.reason), { once: true });
    });
  }
  function awaitOperationWithSignal(promise) { return promise; }
  ${source.slice(start, end)}
  globalThis.__read = localActionCapabilitySnapshot;
  globalThis.__cancel = cancelLocalActionCapabilityProbes;
  globalThis.__drain = waitForLocalActionCapabilityProbesToSettle;
  globalThis.__invalidate = () => {
    LOCAL_ACTION_CAPABILITY_CACHE_GENERATION += 1;
    LOCAL_ACTION_CAPABILITY_CACHE = { at: 0, platform: '', snapshot: null };
  };
  globalThis.__shutdown = () => { SHUTDOWN_REQUESTED = true; };
  globalThis.__probeCount = () => probes.length;
  globalThis.__producerCount = () => LOCAL_ACTION_CAPABILITY_PRODUCERS.size;
  globalThis.__signals = () => probes.map(probe => probe.signal);
`, sandbox, { timeout: 1000 });

const first = sandbox.__read().catch(error => error);
await new Promise(resolve => setImmediate(resolve));
sandbox.__invalidate();
const second = sandbox.__read().catch(error => error);
await new Promise(resolve => setImmediate(resolve));

assert.equal(sandbox.__probeCount(), 2, 'cache invalidation may overlap two probe generations');
assert.equal(sandbox.__producerCount(), 2, 'all overlapping generations must remain service-owned');

sandbox.__shutdown();
const cancelled = sandbox.__cancel('service_shutdown');
assert.equal(cancelled.active, 2);
assert.equal(cancelled.aborted, 2);
const drained = await sandbox.__drain();
assert.equal(drained.active, 0);
assert.equal(sandbox.__producerCount(), 0);
assert.ok(sandbox.__signals().every(signal => signal.aborted), 'shutdown must abort every producer generation');
assert.equal((await first).name, 'AbortError');
assert.equal((await second).name, 'AbortError');

await assert.rejects(
  () => sandbox.__read(),
  error => error?.name === 'AbortError' && /关闭/.test(error.message),
  'shutdown must reject new probe admission instead of recreating a producer during drain',
);
assert.equal(sandbox.__producerCount(), 0);

console.log('local action capability producer lifecycle tests passed');
