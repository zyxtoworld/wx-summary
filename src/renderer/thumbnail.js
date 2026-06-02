import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TMP_DIR } from '../lib/paths.js';
import { ensureDir } from '../lib/json-store.js';

const SCRIPT_PATH = fileURLToPath(new URL('./render-thumbnail.ps1', import.meta.url));

export async function renderDigestThumbnailPng({ filePath, digestId = '', width = 320, height = 420 } = {}) {
  if (process.platform !== 'win32') {
    throw Object.assign(new Error('thumbnail rendering currently requires Windows'), { status: 501 });
  }
  const source = path.resolve(filePath || '');
  const stat = await fsp.stat(source);
  if (!stat.isFile()) throw Object.assign(new Error('thumbnail source is not a file'), { status: 404 });

  const cacheDir = path.join(TMP_DIR, 'thumbs');
  await ensureDir(cacheDir);
  const id = String(digestId || path.basename(source, '.png')).replace(/[^a-z0-9_-]/gi, '').slice(0, 16) || 'digest';
  const key = crypto
    .createHash('sha256')
    .update([source, stat.size, stat.mtimeMs, width, height].join('|'))
    .digest('hex')
    .slice(0, 16);
  const output = path.join(cacheDir, `${id}-${key}.png`);
  if (await exists(output)) return output;

  const tmp = path.join(cacheDir, `${id}-${key}.${process.pid}.${Date.now()}.tmp.png`);
  try {
    await runPowerShell([
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT_PATH,
      '-InputPng', source,
      '-OutputPng', tmp,
      '-Width', String(width),
      '-Height', String(height),
    ]);
    await fsp.rename(tmp, output).catch(async err => {
      if (await exists(output)) return;
      throw err;
    });
    return output;
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

async function exists(file) {
  return !!(await fsp.stat(file).catch(() => null));
}

function runPowerShell(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', err => reject(err));
    child.on('exit', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error((stderr || stdout || `PowerShell exited with ${code}`).trim()), { status: 500 }));
    });
  });
}
