import assert from 'node:assert/strict';
import { createDialogFocusManager } from '../src/web/public/js/ui/dialog-focus.js';
import { captureActionFocus, restoreActionFocus } from '../src/web/public/js/shared/action-focus.js';
import { createRecoveryActionState } from '../src/web/public/js/pages/digest/recovery-action-state.js';

function control(name) {
  return {
    name,
    disabled: false,
    isConnected: true,
    focusCalls: 0,
    focusOptions: [],
    focus(options) {
      this.focusCalls += 1;
      this.focusOptions.push(options);
      documentTarget.activeElement = this;
    },
  };
}

const first = control('first');
const last = control('last');
const opener = control('opener');
const replacement = control('replacement');
const dialog = {
  tabIndex: -1,
  contains(node) { return node === first || node === last; },
  querySelectorAll() { return [first, last]; },
  focus() {
    documentTarget.activeElement = dialog;
  },
};
const listeners = new Map();
const documentTarget = {
  activeElement: opener,
  body: control('body'),
  documentElement: control('html'),
  addEventListener(type, listener) { listeners.set(type, listener); },
  removeEventListener(type, listener) {
    if (listeners.get(type) === listener) listeners.delete(type);
  },
};
const animationFrames = [];

const manager = createDialogFocusManager({
  dialog,
  opener,
  documentTarget,
  requestAnimationFrame: callback => animationFrames.push(callback),
});
manager.focusInitial();
assert.equal(documentTarget.activeElement, first, '打开对话框后焦点必须进入对话框');

listeners.get('keydown')({ key: 'Tab', shiftKey: true, preventDefault() { this.prevented = true; } });
assert.equal(documentTarget.activeElement, last, '焦点在第一个控件反向 Tab 必须循环到最后一个');
assert.deepEqual(last.focusOptions.at(-1), { preventScroll: false },
  '边界反向循环必须允许浏览器把末尾控件滚入可视区');
listeners.get('keydown')({ key: 'Tab', shiftKey: false, preventDefault() { this.prevented = true; } });
assert.equal(documentTarget.activeElement, first, '焦点在最后一个控件正向 Tab 必须循环到第一个');
assert.deepEqual(first.focusOptions.at(-1), { preventScroll: false },
  '边界正向循环必须允许浏览器把开头控件滚入可视区');

documentTarget.activeElement = replacement;
manager.dispose({ restore: true });
animationFrames.shift()?.();
assert.equal(documentTarget.activeElement, replacement, '调用方明确把焦点移到新控件时关闭对话框不得抢回焦点');

const secondManager = createDialogFocusManager({
  dialog,
  opener,
  documentTarget,
  requestAnimationFrame: callback => callback(),
});
documentTarget.activeElement = documentTarget.body;
secondManager.dispose({ restore: true });
assert.equal(documentTarget.activeElement, opener, '焦点丢失到 body 时关闭对话框必须恢复 opener');

// 嵌套弹窗时底层监听器不得抢走最上层弹窗的 Tab 焦点。
const nestedListeners = [];
const nestedDocument = {
  activeElement: null,
  querySelectorAll() { return [bottomDialog, topDialog]; },
  addEventListener(type, listener) { if (type === 'keydown') nestedListeners.push(listener); },
  removeEventListener(type, listener) {
    if (type !== 'keydown') return;
    const index = nestedListeners.indexOf(listener);
    if (index >= 0) nestedListeners.splice(index, 1);
  },
};
const nestedControl = name => ({
  name, disabled: false, isConnected: true, tabIndex: 0,
  focus() { nestedDocument.activeElement = this; },
});
const bottomFirst = nestedControl('bottom-first');
const bottomLast = nestedControl('bottom-last');
const topFirst = nestedControl('top-first');
const topLast = nestedControl('top-last');
const bottomDialog = {
  tabIndex: -1, isConnected: true,
  contains(node) { return node === bottomFirst || node === bottomLast; },
  querySelectorAll() { return [bottomFirst, bottomLast]; },
  focus() { nestedDocument.activeElement = this; },
};
const topDialog = {
  tabIndex: -1, isConnected: true,
  contains(node) { return node === topFirst || node === topLast; },
  querySelectorAll() { return [topFirst, topLast]; },
  focus() { nestedDocument.activeElement = this; },
};
const bottomManager = createDialogFocusManager({ dialog: bottomDialog, documentTarget: nestedDocument });
const topManager = createDialogFocusManager({ dialog: topDialog, documentTarget: nestedDocument });
topManager.focusInitial();
nestedDocument.activeElement = topLast;
const nestedTabEvent = { key: 'Tab', shiftKey: false, prevented: false, preventDefault() { this.prevented = true; } };
for (const listener of [...nestedListeners]) listener(nestedTabEvent);
assert.equal(nestedDocument.activeElement, topFirst, '嵌套弹窗正向 Tab 必须由最上层弹窗循环焦点');
assert.equal(nestedTabEvent.prevented, true, '最上层弹窗必须消费嵌套 Tab 事件');
bottomManager.dispose();
topManager.dispose();

const actionButton = control('action');
const otherControl = control('other');
assert.equal(captureActionFocus([actionButton], actionButton), actionButton, '操作开始时应记住触发按钮');
assert.equal(captureActionFocus([actionButton], otherControl), null, '未聚焦触发按钮时不应伪造恢复目标');
documentTarget.activeElement = documentTarget.body;
assert.equal(restoreActionFocus(actionButton, {
  activeElement: documentTarget.activeElement,
  body: documentTarget.body,
}), true, '焦点因禁用操作退回 body 时应恢复触发按钮');
documentTarget.activeElement = otherControl;
assert.equal(restoreActionFocus(actionButton, {
  activeElement: documentTarget.activeElement,
  body: documentTarget.body,
}), false, '用户已移焦时异步完成不得抢回焦点');
actionButton.disabled = true;
documentTarget.activeElement = documentTarget.body;
assert.equal(restoreActionFocus(actionButton, {
  activeElement: documentTarget.activeElement,
  body: documentTarget.body,
}), false, '目标仍禁用时不得恢复焦点');

const recoveryActions = createRecoveryActionState();
const recoveryAction = recoveryActions.begin('batch-recovery-1', 'recover');
assert.ok(recoveryAction, '同一批次第一次恢复操作应取得 lease');
assert.equal(recoveryActions.begin('batch-recovery-1', 'recover'), null,
  '恢复操作进行中不得因 storage 重绘再次取得 lease');
assert.equal(recoveryActions.begin('batch-recovery-2', 'recover'), null,
  '任一恢复操作进行中不得并发启动另一批次');
assert.equal(recoveryActions.isBusy(), true);
assert.equal(recoveryActions.isCurrent(recoveryAction), true);
recoveryActions.end(recoveryAction);
assert.equal(recoveryActions.isBusy(), false, '操作结束后必须释放恢复 lease');
assert.ok(recoveryActions.begin('batch-recovery-2', 'discard'), '释放后另一批次可以取得 lease');

console.log('web accessibility runtime tests passed');
