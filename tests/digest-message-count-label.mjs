import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

import {
  digestMarkdown,
  digestMessageCountLabel,
  digestMessageCountRow,
  normalizeDigestForRender,
} from '../src/web/public/js/shared/digest-view-model.js';

const known = { message_count: 1369 };
const legacyUnknown = {
  group: '旧摘要统计测试群',
  since: '2026-06-09 00:00',
  until: '2026-06-10 00:00',
  message_count: 0,
  input_message_count: 0,
  scanned_message_count: 0,
  model: 'legacy-model',
  headline: '摘要有内容，但旧版没有可靠消息统计',
  highlights: ['旧版统计不能冒充真实的零'],
};

assert.equal(digestMessageCountLabel(known), '1369 条消息');
assert.equal(digestMessageCountLabel(known, '条'), '1369 条');
assert.equal(digestMessageCountLabel(legacyUnknown), '消息数未记录');
assert.equal(digestMessageCountRow(legacyUnknown), '消息：未记录');
assert.match(digestMarkdown(legacyUnknown), /消息数未记录/);
assert.doesNotMatch(digestMarkdown(legacyUnknown), /0 条消息/);
assert.equal(normalizeDigestForRender(legacyUnknown).__message_count_label, '消息数未记录');

const powershellSource = await fsp.readFile(new URL('../src/renderer/render-digest.ps1', import.meta.url), 'utf8');

assert.ok(
  powershellSource.includes('$digest.__message_count_label')
    && powershellSource.includes('$messageCountLabel'),
  'the PowerShell renderer should consume the shared normalized count label',
);

console.log('digest message-count label tests passed');
