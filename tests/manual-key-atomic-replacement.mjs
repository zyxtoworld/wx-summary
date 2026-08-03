import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const acceptanceDataDir = `outputs/.tmp/manual-key-atomic-${process.pid}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = acceptanceDataDir;
process.env.WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR = `${acceptanceDataDir}/runtime-tmp/wxdb`;

const {
  loadSettings,
  manualKeyVerifiedForAccount,
  saveSecrets,
  saveSettingsPatch,
} = await import('../src/config/settings.js');
const { __mainInternals } = await import('../src/main.js');

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wx-summary-manual-key-atomic-'));
const settingsFile = path.join(root, 'settings.json');
const secretsFile = path.join(root, 'secrets.bin');
const accountId = 'wxacc_atomic';
const accountFingerprint = '1'.repeat(64);
const oldKey = 'a'.repeat(64);
const replacementKey = 'b'.repeat(64);

const patchFor = manualKey => ({
  wechat: {
    manual_key: manualKey,
    manual_key_account_id: accountId,
    manual_key_account_aliases: [accountId],
    manual_key_account_fingerprint: accountFingerprint,
  },
});

const proofFor = (manualKey, { full = false } = {}) => ({
  account_id: accountId,
  account_aliases: [accountId],
  account_fingerprint: accountFingerprint,
  expected_manual_key_text: manualKey,
  message_sample_verified: true,
  message_db_verified: full,
  message_coverage_verified: full,
  message_db_checked_count: full ? 2 : 1,
  message_db_total_count: 2,
});

async function assertOldCandidatePreserved(message) {
  const current = await loadSettings({ includeSecrets: true, settingsFile, secretsFile });
  assert.equal(current.wechat.manual_keys_by_account[accountId], oldKey, message);
  assert.equal(
    manualKeyVerifiedForAccount(current, accountId, [], accountFingerprint),
    true,
    `${message}；旧候选的完整验证记录也必须保留`,
  );
}

try {
  const mirrorSnapshotHash = '2'.repeat(64);
  const proofBody = {
    wechat: {
      manual_key: replacementKey,
      manual_key_account_id: accountId,
      manual_key_account_aliases: [accountId],
    },
    _request_context: {
      account_id: accountId,
      account_aliases: [accountId],
      account_fingerprint: accountFingerprint,
      manual_key_mirror_scope: 'digest',
      manual_key_mirror_snapshot_meta_hash: mirrorSnapshotHash,
      manual_key_mirror_refreshed_at: '2026-07-28T00:00:00.000Z',
    },
  };
  assert.equal(
    __mainInternals.settingsManualKeyPatchHasFullValidation(proofBody, null),
    false,
    'the server must require proof based on the submitted patch, not a client-supplied requirement flag',
  );
  assert.throws(
    () => __mainInternals.assertSettingsManualKeyPatchHasFullValidation(proofBody, null),
    error => error?.public_code === 'manual_key_full_validation_required',
  );
  __mainInternals.rememberPendingManualKeyValidation({
    account_id: accountId,
    account_aliases: [accountId],
    account_fingerprint: accountFingerprint,
    manual_key_text: replacementKey,
    mirror_scope: 'digest',
    mirror_snapshot_meta_hash: mirrorSnapshotHash,
    mirror_refreshed_at: '2026-07-28T00:00:00.000Z',
    message_db_verified: false,
    message_db_checked_count: 1,
    message_db_total_count: 2,
  });
  assert.equal(
    __mainInternals.settingsManualKeyPatchHasFullValidation(
      proofBody,
      __mainInternals.pendingManualKeyValidationForSettingsPatch(proofBody),
    ),
    false,
    'a sample-only pending proof must not authorize the settings route',
  );
  __mainInternals.rememberPendingManualKeyValidation({
    account_id: accountId,
    account_aliases: [accountId],
    account_fingerprint: accountFingerprint,
    manual_key_text: replacementKey,
    mirror_scope: 'digest',
    mirror_snapshot_meta_hash: mirrorSnapshotHash,
    mirror_refreshed_at: '2026-07-28T00:00:00.000Z',
    message_db_verified: true,
    message_db_checked_count: 2,
    message_db_total_count: 2,
  });
  assert.equal(
    __mainInternals.settingsManualKeyPatchHasFullValidation(
      proofBody,
      __mainInternals.pendingManualKeyValidationForSettingsPatch(proofBody),
    ),
    true,
    'only the exact account, candidate, project-copy snapshot, and full shard proof may authorize the route',
  );

  await saveSecrets({
    api_key: '',
    manual_key: '',
    manual_keys_by_account: { [accountId]: oldKey },
    manual_key_account_fingerprints_by_account: { [accountId]: accountFingerprint },
    manual_key_verifications_by_account: {
      [accountId]: {
        key_hash: crypto.createHash('sha256').update(oldKey).digest('hex'),
        account_fingerprint: accountFingerprint,
        message_sample_verified: true,
        message_db_verified: true,
        message_coverage_verified: true,
        message_db_checked_count: 2,
        message_db_total_count: 2,
      },
    },
  }, { file: secretsFile, settingsFile });

  await assert.rejects(
    () => saveSettingsPatch(patchFor(replacementKey), { settingsFile, secretsFile }),
    error => error?.code === 'manual_key_full_validation_required',
    'a replacement candidate without proof must fail before touching the old candidate',
  );
  await assertOldCandidatePreserved('missing proof must not replace the old candidate');

  await assert.rejects(
    () => saveSettingsPatch(patchFor(replacementKey), {
      settingsFile,
      secretsFile,
      verified_manual_key: proofFor(replacementKey),
    }),
    error => error?.code === 'manual_key_full_validation_required',
    'a message-sample-only proof must not authorize replacement',
  );
  await assertOldCandidatePreserved('sample-only proof must not replace the old candidate');

  await assert.rejects(
    () => saveSettingsPatch(patchFor(replacementKey), {
      settingsFile,
      secretsFile,
      verified_manual_key: proofFor('c'.repeat(64), { full: true }),
    }),
    error => error?.code === 'manual_key_full_validation_required',
    'a full proof for a different candidate must not authorize replacement',
  );
  await assertOldCandidatePreserved('mismatched proof must not replace the old candidate');

  const saved = await saveSettingsPatch(patchFor(replacementKey), {
    settingsFile,
    secretsFile,
    verified_manual_key: proofFor(replacementKey, { full: true }),
  });
  const after = await loadSettings({ includeSecrets: true, settingsFile, secretsFile });
  assert.equal(after.wechat.manual_keys_by_account[accountId], replacementKey);
  assert.equal(manualKeyVerifiedForAccount(saved, accountId, [], accountFingerprint), true);
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}

console.log('manual key atomic replacement tests passed');
