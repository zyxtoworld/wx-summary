import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { OUTPUTS_DIR, toProjectRelative } from '../src/lib/paths.js';

const TEST_ROOT = path.join(OUTPUTS_DIR, `history-rerender-output-barrier-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
const BASE = path.join(TEST_ROOT, 'digests');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE = TEST_ROOT;
process.env.WX_SUMMARY_INCLUDE_ACCEPTANCE_HISTORY_FIXTURE_ROOTS = TEST_ROOT;

const {
  digestSemanticRevision,
  findHistoryItem,
  outputFileVersion,
  overwriteRenderedPng,
  readHistoryDigest,
  saveRenderedPng,
} = await import('../src/renderer/output.js');

const settings = {
  settings_revision: 'history-rerender-output-barrier-v1',
  export_policy_revision: 'history-rerender-output-barrier-v1',
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
        digest_id: 'history-rerender-output-barrier',
        group: 'history rerender output barrier fixture',
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
      save_operation_id: 'history-rerender-output-barrier-source',
    });
    const digest = await readHistoryDigest(settings, source.digest_id, {
      history_item_key: source.history_item_key,
    });
    let commitCalls = 0;
    const commitBarrier = async commit => {
      commitCalls += 1;
      if (commitCalls === 2) {
        throw Object.assign(new Error('synthetic output directory change'), {
          status: 409,
          code: 'output_dir_changed',
          public_code: 'output_dir_changed',
        });
      }
      return typeof commit === 'function' ? commit() : true;
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
        commitBarrier,
      }),
      error => error?.code === 'output_dir_changed',
      'a changed output directory must reject the rerender before its marker/index commit',
    );
    assert.equal(commitCalls, 2, 'the fixture must reject after the versioned PNG/digest write boundary');

    const files = await fsp.readdir(path.dirname(source.file_path));
    assert.deepEqual(
      files.filter(name => name.includes('__rerender_')),
      [],
      'a rejected output-directory commit must remove the unindexed rerender PNG, digest and marker',
    );
    const indexed = await findHistoryItem(settings, source.digest_id, {
      history_item_key: source.history_item_key,
    });
    assert.equal(indexed?.relative_path, source.relative_path, 'the original history index binding must remain current');
  } finally {
    await fsp.rm(TEST_ROOT, { recursive: true, force: true });
  }
  console.log('history rerender output directory barrier test passed');
}

await main();
