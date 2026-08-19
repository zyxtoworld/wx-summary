import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(
  new URL('../src/web/public/css/app.css', import.meta.url),
  'utf8',
);

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `必须存在 ${selector} 样式`);
  return match[1];
}

const head = rule('.modal-head');
assert.match(head, /min-width:\s*0;/, '弹层标题栏必须允许在窄屏收缩');
assert.match(head, /gap:\s*12px;/, '标题与关闭按钮必须保留稳定间距');

const title = rule('.modal-head h3');
assert.match(title, /flex:\s*1;/, '标题必须占用关闭按钮之外的剩余宽度');
assert.match(title, /min-width:\s*0;/, '超长标题不能按最小内容宽度撑开弹层');
assert.match(title, /overflow-wrap:\s*anywhere;/, '无断点群名、错误标题必须在弹层内换行');
assert.match(title, /display:\s*-webkit-box;/, '超长标题必须启用多行截断');
assert.match(title, /-webkit-line-clamp:\s*3;/, '视觉标题最多显示三行，不能挤占弹层正文');
assert.match(title, /-webkit-box-orient:\s*vertical;/);
assert.match(title, /overflow:\s*hidden;/, '截断只影响视觉布局，完整标题仍保留在无障碍名称中');

assert.match(
  rule('.modal-x'),
  /flex:\s*0 0 auto;/,
  '关闭按钮不得被超长标题压缩或推出视口',
);

console.log('web modal long title layout tests passed');
