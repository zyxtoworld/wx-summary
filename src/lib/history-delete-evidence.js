function text(value = '') {
  return String(value || '').trim();
}

function timestamp(value = '') {
  return text(value) || new Date().toISOString();
}

export function createHistoryDeleteEvidence({ actionId = '', lookup = {}, now = '' } = {}) {
  return {
    kind: 'history_delete',
    action_id: text(actionId),
    requested_at: timestamp(now),
    digest_id: text(lookup.digest_id),
    history_item_key: text(lookup.history_item_key),
    file_version: text(lookup.expected_file_version || lookup.file_version),
    digest_file_version: text(lookup.expected_digest_file_version || lookup.digest_file_version),
    output_dir_identity: text(lookup.expected_output_dir_identity || lookup.output_dir_identity),
    settings_revision: text(lookup.expected_settings_revision || lookup.settings_revision),
    action_state: 'prepared',
    verification_pending: true,
    verified: false,
    verification_status: 'pending',
    evidence_verified: false,
    local_action_committed: false,
    local_action_recovery_failed: false,
    deleted: false,
    cleanup_pending: false,
    cleanup_pending_count: 0,
    committed_at: '',
    local_action_after_commit_reason: '',
    local_action_after_commit_error: '',
  };
}

export function resolveHistoryDeleteEvidence(evidence = {}, {
  targetPresent = null,
  result = null,
  error = null,
  now = '',
} = {}) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new TypeError('历史删除证据无效');
  }
  if (targetPresent === false || result?.deleted === true) {
    Object.assign(evidence, {
      action_state: 'committed',
      verification_pending: false,
      verified: true,
      verification_status: 'verified',
      evidence_verified: true,
      local_action_committed: true,
      local_action_recovery_failed: false,
      deleted: true,
      deleted_at: timestamp(now),
      cleanup_pending: result?.cleanup_pending === true,
      cleanup_pending_count: Math.max(0, Number(result?.cleanup_pending_count || 0) || 0),
      committed_at: timestamp(now),
      local_action_after_commit_reason: result?.cleanup_pending === true ? 'history_delete_cleanup_pending' : '',
      local_action_after_commit_error: '',
    });
    return evidence;
  }
  if (targetPresent === true) {
    Object.assign(evidence, {
      action_state: 'failed',
      verification_pending: false,
      verified: false,
      verification_status: 'failed',
      evidence_verified: false,
      local_action_committed: false,
      local_action_recovery_failed: true,
      deleted: false,
      committed_at: '',
      local_action_after_commit_reason: 'history_delete_not_committed',
      local_action_after_commit_error: '已核对原历史记录仍存在，本次删除未提交；刷新列表后可以重试。',
    });
    return evidence;
  }
  Object.assign(evidence, {
    action_state: 'outcome_unknown',
    verification_pending: true,
    verified: false,
    verification_status: 'pending',
    evidence_verified: false,
    local_action_committed: false,
    local_action_recovery_failed: false,
    deleted: false,
    local_action_after_commit_reason: 'history_delete_outcome_unknown',
    local_action_after_commit_error: text(error?.message || error) || '历史删除结果尚未确认；正在等待恢复事务核对。',
  });
  return evidence;
}
