import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { historyActionResultTarget } from '../src/web/public/js/pages/history/action-target.js';

const itemKey = item => item?.key || '';
const actionItem = { key: 'history-a' };
const unrelatedOutcomeItem = { key: 'history-b' };

assert.equal(historyActionResultTarget({ actionItem, outcomeItem: unrelatedOutcomeItem, itemKey }), actionItem,
  '动作启动时捕获的目标必须优先于任何后来上下文或结果项');
assert.equal(historyActionResultTarget({ actionItem: null, outcomeItem: unrelatedOutcomeItem, itemKey }), unrelatedOutcomeItem,
  '没有动作目标时才允许回退到响应项');
assert.equal(historyActionResultTarget({ actionItem: {}, outcomeItem: {}, itemKey }), null,
  '缺少稳定身份时必须 fail closed');

const historySource = await readFile(new URL('../src/web/public/js/pages/history/index.js', import.meta.url), 'utf8');
assert.match(historySource, /const actionItem = detail\.item;/,
  '通用详情动作必须在请求前捕获目标项');
assert.ok((historySource.match(/applyOutcomeItem\(outcome, \{ replacesItem, removesItem, actionItem \}\)/g) || []).length >= 3,
  '详情关闭前后及已提交分支必须统一传入捕获目标');
assert.doesNotMatch(historySource, /const current = page\.detail\?\.item \|\| outcome\.item/,
  '结果归并不得从后来打开的详情反查动作目标');

console.log('web history action target identity tests passed');
