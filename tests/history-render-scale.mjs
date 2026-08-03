import assert from 'node:assert/strict';
import fs from 'node:fs';

const appJs = fs.readFileSync(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const appCss = fs.readFileSync(new URL('../src/web/public/css/app.css', import.meta.url), 'utf8');

assert.ok(
  appJs.includes('const HISTORY_VIEW_STORAGE_MAX_LOADED_ITEMS = 500;'),
  'same-tab history restoration must not automatically rebuild thousands of cards',
);

const historyItemCss = appCss.slice(
  appCss.indexOf('.history-item {'),
  appCss.indexOf('.history-item:hover'),
);
assert.ok(
  historyItemCss.includes('content-visibility: auto;')
    && historyItemCss.includes('contain-intrinsic-size: auto 560px;'),
  'offscreen history cards must skip paint/layout work while retaining a stable estimated height',
);
assert.ok(
  appCss.includes('.history-grid.history-paging-layout-stable .history-item {')
    && appCss.includes('content-visibility: visible;')
    && appJs.includes("$grid.classList.toggle('history-paging-layout-stable', !pagingGate.hidden)"),
  'history paging must resolve current card heights before exposing a clickable load-more target',
);
assert.match(
  appCss,
  /\.history-grid \{[\s\S]{0,240}?align-items: start;/,
  'mixed PNG and Markdown history cards must keep their natural heights instead of stretching every card to the tallest item in its grid row',
);

console.log('history render scale tests passed');
