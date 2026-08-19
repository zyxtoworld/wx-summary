import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/web/public/js/pages/history/index.js', import.meta.url),
  'utf8',
);

assert.match(
  source,
  /page\.status = 'loading';[\s\S]*?refreshBtn\.disabled = true;[\s\S]*?renderAll\(\);/,
  '历史列表请求开始时必须禁用刷新按钮,避免重复点击创建并发请求',
);
assert.match(
  source,
  /if \(page\.listController === controller\) \{[\s\S]*?page\.listController = null;[\s\S]*?refreshBtn\.disabled = false;/,
  '当前历史列表请求结束时必须恢复刷新按钮,旧请求不能提前解除新请求的 busy 状态',
);

console.log('web history refresh action busy tests passed');
