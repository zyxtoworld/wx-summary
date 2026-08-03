import assert from 'node:assert/strict';

const acceptanceDataDir = `outputs/.tmp/scheduler-admission-${process.pid}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = acceptanceDataDir;

const {
  __schedulerInternals,
  getSchedulerStatus,
  runSchedulerOnce,
  stopScheduler,
} = await import('../src/daemon/scheduler.js');

assert.equal(typeof __schedulerInternals.withSchedulerLifecycleTransition, 'function');
assert.equal(typeof __schedulerInternals.tryAcquireSchedulerRunLease, 'function');
assert.equal(typeof __schedulerInternals.releaseSchedulerRunLease, 'function');
assert.equal(typeof __schedulerInternals.applySchedulerRuntimePersistenceResult, 'function');

let releaseTransition;
let notifyTransitionStarted;
const transitionGate = new Promise(resolve => { releaseTransition = resolve; });
const transitionStarted = new Promise(resolve => { notifyTransitionStarted = resolve; });
const transition = __schedulerInternals.withSchedulerLifecycleTransition('start', async () => {
  notifyTransitionStarted();
  await transitionGate;
});
await transitionStarted;

const blockedByStart = await runSchedulerOnce({ reason: 'admission_during_start' });
assert.equal(blockedByStart.ok, false);
assert.equal(blockedByStart.detail, 'scheduler_lifecycle_active');
assert.equal(blockedByStart.lifecycle_transition, 'start');
assert.equal(getSchedulerStatus().running, false, 'a rejected run must not acquire the execution lease');
releaseTransition();
await transition;

await assert.rejects(
  runSchedulerOnce({
    reason: 'setup_failure',
    signal: {
      aborted: false,
      addEventListener() {
        throw new Error('controlled listener setup failure');
      },
    },
  }),
  /controlled listener setup failure/,
);
assert.equal(
  getSchedulerStatus().running,
  false,
  'a synchronous failure after lease acquisition must release the execution lease',
);

const lease = __schedulerInternals.tryAcquireSchedulerRunLease('controlled_run');
assert.ok(lease, 'the first scheduler run must acquire a lease synchronously');
assert.equal(getSchedulerStatus().running, true);
assert.equal(__schedulerInternals.tryAcquireSchedulerRunLease('overlap'), null, 'a second scheduler run must not acquire an overlapping lease');

__schedulerInternals.markSchedulerRuntimeBlocked(new Error('controlled startup failure'), {
  reason: 'controlled_start_failure',
  retry: false,
});
assert.equal(
  getSchedulerStatus().running,
  true,
  'startup/recovery failure state must not claim the scheduler is idle while an execution lease is active',
);
assert.equal(__schedulerInternals.releaseSchedulerRunLease({}), false, 'an unrelated completion must not release the active run');
assert.equal(__schedulerInternals.releaseSchedulerRunLease(lease), true);
assert.equal(getSchedulerStatus().running, false);

const staleGeneration = __schedulerInternals.schedulerGenerationValue();
await stopScheduler({ wait: true, reason: 'advance_generation_for_test' });
const currentGeneration = __schedulerInternals.schedulerGenerationValue();
assert.notEqual(currentGeneration, staleGeneration);
assert.equal(
  __schedulerInternals.applySchedulerRuntimePersistenceResult(false, staleGeneration),
  false,
  'an old async persistence callback must be ignored after stop advances the scheduler generation',
);
assert.equal(getSchedulerStatus().runtime_state_degraded, false, 'an ignored old callback must not pollute stopped state');
assert.equal(__schedulerInternals.applySchedulerRuntimePersistenceResult(false, currentGeneration), true);
assert.equal(getSchedulerStatus().runtime_state_degraded, true, 'the current generation may publish its own persistence result');
__schedulerInternals.applySchedulerRuntimePersistenceResult(true, currentGeneration);

console.log('scheduler admission state tests passed');
