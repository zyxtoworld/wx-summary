import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { restoreActionFocus } from '../src/web/public/js/shared/action-focus.js';

function control(name, { connected = true, disabled = false } = {}) {
  return {
    name,
    isConnected: connected,
    disabled,
    focusOptions: null,
    focus(options) { this.focusOptions = options; },
  };
}

const body = control('body');
const removedRetry = control('removed-retry', { connected: false });
const replacementRetry = control('replacement-retry');
const firstGroup = control('first-group');

assert.equal(restoreActionFocus(removedRetry, {
  activeElement: body,
  body,
  fallbackTargets: [replacementRetry, firstGroup],
}), true, '重试按钮被重绘删除后必须把焦点交给当前替代控件');
assert.deepEqual(replacementRetry.focusOptions, { preventScroll: true });
assert.equal(firstGroup.focusOptions, null, '失败态存在新重试按钮时不得越过它聚焦群项');

const userTarget = control('user-target');
replacementRetry.focusOptions = null;
assert.equal(restoreActionFocus(removedRetry, {
  activeElement: userTarget,
  body,
  fallbackTargets: [replacementRetry],
}), false, '用户已移焦时异步完成不得抢回焦点');
assert.equal(replacementRetry.focusOptions, null);

assert.equal(restoreActionFocus(null, {
  activeElement: body,
  body,
  fallbackTargets: [firstGroup],
}), false, '指针触发或非显式动作没有焦点令牌时不得凭空聚焦 fallback');

const source = await readFile(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');
assert.match(source,
  /async function loadGroups\(\{\s*forceGroups = false,\s*focusTarget = null\s*\} = \{\}\)/,
  '群加载必须显式接收本次重试的焦点令牌');
assert.match(source,
  /captureActionFocus\(\[retry\],\s*globalThis\.document\?\.activeElement\)/,
  '错误态重试必须只在按钮确实持有焦点时捕获令牌');
assert.match(source,
  /operation\.isCurrent\(\)[\s\S]*?operation\.finish\(\)[\s\S]*?restoreActionFocus\(focusTarget,[\s\S]*?fallbackTargets:/,
  '只有当前群加载 operation 才能在结束后把焦点交给新重试按钮、首个群项或刷新按钮');
assert.match(source,
  /!page\.destroyed[\s\S]*?groupList\.isConnected/,
  '页面卸载或群列表脱离 DOM 后不得恢复焦点');

console.log('web digest group retry focus tests passed');
