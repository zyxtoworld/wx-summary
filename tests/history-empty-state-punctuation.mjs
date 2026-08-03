import assert from 'node:assert/strict';
import fs from 'node:fs';

const appSource = fs.readFileSync(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const start = appSource.indexOf('  function historyEmptyText() {');
const end = appSource.indexOf('\n  function historyFilterStatusText(', start);

assert.ok(start >= 0 && end > start, 'history empty-state formatter should remain available');
const emptyStateSource = appSource.slice(start, end);

assert.equal(
  emptyStateSource.includes('${partial}；可清空上方搜索查看全部历史。'),
  false,
  'a complete partial-result sentence must not be followed by another semicolon',
);
assert.ok(
  emptyStateSource.includes('没有匹配的异常记录。${partial}可清空上方搜索查看全部历史。')
    && emptyStateSource.includes('没有匹配的正常摘要。${partial}可清空上方搜索查看全部历史。'),
  'normal and issue searches should compose complete sentences without duplicate punctuation',
);

console.log('History empty-state punctuation tests passed');
