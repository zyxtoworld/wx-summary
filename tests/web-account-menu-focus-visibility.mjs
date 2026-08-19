import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as accountSelection from '../src/web/public/js/shared/account-selection.js';

assert.equal(
  typeof accountSelection.focusAccountMenuOption,
  'function',
  '账号菜单必须提供统一的可见聚焦边界',
);

const menu = { scrollTop: 0 };
let focusOptions = null;
const offscreenOption = {
  tabIndex: 0,
  focus(options) {
    focusOptions = options;
    // 模拟浏览器:允许滚动时,把菜单滚到目标项所在位置。
    if (options?.preventScroll === false) menu.scrollTop = 640;
  },
};

assert.equal(accountSelection.focusAccountMenuOption(offscreenOption), true);
assert.deepEqual(focusOptions, { preventScroll: false }, '键盘移动账号选项时必须允许菜单滚动到焦点项');
assert.equal(menu.scrollTop, 640, '长账号列表的焦点项必须进入可视区域');
assert.equal(accountSelection.focusAccountMenuOption(null), false, '缺少目标时必须安全 no-op');

const rovingOptions = Array.from({ length: 4 }, () => ({
  tabIndex: 0,
  focusCalls: [],
  focus(options) { this.focusCalls.push(options); },
}));
assert.equal(accountSelection.focusAccountMenuOption(rovingOptions[2], rovingOptions), true);
assert.deepEqual(
  rovingOptions.map(option => option.tabIndex),
  [-1, -1, 0, -1],
  'listbox 只能保留当前账号选项一个 Tab 停靠点',
);
assert.deepEqual(rovingOptions[2].focusCalls, [{ preventScroll: false }]);

const mainSource = await readFile(new URL('../src/web/public/js/main.js', import.meta.url), 'utf8');
assert.match(
  mainSource,
  /import \{[^}]*createAccountSelectionController[^}]*focusAccountMenuOption[^}]*\} from '\.\/shared\/account-selection\.js'/,
  '生产账号菜单必须接入统一可见聚焦 helper',
);
assert.equal(
  [...mainSource.matchAll(/focusAccountMenuOption\([^\n]+,\s*options\)/g)].length,
  4,
  '打开所选项、方向键移动、Home、End 四条路径都必须同步 roving Tab 停靠点并允许滚动',
);
assert.match(
  mainSource,
  /menu\?\.addEventListener\('focusout',[\s\S]*?setTimeout\([\s\S]*?!menu\.contains\(document\.activeElement\)[\s\S]*?toggleAccountMenu\(false\)/,
  'Tab 或 Shift+Tab 离开账号 listbox 后必须在当前事件结束后收起菜单',
);

console.log('web account menu focus visibility tests passed');
