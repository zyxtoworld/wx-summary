import assert from 'node:assert/strict';

process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = `outputs/.tmp/scheduler-persistent-disable-failure-${process.pid}`;
process.env.WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR = `${process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR}/runtime-tmp/wxdb`;

const { __schedulerInternals, getSchedulerStatus } = await import('../src/daemon/scheduler.js');

const generation = __schedulerInternals.schedulerGenerationValue();
const published = __schedulerInternals.markSchedulerPersistentDisableFailed(
  new Error('controlled settings write failure'),
  { reason: 'persistent_disable_contract', generation },
);

assert.equal(published.published, true, 'the current scheduler generation must publish the persistent-disable failure');
assert.equal(published.result.ok, false);
assert.equal(published.result.reason, 'persistent_disable_contract');
assert.equal(published.result.detail, 'scheduler_persistent_disable_failed');
assert.match(published.message, /后台定时任务需要暂停/);

const failedState = getSchedulerStatus();
assert.equal(failedState.enabled, false, 'a failed persisted disable must stop the runtime state');
assert.equal(failedState.timer_active, false, 'a failed persisted disable must not leave a timer active');
assert.equal(failedState.runtime_stopped_reason, 'scheduler_persistent_disable_failed');
assert.equal(failedState.last_result?.detail, 'scheduler_persistent_disable_failed');
assert.match(String(failedState.last_error || ''), /controlled settings write failure/);

const beforeStalePublish = {
  enabled: failedState.enabled,
  timer_active: failedState.timer_active,
  runtime_stopped_reason: failedState.runtime_stopped_reason,
  last_error: failedState.last_error,
  last_result: failedState.last_result,
};
const stale = __schedulerInternals.markSchedulerPersistentDisableFailed(
  new Error('late old generation failure'),
  { reason: 'late_old_generation', generation: generation + 1 },
);
assert.equal(stale.published, false, 'a stale scheduler generation must not publish a persistent-disable failure');
assert.deepEqual(
  {
    enabled: getSchedulerStatus().enabled,
    timer_active: getSchedulerStatus().timer_active,
    runtime_stopped_reason: getSchedulerStatus().runtime_stopped_reason,
    last_error: getSchedulerStatus().last_error,
    last_result: getSchedulerStatus().last_result,
  },
  beforeStalePublish,
  'a stale persistent-disable failure must not overwrite current scheduler status',
);

console.log('scheduler persistent-disable failure behavior passed');
