import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { OUTPUTS_DIR, PROJECT_ROOT, toProjectRelative } from '../src/lib/paths.js';

const TEST_ROOT = path.join(OUTPUTS_DIR, `history-rerender-index-rollback-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
const BASE = path.join(TEST_ROOT, 'digests');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE = TEST_ROOT;
process.env.WX_SUMMARY_INCLUDE_ACCEPTANCE_HISTORY_FIXTURE_ROOTS = TEST_ROOT;

const {
  digestSemanticRevision,
  outputFileVersion,
  overwriteRenderedPng,
  readHistoryDigest,
  saveRenderedPng,
} = await import('../src/renderer/output.js');

const settings = {
  settings_revision: 'history-rerender-index-rollback-v1',
  export_policy_revision: 'history-rerender-index-rollback-v1',
  output: {
    dir: `./${toProjectRelative(BASE)}`,
    retention_days: 0,
  },
};

async function main() {
  try {
    const source = await saveRenderedPng({
      settings,
      digest: {
        digest_id: 'history-rerender-index-rollback',
        group: 'history rerender rollback fixture',
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
      save_operation_id: 'history-rerender-index-rollback-source',
    });
    const digest = await readHistoryDigest(settings, source.digest_id, {
      history_item_key: source.history_item_key,
    });
    const indexPath = path.join(BASE, 'index.json');
    const committedIndexCopy = path.join(BASE, 'index.committed-before-failed-rollback.json');
    let sabotaged = false;
    const abortAfterNewIndexCommit = () => {
      if (sabotaged) return true;
      let raw = '';
      try {
        raw = fs.readFileSync(indexPath, 'utf8');
      } catch {
        return false;
      }
      if (!raw.includes('__rerender_')) return false;
      fs.renameSync(indexPath, committedIndexCopy);
      fs.mkdirSync(indexPath);
      sabotaged = true;
      return true;
    };

    await assert.rejects(
      overwriteRenderedPng({
        settings,
        item: source,
        digest: { ...digest, __render: { theme: 'dark', font_size: 'normal', accent_color: '#12AB34' } },
        source_digest_revision: digestSemanticRevision(digest),
        png_buffer: PNG,
        expected_file_version: await outputFileVersion(source.file_path),
        expected_digest_file_version: await outputFileVersion(source.digest_path),
        shouldAbort: abortAfterNewIndexCommit,
      }),
      error => error?.code === 'history_index_rollback_failed',
      'the fixture must reach a committed new index whose rollback then fails',
    );
    assert.equal(sabotaged, true, 'the test must inject failure only after the rerender index entry is visible');

    const committedIndex = JSON.parse(await fsp.readFile(committedIndexCopy, 'utf8'));
    const rerendered = committedIndex.find(entry => String(entry?.relative_path || '').includes('__rerender_'));
    assert.ok(rerendered, 'the committed index copy must point at the new rerender version');
    const rerenderedPng = path.resolve(PROJECT_ROOT, rerendered.relative_path);
    const rerenderedDigest = path.resolve(PROJECT_ROOT, rerendered.digest_relative_path);
    const rerenderedMarker = `${rerenderedDigest}.commit.json`;
    for (const artifact of [rerenderedPng, rerenderedDigest, rerenderedMarker]) {
      const stat = await fsp.lstat(artifact).catch(() => null);
      assert.equal(stat?.isFile?.(), true, `a possibly committed rerender artifact must be preserved: ${path.basename(artifact)}`);
    }
  } finally {
    await fsp.rm(TEST_ROOT, { recursive: true, force: true });
  }
  console.log('history rerender index rollback preservation test passed');
}

await main();
