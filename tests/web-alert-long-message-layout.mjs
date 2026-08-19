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
  rule('.alert-bar'),
  /min-width:\s*0;/,
  '页面警示条必须允许收缩到内容容器宽度',
);
assert.match(
  rule('.alert-bar .alert-text'),
  /min-width:\s*0;/,
  '警示正文 flex 项必须允许收缩，不能把操作按钮推出视口',
);
assert.match(
  rule('.alert-bar .alert-text'),
  /overflow-wrap:\s*anywhere;/,
  '警示条里的长 URL、错误码等无断点文本必须换行',
);

console.log('web alert long message layout tests passed');
