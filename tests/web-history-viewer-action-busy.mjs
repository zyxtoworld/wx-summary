import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setHistoryDetailActionBusy } from '../src/web/public/js/pages/history/detail-action-focus.js';

let activeElement = null;
let focusCalls = 0;
const body = {};
const documentElement = {};
const buttons = [
  { dataset: { historyDetailAction: 'view-markdown' }, disabled: false, focus() { focusCalls += 1; activeElement = this; } },
  { dataset: { historyDetailAction: 'download-markdown' }, disabled: false, focus() { focusCalls += 1; activeElement = this; } },
];
const detail = {
  busy: false,
  actionsSlot: { querySelectorAll: () => buttons, contains: node => buttons.includes(node) },
};
const documentTarget = { get activeElement() { return activeElement; }, body, documentElement };
activeElement = buttons[0];

setHistoryDetailActionBusy({ detail, busy: true, documentTarget });
assert.equal(detail.busy, true);
assert.equal(buttons.every(button => button.disabled), true, '查看器请求期间详情动作必须全部禁用');

activeElement = { viewer: true };
setHistoryDetailActionBusy({
  detail,
  busy: false,
  restoreFocus: false,
  documentTarget,
  schedule: callback => callback(),
});
assert.equal(detail.busy, false);
assert.equal(buttons.every(button => !button.disabled), true, '查看器请求结束后详情动作必须恢复可用');
assert.equal(focusCalls, 0, '查看器仍在顶层时恢复按钮不得抢走弹层焦点');
assert.deepEqual(activeElement, { viewer: true });

const [helperSource, historySource] = await Promise.all([
  readFile(new URL('../src/web/public/js/pages/history/detail-action-focus.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/js/pages/history/index.js', import.meta.url), 'utf8'),
]);
assert.match(helperSource, /restoreFocus = true/,
  '详情忙态 helper 必须显式支持关闭焦点恢复的查看器结算模式');
assert.match(historySource, /openMarkdownViewer[\s\S]*?detailBusy\(true\)/,
  'MD 查看器必须通过统一忙态协调器禁用底层动作');
assert.match(historySource, /openImageViewer[\s\S]*?detailBusy\(true\)/,
  'PNG 查看器必须通过统一忙态协调器禁用底层动作');
assert.match(historySource, /detailBusy\(false,\s*\{\s*restoreFocus:\s*false\s*\}\)/,
  '查看器结算时必须恢复底层按钮但保留顶层查看器焦点');
assert.match(historySource,
  /openMarkdownViewer[\s\S]*?onClose:[\s\S]*?restoreHistoryDetailActionFocus\([\s\S]*?action:\s*'view-markdown'[\s\S]*?force:\s*true/,
  '关闭 MD 查看器后必须强制把焦点恢复到查看 MD 触发按钮');
assert.match(historySource,
  /openImageViewer[\s\S]*?onClose:[\s\S]*?restoreHistoryDetailActionFocus\([\s\S]*?action:\s*'open-image'[\s\S]*?force:\s*true/,
  '关闭 PNG 查看器后必须强制把焦点恢复到打开原图触发按钮');

console.log('web history viewer action busy tests passed');
