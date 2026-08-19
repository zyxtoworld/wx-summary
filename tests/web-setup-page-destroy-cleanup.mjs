import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/web/public/js/pages/setup/index.js', import.meta.url),
  'utf8',
);

function extractFunction(moduleSource, marker) {
  const start = moduleSource.indexOf(marker);
  assert.ok(start >= 0, `缺少生产函数: ${marker}`);
  const open = moduleSource.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < moduleSource.length; index += 1) {
    const char = moduleSource[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) {
      return moduleSource.slice(start, index + 1);
    }
  }
  throw new Error(`生产函数未闭合: ${marker}`);
}

const destroySource = extractFunction(source, 'page.destroy = () => {');

function makeDestroyHarness(step) {
  const page = {
    destroyed: false,
    initializing: true,
    completionNavigationPending: true,
    generation: 0,
    entering: 0,
  };
  const controller = new AbortController();
  const storeValues = new Map([['accountSwitchGuard', 'guard']]);
  const skipAction = { disposeCalls: 0, dispose() { this.disposeCalls += 1; } };
  const destroy = new Function(
    'page',
    'currentStep',
    'skipAction',
    'abortController',
    'store',
    'accountSwitchGuard',
    `${destroySource}\nreturn page.destroy;`,
  )(
    page,
    () => step,
    skipAction,
    controller,
    {
      get(key) { return storeValues.get(key); },
      set(key, value) { storeValues.set(key, value); },
    },
    'guard',
  );
  return { page, controller, skipAction, storeValues, destroy };
}

let stepExitCalls = 0;
const harness = makeDestroyHarness({
  onExit() {
    stepExitCalls += 1;
    assert.equal(harness.page.destroyed, true,
      '步骤清理开始前页面必须先进入 destroyed 状态');
  },
});

harness.destroy();
assert.equal(stepExitCalls, 1,
  '路由卸载必须调用当前步骤 onExit,同步撤销步骤自己持有的异步 owner');
assert.equal(harness.controller.signal.aborted, true,
  '路由卸载仍必须 abort 页面级 signal');
assert.equal(harness.skipAction.disposeCalls, 1,
  '路由卸载必须释放跳过动作监听器');
assert.equal(harness.storeValues.get('accountSwitchGuard'), null,
  '路由卸载必须清理向导账号切换 guard');

harness.destroy();
assert.equal(stepExitCalls, 1, '重复 destroy 不得重复运行步骤清理');

const throwing = makeDestroyHarness({
  onExit() {
    throw new Error('步骤清理异常');
  },
});
assert.doesNotThrow(() => throwing.destroy(),
  '单个步骤清理异常不得阻断页面级卸载收尾');
assert.equal(throwing.controller.signal.aborted, true,
  '步骤清理异常后仍必须 abort 页面级 signal');
assert.equal(throwing.storeValues.get('accountSwitchGuard'), null,
  '步骤清理异常后仍必须清理账号切换 guard');

console.log('web setup page destroy cleanup tests passed');
