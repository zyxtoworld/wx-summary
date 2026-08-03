import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const acceptanceDataDir = `outputs/.tmp/manual-key-verification-${process.pid}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = acceptanceDataDir;
process.env.WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR = `${acceptanceDataDir}/runtime-tmp/wxdb`;

const settingsModule = await import('../src/config/settings.js');
const { __schedulerInternals } = await import('../src/daemon/scheduler.js');
const {
  loadSettings,
  saveManualKeyVerificationForAccount,
  saveSecrets,
} = settingsModule;

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wx-summary-manual-key-proof-'));
const settingsFile = path.join(root, 'settings.json');
const secretsFile = path.join(root, 'secrets.bin');
const accountId = 'wxacc_monotonic';
const accountFingerprint = '1'.repeat(64);
const manualKey = 'a'.repeat(64);

try {
  await saveSecrets({
    api_key: '',
    manual_key: '',
    manual_keys_by_account: { [accountId]: manualKey },
    manual_key_account_fingerprints_by_account: { [accountId]: accountFingerprint },
    manual_key_verifications_by_account: {},
  }, { file: secretsFile, settingsFile });

  const before = await loadSettings({ includeSecrets: true, settingsFile, secretsFile });
  assert.match(before.scheduler_runtime_revision, /^[a-f0-9]{16}$/i, 'loaded settings must expose an opaque scheduler runtime revision');
  assert.match(before.scheduler_schedule_revision, /^[a-f0-9]{16}$/i, 'loaded settings must expose a separate scheduler clock revision');

  const full = await saveManualKeyVerificationForAccount({
    account_id: accountId,
    account_fingerprint: accountFingerprint,
    expected_manual_key_text: manualKey,
    expected_revision: before.settings_revision,
    message_db_verified: true,
    message_db_checked_count: 3,
    message_db_total_count: 3,
    settingsFile,
    secretsFile,
  });
  assert.equal(full.settings_revision, before.settings_revision, 'automatic verification evidence must not invalidate a settings form CAS revision');
  assert.notEqual(full.scheduler_runtime_revision, before.scheduler_runtime_revision, 'scheduler freshness must change when full database proof is first recorded');
  assert.equal(full.scheduler_schedule_revision, before.scheduler_schedule_revision, 'database proof changes must not reset the persisted next-run clock');

  const weaker = await saveManualKeyVerificationForAccount({
    account_id: accountId,
    account_fingerprint: accountFingerprint,
    expected_manual_key_text: manualKey,
    expected_revision: full.settings_revision,
    message_db_verified: false,
    message_db_checked_count: 1,
    message_db_total_count: 3,
    settingsFile,
    secretsFile,
  });
  const after = await loadSettings({ includeSecrets: true, settingsFile, secretsFile });
  const proof = after.wechat.manual_key_verifications_by_account[accountId];
  assert.equal(proof.key_hash, crypto.createHash('sha256').update(manualKey).digest('hex'));
  assert.equal(proof.account_fingerprint, accountFingerprint);
  assert.equal(proof.message_db_verified, true, 'sample-only verification must not downgrade an existing full-database proof');
  assert.equal(proof.message_coverage_verified, true, 'coverage proof must be monotonic for the same account fingerprint and key');
  assert.equal(proof.message_db_checked_count, 3, 'a weaker sample must preserve the full proof diagnostics');
  assert.equal(proof.message_db_total_count, 3, 'a weaker sample must preserve the full proof scope');
  assert.equal(weaker.scheduler_runtime_revision, full.scheduler_runtime_revision, 'a discarded weaker proof must not create scheduler revision churn');

  const persistedNow = Date.parse('2026-07-28T00:00:00.000Z');
  const persisted = __schedulerInternals.schedulerRuntimeStatePayload({
    version: 2,
    schedule_revision: before.scheduler_schedule_revision,
    next_run_at: new Date(persistedNow + 60_000).toISOString(),
    interval_ms: 60_000,
  });
  assert.equal(
    __schedulerInternals.schedulerPersistedNextDelay(persisted, full, 60_000, persistedNow).restored,
    true,
    'persisted deadlines must survive a key-proof update when scheduler cadence is unchanged',
  );
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}

console.log('manual key verification monotonic tests passed');
