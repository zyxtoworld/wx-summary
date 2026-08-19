import path from 'node:path';
import url from 'node:url';
import fsp from 'node:fs/promises';

export const SRC_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
export const PROJECT_ROOT = path.resolve(SRC_DIR, '..');
export const OUTPUTS_DIR = path.join(PROJECT_ROOT, 'outputs');
export const OUTPUTS_TMP_DIR = path.join(OUTPUTS_DIR, '.tmp');
export const TMP_DIR = acceptanceTmpDirOverride() || OUTPUTS_TMP_DIR;
export const WXDB_TMP_DIR = acceptanceWxdbTmpDirOverride() || TMP_DIR;
export const DATA_DIR = acceptanceDataDirOverride() || path.join(PROJECT_ROOT, 'data');
export const DEFAULT_DIGESTS_DIR = path.join(OUTPUTS_DIR, 'digests');
export const PUBLIC_DIR = path.join(SRC_DIR, 'web', 'public');
export const VIEWS_DIR = path.join(SRC_DIR, 'web', 'views');
export const DISK_SPACE_RESERVE_BYTES = 64 * 1024 * 1024;

function acceptanceDataDirOverride() {
  if (process.env.WX_SUMMARY_ACCEPTANCE_MODE !== '1') return '';
  const raw = String(process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR || '').trim();
  return acceptanceScopedTmpChild(raw, {
    code: 'INVALID_ACCEPTANCE_DATA_DIR',
    message: '验收数据目录必须是 outputs/.tmp 下的独立子目录。',
  });
}

function acceptanceTmpDirOverride() {
  if (process.env.WX_SUMMARY_ACCEPTANCE_MODE !== '1') return '';
  const dataDir = acceptanceDataDirOverride();
  return path.join(dataDir, 'runtime-tmp');
}

function acceptanceWxdbTmpDirOverride() {
  if (process.env.WX_SUMMARY_ACCEPTANCE_MODE !== '1') return '';
  const raw = String(process.env.WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR || '').trim();
  if (!raw) return path.join(TMP_DIR, 'wxdb');
  return acceptanceScopedTmpChild(raw, {
    parent: TMP_DIR,
    code: 'INVALID_ACCEPTANCE_WXDB_TMP_DIR',
    message: '验收数据库临时目录必须是验收临时目录下的独立子目录。',
  });
}

function acceptanceScopedTmpChild(raw = '', {
  parent = OUTPUTS_TMP_DIR,
  code = 'INVALID_ACCEPTANCE_TMP_DIR',
  message = '验收临时目录必须是 outputs/.tmp 下的独立子目录。',
} = {}) {
  const candidate = String(raw || '').trim() ? path.resolve(PROJECT_ROOT, raw) : '';
  const rel = candidate ? path.relative(parent, candidate) : '';
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw Object.assign(new Error(message), {
      code,
      status: 500,
    });
  }
  return candidate;
}

export function platformPathIdentity(value = '', { resolve = true, platform = process.platform } = {}) {
  const text = resolve ? path.resolve(String(value || '')) : String(value || '');
  return platform === 'win32' ? text.toLowerCase() : text;
}

export function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

export function isDiskSpaceError(error = null) {
  const code = String(error?.public_code || error?.code || error?.errno || '').trim();
  if (/^(?:ENOSPC|EDQUOT|SQLITE_FULL|DISK_SPACE_INSUFFICIENT)$/i.test(code) || /disk_space_insufficient$/i.test(code)) return true;
  return /no space left on device|disk full|quota exceeded|database or disk is full|磁盘空间不足|磁盘已满/i.test(String(error?.message || ''));
}

export async function assertAvailableDiskSpace(targetPath, requiredBytes, {
  reserveBytes = DISK_SPACE_RESERVE_BYTES,
  code = 'DISK_SPACE_INSUFFICIENT',
  message = '磁盘可用空间不足，无法安全完成本次写入。',
} = {}) {
  let probe = path.resolve(String(targetPath || PROJECT_ROOT));
  let statfs = null;
  while (!statfs) {
    try {
      statfs = await fsp.statfs(probe);
    } catch (e) {
      if (!['ENOENT', 'ENOTDIR'].includes(String(e?.code || ''))) {
        if (['ENOSYS', 'ENOTSUP'].includes(String(e?.code || ''))) return null;
        throw e;
      }
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
  const availableBytes = Math.max(0, Number(statfs.bavail || 0) * Number(statfs.bsize || 0));
  const payloadBytes = Math.max(0, Number(requiredBytes || 0) || 0);
  const safetyBytes = Math.max(0, Number(reserveBytes || 0) || 0);
  const minimumBytes = payloadBytes + safetyBytes;
  if (Number.isFinite(availableBytes) && availableBytes < minimumBytes) {
    const err = new Error(message);
    err.status = 507;
    err.code = code;
    err.public_code = code;
    err.required_bytes = payloadBytes;
    err.reserve_bytes = safetyBytes;
    err.available_bytes = availableBytes;
    throw err;
  }
  return { available_bytes: availableBytes, required_bytes: payloadBytes, reserve_bytes: safetyBytes };
}

export function resolveInsideProject(inputPath, label = 'path') {
  const resolved = path.resolve(PROJECT_ROOT, inputPath || '.');
  if (!isInside(PROJECT_ROOT, resolved)) {
    const err = new Error(`${label} must stay inside project root`);
    err.code = 'PATH_OUTSIDE_PROJECT';
    err.status = 400;
    throw err;
  }
  return resolved;
}

export function resolveInsideTmp(inputPath, label = 'path') {
  const resolved = resolveInsideProject(inputPath || './outputs/.tmp', label);
  if (!isInside(TMP_DIR, resolved)) {
    const err = new Error(`${label} must stay inside outputs/.tmp`);
    err.code = 'PATH_OUTSIDE_TMP';
    err.status = 400;
    throw err;
  }
  return resolved;
}

export async function ensureOrdinaryDataDir(dataDir = DATA_DIR, { projectRoot = PROJECT_ROOT } = {}) {
  const resolvedProject = path.resolve(projectRoot);
  const resolvedData = path.resolve(dataDir);
  const realProject = await fsp.realpath(resolvedProject).catch(() => '');
  if (!realProject) throw unsafeDataDirError('project root unavailable');
  if (!isInside(resolvedProject, resolvedData) || resolvedProject === resolvedData) {
    throw unsafeDataDirError('data path must be a dedicated directory inside project root');
  }

  let stat = await fsp.lstat(resolvedData).catch(e => {
    if (e?.code === 'ENOENT') return null;
    throw e;
  });
  if (stat && (!stat.isDirectory?.() || stat.isSymbolicLink?.())) {
    throw unsafeDataDirError('data path must be an ordinary project directory');
  }
  if (!stat) {
    await fsp.mkdir(resolvedData).catch(e => {
      if (e?.code !== 'EEXIST') throw e;
    });
    stat = await fsp.lstat(resolvedData).catch(() => null);
  }
  if (!stat?.isDirectory?.() || stat.isSymbolicLink?.()) {
    throw unsafeDataDirError('data path must be an ordinary project directory');
  }

  const realData = await fsp.realpath(resolvedData).catch(() => '');
  if (!realData || !isInside(realProject, realData) || path.resolve(realProject) === path.resolve(realData)) {
    throw unsafeDataDirError('data directory real path must stay inside project root');
  }
  return { realProject, realData };
}

export async function ensureOrdinaryTmpDir() {
  const { realProject, realOutputs } = await ensureOrdinaryOutputsDir();
  const stat = await fsp.lstat(TMP_DIR).catch(e => {
    if (e?.code === 'ENOENT') return null;
    throw e;
  });
  if (stat?.isSymbolicLink?.()) {
    await fsp.unlink(TMP_DIR).catch(() => fsp.rmdir(TMP_DIR).catch(() => {}));
  } else if (stat && !stat.isDirectory()) {
    await fsp.rm(TMP_DIR, { force: true });
  }
  await fsp.mkdir(TMP_DIR, { recursive: true });
  const tmpStat = await fsp.lstat(TMP_DIR).catch(() => null);
  const realTmp = await fsp.realpath(TMP_DIR).catch(() => '');
  if (!tmpStat?.isDirectory?.() || tmpStat.isSymbolicLink?.()) {
    throw unsafeTmpPathError('outputs/.tmp must be an ordinary directory', 'UNSAFE_TMP_DIR');
  }
  if (!realProject || !realOutputs || !realTmp || !isInside(realProject, realOutputs) || !isInside(realOutputs, realTmp) || path.resolve(realOutputs) === path.resolve(realTmp)) {
    const err = new Error('outputs/.tmp must be an ordinary directory inside project outputs/');
    err.status = 500;
    err.code = 'UNSAFE_TMP_DIR';
    throw err;
  }
  return { realProject, realOutputs, realTmp };
}

export async function ensureOrdinaryOutputsDir() {
  const realProject = await fsp.realpath(PROJECT_ROOT).catch(() => '');
  if (!realProject) throw realOutputPathError('project root unavailable');
  let stat = await fsp.lstat(OUTPUTS_DIR).catch(e => {
    if (e?.code === 'ENOENT') return null;
    throw e;
  });
  if (stat && (!stat.isDirectory?.() || stat.isSymbolicLink?.())) {
    throw realOutputPathError('outputs path must be an ordinary project directory', { code: 'UNSAFE_OUTPUTS_DIR' });
  }
  if (!stat) {
    await fsp.mkdir(OUTPUTS_DIR).catch(e => {
      if (e?.code !== 'EEXIST') throw e;
    });
    stat = await fsp.lstat(OUTPUTS_DIR).catch(() => null);
  }
  if (!stat?.isDirectory?.() || stat.isSymbolicLink?.()) {
    throw realOutputPathError('outputs path must be an ordinary project directory', { code: 'UNSAFE_OUTPUTS_DIR' });
  }
  const realOutputs = await fsp.realpath(OUTPUTS_DIR).catch(() => '');
  if (!realOutputs || !isInside(realProject, realOutputs) || path.resolve(realProject) === path.resolve(realOutputs)) {
    throw realOutputPathError('outputs dir outside project', { code: 'UNSAFE_OUTPUTS_DIR' });
  }
  return { realProject, realOutputs };
}

export async function assertSafeTmpPath(targetPath, {
  label = 'tmp path',
  ensureParent = false,
  requireFile = false,
  allowMissing = true,
} = {}) {
  const resolved = resolveInsideTmp(targetPath, label);
  if (path.resolve(resolved) === path.resolve(TMP_DIR)) {
    const err = new Error(`${label} must be a file or child path inside outputs/.tmp`);
    err.status = 400;
    err.code = 'PATH_IS_TMP_ROOT';
    throw err;
  }
  const { realTmp } = await ensureOrdinaryTmpDir();
  const parent = path.dirname(resolved);
  await assertTmpAncestorTree(parent, realTmp, label);
  if (ensureParent) await fsp.mkdir(parent, { recursive: true });
  await assertTmpAncestorTree(parent, realTmp, label);
  let stat = await fsp.lstat(resolved).catch(e => {
    if (e?.code === 'ENOENT') return null;
    throw e;
  });
  if (!stat) {
    if (!allowMissing) {
      const err = new Error(`${label} does not exist`);
      err.status = 404;
      err.code = 'TMP_PATH_MISSING';
      throw err;
    }
    return { resolved, realTmp, exists: false };
  }
  if (stat.isSymbolicLink?.()) throw unsafeTmpPathError(`${label} must not be a symlink or junction`, 'TMP_PATH_REPARSE_POINT');
  if (requireFile && !stat.isFile()) throw unsafeTmpPathError(`${label} must be a regular file`, 'TMP_PATH_NOT_FILE');
  let realTarget = '';
  try {
    realTarget = await fsp.realpath(resolved);
  } catch (error) {
    // A lock or temporary artifact may disappear after lstat while another
    // owner publishes or releases it. Re-check the exact path before treating
    // that handoff as missing; a replacement must still pass all normal type
    // and real-path checks.
    if (error?.code === 'ENOENT') {
      const current = await fsp.lstat(resolved).catch(e => {
        if (e?.code === 'ENOENT') return null;
        throw e;
      });
      if (!current) {
        if (!allowMissing) {
          const missing = new Error(`${label} does not exist`);
          missing.status = 404;
          missing.code = 'TMP_PATH_MISSING';
          throw missing;
        }
        return { resolved, realTmp, exists: false };
      }
      if (current.isSymbolicLink?.()) throw unsafeTmpPathError(`${label} must not be a symlink or junction`, 'TMP_PATH_REPARSE_POINT');
      if (requireFile && !current.isFile()) throw unsafeTmpPathError(`${label} must be a regular file`, 'TMP_PATH_NOT_FILE');
      stat = current;
      realTarget = await fsp.realpath(resolved);
    } else {
      throw error;
    }
  }
  if (!realTarget || !isInside(realTmp, realTarget)) throw unsafeTmpPathError(`${label} real path is outside outputs/.tmp`, 'TMP_PATH_REALPATH_OUTSIDE');
  return { resolved, realTmp, realTarget, exists: true, stat };
}

async function assertTmpAncestorTree(targetDir, realTmp, label) {
  const root = path.resolve(TMP_DIR);
  const target = path.resolve(targetDir || TMP_DIR);
  if (!isInside(root, target)) throw unsafeTmpPathError(`${label} parent is outside outputs/.tmp`, 'TMP_PATH_PARENT_OUTSIDE');
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const st = await fsp.lstat(current).catch(e => {
      if (e?.code === 'ENOENT') return null;
      throw e;
    });
    if (!st) break;
    if (st.isSymbolicLink?.()) throw unsafeTmpPathError(`${label} parent contains a symlink or junction`, 'TMP_PATH_REPARSE_POINT');
    if (!st.isDirectory()) throw unsafeTmpPathError(`${label} parent is not a directory`, 'TMP_PATH_PARENT_NOT_DIRECTORY');
    const real = await fsp.realpath(current).catch(() => '');
    if (!real || !isInside(realTmp, real)) throw unsafeTmpPathError(`${label} parent real path is outside outputs/.tmp`, 'TMP_PATH_REALPATH_OUTSIDE');
  }
}

function unsafeTmpPathError(message, code) {
  const err = new Error(message);
  err.status = 403;
  err.code = code || 'UNSAFE_TMP_PATH';
  return err;
}

function unsafeDataDirError(message) {
  const err = new Error(message);
  err.status = 500;
  err.code = 'UNSAFE_DATA_DIR';
  return err;
}

export function outputDirFromSettings(settings) {
  const resolved = resolveInsideProject(settings?.output?.dir || './outputs/digests', 'output.dir');
  if (!isInside(OUTPUTS_DIR, resolved)) {
    const err = new Error('output.dir must stay inside outputs/');
    err.code = 'PATH_OUTSIDE_OUTPUTS';
    err.status = 400;
    throw err;
  }
  if (path.resolve(resolved) === path.resolve(OUTPUTS_DIR)) {
    const err = new Error('output.dir must be a dedicated subdirectory under outputs/');
    err.code = 'PATH_OUTPUTS_ROOT';
    err.status = 400;
    throw err;
  }
  if (isInside(OUTPUTS_TMP_DIR, resolved)) {
    const err = new Error('output.dir must not be inside outputs/.tmp');
    err.code = 'PATH_INSIDE_TMP';
    err.status = 400;
    throw err;
  }
  return resolved;
}

export async function assertRealOutputDir(base, { ensure = false, allowMissing = false } = {}) {
  const resolved = path.resolve(base || DEFAULT_DIGESTS_DIR);
  if (isInside(OUTPUTS_TMP_DIR, resolved)) throw realOutputPathError('output dir inside outputs/.tmp');
  const { realProject, realOutputs } = await ensureOrdinaryOutputsDir();
  const realTmp = await fsp.realpath(OUTPUTS_TMP_DIR).catch(() => '');
  if (ensure || allowMissing) {
    await assertCreatableInsideRealOutputs(resolved, { realOutputs, realTmp });
  }
  if (ensure) {
    await fsp.mkdir(resolved, { recursive: true });
  }
  const realBase = await fsp.realpath(resolved).catch(e => {
    if (e?.code === 'ENOENT') return '';
    throw e;
  });
  if (!realBase) {
    if (allowMissing) return { realOutputs, realTmp, realBase: '', missing: true };
    throw realOutputPathError('output dir missing', { code: 'OUTPUT_DIR_MISSING', status: 404 });
  }
  const baseStat = await fsp.lstat(resolved).catch(e => {
    if (e?.code === 'ENOENT') return null;
    throw e;
  });
  if (!baseStat?.isDirectory?.()) {
    throw realOutputPathError('output path must be a directory', { code: 'OUTPUT_PATH_NOT_DIRECTORY', status: 400 });
  }
  if (!realProject || !realOutputs || !isInside(realProject, realOutputs) || !isInside(realOutputs, realBase) || path.resolve(realOutputs) === path.resolve(realBase)) {
    throw realOutputPathError('output dir outside outputs/');
  }
  if (realTmp && isInside(realTmp, realBase)) throw realOutputPathError('output dir inside outputs/.tmp');
  return { realOutputs, realTmp, realBase, missing: false };
}

async function assertCreatableInsideRealOutputs(target, { realOutputs, realTmp = '' } = {}) {
  const existing = await closestExistingPath(target);
  const realExisting = existing ? await fsp.realpath(existing).catch(() => '') : '';
  if (!realExisting || !isInside(realOutputs, realExisting)) {
    throw realOutputPathError('output dir parent outside outputs/');
  }
  if (realTmp && isInside(realTmp, realExisting)) {
    throw realOutputPathError('output dir parent inside outputs/.tmp');
  }
}

async function closestExistingPath(target) {
  let current = path.resolve(target || DEFAULT_DIGESTS_DIR);
  while (true) {
    try {
      await fsp.access(current);
      return current;
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e;
    }
    const parent = path.dirname(current);
    if (parent === current) return '';
    current = parent;
  }
}

function realOutputPathError(message, { code = 'UNSAFE_OUTPUT_PATH', status = 403 } = {}) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

export function toProjectRelative(absPath) {
  return path.relative(PROJECT_ROOT, absPath).replaceAll(path.sep, '/');
}

export function cleanTmpName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}
