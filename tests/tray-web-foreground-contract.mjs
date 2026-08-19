import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const source = await fsp.readFile(new URL('../src/tray/wx-summary-tray.ps1', import.meta.url), 'utf8');
const helper = await fsp.readFile(new URL('../src/tray/open-web-foreground.ps1', import.meta.url), 'utf8');
const openStart = source.indexOf('function Open-Web {');
const openEnd = source.indexOf('\nfunction RuntimeInfo-MatchesProject', openStart);
assert.ok(openStart >= 0 && openEnd > openStart, 'tray Open-Web source must remain available');
const openSource = source.slice(openStart, openEnd);

assert.match(source, /function New-WebFocusToken/, 'each tray open must create a unique foreground binding');
assert.match(source, /function Start-WebOpenHelper/, 'tray web launch must delegate bounded waiting to a hidden helper');
assert.match(source, /\$WebOpenHelperProcess = \$null/, 'tray must retain the active web-open helper so repeated clicks cannot spawn competing foreground attempts');
assert.match(
  openSource,
  /\$script:WebOpenHelperProcess[\s\S]*?\.Refresh\(\)[\s\S]*?\.HasExited[\s\S]*?Try-AttachExistingServer[\s\S]*?Read-ServerUrl/,
  'Open-Web must suppress duplicate helpers and verify a healthy current-version service before trusting server.json',
);
assert.match(openSource, /New-WebFocusToken[\s\S]*?Start-WebOpenHelper/, 'Open-Web must bind the launch URL and helper to the same focus token');
assert.match(openSource, /\$script:WebOpenHelperProcess = Start-WebOpenHelper/, 'Open-Web must track the helper process it starts');
assert.doesNotMatch(openSource, /WaitForExit|Start-Sleep|Focus-WebWindow/, 'the WinForms event path must not synchronously wait for a URL handler or browser window');
assert.match(helper, /FocusToken/, 'the helper must require the per-launch focus token');
assert.match(helper, /function Project-WebOpenMutexName/, 'web-open helpers must share a project-scoped cross-process identity');
assert.match(helper, /System\.Threading\.Mutex/, 'web-open helpers must serialize across tray processes');
assert.match(
  helper,
  /WaitOne\(0\)[\s\S]*?if \(-not \$webOpenMutexOwned\) \{ exit 0 \}[\s\S]*?Start-UrlHandler/,
  'a competing helper must exit before invoking any URL handler',
);
assert.match(
  helper,
  /finally\s*\{[\s\S]*?ReleaseMutex\(\)[\s\S]*?Dispose\(\)/,
  'the winning helper must release and dispose the project web-open mutex on every exit path',
);
assert.match(helper, /FindExact/, 'the helper must select the exact tokenized browser title instead of the first generic wx-summary window');
assert.match(helper, /SetWindowPos/, 'foreground activation must use a temporary topmost nudge when normal activation is denied');
assert.match(helper, /return GetForegroundWindow\(\) == hWnd;/, 'foreground success must be based on the final foreground HWND');
assert.doesNotMatch(helper, /GetForegroundWindow\(\) == hWnd \|\| activated/, 'an earlier SetForegroundWindow return value must not mask later focus loss');

console.log('tray web foreground contract tests passed');
