import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(
  new URL('../src/web/public/css/app.css', import.meta.url),
  'utf8',
);

function declarations(selector) {
  const match = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .find(([, selectors]) => selectors.split(',').some(item => item.trim() === selector));
  assert.ok(match, `必须存在 ${selector} 样式`);
  return match[2];
}

assert.match(
  declarations('.content'),
  /overflow-y:\s*auto;/,
  '页面内容区必须是壳层自己的纵向滚动容器',
);
assert.match(
  declarations('body.modal-open'),
  /overflow:\s*hidden;/,
  '打开弹层时仍必须锁住 body',
);
assert.match(
  declarations('body.modal-open .content'),
  /overflow:\s*hidden;/,
  '打开弹层时必须同时锁住实际页面滚动容器，避免背景与弹层出现双滚动条',
);

console.log('web modal scroll lock tests passed');
