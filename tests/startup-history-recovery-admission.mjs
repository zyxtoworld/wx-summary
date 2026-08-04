import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const source = await fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const mainStart = source.indexOf('export async function main()');
const mainEnd = source.indexOf('\nconst entry = process.argv[1]', mainStart);
assert.ok(mainStart >= 0 && mainEnd > mainStart, 'startup implementation must remain inspectable');

const mainSource = source.slice(mainStart, mainEnd);
const listenIndex = mainSource.indexOf('ACTIVE_SERVER = server;');
const runtimeInfoIndex = mainSource.indexOf('await writeRuntimeInfo(port);');
const signalIndex = mainSource.indexOf("process.on('SIGTERM', requestSignalShutdown);");
const recoveryIndex = mainSource.indexOf("schedulePendingHistoryRecovery(settings, { reason: 'startup', delayMs: 0 })");
const browserIndex = mainSource.indexOf('scheduleStartupBrowserOpen(');

assert.ok(listenIndex >= 0 && runtimeInfoIndex >= 0 && signalIndex >= 0 && recoveryIndex >= 0 && browserIndex >= 0);
assert.ok(
  listenIndex < runtimeInfoIndex
    && runtimeInfoIndex < signalIndex
    && signalIndex < recoveryIndex
    && recoveryIndex < browserIndex,
  'write-capable startup history recovery must begin only after every fallible service ownership step succeeds',
);
assert.equal(
  (mainSource.match(/schedulePendingHistoryRecovery\(settings, \{ reason: 'startup', delayMs: 0 \}\)/g) || []).length,
  1,
  'startup must schedule one history recovery producer',
);

console.log('startup history recovery admission contract passed');
