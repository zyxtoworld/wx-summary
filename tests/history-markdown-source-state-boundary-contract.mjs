import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { OUTPUTS_DIR, toProjectRelative } from '../src/lib/paths.js';

const projectRoot = path.resolve(import.meta.dirname, '..');
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

  const appSource = fs.readFileSync(path.join(projectRoot, 'src', 'web', 'public', 'js', 'app.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(projectRoot, 'src', 'main.js'), 'utf8');
  const targetUsableSource = appSource.slice(appSource.indexOf('function markdownOutputTargetUsable'), appSource.indexOf('function markdownOutputUnusableReasonText'));
  const historyBoundSource = appSource.slice(appSource.indexOf('function outputItemHistoryBound'), appSource.indexOf('function outputFileDownloadPath'));
  const cardActionsSource = appSource.slice(appSource.indexOf('function historyCardActionsHtml'), appSource.indexOf('function historyThumbnailIssue'));
  const modalSource = appSource.slice(appSource.indexOf('function showHistoryMarkdownModal'), appSource.indexOf('function showHistoryModal'));
  const exportCacheSource = appSource.slice(appSource.indexOf('function historyMarkdownExportCacheKey'), appSource.indexOf('function invalidateHistoryMarkdownExportTargets'));
  const historyPngModalSource = appSource.slice(appSource.indexOf('function showHistoryModal'), appSource.indexOf('function historyImagePath'));
  const serverResolverSource = mainSource.slice(mainSource.indexOf('async function resolveMarkdownOutputFile'), mainSource.indexOf('function markdownOutputChangedBeforeResponseError'));

  assert.ok(!targetUsableSource.includes('markdownOutputSourceStale'), 'source status must not disable saved Markdown file actions');
  assert.ok(!historyBoundSource.includes('markdownOutputSourceStale'), 'source status must not make an indexed Markdown history item look unbound');
  assert.ok(!cardActionsSource.match(/const disabled\s*=\s*[^;]*sourceStale/), 'history cards must keep valid Markdown details available when only the source changed');
  assert.ok(!modalSource.match(/const fileUnavailable\s*=\s*[^;]*sourceStale/), 'the Markdown modal must still read the saved file when only the source changed');
  assert.ok(!exportCacheSource.includes('if (markdownOutputSourceStale(exportItem || {})) return false'), 'an exported Markdown cache entry must remain usable after its source changes');
  assert.ok(!historyPngModalSource.includes('if (markdownOutputSourceStale(historyMarkdownExportItem))'), 'download, reveal, and copy-path actions for a newly exported Markdown file must not clear that file on source drift');
  assert.ok(
    !historyPngModalSource.match(/code\s*\|\|\s*''\)\.trim\(\)\s*===\s*'history_md_source_changed'[\s\S]{0,240}clearHistoryMarkdownExportItem/),
    'a failed re-export caused by source drift must not delete an older successfully exported Markdown target',
  );
  assert.ok(
    historyPngModalSource.includes('changed: versionChanged || superseded || serverContextChanged')
      && historyPngModalSource.includes('withHistoryMarkdownSourceWarning')
      && historyPngModalSource.includes('现有 MD 保留导出时内容'),
    'source drift during export completion must preserve the written file and attach a warning instead of reporting it as unbound',
  );
  assert.ok(!serverResolverSource.includes('assertHistoryMarkdownSourceCurrent'), 'server file resolution must validate the saved file and export policy, not current source contents');
  assert.ok(
    appSource.includes('function historyMarkdownSourceWarningText(item = {})')
      && appSource.includes('显示和下载的是导出时内容')
      && appSource.includes('data-history-md-source-warning'),
    'the UI must explain that source drift changes re-export provenance without changing the saved file',
  );
  assert.ok(
    mainSource.includes('const assertHistorySourceStillCurrent = async settingsForCheck')
      && mainSource.includes('await assertHistorySourceStillCurrent(latest)'),
    're-export must continue validating the current source even though existing-file operations do not',
  );
  assert.ok(
    mainSource.includes("'source_stale'")
      && mainSource.includes("'source_stale_reason'")
      && mainSource.includes("'source_stale_error'"),
    'the public history API must preserve dedicated source-drift status even when another post-commit reason exists',
  );
} finally {
  await fsp.rm(testRoot, { recursive: true, force: true });
}

console.log('history Markdown source state boundary contract passed');
