import assert from 'node:assert/strict';

const acceptanceDataDir = `outputs/.tmp/scheduler-timer-cycle-stop-drain-${process.pid}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = acceptanceDataDir;

const {
  __schedulerInternals,
  stopScheduler,
} = await import('../src/daemon/scheduler.js');

assert.equal(
  typeof __schedulerInternals.runSchedulerTimerCycle,
  'function',
  'the scheduler must own the complete timer callback as one lifecycle producer',
);
assert.equal(
  typeof __schedulerInternals.withSchedulerRuntimeStateLock,
  'function',
  'terminal shutdown must be able to drain the scheduler runtime-state persistence queue',
);

function deferred() {
  let resolve;
  const promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
}

async function assertStillPending(promise, message) {
  const marker = Symbol('pending');
  const outcome = await Promise.race([
    promise.then(() => 'settled', () => 'settled'),
    new Promise(resolve => setImmediate(() => resolve(marker))),
  ]);
  assert.equal(outcome, marker, message);
}

const cycleStarted = deferred();
const releaseCycle = deferred();
const cycleController = new AbortController();
const timerCycle = __schedulerInternals.runSchedulerTimerCycle(cycleController, async () => {
  cycleStarted.resolve();
  await releaseCycle.promise;
});
await cycleStarted.promise;

const ordinaryStop = stopScheduler({
  wait: true,
  timeout_ms: 5_000,
  reason: 'timer_cycle_drain_contract',
});
await assertStillPending(
  ordinaryStop,
  'wait:true must not return after activeRunPromise settles while timer-cycle post-processing is still active',
);
assert.equal(cycleController.signal.aborted, true, 'stopping must cancel the complete timer cycle');

releaseCycle.resolve();
await timerCycle;
assert.deepEqual(
  await ordinaryStop,
  {
    stopped: true,
    running: false,
    timed_out: false,
    reason: 'timer_cycle_drain_contract',
  },
);

const timedOutCycleStarted = deferred();
const releaseTimedOutCycle = deferred();
const timedOutCycleController = new AbortController();
const timedOutCycle = __schedulerInternals.runSchedulerTimerCycle(timedOutCycleController, async () => {
  timedOutCycleStarted.resolve();
  await releaseTimedOutCycle.promise;
});
await timedOutCycleStarted.promise;

const timedOutStop = await stopScheduler({
  wait: true,
  timeout_ms: 1,
  reason: 'timer_cycle_timeout_contract',
});
assert.deepEqual(
  timedOutStop,
  {
    stopped: false,
    running: true,
    timed_out: true,
    reason: 'timer_cycle_timeout_contract',
  },
  'a stop timeout must report that timer-cycle post-processing is still active',
);
assert.equal(timedOutCycleController.signal.aborted, true);
releaseTimedOutCycle.resolve();
await timedOutCycle;

const persistenceStarted = deferred();
const releasePersistence = deferred();
const pendingPersistence = __schedulerInternals.withSchedulerRuntimeStateLock(async () => {
  persistenceStarted.resolve();
  await releasePersistence.promise;
});
await persistenceStarted.promise;

const terminalStop = stopScheduler({
  wait: true,
  timeout_ms: 5_000,
  reason: 'terminal_persistence_drain_contract',
  terminal: true,
});
await assertStillPending(
  terminalStop,
  'terminal stop must wait for already-admitted runtime-state persistence before reporting stopped',
);

releasePersistence.resolve();
await pendingPersistence;
assert.equal((await terminalStop).stopped, true);

console.log('scheduler timer-cycle stop drain tests passed');
