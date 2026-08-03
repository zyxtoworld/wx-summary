import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const source = await fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const accessStart = source.indexOf('async function assertApiAccess(');
const accessEnd = source.indexOf('\nconst LOG_REDACT_KEYS', accessStart);
assert.ok(accessStart >= 0 && accessEnd > accessStart, 'API admission source must be inspectable');
const accessSource = source.slice(accessStart, accessEnd);
assert.ok(
  (accessSource.match(/assertServiceAcceptingApiRequest\(parsedUrl\.pathname\)/g) || []).length >= 2,
  'API admission must check shutdown both before and after asynchronous request preparation',
);

const schedulerRouteStart = source.indexOf("if (pathname === '/api/scheduler/run-once'");
const schedulerRouteEnd = source.indexOf("if (pathname === '/api/scheduler/clear-unverified-legacy-cursors'", schedulerRouteStart);
const schedulerRoute = source.slice(schedulerRouteStart, schedulerRouteEnd);
assert.ok(
  schedulerRoute.indexOf('assertServiceAcceptingApiRequest(pathname)')
    < schedulerRoute.indexOf("runSchedulerOnce({ reason: 'manual_api'"),
  'manual scheduler admission must recheck shutdown immediately before registering the producer',
);

console.log('shutdown API admission contract tests passed');
