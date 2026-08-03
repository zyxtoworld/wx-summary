import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const source = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const matchStart = source.indexOf('function interruptedDigestBatchMatchesSelectedAccount');
const matchEnd = source.indexOf('function readInterruptedDigestBatchRecords', matchStart);
assert.ok(matchStart >= 0 && matchEnd > matchStart, 'account-scoped recovery matcher must exist before storage reads');
const matchSource = source.slice(matchStart, matchEnd);
const buildMatcher = new Function(
  'selectedAccountId',
  'canonicalAccountIdForValue',
  'accountFingerprintForValue',
  'accountScopeUniquelyMatches',
  '_appAccounts',
  `${matchSource}; return interruptedDigestBatchMatchesSelectedAccount;`,
);
const matcher = buildMatcher(
  () => 'account-a',
  value => String(value || '').trim(),
  value => value === 'account-a' ? 'a'.repeat(64) : '',
  (scope, accountId) => scope === accountId,
  [],
);

assert.equal(matcher({ account_id: 'account-a', account_fingerprint: 'a'.repeat(64) }), true);
assert.equal(matcher({ account_id: 'account-b', account_fingerprint: 'a'.repeat(64) }), false, 'another account id must never win recovery');
assert.equal(matcher({ account_id: 'account-a', account_fingerprint: 'b'.repeat(64) }), false, 'a stale generation fingerprint must never bind to the current account');
assert.equal(matcher({ account_id: 'account-a', account_fingerprint: '' }), false, 'unverified account identity must not recover into the UI');

const readStart = source.indexOf('function readInterruptedDigestBatch()');
const readEnd = source.indexOf('function writeInterruptedDigestBatchRecords', readStart);
const readSource = source.slice(readStart, readEnd);
assert.ok(readSource.includes('interruptedDigestBatchMatchesSelectedAccount(record)'));

const recoveryStart = source.indexOf('async function recoverInterruptedDigestBatchAfterBootstrap');
const recoveryEnd = source.indexOf('function advanceDigestRunEpoch', recoveryStart);
const recoverySource = source.slice(recoveryStart, recoveryEnd);
assert.ok(recoverySource.includes('interruptedDigestBatchMatchesSelectedAccount(lockedRecord)'));
assert.ok(recoverySource.includes('interruptedDigestBatchMatchesSelectedAccount(current)'));

const resetStart = source.indexOf('function resetDigestAccountState');
const resetEnd = source.indexOf('function digestBatchFinishFailureNotice', resetStart);
const resetSource = source.slice(resetStart, resetEnd);
assert.ok(resetSource.includes('scheduleInterruptedDigestBatchRecoveryFromStorage'));
assert.ok(resetSource.includes('_digestBatchRecoveryRescheduleAfterAccountReset = true'));
assert.ok(resetSource.includes('_digestBatchRecoveryVisitedIds.delete(record.batch_id)'));
assert.ok(recoverySource.includes('if (_digestBatchRecoveryRescheduleAfterAccountReset && !_digestBatchCrossTabActiveId)'));
assert.ok(recoverySource.includes('_digestBatchRecoveryPending = false;\n        scheduleInterruptedDigestBatchRecoveryFromStorage(500);'));

const scheduleStart = source.indexOf('function scheduleInterruptedDigestBatchRecoveryFromStorage');
const scheduleEnd = source.indexOf('function handleInterruptedDigestBatchStorageChange', scheduleStart);
const scheduleSource = source.slice(scheduleStart, scheduleEnd);
assert.ok(!scheduleSource.includes("record.phase === 'text_preview_pending_export'"), 'a retained text preview must be recoverable again after returning to its account');

console.log('digest recovery account isolation tests passed');
