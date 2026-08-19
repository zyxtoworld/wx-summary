import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(
  new URL('../src/web/public/css/setup.css', import.meta.url),
  'utf8',
);
const mobile = css.match(/@media\s*\(max-width:\s*640px\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';

assert.ok(mobile, '设置向导必须存在移动端布局断点');
assert.match(
  mobile,
  /\.setup-foot\s*\{[^}]*gap:\s*6px;/,
  '移动端向导底栏必须缩小按钮间距，为三个业务操作保留单行空间',
);
assert.match(
  mobile,
  /\.setup-foot \.btn\s*\{[^}]*flex:\s*0 0 auto;[^}]*padding-inline:\s*10px;[^}]*white-space:\s*nowrap;/,
  '移动端向导底栏按钮必须停止 flex 压缩并保持标签单行',
);

console.log('web setup mobile footer layout tests passed');
