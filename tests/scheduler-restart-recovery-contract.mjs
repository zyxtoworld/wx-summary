import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const source = await fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const startAt = source.indexOf('async function restartPersistedSchedulerIfRunnable');
const endAt = source.indexOf('function settingsPatchChangesSchedulerRuntime', startAt);
assert.ok(startAt >= 0 && endAt > startAt, 'scheduler recovery source boundaries must exist');
const recovery = source.slice(startAt, endAt);

assert.equal(
  recovery.includes('schedulerSetupAccounts'),
  false,
  'settings-save recovery must not pre-scan accounts outside the scheduler retry lifecycle',
);
assert.match(recovery, /await restartScheduler\(\{ signal \}\)/);
assert.match(recovery, /timer_active|next_run_at/);
assert.match(recovery, /已安排自动重试/);

console.log('scheduler restart recovery contract test passed');
