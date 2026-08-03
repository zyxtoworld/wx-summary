import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

const runId = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
const acceptanceDataDir = `outputs/.tmp/crash-recovery-storage-${runId}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = acceptanceDataDir;
process.env.WX_SUMMARY_NO_RUNTIME_FILE = '1';

const { DATA_DIR, TMP_DIR } = await import('../src/lib/paths.js');
const { __mainInternals } = await import('../src/main.js');

const recoveryFile = path.join(DATA_DIR, 'digest-terminal-recovery.json');
const malformedRecovery = '{"version":2,"items":[';
let commitEvidenceFile = '';

try {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });
  await fsp.writeFile(recoveryFile, malformedRecovery, 'utf8');

  assert.equal(
    await __mainInternals.restoreDigestTerminalRecovery(),
    0,
    'a malformed terminal-recovery file must not be treated as a valid empty recovery set',
  );
  assert.equal(
    await fsp.readFile(recoveryFile, 'utf8'),
    malformedRecovery,
    'startup recovery must preserve the original malformed bytes instead of deleting or overwriting them',
  );
  const recoveryBackups = (await fsp.readdir(DATA_DIR))
    .filter(name => /^digest-terminal-recovery\.invalid\.[a-f0-9]{24}\.json$/i.test(name));
  assert.equal(recoveryBackups.length, 1, 'malformed terminal recovery must have one content-addressed invalid backup');
  assert.equal(
    await fsp.readFile(path.join(DATA_DIR, recoveryBackups[0]), 'utf8'),
    malformedRecovery,
    'the invalid backup must preserve the exact bytes needed for diagnosis or manual recovery',
  );
  const recoveryStatus = __mainInternals.digestTerminalRecoveryPersistenceStatus();
  assert.equal(recoveryStatus.load_failed, true, 'terminal recovery status must report the degraded load');
  assert.equal(recoveryStatus.original_preserved, true, 'terminal recovery status must report that original evidence remains available');

  const actionId = `crash-recovery-${runId}`;
  commitEvidenceFile = __mainInternals.localActionCommitEvidencePath(actionId);
  await fsp.writeFile(commitEvidenceFile, '{broken', 'utf8');
  const evidence = {
    kind: 'reveal',
    action_id: actionId,
    requested_at: new Date().toISOString(),
    action_state: 'prepared',
    local_action_committed: false,
    verification_pending: false,
    verified: false,
    _commit_evidence_path: commitEvidenceFile,
  };

  assert.equal(
    await __mainInternals.reconcileRestoredLocalActionCommitEvidence(evidence),
    true,
    'an unreadable commit marker must durably settle the restored action into an explicit unknown outcome',
  );
  assert.notEqual(evidence._discard_after_restore, true, 'an unreadable marker must never be collapsed into a missing action');
  assert.equal(evidence.action_state, 'outcome_unknown');
  assert.equal(evidence.verification_status, 'warning');
  assert.equal(evidence.local_action_after_commit_reason, 'commit_evidence_unreadable');
  assert.match(evidence.local_action_after_commit_error, /无法确认.*请勿.*重复/);
  assert.equal(await fsp.readFile(commitEvidenceFile, 'utf8'), '{broken', 'the unreadable marker must remain for a later restart or diagnosis');
  assert.ok(
    __mainInternals.runtimeTmpPreservePaths({}, [evidence]).map(value => path.resolve(value)).includes(path.resolve(commitEvidenceFile)),
    'startup and shutdown temporary cleanup must preserve unresolved commit markers',
  );
} finally {
  if (commitEvidenceFile) await fsp.rm(commitEvidenceFile, { force: true }).catch(() => {});
  await fsp.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
}

console.log('crash recovery storage tests passed');
