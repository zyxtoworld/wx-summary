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

for (const selector of ['.boot-failure', '.page-load-failure', '.empty-state']) {
  const body = rule(selector);
  assert.match(
    body,
    /min-width:\s*0;/,
    `${selector} 必须允许收缩到窄屏容器`,
  );
  assert.match(
    body,
    /overflow-wrap:\s*anywhere;/,
    `${selector} 展示的长异常、URL 或错误码必须在卡片内换行`,
  );
}

console.log('web failure long message layout tests passed');
