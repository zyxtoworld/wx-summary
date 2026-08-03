import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const appSource = fs.readFileSync(path.join(projectRoot, 'src', 'web', 'public', 'js', 'app.js'), 'utf8');

const permissionSource = appSource.slice(
  appSource.indexOf('function browserClipboardReadbackNotPreauthorizedError'),
  appSource.indexOf('function observeLateTextClipboardCompletion'),
);
const previewWriteSource = appSource.slice(
  appSource.indexOf('async function writeTextPreviewMarkdownClipboard'),
  appSource.indexOf('function deferredBrowserTextClipboardSupported'),
);
const deferredWriteSource = appSource.slice(
  appSource.indexOf('function beginDeferredBrowserTextClipboardWrite'),
  appSource.indexOf('async function writeTextClipboard'),
);

assert.ok(permissionSource.includes("navigator.permissions.query({ name: 'clipboard-read' })"), 'browser readback should inspect the existing clipboard-read permission without requesting it');
assert.ok(permissionSource.includes('waitForBrowserClipboardOperation('), 'clipboard-read permission inspection must use the same bounded browser-operation wrapper as readback');
assert.ok(permissionSource.includes("action: '检查浏览器剪贴板读取权限'"), 'clipboard-read permission timeout diagnostics should identify the permission check');
assert.ok(permissionSource.includes("permissionError?.name === 'AbortError'"), 'route cancellation during clipboard permission inspection must propagate instead of being misreported as an unsupported permission API');
assert.ok(permissionSource.includes("permission?.state !== 'granted'"), 'prompt, denied, and unknown permission states must skip clipboard reads');
assert.ok(permissionSource.includes('BROWSER_CLIPBOARD_READBACK_NOT_PREAUTHORIZED'), 'skipped readback should have a distinct non-failure reason for user feedback');
assert.equal((appSource.match(/navigator\.clipboard\.readText\(\)/g) || []).length, 1, 'all browser text readback must pass through the permission-gated helper');
assert.ok(previewWriteSource.includes('readBrowserTextClipboardIfAlreadyPermitted({ signal })'), 'direct browser text writes should use permission-gated readback');
assert.ok(deferredWriteSource.includes('readBrowserTextClipboardIfAlreadyPermitted({ signal })'), 'deferred browser text writes should use permission-gated readback');
assert.ok(appSource.includes('未主动申请额外的剪贴板读取权限'), 'copy feedback should explain why accepted writes were not read back');

console.log('text clipboard readback permission contract passed');
