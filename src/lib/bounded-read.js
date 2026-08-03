const DEFAULT_READ_CHUNK_BYTES = 64 * 1024;

export async function readFileHandleBounded(handle, maxBytes, {
  chunkBytes = DEFAULT_READ_CHUNK_BYTES,
  checkAbort = null,
  createTooLargeError = null,
} = {}) {
  const numericLimit = Number(maxBytes);
  if (!Number.isSafeInteger(numericLimit) || numericLimit <= 0) {
    throw new TypeError('bounded file read requires a positive safe integer maxBytes');
  }
  const requestedChunkBytes = Number(chunkBytes);
  const safeChunkBytes = Number.isSafeInteger(requestedChunkBytes) && requestedChunkBytes > 0
    ? requestedChunkBytes
    : DEFAULT_READ_CHUNK_BYTES;
  if (typeof checkAbort === 'function') checkAbort();
  const stat = await handle.stat();
  const observedBytes = Number.isSafeInteger(stat?.size) && stat.size >= 0 ? stat.size : numericLimit;
  const allocationBytes = Math.max(1, Math.min(numericLimit + 1, observedBytes + 1));
  const data = Buffer.allocUnsafe(allocationBytes);
  let total = 0;
  let position = 0;
  while (total < allocationBytes) {
    if (typeof checkAbort === 'function') checkAbort();
    const readBytes = Math.min(safeChunkBytes, allocationBytes - total);
    const { bytesRead } = await handle.read(data, total, readBytes, position);
    if (!bytesRead) break;
    total += bytesRead;
    position += bytesRead;
    if (total > numericLimit) {
      throw typeof createTooLargeError === 'function'
        ? createTooLargeError(total, numericLimit)
        : Object.assign(new Error('file exceeds bounded read limit'), {
          code: 'file_too_large',
          status: 413,
          bytes: total,
          max_bytes: numericLimit,
        });
    }
  }
  if (typeof checkAbort === 'function') checkAbort();
  let finalStat = null;
  try {
    finalStat = await handle.stat();
  } catch (error) {
    throw boundedReadChangedError(stat, null, total, numericLimit, error);
  }
  if (typeof checkAbort === 'function') checkAbort();
  if (total !== observedBytes || !boundedReadStatsMatch(stat, finalStat)) {
    throw boundedReadChangedError(stat, finalStat, total, numericLimit);
  }
  return data.subarray(0, total);
}

function boundedReadStatsMatch(before, after) {
  if (!before || !after) return false;
  if (Number(before.size) !== Number(after.size)) return false;
  for (const field of ['dev', 'ino', 'mtimeMs', 'ctimeMs']) {
    const beforeValue = Number(before[field]);
    const afterValue = Number(after[field]);
    if (Number.isFinite(beforeValue) && Number.isFinite(afterValue) && beforeValue !== afterValue) return false;
  }
  return true;
}

function boundedReadChangedError(before, after, bytes, maxBytes, cause = null) {
  return Object.assign(new Error('文件在读取期间发生变化，请重试。'), {
    code: 'bounded_read_changed',
    status: 409,
    before_bytes: Number(before?.size || 0) || 0,
    after_bytes: Number(after?.size || 0) || 0,
    bytes: Number(bytes || 0) || 0,
    max_bytes: Number(maxBytes || 0) || 0,
    ...(cause ? { cause } : {}),
  });
}
