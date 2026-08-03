import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const outputSource = await fsp.readFile(new URL('../src/renderer/output.js', import.meta.url), 'utf8');
const appSource = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');

const deleteStart = outputSource.indexOf('export async function deleteHistoryItem(');
const deleteEnd = outputSource.indexOf('\nexport async function findHistoryItem(', deleteStart);
assert.ok(deleteStart >= 0 && deleteEnd > deleteStart, 'history delete implementation must remain available');
const deleteSource = outputSource.slice(deleteStart, deleteEnd);
assert.match(
  deleteSource,
  /history_delete_commit_unknown[\s\S]*?mutation_outcome_unknown:\s*observed\s*!==\s*false/,
  'an indeterminate history index commit must be marked as an unknown mutation outcome',
);

const uiStart = appSource.indexOf('async function deleteHistoryCardItem(');
const uiEnd = appSource.indexOf('\n  $grid.addEventListener(\'click\'', uiStart);
assert.ok(uiStart >= 0 && uiEnd > uiStart, 'history delete UI implementation must remain available');
const uiSource = appSource.slice(uiStart, uiEnd);
const lockIndex = uiSource.indexOf('historyDeletePendingKeys.add(itemKey)');
const confirmIndex = uiSource.indexOf('await showAppConfirmDialog({');
assert.ok(lockIndex >= 0 && confirmIndex >= 0 && lockIndex < confirmIndex, 'the history item must be locked before opening its confirmation dialog');
assert.equal((uiSource.match(/historyDeletePendingKeys\.add\(itemKey\)/g) || []).length, 1, 'one delete flow must acquire the item lock only once');
assert.match(uiSource, /if \(!confirmed \|\| !historyPageActive\(\)\) \{[\s\S]*?historyDeletePendingKeys\.delete\(itemKey\);[\s\S]*?return;/, 'cancelled or stale confirmations must release the pre-confirmation lock');
assert.match(appSource, /const historyDeletedItemKeys = new Set\(\);[\s\S]*?function commitDeletedHistoryItem\(/, 'confirmed deletions must have a page-local tombstone and immediate local commit helper');
assert.match(appSource, /function historyResponseWithoutDeletedItems\([\s\S]*?historyDeletedItemKeys\.has\(historyItemStableKey\(item\)\)/, 'late or cached history responses must filter confirmed deletion tombstones');
assert.match(uiSource, /const deleteLoadedTargetCount = Math\.max\(HISTORY_PAGE_SIZE, _state_history\.items\.length\)[\s\S]*?historyDeleteResponseMatchesRequest[\s\S]*?commitDeletedHistoryItem\(itemKey, item, card\)[\s\S]*?refreshLoadedHistoryWindow\(\{[\s\S]*?targetCount: deleteLoadedTargetCount/, 'a successful delete must remove the row before refresh and refill to the pre-delete paging depth');

console.log('history delete outcome tests passed');
