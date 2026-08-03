import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const source = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const recoveryStart = source.indexOf('async function recoverInterruptedImageBatchResults');
const recoveryEnd = source.indexOf('async function recoverInterruptedDigestBatchAfterBootstrap', recoveryStart);
assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart);
const recovery = source.slice(recoveryStart, recoveryEnd);

assert.ok(recovery.includes('let lastRecoveredPreview = null;'));
assert.ok(recovery.includes('lastRecoveredPreview = { digest, savedItem };'));
assert.ok(recovery.includes('_state_digest.lastDigest = lastRecoveredPreview.digest;'));
assert.ok(recovery.includes('_state_digest.lastSavedItem = lastRecoveredPreview.savedItem;'));
assert.ok(recovery.includes('rememberRecoveredDigestFreshness(record, lastRecoveredPreview.digest);'));
assert.ok(
  recovery.indexOf('_state_digest.lastDigest = lastRecoveredPreview.digest;')
    < recovery.indexOf("if (document.getElementById('digest-canvas'))"),
  'recovered output state must be bound even when the winning tab has no digest canvas',
);
assert.ok(!recovery.includes('lastSavedItem = item.item;'));
assert.ok(!recovery.includes('lastSavedItem = terminal.item;'));

const interruptedBatchStart = source.indexOf('function normalizeInterruptedDigestBatch(value = {})');
const interruptedBatchEnd = source.indexOf('function digestBatchServiceInstanceId', interruptedBatchStart);
const interruptedBatch = source.slice(interruptedBatchStart, interruptedBatchEnd);
assert.ok(interruptedBatch.includes('result_input_key:'));
assert.ok(interruptedBatch.includes('result_range:'));
assert.ok(interruptedBatch.includes('result_runtime_version:'));

const recoveryFlowStart = source.indexOf('async function recoverInterruptedDigestBatchAfterBootstrap');
const recoveryFlowEnd = source.indexOf('function advanceDigestRunEpoch', recoveryFlowStart);
const recoveryFlow = source.slice(recoveryFlowStart, recoveryFlowEnd);
assert.ok(recoveryFlow.includes('rememberRecoveredDigestFreshness(record, recoveredDigests);'));

const generatedRecoveryStart = source.indexOf('const recoveredSavedItem = !previewText');
const generatedRecoveryEnd = source.indexOf('if (digest && typeof digest === \'object\') recoverableTerminalIndexes.add(i);', generatedRecoveryStart);
assert.ok(generatedRecoveryStart >= 0 && generatedRecoveryEnd > generatedRecoveryStart);
const generatedRecovery = source.slice(generatedRecoveryStart, generatedRecoveryEnd);
assert.ok(
  !generatedRecovery.includes('_state_digest.lastSavedItem = recoveredSavedItem;'),
  'a saved-only server recovery must not rebind the current canvas to another group file',
);

console.log('digest recovered preview binding tests passed');
