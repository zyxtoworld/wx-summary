import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(
  new URL('../src/web/public/css/history.css', import.meta.url),
  'utf8',
);
const mobile = css.match(/@media\s*\(max-width:\s*720px\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';

assert.ok(mobile, '历史页必须存在窄屏布局断点');
assert.match(
  mobile,
  /\.history-toolbar\s*\{[^}]*position:\s*static;/,
  '窄屏历史筛选栏较高，必须随内容滚走，不能长期遮住记录列表',
);

console.log('web history mobile toolbar visibility tests passed');
