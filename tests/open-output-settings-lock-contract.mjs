import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const routeStart = source.indexOf("if (pathname === '/api/open-output' && req.method === 'POST')");
const routeEnd = source.indexOf("if (pathname === '/api/logs' && req.method === 'GET')", routeStart);
assert.ok(routeStart >= 0 && routeEnd > routeStart, 'open-output route must remain available');
const route = source.slice(routeStart, routeEnd);
const transactionStart = route.indexOf('await withSettingsSaveTransaction(async () => {');
const transactionEnd = route.indexOf('\n      });', transactionStart);
const launchAt = route.indexOf('openDirectoryInSystem(dir, {');
assert.ok(transactionStart >= 0 && transactionEnd > transactionStart, 'open-output must prepare its settings-bound target inside a settings transaction');
assert.ok(launchAt > transactionEnd, 'the external Explorer launch must happen after releasing the global settings write lock');
assert.doesNotMatch(
  route.slice(transactionStart, transactionEnd),
  /openDirectoryInSystem\(/,
  'the settings write lock must not cover a potentially slow operating-system window action',
);
assert.ok(
  route.indexOf('markOutputDirChangedAfterLocalCommit(actionSettings, latestSettings, opener)') > launchAt,
  'open-output must still recheck the settings identity after the unlocked Explorer action commits',
);

console.log('open-output settings lock contract tests passed');
