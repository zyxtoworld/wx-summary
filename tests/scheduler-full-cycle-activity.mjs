import assert from 'node:assert/strict';

const acceptanceDataDir = `outputs/.tmp/scheduler-full-cycle-activity-${process.pid}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = acceptanceDataDir;
process.env.WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR = `${acceptanceDataDir}/runtime-tmp/wxdb`;

const {
  __schedulerInternals,
  getSchedulerStatus,
  runSchedulerOnce,
} = await import('../src/daemon/scheduler.js');

function deferred() {
  let resolve;
  const promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
}

const cycleStarted = deferred();
const releasePostProcessing = deferred();
const cycleController = new AbortController();
const timerCycle = __schedulerInternals.runSchedulerTimerCycle(cycleController, async () => {
  cycleStarted.resolve();
  await releasePostProcessing.promise;
});
await cycleStarted.promise;

assert.equal(
  getSchedulerStatus().running,
  true,
  'the scheduler must stay visibly active through timer-cycle post-processing and final state persistence',
);

const overlappingRun = await runSchedulerOnce({ reason: 'manual_during_timer_post_processing' });
assert.equal(overlappingRun.ok, false);
assert.equal(
  overlappingRun.detail,
  'already_running',
  'manual admission must remain closed until the complete timer cycle has settled',
);

releasePostProcessing.resolve();
await timerCycle;
assert.equal(getSchedulerStatus().running, false, 'activity must clear after the complete timer cycle settles');

console.log('scheduler full-cycle activity tests passed');
