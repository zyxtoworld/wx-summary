import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const mainSource = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

function extractFunction(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing production function: ${marker}`);
  const body = /\)\s*\{/.exec(source.slice(start));
  assert.ok(body, `missing function body: ${marker}`);
  const open = start + body.index + body[0].lastIndexOf('{');
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated production function: ${marker}`);
}

const unverifiedKeysSource = extractFunction(mainSource, 'function schedulerUnverifiedLegacyCursorKeys(');
const tokenSource = extractFunction(mainSource, 'function schedulerLegacyCursorCleanupToken(');
const cleanupSource = extractFunction(mainSource, 'async function clearUnverifiedLegacySchedulerCursors(');

const schedulerUnverifiedLegacyCursorKeys = new Function(
  `${unverifiedKeysSource}; return schedulerUnverifiedLegacyCursorKeys;`,
)();
const schedulerLegacyCursorCleanupToken = new Function(
  'crypto',
  'stableJson',
  'schedulerUnverifiedLegacyCursorKeys',
  `${tokenSource}; return schedulerLegacyCursorCleanupToken;`,
)(
  await import('node:crypto'),
  value => value,
  schedulerUnverifiedLegacyCursorKeys,
);

const statusA = {
  last_started_at: '2026-08-19T01:00:00.000Z',
  last_finished_at: '2026-08-19T01:01:00.000Z',
  last_result_revision: 1,
  last_result: {
    items: [
      { legacy_cursor_unverified: true, legacy_cursor_key: 'group-a@chatroom', detail: 'a' },
      { legacy_cursor_unverified: true, legacy_cursor_key: 'group-b@chatroom', detail: 'b' },
    ],
  },
};
const statusB = structuredClone(statusA);
statusB.last_result_revision = 2;
let expectedTokenForRun = schedulerLegacyCursorCleanupToken(statusA);
let currentStatus = statusA;
let switchToStatusB = true;
const clearedKeys = [];

const clearUnverifiedLegacySchedulerCursors = new Function(
  'getSchedulerStatus',
  'schedulerUnverifiedLegacyCursorKeys',
  'schedulerLegacyCursorCleanupToken',
  'assertSchedulerLegacyCursorCleanupToken',
  'requestSignalAborted',
  'requestAbortError',
  'clearGroupCursor',
  'markSchedulerLegacyCursorsCleared',
  'sanitizeText',
  'publicSchedulerErrorSummary',
  `${cleanupSource}; return clearUnverifiedLegacySchedulerCursors;`,
)(
  () => currentStatus,
  schedulerUnverifiedLegacyCursorKeys,
  schedulerLegacyCursorCleanupToken,
  (expected, status) => {
    if (expected !== expectedTokenForRun || schedulerLegacyCursorCleanupToken(status) !== expectedTokenForRun) {
      throw Object.assign(new Error('token changed'), {
        status: 409,
        code: 'scheduler_legacy_cursor_cleanup_token_changed',
      });
    }
  },
  () => false,
  message => new Error(message),
  async key => {
    clearedKeys.push(key);
    if (switchToStatusB && key === 'group-a@chatroom') currentStatus = statusB;
    return true;
  },
  keys => {
    clearedKeys.push(...keys.map(key => `marked:${key}`));
    for (const item of currentStatus.last_result.items) {
      if (keys.includes(item.legacy_cursor_key)) item.legacy_cursor_unverified = false;
    }
  },
  value => String(value || ''),
  value => String(value || ''),
);

const result = await clearUnverifiedLegacySchedulerCursors({
  statusSnapshot: statusA,
  expectedCleanupToken: expectedTokenForRun,
});

assert.deepEqual(
  clearedKeys,
  ['group-a@chatroom'],
  'a status/token change after one deletion must stop the old cleanup before it deletes the next cursor',
);
assert.equal(result.cancelled_after_commit, true, 'a mid-operation status change must be reported as a post-commit stop');
assert.equal(result.local_action_after_commit_reason, 'cleanup_token_changed', 'a replacement result must be reported as a stale post-commit owner');
assert.equal(result.cleared, 1, 'the response must report only the cursor committed before the token changed');
const replacementA = statusB.last_result.items.find(item => item.legacy_cursor_key === 'group-a@chatroom');
assert.equal(replacementA?.legacy_cursor_unverified, true, 'an old cleanup must not mark the replacement result for the same cursor key');
assert.equal(replacementA?.detail, 'a', 'an old cleanup must not rewrite replacement result detail');

// The cleanup itself changes the completed items in the live status.  That
// self-progress must not invalidate the remaining-token comparison.
currentStatus = structuredClone(statusA);
switchToStatusB = false;
expectedTokenForRun = schedulerLegacyCursorCleanupToken(currentStatus);
clearedKeys.length = 0;
const completed = await clearUnverifiedLegacySchedulerCursors({
  statusSnapshot: currentStatus,
  expectedCleanupToken: expectedTokenForRun,
});
assert.equal(completed.ok, true, 'a stable status must allow every target cursor to be cleared');
assert.equal(completed.cleared, 2, 'stable cleanup should commit both target cursors');
assert.deepEqual(
  clearedKeys,
  ['group-a@chatroom', 'marked:group-a@chatroom', 'group-b@chatroom', 'marked:group-b@chatroom'],
  'the owner check must tolerate only the cleanup action’s own completed-item mutations',
);

console.log('scheduler clear legacy cursor owner test passed');
