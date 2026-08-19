import assert from 'node:assert/strict';
import {
  digestPreviewIdentityText,
  syncDigestPreviewIdentity,
} from '../src/web/public/js/pages/digest/preview-identity.js';

assert.equal(
  digestPreviewIdentityText({ previewGroup: '群 A', processingGroup: '群 B' }),
  '当前显示：群 A；正在处理：群 B',
  'processing group B must not be mistaken for the canvas currently showing group A',
);
assert.equal(digestPreviewIdentityText({ previewGroup: '群 A' }), '当前显示：群 A');
assert.equal(digestPreviewIdentityText({ processingGroup: '群 B' }), '正在处理：群 B');
assert.equal(digestPreviewIdentityText({ previewGroup: '群 A', processingGroup: '群 A' }), '当前显示：群 A');

const identityElement = { textContent: '' };
const attrs = new Map();
const canvas = { setAttribute(name, value) { attrs.set(name, value); } };
const result = syncDigestPreviewIdentity({
  identityElement,
  canvas,
  previewGroup: '群 A',
  processingGroup: '群 B',
});
assert.deepEqual(result, {
  previewGroup: '群 A',
  processingGroup: '群 B',
  text: '当前显示：群 A；正在处理：群 B',
});
assert.equal(identityElement.textContent, result.text);
assert.equal(attrs.get('aria-label'), '群 A 摘要长图',
  'the visible canvas accessible name must identify the group being shown');

const staleAttrs = new Map([['aria-label', '群 A 摘要长图']]);
const staleCanvas = {
  setAttribute(name, value) { staleAttrs.set(name, value); },
  removeAttribute(name) { staleAttrs.delete(name); },
};
syncDigestPreviewIdentity({
  identityElement,
  canvas: staleCanvas,
  previewGroup: '',
  processingGroup: '群 B',
});
assert.equal(staleAttrs.has('aria-label'), false,
  '没有当前显示群时必须移除旧 canvas 的 accessible name,不得继续标识旧群');

console.log('digest preview group identity tests passed');
