import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');

const syncStart = source.indexOf('function syncInputControls()');
const syncEnd = source.indexOf('\n  // -------------------------------------------------------------------------', syncStart);
assert.ok(syncStart >= 0 && syncEnd > syncStart, '必须能定位摘要页统一输入状态同步函数');
const syncSource = source.slice(syncStart, syncEnd);
for (const contract of [
  ['时间范围', '[data-range-key]'],
  ['发送人过滤', 'senderChips.setDisabled(locked)'],
  ['关键词过滤', 'keywordChips.setDisabled(locked)'],
  ['主题', '[data-render-theme]'],
  ['字号', '[data-render-fontsize]'],
]) {
  assert.ok(syncSource.includes(contract[1]), `统一输入状态同步必须覆盖${contract[0]}`);
}

const lockStart = source.indexOf('function lockInputs(locked)');
const lockEnd = source.indexOf('\n  function currentRangeOrError', lockStart);
assert.ok(lockStart >= 0 && lockEnd > lockStart, '必须能定位摘要生成忙态入口');
const lockSource = source.slice(lockStart, lockEnd);
assert.match(
  lockSource,
  /page\.running = locked;[\s\S]*syncInputControls\(\);[\s\S]*syncSelectionUi\(\);/,
  '摘要生成忙态必须通过统一同步锁定时间范围、过滤、渲染选项和最近群入口',
);

const selectionStart = source.indexOf('function syncSelectionUi()');
const selectionEnd = source.indexOf('\n  async function loadGroups', selectionStart);
assert.ok(selectionStart >= 0 && selectionEnd > selectionStart, '必须能定位摘要选择状态同步函数');
assert.match(
  source.slice(selectionStart, selectionEnd),
  /renderRecentRefs\(\);/,
  '选择状态同步必须重建最近群入口，确保忙态不会留下可点击的旧按钮',
);

console.log('web digest input lock tests passed');
