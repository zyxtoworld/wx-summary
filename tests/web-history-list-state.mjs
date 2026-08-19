import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  historyItemMatchesFilter,
  historyListStatusTransition,
  requireHistoryListItems,
} from '../src/web/public/js/pages/history/list-state.js';

assert.deepEqual(requireHistoryListItems({ items: [] }), [], '空历史列表是合法成功响应');
assert.deepEqual(
  requireHistoryListItems({ items: [{ history_item_key: 'history-a' }] }),
  [{ history_item_key: 'history-a' }],
  '历史列表必须保留服务端返回的对象条目',
);
for (const malformed of [null, {}, { items: null }, { items: {} }, { items: [null] }, { items: ['bad'] }]) {
  assert.throws(
    () => requireHistoryListItems(malformed),
    error => error?.status === 502 && error?.code === 'history_list_response_invalid',
    '畸形历史列表响应必须使用固定 502 合同拒绝',
  );
}

const healthy = { has_blocking_issue: false };
const issue = { has_blocking_issue: true };

assert.equal(historyItemMatchesFilter(healthy, 'ok'), true);
assert.equal(historyItemMatchesFilter(issue, 'ok'), false);
assert.equal(historyItemMatchesFilter(healthy, 'issues'), false);
assert.equal(historyItemMatchesFilter(issue, 'issues'), true);
assert.equal(historyItemMatchesFilter(healthy, 'all'), true);
assert.equal(historyItemMatchesFilter(issue, 'all'), true);

assert.deepEqual(historyListStatusTransition(healthy, issue, 'ok'), {
  action: 'remove',
  totalDelta: -1,
  okDelta: -1,
  issueDelta: 1,
});
assert.deepEqual(historyListStatusTransition(issue, healthy, 'issues'), {
  action: 'remove',
  totalDelta: -1,
  okDelta: 1,
  issueDelta: -1,
});
assert.deepEqual(historyListStatusTransition(healthy, issue, 'all'), {
  action: 'replace',
  totalDelta: 0,
  okDelta: -1,
  issueDelta: 1,
});
assert.deepEqual(historyListStatusTransition(healthy, healthy, 'ok'), {
  action: 'replace',
  totalDelta: 0,
  okDelta: 0,
  issueDelta: 0,
});

const historySource = await readFile(new URL('../src/web/public/js/pages/history/index.js', import.meta.url), 'utf8');
assert.match(historySource, /function reconcileHistoryListItem\(nextItem, \{ fallbackItem = null \} = \{\}\)/,
  '生产列表必须集中处理状态迁移');
assert.ok((historySource.match(/reconcileHistoryListItem\(/g) || []).length >= 5,
  '详情重验、显式刷新、动作结果与源记录定位必须复用同一状态迁移');
assert.doesNotMatch(historySource, /if \(index >= 0\) page\.items\.splice\(index, 1, next\)/,
  '状态刷新不得再绕过筛选与计数直接替换数组项');

console.log('web history list-state tests passed');
