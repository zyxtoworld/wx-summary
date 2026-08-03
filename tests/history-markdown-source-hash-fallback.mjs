import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { OUTPUTS_DIR, toProjectRelative } from '../src/lib/paths.js';

const testRoot = path.join(OUTPUTS_DIR, `history-md-source-hash-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE = testRoot;
process.env.WX_SUMMARY_INCLUDE_ACCEPTANCE_HISTORY_FIXTURE_ROOTS = testRoot;

const {
  historyItemKeyForItem,
  listHistory,
  outputFileVersion,
  savePreviewMarkdown,
  saveRenderedPng,
} = await import('../src/renderer/output.js');

const settings = {
  settings_revision: 'history-md-source-hash-v1',
  export_policy_revision: 'history-md-source-hash-v1',
  output: { dir: `./${toProjectRelative(testRoot)}` },
};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const marker = `source-hash-fallback-${crypto.randomUUID()}`;

try {
  const source = await saveRenderedPng({
    settings,
    digest: {
      digest_id: `source-${crypto.randomUUID()}`,
      group: '来源哈希回退测试群',
      since: '2026-07-28 10:00:00',
      until: '2026-07-28 11:00:00',
      message_count: 1,
      model: 'test-model',
      headline: '来源文件保持不变',
      highlights: ['来源哈希回退测试'],
      topics: [],
      created_at: '2026-07-28T03:00:00.000Z',
    },
    png_buffer: png,
    save_operation_id: `save-${crypto.randomUUID()}`,
  });
  const sourceKey = historyItemKeyForItem(testRoot, source);
  const sourcePngVersion = await outputFileVersion(source.file_path);
  const sourceDigestVersion = await outputFileVersion(source.digest_path);
  assert.match(sourceDigestVersion, /^v2:/, 'the fallback contract requires a content-bound v2 source digest version');

  const markdown = await savePreviewMarkdown({
    settings,
    title: '来源哈希回退测试',
    markdown: `# 来源哈希回退测试\n\n${marker}\n`,
    history: true,
    metadata: {
      group: source.group,
      search_text: marker,
      source_digest_id: source.digest_id,
      source_history_item_key: sourceKey,
      source_expected_file_version: sourcePngVersion,
      source_expected_digest_file_version: sourceDigestVersion,
      source_digest_revision: 'f'.repeat(64),
    },
  });

  const unchanged = await listHistory(settings, { offset: 0, limit: 10, query: marker, bypassCache: true });
  assert.equal(unchanged.items[0]?.digest_id, markdown.digest_id, 'the Markdown fixture should be discoverable');
  assert.notEqual(unchanged.items[0]?.source_stale, true, 'an unversioned semantic-revision mismatch must not override an exact v2 source-file hash match');

  const changedDigest = JSON.parse(await fsp.readFile(source.digest_path, 'utf8'));
  changedDigest.headline = '来源文件真实发生变化';
  await fsp.writeFile(source.digest_path, `${JSON.stringify(changedDigest, null, 2)}\n`, 'utf8');

  const changed = await listHistory(settings, { offset: 0, limit: 10, query: marker, bypassCache: true });
  assert.equal(changed.items[0]?.source_stale, true, 'a semantic mismatch must remain visible as provenance drift once the strong source-file hash also changes');
} finally {
  await fsp.rm(testRoot, { recursive: true, force: true });
}

console.log('history Markdown source hash fallback passed');
