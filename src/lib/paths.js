import path from 'node:path';
import url from 'node:url';

export const SRC_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
export const PROJECT_ROOT = path.resolve(SRC_DIR, '..');
export const DATA_DIR = path.join(PROJECT_ROOT, 'data');
export const OUTPUTS_DIR = path.join(PROJECT_ROOT, 'outputs');
export const TMP_DIR = path.join(OUTPUTS_DIR, '.tmp');
export const DEFAULT_DIGESTS_DIR = path.join(OUTPUTS_DIR, 'digests');
export const PUBLIC_DIR = path.join(SRC_DIR, 'web', 'public');
export const VIEWS_DIR = path.join(SRC_DIR, 'web', 'views');

export function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
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
  if (isInside(TMP_DIR, resolved)) {
    const err = new Error('output.dir must not be inside outputs/.tmp');
    err.code = 'PATH_INSIDE_TMP';
    err.status = 400;
    throw err;
  }
  return resolved;
}

export function toProjectRelative(absPath) {
  return path.relative(PROJECT_ROOT, absPath).replaceAll(path.sep, '/');
}

export function cleanTmpName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}
