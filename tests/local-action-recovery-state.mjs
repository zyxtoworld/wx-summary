import assert from 'node:assert/strict';

const { classifyLocalActionRecovery } = await import('../src/web/public/js/local-action-recovery-state.js');

assert.equal(classifyLocalActionRecovery({ local_action_recovery_failed: true }), 'failed');
assert.equal(classifyLocalActionRecovery({ action_state: 'prepared', local_action_committed: false }), 'pending');
assert.equal(classifyLocalActionRecovery({
  action_state: 'committed',
  local_action_committed: true,
  reveal: { platform: 'win32' },
}), 'committed_unverified');
assert.equal(classifyLocalActionRecovery({
  action_state: 'settled',
  local_action_committed: true,
  verified: true,
}), 'verified');
assert.equal(classifyLocalActionRecovery({
  action_state: 'settled',
  local_action_committed: true,
  item: { digest_id: 'digest-1', file_version: 'v1' },
}), 'verified');
assert.equal(classifyLocalActionRecovery({
  action_state: 'settled',
  local_action_committed: true,
  local_action_after_commit_reason: 'verification_error_after_commit',
  item: { digest_id: 'digest-1', file_version: 'v1' },
}), 'committed_unverified');

console.log('local action recovery state tests passed');
