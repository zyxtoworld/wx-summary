import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { OUTPUTS_DIR, toProjectRelative } from '../src/lib/paths.js';

const testRoot = path.join(OUTPUTS_DIR, `history-page-png-cache-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE = testRoot;
process.env.WX_SUMMARY_INCLUDE_ACCEPTANCE_HISTORY_FIXTURE_ROOTS = testRoot;

const { listHistory, saveRenderedPng } = await import('../src/renderer/output.js');
const settings = {
  settings_revision: 'history-page-png-cache-v1',
  export_policy_revision: 'history-page-png-cache-v1',
  output: { dir: `./${toProjectRelative(testRoot)}` },
};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const originalOpen = fsp.open;
let pngBytesRead = 0;

try {
  for (let index = 0; index < 4; index += 1) {
    await saveRenderedPng({
      settings,
      digest: {
        digest_id: `history-png-cache-${index}`,
        group: '历史 PNG 缓存测试群',
        since: '2026-08-01 00:00:00',
        until: '2026-08-01 01:00:00',
        message_count: 1,
        model: 'test-model',
        headline: `历史 PNG 缓存测试 ${index}`,
        created_at: new Date(Date.UTC(2026, 7, 1, 8, 0, 0) - index * 60_000).toISOString(),
      },
      png_buffer: png,
      save_operation_id: `history-png-cache-save-${index}-${crypto.randomUUID()}`,
    });
  }

  const indexPath = path.join(testRoot, 'index.json');
  const indexItems = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
  for (const item of indexItems) {
    delete item.saved_file_version;
    delete item.saved_digest_file_version;
  }
  await fsp.writeFile(indexPath, `${JSON.stringify(indexItems, null, 2)}\n`);

  fsp.open = async function countedHistoryPngOpen(file, ...args) {
    const handle = await originalOpen.call(this, file, ...args);
    if (path.extname(String(file)).toLowerCase() !== '.png') return handle;
    const originalRead = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      const result = await originalRead(...readArgs);
      pngBytesRead += Number(result?.bytesRead || 0) || 0;
      return result;
    };
    return handle;
  };

  const first = await listHistory(settings, { limit: 4, filter: 'ok', bypassCache: true });
  assert.equal(first.items.length, 4);
  assert.ok(pngBytesRead >= png.length * 4, 'the first legacy-page load must validate PNG contents');

  pngBytesRead = 0;
  const second = await listHistory(settings, { limit: 4, filter: 'ok' });
  assert.equal(second.items.length, 4);
  assert.equal(pngBytesRead, 0, 'unchanged PNGs already validated in this process should not be read in full again');
} finally {
  fsp.open = originalOpen;
  await fsp.rm(testRoot, { recursive: true, force: true });
}

console.log('history page PNG validation cache tests passed');
