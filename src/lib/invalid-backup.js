import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readFileHandleBounded } from './bounded-read.js';
import { syncDirectory } from './json-store.js';

function invalidBackupError(message, code, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

async function readBackupSource(file, maxBytes) {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { data: null, reason: 'not_regular' };
  }
  if (stat.size > maxBytes) {
    return { data: null, reason: 'too_large', bytes: stat.size };
  }
  let handle = null;
  try {
    handle = await fsp.open(file, 'r');
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) return { data: null, reason: 'not_regular' };
    const data = await readFileHandleBounded(handle, maxBytes, {
      createTooLargeError: bytes => invalidBackupError('invalid file grew beyond its backup limit', 'invalid_backup_source_too_large', {
        bytes,
        max_bytes: maxBytes,
      }),
    });
    return { data, reason: '' };
  } finally {
    await handle?.close?.().catch(() => {});
  }
}

async function existingBackupMatches(file, expectedHash, maxBytes) {
  const source = await readBackupSource(file, maxBytes);
  if (!source.data) return false;
  return crypto.createHash('sha256').update(source.data).digest('hex') === expectedHash;
}

export async function preserveInvalidFileBackup(file, { maxBytes, mode } = {}) {
  const originalPath = path.resolve(file);
  const limit = Math.floor(Number(maxBytes));
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('invalid backup requires a positive maxBytes limit');
  let source;
  try {
    source = await readBackupSource(originalPath, limit);
  } catch (e) {
    if (e?.code === 'ENOENT') {
      return { original_path: originalPath, backup_path: '', backup_available: false, original_preserved: false, reason: 'missing' };
    }
    if (e?.code === 'invalid_backup_source_too_large') {
      return {
        original_path: originalPath,
        backup_path: '',
        backup_available: false,
        original_preserved: true,
        reason: 'too_large',
        bytes: Number(e?.bytes || 0),
      };
    }
    throw e;
  }
  if (!source.data) {
    return {
      original_path: originalPath,
      backup_path: '',
      backup_available: false,
      original_preserved: true,
      reason: source.reason || 'unavailable',
      ...(source.bytes ? { bytes: source.bytes } : {}),
    };
  }
  const hash = crypto.createHash('sha256').update(source.data).digest('hex');
  const ext = path.extname(originalPath);
  const base = originalPath.slice(0, originalPath.length - ext.length);
  const backupPath = `${base}.invalid.${hash.slice(0, 24)}${ext}`;
  const existing = await fsp.lstat(backupPath).catch(e => {
    if (e?.code === 'ENOENT') return null;
    throw e;
  });
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || !await existingBackupMatches(backupPath, hash, limit)) {
      throw invalidBackupError('content-addressed invalid backup path is occupied by different data', 'invalid_backup_path_collision');
    }
    return { original_path: originalPath, backup_path: backupPath, backup_available: true, original_preserved: true, reason: '' };
  }
  let handle = null;
  let created = false;
  try {
    handle = Number.isInteger(mode)
      ? await fsp.open(backupPath, 'wx', mode)
      : await fsp.open(backupPath, 'wx');
    created = true;
    await handle.writeFile(source.data);
    await handle.sync();
    await handle.close();
    handle = null;
    await syncDirectory(path.dirname(backupPath));
  } catch (e) {
    await handle?.close?.().catch(() => {});
    if (e?.code === 'EEXIST' && await existingBackupMatches(backupPath, hash, limit)) {
      return { original_path: originalPath, backup_path: backupPath, backup_available: true, original_preserved: true, reason: '' };
    }
    if (created) await fsp.rm(backupPath, { force: true }).catch(() => {});
    throw e;
  }
  return { original_path: originalPath, backup_path: backupPath, backup_available: true, original_preserved: true, reason: '' };
}
