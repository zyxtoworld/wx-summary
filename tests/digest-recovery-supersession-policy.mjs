import assert from 'node:assert/strict';

import { selectFullyCoveredRecoverySupersessions } from '../src/web/public/js/shared/digest-recovery-supersession.js';

const accountId = 'wxacc-retry-policy';
const accountFingerprint = 'a'.repeat(64);
const record = {
  batch_id: 'old-image-batch',
  account_id: accountId,
  account_fingerprint: accountFingerprint,
  preview_text: false,
  phase: 'terminal_results_pending_recovery',
  targets: [
    { group_id: 'group-1' },
    { group_id: 'group-2' },
    { group_id: 'group-3' },
  ],
};
const baseResults = [
  { batch_id: record.batch_id, index: 0, group_id: 'group-1', retryable: true, durable: false },
  { batch_id: record.batch_id, index: 1, group_id: 'group-2', retryable: false, durable: true },
  { batch_id: record.batch_id, index: 2, group_id: 'group-3', retryable: false, durable: false },
];

assert.deepEqual(
  selectFullyCoveredRecoverySupersessions({
    records: [record],
    results: baseResults,
    selectedGroupIds: ['group-1'],
    accountId,
    accountFingerprint,
    previewText: false,
  }),
  [],
  'an unresolved non-retried output must keep the old recovery batch alive',
);

assert.deepEqual(
  selectFullyCoveredRecoverySupersessions({
    records: [record],
    results: [
      baseResults[0],
      baseResults[1],
      { ...baseResults[2], retryable: true },
    ],
    selectedGroupIds: ['group-1', 'group-3'],
    accountId,
    accountFingerprint,
    previewText: false,
  }),
  [{ batch_id: record.batch_id, retry_group_ids: ['group-1', 'group-3'] }],
  'a recovery batch is supersedable only when every target is durable or explicitly retried',
);

assert.deepEqual(
  selectFullyCoveredRecoverySupersessions({
    records: [{ ...record, account_fingerprint: 'b'.repeat(64) }],
    results: baseResults.map(result => ({ ...result, retryable: result.group_id !== 'group-2' })),
    selectedGroupIds: ['group-1', 'group-3'],
    accountId,
    accountFingerprint,
    previewText: false,
  }),
  [],
  'a retry must never supersede recovery data from another database identity',
);

assert.deepEqual(
  selectFullyCoveredRecoverySupersessions({
    records: [{ ...record, preview_text: true }],
    results: baseResults.map(result => ({ ...result, retryable: result.group_id !== 'group-2' })),
    selectedGroupIds: ['group-1', 'group-3'],
    accountId,
    accountFingerprint,
    previewText: false,
  }),
  [],
  'an image retry must not discard a text-preview recovery batch',
);

console.log('digest recovery supersession policy tests passed');
