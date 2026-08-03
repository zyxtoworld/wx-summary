import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { syncDirectory } from './json-store.js';

const DEFAULT_LOCK_MAX_BYTES = 4096;
const DEFAULT_LOCK_UNLINK_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800, 1600];

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanLockToken(owner = null) {
  return String(owner?.token || '').trim();
}

function lockOwnerTimestampValid(owner = null) {
  const acquiredAt = Number(owner?.acquired_at || 0) || 0;
  if (acquiredAt > 0) return true;
  const createdAt = Date.parse(String(owner?.created_at || ''));
  return Number.isFinite(createdAt) && createdAt > 0;
}

export function atomicProcessLockOwnerIsComplete(owner = null) {
  const pid = Number(owner?.pid || 0);
  const processStartId = String(owner?.process_start_id || '').trim();
  const token = cleanLockToken(owner);
  return plainObject(owner)
    && Number.isSafeInteger(pid)
    && pid > 0
    && processStartId.length > 0
    && processStartId.length <= 512
    && token.length > 0
    && token.length <= 256
    && lockOwnerTimestampValid(owner);
}

export function atomicProcessLockOwnerIsLegacyDeadReclaimable(owner = null) {
  const pid = Number(owner?.pid || 0);
  const processStartId = String(owner?.process_start_id || '').trim();
  const token = cleanLockToken(owner);
  return plainObject(owner)
    && Number.isSafeInteger(pid)
    && pid > 0
    && !processStartId
    && token.length > 0
    && token.length <= 256
    && lockOwnerTimestampValid(owner);
}

function incompleteOwnerError(message = 'process lock owner is incomplete') {
  return Object.assign(new Error(message), {
    code: 'atomic_process_lock_owner_incomplete',
    public_code: 'atomic_process_lock_owner_incomplete',
  });
}

function invalidLockFileTypeError() {
  return Object.assign(new Error('process lock path must be an ordinary file'), {
    code: 'atomic_process_lock_invalid_file_type',
    public_code: 'atomic_process_lock_invalid_file_type',
  });
}

function lockPayload(owner, maxBytes) {
  if (!atomicProcessLockOwnerIsComplete(owner)) throw incompleteOwnerError();
  const raw = JSON.stringify(owner);
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes <= 0 || bytes > maxBytes) {
    throw Object.assign(new Error('process lock owner exceeds the bounded lock payload'), {
      code: 'atomic_process_lock_owner_too_large',
      public_code: 'atomic_process_lock_owner_too_large',
      bytes,
      max_bytes: maxBytes,
    });
  }
  return raw;
}

function lockObservationStat(observed = null) {
  return observed?.stat || observed?.st || null;
}

export function atomicProcessLockObservationMatches(left = null, right = null) {
  const leftStat = lockObservationStat(left);
  const rightStat = lockObservationStat(right);
  return !!leftStat
    && !!rightStat
    && String(left?.raw || '') === String(right?.raw || '')
    && Number(leftStat.size || 0) === Number(rightStat.size || 0)
    && Number(leftStat.mtimeMs || 0) === Number(rightStat.mtimeMs || 0)
    && cleanLockToken(left?.owner) === cleanLockToken(right?.owner);
}

async function readAtomicProcessLockHandle(handle, maxBytes) {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.isSymbolicLink?.()) throw invalidLockFileTypeError();
  if (stat.size <= 0 || stat.size > maxBytes) return { owner: null, raw: '', stat, complete: false };
  const buffer = await handle.readFile();
  if (buffer.length <= 0 || buffer.length > maxBytes) return { owner: null, raw: '', stat, complete: false };
  const raw = buffer.toString('utf8');
  let owner = null;
  try {
    const parsed = JSON.parse(raw);
    if (plainObject(parsed)) owner = parsed;
  } catch {}
  return { owner, raw, stat, complete: atomicProcessLockOwnerIsComplete(owner) };
}

export async function readAtomicProcessLockFile(requestedLockPath, { maxBytes = DEFAULT_LOCK_MAX_BYTES } = {}) {
  const lockPath = path.resolve(String(requestedLockPath || ''));
  const lstat = await fsp.lstat(lockPath).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!lstat) return null;
  if (!lstat.isFile() || lstat.isSymbolicLink()) throw invalidLockFileTypeError();
  let handle = null;
  try {
    handle = await fsp.open(lockPath, 'r');
    return await readAtomicProcessLockHandle(handle, Math.max(256, Number(maxBytes || 0) || DEFAULT_LOCK_MAX_BYTES));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function atomicLockTempPath(lockPath) {
  return path.join(
    path.dirname(lockPath),
    `.${path.basename(lockPath)}.${process.pid}.${crypto.randomUUID()}.owner.tmp`,
  );
}

export async function prepareAtomicProcessLock({
  lockPath: requestedLockPath,
  owner,
  mode = 0o600,
  maxBytes = DEFAULT_LOCK_MAX_BYTES,
} = {}) {
  const lockPath = path.resolve(String(requestedLockPath || ''));
  if (!String(requestedLockPath || '').trim()) throw new TypeError('process lock path is required');
  const boundedMaxBytes = Math.max(256, Number(maxBytes || 0) || DEFAULT_LOCK_MAX_BYTES);
  const raw = lockPayload(owner, boundedMaxBytes);
  const token = cleanLockToken(owner);
  const tempPath = atomicLockTempPath(lockPath);
  let tempHandle = null;
  try {
    tempHandle = await fsp.open(tempPath, 'wx', mode);
    await tempHandle.writeFile(raw, 'utf8');
    await tempHandle.sync();
    await tempHandle.close();
    tempHandle = null;
  } catch (error) {
    await tempHandle?.close().catch(() => {});
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }

  let settled = false;
  const discard = async () => {
    if (settled) return;
    settled = true;
    await fsp.rm(tempPath, { force: true });
  };
  const publish = async () => {
    if (settled) {
      throw Object.assign(new Error('prepared process lock has already been consumed'), {
        code: 'atomic_process_lock_prepared_consumed',
      });
    }
    let lockHandle = null;
    let linked = false;
    try {
      await fsp.link(tempPath, lockPath);
      linked = true;
      await syncDirectory(path.dirname(lockPath));
      lockHandle = await fsp.open(lockPath, 'r+');
      const observed = await readAtomicProcessLockHandle(lockHandle, boundedMaxBytes);
      if (!observed.complete || observed.raw !== raw || cleanLockToken(observed.owner) !== token) {
        throw incompleteOwnerError('published process lock owner failed its complete-payload verification');
      }
      await fsp.rm(tempPath, { force: true });
      settled = true;
      let released = false;
      return {
        handle: lockHandle,
        lock_path: lockPath,
        owner: { ...owner },
        token,
        async release() {
          if (released) return false;
          await lockHandle?.close().catch(() => {});
          lockHandle = null;
          const removed = await releaseAtomicProcessLockFile(lockPath, token);
          released = true;
          return removed;
        },
      };
    } catch (error) {
      await lockHandle?.close().catch(() => {});
      lockHandle = null;
      if (linked) await releaseAtomicProcessLockFile(lockPath, token).catch(() => {});
      await fsp.rm(tempPath, { force: true }).catch(() => {});
      settled = true;
      throw error;
    }
  };
  return { lock_path: lockPath, temp_path: tempPath, owner: { ...owner }, publish, discard };
}

export async function publishAtomicProcessLock(options = {}) {
  const prepared = await prepareAtomicProcessLock(options);
  try {
    return await prepared.publish();
  } catch (error) {
    await prepared.discard().catch(() => {});
    throw error;
  }
}

function isTransientAtomicLockUnlinkError(error = null) {
  const code = String(error?.code || '').trim().toUpperCase();
  if (['EPERM', 'EACCES', 'EBUSY'].includes(code)) return true;
  return /sharing violation|being used|busy|access is denied|permission denied/i.test(String(error?.message || ''));
}

export async function releaseAtomicProcessLockFile(requestedLockPath, expectedToken, {
  readLock = readAtomicProcessLockFile,
  unlink = fsp.unlink,
  retryDelaysMs = DEFAULT_LOCK_UNLINK_RETRY_DELAYS_MS,
} = {}) {
  const lockPath = path.resolve(String(requestedLockPath || ''));
  const token = String(expectedToken || '').trim();
  if (!token) return false;
  const delays = Array.isArray(retryDelaysMs) ? retryDelaysMs : DEFAULT_LOCK_UNLINK_RETRY_DELAYS_MS;
  const observed = await readLock(lockPath);
  if (!observed || !atomicProcessLockOwnerIsComplete(observed.owner)) return false;
  if (cleanLockToken(observed.owner) !== token) return false;
  const claimPath = reclaimClaimPath(lockPath, token);
  let claimed = false;
  try {
    try {
      await fsp.link(lockPath, claimPath);
      claimed = true;
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EEXIST') return false;
      throw error;
    }
    for (let attempt = 0; ; attempt += 1) {
      const [claim, current] = await Promise.all([readLock(claimPath), readLock(lockPath)]);
      if (!claim
        || !current
        || !atomicProcessLockOwnerIsComplete(claim.owner)
        || !atomicProcessLockOwnerIsComplete(current.owner)
        || !atomicProcessLockObservationMatches(observed, claim)
        || !atomicProcessLockObservationMatches(observed, current)
        || cleanLockToken(claim.owner) !== token
        || cleanLockToken(current.owner) !== token) return false;
      try {
        await unlink(lockPath);
        await syncDirectory(path.dirname(lockPath));
        return true;
      } catch (error) {
        if (error?.code === 'ENOENT') return false;
        const delayMs = delays[attempt];
        if (!isTransientAtomicLockUnlinkError(error) || delayMs === undefined) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(delayMs || 0) || 0)));
      }
    }
  } finally {
    if (claimed) await fsp.rm(claimPath, { force: true }).catch(() => {});
  }
}

function reclaimClaimPath(lockPath, token) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex').slice(0, 24);
  return `${lockPath}.reclaim.${tokenHash}`;
}

export async function reclaimAtomicProcessLockFile(requestedLockPath, observed, {
  ownerState = 'unknown',
  readLock = readAtomicProcessLockFile,
  allowLegacyDeadOwner = false,
} = {}) {
  const lockPath = path.resolve(String(requestedLockPath || ''));
  if (!observed) return true;
  const ownerCanBeReclaimed = owner => atomicProcessLockOwnerIsComplete(owner)
    || (allowLegacyDeadOwner === true
      && ownerState === 'dead'
      && atomicProcessLockOwnerIsLegacyDeadReclaimable(owner));
  if (!ownerCanBeReclaimed(observed.owner)) {
    throw incompleteOwnerError('fixed process lock contains an empty, truncated, or malformed owner');
  }
  if (!['dead', 'different'].includes(String(ownerState || ''))) return false;
  const current = await readLock(lockPath);
  if (!current) return true;
  if (!ownerCanBeReclaimed(current.owner)) {
    throw incompleteOwnerError('fixed process lock changed to an incomplete owner during reclaim');
  }
  if (!atomicProcessLockObservationMatches(observed, current)) return false;
  const token = cleanLockToken(current.owner);
  const reclaimPath = reclaimClaimPath(lockPath, token);
  let claimed = false;
  try {
    try {
      await fsp.link(lockPath, reclaimPath);
      claimed = true;
    } catch (error) {
      if (error?.code === 'ENOENT') return true;
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
    const [claim, fixed] = await Promise.all([readLock(reclaimPath), readLock(lockPath)]);
    if (!claim || !fixed
      || !ownerCanBeReclaimed(claim.owner)
      || !ownerCanBeReclaimed(fixed.owner)
      || !atomicProcessLockObservationMatches(observed, claim)
      || !atomicProcessLockObservationMatches(observed, fixed)
      || cleanLockToken(claim.owner) !== token
      || cleanLockToken(fixed.owner) !== token) return false;
    try {
      await fsp.unlink(lockPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await syncDirectory(path.dirname(lockPath));
    return true;
  } finally {
    if (claimed) await fsp.rm(reclaimPath, { force: true }).catch(() => {});
  }
}
