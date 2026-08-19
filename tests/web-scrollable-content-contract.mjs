import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

globalThis.location = new URL('http://wx-summary.test/#/history');
const loader = createBrowserModuleLoader();
const { makeScrollableRegion } = await loader.load('js/shared/scroll-region.js');

function fakeRegion() {
  return {
    tabIndex: -1,
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
  };
}

const content = fakeRegion();
makeScrollableRegion(content, { label: '重渲染预览滚动区域' });
assert.equal(content.tabIndex, 0);
assert.equal(content.attributes.get('role'), 'region');
assert.equal(content.attributes.get('aria-label'), '重渲染预览滚动区域');

const log = fakeRegion();
makeScrollableRegion(log, { label: '生成运行日志', role: 'log' });
assert.equal(log.tabIndex, 0, '长日志必须显式进入键盘 Tab 顺序');
assert.equal(log.attributes.get('role'), 'log', '动态日志必须保留日志语义');
assert.equal(log.attributes.get('aria-label'), '生成运行日志');

const historySource = await readFile(new URL('../src/web/public/js/pages/history/index.js', import.meta.url), 'utf8');
const progressSource = await readFile(new URL('../src/web/public/js/pages/digest/progress.js', import.meta.url), 'utf8');
const privacySource = await readFile(new URL('../src/web/public/js/pages/settings/privacy.js', import.meta.url), 'utf8');

assert.match(historySource,
  /const previewSlot = makeScrollableRegion\(el\('div', 'history-rerender-preview'\), \{\s*label: '重渲染预览滚动区域',\s*\}\);/,
  '历史重渲染预览必须显式使用共享滚动区域合同');
assert.match(progressSource, /import \{ makeScrollableRegion \} from '\/js\/shared\/scroll-region\.js';/);
assert.match(progressSource,
  /makeScrollableRegion\(logBox, \{ label: '生成运行日志', role: 'log' \}\);/,
  '生成日志必须可键盘滚动并暴露 log 语义');
assert.match(privacySource, /import \{ makeScrollableRegion \} from '\/js\/shared\/scroll-region\.js';/);
assert.match(privacySource,
  /const logPanel = makeScrollableRegion\(el\('div', \{ class: 'settings-log' \}\), \{\s*label: '应用运行日志',\s*role: 'log',\s*\}\);/,
  '设置日志必须可键盘滚动并暴露 log 语义');

console.log('web scrollable content contract tests passed');
