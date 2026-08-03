import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import vm from 'node:vm';

const source = await fsp.readFile(new URL('../src/renderer/output.js', import.meta.url), 'utf8');
const start = source.indexOf('function historyWorkProducerSnapshot(');
const end = source.indexOf('\nfunction historyWriteLockHeld(', start);
assert.ok(start >= 0 && end > start, 'history producer drain source must be inspectable');

let resolveFirst;
let resolveSecond;
const first = new Promise(resolve => { resolveFirst = resolve; });
const second = new Promise(resolve => { resolveSecond = resolve; });
const sandbox = {
  historyBaseDiscoveryQueue: Promise.resolve(),
  historyCombinedStateInFlight: { promise: first },
  historyCombinedStateProducers: new Set([first, second]),
  pendingHistoryRecoveries: new Map(),
  historySaveRecoveryInFlight: new Map(),
  historyPngWriteLocks: new Map(),
  historyWriteLockHeld: () => false,
  waitForHistoryWritesToSettle: async () => {},
  Promise,
  Set,
};
const executable = source
  .slice(start, end)
  .replace('export async function waitForHistoryWorkToSettle(', 'async function waitForHistoryWorkToSettle(');
vm.runInNewContext(`${executable}\nglobalThis.__waitForHistoryWorkToSettle = waitForHistoryWorkToSettle;`, sandbox, { timeout: 1000 });

let settled = false;
const drain = sandbox.__waitForHistoryWorkToSettle().then(() => { settled = true; });
resolveFirst();
await new Promise(resolve => setImmediate(resolve));
assert.equal(settled, false, 'history drain must not lose an older producer when the dedupe pointer is replaced');

resolveSecond();
await drain;
assert.equal(settled, true);

console.log('history combined-producer drain tests passed');
