import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const app = await fs.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const html = await fs.readFile(new URL('../src/web/views/index.html', import.meta.url), 'utf8');
const css = await fs.readFile(new URL('../src/web/public/css/app.css', import.meta.url), 'utf8');

function sliceBetween(startText, endText) {
  const start = app.indexOf(startText);
  const end = app.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, `${startText} source must remain available`);
  return app.slice(start, end);
}

assert.match(html, /id="group-list-inline-status"[^>]*role="status"/,
  'digest sidebar must reserve a dedicated visible status row for mirror/group-list progress and warnings');
assert.match(css, /\.sidebar-group-status\s*\{/,
  'the dedicated sidebar status row must have a stable layout of its own');

const initialLoadingSource = sliceBetween(
  'const setInitialGroupLoadingText =',
  '\n  let initialGroupServerProgressSeen',
);
assert.doesNotMatch(initialLoadingSource, /selectedCount\.textContent = `[^`]*\$\{clean/,
  'initial group progress must not be duplicated into the compact selection/action footer');

const setStatusSource = sliceBetween('function setGroupStatus(', '\n  function paint(');
assert.match(setStatusSource, /document\.getElementById\('group-list-inline-status'\)/,
  'group progress and warnings must paint the dedicated visible status row');

const selectedCountSource = sliceBetween('function updateSelectedCount(', '\n  const whitelistButton');
assert.doesNotMatch(selectedCountSource, /groupStatusText|groupStatusTitleText/,
  'the selection footer must remain selection-only so its action buttons cannot be squeezed by long status text');

console.log('digest sidebar status layout contract tests passed');
