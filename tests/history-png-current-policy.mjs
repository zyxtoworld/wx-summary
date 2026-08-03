import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { OUTPUTS_DIR, toProjectRelative } from '../src/lib/paths.js';
import { RENDERED_PNG_MAX_RGBA_BYTES } from '../src/renderer/png-validate.js';
import { __thumbnailInternals } from '../src/renderer/thumbnail.js';

const testRoot = path.join(OUTPUTS_DIR, `history-png-policy-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE = testRoot;
process.env.WX_SUMMARY_INCLUDE_ACCEPTANCE_HISTORY_FIXTURE_ROOTS = testRoot;

const { listHistory, outputFileVersion, saveRenderedPng } = await import('../src/renderer/output.js');
const settings = {
  settings_revision: 'history-png-policy-v1',
  export_policy_revision: 'history-png-policy-v1',
  output: { dir: `./${toProjectRelative(testRoot)}` },
};
const safePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

function oversizedLegacyPng() {
  const width = 2_000;
  const height = Math.floor(RENDERED_PNG_MAX_RGBA_BYTES / width / 4) + 1;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    __thumbnailInternals.pngChunk('IHDR', ihdr),
    __thumbnailInternals.pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])),
    __thumbnailInternals.pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

try {
  const saved = await saveRenderedPng({
    settings,
    digest: {
      digest_id: 'history-png-current-policy-source',
      group: '旧 PNG 当前策略测试群',
      since: '2026-08-02 00:00:00',
      until: '2026-08-02 01:00:00',
      message_count: 1,
      model: 'test-model',
      headline: '强版本一致也必须满足当前 PNG 安全策略',
      created_at: '2026-08-02T01:00:00.000Z',
    },
    png_buffer: safePng,
    save_operation_id: `history-png-policy-save-${crypto.randomUUID()}`,
  });

  await fsp.writeFile(saved.file_path, oversizedLegacyPng());
  const oversizedVersion = await outputFileVersion(saved.file_path);
  const indexPath = path.join(testRoot, 'index.json');
  const indexItems = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
  const indexItem = indexItems.find(item => item.digest_id === saved.digest_id);
  assert.ok(indexItem, 'saved history item should remain indexed');
  indexItem.saved_file_version = oversizedVersion;
  await fsp.writeFile(indexPath, `${JSON.stringify(indexItems, null, 2)}\n`, 'utf8');

  const history = await listHistory(settings, {
    limit: 10,
    query: '旧 PNG 当前策略测试群',
    filter: 'all',
    bypassCache: true,
  });
  const item = history.items.find(entry => entry.digest_id === saved.digest_id);
  assert.ok(item, 'old PNG should remain visible in history');
  assert.equal(item.file_readable, true, 'the regular file should remain eligible for reveal and path actions');
  assert.equal(item.file_png_valid, false, 'a matching saved version must not bypass the current PNG memory policy');
  assert.equal(item.file_status, 'png_payload_canvas_too_large');
  assert.equal(item.file_version, oversizedVersion, 'the rejected PNG should retain a version-bound rerender source');
  assert.equal(item.has_blocking_issue, true, 'the history card should advertise the unsafe PNG as an issue before click');
} finally {
  await fsp.rm(testRoot, { recursive: true, force: true });
}

console.log('history PNG current-policy tests passed');
