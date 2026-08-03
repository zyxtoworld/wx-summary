import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const app = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const css = await fsp.readFile(new URL('../src/web/public/css/app.css', import.meta.url), 'utf8');

const globalActivityStart = app.indexOf('function updateGlobalDigestActivity(');
const globalActivityEnd = app.indexOf('\nfunction setGlobalDigestActivityNotice(', globalActivityStart);
const globalActivitySource = app.slice(globalActivityStart, globalActivityEnd);
assert.match(
  globalActivitySource,
  /const focusWasInside = !visible && bar\.contains\(document\.activeElement\);[\s\S]*?if \(focusWasInside\)[\s\S]*?focusRouteHeading\(\)/,
  'hiding the global digest activity bar must restore keyboard focus to the active route',
);

const deleteStart = app.indexOf('async function deleteHistoryCardItem(');
const deleteEnd = app.indexOf('\n  async function loadHistoryPage(', deleteStart);
const deleteSource = app.slice(deleteStart, deleteEnd);
assert.ok(deleteStart >= 0 && deleteEnd > deleteStart, 'history deletion source must be inspectable');
assert.match(deleteSource, /历史记录和不再被引用的本地文件已删除。[\s\S]*?announceHistoryStatus\(/, 'successful history deletion must reach the existing live region');
assert.match(deleteSource, /删除失败：[\s\S]*?announceHistoryStatus\(/, 'ordinary history deletion failures must reach the existing live region');

assert.match(
  app,
  /data-md-content-status role="note"/,
  'Markdown body progress must remain visible without creating a second live region',
);
assert.match(
  app,
  /data-status role="status" aria-live="polite"/,
  'Markdown terminal actions must retain one concise polite live region',
);

assert.match(
  css,
  /@media[^{}]*max-width:\s*640px[\s\S]*?button\.link-btn\s*\{[\s\S]*?min-height:\s*44px;[\s\S]*?min-width:\s*44px;/,
  'mobile action-style link buttons must expose a stable 44px touch target',
);

console.log('frontend live-status and touch-target contracts passed');
