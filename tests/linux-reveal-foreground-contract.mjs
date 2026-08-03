import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const mainSource = fs.readFileSync(path.join(projectRoot, 'src', 'main.js'), 'utf8');
const appSource = fs.readFileSync(path.join(projectRoot, 'src', 'web', 'public', 'js', 'app.js'), 'utf8');

const capabilitySource = mainSource.slice(
  mainSource.indexOf('async function probeLocalActionCapabilitySnapshot'),
  mainSource.indexOf('async function localActionCapabilitySnapshot'),
);
const revealSource = mainSource.slice(
  mainSource.indexOf('async function revealInFolder('),
  mainSource.indexOf('function legacyRevealInFolderWindows'),
);
const labelSource = appSource.slice(
  appSource.indexOf('function localRevealButtonLabel'),
  appSource.indexOf('function browserClipboardPngTooLargeError'),
);

assert.ok(capabilitySource.includes('foreground_requested: platform === \'darwin\''), 'Linux reveal capability must not claim that foreground activation was requested');
assert.ok(revealSource.includes("platform: 'linux'") && revealSource.includes('foreground_requested: false'), 'Linux FileManager1 results must preserve the no-foreground-request evidence');
assert.ok(appSource.includes('function localFileManagerMayStayInBackground('), 'the UI must expose Linux foreground limitations before the click');
assert.ok(labelSource.includes("return md ? '在文件管理器中定位 MD' : '在文件管理器中定位'"), 'Linux reveal buttons must describe locating instead of implying foreground display');
assert.ok(labelSource.includes('桌面环境可能让文件管理器留在后台'), 'supported Linux reveal controls must explain the foreground limitation in their tooltip');
assert.ok((appSource.match(/localRevealReadyTitle\(/g) || []).length >= 6, 'the foreground limitation must reach digest, text, batch, and history reveal tooltips');
assert.ok(appSource.includes('桌面环境未提供可靠的窗口置前确认'), 'post-action Linux status must continue to avoid claiming foreground success');

console.log('Linux reveal foreground contract passed');
