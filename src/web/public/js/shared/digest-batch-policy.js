const SHARED_BATCH_FAILURE_KINDS = new Set([
  'reload',
  'local_service',
  'stale',
  'account',
  'mirror',
  'range',
  'key',
]);

const SHARED_AI_FAILURE_GROUPS = new Set(['settings', 'connectivity']);

const GROUP_SCOPED_TIMEOUT_CODES = new Set([
  'digest_job_deadline_exceeded',
  'ai_timeout',
  'ai_deadline_exceeded',
]);

const AUTOMATIC_ZERO_OUTPUT_RETRY_CODES = new Set([
  'wxdb_mirror_readiness_changed',
  'db_key_runtime_state_changed',
]);

export function digestFailureServerStage(error = {}) {
  return String(error?.stage || error?.last_server_stage || '').trim();
}

export function digestFailureStopsRemainingBatchPolicy(error = {}, {
  recoveryKind = '',
  aiRecoveryGroup = '',
} = {}) {
  const code = String(error?.code || '').trim();
  const timeoutPhase = String(error?.timeout_phase || '').trim();
  const serverStage = digestFailureServerStage(error);

  // These limits apply to one group's request. They do not prove that the
  // batch snapshot, credentials, or provider configuration is unusable for
  // the remaining groups.
  if (GROUP_SCOPED_TIMEOUT_CODES.has(code)) return false;

  // The connection is alive far enough to enter this group's model call. A slow
  // or unusually large group must not prevent later groups from being attempted.
  if ((code === 'digest_sse_timeout' && timeoutPhase === 'idle'
      || code === 'digest_result_recovery_timeout')
    && serverStage === 'summarizing') {
    return false;
  }

  if (SHARED_BATCH_FAILURE_KINDS.has(String(recoveryKind || '').trim())) return true;
  if (String(recoveryKind || '').trim() === 'ai') {
    return SHARED_AI_FAILURE_GROUPS.has(String(aiRecoveryGroup || '').trim());
  }
  return false;
}

export function digestBatchCanAutomaticMirrorRetry({
  automaticRetry = false,
  aborted = false,
  stopRequested = false,
  doneCount = 0,
  renderedOnlyCount = 0,
  saveUncertainCount = 0,
  historyUnboundCount = 0,
  failures = [],
} = {}) {
  if (automaticRetry || aborted || stopRequested) return false;
  if (doneCount > 0 || renderedOnlyCount > 0 || saveUncertainCount > 0 || historyUnboundCount > 0) return false;
  const retryableFailures = failures.filter(Boolean);
  return retryableFailures.length > 0 && retryableFailures.every(failure => {
    const error = failure?.meta || failure || {};
    const code = String(error?.code || error?.public_code || '').trim();
    return AUTOMATIC_ZERO_OUTPUT_RETRY_CODES.has(code);
  });
}
