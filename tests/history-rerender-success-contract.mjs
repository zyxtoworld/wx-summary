import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const [appSource, mainSource] = await Promise.all([
  fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8'),
  fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
]);

const assertionStart = appSource.indexOf('function assertHistoryRerenderCommitResponse(');
assert.notEqual(assertionStart, -1, 'history rerender must have a dedicated committed-response validator');
const assertionEnd = appSource.indexOf('\nfunction ', assertionStart + 10);
const assertionSource = appSource.slice(assertionStart, assertionEnd > assertionStart ? assertionEnd : assertionStart + 5000);
for (const evidence of [
  'result.ok !== true',
  'result.local_action_committed !== true',
  'localActionResponseMatchesId(result, localActionId)',
  'item.history_item_key',
  'item.file_version',
  'item.digest_file_version',
  'result.used_cached_preview !== true',
]) {
  assert.ok(assertionSource.includes(evidence), `history rerender success validation must require ${evidence}`);
}
assert.ok((appSource.match(/assertHistoryRerenderCommitResponse\(/g) || []).length >= 3, 'both digest and history rerender save paths must validate direct and recovered commit responses');

const routeStart = mainSource.indexOf("if (pathname === '/api/rerender-history' && req.method === 'POST')");
const routeEnd = mainSource.indexOf("if (pathname === '/api/reveal' && req.method === 'POST')", routeStart);
const routeSource = mainSource.slice(routeStart, routeEnd);
assert.ok(routeSource.includes('local_action_committed: evidence.local_action_committed === true'), 'history rerender response must expose its persisted commit evidence');

console.log('history rerender success contract passed');
