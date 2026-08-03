import assert from 'node:assert/strict';
import {
  digestBatchCanAutomaticMirrorRetry,
  digestFailureStopsRemainingBatchPolicy,
} from '../src/web/public/js/digest-batch-policy.js';

function policy(error, recoveryKind = 'local_service', aiRecoveryGroup = '') {
  return digestFailureStopsRemainingBatchPolicy(error, { recoveryKind, aiRecoveryGroup });
}

assert.equal(policy({
  code: 'digest_sse_timeout',
  timeout_phase: 'idle',
  stage: 'summarizing',
}), false, 'a model-stage SSE timeout is scoped to the current group');

assert.equal(policy({
  code: 'digest_sse_timeout',
  timeout_phase: 'idle',
  stage: 'fetching',
}), true, 'a local-data-stage SSE timeout still stops the shared batch');

assert.equal(policy({
  code: 'digest_sse_timeout',
  timeout_phase: 'connect',
  stage: 'preflight',
}), true, 'a connection timeout still stops the shared batch');

assert.equal(policy({
  code: 'digest_result_recovery_timeout',
  timeout_phase: 'result_recovery',
  stage: 'summarizing',
}), false, 'terminal-result recovery keeps the original model-stage scope');

assert.equal(policy({
  code: 'digest_job_deadline_exceeded',
  stage: 'fetching',
}), false, 'a per-group task deadline must not discard later groups');

assert.equal(policy({
  code: 'ai_timeout',
  stage: 'summarizing',
}, 'ai', 'connectivity'), false, 'a slow or oversized group should not stop later groups');

assert.equal(policy({
  code: 'ai_deadline_exceeded',
  stage: 'summarizing',
}, 'ai', 'connectivity'), false, 'an AI budget is scoped to the current group');

assert.equal(policy({
  code: 'ai_provider_unavailable',
  stage: 'summarizing',
}, 'ai', 'connectivity'), true, 'a provider outage remains a shared batch failure');

assert.equal(policy({ code: 'ai_quality_failed', stage: 'summarizing' }, 'ai', 'content'), false);
assert.equal(policy({ code: 'ai_auth_failed', stage: 'preflight' }, 'ai', 'settings'), true);

const attempted = [];
const results = [];
for (const group of ['first', 'second']) {
  attempted.push(group);
  try {
    if (group === 'first') {
      throw Object.assign(new Error('model stalled'), {
        code: 'digest_sse_timeout',
        timeout_phase: 'idle',
        stage: 'summarizing',
      });
    }
    results.push({ group, status: 'done' });
  } catch (error) {
    results.push({ group, status: 'error' });
    if (policy(error)) break;
  }
}

assert.deepEqual(attempted, ['first', 'second']);
assert.deepEqual(results, [
  { group: 'first', status: 'error' },
  { group: 'second', status: 'done' },
]);

const mirrorFailure = [{ meta: { code: 'wxdb_mirror_readiness_changed' } }];
assert.equal(digestBatchCanAutomaticMirrorRetry({ failures: mirrorFailure }), true, 'a zero-output snapshot change may retry once');
assert.equal(digestBatchCanAutomaticMirrorRetry({ automaticRetry: true, failures: mirrorFailure }), false, 'the automatic retry must not recurse');
assert.equal(digestBatchCanAutomaticMirrorRetry({ aborted: true, failures: mirrorFailure }), false, 'user cancellation must win over retry');
assert.equal(digestBatchCanAutomaticMirrorRetry({ stopRequested: true, failures: mirrorFailure }), false, 'stop-after-save must win over retry');
assert.equal(digestBatchCanAutomaticMirrorRetry({ doneCount: 1, failures: mirrorFailure }), false, 'completed output makes a whole-batch retry unsafe');
assert.equal(digestBatchCanAutomaticMirrorRetry({ renderedOnlyCount: 1, failures: mirrorFailure }), false, 'a downloadable render makes a whole-batch retry unsafe');
assert.equal(digestBatchCanAutomaticMirrorRetry({ saveUncertainCount: 1, failures: mirrorFailure }), false, 'an uncertain save makes a whole-batch retry unsafe');
assert.equal(digestBatchCanAutomaticMirrorRetry({ historyUnboundCount: 1, failures: mirrorFailure }), false, 'an unbound history write makes a whole-batch retry unsafe');
assert.equal(digestBatchCanAutomaticMirrorRetry({ failures: [{ meta: { code: 'wxdb_key_verification_failed' } }] }), false, 'real key failures must remain visible');

const keyRuntimeFailure = [{ meta: { code: 'db_key_runtime_state_changed' } }];
assert.equal(digestBatchCanAutomaticMirrorRetry({ failures: keyRuntimeFailure }), true, 'a zero-output key runtime state change may retry once after settlement');
assert.equal(digestBatchCanAutomaticMirrorRetry({ failures: [{ public_code: 'db_key_runtime_state_changed' }] }), true, 'the public error code should retain the same safe retry policy');
assert.equal(digestBatchCanAutomaticMirrorRetry({ automaticRetry: true, failures: keyRuntimeFailure }), false, 'a key runtime state retry must not recurse');
assert.equal(digestBatchCanAutomaticMirrorRetry({ doneCount: 1, failures: keyRuntimeFailure }), false, 'a completed output makes a key runtime whole-batch retry unsafe');
assert.equal(digestBatchCanAutomaticMirrorRetry({
  failures: [...keyRuntimeFailure, { meta: { code: 'wxdb_key_verification_failed' } }],
}), false, 'mixed transient and real key failures must not replay the whole batch');
