import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const generateStart = source.indexOf('async function generateDigest');
const moduleLifecycleSource = source.slice(0, generateStart);

assert.ok(generateStart > 0, 'generateDigest should exist');
assert.equal(/\bupsertStage\s*\(/.test(moduleLifecycleSource), false,
  'module-level digest lifecycle code must not call the generateDigest-local upsertStage helper');
assert.ok(moduleLifecycleSource.includes('function upsertDigestLifecycleStage(stage = {})'),
  'module-level lifecycle events need a snapshot-only stage helper');

const resetSource = source.slice(
  source.indexOf('function resetDigestAccountState'),
  source.indexOf('function digestBatchRecoveryStorageKey'),
);
assert.ok(resetSource.includes('upsertDigestLifecycleStage({')
  && resetSource.includes('scheduleDigestAccountStateReset();'),
  'account changes during generation must record a lifecycle stage and always schedule cleanup');

const cancelFailureSource = source.slice(
  source.indexOf('function showDigestCancelConfirmationFailure'),
  source.indexOf('function beginDigestCancelConfirmation'),
);
assert.ok(cancelFailureSource.includes('upsertDigestLifecycleStage({')
  && !cancelFailureSource.includes('upsertStage({'),
  'cancel confirmation failures must not depend on generateDigest-local UI state');
assert.match(cancelFailureSource,
  /\.finally\(\(\) => \{[\s\S]*?if \(request === _state_digest\.cancelRequest\) \{[\s\S]*?try \{[\s\S]*?showDigestCancelConfirmationFailure\(request\)[\s\S]*?\} finally \{[\s\S]*?updateDigestCancelButton\(\);[\s\S]*?updateGlobalDigestActivity\(\);[\s\S]*?\}/,
  'cancel request settlement must unlock controls even if failure-status rendering throws');

console.log('digest lifecycle progress tests passed');
