import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const mainSource = await fs.readFile(new URL('../src/main.js', import.meta.url), 'utf8');

const copyPathRouteStart = mainSource.indexOf("pathname === '/api/copy-path'");
const copyPathRouteEnd = mainSource.indexOf("pathname === '/api/copy-image'", copyPathRouteStart);
assert.ok(copyPathRouteStart >= 0 && copyPathRouteEnd > copyPathRouteStart,
  'copy-path backend route must remain available');
const copyPathRoute = mainSource.slice(copyPathRouteStart, copyPathRouteEnd);
const unavailableClipboardStart = copyPathRoute.indexOf('if (clipboardCapability?.supported !== true) {');
const unavailableClipboardEnd = copyPathRoute.indexOf("localActionLease = beginLocalAction(body, '复制文件路径')", unavailableClipboardStart);
assert.ok(unavailableClipboardStart >= 0 && unavailableClipboardEnd > unavailableClipboardStart,
  'copy-path backend must retain an explicit system-clipboard-unavailable branch');
const unavailableClipboardResponse = copyPathRoute.slice(unavailableClipboardStart, unavailableClipboardEnd);
assert.match(copyPathRoute, /const requestedLocalActionId = requireLocalActionId\(body, '复制文件路径'\)/,
  'copy-path must validate the requested action id before returning a non-committing capability response');
assert.match(unavailableClipboardResponse, /local_action_id: requestedLocalActionId/,
  'a non-committing system-clipboard response must echo the validated action id so the frontend can continue browser fallback');
assert.match(unavailableClipboardResponse, /local_action_committed: false/,
  'a system-clipboard capability miss must explicitly report that no local action committed');
assert.match(unavailableClipboardResponse, /clipboard_attempted: false/,
  'a system-clipboard capability miss must explicitly report that clipboard mutation was not attempted');

const historyDeleteStart = mainSource.indexOf("pathname === '/api/history-delete'");
const historyDeleteEnd = mainSource.indexOf("pathname.startsWith('/api/history-markdown-source/'", historyDeleteStart);
assert.ok(historyDeleteStart >= 0 && historyDeleteEnd > historyDeleteStart,
  'history-delete backend route must remain available');
const historyDeleteRoute = mainSource.slice(historyDeleteStart, historyDeleteEnd);
assert.match(historyDeleteRoute, /beginLocalAction\(body, '删除历史记录'\)/,
  'history-delete must reserve a local action lease before destructive work');
assert.ok(
  historyDeleteRoute.includes('local_action_id: localActionId')
    && historyDeleteRoute.includes('local_action_committed: true')
    && historyDeleteRoute.includes('verified: result?.deleted === true'),
  'confirmed history deletion must echo and verify the exact local action id',
);

console.log('local action response contract tests passed');
