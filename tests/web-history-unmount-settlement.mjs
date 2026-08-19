import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/web/public/js/pages/history/index.js', import.meta.url),
  'utf8',
);

const firstStart = source.indexOf('  async function loadFirstPage(');
const firstEnd = source.indexOf('\n  async function loadMore(', firstStart);
const moreStart = firstEnd;
const moreEnd = source.indexOf('\n  // -------------------------------------------------------------------------', moreStart);
assert.ok(firstStart >= 0 && firstEnd > firstStart, '必须能定位历史首屏加载生命周期');
assert.ok(moreStart >= 0 && moreEnd > moreStart, '必须能定位历史分页加载生命周期');

const firstSource = source.slice(firstStart, firstEnd);
const moreSource = source.slice(moreStart, moreEnd);

assert.match(
  firstSource,
  /if \(page\.listController === controller\) \{[\s\S]*?page\.listController = null;[\s\S]*?if \(!page\.destroyed\) \{[\s\S]*?refreshBtn\.disabled = false;/,
  '首屏请求 finally 在页面销毁后不得恢复刷新按钮或写入 DOM',
);
assert.match(
  moreSource,
  /if \(page\.moreController === controller\) \{[\s\S]*?page\.moreController = null;[\s\S]*?if \(!page\.destroyed\) \{[\s\S]*?renderMore\(\);/,
  '分页请求 finally 在页面销毁后不得重绘分页控件',
);

console.log('web history unmount settlement tests passed');
