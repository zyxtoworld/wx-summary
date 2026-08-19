import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  activateSettingsNavItem,
  settingsNavScrollDelta,
} from '../src/web/public/js/pages/settings/nav-scroll.js';

const source = await readFile(
  new URL('../src/web/public/js/pages/settings/index.js', import.meta.url),
  'utf8',
);
const css = await readFile(
  new URL('../src/web/public/css/settings.css', import.meta.url),
  'utf8',
);

assert.match(source,
  /settingsNavItemFromFocusEvent[\s\S]*?closest\?\.\('\.settings-nav-item'\)[\s\S]*?nav\.contains\(target\)/,
  '设置导航必须只处理自身分区按钮的焦点事件');
assert.match(source,
  /nav\.addEventListener\('focusin',[\s\S]*?scrollSettingsNavItemIntoView\(nav, target\)/,
  '横向设置导航必须用自身滚动容器把焦点分区完整滚入可视区');
assert.match(source,
  /nav\.addEventListener\('focusin',[\s\S]*?setTimeout\([\s\S]*?state\.destroyed[\s\S]*?!nav\.isConnected[\s\S]*?document\.activeElement !== target[\s\S]*?scrollSettingsNavItemIntoView\(nav, target\)[\s\S]*?,\s*0\)/,
  '焦点滚动必须在浏览器默认聚焦滚动后的任务中校正，并在页面卸载或焦点变化时停止');
assert.doesNotMatch(source,
  /target\?\.scrollIntoView\(/,
  '不得依赖 Chromium 对部分可见元素不滚动的 inline nearest 行为');
assert.match(css,
  /@media \(max-width: 900px\)[\s\S]*?\.settings-nav\s*\{[\s\S]*?scroll-padding-inline:\s*8px/,
  '窄屏设置导航必须为焦点轮廓保留横向滚动内边距');
assert.match(css,
  /@media \(max-width: 900px\)[\s\S]*?\.settings-nav\s*\{[\s\S]*?scrollbar-width:\s*none;[\s\S]*?-ms-overflow-style:\s*none;/,
  '窄屏设置导航必须隐藏 Firefox/旧 Edge 的原生滚动条外观');
assert.match(css,
  /@media \(max-width: 900px\)[\s\S]*?\.settings-nav::\-webkit-scrollbar\s*\{\s*display:\s*none;/,
  '窄屏设置导航必须隐藏 Chromium/WebKit 的原生滚动条外观');

assert.equal(settingsNavScrollDelta({ navLeft: 12, navRight: 298, itemLeft: 270, itemRight: 362, inset: 8 }), 72,
  '右侧只露出一部分的按钮必须向右滚到含内边距的完整可见位置');
assert.equal(settingsNavScrollDelta({ navLeft: 12, navRight: 298, itemLeft: -20, itemRight: 70, inset: 8 }), -40,
  '左侧只露出一部分的按钮必须向左滚到含内边距的完整可见位置');
assert.equal(settingsNavScrollDelta({ navLeft: 12, navRight: 298, itemLeft: 40, itemRight: 160, inset: 8 }), 0,
  '完整可见的按钮不得引发导航抖动');

const clickNav = {
  scrollLeft: 0,
  getBoundingClientRect: () => ({ left: 12, right: 298 }),
};
const clickedItem = {
  getBoundingClientRect: () => ({ left: 365, right: 443 }),
};
let activated = 0;
const previousGetComputedStyle = globalThis.getComputedStyle;
globalThis.getComputedStyle = () => ({ scrollPaddingInlineStart: '8px' });
try {
  assert.equal(activateSettingsNavItem(clickNav, clickedItem, () => { activated += 1; }), 153,
    '指针或触摸激活末端分区时必须把按钮完整滚入可视区');
} finally {
  if (previousGetComputedStyle === undefined) delete globalThis.getComputedStyle;
  else globalThis.getComputedStyle = previousGetComputedStyle;
}
assert.equal(activated, 1, '一次导航激活只能切换一次分区');
assert.equal(clickNav.scrollLeft, 153, '点击路径不能依赖浏览器是否为按钮派发 focusin');
assert.match(source,
  /onclick:\s*\(\) => activateSettingsNavItem\(nav, btn, \(\) => switchSection\(item\.id\)\)/,
  '设置分区点击必须接入同一可见性边界');

console.log('web settings nav focus visibility tests passed');
