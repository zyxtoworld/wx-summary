import fsp from 'node:fs/promises';
import * as zlib from 'node:zlib';
import { createFileHandleCloser } from '../lib/bounded-read.js';

const { createInflate, inflateSync } = zlib;

export const RENDERED_PNG_MAX_BYTES = 88 * 1024 * 1024;
export const RENDERED_PNG_MAX_RGBA_BYTES = 160 * 1024 * 1024;
export const RENDERED_PNG_MAX_SIDE = 32767;
export const RENDERED_PNG_MAX_CHUNKS = 16 * 1024;

const PNG_CRC_TABLE = createPngCrcTable();
const PNG_FILE_SCAN_CHUNK_BYTES = 1024 * 1024;
const PNG_ADAM7_PASSES = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

function createPngValidationLifecycle(options = {}) {
  const signal = options?.signal || null;
  const closeHandle = typeof options?.closeHandle === 'function' ? options.closeHandle : null;
  if (!signal || !closeHandle) return null;
  let closePromise = null;
  const requestClose = () => {
    if (!closePromise) {
      closePromise = Promise.resolve().then(() => closeHandle());
      closePromise.catch(() => {});
    }
    return closePromise;
  };
  const onAbort = () => { void requestClose().catch(() => {}); };
  signal.addEventListener?.('abort', onAbort, { once: true });
  return {
    close: requestClose,
    dispose: () => signal.removeEventListener?.('abort', onAbort),
  };
}

async function finishPngValidationLifecycle(lifecycle, options = {}) {
  if (!lifecycle) return;
  let closeError = null;
  try {
    if (options?.signal?.aborted) await lifecycle.close();
  } catch (error) {
    closeError = error;
  }
  try {
    if (options?.signal?.aborted) throwIfPngValidationAborted(options);
  } finally {
    lifecycle.dispose();
  }
  if (closeError) throw closeError;
}

export function pngBufferFromDataUrl(pngDataUrl, options = {}) {
  const limits = pngLimits(options);
  const match = String(pngDataUrl || '').match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    throwPngValidationError(
      options,
      'dataUrlInvalid',
      'PNG data URL 无效。',
      'png_payload_invalid',
      400,
      limits,
    );
  }
  const estimatedBytes = Math.floor(match[1].length * 3 / 4);
  if (estimatedBytes > limits.maxBytes) {
    throwPngValidationError(
      options,
      'payloadTooLarge',
      `PNG 超过安全上限 ${formatPngByteSize(limits.maxBytes)}。`,
      'png_payload_too_large',
      413,
      { ...limits, bytes: estimatedBytes },
    );
  }
  const buffer = Buffer.from(match[1], 'base64');
  validatePngBuffer(buffer, options);
  return buffer;
}

export function pngBufferFromInput({ png_data_url = '', png_buffer = null } = {}, options = {}) {
  if (Buffer.isBuffer(png_buffer) || png_buffer instanceof Uint8Array) {
    const buffer = Buffer.from(png_buffer);
    validatePngBuffer(buffer, options);
    return buffer;
  }
  return pngBufferFromDataUrl(png_data_url, options);
}

export function validatePngBuffer(buffer, options = {}) {
  const limits = pngLimits(options);
  if (!Buffer.isBuffer(buffer)) {
    throwPngValidationError(
      options,
      'invalidPng',
      'PNG 数据不完整或已损坏。',
      'png_payload_invalid',
      400,
      limits,
    );
  }
  if (buffer.length > limits.maxBytes) {
    throwPngValidationError(
      options,
      'payloadTooLarge',
      `PNG 超过安全上限 ${formatPngByteSize(limits.maxBytes)}。`,
      'png_payload_too_large',
      413,
      { ...limits, bytes: buffer.length },
    );
  }
  const validateInflatedPayload = options.validateInflatedPayload !== false;
  const inspection = inspectPngBuffer(buffer, {
    collectIdat: validateInflatedPayload,
    maxChunks: limits.maxChunks,
    validationOptions: options,
    limits,
  });
  if (!inspection) {
    throwPngValidationError(
      options,
      'invalidPng',
      'PNG 数据不完整或已损坏。',
      'png_payload_invalid',
      400,
      limits,
    );
  }
  validatePngDimensions(inspection.dimensions, options, limits);
  const layout = createPngInflatedScanlineLayout(inspection.state, options, limits);
  if (validateInflatedPayload) {
    validatePngInflatedBuffer(inspection.idatChunks, layout, options, limits);
  }
  return inspection.dimensions;
}

export function validatePngHeader(buffer, options = {}) {
  const limits = pngLimits(options);
  const dimensions = readPngHeaderDimensions(buffer);
  if (!dimensions) {
    throwPngValidationError(
      options,
      'invalidPng',
      'PNG 数据不完整或已损坏。',
      'png_payload_invalid',
      400,
      limits,
    );
  }
  validatePngDimensions(dimensions, options, limits);
  return dimensions;
}

export async function validatePngFileHeaderHandle(handle, options = {}) {
  const lifecycle = createPngValidationLifecycle(options);
  try {
  const limits = pngLimits(options);
  throwIfPngValidationAborted(options);
  const stat = await handle.stat();
  throwIfPngValidationAborted(options);
  if (!stat.isFile()) {
    throwPngValidationError(options, 'invalidPng', 'PNG 数据不完整或已损坏。', 'png_payload_invalid', 400, limits);
  }
  if (stat.size > limits.maxBytes) {
    throwPngValidationError(
      options,
      'payloadTooLarge',
      `PNG 超过安全上限 ${formatPngByteSize(limits.maxBytes)}。`,
      'png_payload_too_large',
      413,
      { ...limits, bytes: stat.size },
    );
  }
  const header = await readPngFileExact(handle, 33, 0, options);
  return { ...validatePngHeader(header, options), bytes: stat.size };
  } finally {
    await finishPngValidationLifecycle(lifecycle, options);
  }
}

export async function validatePngFile(filePath, options = {}) {
  throwIfPngValidationAborted(options);
  let handle = null;
  let closeHandle = null;
  try {
    handle = await fsp.open(filePath, 'r');
    closeHandle = createFileHandleCloser(handle);
    return await validatePngFileHandle(handle, { ...options, closeHandle });
  } finally {
    try {
      await closeHandle?.();
    } catch {
      if (options?.signal?.aborted) throwIfPngValidationAborted(options);
    }
    if (options?.signal?.aborted) throwIfPngValidationAborted(options);
  }
}

export async function validatePngFileHandle(handle, options = {}) {
  const lifecycle = createPngValidationLifecycle(options);
  try {
  const limits = pngLimits(options);
  throwIfPngValidationAborted(options);
  const stat = await handle.stat();
  throwIfPngValidationAborted(options);
  if (!stat.isFile()) {
    throwPngValidationError(options, 'invalidPng', 'PNG 数据不完整或已损坏。', 'png_payload_invalid', 400, limits);
  }
  if (stat.size > limits.maxBytes) {
    throwPngValidationError(
      options,
      'payloadTooLarge',
      `PNG 超过安全上限 ${formatPngByteSize(limits.maxBytes)}。`,
      'png_payload_too_large',
      413,
      { ...limits, bytes: stat.size },
    );
  }

  const signature = await readPngFileExact(handle, 8, 0, options);
  if (signature.readUInt32BE(0) !== 0x89504e47 || signature.readUInt32BE(4) !== 0x0d0a1a0a) {
    throwPngValidationError(options, 'invalidPng', 'PNG 数据不完整或已损坏。', 'png_payload_invalid', 400, limits);
  }

  const validateInflatedPayload = options.validateInflatedPayload !== false;
  let offset = 8;
  let chunkCount = 0;
  const chunkState = createPngChunkState();
  const idatRanges = validateInflatedPayload ? [] : null;
  const scratch = Buffer.allocUnsafe(PNG_FILE_SCAN_CHUNK_BYTES);
  while (offset + 12 <= stat.size) {
      throwIfPngValidationAborted(options);
      chunkCount += 1;
      assertPngChunkCount(chunkCount, options, limits);
      const header = await readPngFileExact(handle, 8, offset, options);
      const chunkLength = header.readUInt32BE(0);
      const chunkType = header.toString('ascii', 4, 8);
      const dataStart = offset + 8;
      const dataEnd = dataStart + chunkLength;
      const nextOffset = dataEnd + 4;
      if (dataEnd > stat.size || nextOffset > stat.size) {
        throwPngValidationError(options, 'invalidPng', 'PNG 数据不完整或已损坏。', 'png_payload_invalid', 400, limits);
      }

      let crc = pngCrc32(header, 4, 8);
      let position = dataStart;
      let ihdr = null;
      if (!chunkState.dimensions) {
        if (chunkLength !== 13 || chunkType !== 'IHDR') {
          throwPngValidationError(options, 'invalidPng', 'PNG 数据不完整或已损坏。', 'png_payload_invalid', 400, limits);
        }
        ihdr = await readPngFileExact(handle, 13, dataStart, options);
        crc = pngCrc32Continue(crc, ihdr, 0, ihdr.length);
        position = dataEnd;
      }

      while (position < dataEnd) {
        throwIfPngValidationAborted(options);
        const size = Math.min(scratch.length, dataEnd - position);
        const { bytesRead } = await handle.read(scratch, 0, size, position);
        if (bytesRead !== size) {
          throwPngValidationError(options, 'invalidPng', 'PNG 数据不完整或已损坏。', 'png_payload_invalid', 400, limits);
        }
        crc = pngCrc32Continue(crc, scratch, 0, bytesRead);
        position += bytesRead;
      }

      const storedCrc = (await readPngFileExact(handle, 4, dataEnd, options)).readUInt32BE(0);
      if (crc !== storedCrc) {
        throwPngValidationError(options, 'invalidPng', 'PNG 数据不完整或已损坏。', 'png_payload_invalid', 400, limits);
      }
      if (!acceptPngChunk(chunkState, chunkType, chunkLength, ihdr)) {
        throwPngValidationError(options, 'invalidPng', 'PNG 数据不完整或已损坏。', 'png_payload_invalid', 400, limits);
      }
      if (validateInflatedPayload && chunkType === 'IDAT') idatRanges.push({ position: dataStart, length: chunkLength });
      if (chunkType === 'IEND') {
        if (chunkLength !== 0 || nextOffset !== stat.size) {
          throwPngValidationError(options, 'invalidPng', 'PNG 数据不完整或已损坏。', 'png_payload_invalid', 400, limits);
        }
        break;
      }
      offset = nextOffset;
  }
  if (!pngChunkStateComplete(chunkState)) {
    throwPngValidationError(options, 'invalidPng', 'PNG 数据不完整或已损坏。', 'png_payload_invalid', 400, limits);
  }
  validatePngDimensions(chunkState.dimensions, options, limits);
  const layout = createPngInflatedScanlineLayout(chunkState, options, limits);
  if (validateInflatedPayload) {
    await validatePngFileInflatedPayload(handle, idatRanges, layout, options, limits);
  }
  return { ...chunkState.dimensions, bytes: stat.size };
  } finally {
    await finishPngValidationLifecycle(lifecycle, options);
  }
}

async function readPngFileExact(handle, length, position, options = {}) {
  throwIfPngValidationAborted(options);
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  throwIfPngValidationAborted(options);
  if (bytesRead !== length) {
    throwPngValidationError(options, 'invalidPng', 'PNG 数据不完整或已损坏。', 'png_payload_invalid', 400, pngLimits(options));
  }
  return buffer;
}

function throwIfPngValidationAborted(options = {}) {
  const signal = options?.signal || null;
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error('PNG 校验已取消。'), { status: 499, name: 'AbortError' });
}

function validatePngDimensions(dimensions, options, limits) {
  if (dimensions.width <= 0 || dimensions.height <= 0 || dimensions.width > limits.maxSide || dimensions.height > limits.maxSide) {
    throwPngValidationError(
      options,
      'dimensionsTooLarge',
      `PNG 宽高超过安全上限 ${limits.maxSide}px。`,
      'png_payload_dimensions_too_large',
      413,
      { ...limits, ...dimensions },
    );
  }
  const rgbaBytes = dimensions.width * dimensions.height * 4;
  if (rgbaBytes > limits.maxRgbaBytes) {
    throwPngValidationError(
      options,
      'rgbaTooLarge',
      `PNG 解码后约 ${formatPngByteSize(rgbaBytes)}，超过自动保存内存上限 ${formatPngByteSize(limits.maxRgbaBytes)}。`,
      'png_payload_canvas_too_large',
      413,
      { ...limits, ...dimensions, rgbaBytes },
    );
  }
}

export function readPngHeaderDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  const chunkLength = buffer.readUInt32BE(8);
  const chunkType = buffer.toString('ascii', 12, 16);
  const dataStart = 16;
  const dataEnd = dataStart + chunkLength;
  if (chunkLength !== 13 || chunkType !== 'IHDR' || dataEnd + 4 > buffer.length) return null;
  if (buffer.readUInt32BE(dataEnd) !== pngCrc32(buffer, 12, dataEnd)) return null;
  if (!pngIhdrFieldsValid(buffer, dataStart)) return null;
  return {
    width: buffer.readUInt32BE(dataStart),
    height: buffer.readUInt32BE(dataStart + 4),
  };
}

export function readPngDimensions(buffer) {
  const inspection = inspectPngBuffer(buffer);
  return inspection?.dimensions || null;
}

function inspectPngBuffer(buffer, {
  collectIdat = false,
  maxChunks = RENDERED_PNG_MAX_CHUNKS,
  validationOptions = null,
  limits = null,
} = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  let offset = 8;
  let chunkCount = 0;
  const chunkState = createPngChunkState();
  const idatChunks = [];
  while (offset + 12 <= buffer.length) {
    chunkCount += 1;
    if (chunkCount > maxChunks) {
      if (validationOptions) assertPngChunkCount(chunkCount, validationOptions, limits || pngLimits(validationOptions));
      return null;
    }
    const chunkLength = buffer.readUInt32BE(offset);
    const chunkType = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    const nextOffset = dataEnd + 4;
    if (chunkLength > buffer.length || dataEnd > buffer.length || nextOffset > buffer.length) return null;
    const storedCrc = buffer.readUInt32BE(dataEnd);
    const computedCrc = pngCrc32(buffer, offset + 4, dataEnd);
    if (storedCrc !== computedCrc) return null;
    const ihdr = chunkType === 'IHDR' ? buffer.subarray(dataStart, dataEnd) : null;
    if (!acceptPngChunk(chunkState, chunkType, chunkLength, ihdr)) return null;
    if (collectIdat && chunkType === 'IDAT') idatChunks.push(buffer.subarray(dataStart, dataEnd));
    if (chunkType === 'IEND') {
      if (chunkLength !== 0) return null;
      if (nextOffset !== buffer.length) return null;
      break;
    }
    offset = nextOffset;
  }
  if (!pngChunkStateComplete(chunkState)) return null;
  return { dimensions: chunkState.dimensions, state: chunkState, idatChunks };
}

function assertPngChunkCount(chunkCount, options, limits) {
  if (chunkCount <= limits.maxChunks) return;
  throwPngValidationError(
    options,
    'tooManyChunks',
    `PNG 数据分块数量超过安全上限 ${limits.maxChunks}。`,
    'png_payload_too_many_chunks',
    413,
    { ...limits, chunkCount },
  );
}

function createPngChunkState() {
  return {
    dimensions: null,
    bitDepth: 0,
    colorType: -1,
    interlace: 0,
    sawPlte: false,
    sawIdat: false,
    idatBytes: 0,
    idatEnded: false,
    sawIend: false,
  };
}

function acceptPngChunk(state, chunkType, chunkLength, ihdr = null) {
  if (!state || state.sawIend || !/^[A-Za-z]{4}$/.test(chunkType) || /[a-z]/.test(chunkType[2])) return false;
  if (!state.dimensions) {
    if (chunkType !== 'IHDR' || chunkLength !== 13 || !Buffer.isBuffer(ihdr) || !pngIhdrFieldsValid(ihdr, 0)) return false;
    state.dimensions = { width: ihdr.readUInt32BE(0), height: ihdr.readUInt32BE(4) };
    state.bitDepth = ihdr[8];
    state.colorType = ihdr[9];
    state.interlace = ihdr[12];
    return true;
  }
  if (chunkType === 'IHDR') return false;
  if (chunkType === 'PLTE') {
    if (state.sawPlte || state.sawIdat || [0, 4].includes(state.colorType)) return false;
    if (chunkLength <= 0 || chunkLength > 768 || chunkLength % 3 !== 0) return false;
    if (state.colorType === 3 && chunkLength / 3 > 2 ** state.bitDepth) return false;
    state.sawPlte = true;
    return true;
  }
  if (chunkType === 'IDAT') {
    if (state.idatEnded || (state.colorType === 3 && !state.sawPlte)) return false;
    state.sawIdat = true;
    state.idatBytes += chunkLength;
    return true;
  }
  if (state.sawIdat) state.idatEnded = true;
  if (chunkType === 'IEND') {
    if (chunkLength !== 0 || !state.sawIdat || state.idatBytes <= 0) return false;
    state.sawIend = true;
    return true;
  }
  return chunkType[0] === chunkType[0].toLowerCase();
}

function pngChunkStateComplete(state) {
  return !!state?.dimensions && state.sawIdat && state.idatBytes > 0 && state.sawIend;
}

function createPngInflatedScanlineLayout(state, options, limits) {
  const channels = pngColorChannels(state?.colorType);
  const bitDepth = Number(state?.bitDepth || 0) || 0;
  const width = Number(state?.dimensions?.width || 0) || 0;
  const height = Number(state?.dimensions?.height || 0) || 0;
  if (!channels || !bitDepth || !width || !height) {
    throwPngValidationError(options, 'invalidPng', 'PNG 数据不完整或已损坏。', 'png_payload_invalid', 400, limits);
  }
  const bitsPerPixel = channels * bitDepth;
  const passes = state?.interlace === 1 ? PNG_ADAM7_PASSES : [[0, 0, 1, 1]];
  const entries = [];
  let decodedBytes = 0;
  for (const [startX, startY, stepX, stepY] of passes) {
    const passWidth = pngAdam7PassDimension(width, startX, stepX);
    const passHeight = pngAdam7PassDimension(height, startY, stepY);
    if (!passWidth || !passHeight) continue;
    const rowBytes = Math.ceil(passWidth * bitsPerPixel / 8);
    const lineBytes = rowBytes + 1;
    const passBytes = lineBytes * passHeight;
    if (!Number.isSafeInteger(passBytes) || passBytes <= 0 || !Number.isSafeInteger(decodedBytes + passBytes)) {
      throwPngValidationError(options, 'decodedTooLarge', 'PNG 解压后的像素数据超过安全上限。', 'png_payload_decoded_too_large', 413, {
        ...limits,
        ...state.dimensions,
        decodedBytes: Number.MAX_SAFE_INTEGER,
      });
    }
    decodedBytes += passBytes;
    entries.push({ lineBytes, rows: passHeight });
  }
  if (!entries.length || decodedBytes > limits.maxInflatedBytes) {
    throwPngValidationError(
      options,
      'decodedTooLarge',
      `PNG 解压后约 ${formatPngByteSize(decodedBytes)}，超过安全上限 ${formatPngByteSize(limits.maxInflatedBytes)}。`,
      'png_payload_decoded_too_large',
      413,
      { ...limits, ...state.dimensions, decodedBytes },
    );
  }
  return { entries, decodedBytes };
}

function pngColorChannels(colorType) {
  if (colorType === 0 || colorType === 3) return 1;
  if (colorType === 2) return 3;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  return 0;
}

function pngAdam7PassDimension(size, start, step) {
  const value = Number(size || 0) || 0;
  return value > start ? Math.ceil((value - start) / step) : 0;
}

function validatePngInflatedBuffer(idatChunks, layout, options, limits) {
  const validator = createPngInflatedScanlineValidator(layout, options, limits);
  try {
    const compressed = idatChunks.length === 1 ? idatChunks[0] : Buffer.concat(idatChunks);
    const inflated = inflateSync(compressed, { maxOutputLength: layout.decodedBytes + 1 });
    validator.consume(inflated);
    validator.finish();
  } catch (error) {
    if (error?.__wxSummaryPngValidationError) throw error;
    if (isPngValidationAbortError(error, options)) throw error;
    throwPngValidationError(options, 'invalidPng', 'PNG 数据不完整或已损坏。', 'png_payload_invalid', 400, limits);
  }
}

async function validatePngFileInflatedPayload(handle, idatRanges, layout, options, limits) {
  const validator = createPngInflatedScanlineValidator(layout, options, limits);
  const inflater = createInflate();
  let streamFailure = null;
  const completion = new Promise((resolve, reject) => {
    inflater.once('error', error => {
      streamFailure ||= error;
      reject(error);
    });
    inflater.once('end', resolve);
  });
  completion.catch(() => {});
  inflater.on('data', chunk => {
    try {
      validator.consume(chunk);
    } catch (error) {
      streamFailure ||= error;
      inflater.destroy(error);
    }
  });
  const scratch = Buffer.allocUnsafe(64 * 1024);
  try {
    for (const range of idatRanges) {
      let position = Number(range?.position || 0) || 0;
      let remaining = Number(range?.length || 0) || 0;
      while (remaining > 0) {
        throwIfPngValidationAborted(options);
        const size = Math.min(scratch.length, remaining);
        const { bytesRead } = await handle.read(scratch, 0, size, position);
        if (bytesRead !== size) {
          throwPngValidationError(options, 'invalidPng', 'PNG 数据不完整或已损坏。', 'png_payload_invalid', 400, limits);
        }
        await writePngInflateChunk(inflater, scratch.subarray(0, bytesRead), options);
        position += bytesRead;
        remaining -= bytesRead;
      }
    }
    await endPngInflate(inflater, options);
    await completion;
    validator.finish();
  } catch (error) {
    const failure = streamFailure || error;
    if (!inflater.destroyed) inflater.destroy(failure instanceof Error ? failure : undefined);
    if (failure?.__wxSummaryPngValidationError) throw failure;
    if (isPngValidationAbortError(failure, options)) throw failure;
    throwPngValidationError(options, 'invalidPng', 'PNG 数据不完整或已损坏。', 'png_payload_invalid', 400, limits);
  }
}

function writePngInflateChunk(inflater, chunk, options) {
  throwIfPngValidationAborted(options);
  return new Promise((resolve, reject) => {
    let settled = false;
    const signal = options?.signal || null;
    const finish = error => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : Object.assign(new Error('PNG 校验已取消。'), { status: 499, name: 'AbortError' }));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      inflater.write(chunk, finish);
    } catch (error) {
      finish(error);
    }
  });
}

function endPngInflate(inflater, options) {
  throwIfPngValidationAborted(options);
  return new Promise((resolve, reject) => {
    let settled = false;
    const signal = options?.signal || null;
    const finish = error => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : Object.assign(new Error('PNG 校验已取消。'), { status: 499, name: 'AbortError' }));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      inflater.end(finish);
    } catch (error) {
      finish(error);
    }
  });
}

function createPngInflatedScanlineValidator(layout, options, limits) {
  const entries = Array.isArray(layout?.entries) ? layout.entries : [];
  let entryIndex = 0;
  let rowsRemaining = Number(entries[0]?.rows || 0) || 0;
  let lineBytes = Number(entries[0]?.lineBytes || 0) || 0;
  let lineOffset = 0;
  let decodedBytes = 0;
  const advanceEntry = () => {
    while (rowsRemaining <= 0 && entryIndex < entries.length) {
      entryIndex += 1;
      rowsRemaining = Number(entries[entryIndex]?.rows || 0) || 0;
      lineBytes = Number(entries[entryIndex]?.lineBytes || 0) || 0;
    }
  };
  return {
    consume(chunk) {
      for (let index = 0; index < chunk.length; index += 1) {
        if (decodedBytes >= layout.decodedBytes || entryIndex >= entries.length || lineBytes <= 0) {
          throwPngValidationError(options, 'invalidPng', 'PNG 数据不完整或已损坏。', 'png_payload_invalid', 400, limits);
        }
        if (lineOffset === 0 && chunk[index] > 4) {
          throwPngValidationError(options, 'invalidPng', 'PNG 数据不完整或已损坏。', 'png_payload_invalid', 400, limits);
        }
        decodedBytes += 1;
        lineOffset += 1;
        if (lineOffset === lineBytes) {
          lineOffset = 0;
          rowsRemaining -= 1;
          advanceEntry();
        }
      }
    },
    finish() {
      if (decodedBytes !== layout.decodedBytes || lineOffset !== 0 || entryIndex !== entries.length) {
        throwPngValidationError(options, 'invalidPng', 'PNG 数据不完整或已损坏。', 'png_payload_invalid', 400, limits);
      }
    },
  };
}

function isPngValidationAbortError(error, options = {}) {
  return options?.signal?.aborted === true || error?.name === 'AbortError' || Number(error?.status || 0) === 499;
}

export function formatPngByteSize(bytes = 0) {
  const value = Math.max(0, Number(bytes || 0) || 0);
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)}MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(value >= 10 * 1024 ? 0 : 1)}KB`;
  return `${value}B`;
}

function pngLimits(options = {}) {
  const maxBytes = positiveLimit(options.maxBytes, RENDERED_PNG_MAX_BYTES);
  const maxRgbaBytes = positiveLimit(options.maxRgbaBytes, RENDERED_PNG_MAX_RGBA_BYTES);
  const maxSide = positiveLimit(options.maxSide, RENDERED_PNG_MAX_SIDE);
  return {
    maxBytes,
    maxChunks: positiveIntegerLimit(options.maxChunks, RENDERED_PNG_MAX_CHUNKS),
    maxRgbaBytes,
    maxInflatedBytes: positiveLimit(options.maxInflatedBytes, defaultPngInflatedBytesLimit(maxRgbaBytes, maxSide)),
    maxSide,
  };
}

function defaultPngInflatedBytesLimit(maxRgbaBytes, maxSide) {
  const pixels = Math.max(1, Math.floor(Number(maxRgbaBytes) || 0));
  const side = Math.max(1, Math.floor(Number(maxSide) || 0));
  // Each scanline has a filter byte; Adam7 can emit four rows for a one-row image.
  const filterAllowance = Math.min(Number.MAX_SAFE_INTEGER, side * 4);
  return pixels > Number.MAX_SAFE_INTEGER - filterAllowance
    ? Number.MAX_SAFE_INTEGER
    : pixels + filterAllowance;
}

function positiveLimit(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function positiveIntegerLimit(value, fallback) {
  return Math.floor(positiveLimit(value, fallback));
}

function throwPngValidationError(options = {}, key = 'invalidPng', fallbackMessage = 'PNG 数据无效。', fallbackCode = 'png_payload_invalid', fallbackStatus = 400, context = {}) {
  const message = pngValidationMessage(options.messages, key, context, fallbackMessage);
  const code = pngValidationCode(options.codes, key, fallbackCode);
  const status = pngValidationStatus(options.statuses, key, fallbackStatus);
  const errorFactory = typeof options.errorFactory === 'function' ? options.errorFactory : defaultPngValidationError;
  const error = errorFactory(message, code, status, context);
  if (error && typeof error === 'object') error.__wxSummaryPngValidationError = true;
  throw error;
}

function pngValidationMessage(messages = {}, key = '', context = {}, fallback = '') {
  const value = messages && typeof messages === 'object' ? messages[key] : null;
  if (typeof value === 'function') return value(context);
  return value || fallback;
}

function pngValidationCode(codes = {}, key = '', fallback = '') {
  const value = codes && typeof codes === 'object' ? codes[key] : '';
  return String(value || fallback || 'png_payload_invalid').trim();
}

function pngValidationStatus(statuses = {}, key = '', fallback = 400) {
  const value = statuses && typeof statuses === 'object' ? Number(statuses[key]) : NaN;
  return Number.isFinite(value) && value >= 400 ? value : fallback;
}

function defaultPngValidationError(message, code = 'png_payload_invalid', status = 400) {
  const err = new Error(message || 'PNG 数据无效。');
  err.status = status;
  err.code = code;
  err.public_code = code;
  return err;
}

function pngIhdrFieldsValid(buffer, dataStart) {
  const bitDepth = buffer[dataStart + 8];
  const colorType = buffer[dataStart + 9];
  const compression = buffer[dataStart + 10];
  const filter = buffer[dataStart + 11];
  const interlace = buffer[dataStart + 12];
  if (compression !== 0 || filter !== 0 || ![0, 1].includes(interlace)) return false;
  if (colorType === 0) return [1, 2, 4, 8, 16].includes(bitDepth);
  if (colorType === 2) return [8, 16].includes(bitDepth);
  if (colorType === 3) return [1, 2, 4, 8].includes(bitDepth);
  if (colorType === 4) return [8, 16].includes(bitDepth);
  if (colorType === 6) return [8, 16].includes(bitDepth);
  return false;
}

function createPngCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
}

function pngCrc32(buffer, start, end) {
  return pngCrc32Continue(0, buffer, start, end);
}

function pngCrc32Continue(previous, buffer, start, end) {
  if (typeof zlib.crc32 === 'function') {
    return zlib.crc32(buffer.subarray(start, end), previous) >>> 0;
  }
  const crc = pngCrc32Update((previous ^ 0xffffffff) >>> 0, buffer, start, end);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngCrc32Update(initial, buffer, start, end) {
  let crc = initial >>> 0;
  for (let i = start; i < end; i += 1) {
    crc = PNG_CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return crc >>> 0;
}
