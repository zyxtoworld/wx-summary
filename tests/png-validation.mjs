import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { TMP_DIR } from '../src/lib/paths.js';
import {
  RENDERED_PNG_MAX_CHUNKS,
  validatePngBuffer,
  validatePngFile,
  validatePngFileHandle,
} from '../src/renderer/png-validate.js';
import { __thumbnailInternals } from '../src/renderer/thumbnail.js';

const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const TEST_DIR = path.join(TMP_DIR, `png-validation-${process.pid}-${Date.now()}`);

function ihdr({ width = 1, height = 1, colorType = 6, bitDepth = 8, interlace = 0 } = {}) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = bitDepth;
  data[9] = colorType;
  data[12] = interlace;
  return __thumbnailInternals.pngChunk('IHDR', data);
}

function png(...chunks) {
  return Buffer.concat([SIGNATURE, ...chunks]);
}

function invalid(buffer, message) {
  assert.throws(
    () => validatePngBuffer(buffer),
    error => error?.code === 'png_payload_invalid',
    message,
  );
}

function invalidWithCode(buffer, code, message) {
  assert.throws(
    () => validatePngBuffer(buffer),
    error => error?.code === code,
    message,
  );
}

function compressedPng({ raw, ...header } = {}) {
  return png(
    ihdr(header),
    __thumbnailInternals.pngChunk('IDAT', deflateSync(raw)),
    __thumbnailInternals.pngChunk('IEND', Buffer.alloc(0)),
  );
}

function trackingFileHandle(data) {
  let maxReadLength = 0;
  return {
    get maxReadLength() {
      return maxReadLength;
    },
    async stat() {
      return { size: data.length, isFile: () => true };
    },
    async read(target, offset, length, position) {
      maxReadLength = Math.max(maxReadLength, length);
      const bytesRead = Math.max(0, Math.min(length, data.length - position));
      if (bytesRead > 0) data.copy(target, offset, position, position + bytesRead);
      return { bytesRead, buffer: target };
    },
  };
}

async function main() {
  const valid = __thumbnailInternals.encodeRgbaPng(1, 1, Buffer.from([0, 20, 40, 60, 255]));
  assert.deepEqual(validatePngBuffer(valid), { width: 1, height: 1 });

  const noIdat = png(ihdr(), __thumbnailInternals.pngChunk('IEND', Buffer.alloc(0)));
  invalid(noIdat, 'PNG without IDAT must be rejected');

  const duplicateIhdr = png(
    ihdr(),
    ihdr(),
    __thumbnailInternals.pngChunk('IDAT', Buffer.from([1])),
    __thumbnailInternals.pngChunk('IEND', Buffer.alloc(0)),
  );
  invalid(duplicateIhdr, 'duplicate IHDR must be rejected');

  const indexedWithoutPalette = png(
    ihdr({ colorType: 3, bitDepth: 1 }),
    __thumbnailInternals.pngChunk('IDAT', Buffer.from([1])),
    __thumbnailInternals.pngChunk('IEND', Buffer.alloc(0)),
  );
  invalid(indexedWithoutPalette, 'indexed PNG without PLTE must be rejected');

  const splitIdat = png(
    ihdr(),
    __thumbnailInternals.pngChunk('IDAT', Buffer.from([1])),
    __thumbnailInternals.pngChunk('tEXt', Buffer.from('x')),
    __thumbnailInternals.pngChunk('IDAT', Buffer.from([2])),
    __thumbnailInternals.pngChunk('IEND', Buffer.alloc(0)),
  );
  invalid(splitIdat, 'non-contiguous IDAT chunks must be rejected');

  const dataAfterIend = Buffer.concat([valid, Buffer.from([0])]);
  invalid(dataAfterIend, 'data after IEND must be rejected');

  const malformedZlib = png(
    ihdr(),
    __thumbnailInternals.pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x00])),
    __thumbnailInternals.pngChunk('IEND', Buffer.alloc(0)),
  );
  invalid(malformedZlib, 'PNG with a malformed zlib payload must be rejected');
  assert.deepEqual(
    validatePngBuffer(malformedZlib, { validateInflatedPayload: false }),
    { width: 1, height: 1 },
    'structural validation must skip zlib inflation while retaining PNG chunk validation',
  );

  const corruptIdatCrc = Buffer.from(malformedZlib);
  corruptIdatCrc[corruptIdatCrc.length - 16] ^= 0xff;
  assert.throws(
    () => validatePngBuffer(corruptIdatCrc, { validateInflatedPayload: false }),
    error => error?.code === 'png_payload_invalid',
    'structural validation must still reject a corrupt IDAT CRC',
  );

  const shortScanline = compressedPng({ raw: Buffer.from([0]) });
  invalid(shortScanline, 'PNG with too few inflated scanline bytes must be rejected');

  const badFilter = compressedPng({ raw: Buffer.from([5, 0, 0, 0, 0]) });
  invalid(badFilter, 'PNG with an invalid scanline filter byte must be rejected');

  const valid16Bit = compressedPng({ bitDepth: 16, raw: Buffer.alloc(9) });
  assert.deepEqual(validatePngBuffer(valid16Bit), { width: 1, height: 1 });

  const chunkedWidth = 1023;
  const chunkedRaw = Buffer.alloc(chunkedWidth * 4 + 1);
  let randomState = 0x12345678;
  for (let index = 1; index < chunkedRaw.length; index += 1) {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    chunkedRaw[index] = randomState & 0xff;
  }
  const chunkedCompressed = deflateSync(chunkedRaw);
  const manyIdatChunks = [...chunkedCompressed].map(byte => __thumbnailInternals.pngChunk('IDAT', Buffer.from([byte])));
  const manyIdatPng = png(
    ihdr({ width: chunkedWidth }),
    ...manyIdatChunks,
    __thumbnailInternals.pngChunk('IEND', Buffer.alloc(0)),
  );
  assert.ok(manyIdatChunks.length > 1000, 'fixture should reproduce browser PNGs containing many small IDAT chunks');
  assert.deepEqual(
    validatePngBuffer(manyIdatPng, { validateInflatedPayload: false }),
    { width: chunkedWidth, height: 1 },
    'structural validation must accept a valid PNG split across many contiguous IDAT chunks',
  );

  const largeAncillaryPng = png(
    ihdr(),
    __thumbnailInternals.pngChunk('tEXt', Buffer.alloc(2 * 1024 * 1024)),
    __thumbnailInternals.pngChunk('IDAT', deflateSync(Buffer.alloc(5))),
    __thumbnailInternals.pngChunk('IEND', Buffer.alloc(0)),
  );
  const trackedHandle = trackingFileHandle(largeAncillaryPng);
  assert.deepEqual(
    await validatePngFileHandle(trackedHandle, { validateInflatedPayload: false }),
    { width: 1, height: 1, bytes: largeAncillaryPng.length },
    'structural file validation must preserve chunk and CRC checks',
  );
  assert.ok(
    trackedHandle.maxReadLength <= 1024 * 1024,
    `structural file validation must stay chunked; largest requested read was ${trackedHandle.maxReadLength} bytes`,
  );

  const excessiveIdatPng = png(
    ihdr(),
    __thumbnailInternals.pngChunk('IDAT', deflateSync(Buffer.alloc(5))),
    ...Array.from({ length: RENDERED_PNG_MAX_CHUNKS }, () => __thumbnailInternals.pngChunk('IDAT', Buffer.alloc(0))),
    __thumbnailInternals.pngChunk('IEND', Buffer.alloc(0)),
  );
  assert.throws(
    () => validatePngBuffer(excessiveIdatPng, { validateInflatedPayload: false }),
    error => error?.code === 'png_payload_too_many_chunks' && error?.status === 413,
    'PNG metadata must have a fixed chunk-count ceiling',
  );

  const thumbnailWidth = 320;
  const thumbnailHeight = 420;
  const thumbnailSized = __thumbnailInternals.encodeRgbaPng(
    thumbnailWidth,
    thumbnailHeight,
    Buffer.alloc(thumbnailHeight * (thumbnailWidth * 4 + 1)),
  );
  assert.deepEqual(validatePngBuffer(thumbnailSized, {
    maxRgbaBytes: thumbnailWidth * thumbnailHeight * 4,
    maxSide: thumbnailHeight,
  }), { width: thumbnailWidth, height: thumbnailHeight }, 'PNG scanline filter bytes must not make an otherwise in-budget RGBA canvas invalid');

  const decodedTooLarge = png(
    ihdr({ width: 6000, height: 6000, bitDepth: 16 }),
    __thumbnailInternals.pngChunk('IDAT', Buffer.from([1])),
    __thumbnailInternals.pngChunk('IEND', Buffer.alloc(0)),
  );
  invalidWithCode(decodedTooLarge, 'png_payload_decoded_too_large', 'PNG whose real inflated samples exceed the limit must be rejected before decoding');

  await fsp.mkdir(TEST_DIR, { recursive: true });
  const validFile = path.join(TEST_DIR, 'valid.png');
  await fsp.writeFile(validFile, valid);
  assert.deepEqual(await validatePngFile(validFile), { width: 1, height: 1, bytes: valid.length });

  const noIdatFile = path.join(TEST_DIR, 'no-idat.png');
  await fsp.writeFile(noIdatFile, noIdat);
  await assert.rejects(
    validatePngFile(noIdatFile),
    error => error?.code === 'png_payload_invalid',
    'file validator must reject PNG without IDAT',
  );
  const malformedZlibFile = path.join(TEST_DIR, 'malformed-zlib.png');
  await fsp.writeFile(malformedZlibFile, malformedZlib);
  await assert.rejects(
    validatePngFile(malformedZlibFile),
    error => error?.code === 'png_payload_invalid',
    'file validator must reject a malformed zlib payload',
  );
  assert.deepEqual(
    await validatePngFile(malformedZlibFile, { validateInflatedPayload: false }),
    { width: 1, height: 1, bytes: malformedZlib.length },
    'structural file validation must avoid inflating IDAT data',
  );
  const corruptIdatCrcFile = path.join(TEST_DIR, 'corrupt-idat-crc.png');
  await fsp.writeFile(corruptIdatCrcFile, corruptIdatCrc);
  await assert.rejects(
    validatePngFile(corruptIdatCrcFile, { validateInflatedPayload: false }),
    error => error?.code === 'png_payload_invalid',
    'structural file validation must still reject a corrupt IDAT CRC',
  );
  const manyIdatFile = path.join(TEST_DIR, 'many-idat.png');
  await fsp.writeFile(manyIdatFile, manyIdatPng);
  assert.deepEqual(
    await validatePngFile(manyIdatFile, { validateInflatedPayload: false }),
    { width: chunkedWidth, height: 1, bytes: manyIdatPng.length },
    'structural file validation must handle thousands of IDAT chunks through bounded chunk scanning',
  );
  const excessiveIdatFile = path.join(TEST_DIR, 'excessive-idat.png');
  await fsp.writeFile(excessiveIdatFile, excessiveIdatPng);
  await assert.rejects(
    validatePngFile(excessiveIdatFile, { validateInflatedPayload: false }),
    error => error?.code === 'png_payload_too_many_chunks' && error?.status === 413,
    'file validation must enforce the same chunk-count ceiling without retaining chunk metadata',
  );
  console.log('png validation tests passed');
}

try {
  await main();
} finally {
  await fsp.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
}
