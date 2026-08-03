import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(projectRoot, 'src', 'web', 'public', 'js', 'app.js'), 'utf8');

const permissionStart = source.indexOf('function browserClipboardWritePermissionState()');
const permissionEnd = source.indexOf('function modernTextClipboardSupported()', permissionStart);
assert.ok(permissionStart >= 0 && permissionEnd > permissionStart, 'clipboard-write permission preflight must remain available');
const permissionSource = source.slice(permissionStart, permissionEnd);

assert.ok(permissionSource.includes("navigator.permissions.query({ name: 'clipboard-write' })"), 'preflight must inspect existing clipboard-write permission');
assert.ok(permissionSource.includes("return state === 'denied'"), 'only an explicit denied state may block browser clipboard writes');
assert.ok(permissionSource.includes("['granted', 'prompt', 'denied'].includes"), 'granted, prompt, and denied states must be normalized explicitly');
assert.ok(permissionSource.includes('BROWSER_CLIPBOARD_PERMISSION_UPDATED_EVENT'), 'permission changes must notify visible copy controls');
assert.ok(source.includes("window.addEventListener('focus', refreshPermission)"), 'returning to the window must refresh cached clipboard permission');
assert.ok(source.includes("document.addEventListener('visibilitychange', onVisibilityChange)"), 'returning to a visible tab must refresh cached clipboard permission');

for (const functionName of ['modernTextClipboardSupported', 'deferredBrowserTextClipboardSupported', 'browserImageClipboardSupported']) {
  const start = source.indexOf(`function ${functionName}(`);
  const end = source.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, `${functionName} must remain available`);
  assert.ok(source.slice(start, end).includes('browserClipboardWritePermissionDenied()'), `${functionName} must reject an explicitly denied browser write permission`);
}

assert.ok(source.includes('browser_permission_denied: browserClipboardWritePermissionDenied()'), 'image clipboard capability snapshots must expose a denied browser channel');
assert.ok(source.includes('浏览器已明确拒绝图片剪贴板权限'), 'disabled image copy controls must explain an explicit permission denial');
assert.ok(source.includes('removeHistoryClipboardPermissionListener'), 'open history modals must resync copy actions after permission changes');
assert.ok(source.includes('const unsupported = systemOnlyTooLarge || noKnownClipboard'), 'text copy must disable when every clipboard path is confirmed unavailable, while retryable unknown system capability remains enabled');
assert.ok(source.includes('function textClipboardCapabilityState()'), 'text clipboard support must distinguish confirmed, retryable, and unavailable states');
assert.ok(source.includes("return localCapabilityRetryable(detail) ? 'retryable' : 'unavailable'"), 'unknown local clipboard capability must remain retryable');
assert.ok(source.includes('function textClipboardActionLabel(label = \'复制\')'), 'copy controls must share an honest retryable-state label');
assert.ok(source.includes('return textClipboardNeedsCheck() ? `检查后${label}` : label'), 'retryable copy controls must say that capability will be checked first');

function namedFunctionBlock(functionName) {
  const declaration = `function ${functionName}(`;
  let start = source.indexOf(declaration);
  if (start >= 0) {
    const end = source.indexOf('\n}', start);
    return end > start ? source.slice(start, end) : '';
  }
  start = source.indexOf(`const ${functionName} =`);
  if (start < 0) return '';
  const end = source.indexOf('\n  };', start);
  return end > start ? source.slice(start, end) : '';
}

for (const functionName of [
  'syncTextPreviewCopyButton',
  'syncTextPreviewCopyPathButton',
  'syncMarkdownBodyCopyAction',
  'syncHistorySavedPngFileActions',
  'syncHistoryMarkdownButtons',
]) {
  const block = namedFunctionBlock(functionName);
  assert.ok(block, `${functionName} must remain available`);
  assert.ok(block.includes('textClipboardActionLabel('), `${functionName} must expose retryable clipboard preflight in its visible label`);
}

console.log('browser clipboard-write permission contract passed');
