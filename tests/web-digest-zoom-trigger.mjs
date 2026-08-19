import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

globalThis.location = new URL('http://wx-summary.test/#/digest');
const loader = createBrowserModuleLoader();
const { createResultZoomTrigger } = await loader.load('js/pages/digest/result-zoom-trigger.js');

const listeners = new Map();
const document = {
  createElement(tagName) {
    return {
      tagName: String(tagName).toUpperCase(),
      type: '',
      className: '',
      attributes: new Map(),
      children: [],
      setAttribute(name, value) { this.attributes.set(name, String(value)); },
      appendChild(child) { this.children.push(child); return child; },
      addEventListener(type, listener) { listeners.set(type, listener); },
      click() { listeners.get('click')?.({ currentTarget: this }); },
    };
  },
};
const canvas = { tagName: 'CANVAS' };
let openedCanvas = null;
const trigger = createResultZoomTrigger(canvas, {
  document,
  label: '打开合成群摘要长图预览',
  onOpen: value => { openedCanvas = value; },
});

assert.equal(trigger.tagName, 'BUTTON', '长图预览动作必须使用原生按钮语义');
assert.equal(trigger.type, 'button');
assert.equal(trigger.className, 'result-canvas-trigger');
assert.equal(trigger.attributes.get('aria-label'), '打开合成群摘要长图预览');
assert.deepEqual(trigger.children, [canvas], '按钮必须包裹保留图片语义的 canvas');
trigger.click();
assert.equal(openedCanvas, canvas, '鼠标与原生键盘 click 必须打开当前 canvas');
assert.equal(createResultZoomTrigger(null, { document, onOpen() {} }), null);

const digestSource = await readFile(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');
assert.match(digestSource, /import \{ createResultZoomTrigger \} from '\.\/result-zoom-trigger\.js';/,
  '摘要页生产代码必须接入原生长图预览按钮');
assert.match(digestSource, /createResultZoomTrigger\(visible, \{/,
  '渲染结果必须由可聚焦按钮承载缩放动作');
assert.doesNotMatch(digestSource, /visible\.addEventListener\('click', \(\) => openZoomModal\(visible\)\)/,
  'canvas 不得继续维护一套鼠标专用入口');

console.log('web digest zoom trigger tests passed');
