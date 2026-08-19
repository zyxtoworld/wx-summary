import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

globalThis.location = new URL('http://wx-summary.test/#/history');
const loader = createBrowserModuleLoader();
const { createZoomRegion } = await loader.load('js/shared/zoom-region.js');

const document = {
  createElement(tagName) {
    return {
      tagName,
      className: '',
      tabIndex: -1,
      attributes: new Map(),
      children: [],
      setAttribute(name, value) { this.attributes.set(name, String(value)); },
      appendChild(child) { this.children.push(child); return child; },
    };
  },
};
const image = { tagName: 'IMG' };
const region = createZoomRegion(image, { document, className: 'history-zoom-scroll' });

assert.equal(region.className, 'history-zoom-scroll');
assert.equal(region.tabIndex, 0, '100% 长图滚动区域必须可键盘聚焦');
assert.equal(region.attributes.get('role'), 'region');
assert.equal(region.attributes.get('aria-label'), '100% 长图滚动区域');
assert.deepEqual(region.children, [image], '滚动区域必须包含原图节点');
assert.equal(createZoomRegion(null, { document }), null);

const digestSource = await readFile(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');
const historySource = await readFile(new URL('../src/web/public/js/pages/history/index.js', import.meta.url), 'utf8');
assert.match(digestSource, /import \{ createZoomRegion \} from '\/js\/shared\/zoom-region\.js';/,
  '摘要结果 100% 预览必须接入共享可聚焦滚动区域');
assert.match(digestSource, /createZoomRegion\(copy\)/,
  '摘要结果必须把复制后的长图放入共享滚动区域');
assert.match(historySource, /createZoomRegion\(img, \{ className: 'history-zoom-scroll' \}\)/,
  '历史页必须继续复用同一滚动区域能力');

console.log('web history zoom region tests passed');
