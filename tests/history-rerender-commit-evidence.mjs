import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { OUTPUTS_DIR, toProjectRelative } from '../src/lib/paths.js';

const TEST_ROOT = path.join(OUTPUTS_DIR, `history-rerender-evidence-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
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
  settings_revision: 'history-rerender-evidence-v1',
  export_policy_revision: 'history-rerender-evidence-v1',
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
        digest_id: 'history-rerender-commit-evidence',
        group: 'history rerender commit evidence fixture',
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
      save_operation_id: 'history-rerender-evidence-source',
    });
    const digest = await readHistoryDigest(settings, source.digest_id, {
      history_item_key: source.history_item_key,
    });
    const rerendered = await overwriteRenderedPng({
      settings,
      item: source,
      digest: { ...digest, __render: { theme: 'dark', font_size: 'normal', accent_color: '#12AB34' } },
      source_digest_revision: digestSemanticRevision(digest),
      png_buffer: PNG,
      expected_file_version: await outputFileVersion(source.file_path),
      expected_digest_file_version: await outputFileVersion(source.digest_path),
      finalizeCommitEvidence: async () => {
        throw Object.assign(new Error('synthetic rerender evidence failure'), {
          code: 'synthetic_rerender_evidence_failure',
        });
      },
    });

    assert.equal(rerendered.history_current, true, 'a post-index evidence failure must keep the committed rerender current');
    assert.equal(rerendered.history_commit_failed, false, 'a post-index evidence failure must not be reported as an index failure');
    assert.equal(
      rerendered.local_action_after_commit_reason,
      'commit_evidence_persist_failed',
      'a post-index evidence failure must return a precise committed-with-warning reason',
    );
    assert.match(
      String(rerendered.local_action_after_commit_error || ''),
      /synthetic rerender evidence failure/,
      'the committed rerender warning must retain the sanitized evidence failure detail',
    );
    const indexed = await findHistoryItem(settings, rerendered.digest_id, {
      history_item_key: rerendered.history_item_key,
    });
    assert.equal(indexed?.relative_path, rerendered.relative_path, 'the committed rerender must remain discoverable after evidence persistence fails');
  } finally {
    await fsp.rm(TEST_ROOT, { recursive: true, force: true });
  }
  console.log('history rerender commit evidence test passed');
}

await main();
