import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const indexSource = await readFile(
  new URL('../src/web/public/js/pages/history/index.js', import.meta.url),
  'utf8',
);
const cssSource = await readFile(
  new URL('../src/web/public/css/history.css', import.meta.url),
  'utf8',
);

assert.match(
  indexSource,
  /function kv\(label, value\) \{[\s\S]*?const displayValue = String\(value \|\| '—'\);[\s\S]*?valueEl\.title = displayValue;/,
  '历史详情的完整字段值必须提供 title，桌面端省略时仍可查看原文',
);

assert.match(
  cssSource,
  /@media \(max-width: 720px\) \{[\s\S]*?\.history-kv-value\s*\{[\s\S]*?white-space:\s*normal;[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?\}/,
  '历史详情的字段值在窄屏必须换行展示，不能只留不可触达的省略号',
);

console.log('web history detail value visibility tests passed');
