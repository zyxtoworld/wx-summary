import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import vm from 'node:vm';

const source = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const classifierStart = source.indexOf('function apiMutationOutcomeUnknown(');
const start = source.indexOf('async function api(path, opts = {})');
const end = source.indexOf('\nfunction syncAppStateDependentControls', start);
assert.ok(classifierStart >= 0 && start > classifierStart && end > start, 'frontend API implementation must remain inspectable');

const classifierSource = source.slice(classifierStart, start);
const sandbox = {};
vm.runInNewContext(`${classifierSource}\nglobalThis.__unknown = apiMutationOutcomeUnknown;`, sandbox, { timeout: 1_000 });

assert.equal(sandbox.__unknown({ mutation: false, requestStarted: true, outcomeConfirmed: false, error: new Error('read failed') }), false);
assert.equal(sandbox.__unknown({ mutation: true, requestStarted: false, outcomeConfirmed: false, error: new Error('read failed') }), false);
assert.equal(sandbox.__unknown({ mutation: true, requestStarted: true, outcomeConfirmed: true, error: new Error('read failed') }), false);
assert.equal(
  sandbox.__unknown({ mutation: true, requestStarted: true, outcomeConfirmed: false, error: new Error('response body aborted') }),
  true,
  'a started mutation without a fully parsed and validated response must remain outcome-unknown regardless of the body-read failure code',
);

const apiSource = source.slice(start, end);
assert.match(
  apiSource,
  /apiMutationOutcomeUnknown\(\{\s*mutation,\s*requestStarted:\s*mutationRequestStarted,\s*outcomeConfirmed:\s*mutationOutcomeConfirmed,\s*error,?\s*\}\)/,
  'the API catch path must classify every unconfirmed mutation response through the shared outcome predicate',
);
assert.match(apiSource, /mutationRequestStarted = false;\s*mutationOutcomeConfirmed = false;\s*const request = fetch/);
assert.match(apiSource, /const r = await request;\s*if \(!r\.ok\) \{[\s\S]*?const text = await readResponseTextLimited[\s\S]*?mutationOutcomeConfirmed = true;/);
assert.match(apiSource, /if \(localActionId && !localActionResponseMatchesId[\s\S]*?\}\s*mutationOutcomeConfirmed = true;\s*rememberSettingsRevisionFromPayload/);

console.log('API mutation unconfirmed-response outcome tests passed');
