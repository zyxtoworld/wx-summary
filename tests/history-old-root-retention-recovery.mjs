import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { OUTPUTS_DIR, toProjectRelative } from '../src/lib/paths.js';

const TEST_ROOT = path.join(OUTPUTS_DIR, `history-old-root-retention-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
const OLD_BASE = path.join(TEST_ROOT, 'old', 'digests');
const CURRENT_BASE = path.join(TEST_ROOT, 'current', 'digests');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE = TEST_ROOT;
process.env.WX_SUMMARY_INCLUDE_ACCEPTANCE_HISTORY_FIXTURE_ROOTS = TEST_ROOT;

const {
  outputFileVersion,
  recoverPendingHistoryWrites,
  saveRenderedPng,
} = await import('../src/renderer/output.js');

const settingsFor = (base, revision) => ({
  settings_revision: revision,
  export_policy_revision: revision,
  output: {
    dir: `./${toProjectRelative(base)}`,
    retention_days: 0,
  },
});

async function fileExists(file) {
  return fsp.stat(file).then(stat => stat.isFile(), () => false);
}

async function main() {
  try {
    const oldSettings = settingsFor(OLD_BASE, 'history-old-root-v1');
    const oldItem = await saveRenderedPng({
      settings: oldSettings,
      digest: {
        digest_id: 'history-old-root-retention',
        group: 'old root retention recovery fixture',
        since: '2026-01-01 00:00:00',
        until: '2026-01-01 01:00:00',
        message_count: 1,
        model: 'test-model',
        headline: 'old output item',
        highlights: ['fixture'],
        topics: [],
        created_at: '2026-01-01T01:00:00.000Z',
      },
      png_buffer: PNG,
      save_operation_id: 'history-old-root-source',
    });
    const currentSettings = settingsFor(CURRENT_BASE, 'history-current-root-v1');
    await saveRenderedPng({
      settings: currentSettings,
      digest: {
        digest_id: 'history-current-root-retention',
        group: 'current root retention recovery fixture',
        since: '2026-01-01 00:00:00',
        until: '2026-01-01 01:00:00',
        message_count: 1,
        model: 'test-model',
        headline: 'current output item',
        highlights: ['fixture'],
        topics: [],
        created_at: '2026-01-01T01:00:00.000Z',
      },
      png_buffer: PNG,
      save_operation_id: 'history-current-root-source',
    });

    const fileVersion = await outputFileVersion(oldItem.file_path);
    const transactionId = '11111111-1111-4111-8111-111111111111';
    const stagedPath = `${oldItem.file_path}.retention-delete-${transactionId}.pending`;
    const manifestPath = `${stagedPath}.transaction.json`;
    await fsp.writeFile(path.join(OLD_BASE, 'index.json'), '[]\n', 'utf8');
    await fsp.rename(oldItem.file_path, stagedPath);
    await fsp.writeFile(manifestPath, JSON.stringify({
      schema: 'wx-summary.retention-delete.v1',
      version: 1,
      transaction_id: transactionId,
      output_dir_identity: oldItem.output_dir_identity,
      original_relative_path: path.relative(OLD_BASE, oldItem.file_path).replace(/\\/g, '/'),
      staged_relative_path: path.relative(OLD_BASE, stagedPath).replace(/\\/g, '/'),
      role: 'primary',
      expected_version: fileVersion,
      file_version: fileVersion,
      prepared_at: new Date().toISOString(),
    }, null, 2), 'utf8');

    const recovered = await recoverPendingHistoryWrites(currentSettings, { reason: 'startup_test' });
    assert.ok(Number(recovered.retention_finalized || 0) >= 1, 'startup recovery must report finalized cleanup from a discovered old output root');
    assert.equal(await fileExists(stagedPath), false, 'startup recovery must remove the committed old-root staged file');
    assert.equal(await fileExists(manifestPath), false, 'startup recovery must remove the committed old-root transaction manifest');
    assert.equal(await fileExists(oldItem.file_path), false, 'startup recovery must not restore an artifact removed from the committed old-root index');
  } finally {
    await fsp.rm(TEST_ROOT, { recursive: true, force: true });
  }
  console.log('history old-root retention recovery test passed');
}

await main();
