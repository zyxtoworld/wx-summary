import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const launcher = await fsp.readFile(new URL('../启动.cmd', import.meta.url), 'utf8');
const hiddenLauncher = await fsp.readFile(new URL('../scripts/start-tray-hidden.vbs', import.meta.url), 'utf8');
const dependencyHelper = await fsp.readFile(new URL('../scripts/ensure-dependencies.ps1', import.meta.url), 'utf8');
const tray = await fsp.readFile(new URL('../src/tray/wx-summary-tray.ps1', import.meta.url), 'utf8');
const shutdownHelper = await fsp.readFile(new URL('../src/tray/stop-node-tree.ps1', import.meta.url), 'utf8');
const main = await fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8');

assert.match(launcher, /ensure-dependencies\.ps1/i, 'Windows launcher must delegate dependency setup to the locked helper');
assert.doesNotMatch(launcher, /\bnpm\s+ci\b/i, 'the batch launcher must not install outside the dependency mutex');
assert.doesNotMatch(launcher, /wscript\.exe"?\s+\/\/B/i, 'windowless tray launch must still allow fatal startup messages to be shown');
assert.match(hiddenLauncher, /FileExists\(ps1\)/i, 'hidden launcher must report a missing tray script before starting PowerShell');
assert.match(hiddenLauncher, /shell\.Popup/i, 'hidden launcher must surface trusted executable, script, and process launch failures');
assert.match(hiddenLauncher, /On Error Resume Next[\s\S]*?shell\.Run[\s\S]*?Err\.Number/i, 'hidden launcher must report a synchronous process launch failure instead of exiting silently');
assert.match(dependencyHelper, /System\.Threading\.Mutex/);
assert.match(dependencyHelper, /Project-DependencyMutexName/);
assert.match(dependencyHelper, /WaitOne\(/);
const dependencyLock = dependencyHelper.indexOf('$lockAcquired =');
const dependencyRecheck = dependencyHelper.indexOf('Invoke-NativeCommand $node @($DependencyCheckScript)', dependencyLock);
const dependencyInstall = dependencyHelper.indexOf("@('ci')", dependencyRecheck);
assert.ok(dependencyLock >= 0 && dependencyRecheck > dependencyLock && dependencyInstall > dependencyRecheck, 'dependencies must be rechecked after acquiring the install mutex');
assert.match(dependencyHelper, /finally\s*\{[\s\S]*?ReleaseMutex\(\)/);

assert.match(tray, /function Start-NodeShutdownHelper/);
assert.match(tray, /function Request-TrayExit/);
assert.match(tray, /function Test-ExpectedNodeProcessAlive/);
assert.match(tray, /function Restore-TrayAfterShutdownFailure/);
assert.match(tray, /System\.Windows\.Forms\.Timer/);
assert.match(tray, /-WindowStyle Hidden/);
assert.doesNotMatch(tray, /Stop-Process\s+-Id\s+\$script:NodeProcess\.Id\s+-Force/, 'tray must never kill only the Node parent');
const versionAwareWaitStart = tray.indexOf('function Wait-VersionAwareServer');
const versionAwareWaitEnd = tray.indexOf('\nfunction Wait-ExistingTrayOrAcquireMutex', versionAwareWaitStart);
const versionAwareWait = tray.slice(versionAwareWaitStart, versionAwareWaitEnd);
assert.ok(versionAwareWaitStart >= 0 && versionAwareWaitEnd > versionAwareWaitStart, 'version-aware launcher wait source must remain bounded');
assert.match(versionAwareWait, /\$rawExitCode\s*=\s*\$null[\s\S]*?\$LauncherProcess\.ExitCode/, 'launcher failure handling must read the process exit code defensively');
assert.match(versionAwareWait, /\$exitCodeText[\s\S]*?unknown/, 'launcher failure handling must show an explicit unknown exit code instead of a blank message');
assert.match(versionAwareWait, /Read-LauncherFailureDetail/, 'launcher failure handling must point to the captured startup logs');
const exitedBlockStart = versionAwareWait.indexOf('if ($LauncherProcess.HasExited)');
const exitedBlockEnd = versionAwareWait.indexOf('\n    Start-Sleep', exitedBlockStart);
const exitedBlock = versionAwareWait.slice(exitedBlockStart, exitedBlockEnd);
assert.match(exitedBlock, /\$attached\s*=\s*Try-AttachExistingServer[\s\S]*?\$rawExitCode/, 'launcher wait must attach a healthy existing service before trusting the redirected process exit code');
assert.match(tray, /Get-Content -LiteralPath \$path -Tail 12 -Encoding UTF8/, 'launcher failure logs must decode Node UTF-8 output correctly');
const readyTimerStart = tray.indexOf('$readyTimer.Add_Tick({');
const readyTimerEnd = tray.indexOf('\n  })', readyTimerStart);
const readyTimer = tray.slice(readyTimerStart, readyTimerEnd);
assert.ok(readyTimerStart >= 0 && readyTimerEnd > readyTimerStart, 'tray ready timer must remain available');
assert.doesNotMatch(
  readyTimer,
  /\$notify\.Text\s*=\s*"[^"\r\n]*\$script:ServerUrl[^"\r\n]*"/,
  'NotifyIcon.Text must never include the credential-bearing launch URL or exceed the Windows PowerShell 5.1 limit',
);
assert.doesNotMatch(
  readyTimer,
  /\$notify\.ShowBalloonTip\([^\r\n]*\$script:ServerUrl/,
  'the startup balloon must not expose the credential-bearing launch URL',
);
assert.match(readyTimer, /\$notify\.Text\s*=\s*'wx-summary'/, 'the ready state must keep a stable short tray label');
const exitHandler = tray.slice(tray.indexOf('$exitItem.Add_Click({'), tray.indexOf('\n  })', tray.indexOf('$exitItem.Add_Click({')) + 5);
assert.match(exitHandler, /Request-TrayExit/);
assert.doesNotMatch(exitHandler, /Stop-Node/, 'exit click must not block the WinForms UI thread');

const requestExitStart = tray.indexOf('function Request-TrayExit');
const requestExitEnd = tray.indexOf('\ntry {\n  $createdMutex', requestExitStart);
const requestExit = tray.slice(requestExitStart, requestExitEnd);
assert.match(
  requestExit,
  /if \(-not \(Test-ExpectedNodeProcessAlive\)\) \{\s*Complete-TrayExit/,
  'tray exit may complete only after the original identity-bound Node process is gone',
);
assert.match(
  requestExit,
  /if \(\$script:ShutdownHelperProcess\.HasExited\) \{[\s\S]*?Restore-TrayAfterShutdownFailure/,
  'a shutdown helper that exits while Node is still alive must restore the tray instead of reporting success',
);
assert.match(
  requestExit,
  /\$script:ShutdownFallbackProcess\.HasExited[\s\S]*?Test-ExpectedNodeProcessAlive[\s\S]*?\$script:ShutdownFallbackProcess = Start-FallbackTaskkillTree/,
  'the asynchronous taskkill fallback must be observed and identity-rechecked before the tray exits',
);
assert.doesNotMatch(
  requestExit,
  /Start-FallbackTaskkillTree\) \} catch \{\}\s*Complete-TrayExit/,
  'starting a fallback command is not evidence that the service stopped',
);
assert.match(
  requestExit,
  /catch \{\s*try \{\s*\$script:ShutdownHelperProcess = Start-FallbackTaskkillTree[\s\S]*?catch \{\s*\$script:ShutdownHelperProcess = \$null/,
  'a fallback launcher failure must stay inside the tray state machine so controls can be restored',
);

assert.match(shutdownHelper, /process_start_id/i);
assert.match(shutdownHelper, /Get-ProcessStartIdentity/);
assert.match(shutdownHelper, /Trusted-TaskkillExecutable/);
assert.match(shutdownHelper, /System32[\\/]taskkill\.exe/i);
assert.match(shutdownHelper, /@\('\/PID', \[string\]\$ExpectedPid, '\/T', '\/F'\)/);
assert.match(shutdownHelper, /Invoke-RestMethod[\s\S]*?shutdown_deadline_at/);
assert.match(shutdownHelper, /while \(\(Get-Date\) -lt \$deadline/);

const gracefulStart = main.indexOf('async function gracefulShutdown(');
const gracefulEnd = main.indexOf('\nasync function waitForLocalActionWorkToSettle(', gracefulStart);
const graceful = main.slice(gracefulStart, gracefulEnd);
assert.match(graceful, /const schedulerStopResult = await stopScheduler/);
assert.match(graceful, /schedulerStopResult\?\.stopped === true/);
assert.match(graceful, /schedulerStopResult\?\.running !== true/);
assert.match(graceful, /schedulerStopResult\?\.timed_out !== true/);
assert.match(graceful, /const finalMirrors = activeWxDbMirrorTaskStatus\(\);[\s\S]*?const databaseDependenciesSettled = schedulerCleanupSafe && finalMirrorCleanupSafe && digestCleanupSafe;/);
assert.match(graceful, /setShutdownPhase\('closing_database_read_sessions'\);[\s\S]*?await releaseAllWxDbIsolatedBatchSessions\('service_shutdown'\)/,
  'shutdown must always close isolated database workers even when another producer failed to settle');
assert.doesNotMatch(graceful, /if \(databaseDependenciesSettled\) \{[\s\S]*?releaseAllWxDbIsolatedBatchSessions/,
  'unsettled dependencies may preserve temporary files but must not leave worker processes alive');
assert.match(graceful, /const temporaryCleanupSafe = shutdownTemporaryCleanupSafe\([\s\S]*?if \(temporaryCleanupSafe\) \{[\s\S]*?clearTmpDirForShutdown/);
assert.match(graceful, /shutdown_database_dependencies_not_settled/);
assert.match(graceful, /shutdown_temporary_cleanup_skipped/);

console.log('tray lifecycle hardening tests passed');
