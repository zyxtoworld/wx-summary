import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  captureHistoryDetailActionFocus,
  restoreHistoryDetailActionFocus,
  setHistoryDetailActionBusy,
} from '../src/web/public/js/pages/history/detail-action-focus.js';

const body = { name: 'body', isConnected: true };
const html = { name: 'html', isConnected: true };
const documentTarget = { activeElement: body, body, documentElement: html };
const replacement = {
  disabled: false,
  isConnected: true,
  focusCalls: 0,
  focus() {
    this.focusCalls += 1;
    documentTarget.activeElement = this;
  },
};
const deleteReplacement = {
  disabled: false,
  isConnected: true,
  focusCalls: 0,
  focus() {
    this.focusCalls += 1;
    documentTarget.activeElement = this;
  },
};
const dialog = {
  isConnected: true,
  focusCalls: 0,
  focus() {
    this.focusCalls += 1;
    documentTarget.activeElement = this;
  },
};
const detail = {
  actionsSlot: {
    contains(node) {
      return node === focusedAction;
    },
    querySelector(selector) {
      if (selector === '[data-history-detail-action="rerender"]') return replacement;
      if (selector === '[data-history-detail-action="delete"]') return deleteReplacement;
      assert.fail(`unexpected detail action selector: ${selector}`);
    },
  },
  modal: { el: dialog },
};
const focusedAction = {
  disabled: false,
  isConnected: true,
  dataset: { historyDetailAction: 'delete' },
};
const permanentlyDisabledAction = {
  disabled: true,
  isConnected: true,
  dataset: { disabledReason: '1', historyDetailAction: 'unavailable' },
};
detail.actionsSlot.querySelectorAll = () => [focusedAction, permanentlyDisabledAction];
const scheduled = [];
const schedule = callback => scheduled.push(callback);

documentTarget.activeElement = focusedAction;
assert.equal(captureHistoryDetailActionFocus({ detail, documentTarget }), 'delete',
  '重绘前必须捕获当前详情操作的稳定语义身份');
documentTarget.activeElement = body;
assert.equal(captureHistoryDetailActionFocus({ detail, documentTarget }), '',
  '焦点不在详情操作区时不得伪造恢复目标');

documentTarget.activeElement = focusedAction;
detail.busy = false;
detail.busyFocusAction = '';
assert.equal(setHistoryDetailActionBusy({
  detail,
  busy: true,
  documentTarget,
  schedule,
  isActive: () => true,
}), true);
assert.equal(detail.busy, true);
assert.equal(detail.busyFocusAction, 'delete', '首次进入忙态必须在禁用前保存焦点身份');
assert.equal(focusedAction.disabled, true);
assert.equal(permanentlyDisabledAction.disabled, true);
documentTarget.activeElement = body;
setHistoryDetailActionBusy({ detail, busy: true, documentTarget, schedule, isActive: () => true });
assert.equal(detail.busyFocusAction, 'delete', '忙态重绘再次禁用按钮时不得用 body 覆盖原身份');
setHistoryDetailActionBusy({ detail, busy: false, documentTarget, schedule, isActive: () => true });
assert.equal(focusedAction.disabled, false, '忙态结束必须恢复普通操作');
assert.equal(permanentlyDisabledAction.disabled, true, '业务条件不可用的按钮不得被忙态结束误启用');
scheduled.shift()();
assert.equal(documentTarget.activeElement, deleteReplacement, '忙态结束必须恢复替代操作按钮焦点');

documentTarget.activeElement = body;
restoreHistoryDetailActionFocus({
  detail,
  action: 'delete',
  documentTarget,
  schedule,
  isActive: () => true,
});
scheduled.shift()();
assert.equal(documentTarget.activeElement, deleteReplacement,
  '异步重绘后必须按捕获到的语义身份恢复替代按钮');

documentTarget.activeElement = body;
assert.equal(restoreHistoryDetailActionFocus({
  detail,
  action: 'rerender',
  documentTarget,
  schedule,
  isActive: () => true,
}), true);
assert.equal(scheduled.length, 1);
scheduled.shift()();
assert.equal(documentTarget.activeElement, replacement, '内层弹窗成功关闭后必须聚焦详情中的替代操作按钮');
assert.equal(replacement.focusCalls, 1);

const explicit = { isConnected: true };
documentTarget.activeElement = explicit;
restoreHistoryDetailActionFocus({ detail, action: 'rerender', documentTarget, schedule, isActive: () => true });
scheduled.shift()();
assert.equal(documentTarget.activeElement, explicit, '已有显式焦点时不得抢焦点');

documentTarget.activeElement = explicit;
restoreHistoryDetailActionFocus({
  detail,
  action: 'delete',
  documentTarget,
  schedule,
  isActive: () => true,
  force: true,
});
scheduled.shift()();
assert.equal(documentTarget.activeElement, deleteReplacement,
  '嵌套确认关闭后浏览器的临时底层焦点不得阻止恢复到重绘后的危险操作按钮');

documentTarget.activeElement = body;
replacement.disabled = true;
restoreHistoryDetailActionFocus({ detail, action: 'rerender', documentTarget, schedule, isActive: () => true });
scheduled.shift()();
assert.equal(documentTarget.activeElement, dialog, '替代按钮不可用时焦点至少必须留在仍打开的详情对话框');

documentTarget.activeElement = body;
restoreHistoryDetailActionFocus({ detail, action: 'rerender', documentTarget, schedule, isActive: () => false });
scheduled.shift()();
assert.equal(documentTarget.activeElement, body, '详情已失效时不得写焦点');

const historySource = await readFile(
  new URL('../src/web/public/js/pages/history/index.js', import.meta.url),
  'utf8',
);
assert.match(historySource, /const focusedAction = captureHistoryDetailActionFocus\(\{ detail \}\);/,
  '生产详情更新必须在替换操作区前捕获焦点身份');
assert.match(historySource, /renderDetailBody\(\);\s*if \(focusedAction\) \{\s*restoreHistoryDetailActionFocus\(/,
  '生产详情更新必须在重绘后恢复捕获到的操作身份');
assert.match(historySource, /action: 'delete'/,
  '生产危险操作必须提供稳定语义身份，确保状态重校验后可恢复');
assert.match(historySource,
  /async function confirmDelete\(item\)[\s\S]*?if \(!detail \|\| detail\.busy \|\| detail\.deleteConfirmPending\) return;[\s\S]*?detailBusy\(true\);[\s\S]*?await ui\.confirmDialog\([\s\S]*?finally \{[\s\S]*?detail\.deleteConfirmPending = false;[\s\S]*?detailBusy\(false\)/,
  '删除确认必须先取得唯一详情 owner,取消/异常时由 busy 生命周期恢复替代按钮焦点');
assert.match(historySource,
  /detailBusy\(false, \{ restoreFocus: false \}\);\s*handedOffToDeleteAction = true;\s*await runDetailAction\(/,
  '删除目标核验通过后必须明确把 busy 交给真正删除 action,不能由确认流程重复释放');
assert.match(historySource, /setHistoryDetailActionBusy\(\{\s*detail,\s*busy: flag,/,
  '生产详情忙态必须接入经过行为测试的焦点生命周期 helper');
assert.match(historySource,
  /if \(outcome\.status === 'cancelled'\) \{\s*if \(page\.detail === detail && detail\.busy\) \{\s*detailBusy\(false\);\s*setDetailStatus\(`\$\{label\}已取消。`\);\s*}\s*return;/,
  '详情操作取消后必须释放忙态并结算状态文案，不能永久显示“进行中”');

console.log('web history detail action focus tests passed');
