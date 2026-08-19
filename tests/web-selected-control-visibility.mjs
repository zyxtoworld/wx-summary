import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(
  new URL('../src/web/public/css/app.css', import.meta.url),
  'utf8',
);

assert.match(
  css,
  /\.theme-btn\.active\s*\{[^}]*box-shadow:\s*inset 0 0 0 1px var\(--control-border\);/,
  '主题三态的当前按钮必须有达到 3:1 的持久边界，不能只依赖淡色背景',
);
assert.match(
  css,
  /\.segmented-btn\.active\s*\{[^}]*box-shadow:\s*inset 0 0 0 1px var\(--control-border\),\s*var\(--shadow-sm\);/,
  '分段控件的当前按钮必须有达到 3:1 的持久边界，同时保留原有层级阴影',
);

console.log('web selected control visibility tests passed');
