import fsp from 'node:fs/promises';
import path from 'node:path';
import { readFileHandleBounded } from './bounded-read.js';
import { createFileHandleCloser } from './bounded-read.js';

export const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_JSON_READ_MAX_BYTES = 16 * 1024 * 1024;
const WINDOWS_ATOMIC_RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800, 1600, 3200];

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

export async function syncDirectory(dir) {
  let handle = null;
  try {
    handle = await fsp.open(dir, 'r');
    await handle.sync();
  } catch (e) {
    if (!['EINVAL', 'EPERM', 'EACCES', 'ENOTSUP'].includes(String(e?.code || ''))) throw e;
  } finally {
    await handle?.close?.().catch(() => {});
  }
}

function isTransientAtomicRenameError(error) {
  if (process.platform !== 'win32') return false;
  const code = String(error?.code || '').toUpperCase();
  if (['EPERM', 'EACCES', 'EBUSY'].includes(code)) return true;
  return /sharing violation|being used|busy|access is denied|permission denied/i.test(String(error?.message || ''));
}

export async function renameAtomicWithRetry(tmp, file) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (error) {
      const delayMs = WINDOWS_ATOMIC_RENAME_RETRY_DELAYS_MS[attempt];
      if (!isTransientAtomicRenameError(error) || delayMs === undefined) throw error;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

function atomicWriteCommitUnknownError(error, file) {
  const original = error instanceof Error ? error : new Error(String(error || 'atomic write failed'));
  try {
    original.atomic_write_may_have_committed = true;
    original.atomic_write_path = path.resolve(file);
    return original;
  } catch {
    const wrapped = new Error(original.message || 'atomic write outcome is unknown', { cause: error });
    if (original.name) wrapped.name = original.name;
    if (original.code) wrapped.code = original.code;
    wrapped.atomic_write_may_have_committed = true;
    wrapped.atomic_write_path = path.resolve(file);
    return wrapped;
  }
}

export async function writeFileAtomic(file, data, options = {}) {
  const encoding = typeof options === 'string' ? options : options?.encoding;
  const mode = typeof options === 'object' && Number.isInteger(options?.mode) ? options.mode : undefined;
  const dir = path.dirname(file);
  await ensureDir(dir);
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let handle = null;
  let renamed = false;
  try {
    handle = await fsp.open(tmp, 'w', mode);
    if (encoding) await handle.writeFile(data, { encoding });
    else await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await renameAtomicWithRetry(tmp, file);
    renamed = true;
    await syncDirectory(dir);
  } catch (e) {
    await handle?.close?.().catch(() => {});
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw renamed ? atomicWriteCommitUnknownError(e, file) : e;
  }
}

function jsonReadAbortError(signal = null) {
  return signal?.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error('JSON 读取已取消。'), { name: 'AbortError', status: 499 });
}

function throwIfJsonReadAborted(signal = null) {
  if (signal?.aborted) throw jsonReadAbortError(signal);
}

function jsonFileTooLargeError(limit, bytes = 0) {
  return Object.assign(new Error(`JSON 文件超过安全读取上限 ${Math.ceil(limit / 1024 / 1024)}MB。`), {
    code: 'json_file_too_large',
    public_code: 'json_file_too_large',
    status: 413,
    max_bytes: limit,
    ...(bytes > 0 ? { bytes } : {}),
  });
}

function jsonPayloadTooLargeError(limit, bytes = 0) {
  return Object.assign(new Error(`JSON 内容超过安全写入上限 ${Math.ceil(limit / 1024 / 1024)}MB。`), {
    code: 'json_payload_too_large',
    public_code: 'json_payload_too_large',
    status: 413,
    max_bytes: limit,
    ...(bytes > 0 ? { bytes } : {}),
  });
}

export async function readJson(file, fallback, { strict = false, maxBytes = DEFAULT_JSON_READ_MAX_BYTES, signal = null } = {}) {
  let handle = null;
  let closeHandle = null;
  try {
    throwIfJsonReadAborted(signal);
    handle = await fsp.open(file, 'r');
    closeHandle = createFileHandleCloser(handle);
    const requestedLimit = Number(maxBytes);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.floor(requestedLimit)
      : DEFAULT_JSON_READ_MAX_BYTES;
    const stat = await handle.stat();
    if (!stat?.isFile?.()) throw Object.assign(new Error('JSON 路径不是普通文件。'), { code: 'json_file_not_regular', status: 403 });
    if (stat.size > limit) throw jsonFileTooLargeError(limit, stat.size);
    const raw = (await readFileHandleBounded(handle, limit, {
      checkAbort: () => throwIfJsonReadAborted(signal),
      signal,
      closeHandle,
      createTooLargeError: actualBytes => jsonFileTooLargeError(limit, actualBytes),
    })).toString('utf-8');
    throwIfJsonReadAborted(signal);
    return JSON.parse(raw);
  } catch (e) {
    if (signal?.aborted) throw jsonReadAbortError(signal);
    if (e?.name === 'AbortError' || e?.status === 499) throw e;
    if (e?.code === 'ENOENT') return fallback;
    if (strict) throw e;
    return fallback;
  } finally {
    try {
      await closeHandle?.();
    } catch {
      // Preserve the existing best-effort close behavior unless the caller cancelled.
    }
    if (signal?.aborted) throw jsonReadAbortError(signal);
  }
}

export async function writeJsonAtomic(file, data, options = {}) {
  const mode = typeof options === 'object' && Number.isInteger(options?.mode) ? options.mode : undefined;
  const serialized = JSON.stringify(data, null, 2);
  const requestedMaxBytes = typeof options === 'object' ? Number(options?.maxBytes) : 0;
  if (Number.isFinite(requestedMaxBytes) && requestedMaxBytes > 0) {
    const maxBytes = Math.floor(requestedMaxBytes);
    const bytes = Buffer.byteLength(serialized, 'utf-8');
    if (bytes > maxBytes) throw jsonPayloadTooLargeError(maxBytes, bytes);
  }
  await writeFileAtomic(file, serialized, { encoding: 'utf-8', mode });
}

export function deepMerge(a, b) {
  if (Array.isArray(b)) return b;
  if (b && typeof b === 'object' && !Array.isArray(b) && a && typeof a === 'object' && !Array.isArray(a)) {
    const out = { ...a };
    for (const key of Object.keys(b)) out[key] = deepMerge(a[key], b[key]);
    return out;
  }
  return b === undefined ? a : b;
}

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
