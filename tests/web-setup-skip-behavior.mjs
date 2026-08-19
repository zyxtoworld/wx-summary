import assert from 'node:assert/strict';
import { createSetupSkipAction } from '../src/web/public/js/pages/setup/skip-action.js';

class FakeButton {
  constructor() {
    this.disabled = false;
    this.listener = null;
  }

  addEventListener(type, listener) {
    assert.equal(type, 'click');
    this.listener = listener;
  }

  removeEventListener(type, listener) {
    assert.equal(type, 'click');
    if (this.listener === listener) this.listener = null;
  }

  click() {
    return this.listener?.({ currentTarget: this, target: this });
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(nextResolve => { resolve = nextResolve; });
  return { promise, resolve };
}

let stepIndex = 1;
let destroyed = false;
let pending = false;
let refreshCount = 0;
let navigationCount = 0;
const confirmations = [];
const button = new FakeButton();

const action = createSetupSkipAction({
  button,
  isBusy: () => false,
  getStepIndex: () => stepIndex,
  isDestroyed: () => destroyed,
  confirmDialog: () => {
    const confirmation = deferred();
    confirmations.push(confirmation);
    return confirmation.promise;
  },
  onPendingChange: value => { pending = value; },
  refreshButtons: () => { refreshCount += 1; },
  gotoStep: next => {
    stepIndex = next;
    navigationCount += 1;
  },
  markKeySkipped: () => assert.fail('AI 步骤不应走数据库密钥跳过分支'),
  showNotice: () => assert.fail('AI 步骤不应显示数据库密钥提示'),
});

const firstClick = button.click();
assert.equal(confirmations.length, 1, '第一次点击应打开一个确认框');
assert.equal(button.disabled, true, '确认等待期间跳过按钮必须立即禁用');
assert.equal(pending, true, '确认等待期间向导必须持有跳过动作锁');

const secondClick = button.click();
assert.equal(confirmations.length, 1, '确认等待期间第二次点击不得打开第二个确认框');
confirmations[0].resolve(true);
assert.equal(await firstClick, true);
assert.equal(await secondClick, false);
assert.equal(stepIndex, 2, '一次确认只能推进一个步骤');
assert.equal(navigationCount, 1);
assert.equal(pending, false, '确认结束后必须释放跳过动作锁');
assert.equal(button.disabled, false, '确认结束后必须恢复跳过按钮');
assert.ok(refreshCount >= 2, '锁定和释放都必须刷新导航控件');

// 确认期间即使另一个真实导航先改变了步骤,晚到确认也不得再按新步骤递进。
stepIndex = 1;
const lateClick = button.click();
assert.equal(confirmations.length, 2);
stepIndex = 2;
confirmations[1].resolve(true);
assert.equal(await lateClick, false);
assert.equal(stepIndex, 2, '晚到确认不得从已变化的步骤继续推进');
assert.equal(navigationCount, 1);

action.dispose();
assert.equal(button.listener, null, '销毁动作必须移除 DOM 监听器');

// 确认框尚未结算时页面卸载:dispose 已经释放 pending,迟到 finally 不得重复
// 向页面状态写入一次相同的释放事件。
{
  let disposedStep = 1;
  const disposedConfirmation = deferred();
  const pendingEvents = [];
  const disposedButton = new FakeButton();
  const disposedAction = createSetupSkipAction({
    button: disposedButton,
    getStepIndex: () => disposedStep,
    confirmDialog: () => disposedConfirmation.promise,
    onPendingChange: value => pendingEvents.push(value),
  });
  const disposedRun = disposedButton.click();
  assert.deepEqual(pendingEvents, [true], '确认等待必须先只建立一次 pending');
  disposedAction.dispose();
  assert.deepEqual(pendingEvents, [true, false], '卸载必须释放自己的 pending');
  disposedConfirmation.resolve(true);
  assert.equal(await disposedRun, false, '卸载后的迟到确认不得继续推进步骤');
  assert.deepEqual(pendingEvents, [true, false],
    '迟到 finally 不得重复释放已由 dispose 释放的 pending');
}

// 确认组件异常时，DOM click listener 不能留下 rejected Promise；
// 该异常应按用户拒绝处理，释放自己的 pending 且不得推进步骤。
{
  const errorButton = new FakeButton();
  const errorPendingEvents = [];
  let errorNavigationCount = 0;
  const errorAction = createSetupSkipAction({
    button: errorButton,
    getStepIndex: () => 1,
    confirmDialog: async () => { throw new Error('确认组件异常'); },
    onPendingChange: value => errorPendingEvents.push(value),
    gotoStep: () => { errorNavigationCount += 1; },
  });
  const errorRun = errorButton.click();
  assert.equal(await errorRun, false,
    '确认组件抛错时跳过动作必须按拒绝结束,不能向 DOM 事件泄漏 rejected Promise');
  assert.deepEqual(errorPendingEvents, [true, false],
    '确认组件抛错后必须释放跳过动作 pending');
  assert.equal(errorNavigationCount, 0,
    '确认组件抛错后不得推进向导步骤');
  assert.equal(errorAction.isPending(), false);
  errorAction.dispose();
}

console.log('web setup skip behavior tests passed');
