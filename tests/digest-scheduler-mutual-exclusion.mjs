import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  getSchedulerStatus,
  runSchedulerOnce,
  setSchedulerManualDigestActivityProbe,
} from '../src/daemon/scheduler.js';

const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const scheduler = fs.readFileSync(new URL('../src/daemon/scheduler.js', import.meta.url), 'utf8');

setSchedulerManualDigestActivityProbe(() => true);
const blocked = await runSchedulerOnce({ reason: 'mutual_exclusion_test' });
setSchedulerManualDigestActivityProbe(null);

assert.equal(blocked.ok, false);
assert.equal(blocked.detail, 'manual_digest_active');
assert.equal(blocked.retry_after_ms > 0, true);
assert.equal(getSchedulerStatus().running, false, 'a blocked scheduler run must not claim the runtime lock');

assert.match(
  scheduler,
  /if \(schedulerManualDigestActivityActive\(\)\)[\s\S]*?detail: 'manual_digest_active'[\s\S]*?const runLease = tryAcquireSchedulerRunLease\(reason, \{ timer_cycle_signal: signal \}\)/,
  'scheduler must synchronously reject a run before taking its runtime lock when a manual digest batch is active',
);

assert.match(
  main,
  /setSchedulerManualDigestActivityProbe\(manualDigestActivityForScheduler\)/,
  'the HTTP service must connect its live manual digest leases to the scheduler guard',
);

const batchStart = main.slice(
  main.indexOf("if (pathname === '/api/digest-batch-start'"),
  main.indexOf("if (pathname === '/api/digest-batch-finish'"),
);
assert.ok(
  batchStart.indexOf('assertSchedulerIdleForManualDigest()') >= 0
    && batchStart.indexOf('assertSchedulerIdleForManualDigest()') < batchStart.indexOf('ACTIVE_DIGEST_BATCH_STARTS.add'),
  'manual batch start must check the scheduler immediately before reserving its batch lease',
);

const digestRoute = main.slice(
  main.indexOf("if (pathname === '/api/digest'"),
  main.indexOf("if (pathname === '/api/digest-result'"),
);
assert.ok(
  digestRoute.indexOf('assertSchedulerIdleForManualDigest()') >= 0
    && digestRoute.indexOf('assertSchedulerIdleForManualDigest()') < digestRoute.indexOf('ACTIVE_DIGEST_REQUESTS.set(requestId'),
  'manual digest requests must retain a second scheduler guard before reserving a database read',
);

console.log('manual digest and scheduler mutual exclusion passed');
