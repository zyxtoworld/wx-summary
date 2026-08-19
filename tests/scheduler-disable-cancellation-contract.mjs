import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const source = (await fsp.readFile(new URL('../src/daemon/scheduler.js', import.meta.url), 'utf8'))
  .replace(/\r\n/g, '\n');
const executeStart = source.indexOf('async function executeSchedulerTick(');
const executeEnd = source.indexOf('\nfunction schedulerCollectionRecheckMeta(', executeStart);
const executeSource = source.slice(executeStart, executeEnd);
const scheduleStart = source.indexOf('async function scheduleNext(');
const scheduleEnd = source.indexOf('\nasync function executeSchedulerTick(', scheduleStart);
const scheduleSource = source.slice(scheduleStart, scheduleEnd);
const stopStart = source.indexOf('function schedulerStopRuntimeNow(');
const stopEnd = source.indexOf('\nexport function closeSchedulerAdmission(', stopStart);
const stopSource = source.slice(stopStart, stopEnd);

assert.ok(executeStart >= 0 && executeEnd > executeStart, 'scheduler tick source must be bounded');
assert.ok(scheduleStart >= 0 && scheduleEnd > scheduleStart, 'scheduler timer-cycle source must be bounded');
assert.ok(stopStart >= 0 && stopEnd > stopStart, 'scheduler synchronous stop boundary must be bounded');

assert.ok(
  executeSource.includes("disablePersistedSchedulerForSetup(settings, { reason: reason || 'run', signal })")
    && executeSource.includes("disablePersistedSchedulerForSetup(settings, { reason: reason || 'manual_key_unverified', signal })"),
  'manual and timer scheduler ticks must propagate cancellation into every persistent auto-disable branch',
);
assert.ok(
  source.includes('let activeTimerCycleController = null;')
    && scheduleSource.includes('const cycleController = new AbortController()')
    && scheduleSource.includes("runSchedulerOnce({ reason: 'timer', signal: cycleController.signal })")
    && scheduleSource.includes("disablePersistedSchedulerForSetup(latest, { reason: 'reschedule', signal: cycleController.signal })")
    && scheduleSource.includes('schedulerSettingsNeedSetupWithRuntime(latest, latestAccounts, { signal: cycleController.signal })'),
  'the timer cycle must keep one cancellation signal through post-run account checks and persistent rescheduling decisions',
);
assert.ok(
  stopSource.includes('const timerCycleController = activeTimerCycleController;')
    && stopSource.includes('timerCycleController.abort(schedulerAbortError(reason))'),
  'stopping the scheduler must abort post-run rescheduling before it can persist a disable decision',
);
assert.ok(
  scheduleSource.includes("if (schedulerTerminalShutdown || generation !== schedulerGeneration || cycleController.signal.aborted) return;\n        state.enabled = false;"),
  'the timer cycle must recheck cancellation and generation immediately before its final disabled-state writeback',
);

console.log('scheduler persistent-disable cancellation contract passed');
