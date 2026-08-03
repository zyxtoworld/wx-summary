import assert from 'node:assert/strict';
import { __thumbnailInternals } from '../src/renderer/thumbnail.js';

function pixel(scanlines, width, x, y) {
  const offset = y * (width * 4 + 1) + 1 + x * 4;
  return [...scanlines.subarray(offset, offset + 4)];
}

const opaqueBlend = __thumbnailInternals.scalePortablePngTopCropToRgba({
  width: 2,
  height: 1,
  rgba: Buffer.from([
    255, 0, 0, 255,
    0, 0, 255, 255,
  ]),
}, { width: 3, height: 2 });

assert.deepEqual(pixel(opaqueBlend, 3, 0, 0), [255, 0, 0, 255], 'left edge must retain the source color');
assert.deepEqual(pixel(opaqueBlend, 3, 1, 0), [128, 0, 128, 255], 'the middle pixel must bilinearly blend both opaque source pixels');
assert.deepEqual(pixel(opaqueBlend, 3, 2, 0), [0, 0, 255, 255], 'right edge must retain the source color');

const transparentBlend = __thumbnailInternals.scalePortablePngTopCropToRgba({
  width: 2,
  height: 1,
  rgba: Buffer.from([
    255, 0, 0, 255,
    0, 0, 255, 0,
  ]),
}, { width: 3, height: 2 });

assert.deepEqual(pixel(transparentBlend, 3, 1, 0), [255, 0, 0, 128], 'premultiplied-alpha interpolation must not bleed invisible blue into a red edge');

console.log('thumbnail bilinear quality tests passed');
