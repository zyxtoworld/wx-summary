import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../src/main.js', import.meta.url), 'utf8');

function sliceBetween(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, `${startText} source must remain available`);
  return source.slice(start, end);
}

const commitSource = sliceBetween(
  'async function markWindowLocalActionCommitted(',
  '\nasync function markWindowLocalActionLateFailure(',
);
assert.match(commitSource, /const persistence = await persistRecordedLocalActionEvidence\(evidence\)/);
assert.match(commitSource, /persistence\.evidence_persisted !== true/);
assert.match(commitSource, /commit_evidence_persist_failed/);
assert.match(commitSource, /return persistence/);

const launcherSource = sliceBetween(
  'function launchWindowsExplorerNative(',
  '\nfunction runBoundedWindowsExplorerAction(',
);
const responsiveSource = sliceBetween(
  'function runResponsiveWindowsExplorerAction(',
  '\nfunction localActionAbortError(',
);
assert.match(
  responsiveSource,
  /return runBoundedWindowsExplorerAction\(targetPath, \{ \.\.\.options, mode \}\);/,
  'the active Windows Explorer path must verify the exact target before foregrounding it',
);
assert.doesNotMatch(
  responsiveSource,
  /return launchWindowsExplorerNative\(targetPath, \{ \.\.\.options, mode \}\);/,
  'the unverified native launcher must remain a fallback instead of the primary click path',
);
assert.match(launcherSource, /const commitEvidencePersisted = await notifyCommitted\(\)/);
assert.match(launcherSource, /await onCommitted\?\.\(\)[\s\S]*?cleanupLocalActionCommitEvidence\(commitEvidencePath\)[\s\S]*?return true[\s\S]*?catch \(error\)[\s\S]*?return false/);
assert.match(launcherSource, /cleanupLocalActionCommitEvidence\(commitEvidencePath\)/);
assert.doesNotMatch(
  launcherSource,
  /notifyCommitted[\s\S]*?\.finally\(\(\) => \{[\s\S]*?cleanupLocalActionCommitEvidence/,
  'a failed evidence persistence callback must retain the native commit marker',
);

const watchdogSource = sliceBetween(
  'function startNativeExplorerTopmostWatchdog(',
  '\nfunction clearNativeExplorerTopmost(',
);
assert.match(watchdogSource, /detached: true/);
assert.match(watchdogSource, /windowsHide: true/);
assert.match(watchdogSource, /stdio: 'ignore'/);
assert.match(watchdogSource, /child\.unref\(\)/);

const activationSource = sliceBetween(
  'async function activateNativeExplorerWindow(',
  '\nfunction scheduleNativeExplorerForegroundHandoff(',
);
const watchdogIndex = activationSource.indexOf('startNativeExplorerTopmostWatchdog(windowHandle)');
const topmostIndex = activationSource.indexOf('api.SetWindowPos(windowHandle, -1');
assert.ok(watchdogIndex >= 0 && topmostIndex > watchdogIndex, 'the independent cleanup watchdog must start before the topmost mutation');
assert.match(activationSource, /if \(foreground\.deferred_topmost_clear_result\) \{/);
assert.match(
  source,
  /const WINDOWS_EXPLORER_NATIVE_WINDOW_WAIT_MS = ([\d_]+);/,
  'native Explorer launch must expose a bounded window-discovery budget',
);
const nativeWindowWaitMs = Number(source.match(/const WINDOWS_EXPLORER_NATIVE_WINDOW_WAIT_MS = ([\d_]+);/)[1].replaceAll('_', ''));
assert.ok(
  nativeWindowWaitMs >= 2_500 && nativeWindowWaitMs <= 5_000,
  'native Explorer discovery must cover normal Windows 11 launch latency without making the click unbounded',
);
assert.match(activationSource, /GetWindowThreadProcessId/);
assert.match(activationSource, /GetCurrentThreadId/);
assert.match(activationSource, /AttachThreadInput/);
assert.match(activationSource, /SetActiveWindow/);
assert.match(
  activationSource,
  /finally[\s\S]*?AttachThreadInput[\s\S]*?false/,
  'native Explorer activation must always detach temporarily joined input queues',
);

assert.doesNotMatch(
  launcherSource,
  /windowsExplorerNativeApi\(|nativeExplorerWindowHandles\(|captureNativeExplorerLaunchForeground\(|waitForNativeExplorerWindow\(|activateNativeExplorerWindow\(|scheduleNativeExplorerForegroundHandoff\(/,
  'a newly observed Explorer HWND is not target identity and must never be foregrounded before path verification',
);
assert.match(
  launcherSource,
  /const commitEvidencePersisted = await notifyCommitted\(\);[\s\S]*?finish\(resolve, nativeWindowsExplorerResult\(/,
  'native Explorer launch should return committed pending evidence so target-bound verification can run after the response',
);

const nativeTopmostClearSource = sliceBetween(
  'function clearNativeExplorerTopmost(',
  '\nfunction scheduleNativeExplorerTopmostClear(',
);
assert.match(nativeTopmostClearSource, /const flags = 0x0001 \| 0x0002 \| 0x0010 \| 0x0040;/);
assert.equal(
  (nativeTopmostClearSource.match(/SetWindowPos\(/g) || []).length,
  1,
  'native topmost cleanup must only demote the window and must not raise it again as HWND_TOP',
);

const powerShellRunnerSource = sliceBetween(
  'async function runLocalActionPowerShell(',
  '\nfunction systemImageClipboardCommandSpec(',
);
assert.match(powerShellRunnerSource, /terminateWindowsProcessTree\(child,/);
assert.match(powerShellRunnerSource, /quarantineLocalActionLane\(queueLane, terminationCleanupPromise \|\| processClosedPromise\)/);
assert.match(powerShellRunnerSource, /process_termination_unconfirmed/);
assert.match(
  powerShellRunnerSource,
  /const stopWithoutTerminatingCommittedProcess = error =>[\s\S]*?quarantineLocalActionLane\(queueLane, processClosedPromise\)[\s\S]*?finish\(resolve, localActionAfterCommitResult\(stdout, stderr, error\)\)/,
  'an action whose commit marker is already durable must release the request without killing its PowerShell or newly opened Explorer process tree',
);
assert.match(
  powerShellRunnerSource,
  /committedFromOutputOrEvidence\(\)[\s\S]*?if \(committed\)[\s\S]*?stopWithoutTerminatingCommittedProcess\(error\)[\s\S]*?killFor\(error\)/,
  'abort and timeout handling must check durable commit evidence before terminating the local process tree',
);
assert.doesNotMatch(
  powerShellRunnerSource,
  /const onAbort = \(\) => killFor\(/,
  'request abort must not unconditionally terminate a process tree after an external action has committed',
);

const publicEvidenceSource = sliceBetween(
  'function publicLocalActionEvidence(',
  '\nasync function serveStatic(',
);
assert.match(publicEvidenceSource, /'window_ambiguous'/);
assert.match(publicEvidenceSource, /'target_window_count'/);

const boundedSource = sliceBetween(
  'function runBoundedWindowsExplorerAction(',
  '\nfunction runResponsiveWindowsExplorerAction(',
);
assert.match(
  boundedSource,
  /if \(localActionProcessTerminationUnconfirmed\(error\)\) throw error;/,
  'an Explorer controller whose process tree is still alive must not start a second fallback action',
);

assert.match(source, /const WINDOWS_EXPLORER_FOREGROUND_INTENT_LEASE_MS = 8_000;/);
const foregroundIntentSource = sliceBetween(
  'function armWindowActionForegroundIntent(',
  '\nfunction windowActionCanRetryForegroundActivation(',
);
assert.match(foregroundIntentSource, /foreground_activation_intent_deadline_at/);
const foregroundRetrySource = sliceBetween(
  'function windowActionCanRetryForegroundActivation(',
  '\nfunction reserveWindowActionForegroundActivation(',
);
assert.match(foregroundRetrySource, /foreground_activation_intent_deadline_at/);
assert.match(foregroundRetrySource, /Date\.now\(\) >= intentDeadline/);
assert.match(source, /recordRevealEvidence[\s\S]*?armWindowActionForegroundIntent\(evidence, \{ refresh: true \}\)/);
assert.match(source, /recordOpenOutputEvidence[\s\S]*?armWindowActionForegroundIntent\(evidence, \{ refresh: true \}\)/);

const revealVerifierSource = sliceBetween(
  'async function verifyPendingRevealEvidence(',
  '\nasync function verifyPendingOpenOutputEvidence(',
);
assert.ok(
  revealVerifierSource.indexOf('await probeExplorerSelection(')
    < revealVerifierSource.indexOf('await activateExistingExplorerWindowForeground('),
  'file reveal must verify the selected target path before foregrounding its Explorer window',
);

const outputVerifierSource = sliceBetween(
  'async function verifyPendingOpenOutputEvidence(',
  '\nfunction explorerWindowProbeScriptPreamble(',
);
assert.ok(
  outputVerifierSource.indexOf('await probeExplorerFolderWindow(')
    < outputVerifierSource.indexOf('await activateExistingExplorerWindowForeground('),
  'output-directory opening must verify the target folder before foregrounding its Explorer window',
);

for (const [name, functionSource] of [
  ['selection probe', sliceBetween('function probeExplorerSelection(', '\nfunction probeExplorerFolderWindow(')],
  ['folder probe', sliceBetween('function probeExplorerFolderWindow(', '\nfunction explorerTopmostHoldRemainingMs(')],
  ['foreground activation', sliceBetween('function activateExistingExplorerWindowForeground(', '\nfunction probeExistingExplorerWindowForeground(')],
  ['foreground confirmation', sliceBetween('function probeExistingExplorerWindowForeground(', '\nfunction normalizedClipboardSize(')],
]) {
  assert.match(
    functionSource,
    /checkDesktopSession:\s*true/,
    `the delayed Explorer ${name} must remain bound to the active interactive Windows session`,
  );
  assert.doesNotMatch(
    functionSource,
    /checkDesktopSession:\s*false/,
    `the delayed Explorer ${name} must not bypass the active desktop-session gate`,
  );
}

const clearScriptSource = sliceBetween(
  'const WINDOWS_DEFERRED_TOPMOST_CLEAR_SCRIPT = `',
  '\nconst WINDOWS_DEFERRED_TOPMOST_CLEAR_SCRIPT_B64',
);
assert.match(clearScriptSource, /GetClassName/);
assert.match(clearScriptSource, /GetWindowThreadProcessId/);
assert.match(clearScriptSource, /CabinetWClass/);
assert.match(clearScriptSource, /ExploreWClass/);
assert.match(clearScriptSource, /ProcessName/);

console.log('Explorer local action contract tests passed');
