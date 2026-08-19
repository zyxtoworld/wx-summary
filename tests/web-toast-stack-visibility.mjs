import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(
  new URL('../src/web/public/css/app.css', import.meta.url),
  'utf8',
);
const rootRule = css.match(/\.toast-root\s*\{([^}]+)\}/)?.[1] || '';

assert.ok(rootRule, '必须存在共享通知容器样式');
assert.match(
  rootRule,
  /max-height:\s*calc\(100dvh\s*-\s*var\(--toast-top,\s*16px\)\s*-\s*16px\);/,
  '通知堆叠必须限制在动态视口中实际可用的顶部避让区域内',
);
assert.match(rootRule, /overflow-y:\s*auto;/, '超出视口的通知必须能在容器内滚动到达');
assert.match(rootRule, /overflow-x:\s*hidden;/, '通知入场位移不得让根容器出现横向滚动条');
assert.match(rootRule, /overscroll-behavior:\s*contain;/, '滚动通知堆叠时不得把滚动继续传给底层页面');

console.log('web toast stack visibility tests passed');
