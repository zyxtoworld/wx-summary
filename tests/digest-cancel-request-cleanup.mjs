import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');

const generateStart = source.indexOf('async function generateDigest(');
const generateEnd = source.indexOf('\nfunction digestPrepareConcurrency(', generateStart);
assert.ok(generateStart >= 0 && generateEnd > generateStart, 'generateDigest source must remain available');
const generateSource = source.slice(generateStart, generateEnd);

const clearStart = generateSource.indexOf('const clearActiveDigestRunState =');
const clearEnd = generateSource.indexOf('\n  const settlePrepareLeaseBeforeUnlock =', clearStart);
assert.ok(clearStart >= 0 && clearEnd > clearStart, 'active digest cleanup helper must remain available');
const clearSource = generateSource.slice(clearStart, clearEnd);
assert.match(
  clearSource,
  /forgetDigestCancelRequest\(batchId\);[\s\S]*?_state_digest\.cancelRequest = null;/,
  'every terminal generateDigest cleanup must discard its batch-scoped cancel request before clearing the active pointer',
);

const frontendFailureStart = generateSource.indexOf('if (!frontendFresh?.ok) {');
const frontendFailureEnd = generateSource.indexOf('\n  setDigestOutputStatusLive(false);', frontendFailureStart);
assert.ok(frontendFailureStart >= 0 && frontendFailureEnd > frontendFailureStart, 'frontend freshness failure branch must remain available');
const frontendFailureSource = generateSource.slice(frontendFailureStart, frontendFailureEnd);
assert.ok(
  (frontendFailureSource.match(/forgetDigestCancelRequest\(batchId\);/g) || []).length >= 2,
  'frontend freshness cancellation must discard the batch-scoped request in both superseded and visible failure branches even though no server lease exists yet',
);

console.log('Digest cancel request cleanup contract passed');
