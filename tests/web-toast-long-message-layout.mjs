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

assert.match(
  rule('.toast'),
  /min-width:\s*0;/,
  '通知卡必须允许收缩到容器宽度，不能被无断点消息撑开',
);
assert.match(
  rule('.toast-body'),
  /min-width:\s*0;/,
  '通知正文 flex 项必须允许收缩，确保关闭按钮留在视口内',
);
assert.match(
  rule('.toast-body'),
  /overflow-wrap:\s*anywhere;/,
  '长 URL、错误码等无断点文本必须在通知正文内换行',
);

console.log('web toast long message layout tests passed');
