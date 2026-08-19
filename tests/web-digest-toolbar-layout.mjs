import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appCss = await readFile(new URL('../src/web/public/css/app.css', import.meta.url), 'utf8');

assert.match(
  appCss,
  /\.digest-list-toolbar\s*\{[^}]*flex-wrap:\s*wrap;/s,
  '摘要侧栏工具栏必须允许整组控件换行，不能把按钮文字压成多行',
);
assert.match(
  appCss,
  /\.digest-list-toolbar\s*>\s*\.muted\s*\{[^}]*white-space:\s*nowrap;/s,
  '已选计数必须保持单行',
);
assert.match(
  appCss,
  /\.toolbar-btns\s*\{[^}]*flex:\s*0\s+0\s+auto;[^}]*margin-left:\s*auto;/s,
  '工具栏按钮组必须整体收缩并在空间不足时换到下一行',
);
assert.match(
  appCss,
  /\.toolbar-btns\s+\.btn\s*\{[^}]*white-space:\s*nowrap;/s,
  '工具栏按钮文字必须保持单行',
);

console.log('web digest toolbar layout tests passed');
