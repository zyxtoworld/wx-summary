import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const [schedulerSource, mainSource] = await Promise.all([
  fsp.readFile(new URL('../src/daemon/scheduler.js', import.meta.url), 'utf8'),
  fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
]);

assert.ok(
  schedulerSource.includes('active_progress: null')
    && schedulerSource.includes('function updateActiveSchedulerProgress(')
    && schedulerSource.includes('onProgress: reportTargetProgress')
    && schedulerSource.includes('onProgress,')
    && schedulerSource.includes('completed_targets:'),
  'scheduler runtime status must track bounded per-target progress and forward collector/AI stages',
);
assert.ok(
  mainSource.includes('active_progress: publicSchedulerProgress(status.active_progress)')
    && mainSource.includes('function publicSchedulerProgress('),
  'scheduler progress must pass through an explicit public sanitizer',
);

console.log('scheduler manual run runtime contract passed');
