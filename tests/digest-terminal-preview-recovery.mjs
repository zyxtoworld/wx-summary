import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const fixtureRelative = `outputs/.tmp/digest-terminal-preview-recovery-${process.pid}-${Date.now()}`;
const fixturePath = path.resolve(fixtureRelative);

process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = fixtureRelative;

await fs.mkdir(fixturePath, { recursive: true });

try {
  const { __mainInternals } = await import('../src/main.js');
  const batchId = `preview-recovery-${process.pid}`;
  const batchToken = `preview-recovery-token-${process.pid}`;
  const ownerHash = crypto.createHash('sha256').update(`${batchId}\0${batchToken}`).digest('hex');
  const accountFingerprint = 'a'.repeat(64);
  const digest = {
    digest_id: `preview-recovery-digest-${process.pid}`,
    account_id: 'wxacc-preview-recovery',
    group_id: 'preview-recovery@chatroom',
    group: '恢复测试群',
    headline: '服务重启后仍可导出',
    summary: '完整文本预览应恢复为完成状态，并重新建立服务端导出快照。',
    message_count: 3,
  };

  await __mainInternals.registerDigestTerminalResult({
    batchId,
    batchIndex: 0,
    ownerHash,
    accountId: digest.account_id,
    accountFingerprint,
    groupId: digest.group_id,
    groupName: digest.group,
    previewText: true,
    digest,
  });

  const recovered = __mainInternals.recoverDigestBatchPreview(batchId, {
    token: batchToken,
    expectedTotal: 1,
    accountId: digest.account_id,
    accountFingerprint,
  });
  assert.equal(recovered?.done, 1, 'restart recovery should return the completed preview digest');
  assert.equal(recovered?.total, 1, 'the owner-bound browser recovery record should restore the legacy batch total');
  assert.equal(recovered?.complete, true, 'a recovered 1/1 preview must not be mislabeled as cancelled or partial');
  assert.equal(recovered?.restored_after_restart, true, 'terminal fallback recovery should disclose that it rebuilt restart state');
  const recoveredAgain = __mainInternals.recoverDigestBatchPreview(batchId, {
    token: batchToken,
    expectedTotal: 1,
    accountId: digest.account_id,
    accountFingerprint,
  });
  assert.equal(recoveredAgain?.done, 1, 'a rebuilt preview snapshot must retain its account binding for later recovery calls');
  const unpersistedPreview = __mainInternals.digestBatchPreviewRecoveryPayload({
    total: 1,
    total_confirmed: true,
    recovery_persisted: false,
    digests: new Map([[0, digest]]),
  }, 'preview-unpersisted-payload');
  assert.equal(unpersistedPreview?.terminal_recovery_persisted, false,
    'text-preview recovery must expose an unpersisted terminal marker to the browser');
  assert.throws(
    () => __mainInternals.recoverDigestBatchPreview(batchId, {
      token: batchToken,
      expectedTotal: 1,
      accountId: digest.account_id,
      accountFingerprint: 'b'.repeat(64),
    }),
    error => error?.public_code === 'digest_account_context_mismatch',
    'a rebuilt preview snapshot must reject another account identity',
  );

  const exportSnapshot = __mainInternals.loadDigestBatchPreviewMarkdown(batchId, {
    token: batchToken,
    metadata: { complete: true, done: 1, total: 1 },
    confirmedDigests: [{ batch_index: 0, digest_id: digest.digest_id }],
    accountId: digest.account_id,
    accountFingerprint,
  });
  assert.match(exportSnapshot.markdown, /服务重启后仍可导出/, 'restart recovery must hydrate the server snapshot used by MD export');
  assert.throws(
    () => __mainInternals.loadDigestBatchPreviewMarkdown(batchId, {
      token: batchToken,
      metadata: { complete: true, done: 1, total: 1 },
      confirmedDigests: [{ batch_index: 0, digest_id: digest.digest_id }],
      accountId: digest.account_id,
      accountFingerprint: '',
    }),
    error => error?.public_code === 'digest_account_context_mismatch',
    'MD export must not accept an owner token without the original account identity',
  );

  const partialBatchId = `preview-partial-${process.pid}`;
  const partialBatchToken = `preview-partial-token-${process.pid}`;
  const partialOwnerHash = crypto.createHash('sha256').update(`${partialBatchId}\0${partialBatchToken}`).digest('hex');
  await __mainInternals.registerDigestTerminalResult({
    batchId: partialBatchId,
    batchIndex: 0,
    batchTotal: 2,
    ownerHash: partialOwnerHash,
    accountId: digest.account_id,
    accountFingerprint,
    groupId: digest.group_id,
    groupName: digest.group,
    previewText: true,
    digest: { ...digest, digest_id: `${digest.digest_id}-partial` },
  });
  const partial = __mainInternals.recoverDigestBatchPreview(partialBatchId, {
    token: partialBatchToken,
    accountId: digest.account_id,
    accountFingerprint,
  });
  assert.equal(partial.total, 2, 'new terminal recovery records should preserve the server-validated batch total');
  assert.equal(partial.done, 1, 'partial recovery should expose only completed groups');
  assert.equal(partial.complete, false, 'one recovered digest from a two-group batch must remain incomplete');
  assert.equal(
    __mainInternals.digestTerminalResultSummariesForBatch({
      batchId: partialBatchId,
      ownerHash: partialOwnerHash,
      accountId: digest.account_id,
      accountFingerprint,
    })[0].batch_total,
    2,
    'batch result summaries should return the terminal batch total to recovery clients',
  );
  assert.throws(
    () => __mainInternals.recoverDigestBatchPreview(partialBatchId, {
      token: partialBatchToken,
      expectedTotal: 1,
      accountId: digest.account_id,
      accountFingerprint,
    }),
    error => error?.public_code === 'digest_batch_preview_total_mismatch',
    'a conflicting browser batch total must be rejected instead of changing partial recovery into a false complete result',
  );
  assert.equal(__mainInternals.markDigestBatchCancelled(partialBatchId, 'user_cancelled', {
    abortSaves: true,
    preserveCompletedResults: true,
    ownerHash: partialOwnerHash,
  }), true, 'hard cancellation should still stop unfinished work');
  const cancelledPartial = __mainInternals.recoverDigestBatchPreview(partialBatchId, {
    token: partialBatchToken,
    accountId: digest.account_id,
    accountFingerprint,
  });
  assert.equal(cancelledPartial?.done, 1, 'cancelling a partial text batch must retain its completed server preview snapshot');
  assert.equal(cancelledPartial?.complete, false, 'a retained cancelled preview must remain explicitly partial');
  assert.equal(__mainInternals.digestBatchAllowsSaveAfterCancel(partialBatchId, { token: partialBatchToken }), true, 'the owner should still be allowed to export completed output after cancelling unfinished work');

  console.log('Digest terminal preview recovery tests passed');
} finally {
  await fs.rm(fixturePath, { recursive: true, force: true });
}
