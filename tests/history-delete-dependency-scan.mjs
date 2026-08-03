import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { OUTPUTS_DIR, toProjectRelative } from '../src/lib/paths.js';

const TEST_ROOT = path.join(OUTPUTS_DIR, `history-delete-scan-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
const CURRENT_BASE = path.join(TEST_ROOT, 'current', 'digests');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE = TEST_ROOT;
process.env.WX_SUMMARY_INCLUDE_ACCEPTANCE_HISTORY_FIXTURE_ROOTS = TEST_ROOT;

const {
  deleteHistoryItem,
  historyItemKeyForItem,
  listHistory,
  outputFileVersion,
  saveRenderedPng,
} = await import('../src/renderer/output.js');

const settings = {
  settings_revision: 'history-delete-scan-v1',
  export_policy_revision: 'history-delete-scan-v1',
  output: {
    dir: `./${toProjectRelative(CURRENT_BASE)}`,
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
        digest_id: 'history-delete-incomplete-scan',
        group: 'history delete incomplete scan fixture',
        since: '2026-01-01 00:00:00',
        until: '2026-01-01 01:00:00',
        message_count: 1,
        model: 'test-model',
        headline: 'dependency discovery must finish before deletion',
        highlights: ['fixture'],
        topics: [],
        created_at: '2026-01-01T01:00:00.000Z',
      },
      png_buffer: PNG,
      save_operation_id: 'history-delete-scan-save',
    });
    for (let index = 0; index < 205; index += 1) {
      const base = path.join(TEST_ROOT, `foreign-${String(index).padStart(3, '0')}`, 'digests');
      await fsp.mkdir(base, { recursive: true });
      await fsp.writeFile(path.join(base, 'index.json'), '[]\n', 'utf8');
    }
    const lookup = {
      history_item_key: historyItemKeyForItem(CURRENT_BASE, source),
      expected_file_version: await outputFileVersion(source.file_path),
      expected_digest_file_version: await outputFileVersion(source.digest_path),
      expected_output_dir_identity: source.output_dir_identity,
    };

    let incompleteError = null;
    await assert.rejects(
      () => deleteHistoryItem(settings, source.digest_id, lookup),
      error => {
        incompleteError = error;
        return error?.code === 'history_dependency_scan_incomplete' && error?.status === 409;
      },
      'manual deletion must fail closed while history dependency discovery is incomplete',
    );
    assert.ok(Number(incompleteError?.pending_dir_count || 0) > 0, 'incomplete deletion error should expose remaining directory work');
    assert.equal(await fileExists(source.file_path), true, 'incomplete dependency discovery must preserve the PNG');
    assert.equal(await fileExists(source.digest_path), true, 'incomplete dependency discovery must preserve the digest JSON');
    const staged = (await fsp.readdir(path.dirname(source.file_path))).filter(name => name.includes('.retention-delete-'));
    assert.deepEqual(staged, [], 'incomplete dependency discovery must stop before staging any source artifact');

    let history = null;
    for (let pass = 0; pass < 6; pass += 1) {
      history = await listHistory(settings, { offset: 0, limit: 1, bypassCache: true });
      if (history.history_base_discovery_complete === true) break;
    }
    assert.equal(history?.history_base_discovery_complete, true, 'continued bounded discovery should eventually reach a complete dependency view');
    const deleted = await deleteHistoryItem(settings, source.digest_id, lookup);
    assert.equal(deleted.deleted, true, 'manual deletion may proceed after dependency discovery is complete and no dependents exist');
    assert.equal(await fileExists(source.file_path), false, 'completed safe deletion should remove the PNG');
    assert.equal(await fileExists(source.digest_path), false, 'completed safe deletion should remove the digest JSON');
  } finally {
    await fsp.rm(TEST_ROOT, { recursive: true, force: true });
  }
  console.log('history delete dependency scan test passed');
}

await main();
