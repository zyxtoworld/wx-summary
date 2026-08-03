import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const appSource = fs.readFileSync(path.join(projectRoot, 'src', 'web', 'public', 'js', 'app.js'), 'utf8');

const textPrepareSource = appSource.slice(
  appSource.indexOf('async function prepareTextClipboardActionForRetry'),
  appSource.indexOf('function observeLateTextClipboardCompletion'),
);
const textWriteSource = appSource.slice(
  appSource.indexOf('async function writeTextPreviewMarkdownClipboard'),
  appSource.indexOf('function deferredBrowserTextClipboardSupported'),
);
const textClickSource = appSource.slice(
  appSource.indexOf('async function copyTextPreviewMarkdown()'),
  appSource.indexOf('async function revealTextPreviewMarkdown()'),
);
const imageRefreshSource = appSource.slice(
  appSource.indexOf('async function refreshImageClipboardCapabilitiesAfterBrowserFailure'),
  appSource.indexOf('function imageClipboardUnsupportedMessage'),
);

assert.ok(textPrepareSource.includes('minimumReadyEntries = 1'), 'text clipboard preparation should support reserving independent fallback attempts');
assert.ok(textPrepareSource.includes('while (matching.length < required)'), 'text clipboard preparation should fill every required fallback reservation');
assert.ok(textWriteSource.includes('minimumReadyEntries: legacyTextClipboardSupported() ? 2 : 1'), 'the first modern text-copy click should also reserve a legacy fallback action');
assert.ok(textWriteSource.includes('discardPreparedTextClipboardEntries(text'), 'a successful modern write should settle the unused legacy reservation');
assert.ok(textWriteSource.includes('if (!allowSystemFallback) throw e;'), 'a prepared modern action must continue to legacy/system fallback on the first click when system fallback is allowed');
assert.ok(textWriteSource.includes('if (!allowSystemFallback) throw legacyError;'), 'a prepared legacy action must continue to system fallback on the first click when system fallback is allowed');

assert.ok(imageRefreshSource.includes('current.systemBusy || imageClipboardCanRefreshSystem({ ...current, browser: false })'), 'a failed browser image write should evaluate system refreshability independently from the still-present browser API');
assert.ok(imageRefreshSource.includes('if (current.system || !shouldRefreshSystem) return current;'), 'an already usable system clipboard should not be needlessly reprobed');

assert.ok(textClickSource.includes('正在实时检查浏览器和本机系统剪贴板能力...'), 'clicking an unknown text-copy capability should visibly run the promised live check');
assert.ok(textClickSource.indexOf('await refreshAppStateSilently({ refresh: true, signal: actionAbort.signal })') < textClickSource.indexOf("status.textContent = '当前环境不支持文本剪贴板，请改用“导出 MD”。'"), 'text copy should refresh system capability before reporting it unsupported');

console.log('clipboard fallback contract passed');
