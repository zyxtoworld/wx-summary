import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { OUTPUTS_DIR, toProjectRelative } from '../src/lib/paths.js';

const testRoot = path.join(OUTPUTS_DIR, `history-md-source-boundary-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE = testRoot;
process.env.WX_SUMMARY_INCLUDE_ACCEPTANCE_HISTORY_FIXTURE_ROOTS = testRoot;

const {
  bindPreviewMarkdownSourceMetadata,
  historyItemKeyForItem,
  listHistory,
  outputFileVersion,
  savePreviewMarkdown,
  saveRenderedPng,
} = await import('../src/renderer/output.js');
const {
  mdFileActionCheck,
  markdownSourceCheck,
} = await import('../src/web/public/js/pages/history/format.js');

const settings = {
  settings_revision: 'history-md-source-boundary-v1',
  export_policy_revision: 'history-md-source-boundary-v1',
  output: { dir: `./${toProjectRelative(testRoot)}` },
};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const marker = `source-state-boundary-${crypto.randomUUID()}`;

try {
  const source = await saveRenderedPng({
    settings,
    digest: {
      digest_id: `source-${crypto.randomUUID()}`,
      group: '来源状态边界测试群',
      since: '2026-07-29 02:00:00',
      until: '2026-07-29 03:00:00',
      message_count: 1,
      model: 'test-model',
      headline: '导出时来源内容',
      highlights: ['来源状态边界'],
      topics: [],
      created_at: '2026-07-28T19:00:00.000Z',
    },
    png_buffer: png,
    save_operation_id: `save-${crypto.randomUUID()}`,
  });
  const sourceKey = historyItemKeyForItem(testRoot, source);
  const sourcePngVersion = await outputFileVersion(source.file_path);
  const sourceDigestVersion = await outputFileVersion(source.digest_path);

  assert.throws(
    () => bindPreviewMarkdownSourceMetadata({
      source_digest_id: 'forged-source',
      source_history_item_key: sourceKey,
      source_expected_file_version: sourcePngVersion,
      source_expected_digest_file_version: sourceDigestVersion,
    }, {
      item: {
        ...source,
        history_item_key: sourceKey,
        file_version: sourcePngVersion,
      },
      digest_file_version: sourceDigestVersion,
      digest_revision: 'verified-revision',
    }),
    error => error?.code === 'history_md_source_metadata_mismatch'
      && error?.field === 'source_digest_id',
    'a Markdown export must reject client metadata that points at a different source than the verified history source',
  );
  assert.throws(
    () => bindPreviewMarkdownSourceMetadata({ source_digest_revision: 'forged-revision' }, {
      item: {
        ...source,
        history_item_key: sourceKey,
        file_version: sourcePngVersion,
      },
      digest_file_version: sourceDigestVersion,
      digest_revision: 'verified-revision',
    }),
    error => error?.code === 'history_md_source_metadata_mismatch'
      && error?.field === 'source_digest_revision',
    'a client-supplied source revision must not replace the revision computed from the verified digest',
  );
  const boundSourceMetadata = bindPreviewMarkdownSourceMetadata({
    group: source.group,
    source_expected_file_version: 'client-png-version-is-not-authoritative',
  }, {
    item: {
      ...source,
      history_item_key: sourceKey,
      file_version: sourcePngVersion,
    },
    digest_file_version: sourceDigestVersion,
    digest_revision: 'verified-revision',
  });
  assert.deepEqual({
    source_digest_id: boundSourceMetadata.source_digest_id,
    source_history_item_key: boundSourceMetadata.source_history_item_key,
    source_expected_file_version: boundSourceMetadata.source_expected_file_version,
    source_expected_digest_file_version: boundSourceMetadata.source_expected_digest_file_version,
    source_digest_revision: boundSourceMetadata.source_digest_revision,
  }, {
    source_digest_id: source.digest_id,
    source_history_item_key: sourceKey,
    source_expected_file_version: sourcePngVersion,
    source_expected_digest_file_version: sourceDigestVersion,
    source_digest_revision: 'verified-revision',
  }, 'persisted Markdown provenance must be derived from the verified source item, while an unrelated client PNG version cannot redirect or block digest-JSON export');

  const markdown = await savePreviewMarkdown({
    settings,
    title: '来源状态边界测试',
    markdown: `# 来源状态边界测试\n\n${marker}\n`,
    history: true,
    metadata: {
      group: source.group,
      search_text: marker,
      source_digest_id: source.digest_id,
      source_history_item_key: sourceKey,
      source_expected_file_version: sourcePngVersion,
      source_expected_digest_file_version: sourceDigestVersion,
    },
  });

  const changedDigest = JSON.parse(await fsp.readFile(source.digest_path, 'utf8'));
  changedDigest.headline = '导出后来源内容已变化';
  await fsp.writeFile(source.digest_path, `${JSON.stringify(changedDigest, null, 2)}\n`, 'utf8');

  const normal = await listHistory(settings, {
    offset: 0,
    limit: 10,
    query: marker,
    filter: 'ok',
    bypassCache: true,
  });
  const item = normal.items.find(candidate => candidate.digest_id === markdown.digest_id);
  assert.ok(item, 'a complete saved Markdown file must stay in normal history when only its source digest changes');
  assert.equal(item.source_stale, true, 'the historical source change must remain visible as provenance status');
  assert.equal(item.source_stale_reason, 'history_source_changed_after_commit', 'source drift must have a dedicated reason that cannot be hidden by another post-commit warning');
  assert.equal(item.has_blocking_issue, false, 'source provenance drift must not classify the immutable Markdown file as blocked');
  assert.equal(item.blocking_issue_reason, '', 'source provenance drift must not replace a real file or privacy-policy issue reason');

  const issues = await listHistory(settings, {
    offset: 0,
    limit: 10,
    query: marker,
    filter: 'issues',
    bypassCache: true,
  });
  assert.ok(!issues.items.some(candidate => candidate.digest_id === markdown.digest_id), 'source provenance drift alone must not move a usable Markdown file into the issue filter');

  const markdownItem = {
    artifact_type: 'text_preview_md',
    digest_id: 'markdown-source-boundary',
    history_item_key: 'history-key-markdown-source-boundary',
    file_exists: true,
    file_version: 'sha256-md',
    export_policy_revision: 'policy-v1',
    source_stale: true,
    source_stale_reason: 'history_source_changed_after_commit',
  };
  assert.equal(mdFileActionCheck(markdownItem).ok, true,
    'a saved Markdown file remains usable when its source digest changes later');
  assert.equal(markdownSourceCheck(markdownItem).ok, true,
    'source lookup uses the saved Markdown identity and file version');
  const missingMarkdown = { ...markdownItem, file_exists: false, file_version: 'missing:v1' };
  assert.equal(mdFileActionCheck(missingMarkdown).ok, false);
  assert.match(mdFileActionCheck(missingMarkdown).reason, /重新导出/);
} finally {
  await fsp.rm(testRoot, { recursive: true, force: true });
}

console.log('history Markdown source state boundary contract passed');
