import assert from 'node:assert/strict';
import { renderDigestPngBuffer } from '../src/renderer/server-png.js';

if (process.platform !== 'win32') {
  console.log('server PNG height-limit test skipped (Windows only)');
  process.exit(0);
}

const digest = {
  group: '高度边界验收',
  since: '2026-07-24 00:00:00',
  until: '2026-07-24 23:59:59',
  model: 'acceptance',
  headline: '高度边界',
  created_at: new Date().toISOString(),
  message_count: 1,
  topics: [{
    title: '主题',
    summary: '高度边界验收行\n'.repeat(1200),
    participants: ['测试'],
  }],
};

await assert.rejects(
  () => renderDigestPngBuffer(digest, { theme: 'light', font_size: 'normal' }),
  error => {
    assert.equal(error?.code, 'server_render_too_tall');
    assert.equal(error?.status, 413);
    assert.ok(Number.isSafeInteger(error?.expected_height_px) && error.expected_height_px > 0);
    assert.ok(Number.isSafeInteger(error?.max_height_px) && error.max_height_px > 0);
    assert.ok(error.expected_height_px > error.max_height_px);
    assert.match(String(error?.message || ''), /摘要内容过长/);
    return true;
  },
  'oversized server renders must fail before PNG allocation and preserve expected/max-height diagnostics',
);

console.log('server PNG height-limit test passed');
