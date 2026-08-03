import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { OUTPUTS_DIR, PROJECT_ROOT, toProjectRelative } from '../src/lib/paths.js';

const TEST_ROOT = path.join(OUTPUTS_DIR, `history-rerender-startup-recovery-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
const BASE = path.join(TEST_ROOT, 'digests');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE = TEST_ROOT;
process.env.WX_SUMMARY_INCLUDE_ACCEPTANCE_HISTORY_FIXTURE_ROOTS = TEST_ROOT;

const {
  digestSemanticRevision,
  outputFileVersion,
  overwriteRenderedPng,
  readHistoryDigest,
  recoverPendingHistoryWrites,
  saveRenderedPng,
} = await import('../src/renderer/output.js');

const settings = {
  settings_revision: 'history-rerender-startup-recovery-v1',
  export_policy_revision: 'history-rerender-startup-recovery-v1',
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
        digest_id: 'history-rerender-startup-recovery',
        group: 'history rerender startup recovery fixture',
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
      save_operation_id: 'history-rerender-startup-recovery-source',
    });
    const indexPath = path.join(BASE, 'index.json');
    const indexBeforeRerender = await fsp.readFile(indexPath);
    const sourceDigest = await readHistoryDigest(settings, source.digest_id, {
      history_item_key: source.history_item_key,
    });
    const rerendered = await overwriteRenderedPng({
      settings,
      item: source,
      digest: { ...sourceDigest, __render: { theme: 'dark', font_size: 'normal', accent_color: '#12AB34' } },
      source_digest_revision: digestSemanticRevision(sourceDigest),
      png_buffer: PNG,
      expected_file_version: await outputFileVersion(source.file_path),
      expected_digest_file_version: await outputFileVersion(source.digest_path),
    });

    const committedIndex = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
    assert.ok(
      committedIndex.some(entry => entry.relative_path === rerendered.relative_path),
      'the fixture must first commit the rerender to history',
    );
    await fsp.writeFile(indexPath, indexBeforeRerender);

    const staleIndex = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
    assert.equal(
      staleIndex.some(entry => entry.relative_path === rerendered.relative_path),
      false,
      'the simulated crash must leave the committed rerender missing from index.json',
    );
    const markerPath = `${path.resolve(PROJECT_ROOT, rerendered.digest_relative_path)}.commit.json`;
    assert.equal((await fsp.lstat(markerPath)).isFile(), true, 'the simulated crash must retain the committed rerender marker');

    const recovery = await recoverPendingHistoryWrites(settings, { reason: 'startup_test' });
    const recoveredIndex = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
    assert.ok(
      recoveredIndex.some(entry => entry.relative_path === rerendered.relative_path),
      'startup recovery must restore a hash-verified committed rerender that is missing from index.json',
    );
    assert.equal(recovery.rerender_recovered, 1, 'startup recovery should report the restored rerender count');
    assert.ok(
      recovery.warnings.some(warning => warning?.code === 'history_rerender_commit_recovered'),
      'startup recovery should explain that a committed rerender was restored',
    );
  } finally {
    await fsp.rm(TEST_ROOT, { recursive: true, force: true });
  }
  console.log('history rerender startup recovery test passed');
}

await main();
