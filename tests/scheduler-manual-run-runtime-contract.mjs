import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const [appSource, schedulerSource, mainSource] = await Promise.all([
  fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8'),
  fsp.readFile(new URL('../src/daemon/scheduler.js', import.meta.url), 'utf8'),
  fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
]);

assert.ok(
  !appSource.includes('SCHEDULER_RUN_ONCE_HTTP_TIMEOUT_MS')
    && /api\('\/api\/scheduler\/run-once',[\s\S]*?timeoutMs:\s*0,[\s\S]*?body:\s*\{ base_settings_revision: runRevision \}/.test(appSource),
  'manual all-target runs must not fail on an arbitrary wall-clock timeout while explicit AbortSignal cancellation remains active',
);

const gateStart = appSource.indexOf('function schedulerManualRunGateMessage()');
const gateEnd = appSource.indexOf('function syncSchedulerAccountGate', gateStart);
assert.ok(gateStart >= 0 && gateEnd > gateStart, 'manual scheduler gate source must be bounded');
assert.ok(
  appSource.slice(gateStart, gateEnd).includes('latestSchedulerStatus?.running'),
  'manual run must be disabled when another page or the background scheduler is already running',
);

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
assert.ok(
  appSource.includes('function schedulerActiveProgressText(')
    && appSource.includes('schedulerActiveProgressText(view)')
    && appSource.includes('schedulerActiveProgressText(latestSchedulerStatus)'),
  'settings status and the in-flight manual-run ticker must render live scheduler progress',
);

console.log('scheduler manual run runtime contract passed');
