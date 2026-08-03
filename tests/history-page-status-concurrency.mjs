import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { OUTPUTS_DIR, toProjectRelative } from '../src/lib/paths.js';

const testRoot = path.join(OUTPUTS_DIR, `history-page-status-concurrency-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE = testRoot;
process.env.WX_SUMMARY_INCLUDE_ACCEPTANCE_HISTORY_FIXTURE_ROOTS = testRoot;

const { listHistory, saveRenderedPng } = await import('../src/renderer/output.js');
const settings = {
  settings_revision: 'history-page-status-concurrency-v1',
  export_policy_revision: 'history-page-status-concurrency-v1',
  output: { dir: `./${toProjectRelative(testRoot)}` },
};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const originalOpen = fsp.open;

try {
  for (let index = 0; index < 8; index += 1) {
    await saveRenderedPng({
      settings,
      digest: {
        digest_id: `history-status-concurrency-${index}`,
        group: '历史并发状态测试群',
        since: '2026-08-01 00:00:00',
        until: '2026-08-01 01:00:00',
        message_count: 1,
        model: 'test-model',
        headline: `历史并发状态测试 ${index}`,
        created_at: new Date(Date.UTC(2026, 7, 1, 8, 0, 0) - index * 60_000).toISOString(),
      },
      png_buffer: png,
      save_operation_id: `history-status-concurrency-save-${index}-${crypto.randomUUID()}`,
    });
  }

  const warm = await listHistory(settings, {
    limit: 1,
    filter: 'ok',
    bypassCache: true,
  });
  assert.equal(warm.items.length, 1, 'the combined history index must be warm before measuring card status reads');

  let activeOpens = 0;
  let maxActiveOpens = 0;
  let delayedOpens = 0;
  const rootPrefix = `${path.resolve(testRoot)}${path.sep}`.toLowerCase();
  fsp.open = async function delayedHistoryOpen(file, ...args) {
    const resolved = path.resolve(String(file)).toLowerCase();
    const delayed = resolved.startsWith(rootPrefix) && path.basename(resolved) !== 'index.json';
    if (!delayed) return originalOpen.call(this, file, ...args);
    delayedOpens += 1;
    activeOpens += 1;
    maxActiveOpens = Math.max(maxActiveOpens, activeOpens);
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      return await originalOpen.call(this, file, ...args);
    } finally {
      activeOpens -= 1;
    }
  };

  const history = await listHistory(settings, {
    limit: 8,
    filter: 'ok',
  });
  assert.equal(history.items.length, 8);
  assert.ok(delayedOpens >= 8, 'the fixture must exercise per-item file status reads');
  assert.ok(maxActiveOpens >= 2, 'history page file status reads should run with bounded concurrency instead of serializing every card');
  assert.ok(maxActiveOpens <= 8, 'one history page must not create unbounded file status concurrency');
} finally {
  fsp.open = originalOpen;
  await fsp.rm(testRoot, { recursive: true, force: true });
}

console.log('history page status concurrency tests passed');
