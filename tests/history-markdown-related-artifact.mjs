import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { OUTPUTS_DIR, toProjectRelative } from '../src/lib/paths.js';

const TEST_ROOT = path.join(OUTPUTS_DIR, `history-md-related-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
const BASE = path.join(TEST_ROOT, 'digests');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE = TEST_ROOT;
process.env.WX_SUMMARY_INCLUDE_ACCEPTANCE_HISTORY_FIXTURE_ROOTS = TEST_ROOT;

const {
  digestSemanticRevision,
  historyItemKeyForItem,
  listHistory,
  outputFileVersion,
  readHistoryDigest,
  savePreviewMarkdown,
  saveRenderedPng,
} = await import('../src/renderer/output.js');

const settings = {
  settings_revision: 'history-md-related-v1',
  export_policy_revision: 'history-md-related-v1',
  output: {
    dir: `./${toProjectRelative(BASE)}`,
    retention_days: 0,
  },
};

const [mainSource, appSource] = await Promise.all([
  fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8'),
]);
const publicOutputItemSource = mainSource.slice(
  mainSource.indexOf('function publicOutputItem('),
  mainSource.indexOf('function redactPreviewHistoryMetadata'),
);
assert.ok(publicOutputItemSource.includes('out.related_markdown_export = publicOutputItem(item.related_markdown_export)'), 'history API projection must expose only the public fields of a related Markdown item');
const normalizeHistoryResponseSource = appSource.slice(
  appSource.indexOf('function normalizeHistoryResponse('),
  appSource.indexOf('function historyResponseWithoutDeletedItems'),
);
assert.ok(appSource.includes('function restoreHistoryMarkdownExportTargetsFromItems(')
  && normalizeHistoryResponseSource.includes('restoreHistoryMarkdownExportTargetsFromItems(data.items)'),
'history reload must rebuild PNG-to-Markdown action targets from the API instead of relying only on process memory');

try {
  const source = await saveRenderedPng({
    settings,
    digest: {
      digest_id: 'history-md-related-source',
      group: '关联 MD 恢复测试群',
      since: '2026-07-01 00:00:00',
      until: '2026-07-01 01:00:00',
      message_count: 1,
      model: 'test-model',
      headline: '刷新后仍能找到导出的 MD',
      highlights: ['fixture'],
      topics: [],
      created_at: '2026-07-01T01:00:00.000Z',
    },
    png_buffer: PNG,
    save_operation_id: 'history-md-related-source-save',
  });
  const sourceDigest = await readHistoryDigest(settings, source.digest_id);
  const markdown = await savePreviewMarkdown({
    settings,
    title: '关联 MD 恢复测试',
    markdown: '# 关联 MD 恢复测试\n',
    history: true,
    metadata: {
      group: source.group,
      message_count: 1,
      source_digest_id: source.digest_id,
      source_history_item_key: historyItemKeyForItem(BASE, source),
      source_expected_file_version: await outputFileVersion(source.file_path),
      source_expected_digest_file_version: await outputFileVersion(source.digest_path),
      source_digest_revision: digestSemanticRevision(sourceDigest),
    },
  });

  const history = await listHistory(settings, {
    offset: 0,
    limit: 10,
    query: '关联 MD 恢复测试群',
    filter: 'all',
    bypassCache: true,
  });
  const restoredSource = history.items.find(item => item.digest_id === source.digest_id && item.artifact_type !== 'text_preview_md');
  assert.ok(restoredSource, 'source PNG must remain in the reloaded history page');
  assert.equal(restoredSource.related_markdown_export?.history_item_key, historyItemKeyForItem(BASE, markdown), 'source PNG must expose its latest valid related Markdown after a fresh history read');
  assert.equal(restoredSource.related_markdown_export?.file_readable, true, 'related Markdown must be versioned and readable before the API exposes it as an action target');
} finally {
  await fsp.rm(TEST_ROOT, { recursive: true, force: true });
}

console.log('history related Markdown artifact tests passed');
