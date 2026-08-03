import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { OUTPUTS_DIR, toProjectRelative } from '../src/lib/paths.js';

const TEST_ROOT = path.join(OUTPUTS_DIR, `history-rerender-delete-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
const BASE = path.join(TEST_ROOT, 'digests');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE = TEST_ROOT;
process.env.WX_SUMMARY_INCLUDE_ACCEPTANCE_HISTORY_FIXTURE_ROOTS = TEST_ROOT;

const {
  deleteHistoryItem,
  digestSemanticRevision,
  listHistory,
  outputFileVersion,
  overwriteRenderedPng,
  readHistoryDigest,
  saveRenderedPng,
} = await import('../src/renderer/output.js');

const settings = {
  settings_revision: 'history-rerender-delete-v1',
  export_policy_revision: 'history-rerender-delete-v1',
  output: {
    dir: `./${toProjectRelative(BASE)}`,
    retention_days: 0,
  },
};

async function fileExists(file) {
  return fsp.stat(file).then(stat => stat.isFile(), () => false);
}

async function main() {
  try {
    const source = await saveRenderedPng({
      settings,
      digest: {
        digest_id: 'history-rerender-chain-delete',
        group: 'history rerender chain delete fixture',
        since: '2026-01-01 00:00:00',
        until: '2026-01-01 01:00:00',
        message_count: 1,
        model: 'test-model',
        headline: 'source version',
        highlights: ['fixture'],
        topics: [],
        created_at: '2026-01-01T01:00:00.000Z',
      },
      png_buffer: PNG,
      save_operation_id: 'history-rerender-chain-source',
    });
    const sourceDigest = await readHistoryDigest(settings, source.digest_id, {
      history_item_key: source.history_item_key,
    });
    const first = await overwriteRenderedPng({
      settings,
      item: source,
      digest: { ...sourceDigest, __render: { theme: 'dark', font_size: 'normal', accent_color: '#12AB34' } },
      source_digest_revision: digestSemanticRevision(sourceDigest),
      png_buffer: PNG,
      expected_file_version: await outputFileVersion(source.file_path),
      expected_digest_file_version: await outputFileVersion(source.digest_path),
    });
    const firstDigest = await readHistoryDigest(settings, first.digest_id, {
      history_item_key: first.history_item_key,
      expected_digest_file_version: first.digest_file_version,
    });
    const second = await overwriteRenderedPng({
      settings,
      item: first,
      digest: { ...firstDigest, __render: { theme: 'light', font_size: 'large', accent_color: '#2255AA' } },
      source_digest_revision: digestSemanticRevision(firstDigest),
      png_buffer: PNG,
      expected_file_version: first.file_version,
      expected_digest_file_version: first.digest_file_version,
    });

    assert.notEqual(first.file_path, second.file_path, 'successive rerenders must create distinct versioned PNGs');
    assert.equal(await fileExists(first.file_path), true, 'the hidden first rerender PNG must exist before deletion');
    assert.equal(await fileExists(first.digest_path), true, 'the hidden first rerender sidecar must exist before deletion');

    const deleted = await deleteHistoryItem(settings, second.digest_id, {
      history_item_key: second.history_item_key,
      expected_file_version: second.file_version,
      expected_digest_file_version: second.digest_file_version,
      expected_output_dir_identity: second.output_dir_identity,
    });
    assert.equal(deleted.deleted, true, 'deleting the visible rerender lineage should commit');
    assert.equal(await fileExists(second.file_path), false, 'deletion must remove the visible rerender PNG');
    assert.equal(await fileExists(second.digest_path), false, 'deletion must remove the visible rerender sidecar');
    assert.equal(await fileExists(first.file_path), false, 'deletion must remove the hidden superseded rerender PNG');
    assert.equal(await fileExists(first.digest_path), false, 'deletion must remove the hidden superseded rerender sidecar');
    assert.equal(await fileExists(source.file_path), true, 'deletion must preserve the separately indexed source PNG');
    assert.equal(await fileExists(source.digest_path), true, 'deletion must preserve the separately indexed source sidecar');

    await fsp.rm(path.join(BASE, 'index.json'), { force: true });
    const rebuilt = await listHistory(settings, {
      offset: 0,
      limit: 20,
      query: 'history rerender chain delete fixture',
      filter: 'all',
      bypassCache: true,
    });
    assert.equal(
      rebuilt.items.some(item => item.history_item_key === second.history_item_key),
      false,
      'index rebuild must not resurrect a deleted rerender lineage from hidden superseded artifacts',
    );
    assert.equal(
      rebuilt.items.some(item => item.history_item_key === source.history_item_key),
      true,
      'index rebuild must retain the separately indexed source record',
    );
  } finally {
    await fsp.rm(TEST_ROOT, { recursive: true, force: true });
  }
  console.log('history rerender chain deletion test passed');
}

await main();
