import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

globalThis.location = new URL('http://wx-summary.test/#/history');
const loader = createBrowserModuleLoader();
const { makeScrollableRegion } = await loader.load('js/shared/scroll-region.js');

const attributes = new Map();
const pre = {
  tabIndex: -1,
  setAttribute(name, value) { attributes.set(name, String(value)); },
};
assert.equal(makeScrollableRegion(pre, { label: 'Markdown 内容滚动区域' }), pre);
assert.equal(pre.tabIndex, 0, '长 Markdown 内容必须进入键盘 Tab 顺序');
assert.equal(attributes.get('role'), 'region');
assert.equal(attributes.get('aria-label'), 'Markdown 内容滚动区域');
assert.equal(makeScrollableRegion(null), null);

const historySource = await readFile(new URL('../src/web/public/js/pages/history/index.js', import.meta.url), 'utf8');
const zoomSource = await readFile(new URL('../src/web/public/js/shared/zoom-region.js', import.meta.url), 'utf8');
const historyCss = await readFile(new URL('../src/web/public/css/history.css', import.meta.url), 'utf8');
assert.match(historySource, /import \{ makeScrollableRegion \} from '\/js\/shared\/scroll-region\.js';/,
  '历史页必须接入共享滚动区域能力');
assert.match(historySource, /makeScrollableRegion\(el\('pre', 'history-md-view'\), \{\s*label: 'Markdown 内容滚动区域',\s*\}\)/,
  'MD 查看器必须把真正发生滚动的 pre 配置为可聚焦区域');
assert.match(zoomSource, /makeScrollableRegion\(region, \{ label: '100% 长图滚动区域' \}\)/,
  '长图与 Markdown 不得复制两套滚动区域语义');
assert.match(historyCss, /\.history-md-view:focus-visible\s*\{/,
  '暗色和浅色主题都必须显示 MD 滚动区域的键盘焦点');

console.log('web history markdown region tests passed');
