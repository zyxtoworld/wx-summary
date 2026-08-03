import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import zlib from 'node:zlib';
import pngjs from 'pngjs';
import { createAbortableWorkRegistry } from '../lib/abortable-work-registry.js';
import { readFileHandleBounded } from '../lib/bounded-read.js';
import { TMP_DIR, assertSafeTmpPath } from '../lib/paths.js';
import { RENDERED_PNG_MAX_BYTES, RENDERED_PNG_MAX_RGBA_BYTES, RENDERED_PNG_MAX_SIDE, validatePngBuffer, validatePngFileHandle, validatePngHeader } from './png-validate.js';
import { attachWindowsProcessCleanup, terminateWindowsProcessTree, windowsProcessCleanupForError } from './windows-process-tree.js';

const SCRIPT_PATH = fileURLToPath(new URL('./render-thumbnail.ps1', import.meta.url));
const PORTABLE_THUMBNAIL_WORKER_URL = new URL('./thumbnail-worker.js', import.meta.url);
const THUMBNAIL_RENDER_TIMEOUT_MS = 10000;
// Each renderer can retain a full decoded source image. Keep history-grid fanout bounded.
const THUMBNAIL_RENDER_CONCURRENCY = 1;
const THUMBNAIL_RENDER_QUEUE_LIMIT = 24;
const THUMBNAIL_RENDER_QUEUE_WAIT_MS = 15000;
const THUMBNAIL_PROCESS_KILL_GRACE_MS = 1500;
const THUMBNAIL_PROCESS_POLL_MS = 50;
const THUMBNAIL_PROCESS_RESPONSE_WAIT_MS = 5000;
const THUMBNAIL_PROCESS_OUTPUT_TAIL_MAX_CHARS = 64 * 1024;
const THUMBNAIL_FAILURE_CACHE_MS = 60 * 1000;
const THUMBNAIL_FAILURE_CACHE_LIMIT = 512;
const THUMBNAIL_DISK_CACHE_MAX_FILES = 1000;
const THUMBNAIL_DISK_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const THUMBNAIL_DISK_CACHE_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const THUMBNAIL_TEMP_MAX_AGE_MS = 60 * 60 * 1000;
const THUMBNAIL_PORTABLE_MAX_SOURCE_BYTES = RENDERED_PNG_MAX_BYTES;
const THUMBNAIL_JS_MAX_SOURCE_RGBA_BYTES = RENDERED_PNG_MAX_RGBA_BYTES;
const THUMBNAIL_JS_MAX_INFLATED_BYTES = RENDERED_PNG_MAX_RGBA_BYTES + RENDERED_PNG_MAX_SIDE * 4;
const THUMBNAIL_SNAPSHOT_COPY_CHUNK_BYTES = 1024 * 1024;
const PNG_SIGNATURE_HEX = '89504e470d0a1a0a';
const PNG_CRC_TABLE = createPngCrcTable();
const { PNG } = pngjs;
const PNG_ADAM7_PASSES = Object.freeze([
  Object.freeze([0, 0, 8, 8]),
  Object.freeze([4, 0, 8, 8]),
  Object.freeze([0, 4, 4, 8]),
  Object.freeze([2, 0, 4, 4]),
  Object.freeze([0, 2, 2, 4]),
  Object.freeze([1, 0, 2, 2]),
  Object.freeze([0, 1, 1, 2]),
]);
let ACTIVE_THUMBNAIL_RENDERS = 0;
const THUMBNAIL_RENDER_QUEUE = [];
let THUMBNAIL_PROCESS_QUARANTINE = null;
const THUMBNAIL_FAILURE_CACHE = new Map();
const THUMBNAIL_IN_FLIGHT = new Map();
let THUMBNAIL_SOURCE_SNAPSHOT_COUNT = 0;
let LAST_THUMBNAIL_DISK_CACHE_PRUNE_AT = 0;
let THUMBNAIL_DISK_CACHE_PRUNE_IN_FLIGHT = null;
const THUMBNAIL_WORK = createAbortableWorkRegistry({
  closingError: reason => thumbnailShutdownError(reason?.message),
});

function windowsPowerShellExecutablePath() {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.join(root, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];
  return candidates.find(file => {
    try {
      return fs.existsSync(file);
    } catch {
      return false;
    }
  }) || '';
}

export const __thumbnailInternals = {
  decodePortableThumbnailSource,
  scalePortablePngTopCropToRgba,
  encodeRgbaPng,
  pngChunk,
  portableThumbnailInflatedBytes,
  pruneThumbnailDiskCache,
  createThumbnailSourceSnapshotFromHandle,
  joinThumbnailFlight,
  runPortableThumbnailWorker,
  withThumbnailRenderSlot,
  isCacheableThumbnailFailure,
  rememberThumbnailFailure,
  cachedThumbnailFailure,
  clearThumbnailFailureCache: () => THUMBNAIL_FAILURE_CACHE.clear(),
  thumbnailRenderConcurrency: THUMBNAIL_RENDER_CONCURRENCY,
  thumbnailFlightCount: () => THUMBNAIL_IN_FLIGHT.size,
  thumbnailSourceSnapshotCount: () => THUMBNAIL_SOURCE_SNAPSHOT_COUNT,
  thumbnailSourceMaxBytes,
  thumbnailSourceMaxRgbaBytes,
  thumbnailFileContentStatMatches,
  thumbnailProcessQuarantinedError,
};

export async function renderDigestThumbnailPng({ filePath, digestId = '', fileVersion = '', width = 320, height = 420, signal = null, timeout_ms = THUMBNAIL_RENDER_TIMEOUT_MS } = {}) {
  if (THUMBNAIL_WORK.status().closing) throw thumbnailShutdownError();
  throwIfThumbnailAborted(signal);
  const source = path.resolve(filePath || '');
  const stat = await fsp.stat(source);
  if (!stat.isFile()) throw Object.assign(new Error('thumbnail source is not a file'), { status: 404 });
  const sourceMaxBytes = thumbnailSourceMaxBytes();
  const sourceMaxRgbaBytes = thumbnailSourceMaxRgbaBytes();
  if (stat.size > sourceMaxBytes) {
    throw thumbnailLimitExceededError('缩略图源文件过大；请点开查看原图。');
  }
  await validateThumbnailSourceHeader(source, stat, { signal, maxBytes: sourceMaxBytes, maxRgbaBytes: sourceMaxRgbaBytes });
  const targetWidth = normalizeThumbnailDimension(width, 320);
  const targetHeight = normalizeThumbnailDimension(height, 420);
  throwIfThumbnailAborted(signal);

  const cacheDir = path.join(TMP_DIR, 'thumbs');
  scheduleThumbnailDiskCachePrune(cacheDir);
  const id = String(digestId || path.basename(source, '.png')).replace(/[^a-z0-9_-]/gi, '').slice(0, 16) || 'digest';
  const versionKey = String(fileVersion || '').trim();
  const sourceAdmissionIdentity = versionKey
    ? ['v3', source, versionKey, targetWidth, targetHeight].join('|')
    : ['stat-v3', source, stat.size, stat.mtimeMs, stat.ctimeMs, targetWidth, targetHeight].join('|');
  const expectedSnapshotSha = thumbnailV2VersionSha(versionKey);
  let expectedCacheIdentity = '';
  if (expectedSnapshotSha) {
    expectedCacheIdentity = thumbnailCacheIdentity(sourceAdmissionIdentity, expectedSnapshotSha, targetWidth, targetHeight);
    const output = path.join(cacheDir, `${id}-${expectedCacheIdentity}.png`);
    const safeOutput = await assertSafeTmpPath(output, { label: 'thumbnail cache', ensureParent: true });
    if (await validPngCache(safeOutput.resolved, { width: targetWidth, height: targetHeight })) return safeOutput.resolved;
    pruneThumbnailFailureCache();
    const cachedFailure = cachedThumbnailFailure(expectedCacheIdentity);
    if (cachedFailure) throw cachedFailure;
  }
  const admissionIdentity = `admission:${thumbnailCacheIdentity(
    sourceAdmissionIdentity,
    expectedSnapshotSha || 'unversioned',
    targetWidth,
    targetHeight,
  )}`;
  return await joinThumbnailFlight(admissionIdentity, signal, producerSignal => withThumbnailRenderSlot(producerSignal, async () => {
    let snapshot = null;
    let snapshotOwnedByRenderer = false;
    let cacheIdentity = expectedCacheIdentity;
    try {
      snapshot = await createThumbnailSourceSnapshot(source, cacheDir, {
        id,
        expectedFileVersion: versionKey,
        maxBytes: sourceMaxBytes,
        maxRgbaBytes: sourceMaxRgbaBytes,
        signal: producerSignal,
      });
      cacheIdentity ||= thumbnailCacheIdentity(sourceAdmissionIdentity, snapshot.sha256, targetWidth, targetHeight);
      const output = path.join(cacheDir, `${id}-${cacheIdentity}.png`);
      const safeOutput = await assertSafeTmpPath(output, { label: 'thumbnail cache', ensureParent: true });
      if (await validPngCache(safeOutput.resolved, { width: targetWidth, height: targetHeight })) return safeOutput.resolved;
      pruneThumbnailFailureCache();
      const cachedFailure = cachedThumbnailFailure(cacheIdentity);
      if (cachedFailure) throw cachedFailure;
      snapshotOwnedByRenderer = true;
      return await renderThumbnailSnapshotProducer({
        snapshot,
        safeOutput,
        cacheIdentity,
        id,
        targetWidth,
        targetHeight,
        timeoutMs: timeout_ms,
        signal: producerSignal,
      });
    } catch (e) {
      if (cacheIdentity && !isThumbnailAbortError(e) && !isTransientThumbnailError(e) && isCacheableThumbnailFailure(e)) {
        rememberThumbnailFailure(cacheIdentity, e);
      }
      throw e;
    } finally {
      if (snapshot && !snapshotOwnedByRenderer) await cleanupThumbnailTemp(snapshot.path);
    }
  })).promise;
}

function thumbnailCacheIdentity(sourceAdmissionIdentity, snapshotSha, targetWidth, targetHeight) {
  return crypto
    .createHash('sha256')
    .update(['snapshot-v1', sourceAdmissionIdentity, snapshotSha, targetWidth, targetHeight].join('|'))
    .digest('hex');
}

function thumbnailV2VersionSha(version = '') {
  return String(version || '').trim().match(/^v2:\d+:\d+:\d+:([a-f0-9]{64})$/i)?.[1]?.toLowerCase() || '';
}

async function renderThumbnailSnapshotProducer({ snapshot, safeOutput, cacheIdentity, id, targetWidth, targetHeight, timeoutMs, signal }) {
  const tmp = path.join(path.dirname(safeOutput.resolved), `${id}-${cacheIdentity}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp.png`);
  let safeTmp = null;
  let deferredProcessCleanup = null;
  try {
    if (await validPngCache(safeOutput.resolved, { width: targetWidth, height: targetHeight })) return safeOutput.resolved;
    await removeInvalidThumbnailCache(safeOutput.resolved);
    throwIfThumbnailAborted(signal);
    safeTmp = await assertSafeTmpPath(tmp, { label: 'thumbnail temp', ensureParent: true });
    if (process.platform === 'win32') {
      await runPowerShell([
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', SCRIPT_PATH,
        '-InputPng', snapshot.path,
        '-OutputPng', safeTmp.resolved,
        '-Width', String(targetWidth),
        '-Height', String(targetHeight),
      ], { signal, timeoutMs });
    } else {
      await runPortableThumbnailWorker(snapshot.path, safeTmp.resolved, {
        width: targetWidth,
        height: targetHeight,
        signal,
        timeoutMs,
      });
    }
    throwIfThumbnailAborted(signal);
    safeTmp = await assertSafeTmpPath(safeTmp.resolved, { label: 'thumbnail temp', requireFile: true });
    await assertValidThumbnailPng(safeTmp.resolved, { width: targetWidth, height: targetHeight, label: 'thumbnail temp' });
    await assertSafeTmpPath(safeOutput.resolved, { label: 'thumbnail cache', ensureParent: true });
    await installThumbnailCache(safeTmp.resolved, safeOutput.resolved, { width: targetWidth, height: targetHeight });
    THUMBNAIL_FAILURE_CACHE.delete(cacheIdentity);
    return safeOutput.resolved;
  } catch (e) {
    deferredProcessCleanup = windowsProcessCleanupForError(e);
    if (!isThumbnailAbortError(e) && !isTransientThumbnailError(e) && isCacheableThumbnailFailure(e)) {
      rememberThumbnailFailure(cacheIdentity, e);
    }
    throw e;
  } finally {
    const cleanup = () => Promise.all([
      cleanupThumbnailTemp(safeTmp?.resolved || tmp),
      cleanupThumbnailTemp(snapshot.path),
    ]);
    if (deferredProcessCleanup) {
      void THUMBNAIL_WORK.track(deferredProcessCleanup.then(cleanup, cleanup)).catch(() => {});
    } else {
      await cleanup();
    }
  }
}

async function createThumbnailSourceSnapshot(source, cacheDir, { id = 'digest', expectedFileVersion = '', maxBytes = RENDERED_PNG_MAX_BYTES, maxRgbaBytes = RENDERED_PNG_MAX_RGBA_BYTES, signal = null } = {}) {
  throwIfThumbnailAborted(signal);
  const snapshotPath = path.join(cacheDir, `${id}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.source.tmp.png`);
  const safeSnapshot = await assertSafeTmpPath(snapshotPath, { label: 'thumbnail source snapshot', ensureParent: true });
  let handle = null;
  try {
    handle = await fsp.open(source, 'r');
    return await createThumbnailSourceSnapshotFromHandle(handle, safeSnapshot.resolved, { expectedFileVersion, maxBytes, maxRgbaBytes, signal });
  } catch (error) {
    await cleanupThumbnailTemp(safeSnapshot.resolved);
    throw error;
  } finally {
    await handle?.close?.().catch(() => {});
  }
}

async function createThumbnailSourceSnapshotFromHandle(handle, snapshotPath, { expectedFileVersion = '', maxBytes = RENDERED_PNG_MAX_BYTES, maxRgbaBytes = RENDERED_PNG_MAX_RGBA_BYTES, signal = null } = {}) {
  throwIfThumbnailAborted(signal);
  const before = await handle.stat();
  if (!before?.isFile?.()) throw thumbnailValidationError('缩略图源文件不是普通文件。', 'thumbnail_invalid_png', 422);
  const boundedMaxBytes = Math.max(1, Math.min(RENDERED_PNG_MAX_BYTES, Number(maxBytes || 0) || RENDERED_PNG_MAX_BYTES));
  const boundedMaxRgbaBytes = Math.max(1, Math.min(RENDERED_PNG_MAX_RGBA_BYTES, Number(maxRgbaBytes || 0) || RENDERED_PNG_MAX_RGBA_BYTES));
  if (before.size > boundedMaxBytes) {
    throw thumbnailLimitExceededError('缩略图源文件过大；请点开查看原图。');
  }
  let snapshotHandle = null;
  let completed = false;
  try {
    snapshotHandle = await fsp.open(snapshotPath, 'wx+');
    const copied = await copyThumbnailSourceSnapshot(handle, snapshotHandle, before.size, { signal });
    const after = await handle.stat();
    if (!thumbnailFileContentStatMatches(before, after)) {
      throw thumbnailValidationError('缩略图源文件已变化，请刷新历史后重试。', 'history_file_changed', 409);
    }
    assertThumbnailSnapshotVersion(expectedFileVersion, after, copied.sha256);
    throwIfThumbnailAborted(signal);
    await snapshotHandle.sync();
    await validatePngFileHandle(snapshotHandle, thumbnailSourceValidationOptions({
      signal,
      maxBytes: boundedMaxBytes,
      maxRgbaBytes: boundedMaxRgbaBytes,
    }));
    throwIfThumbnailAborted(signal);
    const safeSnapshot = await assertSafeTmpPath(snapshotPath, { label: 'thumbnail source snapshot', requireFile: true });
    THUMBNAIL_SOURCE_SNAPSHOT_COUNT += 1;
    completed = true;
    return { path: safeSnapshot.resolved, sha256: copied.sha256, stat: after, bytes: copied.bytes };
  } catch (error) {
    if (error?.code === 'thumbnail_limit_exceeded') throw error;
    if (error?.code === 'history_file_changed' || isThumbnailAbortError(error)) throw error;
    if (error?.code === 'thumbnail_invalid_png' || error?.code === 'thumbnail_failed') throw error;
    if (String(error?.code || '').toLowerCase().startsWith('png_payload_')) {
      throw thumbnailValidationError(error?.message || '缩略图源图不是有效 PNG。', 'thumbnail_invalid_png', Number(error?.status || 422) || 422);
    }
    throw thumbnailValidationError('缩略图临时副本准备失败；请稍后重试。', 'thumbnail_failed', 500);
  } finally {
    await snapshotHandle?.close?.().catch(() => {});
    if (!completed) await cleanupThumbnailTemp(snapshotPath);
  }
}

async function copyThumbnailSourceSnapshot(sourceHandle, snapshotHandle, expectedBytes, { signal = null } = {}) {
  const size = Number(expectedBytes);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw thumbnailValidationError('缩略图源文件已变化，请刷新历史后重试。', 'history_file_changed', 409);
  }
  const chunk = Buffer.allocUnsafe(Math.min(THUMBNAIL_SNAPSHOT_COPY_CHUNK_BYTES, size));
  const hash = crypto.createHash('sha256');
  let position = 0;
  while (position < size) {
    throwIfThumbnailAborted(signal);
    const requested = Math.min(chunk.length, size - position);
    const { bytesRead } = await sourceHandle.read(chunk, 0, requested, position);
    if (!bytesRead) {
      throw thumbnailValidationError('缩略图源文件已变化，请刷新历史后重试。', 'history_file_changed', 409);
    }
    hash.update(chunk.subarray(0, bytesRead));
    let written = 0;
    while (written < bytesRead) {
      throwIfThumbnailAborted(signal);
      const result = await snapshotHandle.write(chunk, written, bytesRead - written, position + written);
      if (!result.bytesWritten) {
        throw thumbnailValidationError('缩略图临时副本写入失败；请稍后重试。', 'thumbnail_failed', 500);
      }
      written += result.bytesWritten;
    }
    position += bytesRead;
  }
  const extra = Buffer.allocUnsafe(1);
  if ((await sourceHandle.read(extra, 0, 1, position)).bytesRead) {
    throw thumbnailValidationError('缩略图源文件已变化，请刷新历史后重试。', 'history_file_changed', 409);
  }
  return { bytes: position, sha256: hash.digest('hex') };
}

function thumbnailSourceValidationOptions({ signal = null, maxBytes = RENDERED_PNG_MAX_BYTES, maxRgbaBytes = RENDERED_PNG_MAX_RGBA_BYTES } = {}) {
  return {
    signal,
    maxBytes,
    maxRgbaBytes,
    maxSide: RENDERED_PNG_MAX_SIDE,
    messages: {
      invalidPng: '缩略图源图不是有效 PNG。',
      payloadTooLarge: '缩略图源文件过大；请点开查看原图。',
      dimensionsTooLarge: '缩略图源图尺寸超过安全上限；请点开查看原图。',
      rgbaTooLarge: '缩略图源图解码内存超过安全上限；请点开查看原图。',
      decodedTooLarge: '缩略图源图解压后的像素数据超过安全上限；请点开查看原图。',
      tooManyChunks: '缩略图源图数据分块数量异常；请点开查看原图。',
    },
    codes: {
      invalidPng: 'thumbnail_invalid_png',
      payloadTooLarge: 'thumbnail_limit_exceeded',
      dimensionsTooLarge: 'thumbnail_limit_exceeded',
      rgbaTooLarge: 'thumbnail_limit_exceeded',
      decodedTooLarge: 'thumbnail_limit_exceeded',
      tooManyChunks: 'thumbnail_limit_exceeded',
    },
    errorFactory: thumbnailValidationError,
  };
}

function assertThumbnailSnapshotVersion(expectedFileVersion, stat, sha256) {
  const expected = String(expectedFileVersion || '').trim();
  if (!expected) return;
  const v2 = expected.match(/^v2:\d+:\d+:\d+:([a-f0-9]{64})$/i);
  if (v2 && v2[1].toLowerCase() === sha256) return;
  const v1 = expected.match(/^v1:(\d+:\d+:\d+)$/i);
  if (v1 && v1[1] === thumbnailFileStatFingerprint(stat)) return;
  throw thumbnailValidationError('缩略图源文件已变化，请刷新历史后重试。', 'history_file_changed', 409);
}

function thumbnailFileStatFingerprint(stat) {
  if (!stat?.isFile?.()) return '';
  return [
    Number(stat.size || 0) || 0,
    Math.round((Number(stat.mtimeMs || 0) || 0) * 1000),
    Math.round((Number(stat.ctimeMs || 0) || 0) * 1000),
  ].join(':');
}

async function validateThumbnailSourceHeader(source, expectedStat, { signal = null, maxBytes = RENDERED_PNG_MAX_BYTES, maxRgbaBytes = RENDERED_PNG_MAX_RGBA_BYTES } = {}) {
  throwIfThumbnailAborted(signal);
  let handle = null;
  try {
    handle = await fsp.open(source, 'r');
    const before = await handle.stat();
    if (!before?.isFile?.()) throw thumbnailValidationError('缩略图源文件不是普通文件。', 'thumbnail_invalid_png', 422);
    if (before.size > maxBytes) {
      throw thumbnailLimitExceededError('缩略图源文件过大；请点开查看原图。');
    }
    const header = Buffer.alloc(33);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    throwIfThumbnailAborted(signal);
    try {
      validatePngHeader(header.subarray(0, bytesRead), {
        maxRgbaBytes,
        maxSide: RENDERED_PNG_MAX_SIDE,
        messages: {
          invalidPng: '缩略图源图不是有效 PNG。',
          dimensionsTooLarge: '缩略图源图尺寸超过安全上限；请点开查看原图。',
          rgbaTooLarge: '缩略图源图解码内存超过安全上限；请点开查看原图。',
        },
        codes: {
          invalidPng: 'thumbnail_invalid_png',
          dimensionsTooLarge: 'thumbnail_limit_exceeded',
          rgbaTooLarge: 'thumbnail_limit_exceeded',
        },
        errorFactory: thumbnailValidationError,
      });
    } catch (e) {
      if (e?.code === 'thumbnail_limit_exceeded') throw e;
      throw thumbnailValidationError(e?.message || '缩略图源图不是有效 PNG。', 'thumbnail_invalid_png', Number(e?.status || 422) || 422);
    }
    const after = await handle.stat();
    if (!thumbnailFileContentStatMatches(before, after)
      || (expectedStat && !thumbnailFileContentStatMatches(expectedStat, after))) {
      throw thumbnailValidationError('缩略图源文件已变化，请刷新历史后重试。', 'history_file_changed', 409);
    }
  } finally {
    await handle?.close?.().catch(() => {});
  }
}

export async function renderPortableThumbnailPng(source, output, { width, height, signal = null } = {}) {
  throwIfThumbnailAborted(signal);
  const { data: input } = await readThumbnailFileBounded(source, THUMBNAIL_PORTABLE_MAX_SOURCE_BYTES, {
    signal,
    createTooLargeError: () => thumbnailLimitExceededError('缩略图源文件过大；请点开查看原图。'),
    createChangedError: () => thumbnailValidationError('缩略图源文件已变化，请刷新历史后重试。', 'history_file_changed', 409),
  });
  throwIfThumbnailAborted(signal);
  const png = await decodePortableThumbnailSource(input, { signal });
  throwIfThumbnailAborted(signal);
  const scaled = scalePortablePngTopCropToRgba(png, { width, height, signal });
  throwIfThumbnailAborted(signal);
  const encoded = encodeRgbaPng(width, height, scaled);
  await fsp.writeFile(output, encoded, { flag: 'wx' });
}

async function decodePortableThumbnailSource(buffer, { signal = null } = {}) {
  throwIfThumbnailAborted(signal);
  const parsed = parsePngForPortableThumbnail(buffer);
  await verifyPortableThumbnailInflatedData(parsed, { signal });
  throwIfThumbnailAborted(signal);
  let decoded;
  try {
    decoded = PNG.sync.read(buffer, { checkCRC: true, skipRescale: false });
  } catch (error) {
    if (/unsupported|not supported/i.test(String(error?.message || ''))) {
      throw thumbnailValidationError('当前便携缩略图无法解码这张合法 PNG；原图仍可正常打开。', 'thumbnail_format_unsupported', 422);
    }
    throw thumbnailValidationError('缩略图源图已损坏；请点开查看原图。', 'thumbnail_invalid_png', 500);
  }
  const rgbaBytes = parsed.width * parsed.height * 4;
  if (!Number.isSafeInteger(rgbaBytes)
    || decoded?.width !== parsed.width
    || decoded?.height !== parsed.height
    || !Buffer.isBuffer(decoded?.data)
    || decoded.data.length !== rgbaBytes) {
    throw thumbnailValidationError('缩略图源图解码结果异常；请点开查看原图。', 'thumbnail_invalid_png', 500);
  }
  return {
    width: parsed.width,
    height: parsed.height,
    bitDepth: 8,
    colorType: 6,
    interlace: 0,
    rgba: decoded.data,
  };
}

function portableThumbnailInflatedBytes(png = {}) {
  const width = Number(png.width || 0);
  const height = Number(png.height || 0);
  const channels = portablePngChannels(png.colorType);
  const bitsPerPixel = channels * Number(png.bitDepth || 0);
  if (!Number.isSafeInteger(width) || width <= 0
    || !Number.isSafeInteger(height) || height <= 0
    || !Number.isSafeInteger(bitsPerPixel) || bitsPerPixel <= 0) {
    throw thumbnailValidationError('缩略图源图尺寸异常；请点开查看原图。', 'thumbnail_invalid_png', 500);
  }
  const passBytes = (passWidth, passHeight) => {
    if (!passWidth || !passHeight) return 0;
    const rowBytes = Math.ceil(passWidth * bitsPerPixel / 8) + 1;
    const bytes = rowBytes * passHeight;
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      throw thumbnailValidationError('缩略图源图尺寸异常；请点开查看原图。', 'thumbnail_invalid_png', 500);
    }
    return bytes;
  };
  const expected = Number(png.interlace || 0) === 1
    ? PNG_ADAM7_PASSES.reduce((sum, [startX, startY, stepX, stepY]) => {
      const passWidth = portablePngPassSize(width, startX, stepX);
      const passHeight = portablePngPassSize(height, startY, stepY);
      return sum + passBytes(passWidth, passHeight);
    }, 0)
    : passBytes(width, height);
  if (!Number.isSafeInteger(expected) || expected <= 0) {
    throw thumbnailValidationError('缩略图源图尺寸异常；请点开查看原图。', 'thumbnail_invalid_png', 500);
  }
  return expected;
}

function portablePngChannels(colorType) {
  if (colorType === 0 || colorType === 3) return 1;
  if (colorType === 2) return 3;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  throw thumbnailValidationError('缩略图源图色彩类型无效；请点开查看原图。', 'thumbnail_invalid_png', 500);
}

function portablePngPassSize(size, start, step) {
  return size <= start ? 0 : Math.ceil((size - start) / step);
}

async function verifyPortableThumbnailInflatedData(png, { signal = null } = {}) {
  const expected = portableThumbnailInflatedBytes(png);
  if (expected > THUMBNAIL_JS_MAX_INFLATED_BYTES) {
    throw thumbnailLimitExceededError('缩略图源图解压后过大；请点开查看原图。');
  }
  let actual = 0;
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      actual += chunk.length;
      if (actual > expected) {
        callback(thumbnailValidationError('缩略图源图数据长度异常；请点开查看原图。', 'thumbnail_invalid_png', 500));
        return;
      }
      callback();
    },
  });
  try {
    await pipeline(
      Readable.from(png.idat, { objectMode: false }),
      zlib.createInflate(),
      sink,
      signal ? { signal } : {},
    );
  } catch (error) {
    if (signal?.aborted) throw thumbnailAbortReason(signal);
    if (error?.code === 'thumbnail_invalid_png') throw error;
    throw thumbnailValidationError('缩略图源图已损坏；请点开查看原图。', 'thumbnail_invalid_png', 500);
  }
  if (actual !== expected) {
    throw thumbnailValidationError('缩略图源图数据长度异常；请点开查看原图。', 'thumbnail_invalid_png', 500);
  }
}

function runPortableThumbnailWorker(source, output, {
  width,
  height,
  signal = null,
  timeoutMs = THUMBNAIL_RENDER_TIMEOUT_MS,
  workerFactory = null,
} = {}) {
  throwIfThumbnailAborted(signal);
  const timeout = Math.max(1000, Number(timeoutMs || 0) || THUMBNAIL_RENDER_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    let worker = null;
    let finalized = false;
    let timer = null;
    let resultReceived = false;
    let resultError = null;
    let stopError = null;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
      worker?.removeAllListeners?.();
    };
    const finalize = (error = null) => {
      if (finalized) return;
      finalized = true;
      cleanup();
      if (error) reject(error);
      else resolve(output);
    };
    const stopFor = error => {
      if (finalized || stopError) return;
      stopError = error;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
      let termination;
      try {
        termination = worker?.terminate?.();
      } catch {
        finalize(stopError);
        return;
      }
      Promise.resolve(termination).then(
        () => finalize(stopError),
        () => finalize(stopError),
      );
    };
    const abort = () => stopFor(thumbnailAbortReason(signal));
    try {
      const createWorker = typeof workerFactory === 'function'
        ? workerFactory
        : (url, options) => new Worker(url, options);
      worker = createWorker(PORTABLE_THUMBNAIL_WORKER_URL, {
        workerData: { source, output, width, height },
      });
    } catch (e) {
      finalize(thumbnailValidationError(`缩略图渲染进程启动失败：${e?.message || String(e)}`, 'thumbnail_failed', 500));
      return;
    }
    worker.once('message', message => {
      if (resultReceived || stopError) return;
      resultReceived = true;
      if (message?.ok) {
        return;
      }
      const payload = message?.error || {};
      resultError = thumbnailValidationError(
        payload.message || '缩略图生成失败；请点开查看原图。',
        payload.code || 'thumbnail_failed',
        payload.status || 500,
      );
    });
    worker.once('error', e => stopFor(thumbnailValidationError(
        `缩略图渲染进程失败：${e?.message || String(e)}`,
        'thumbnail_failed',
        500,
      )));
    worker.once('exit', code => {
      if (stopError) {
        finalize(stopError);
        return;
      }
      if (resultReceived) {
        finalize(resultError || (code === 0 ? null : thumbnailValidationError(
          `缩略图渲染进程异常退出（${code}）。`,
          'thumbnail_failed',
          500,
        )));
        return;
      }
      finalize(thumbnailValidationError(
        code === 0 ? '缩略图渲染进程未返回结果。' : `缩略图渲染进程异常退出（${code}）。`,
        'thumbnail_failed',
        500,
      ));
    });
    signal?.addEventListener?.('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    timer = setTimeout(() => stopFor(thumbnailTimeoutError(timeout)), timeout);
    timer.unref?.();
  });
}

function parsePngForPortableThumbnail(buffer) {
  validatePngBuffer(buffer, {
    maxBytes: THUMBNAIL_PORTABLE_MAX_SOURCE_BYTES,
    maxRgbaBytes: THUMBNAIL_JS_MAX_SOURCE_RGBA_BYTES,
    maxInflatedBytes: THUMBNAIL_JS_MAX_INFLATED_BYTES,
    maxSide: RENDERED_PNG_MAX_SIDE,
    validateInflatedPayload: false,
    messages: {
      invalidPng: '缩略图源图已损坏或格式无效；请点开查看原图。',
      dimensionsTooLarge: '缩略图源图尺寸过大；请点开查看原图。',
      rgbaTooLarge: '缩略图源图解码后过大；请点开查看原图。',
      decodedTooLarge: '缩略图源图解压后的像素数据过大；请点开查看原图。',
      payloadTooLarge: '缩略图源文件过大；请点开查看原图。',
    },
    codes: {
      invalidPng: 'thumbnail_invalid_png',
      dimensionsTooLarge: 'thumbnail_limit_exceeded',
      rgbaTooLarge: 'thumbnail_limit_exceeded',
      decodedTooLarge: 'thumbnail_limit_exceeded',
      payloadTooLarge: 'thumbnail_limit_exceeded',
      tooManyChunks: 'thumbnail_limit_exceeded',
    },
    statuses: {
      invalidPng: 500,
      dimensionsTooLarge: 413,
      rgbaTooLarge: 413,
      decodedTooLarge: 413,
      payloadTooLarge: 413,
      tooManyChunks: 413,
    },
    errorFactory: thumbnailValidationError,
  });
  let offset = 8;
  let ihdr = null;
  const idat = [];
  let sawIend = false;
  while (offset + 12 <= buffer.length) {
    const chunkLength = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    const nextOffset = dataEnd + 4;
    if (!ihdr) {
      ihdr = {
        width: buffer.readUInt32BE(dataStart),
        height: buffer.readUInt32BE(dataStart + 4),
        bitDepth: buffer[dataStart + 8],
        colorType: buffer[dataStart + 9],
        compression: buffer[dataStart + 10],
        filter: buffer[dataStart + 11],
        interlace: buffer[dataStart + 12],
      };
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      sawIend = true;
      break;
    }
    offset = nextOffset;
  }
  if (!ihdr || !sawIend || !idat.length) {
    throw thumbnailValidationError('缩略图源图已损坏；请点开查看原图。', 'thumbnail_invalid_png', 500);
  }
  return { ...ihdr, idat };
}

function thumbnailSourceMaxBytes(platform = process.platform) {
  return RENDERED_PNG_MAX_BYTES;
}

function thumbnailSourceMaxRgbaBytes(platform = process.platform) {
  return RENDERED_PNG_MAX_RGBA_BYTES;
}

function scalePortablePngTopCropToRgba(png, { width, height, signal = null } = {}) {
  const sourceWidth = Number(png.width || 0);
  const sourceHeight = Number(png.height || 0);
  const sourceStride = sourceWidth * 4;
  const expected = sourceStride * sourceHeight;
  if (!Number.isSafeInteger(expected) || expected <= 0 || !Buffer.isBuffer(png.rgba) || png.rgba.length !== expected) {
    throw thumbnailValidationError('缩略图源图数据不完整；请点开查看原图。', 'thumbnail_invalid_png', 500);
  }
  const targetWidth = normalizeThumbnailDimension(width, 320);
  const targetHeight = normalizeThumbnailDimension(height, 420);
  const scaledHeight = Math.max(1, Math.round(sourceHeight * targetWidth / sourceWidth));
  const visibleHeight = Math.min(targetHeight, scaledHeight);
  const sourceX0 = new Uint32Array(targetWidth);
  const sourceX1 = new Uint32Array(targetWidth);
  const sourceXWeight = new Float64Array(targetWidth);
  for (let x = 0; x < targetWidth; x += 1) {
    const mappedX = Math.min(sourceWidth - 1, Math.max(0, (x + 0.5) * sourceWidth / targetWidth - 0.5));
    const x0 = Math.floor(mappedX);
    sourceX0[x] = x0;
    sourceX1[x] = Math.min(sourceWidth - 1, x0 + 1);
    sourceXWeight[x] = mappedX - x0;
  }
  const out = Buffer.alloc(targetHeight * (targetWidth * 4 + 1));
  const targetStride = targetWidth * 4 + 1;
  for (let y = 0; y < visibleHeight; y += 1) {
    if ((y & 31) === 0) throwIfThumbnailAborted(signal);
    const mappedY = Math.min(sourceHeight - 1, Math.max(0, (y + 0.5) * sourceHeight / scaledHeight - 0.5));
    const sourceY0 = Math.floor(mappedY);
    const sourceY1 = Math.min(sourceHeight - 1, sourceY0 + 1);
    const weightY = mappedY - sourceY0;
    const inverseY = 1 - weightY;
    const sourceRow0 = sourceY0 * sourceStride;
    const sourceRow1 = sourceY1 * sourceStride;
    const targetRowOffset = y * targetStride;
    out[targetRowOffset] = 0;
    for (let x = 0; x < targetWidth; x += 1) {
      const weightX = sourceXWeight[x];
      const inverseX = 1 - weightX;
      const weight00 = inverseX * inverseY;
      const weight10 = weightX * inverseY;
      const weight01 = inverseX * weightY;
      const weight11 = weightX * weightY;
      const offset00 = sourceRow0 + sourceX0[x] * 4;
      const offset10 = sourceRow0 + sourceX1[x] * 4;
      const offset01 = sourceRow1 + sourceX0[x] * 4;
      const offset11 = sourceRow1 + sourceX1[x] * 4;
      const targetOffset = targetRowOffset + 1 + x * 4;
      const alpha00 = png.rgba[offset00 + 3] * weight00;
      const alpha10 = png.rgba[offset10 + 3] * weight10;
      const alpha01 = png.rgba[offset01 + 3] * weight01;
      const alpha11 = png.rgba[offset11 + 3] * weight11;
      const alpha = alpha00 + alpha10 + alpha01 + alpha11;
      // Interpolate premultiplied channels so invisible RGB cannot tint text edges.
      if (alpha > 0) {
        out[targetOffset] = Math.round((
          png.rgba[offset00] * alpha00
          + png.rgba[offset10] * alpha10
          + png.rgba[offset01] * alpha01
          + png.rgba[offset11] * alpha11
        ) / alpha);
        out[targetOffset + 1] = Math.round((
          png.rgba[offset00 + 1] * alpha00
          + png.rgba[offset10 + 1] * alpha10
          + png.rgba[offset01 + 1] * alpha01
          + png.rgba[offset11 + 1] * alpha11
        ) / alpha);
        out[targetOffset + 2] = Math.round((
          png.rgba[offset00 + 2] * alpha00
          + png.rgba[offset10 + 2] * alpha10
          + png.rgba[offset01 + 2] * alpha01
          + png.rgba[offset11 + 2] * alpha11
        ) / alpha);
        out[targetOffset + 3] = Math.round(alpha);
      }
    }
  }
  return out;
}

function encodeRgbaPng(width, height, rawScanlines) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE_HEX, 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(rawScanlines, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const payload = Buffer.isBuffer(data) ? data : Buffer.alloc(0);
  const chunk = Buffer.alloc(12 + payload.length);
  chunk.writeUInt32BE(payload.length, 0);
  typeBuffer.copy(chunk, 4);
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(pngCrc32(chunk, 4, 8 + payload.length), 8 + payload.length);
  return chunk;
}

function normalizeThumbnailDimension(value, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 2048);
}

async function installThumbnailCache(tmp, output, { width = 0, height = 0 } = {}) {
  try {
    await fsp.rename(tmp, output);
  } catch (err) {
    if (await validPngCache(output, { width, height })) return;
    await removeInvalidThumbnailCache(output);
    await fsp.rename(tmp, output);
  }
  await assertValidThumbnailPng(output, { width, height, label: 'thumbnail cache' });
}

function pruneThumbnailFailureCache(now = Date.now()) {
  for (const [key, item] of THUMBNAIL_FAILURE_CACHE.entries()) {
    if (now - Number(item?.at || 0) > THUMBNAIL_FAILURE_CACHE_MS) THUMBNAIL_FAILURE_CACHE.delete(key);
  }
  if (THUMBNAIL_FAILURE_CACHE.size <= THUMBNAIL_FAILURE_CACHE_LIMIT) return;
  const oldest = [...THUMBNAIL_FAILURE_CACHE.entries()]
    .sort((a, b) => Number(a[1]?.at || 0) - Number(b[1]?.at || 0));
  for (let i = 0; i < oldest.length - THUMBNAIL_FAILURE_CACHE_LIMIT; i += 1) {
    THUMBNAIL_FAILURE_CACHE.delete(oldest[i][0]);
  }
}

function cachedThumbnailFailure(key, now = Date.now()) {
  const cachedFailure = THUMBNAIL_FAILURE_CACHE.get(key);
  if (!cachedFailure) return null;
  if (now - Number(cachedFailure.at || 0) >= THUMBNAIL_FAILURE_CACHE_MS) {
    THUMBNAIL_FAILURE_CACHE.delete(key);
    return null;
  }
  return Object.assign(new Error(cachedFailure.message || 'thumbnail rendering failed recently'), {
    status: cachedFailure.status || 500,
    code: cachedFailure.code || 'thumbnail_failed',
  });
}

function rememberThumbnailFailure(key, error, now = Date.now()) {
  if (!isCacheableThumbnailFailure(error)) return false;
  THUMBNAIL_FAILURE_CACHE.set(key, {
    at: now,
    message: error?.message || String(error),
    status: error?.status || 500,
    code: error?.code || '',
  });
  pruneThumbnailFailureCache(now);
  return true;
}

function isCacheableThumbnailFailure(error) {
  const code = String(error?.public_code || error?.code || '').trim();
  return code === 'thumbnail_invalid_png' || code === 'thumbnail_format_unsupported';
}

function scheduleThumbnailDiskCachePrune(cacheDir, now = Date.now()) {
  if (THUMBNAIL_WORK.status().closing) return;
  if (THUMBNAIL_DISK_CACHE_PRUNE_IN_FLIGHT || now - LAST_THUMBNAIL_DISK_CACHE_PRUNE_AT < THUMBNAIL_DISK_CACHE_PRUNE_INTERVAL_MS) return;
  LAST_THUMBNAIL_DISK_CACHE_PRUNE_AT = now;
  let tracked = null;
  const lifecycle = pruneThumbnailDiskCache(cacheDir, now)
    .catch(() => {})
    .finally(() => {
      if (THUMBNAIL_DISK_CACHE_PRUNE_IN_FLIGHT === tracked) THUMBNAIL_DISK_CACHE_PRUNE_IN_FLIGHT = null;
    });
  tracked = THUMBNAIL_WORK.track(lifecycle);
  THUMBNAIL_DISK_CACHE_PRUNE_IN_FLIGHT = tracked;
}

async function pruneThumbnailDiskCache(cacheDir, now = Date.now()) {
  const safeDir = await assertSafeTmpPath(cacheDir, { label: 'thumbnail cache directory', allowMissing: true });
  if (!safeDir.exists || !safeDir.stat?.isDirectory()) return;
  const entries = await fsp.readdir(safeDir.resolved, { withFileTypes: true }).catch(() => []);
  const cached = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(safeDir.resolved, entry.name);
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat?.isFile()) continue;
    const age = Math.max(0, now - Number(stat.mtimeMs || 0));
    if (/\.tmp\.png$/i.test(entry.name)) {
      if (age > THUMBNAIL_TEMP_MAX_AGE_MS) await removeThumbnailDiskCacheFile(file);
      continue;
    }
    if (!/\.png$/i.test(entry.name)) continue;
    if (age > THUMBNAIL_DISK_CACHE_MAX_AGE_MS) {
      await removeThumbnailDiskCacheFile(file);
      continue;
    }
    cached.push({ file, mtimeMs: Number(stat.mtimeMs || 0) || 0 });
  }
  if (cached.length <= THUMBNAIL_DISK_CACHE_MAX_FILES) return;
  cached.sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file));
  for (const item of cached.slice(0, cached.length - THUMBNAIL_DISK_CACHE_MAX_FILES)) {
    await removeThumbnailDiskCacheFile(item.file);
  }
}

async function removeThumbnailDiskCacheFile(file) {
  const safe = await assertSafeTmpPath(file, { label: 'thumbnail cache cleanup', requireFile: true }).catch(() => null);
  if (safe?.exists) await fsp.rm(safe.resolved, { force: true }).catch(() => {});
}

async function exists(file) {
  return !!(await assertSafeTmpPath(file, { label: 'thumbnail cache', requireFile: true }).catch(() => null));
}

async function validPngCache(file, { width = 0, height = 0 } = {}) {
  try {
    await assertValidThumbnailPng(file, { width, height, label: 'thumbnail cache' });
    return true;
  } catch {
    return false;
  }
}

export async function readDigestThumbnailPngBuffer(file, { width = 320, height = 420, signal = null } = {}) {
  return (await validateThumbnailPngFile(file, { width, height, label: 'thumbnail cache', signal })).buffer;
}

async function assertValidThumbnailPng(file, { width = 0, height = 0, label = 'thumbnail cache', signal = null } = {}) {
  return (await validateThumbnailPngFile(file, { width, height, label, signal })).file;
}

async function validateThumbnailPngFile(file, { width = 0, height = 0, label = 'thumbnail cache', signal = null } = {}) {
  throwIfThumbnailAborted(signal);
  const safe = await assertSafeTmpPath(file, { label, requireFile: true });
  const st = safe.stat || await fsp.stat(safe.resolved);
  if (!st.isFile() || st.size < 32) throw thumbnailValidationError('缩略图缓存已损坏；请点开查看原图。');
  const expectedWidth = Math.max(0, Math.round(Number(width) || 0));
  const expectedHeight = Math.max(0, Math.round(Number(height) || 0));
  const maxBytes = Math.max(4 * 1024 * 1024, (expectedWidth || 1) * (expectedHeight || 1) * 4);
  const { data: buffer } = await readThumbnailFileBounded(safe.resolved, maxBytes, {
    signal,
    expectedStat: st,
    createTooLargeError: () => thumbnailValidationError('缩略图缓存文件过大；请点开查看原图。'),
    createChangedError: () => thumbnailValidationError('缩略图缓存已变化；请重新打开历史预览。'),
  });
  const dimensions = validatePngBuffer(buffer, {
    maxBytes,
    maxRgbaBytes: Math.max(4, (expectedWidth || 1) * (expectedHeight || 1) * 4),
    maxInflatedBytes: thumbnailExpectedInflatedBytes(expectedWidth || 1, expectedHeight || 1),
    maxSide: Math.max(1, expectedWidth || 1, expectedHeight || 1),
    messages: {
      invalidPng: '缩略图缓存已损坏；请点开查看原图。',
      dimensionsTooLarge: '缩略图缓存尺寸异常；请点开查看原图。',
      rgbaTooLarge: '缩略图缓存尺寸异常；请点开查看原图。',
      payloadTooLarge: '缩略图缓存文件过大；请点开查看原图。',
    },
    codes: {
      invalidPng: 'thumbnail_invalid_png',
      dimensionsTooLarge: 'thumbnail_invalid_png',
      rgbaTooLarge: 'thumbnail_invalid_png',
      payloadTooLarge: 'thumbnail_invalid_png',
    },
    statuses: {
      invalidPng: 500,
      dimensionsTooLarge: 500,
      rgbaTooLarge: 500,
      payloadTooLarge: 500,
    },
    errorFactory: thumbnailValidationError,
  });
  if ((expectedWidth && dimensions.width !== expectedWidth) || (expectedHeight && dimensions.height !== expectedHeight)) {
    throw thumbnailValidationError('缩略图缓存尺寸不匹配；请点开查看原图。');
  }
  return { file: safe.resolved, buffer, dimensions };
}

function thumbnailExpectedInflatedBytes(width, height) {
  const expectedWidth = Math.max(1, Math.round(Number(width) || 0));
  const expectedHeight = Math.max(1, Math.round(Number(height) || 0));
  return (expectedWidth * 4 + 1) * expectedHeight;
}

async function readThumbnailFileBounded(file, maxBytes, {
  signal = null,
  expectedStat = null,
  createTooLargeError = null,
  createChangedError = null,
} = {}) {
  throwIfThumbnailAborted(signal);
  let handle = null;
  try {
    handle = await fsp.open(file, 'r');
    const before = await handle.stat();
    if (!before?.isFile?.()) throw thumbnailValidationError('缩略图文件不是普通文件。');
    if (expectedStat && !thumbnailFileContentStatMatches(expectedStat, before)) {
      throw typeof createChangedError === 'function' ? createChangedError() : thumbnailValidationError('缩略图文件已变化。');
    }
    if (before.size > maxBytes) {
      throw typeof createTooLargeError === 'function' ? createTooLargeError() : thumbnailValidationError('缩略图文件过大。');
    }
    const data = await readFileHandleBounded(handle, maxBytes, {
      checkAbort: () => throwIfThumbnailAborted(signal),
      createTooLargeError: () => (typeof createTooLargeError === 'function' ? createTooLargeError() : thumbnailValidationError('缩略图文件过大。')),
    });
    const after = await handle.stat();
    if (!thumbnailFileContentStatMatches(before, after) || (expectedStat && !thumbnailFileContentStatMatches(expectedStat, after))) {
      throw typeof createChangedError === 'function' ? createChangedError() : thumbnailValidationError('缩略图文件已变化。');
    }
    throwIfThumbnailAborted(signal);
    return { data, stat: after };
  } finally {
    await handle?.close?.().catch(() => {});
  }
}

function thumbnailFileContentStatMatches(a, b) {
  return !!a && !!b
    && a.isFile?.() === true
    && b.isFile?.() === true
    && a.size === b.size
    && a.mtimeMs === b.mtimeMs;
}

function thumbnailValidationError(message = '缩略图缓存已损坏；请点开查看原图。', code = 'thumbnail_invalid_png', status = 500) {
  const err = new Error(message);
  err.status = status || 500;
  err.code = code || 'thumbnail_invalid_png';
  err.public_code = err.code;
  return err;
}

function thumbnailLimitExceededError(message = '缩略图超出安全范围；请点开查看原图。') {
  return thumbnailValidationError(message, 'thumbnail_limit_exceeded', 413);
}

async function removeInvalidThumbnailCache(file) {
  if (!(await exists(file))) return;
  const safe = await assertSafeTmpPath(file, { label: 'thumbnail cache', requireFile: true }).catch(() => null);
  if (!safe) return;
  await fsp.rm(safe.resolved, { force: true }).catch(() => {});
}

function thumbnailAbortError(message = '缩略图生成已取消') {
  return Object.assign(new Error(message), { name: 'AbortError', status: 499 });
}

function thumbnailAbortReason(signal) {
  const reason = signal?.reason;
  return reason instanceof Error
    ? reason
    : thumbnailAbortError(typeof reason === 'string' ? reason : undefined);
}

function thumbnailTimeoutError(timeoutMs) {
  const seconds = Math.max(1, Math.round(Number(timeoutMs || 0) / 1000));
  return Object.assign(new Error(`缩略图生成超过 ${seconds} 秒仍未完成；请点开查看原图。`), { status: 504, code: 'thumbnail_timeout' });
}

function thumbnailQueueFullError() {
  return Object.assign(new Error('缩略图生成队列较多，请稍后再试。'), { status: 429, code: 'thumbnail_queue_full' });
}

function thumbnailQueueTimeoutError(timeoutMs = THUMBNAIL_RENDER_QUEUE_WAIT_MS) {
  const seconds = Math.max(1, Math.round(Number(timeoutMs || 0) / 1000));
  return Object.assign(new Error(`缩略图队列等待超过 ${seconds} 秒；请点开查看原图。`), { status: 504, code: 'thumbnail_queue_timeout' });
}

function thumbnailProcessQuarantinedError(pid = THUMBNAIL_PROCESS_QUARANTINE?.pid || 0) {
  const suffix = pid ? `（进程 ${pid}）` : '';
  return Object.assign(new Error(`上一项缩略图渲染进程${suffix}仍在退出，暂不启动新的缩略图；请稍后重试或点开查看原图。`), {
    status: 503,
    code: 'thumbnail_process_quarantined',
    public_code: 'thumbnail_process_quarantined',
  });
}

function thumbnailShutdownError(message = '') {
  return Object.assign(new Error(message || '服务正在关闭，缩略图生成未开始。'), {
    name: 'AbortError',
    status: 503,
    code: 'thumbnail_shutdown',
    public_code: 'thumbnail_shutdown',
  });
}

export function thumbnailRenderWorkStatus() {
  const work = THUMBNAIL_WORK.status();
  return {
    ...work,
    renders: ACTIVE_THUMBNAIL_RENDERS,
    queued: THUMBNAIL_RENDER_QUEUE.length,
    flights: THUMBNAIL_IN_FLIGHT.size,
    quarantined: !!THUMBNAIL_PROCESS_QUARANTINE,
    cache_prune: !!THUMBNAIL_DISK_CACHE_PRUNE_IN_FLIGHT,
  };
}

export function cancelThumbnailRenderWork(reason = '服务正在关闭，缩略图生成已取消。') {
  const error = thumbnailShutdownError(reason);
  const before = thumbnailRenderWorkStatus();
  const cancelled = THUMBNAIL_WORK.cancel(error);
  for (const flight of THUMBNAIL_IN_FLIGHT.values()) {
    if (!flight?.controller?.signal?.aborted) flight.controller.abort(error);
  }
  rejectQueuedThumbnailRenders(error);
  return { ...before, aborted: cancelled.aborted, closing: true };
}

export async function waitForThumbnailRenderWorkToSettle(timeoutMs = 0) {
  const settled = await THUMBNAIL_WORK.waitForSettled(timeoutMs);
  const status = thumbnailRenderWorkStatus();
  const complete = settled.settled
    && status.renders === 0
    && status.queued === 0
    && status.flights === 0
    && !status.quarantined
    && !status.cache_prune;
  return {
    settled: complete,
    active: settled.active,
    timed_out: settled.timed_out || !complete,
    renders: status.renders,
    queued: status.queued,
    flights: status.flights,
    quarantined: status.quarantined,
    cache_prune: status.cache_prune,
  };
}

function thumbnailProcessError(error) {
  const code = String(error?.code || '').trim();
  if (code === 'ENOENT') {
    return Object.assign(new Error('当前系统无法启动 PowerShell 缩略图渲染；请点开查看原图。'), {
      status: 501,
      code: 'thumbnail_unsupported',
    });
  }
  return Object.assign(new Error('缩略图渲染进程启动失败；请点开查看原图。'), {
    status: 500,
    code: 'thumbnail_failed',
  });
}

function throwIfThumbnailAborted(signal) {
  if (!signal?.aborted) return;
  throw thumbnailAbortReason(signal);
}

function isThumbnailAbortError(error) {
  return error?.name === 'AbortError' || error?.status === 499;
}

function isTransientThumbnailError(error) {
  const code = String(error?.code || '').trim();
  const status = Number(error?.status || 0) || 0;
  return status === 429 || [
    'history_file_changed',
    'thumbnail_queue_full',
    'thumbnail_queue_timeout',
    'thumbnail_timeout',
    'thumbnail_process_quarantined',
    'thumbnail_process_missing',
    'thumbnail_failed',
  ].includes(code);
}

function joinThumbnailFlight(identity, signal, producer) {
  throwIfThumbnailAborted(signal);
  if (THUMBNAIL_WORK.status().closing) throw thumbnailShutdownError();
  const key = String(identity || '').trim();
  if (!key) throw new TypeError('thumbnail single-flight identity is required');
  let flight = THUMBNAIL_IN_FLIGHT.get(key);
  let created = false;
  if (!flight) {
    created = true;
    const controller = new AbortController();
    flight = {
      controller,
      finished: false,
      waiterCount: 0,
      promise: null,
    };
    THUMBNAIL_IN_FLIGHT.set(key, flight);
    flight.promise = THUMBNAIL_WORK.run(producer, { signal: controller.signal })
      .then(
        value => {
          flight.finished = true;
          return value;
        },
        error => {
          flight.finished = true;
          throw error;
        },
      )
      .finally(() => {
        if (THUMBNAIL_IN_FLIGHT.get(key) === flight) THUMBNAIL_IN_FLIGHT.delete(key);
      });
  }

  flight.waiterCount += 1;
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const release = () => {
      if (settled) return false;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      flight.waiterCount = Math.max(0, flight.waiterCount - 1);
      if (flight.waiterCount === 0 && !flight.finished && !flight.controller.signal.aborted) {
        flight.controller.abort(thumbnailAbortError('所有缩略图请求均已取消'));
      }
      return true;
    };
    const finish = (fn, value) => {
      if (!release()) return;
      fn(value);
    };
    const onAbort = () => finish(
      reject,
      thumbnailAbortReason(signal),
    );
    signal?.addEventListener?.('abort', onAbort, { once: true });
    flight.promise.then(
      value => finish(resolve, value),
      error => finish(reject, error),
    );
    if (signal?.aborted) onAbort();
  });
  return { created, promise };
}

function withThumbnailRenderSlot(signal, task) {
  throwIfThumbnailAborted(signal);
  return new Promise((resolve, reject) => {
    if (THUMBNAIL_WORK.status().closing) {
      reject(thumbnailShutdownError());
      return;
    }
    if (THUMBNAIL_PROCESS_QUARANTINE) {
      reject(thumbnailProcessQuarantinedError());
      return;
    }
    if (THUMBNAIL_RENDER_QUEUE.length >= THUMBNAIL_RENDER_QUEUE_LIMIT) {
      reject(thumbnailQueueFullError());
      return;
    }
    const item = { resolve, reject, signal, task, onAbort: null, queueTimer: null, settled: false };
    const rejectQueuedItem = error => {
      if (item.settled) return;
      item.settled = true;
      const index = THUMBNAIL_RENDER_QUEUE.indexOf(item);
      if (index >= 0) THUMBNAIL_RENDER_QUEUE.splice(index, 1);
      if (item.queueTimer) clearTimeout(item.queueTimer);
      signal?.removeEventListener?.('abort', item.onAbort);
      reject(error);
    };
    item.onAbort = () => rejectQueuedItem(thumbnailAbortReason(signal));
    item.queueTimer = setTimeout(() => rejectQueuedItem(thumbnailQueueTimeoutError()), THUMBNAIL_RENDER_QUEUE_WAIT_MS);
    item.queueTimer.unref?.();
    signal?.addEventListener?.('abort', item.onAbort, { once: true });
    THUMBNAIL_RENDER_QUEUE.push(item);
    drainThumbnailRenderQueue();
  });
}

function drainThumbnailRenderQueue() {
  if (THUMBNAIL_WORK.status().closing) {
    rejectQueuedThumbnailRenders(thumbnailShutdownError());
    return;
  }
  if (THUMBNAIL_PROCESS_QUARANTINE) {
    rejectQueuedThumbnailRenders();
    return;
  }
  while (ACTIVE_THUMBNAIL_RENDERS < THUMBNAIL_RENDER_CONCURRENCY && THUMBNAIL_RENDER_QUEUE.length) {
    const item = THUMBNAIL_RENDER_QUEUE.shift();
    if (item.settled) continue;
    if (item.signal?.aborted) {
      item.settled = true;
      if (item.queueTimer) clearTimeout(item.queueTimer);
      item.signal.removeEventListener?.('abort', item.onAbort);
      item.reject(thumbnailAbortReason(item.signal));
      continue;
    }
    item.settled = true;
    if (item.queueTimer) clearTimeout(item.queueTimer);
    item.signal?.removeEventListener?.('abort', item.onAbort);
    ACTIVE_THUMBNAIL_RENDERS++;
    Promise.resolve()
      .then(() => item.task())
      .then(item.resolve, item.reject)
      .finally(() => {
        ACTIVE_THUMBNAIL_RENDERS = Math.max(0, ACTIVE_THUMBNAIL_RENDERS - 1);
        drainThumbnailRenderQueue();
      });
  }
}

function runPowerShell(args, { signal = null, timeoutMs = THUMBNAIL_RENDER_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(thumbnailAbortReason(signal));
      return;
    }
    const powerShellPath = windowsPowerShellExecutablePath();
    if (!powerShellPath) {
      reject(thumbnailValidationError('缩略图渲染失败：找不到受信任的 Windows PowerShell。', 'thumbnail_process_missing', 501));
      return;
    }
    let child;
    try {
      child = spawn(powerShellPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      reject(thumbnailProcessError(e));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    let pendingKillError = null;
    let childClosed = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      fn(value);
    };
    const killFor = error => {
      if (pendingKillError || settled) return;
      pendingKillError = error;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      signal?.removeEventListener?.('abort', onAbort);
      terminateWindowsProcessTree(child, {
        isClosed: () => childClosed,
        retryMs: THUMBNAIL_PROCESS_KILL_GRACE_MS,
        pollMs: THUMBNAIL_PROCESS_POLL_MS,
        responseWaitMs: THUMBNAIL_PROCESS_RESPONSE_WAIT_MS,
      }).then(({ pid, terminated, cleanup }) => {
        if (!terminated) {
          quarantineThumbnailProcess(pid, cleanup);
          attachWindowsProcessCleanup(pendingKillError, cleanup);
        }
        finish(reject, pendingKillError);
      });
    };
    const onAbort = () => {
      killFor(thumbnailAbortReason(signal));
    };
    const timeout = Math.max(1000, Number(timeoutMs || THUMBNAIL_RENDER_TIMEOUT_MS) || THUMBNAIL_RENDER_TIMEOUT_MS);
    timer = setTimeout(() => {
      killFor(thumbnailTimeoutError(timeout));
    }, timeout);
    timer.unref?.();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', chunk => {
      stdout = appendBoundedOutputTail(stdout, chunk, THUMBNAIL_PROCESS_OUTPUT_TAIL_MAX_CHARS);
    });
    child.stderr.on('data', chunk => {
      stderr = appendBoundedOutputTail(stderr, chunk, THUMBNAIL_PROCESS_OUTPUT_TAIL_MAX_CHARS);
    });
    child.on('error', err => {
      if (pendingKillError) return;
      const processError = thumbnailProcessError(err);
      if (Number.isSafeInteger(child.pid) && child.pid > 0) killFor(processError);
      else finish(reject, processError);
    });
    child.on('close', code => {
      childClosed = true;
      if (pendingKillError) {
        return;
      }
      if (code === 0) finish(resolve, { stdout, stderr });
      else finish(reject, thumbnailRenderFailedError(stderr || stdout, code));
    });
    if (signal?.aborted) onAbort();
  });
}

function appendBoundedOutputTail(current, chunk, maxChars) {
  const combined = `${current}${String(chunk || '')}`;
  return combined.length > maxChars ? combined.slice(-maxChars) : combined;
}

async function cleanupThumbnailTemp(file) {
  await assertSafeTmpPath(file, { label: 'thumbnail temp', requireFile: true })
    .then(safe => fsp.rm(safe.resolved, { force: true }))
    .catch(() => {});
}

function rejectQueuedThumbnailRenders(error = null) {
  while (THUMBNAIL_RENDER_QUEUE.length) {
    const item = THUMBNAIL_RENDER_QUEUE.shift();
    if (!item || item.settled) continue;
    item.settled = true;
    if (item.queueTimer) clearTimeout(item.queueTimer);
    item.signal?.removeEventListener?.('abort', item.onAbort);
    item.reject(error || thumbnailProcessQuarantinedError());
  }
}

function quarantineThumbnailProcess(pid, cleanup) {
  const token = Symbol('thumbnail-process-quarantine');
  const trackedCleanup = THUMBNAIL_WORK.track(cleanup);
  THUMBNAIL_PROCESS_QUARANTINE = { token, pid, cleanup: trackedCleanup };
  rejectQueuedThumbnailRenders();
  void trackedCleanup.then(() => {
    if (THUMBNAIL_PROCESS_QUARANTINE?.token === token) THUMBNAIL_PROCESS_QUARANTINE = null;
  }, () => {});
}

function thumbnailRenderFailedError(detail = '', exitCode = 1) {
  const err = new Error('缩略图渲染失败；请点开查看原图。');
  err.status = 500;
  err.code = 'thumbnail_failed';
  err.exit_code = exitCode;
  const raw = String(detail || '').trim();
  if (raw) err.raw_detail = raw;
  return err;
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
  let crc = 0xffffffff;
  for (let i = start; i < end; i += 1) {
    crc = PNG_CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
