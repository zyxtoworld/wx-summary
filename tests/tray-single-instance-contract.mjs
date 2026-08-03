import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const traySource = await fsp.readFile(new URL('../src/tray/wx-summary-tray.ps1', import.meta.url), 'utf8');
const mainStart = traySource.indexOf('try {\n  $createdMutex');
const launcherStart = traySource.indexOf('$launcherProcess = Start-VersionAwareServerLauncher $node', mainStart);
const ownershipGate = traySource.indexOf('if (-not $createdMutex) {', mainStart);
const sourceChangeHandoff = traySource.indexOf('Request-ExistingTraySourceChangeShutdown', ownershipGate);
const handoffWait = traySource.indexOf('Wait-ExistingTrayOrAcquireMutex $script:TrayMutex', ownershipGate);
const launcherTracked = traySource.indexOf('$script:NodeProcess = $launcherProcess', launcherStart);
const launcherWait = traySource.indexOf('$attachedProcess = Wait-VersionAwareServer $launcherProcess', launcherStart);

assert.ok(mainStart >= 0 && ownershipGate > mainStart, 'tray startup must branch on mutex ownership');
assert.ok(ownershipGate < launcherStart, 'a second tray must resolve mutex ownership before it can start Node');
assert.ok(
  ownershipGate < sourceChangeHandoff && sourceChangeHandoff < handoffWait,
  'a second tray must ask a trusted stale-source service to shut down before waiting for the old tray mutex',
);
assert.ok(
  launcherStart < launcherTracked && launcherTracked < launcherWait,
  'the tray must track the newly spawned Node before waiting for health so timeout cleanup cannot orphan it',
);
assert.match(
  traySource.slice(launcherTracked, launcherWait),
  /\$script:NodeProcessStartId = Node-ProcessStartIdentity \$launcherProcess\.Id/,
  'startup cleanup must bind the launched PID to its start identity before health polling',
);
assert.match(traySource, /function Wait-ExistingTrayOrAcquireMutex[\s\S]*?Try-AttachExistingServer[\s\S]*?WaitOne/, 'the losing tray must first attach to the service or wait to inherit mutex ownership');
const handoffWaitSource = traySource.slice(
  traySource.indexOf('function Wait-ExistingTrayOrAcquireMutex'),
  traySource.indexOf('\nfunction Get-Sha256Hex'),
);
assert.match(
  handoffWaitSource,
  /\$nextSourceChangeProbeAt[\s\S]*?while \(\(Get-Date\) -lt \$deadline\)[\s\S]*?Request-ExistingTraySourceChangeShutdown[\s\S]*?\.AddSeconds\(2\)[\s\S]*?WaitOne\(250\)/,
  'a losing tray must keep probing for a late source-version change while it waits for the old tray mutex',
);
assert.match(
  traySource,
  /function Request-ExistingTraySourceChangeShutdown[\s\S]*?source_asset_version[\s\S]*?shutdown_token[\s\S]*?\/api\/shutdown/,
  'tray source-change handoff must be version-aware and use the authenticated local shutdown endpoint',
);
assert.match(traySource, /catch \[System\.Threading\.AbandonedMutexException\][\s\S]*?acquired = \$true/, 'an abandoned tray mutex must transfer ownership to the waiting launcher');
assert.doesNotMatch(traySource.slice(launcherStart), /if \(-not \$createdMutex\)/, 'mutex ownership must not be decided after spawning Node');

console.log('tray single-instance contract tests passed');
