function nonEmpty(value) {
  return String(value || '').trim();
}

function committed(result = {}) {
  return result?.local_action_committed === true
    || result?.item?.local_action_committed === true
    || result?.reveal?.local_action_committed === true
    || result?.opener?.local_action_committed === true;
}

function explicitVerification(result = {}) {
  return result?.verified === true
    || result?.clipboard_verified === true
    || result?.evidence_verified === true
    || nonEmpty(result?.status) === 'verified'
    || nonEmpty(result?.verification_status) === 'verified'
    || nonEmpty(result?.reveal?.verification_status) === 'verified'
    || nonEmpty(result?.opener?.verification_status) === 'verified';
}

function postCommitReason(result = {}) {
  return nonEmpty(
    result?.local_action_after_commit_reason
      || result?.item?.local_action_after_commit_reason
      || result?.reveal?.local_action_after_commit_reason
      || result?.opener?.local_action_after_commit_reason,
  );
}

function settledArtifact(result = {}) {
  const item = result?.item;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const identity = nonEmpty(item.digest_id)
    || nonEmpty(item.history_item_key)
    || nonEmpty(item.file_version)
    || nonEmpty(item.relative_path);
  if (!identity) return false;
  const afterReason = postCommitReason(result);
  return !afterReason || afterReason === 'cancelled_after_commit';
}

export function classifyLocalActionRecovery(result = null) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return 'pending';
  if (result.local_action_recovery_failed === true) return 'failed';
  if (result.local_action_recovery_cleanup_failed === true) return 'committed_unverified';
  if (!committed(result)) return 'pending';
  const verificationPending = result.local_action_recovery_pending === true
    || result.verification_pending === true
    || result.reveal?.verification_pending === true
    || result.opener?.verification_pending === true;
  const afterReason = postCommitReason(result);
  const postCommitVerificationSettled = !afterReason || afterReason === 'cancelled_after_commit';
  if (!verificationPending
    && postCommitVerificationSettled
    && (explicitVerification(result) || settledArtifact(result))) return 'verified';
  return 'committed_unverified';
}
