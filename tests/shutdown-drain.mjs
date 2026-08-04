import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import vm from 'node:vm';

const mainSource = await fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const settingsSource = await fsp.readFile(new URL('../src/config/settings.js', import.meta.url), 'utf8');
const outputSource = await fsp.readFile(new URL('../src/renderer/output.js', import.meta.url), 'utf8');
const loggerSource = await fsp.readFile(new URL('../src/lib/logger.js', import.meta.url), 'utf8');
const traySource = await fsp.readFile(new URL('../src/tray/wx-summary-tray.ps1', import.meta.url), 'utf8');
const trayShutdownSource = await fsp.readFile(new URL('../src/tray/stop-node-tree.ps1', import.meta.url), 'utf8');

const helperStart = mainSource.indexOf('function runAfterResponseFinished(');
const helperEnd = mainSource.indexOf('\nfunction attachmentDisposition(', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'after-response helper must remain available');
let afterResponseWarnings = 0;
const sandbox = {
  setImmediate,
  logWarn() { afterResponseWarnings += 1; },
  sanitizeText: value => String(value || ''),
};
vm.runInNewContext(`${mainSource.slice(helperStart, helperEnd)}\nglobalThis.__runAfterResponse = runAfterResponseFinished;`, sandbox, { timeout: 1_000 });

const response = new EventEmitter();
response.writableEnded = false;
response.destroyed = false;
let actionCalls = 0;
sandbox.__runAfterResponse(response, () => { actionCalls += 1; });
response.emit('close');
await new Promise(resolve => setImmediate(resolve));
assert.equal(actionCalls, 1, 'an early response close must still start graceful shutdown');
response.emit('finish');
await new Promise(resolve => setImmediate(resolve));
assert.equal(actionCalls, 1, 'finish after close must not start graceful shutdown twice');

const rejectedResponse = new EventEmitter();
rejectedResponse.writableEnded = false;
rejectedResponse.destroyed = false;
sandbox.__runAfterResponse(rejectedResponse, async () => { throw new Error('shutdown failed'); });
rejectedResponse.emit('finish');
await new Promise(resolve => setImmediate(resolve));
assert.equal(afterResponseWarnings, 1, 'an asynchronous after-response failure must be caught and logged');

assert.match(settingsSource, /export async function waitForSettingsSavesToSettle\(/, 'settings writes must expose an explicit shutdown drain');
assert.match(outputSource, /export async function waitForHistoryWritesToSettle\(/, 'history writes must expose an explicit shutdown drain');
assert.match(outputSource, /export async function waitForHistoryWorkToSettle\(/, 'history recovery, discovery, and write producers must expose one stable shutdown drain');
assert.match(loggerSource, /export async function waitForLoggerWritesToSettle\(/, 'logger writes must expose a bounded shutdown drain');
const shutdownStart = mainSource.indexOf('async function gracefulShutdown(');
const shutdownEnd = mainSource.indexOf('\nasync function waitForLocalActionWorkToSettle(', shutdownStart);
const shutdownSource = mainSource.slice(shutdownStart, shutdownEnd);
assert.match(shutdownSource, /await waitForSettingsSavesToSettle\(\)/, 'graceful shutdown must drain settings writes');
assert.match(shutdownSource, /await waitForHistoryWorkToSettle\(\)/, 'graceful shutdown must drain history producers before the final write queue');
assert.match(shutdownSource, /await waitForHistoryWritesToSettle\(\)/, 'graceful shutdown must drain history and retention writes');
assert.match(shutdownSource, /await waitForActiveRetentionCleanup\(\)/, 'graceful shutdown must await the tracked startup retention cleanup');
assert.match(shutdownSource, /const loggerSettled = await waitForLoggerWritesToSettle\(SHUTDOWN_LOG_SETTLE_TIMEOUT_MS\)[\s\S]*?if \(!loggerSettled\)[\s\S]*?process\.stderr\.write/, 'graceful shutdown must check the logger drain result and report incomplete diagnostics without queuing another log write');
assert.match(mainSource, /process\.on\('SIGINT', requestSignalShutdown\)[\s\S]*?process\.on\('SIGTERM', requestSignalShutdown\)[\s\S]*?process\.platform !== 'win32'[\s\S]*?process\.on\('SIGHUP', requestSignalShutdown\)/, 'repeated termination signals and POSIX terminal hangup must share the idempotent graceful shutdown path');
assert.match(mainSource, /let SHUTDOWN_DEADLINE_TIMER\s*=\s*null;/, 'shutdown must track one process-local deadline watchdog');
const deadlineHelperStart = mainSource.indexOf('function shutdownDeadlineDelayMs(');
const deadlineHelperEnd = mainSource.indexOf('\nfunction beginShutdownState(', deadlineHelperStart);
assert.ok(deadlineHelperStart >= 0 && deadlineHelperEnd > deadlineHelperStart, 'shutdown deadline delay helper must remain available');
const deadlineSandbox = {};
vm.runInNewContext(`${mainSource.slice(deadlineHelperStart, deadlineHelperEnd)}\nglobalThis.__shutdownDeadlineDelayMs = shutdownDeadlineDelayMs;`, deadlineSandbox, { timeout: 1_000 });
assert.equal(deadlineSandbox.__shutdownDeadlineDelayMs('2026-01-01T00:00:10.000Z', Date.parse('2026-01-01T00:00:00.000Z')), 10_000, 'shutdown watchdog must honor the published deadline');
assert.equal(deadlineSandbox.__shutdownDeadlineDelayMs('2025-12-31T23:59:59.000Z', Date.parse('2026-01-01T00:00:00.000Z')), 1, 'an elapsed shutdown deadline must still schedule an asynchronous immediate exit');
const watchdogStart = mainSource.indexOf('function armShutdownDeadlineWatchdog(');
const watchdogEnd = mainSource.indexOf('\nfunction beginShutdownState(', watchdogStart);
const watchdogSource = mainSource.slice(watchdogStart, watchdogEnd);
assert.match(watchdogSource, /setTimeout\([\s\S]*?shutdown_deadline_exceeded[\s\S]*?removeRuntimeInfo\(\)[\s\S]*?releaseInstanceLockSync\(\)[\s\S]*?process\.exit\(code\)/, 'deadline watchdog must report the stuck phase, release runtime ownership, and exit');
assert.match(
  watchdogSource,
  /shutdown_deadline_exceeded[\s\S]*?writeShutdownDeadlineEmergencyDiagnostic\([\s\S]*?process\.exit\(code\)/,
  'deadline watchdog must synchronously emit its terminal diagnostic before process.exit can discard the async logger queue',
);
const watchdogEvents = [];
let watchdogCallback = null;
const watchdogSandbox = {
  Buffer,
  SHUTDOWN_DEADLINE_TIMER: null,
  SHUTDOWN_PHASE: 'database\ncleanup',
  SHUTDOWN_STARTED_AT: '2026-01-01T00:00:00.000Z',
  SHUTDOWN_DEADLINE_AT: '2026-01-01T00:02:00.000Z',
  SHUTDOWN_TOTAL_BUDGET_MS: 120_000,
  setTimeout(callback) {
    watchdogCallback = callback;
    return { callback };
  },
  shutdownDeadlineDelayMs: () => 1,
  sanitizeText: value => String(value || ''),
  logError: () => watchdogEvents.push('async-log-queued'),
  fs: {
    writeSync(_fd, value) {
      watchdogEvents.push(`sync:${Buffer.from(value).toString('utf8')}`);
    },
  },
  removeRuntimeInfo: () => watchdogEvents.push('runtime-removed'),
  releaseInstanceLockSync: () => watchdogEvents.push('lock-released'),
  process: { exit: code => watchdogEvents.push(`exit:${code}`) },
};
vm.runInNewContext(`${watchdogSource}\nglobalThis.__armShutdownDeadlineWatchdog = armShutdownDeadlineWatchdog;`, watchdogSandbox, { timeout: 1_000 });
assert.equal(watchdogSandbox.__armShutdownDeadlineWatchdog(73), true);
watchdogCallback();
const synchronousDiagnostic = watchdogEvents.find(event => event.startsWith('sync:')) || '';
assert.match(synchronousDiagnostic, /phase=database cleanup/);
assert.ok(watchdogEvents.indexOf(synchronousDiagnostic) < watchdogEvents.indexOf('exit:73'), 'the synchronous diagnostic must precede hard exit');
assert.ok(watchdogEvents.indexOf('lock-released') < watchdogEvents.indexOf('exit:73'), 'the hard deadline must release ownership before exit');

watchdogSandbox.fs.writeSync = () => { throw new Error('stderr unavailable'); };
assert.equal(watchdogSandbox.__armShutdownDeadlineWatchdog(74), true);
watchdogCallback();
assert.ok(watchdogEvents.includes('exit:74'), 'a synchronous diagnostic failure must not prevent the hard exit');
assert.match(shutdownSource, /SHUTTING_DOWN\s*=\s*true;\s*armShutdownDeadlineWatchdog\(code\);/, 'graceful shutdown must arm the hard deadline before its first awaited drain');
assert.match(shutdownSource, /finally\s*{\s*disarmShutdownDeadlineWatchdog\(\);/, 'normal shutdown must disarm the hard deadline before exiting');

assert.match(trayShutdownSource, /\$deadline\s*=\s*\(Get-Date\)\.AddSeconds\(\$FallbackWaitSeconds\)[\s\S]*?Invoke-RestMethod/, 'tray shutdown helper must establish its fallback deadline before the HTTP request can fail');
assert.match(trayShutdownSource, /catch \{\}[\s\S]*?while \(\(Get-Date\) -lt \$deadline -and \(Expected-ProcessAlive\)\)/, 'tray shutdown helper must keep waiting after an uncertain HTTP response before force-killing the process tree');
assert.match(traySource, /function Request-TrayExit[\s\S]*?System\.Windows\.Forms\.Timer/, 'tray exit must poll the hidden shutdown helper instead of blocking the WinForms event thread');

console.log('shutdown drain tests passed');
