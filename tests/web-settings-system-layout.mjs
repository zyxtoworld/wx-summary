import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [css, systemSource] = await Promise.all([
  readFile(new URL('../src/web/public/css/settings.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/js/pages/settings/system.js', import.meta.url), 'utf8'),
]);

assert.match(
  systemSource,
  /settings-check-title[\s\S]*?software_evidence_summary[\s\S]*?settings-check-meta[\s\S]*?next_step/,
  '本机状态会把诊断标题、证据摘要和下一步投影到检查项文本节点',
);
assert.match(
  systemSource,
  /settings-check-meta[\s\S]*?entry\.reason/,
  '平台限制原因也会投影到诊断文本节点',
);
assert.match(
  css,
  /\.settings-check-item\s*\{[^}]*min-width:\s*0;[^}]*overflow-x:\s*hidden;/,
  '检查项 flex 容器必须限制连续诊断文本的横向尺寸',
);
assert.match(
  css,
  /\.settings-check-title,\s*\n?\.settings-check-meta\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;[^}]*word-break:\s*break-word;/,
  '诊断标题、证据、下一步和平台限制原因必须允许任意断行',
);

console.log('web settings system layout tests passed');
