import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const normalization = source.slice(
  source.indexOf('function normalizeInterruptedDigestBatchSupersessions'),
  source.indexOf('function digestBatchServiceInstanceId'),
);
const retrySelection = source.slice(
  source.indexOf('function digestRetrySupersessionIntent'),
  source.indexOf('function digestBatchPathPayloadForResult'),
);
const generation = source.slice(
  source.indexOf('async function generateDigest'),
  source.indexOf('function digestResultRecoveryRequestRetryable'),
);
const reloadRecovery = source.slice(
  source.indexOf('async function recoverInterruptedImageBatchResults'),
  source.indexOf('async function recoverInterruptedDigestBatchAfterBootstrap') + 16000,
);

assert.ok(source.includes("import { selectFullyCoveredRecoverySupersessions } from './digest-recovery-supersession.js'"));
assert.ok(normalization.includes('const supersedes = normalizeInterruptedDigestBatchSupersessions'));
assert.ok(normalization.includes('supersedes,'), 'retry provenance must survive local recovery record normalization');
assert.ok(retrySelection.includes('selectFullyCoveredRecoverySupersessions({'));
assert.ok(retrySelection.includes('_pendingDigestRetrySupersessionIntent = retrySupersession'));
assert.ok(generation.includes('const retrySupersessionIntent = takeDigestRetrySupersessionIntent(previewText)'));
assert.ok(generation.includes('supersedes: retrySupersessionIntent?.supersessions || []'));
assert.ok(generation.includes('releaseCompletedImageRetrySupersessions(retrySupersessionIntent?.supersessions, completedRetryGroupIds'));
assert.ok(reloadRecovery.includes('durableGroupIds: [...durableGroupIds].filter(Boolean)'));
assert.ok(reloadRecovery.includes('releaseCompletedImageRetrySupersessions(record.supersedes, imageRecovery.durableGroupIds'));
assert.ok(retrySelection.includes("record.phase === 'terminal_results_pending_recovery'"));
assert.ok(retrySelection.includes('writeInterruptedDigestBatchRecords(records.filter(record => !releasedIds.has(record.batch_id)))'));

console.log('digest recovery supersession integration contract tests passed');
