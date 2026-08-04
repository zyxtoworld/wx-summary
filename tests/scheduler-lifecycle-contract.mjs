import assert from 'node:assert/strict';

const acceptanceDataDir = `outputs/.tmp/scheduler-lifecycle-${process.pid}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = acceptanceDataDir;
process.env.WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR = `${acceptanceDataDir}/runtime-tmp/wxdb`;

const {
  __schedulerInternals,
  getSchedulerStatus,
  runSchedulerOnce,
  scheduleSchedulerRestartWhenIdle,
  startScheduler,
  stopScheduler,
} = await import('../src/daemon/scheduler.js');

assert.equal(typeof __schedulerInternals.queueSchedulerLifecycle, 'function', 'scheduler lifecycle queue must be testable');

let releaseBlocker;
let notifyBlockerStarted;
const blockerGate = new Promise(resolve => { releaseBlocker = resolve; });
const blockerStarted = new Promise(resolve => { notifyBlockerStarted = resolve; });
const blocker = __schedulerInternals.queueSchedulerLifecycle(async () => {
  notifyBlockerStarted();
  await blockerGate;
});
await blockerStarted;

const queuedStart = startScheduler();
const terminalStopStartedAt = Date.now();
const terminalStop = stopScheduler({
  wait: true,
  timeout_ms: 40,
  reason: 'contract_terminal_shutdown',
  terminal: true,
});
const terminalStopOutcome = await Promise.race([
  terminalStop.then(value => ({ settled: true, value })),
  new Promise(resolve => setTimeout(() => resolve({ settled: false, value: null }), 500)),
]);
assert.equal(
  terminalStopOutcome.settled,
  true,
  'terminal stop timeout must include time spent waiting for an earlier lifecycle transition',
);
assert.equal(terminalStopOutcome.value?.timed_out, true);
assert.equal(terminalStopOutcome.value?.running, true);
assert.ok(
  Date.now() - terminalStopStartedAt < 500,
  'terminal stop must return within its own deadline even when the lifecycle queue is blocked',
);
releaseBlocker();
await blocker;

await assert.rejects(
  queuedStart,
  error => error?.name === 'AbortError' && error?.code === 'scheduler_terminal_shutdown',
  'a start already queued before terminal shutdown must still be rejected when it reaches the lifecycle boundary',
);
await __schedulerInternals.queueSchedulerLifecycle(() => undefined);
assert.equal(getSchedulerStatus().timer_active, false);
assert.equal(scheduleSchedulerRestartWhenIdle({ reason: 'after_terminal_shutdown' }), false, 'idle recovery must not queue a restart after terminal shutdown');
const lastStartedAtAfterStop = getSchedulerStatus().last_started_at;
await assert.rejects(
  runSchedulerOnce({ reason: 'run_after_terminal_shutdown', force: true }),
  error => error?.name === 'AbortError' && error?.code === 'scheduler_terminal_shutdown',
  'the real scheduler producer entry must reject new work after terminal shutdown',
);
assert.equal(
  getSchedulerStatus().last_started_at,
  lastStartedAtAfterStop,
  'a rejected post-terminal run must not publish a new start timestamp',
);
await assert.rejects(
  startScheduler(),
  error => error?.name === 'AbortError' && error?.code === 'scheduler_terminal_shutdown',
  'new starts must fail closed after terminal shutdown',
);

console.log('scheduler lifecycle contract tests passed');
