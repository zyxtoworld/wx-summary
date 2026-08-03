import assert from 'node:assert/strict';

const acceptanceDataDir = `outputs/.tmp/scheduler-stale-generation-writeback-${process.pid}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = acceptanceDataDir;
process.env.WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR = `${acceptanceDataDir}/runtime-tmp/wxdb`;

const [scheduler, settingsModule] = await Promise.all([
  import('../src/daemon/scheduler.js'),
  import('../src/config/settings.js'),
]);
const {
  __schedulerInternals,
  getSchedulerStatus,
  runSchedulerOnce,
  stopScheduler,
} = scheduler;
const { withSettingsSaveTransaction } = settingsModule;

function deferred() {
  let resolve;
  const promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
}

const settingsReadStarted = deferred();
const releaseSettingsRead = deferred();
const oldGeneration = __schedulerInternals.schedulerGenerationValue();
const settingsBlocker = withSettingsSaveTransaction(async () => {
  settingsReadStarted.resolve();
  await releaseSettingsRead.promise;
});
await settingsReadStarted.promise;

const oldGenerationRun = runSchedulerOnce({ reason: 'stale_generation_writeback_contract' });
await new Promise(resolve => setImmediate(resolve));
assert.equal(getSchedulerStatus().running, true, 'the controlled run must hold the execution lease');

const stopResult = await stopScheduler({
  wait: false,
  reason: 'advance_generation_while_settings_read_waits',
});
assert.equal(stopResult.stopped, false, 'a non-waiting stop must report the still-draining old run');
const stoppedState = getSchedulerStatus();

releaseSettingsRead.resolve();
await settingsBlocker;
const callerResult = await oldGenerationRun;
assert.equal(callerResult.cancelled, true, 'the initiating caller must still receive its cancellation result');

const settledState = getSchedulerStatus();
assert.deepEqual(
  settledState.last_result,
  stoppedState.last_result,
  'an old generation must not publish its cancellation result after stop has advanced the generation',
);
assert.equal(
  settledState.last_finished_at,
  stoppedState.last_finished_at,
  'an old generation must not publish a final completion timestamp after stop',
);

const beforeLateFailure = getSchedulerStatus();
__schedulerInternals.markSchedulerRuntimeBlocked(new Error('controlled late timer-cycle failure'), {
  reason: 'late_timer_cycle_failure',
  retry: false,
  generation: oldGeneration,
});
const afterLateFailure = getSchedulerStatus();
assert.deepEqual(
  {
    enabled: afterLateFailure.enabled,
    timer_active: afterLateFailure.timer_active,
    runtime_stopped_reason: afterLateFailure.runtime_stopped_reason,
    last_error: afterLateFailure.last_error,
    last_result: afterLateFailure.last_result,
  },
  {
    enabled: beforeLateFailure.enabled,
    timer_active: beforeLateFailure.timer_active,
    runtime_stopped_reason: beforeLateFailure.runtime_stopped_reason,
    last_error: beforeLateFailure.last_error,
    last_result: beforeLateFailure.last_result,
  },
  'a late timer-cycle failure from an old generation must not overwrite stopped state',
);

console.log('scheduler stale-generation writeback tests passed');
