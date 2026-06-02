import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TMP_DIR } from '../lib/paths.js';
import { ensureDir } from '../lib/json-store.js';

const SCRIPT_PATH = fileURLToPath(new URL('./render-digest.ps1', import.meta.url));

export async function renderDigestPngDataUrl(digest, renderOptions = {}) {
  if (process.platform !== 'win32') {
    throw Object.assign(new Error('server PNG rendering currently requires Windows'), { status: 501 });
  }
  await ensureDir(TMP_DIR);
  const id = crypto.randomBytes(8).toString('hex');
  const inputJson = path.join(TMP_DIR, `render-${id}.json`);
  const outputPng = path.join(TMP_DIR, `render-${id}.png`);
  const payload = { ...digest, __render: normalizeRenderOptions(renderOptions) };
  await fsp.writeFile(inputJson, JSON.stringify(payload, null, 2), 'utf-8');
  try {
    await runPowerShell([
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT_PATH,
      '-InputJson', inputJson,
      '-OutputPng', outputPng,
    ]);
    const buffer = await fsp.readFile(outputPng);
    if (buffer.length < 32 || buffer.readUInt32BE(0) !== 0x89504e47) {
      throw Object.assign(new Error('server renderer did not produce a PNG'), { status: 500 });
    }
    return `data:image/png;base64,${buffer.toString('base64')}`;
  } finally {
    await fsp.rm(inputJson, { force: true }).catch(() => {});
    await fsp.rm(outputPng, { force: true }).catch(() => {});
  }
}

function normalizeRenderOptions(options = {}) {
  const accentColor = normalizeAccentColor(options.accent_color || options.primary_color || options.accent);
  const theme = options.theme || options.default_theme;
  const fontSize = options.font_size || options.default_font_size;
  return {
    theme: ['light', 'dark'].includes(theme) ? theme : 'light',
    font_size: fontSize === 'large' ? 'large' : 'normal',
    accent_color: accentColor,
  };
}

function normalizeAccentColor(value) {
  const text = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toUpperCase() : '';
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
