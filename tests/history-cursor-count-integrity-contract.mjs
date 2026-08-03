import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../src/renderer/output.js', import.meta.url), 'utf8');
const collectStart = source.indexOf('async function collectHistoryFilteredPage(');
const collectEnd = source.indexOf('\nfunction historyCursorStaleError(', collectStart);
const encodeStart = source.indexOf('function encodeHistoryPageCursor(');
const decodeEnd = source.indexOf('\nfunction historyMarkdownSourceChangedItem(', encodeStart);
assert.ok(collectStart >= 0 && collectEnd > collectStart && encodeStart >= 0 && decodeEnd > encodeStart);
const collectSource = source.slice(collectStart, collectEnd);
const cursorSource = source.slice(encodeStart, decodeEnd);
const checkpointSource = source.slice(
  source.indexOf('function historyPageCheckpointForCursor('),
  source.indexOf('async function historyStatusPathDependency('),
);

assert.doesNotMatch(cursorSource, /counts\s*=|visible:\s*Math\.max\(0, Number\(counts|parsed\.visible|parsed\.scanned|parsed\.ok|parsed\.issues/);
assert.match(cursorSource, /v:\s*7/);
assert.match(cursorSource, /checkpoint:\s*String\(checkpoint/);
assert.doesNotMatch(collectSource, /afterCursor\?\.(visible|scanned|ok|issues)/);
assert.match(collectSource, /visibleBeforeCursor/);
assert.match(collectSource, /continuationCheckpoint\.scanned_total/);
assert.match(collectSource, /validateHistoryPageCheckpointPrefix/);
assert.match(checkpointSource, /historyPageCheckpoints\.get\(token\)/);
assert.match(checkpointSource, /checkpoint\.status_revision/);

console.log('history cursor count integrity contract tests passed');
