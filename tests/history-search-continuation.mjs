import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { OUTPUTS_DIR, toProjectRelative } from '../src/lib/paths.js';

const testRoot = path.join(OUTPUTS_DIR, `history-search-continuation-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE = testRoot;
process.env.WX_SUMMARY_INCLUDE_ACCEPTANCE_HISTORY_FIXTURE_ROOTS = testRoot;

const { listHistory } = await import('../src/renderer/output.js');

const settings = {
  settings_revision: 'history-search-continuation-v1',
  export_policy_revision: 'history-search-continuation-v1',
  output: { dir: `./${toProjectRelative(testRoot)}` },
};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const tailToken = `tail-search-${crypto.randomUUID()}`;

try {
  await fsp.mkdir(testRoot, { recursive: true });
  const index = [];
  for (let itemIndex = 0; itemIndex < 65; itemIndex += 1) {
    const digestId = `search-candidate-${String(itemIndex).padStart(2, '0')}`;
    const filePath = path.join(testRoot, `${digestId}.png`);
    const digestPath = path.join(testRoot, `${digestId}.digest.json`);
    const createdAt = new Date(Date.UTC(2026, 6, 31, 7, 0, 0) - itemIndex * 60_000).toISOString();
    await fsp.writeFile(filePath, png);
    await fsp.writeFile(digestPath, JSON.stringify({
      digest_id: digestId,
      group: `全文续扫测试群 ${itemIndex}`,
      created_at: createdAt,
      message_count: 1,
      headline: `普通正文 ${itemIndex}`,
      highlights: itemIndex === 64 ? [`只有最后候选包含 ${tailToken}`] : [],
    }));
    index.push({
      digest_id: digestId,
      group: `全文续扫测试群 ${itemIndex}`,
      file_path: filePath,
      digest_path: digestPath,
      created_at: createdAt,
      message_count: 1,
      search_text: 'x'.repeat(6000),
      search_text_version: 3,
    });
  }
  await fsp.writeFile(path.join(testRoot, 'index.json'), JSON.stringify(index), 'utf8');

  const first = await listHistory(settings, {
    limit: 10,
    query: tailToken,
    filter: 'all',
    bypassCache: true,
    readOnly: true,
  });
  assert.deepEqual(first.items, []);
  assert.equal(first.search_scan_has_more, true, 'a bounded search pass should expose a resumable continuation instead of silently skipping later candidates');
  assert.match(first.next_search_cursor, /^[A-Za-z0-9_-]{20,}$/);
  assert.equal(first.search_scan_checked, 64);
  assert.equal(first.search_scan_total, 65);

  const second = await listHistory(settings, {
    limit: 10,
    query: tailToken,
    filter: 'all',
    searchCursor: first.next_search_cursor,
    readOnly: true,
  });
  assert.equal(second.search_scan_has_more, false);
  assert.equal(second.next_search_cursor, '');
  assert.deepEqual(second.items.map(item => item.digest_id), ['search-candidate-64'], 'the next bounded pass must continue after candidate 64 and find a tail-only match');
  assert.ok(!second.incomplete_reasons.includes('history_search_fallback_budget_exhausted'));
} finally {
  await fsp.rm(testRoot, { recursive: true, force: true });
}

console.log('history search continuation tests passed');
