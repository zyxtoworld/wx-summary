import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  configureSetupAccountRadioGroup,
  setupAccountRadioNavigationIndex,
} from '../src/web/public/js/pages/setup/account-radio-group.js';

function createOption({ checked = false, disabled = false } = {}) {
  const attrs = new Map([['role', 'radio'], ['aria-checked', String(checked)]]);
  return {
    disabled,
    tabIndex: 0,
    focusCalls: [],
    clickCount: 0,
    getAttribute(name) { return attrs.get(name) ?? null; },
    setAttribute(name, value) { attrs.set(name, String(value)); },
    focus(options) { this.focusCalls.push(options); },
    click() { this.clickCount += 1; },
  };
}

const attrs = new Map();
const listeners = new Map();
const options = [
  createOption(),
  createOption({ checked: true }),
  createOption(),
  createOption(),
];
const group = {
  setAttribute(name, value) { attrs.set(name, String(value)); },
  addEventListener(type, listener) { listeners.set(type, listener); },
  removeEventListener(type, listener) {
    if (listeners.get(type) === listener) listeners.delete(type);
  },
  querySelectorAll(selector) {
    assert.equal(selector, '[role="radio"]');
    return options;
  },
};

const controller = configureSetupAccountRadioGroup(group, { label: '选择微信账号' });
controller.syncTabStops();
assert.equal(attrs.get('role'), 'radiogroup');
assert.equal(attrs.get('aria-label'), '选择微信账号');
assert.deepEqual(options.map(option => option.tabIndex), [-1, 0, -1, -1], '只有已选账号进入 Tab 序列');

assert.equal(setupAccountRadioNavigationIndex('ArrowDown', 1, 4), 2);
assert.equal(setupAccountRadioNavigationIndex('ArrowRight', 3, 4), 0);
assert.equal(setupAccountRadioNavigationIndex('ArrowUp', 0, 4), 3);
assert.equal(setupAccountRadioNavigationIndex('ArrowLeft', 2, 4), 1);
assert.equal(setupAccountRadioNavigationIndex('Home', 2, 4), 0);
assert.equal(setupAccountRadioNavigationIndex('End', 1, 4), 3);
assert.equal(setupAccountRadioNavigationIndex('Tab', 1, 4), -1);

let prevented = false;
listeners.get('keydown')?.({
  key: 'ArrowDown',
  target: options[1],
  preventDefault() { prevented = true; },
});
assert.equal(prevented, true);
assert.deepEqual(options[2].focusCalls, [{ preventScroll: false }], '方向键移动必须把目标账号滚入视口');
assert.equal(options[2].clickCount, 1, '方向键移动必须同步触发账号选择');

controller.destroy();
assert.equal(listeners.has('keydown'), false);

const source = await readFile(new URL('../src/web/public/js/pages/setup/step-account.js', import.meta.url), 'utf8');
assert.match(source, /configureSetupAccountRadioGroup/,
  '首次向导生产账号步骤必须接入 radio group 协调器');
assert.match(source, /accountRadioGroup\.syncTabStops\(\)/,
  '每次重绘账号列表后必须重建唯一 Tab 停靠点');
assert.match(source, /focus\(\{\s*preventScroll:\s*false\s*\}\)/,
  '异步刷新后恢复所选账号焦点时必须允许滚入视口');

console.log('web setup account radio keyboard tests passed');
