import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const storageSync = source.slice(
  source.indexOf('function setupPendingLocalActionStorageSync'),
  source.indexOf('function forgetPendingLocalAction'),
);
const recovery = source.slice(
  source.indexOf('async function recoverInterruptedDigestBatchAfterBootstrap'),
  source.indexOf('function advanceDigestRunEpoch'),
);

assert.ok(source.includes("namespace: 'digest-batch-recovery'"));
assert.ok(storageSync.includes('INTERRUPTED_DIGEST_BATCH_STORAGE_KEY'));
assert.ok(storageSync.includes('handleInterruptedDigestBatchStorageChange'));
assert.ok(source.includes('scheduleInterruptedDigestBatchRecoveryFromStorage'));
assert.ok(recovery.includes('DIGEST_BATCH_RECOVERY_RUNNER.run(record.batch_id'));
assert.ok(recovery.includes('readInterruptedDigestBatchRecords().find(item => item.batch_id === record.batch_id'));
assert.ok(recovery.includes('lockAcquired: true'));
assert.ok(recovery.includes('另一页面已完成刷新前摘要的收尾；如有已保存结果，可在历史页查看'));
assert.ok(recovery.indexOf('DIGEST_BATCH_RECOVERY_RUNNER.run(record.batch_id') < recovery.indexOf('recoverInterruptedImageBatchResults(record, batchResults)'));
assert.ok(recovery.indexOf('recoverInterruptedImageBatchResults(record, batchResults)') < recovery.indexOf("finishDigestBatchLeaseResult(record.batch_id, 'page_reload_recovery_consumed'"));
assert.ok(source.includes("startInterruptedDigestBatchBootstrapHeartbeat()"));

console.log('digest cross-tab recovery contract tests passed');
