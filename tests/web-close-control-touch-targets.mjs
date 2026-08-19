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

for (const selector of ['.toast-close', '.modal-x']) {
  const body = rule(selector);
  assert.match(body, /min-width:\s*32px;/, `${selector} 必须提供至少 32px 的水平点击区域`);
  assert.match(body, /min-height:\s*32px;/, `${selector} 必须提供至少 32px 的垂直点击区域`);
  assert.match(body, /place-items:\s*center;/, `${selector} 放大点击区域后必须保持关闭图标居中`);
}

console.log('web close control touch target tests passed');
