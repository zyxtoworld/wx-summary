import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { OUTPUTS_DIR, toProjectRelative } from '../src/lib/paths.js';

const TEST_ROOT = path.join(OUTPUTS_DIR, `retention-cross-root-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
const SOURCE_BASE = path.join(TEST_ROOT, 'source', 'digests');
const EXPORT_BASE = path.join(TEST_ROOT, 'exports', 'digests');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE = TEST_ROOT;
process.env.WX_SUMMARY_INCLUDE_ACCEPTANCE_HISTORY_FIXTURE_ROOTS = TEST_ROOT;

const {
  cleanupOldDigests,
  historyItemKeyForItem,
  savePreviewMarkdown,
  saveRenderedPng,
} = await import('../src/renderer/output.js');

function settingsFor(base) {
  return {
    settings_revision: 'cross-root-retention-v1',
    export_policy_revision: 'cross-root-retention-v1',
    output: {
      dir: `./${toProjectRelative(base)}`,
      retention_days: 1,
    },
  };
}

async function fileExists(file) {
  return fsp.stat(file).then(stat => stat.isFile(), () => false);
}

async function main() {
  const sourceSettings = settingsFor(SOURCE_BASE);
  const exportSettings = settingsFor(EXPORT_BASE);
  try {
    const source = await saveRenderedPng({
      settings: sourceSettings,
      digest: {
        digest_id: 'cross-root-source',
        group: 'cross root dependency fixture',
        since: '2020-01-01 00:00:00',
        until: '2020-01-01 01:00:00',
        message_count: 1,
        model: 'test-model',
        headline: 'expired source retained by another output root',
        highlights: ['fixture'],
        topics: [],
        created_at: '2020-01-01T01:00:00.000Z',
      },
      png_buffer: PNG,
      save_operation_id: 'cross-root-source-save',
    });
    const sourceHistoryKey = historyItemKeyForItem(SOURCE_BASE, source);
    const exported = await savePreviewMarkdown({
      settings: exportSettings,
      title: 'cross root dependent markdown',
      markdown: '# cross root dependent markdown\n',
      history: true,
      metadata: {
        group: source.group,
        message_count: 1,
        source_digest_id: source.digest_id,
        source_history_item_key: sourceHistoryKey,
      },
    });

    const protectedCleanup = await cleanupOldDigests(sourceSettings);
    assert.equal(protectedCleanup.pruned, 0, 'retention must not prune a source row referenced by Markdown in another output root');
    assert.equal(protectedCleanup.removed, 0, 'retention must not remove source artifacts referenced by another output root');
    assert.equal(await fileExists(source.file_path), true, 'cross-root Markdown dependency must retain the source PNG');
    assert.equal(await fileExists(source.digest_path), true, 'cross-root Markdown dependency must retain the source digest JSON');
    assert.equal(await fileExists(exported.file_path), true, 'cleanup of the source root must not touch the foreign Markdown file');

    await fsp.writeFile(path.join(EXPORT_BASE, 'index.json'), '[]\n', 'utf8');
    await fsp.rm(exported.file_path, { force: true });
    await fsp.rm(`${exported.file_path}.meta.json`, { force: true });
    const unprotectedCleanup = await cleanupOldDigests(sourceSettings);
    assert.equal(unprotectedCleanup.pruned, 1, 'the expired source may be pruned after the foreign dependency is removed');
    assert.equal(await fileExists(source.file_path), false, 'the unreferenced expired PNG should be removed');
    assert.equal(await fileExists(source.digest_path), false, 'the unreferenced expired digest JSON should be removed');
  } finally {
    await fsp.rm(TEST_ROOT, { recursive: true, force: true });
  }
  console.log('retention cross-root dependency test passed');
}

await main();
