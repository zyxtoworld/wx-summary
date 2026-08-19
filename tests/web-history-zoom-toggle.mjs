import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

globalThis.location = new URL('http://wx-summary.test/#/history');
const loader = createBrowserModuleLoader();
const { createHistoryZoomToggle } = await loader.load('js/pages/history/zoom-toggle.js');

function createNode(tagName) {
  const listeners = new Map();
  return {
    tagName: String(tagName).toUpperCase(),
    type: '',
    className: '',
    textContent: '',
    title: '',
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    addEventListener(type, listener) { listeners.set(type, listener); },
    click() { listeners.get('click')?.({ currentTarget: this }); },
  };
}

const classes = new Set(['history-zoom-img', 'fit']);
const image = createNode('img');
image.classList = {
  contains(name) { return classes.has(name); },
  toggle(name) {
    if (classes.has(name)) {
      classes.delete(name);
      return false;
    }
    classes.add(name);
    return true;
  },
};
const document = { createElement: createNode };
const toggle = createHistoryZoomToggle(image, { document });

assert.equal(toggle.tagName, 'BUTTON', '缩放模式必须由原生按钮控制');
assert.equal(toggle.type, 'button');
assert.equal(toggle.className, 'btn btn-ghost btn-sm history-zoom-toggle');
assert.equal(toggle.textContent, '查看 100%');
assert.equal(toggle.attributes.get('aria-pressed'), 'false');
assert.equal(toggle.attributes.get('aria-label'), '查看 100% 原图');
assert.equal(image.title, '点击查看 100% 原图');

toggle.click();
assert.equal(classes.has('fit'), false);
assert.equal(toggle.textContent, '适应宽度');
assert.equal(toggle.attributes.get('aria-pressed'), 'true');
assert.equal(toggle.attributes.get('aria-label'), '按宽度适应原图');
assert.equal(image.title, '点击按宽度适应原图');

image.click();
assert.equal(classes.has('fit'), true, '图片点击必须复用按钮的同一切换状态机');
assert.equal(toggle.textContent, '查看 100%');
assert.equal(toggle.attributes.get('aria-pressed'), 'false');
assert.equal(createHistoryZoomToggle(null, { document }), null);

const historySource = await readFile(new URL('../src/web/public/js/pages/history/index.js', import.meta.url), 'utf8');
assert.match(historySource, /import \{ createHistoryZoomToggle \} from '\.\/zoom-toggle\.js';/,
  '历史页生产代码必须接入共享缩放切换控件');
assert.match(historySource, /const zoomToggle = createHistoryZoomToggle\(img\);/);
assert.match(historySource, /wrapBox\.replaceChildren\(zoomToggle, scrollRegion\);/);
assert.doesNotMatch(historySource, /img\.addEventListener\('click', \(\) => img\.classList\.toggle\('fit'\)\)/,
  '生产页不得保留鼠标专用的第二套切换逻辑');

const historyCss = await readFile(new URL('../src/web/public/css/history.css', import.meta.url), 'utf8');
const zoomScrollRule = historyCss.match(/\.history-zoom-scroll\s*\{([^}]*)\}/s)?.[1] || '';
assert.match(zoomScrollRule, /\bmax-height:\s*clamp\(200px,\s*calc\(84vh\s*-\s*160px\),\s*70vh\);/,
  '原图滚动区必须为弹层三行标题、内边距和缩放按钮预留高度，避免键盘聚焦时外层滚动并遮住按钮');

console.log('web history zoom toggle tests passed');
