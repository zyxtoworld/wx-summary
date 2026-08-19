import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { OUTPUTS_DIR, toProjectRelative } from '../src/lib/paths.js';
import {
  DIGEST_RENDERER_ENGINE_BROWSER,
  DIGEST_RENDERER_ENGINE_SERVER,
  DIGEST_RENDERER_VERSION,
  RENDER_TOPIC_LIMIT,
  RENDER_TOPIC_PARTICIPANT_LIMIT,
  normalizeDigestForRender,
} from '../src/web/public/js/shared/digest-view-model.js';
import { normalizeRenderOptions } from '../src/renderer/server-png.js';

const TEST_ROOT = path.join(OUTPUTS_DIR, `history-renderer-version-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
const BASE = path.join(TEST_ROOT, 'digests');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE = TEST_ROOT;
process.env.WX_SUMMARY_INCLUDE_ACCEPTANCE_HISTORY_FIXTURE_ROOTS = TEST_ROOT;

const { listHistory, readHistoryDigest, saveRenderedPng } = await import('../src/renderer/output.js');
const settings = {
  settings_revision: 'history-renderer-version-v1',
  output: { dir: `./${toProjectRelative(BASE)}`, retention_days: 0 },
};

assert.equal(Number.isInteger(DIGEST_RENDERER_VERSION), true, 'renderer version must be one stable integer shared by browser and server code');
assert.equal(normalizeRenderOptions({}).renderer_engine, DIGEST_RENDERER_ENGINE_SERVER, 'server PNG options must identify the PowerShell renderer');

const oversizedTopics = Array.from({ length: RENDER_TOPIC_LIMIT + 1 }, (_, topicIndex) => ({
  title: `topic-${topicIndex}`,
  summary: `summary-${topicIndex}`,
  participants: Array.from({ length: RENDER_TOPIC_PARTICIPANT_LIMIT + 1 }, (_, participantIndex) => `user-${participantIndex}`),
}));
const normalizedOversizedDigest = normalizeDigestForRender({ topics: oversizedTopics });
assert.equal(normalizedOversizedDigest.topics.length, RENDER_TOPIC_LIMIT, 'the first browser/server render input must apply the persisted topic limit');
assert.equal(normalizedOversizedDigest.topics[0].participants.length, RENDER_TOPIC_PARTICIPANT_LIMIT, 'the first browser/server render input must apply the persisted participant limit');

try {
  const saved = await saveRenderedPng({
    settings,
    digest: {
      digest_id: 'history-renderer-version-source',
      group: '版式版本测试群',
      since: '2026-07-01 00:00:00',
      until: '2026-07-01 01:00:00',
      message_count: 1,
      headline: '版式版本必须随历史恢复',
      highlights: ['fixture'],
      topics: oversizedTopics,
      __render: {
        theme: 'light',
        font_size: 'normal',
        accent_color: '#12AB34',
        renderer_version: DIGEST_RENDERER_VERSION,
        renderer_engine: DIGEST_RENDERER_ENGINE_BROWSER,
      },
      created_at: '2026-07-01T01:00:00.000Z',
    },
    png_buffer: PNG,
    save_operation_id: 'history-renderer-version-save',
  });
  const digest = await readHistoryDigest(settings, saved.digest_id);
  assert.equal(digest.__render?.renderer_version, DIGEST_RENDERER_VERSION, 'persisted digest JSON must retain its renderer version');
  assert.equal(digest.__render?.renderer_engine, DIGEST_RENDERER_ENGINE_BROWSER, 'persisted digest JSON must retain its renderer engine');
  assert.deepEqual(digest.topics, normalizedOversizedDigest.topics, 'history JSON must retain the exact bounded topic input used by the first render');

  const history = await listHistory(settings, { offset: 0, limit: 10, bypassCache: true });
  const restored = history.items.find(item => item.digest_id === saved.digest_id);
  assert.equal(restored?.renderer_version, DIGEST_RENDERER_VERSION, 'fresh history reads must expose the renderer version without opening the digest JSON modal');
  assert.equal(restored?.renderer_engine, DIGEST_RENDERER_ENGINE_BROWSER, 'fresh history reads must expose the renderer engine without opening the digest JSON modal');
} finally {
  await fsp.rm(TEST_ROOT, { recursive: true, force: true });
}

const mainSource = await fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const publicItemSource = mainSource.slice(mainSource.indexOf('function publicOutputItem('), mainSource.indexOf('function redactPreviewHistoryMetadata'));
assert.ok(publicItemSource.includes("'renderer_version'"), 'history API projection must expose the renderer version');
assert.ok(publicItemSource.includes("'renderer_engine'"), 'history API projection must expose the renderer engine');

console.log('history renderer-version contract passed');
