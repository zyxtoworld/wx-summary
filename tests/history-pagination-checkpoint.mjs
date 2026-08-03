import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { OUTPUTS_DIR, toProjectRelative } from '../src/lib/paths.js';

const testRoot = path.join(OUTPUTS_DIR, `history-page-checkpoint-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE = testRoot;
process.env.WX_SUMMARY_INCLUDE_ACCEPTANCE_HISTORY_FIXTURE_ROOTS = testRoot;

const { listHistory, saveRenderedPng } = await import('../src/renderer/output.js');

const settings = {
  settings_revision: 'history-page-checkpoint-v1',
  export_policy_revision: 'history-page-checkpoint-v1',
  output: { dir: `./${toProjectRelative(testRoot)}` },
};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const originalOpen = fsp.open;

try {
  for (let index = 0; index < 8; index += 1) {
    await saveRenderedPng({
      settings,
      digest: {
        digest_id: `page-checkpoint-${index}`,
        group: '分页检查点测试群',
        since: '2026-07-31 00:00:00',
        until: '2026-07-31 01:00:00',
        message_count: 1,
        model: 'test-model',
        headline: `分页检查点测试 ${index}`,
        created_at: new Date(Date.UTC(2026, 6, 31, 8, 0, 0) - index * 60_000).toISOString(),
      },
      png_buffer: png,
      save_operation_id: `page-checkpoint-save-${index}-${crypto.randomUUID()}`,
    });
  }

  const first = await listHistory(settings, {
    limit: 3,
    query: '分页检查点测试群',
    filter: 'ok',
    bypassCache: true,
  });
  assert.equal(first.items.length, 3);
  assert.equal(first.has_more, true);
  const decodedCursor = JSON.parse(Buffer.from(first.next_cursor, 'base64url').toString('utf8'));
  assert.equal(decodedCursor.v, 7, 'history cursors should identify the server-side checkpoint format');
  assert.match(decodedCursor.checkpoint, /^[A-Za-z0-9_-]{20,}$/);

  const firstPageDigests = new Set(first.items.map(item => path.resolve(item.digest_path).toLowerCase()));
  let reopenedPrefixDigests = 0;
  fsp.open = async function countedHistoryOpen(file, ...args) {
    if (firstPageDigests.has(path.resolve(String(file)).toLowerCase())) reopenedPrefixDigests += 1;
    return originalOpen.call(this, file, ...args);
  };

  const second = await listHistory(settings, {
    cursor: first.next_cursor,
    limit: 3,
    query: '分页检查点测试群',
    filter: 'ok',
  });
  assert.equal(second.items.length, 3);
  assert.equal(reopenedPrefixDigests, 0, 'continuation should revalidate prefix metadata without reopening and reparsing prior digest JSON files');
} finally {
  fsp.open = originalOpen;
  await fsp.rm(testRoot, { recursive: true, force: true });
}

console.log('history pagination checkpoint tests passed');
