import assert from 'node:assert/strict';
import fs from 'node:fs';

const appSource = fs.readFileSync(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');

const missingStart = appSource.indexOf('const markHistoryFileMissing =');
const missingEnd = appSource.indexOf('const markHistoryFileStale =', missingStart);
assert.ok(missingStart >= 0 && missingEnd > missingStart, 'history PNG missing recovery should exist');

const missingSource = appSource.slice(missingStart, missingEnd);
const item = { file_exists: true };
const calls = [];
const status = { className: '', textContent: '' };
const makeMissingHandler = new Function(
  'invalidateHistoryRerenderTarget',
  'item',
  'updateHistoryCardItem',
  'releaseHistoryPreviewState',
  'historySavedImageBlob',
  'historySavedImageLoadSeq',
  'removeInvalidHistoryPreviewImage',
  'paintModalArtifactNote',
  'disableImageActions',
  'status',
  'setHistoryRerenderAvailability',
  'notifyHistoryListNeedsReload',
  `${missingSource}; return markHistoryFileMissing;`,
);
const markMissing = makeMissingHandler(
  message => calls.push(['invalidate', message]),
  item,
  value => calls.push(['update', value.file_exists]),
  () => calls.push(['release']),
  {},
  'old',
  () => calls.push(['remove-image']),
  () => calls.push(['paint-note']),
  message => calls.push(['disable', message]),
  status,
  () => calls.push(['sync-rerender']),
  () => calls.push(['reload-list']),
);

assert.doesNotThrow(() => markMissing('PNG 已不存在'),
  'handling a missing PNG must not throw a second ReferenceError');
assert.equal(item.file_exists, false);
assert.deepEqual(calls[0], ['invalidate', 'PNG 已不存在']);
assert.equal(status.className, 'status warn');
assert.equal(status.textContent, 'PNG 已不存在');

const markdownModalSource = appSource.slice(
  appSource.indexOf('function showHistoryMarkdownModal'),
  appSource.indexOf('function showHistoryModal'),
);
const actionsStart = markdownModalSource.indexOf('<div class="preview-actions">');
const actionsEnd = markdownModalSource.indexOf('</div>\n    </div>`;', actionsStart);
const markdownActionsMarkup = markdownModalSource.slice(actionsStart, actionsEnd);
assert.ok(markdownActionsMarkup.indexOf('data-status') < markdownActionsMarkup.indexOf('data-download-md'),
  'Markdown action feedback must appear before the scrollable button list on short screens');
assert.ok(markdownModalSource.includes('const initialCopyPathDisabled = fileUnavailable || !textClipboardSupported()'),
  'Markdown copy-path should start disabled when text clipboard support is unavailable');

console.log('history modal error recovery tests passed');
