import fsp from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

export async function readJson(file, fallback) {
  try {
    const raw = await fsp.readFile(file, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    if (e?.code === 'ENOENT') return fallback;
    return fallback;
  }
}

export async function writeJsonAtomic(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
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
