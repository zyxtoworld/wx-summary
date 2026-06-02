import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT } from '../lib/paths.js';
import { getWeixinProcesses } from '../wxenv/discovery.js';
import { detectImageMime } from './image-dat.js';

const MAX_WXGF_BYTES = 64 * 1024 * 1024;
let voipEngineCache = { at: 0, path: '' };
let ffmpegCache = { at: 0, path: '', source: '', checked: [] };
const WORKER_PATH = fileURLToPath(new URL('./wxgf-native-worker.js', import.meta.url));

export async function decodeWxgfToImage(data) {
  if (!isWxgf(data)) return null;
  const native = await decodeWxgfWithNativeDll(data);
  if (native) return native;
  return decodeWxgfWithFfmpeg(data);
}

export async function extractVideoFrameToImage(file) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg || !file) return null;
  const output = await runBinary(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-ss', '00:00:01', '-i', file, '-frames:v', '1', '-c:v', 'mjpeg', '-q:v', '4', '-f', 'image2', '-'],
    Buffer.alloc(0),
    { timeoutMs: 15000 },
  ).catch(() => null);
  const mime = detectImageMime(output);
  return mime ? { mime, bytes: output } : null;
}

export async function transcodeAudioToWav(file) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg || !file) return null;
  const output = await runBinary(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', '-'],
    Buffer.alloc(0),
    { timeoutMs: 15000 },
  ).catch(() => null);
  return isWav(output) ? { mime: 'audio/wav', bytes: output } : null;
}

export async function probeMediaTools() {
  const ffmpeg = await resolveFfmpeg();
  const voipEngine = await findVoipEngineDll();
  return {
    ffmpeg: {
      available: !!ffmpeg.path,
      path: ffmpeg.path,
      source: ffmpeg.source,
      checked: ffmpeg.checked,
    },
    voip_engine: {
      available: !!voipEngine,
      path: voipEngine,
    },
  };
}

export function isWxgf(data) {
  return Buffer.isBuffer(data) && data.length >= 16 && data.subarray(0, 4).toString('ascii') === 'wxgf';
}

function isWav(data) {
  return Buffer.isBuffer(data)
    && data.length > 44
    && data.subarray(0, 4).toString('ascii') === 'RIFF'
    && data.subarray(8, 12).toString('ascii') === 'WAVE';
}

export function findWxgfPartitions(data) {
  if (!isWxgf(data)) return [];
  const headerLen = data.readUInt32LE(4);
  const payloadStart = 4 + headerLen;
  if (headerLen <= 0 || payloadStart >= data.length) return [];
  for (const pattern of [Buffer.from([0x00, 0x00, 0x00, 0x01]), Buffer.from([0x00, 0x00, 0x01])]) {
    const partitions = [];
    let offset = 0;
    while (payloadStart + offset < data.length) {
      const index = data.indexOf(pattern, payloadStart + offset);
      if (index < 0) break;
      if (index < 4) {
        offset = index - payloadStart + 1;
        continue;
      }
      const size = data.readUInt32BE(index - 4);
      if (size > 0 && index + size <= data.length) {
        partitions.push({ offset: index, size, ratio: size / data.length });
        offset = index - payloadStart + size;
      } else {
        offset = index - payloadStart + 1;
      }
    }
    if (partitions.length) return partitions.sort((a, b) => b.size - a.size);
  }
  return [];
}

async function decodeWxgfWithNativeDll(data) {
  const dllPath = await findVoipEngineDll();
  if (!dllPath) return null;
  const output = await runBinary(process.execPath, [WORKER_PATH, dllPath], data, { timeoutMs: 15000 }).catch(() => null);
  const mime = detectImageMime(output);
  return mime ? { mime, bytes: output } : null;
}

async function decodeWxgfWithFfmpeg(data) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return null;
  const partition = findWxgfPartitions(data)[0];
  if (!partition) return null;
  const frame = data.subarray(partition.offset, partition.offset + partition.size);
  const output = await runBinary(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'hevc', '-i', '-', '-vframes', '1', '-c:v', 'mjpeg', '-q:v', '4', '-f', 'image2', '-'], frame, { timeoutMs: 15000 }).catch(() => null);
  const mime = detectImageMime(output);
  return mime ? { mime, bytes: output } : null;
}

async function findVoipEngineDll() {
  if (voipEngineCache.path && Date.now() - voipEngineCache.at < 10 * 60 * 1000) return voipEngineCache.path;
  const candidates = [];
  if (process.env.WX_SUMMARY_VOIP_ENGINE) candidates.push(process.env.WX_SUMMARY_VOIP_ENGINE);
  const processes = await getWeixinProcesses().catch(() => []);
  for (const proc of processes) {
    const exeDir = proc.path ? path.dirname(proc.path) : '';
    if (exeDir) {
      candidates.push(path.join(exeDir, 'VoipEngine.dll'));
      const versionDirs = await fsp.readdir(exeDir, { withFileTypes: true }).catch(() => []);
      for (const entry of versionDirs) {
        if (entry.isDirectory()) candidates.push(path.join(exeDir, entry.name, 'VoipEngine.dll'));
      }
    }
    const userLibDir = String(proc.command_line || '').match(/--user-lib-dir="([^"]+)"/i)?.[1];
    if (userLibDir) candidates.push(path.join(userLibDir, 'VoipEngine.dll'));
  }
  candidates.push(
    path.join(process.env.ProgramFiles || '', 'Tencent', 'Weixin', 'VoipEngine.dll'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Tencent', 'Weixin', 'VoipEngine.dll'),
  );

  for (const candidate of uniquePaths(candidates)) {
    const st = await fsp.stat(candidate).catch(() => null);
    if (st?.isFile()) {
      voipEngineCache = { at: Date.now(), path: candidate };
      return candidate;
    }
  }
  voipEngineCache = { at: Date.now(), path: '' };
  return '';
}

async function findFfmpeg() {
  return (await resolveFfmpeg()).path;
}

async function resolveFfmpeg() {
  if (Date.now() - ffmpegCache.at < 10 * 60 * 1000) return ffmpegCache;
  const checked = [];
  for (const candidate of await collectFfmpegCandidates()) {
    checked.push(candidate.source);
    const ok = await runBinary(candidate.file, ['-version'], Buffer.alloc(0), { timeoutMs: 5000 }).then(() => true, () => false);
    if (ok) {
      ffmpegCache = { at: Date.now(), path: candidate.file, source: candidate.source, checked: uniqueStrings(checked) };
      return ffmpegCache;
    }
  }
  ffmpegCache = { at: Date.now(), path: '', source: '', checked: uniqueStrings(checked) };
  return ffmpegCache;
}

async function collectFfmpegCandidates() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [];
  const add = (file, source) => {
    if (!file) return;
    candidates.push({ file: String(file), source });
  };

  add(process.env.FFMPEG_PATH, 'FFMPEG_PATH');
  add(path.join(PROJECT_ROOT, 'bin', exe), 'project bin');
  add(path.join(PROJECT_ROOT, 'tools', 'ffmpeg', 'bin', exe), 'project tools');
  add(path.join(PROJECT_ROOT, 'node_modules', 'ffmpeg-static', exe), 'ffmpeg-static');
  if (process.platform === 'win32') {
    add(path.join(PROJECT_ROOT, 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe'), '@ffmpeg-installer/win32-x64');
    add(path.join(process.env.ChocolateyInstall || 'C:\\ProgramData\\chocolatey', 'bin', 'ffmpeg.exe'), 'Chocolatey');
    add(path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'), 'WinGet Links');
    add(path.join(process.env.ProgramFiles || '', 'ffmpeg', 'bin', 'ffmpeg.exe'), 'Program Files');
    add(path.join(process.env['ProgramFiles(x86)'] || '', 'ffmpeg', 'bin', 'ffmpeg.exe'), 'Program Files x86');
    add('ffmpeg.exe', 'PATH');
  } else {
    add('/opt/homebrew/bin/ffmpeg', 'Homebrew');
    add('/usr/local/bin/ffmpeg', 'local bin');
    add('/usr/bin/ffmpeg', 'system bin');
    add('ffmpeg', 'PATH');
  }

  const processes = await getWeixinProcesses().catch(() => []);
  for (const proc of processes) {
    const exeDir = proc.path ? path.dirname(proc.path) : '';
    if (exeDir) {
      add(path.join(exeDir, exe), 'Weixin install dir');
      const versionDirs = await fsp.readdir(exeDir, { withFileTypes: true }).catch(() => []);
      for (const entry of versionDirs) {
        if (entry.isDirectory()) add(path.join(exeDir, entry.name, exe), 'Weixin version dir');
      }
    }
    const userLibDir = String(proc.command_line || '').match(/--user-lib-dir="([^"]+)"/i)?.[1];
    if (userLibDir) add(path.join(userLibDir, exe), 'Weixin user lib dir');
  }

  return uniqueCandidates(candidates);
}

function runBinary(file, args, input, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    if (input?.length > MAX_WXGF_BYTES) {
      reject(new Error('wxgf input too large'));
      return;
    }
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const stdout = [];
    const stderr = [];
    let outBytes = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('wxgf conversion timed out'));
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      outBytes += chunk.length;
      if (outBytes <= MAX_WXGF_BYTES) stdout.push(chunk);
      else child.kill();
    });
    child.stderr.on('data', chunk => {
      if (stderr.reduce((n, b) => n + b.length, 0) < 4096) stderr.push(chunk);
    });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', code => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout);
      if (code === 0 && output.length) resolve(output);
      else reject(new Error(Buffer.concat(stderr).toString('utf-8').slice(0, 200) || `process exited ${code}`));
    });
    child.stdin.end(input || Buffer.alloc(0));
  });
}

function uniqueCandidates(candidates) {
  const out = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const file = String(candidate.file || '').trim();
    if (!file) continue;
    const key = file.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ file, source: candidate.source || path.basename(file) });
    }
  }
  return out;
}

function uniquePaths(paths) {
  const out = [];
  const seen = new Set();
  for (const p of paths) {
    if (!p) continue;
    const resolved = path.resolve(p);
    const key = resolved.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(resolved);
    }
  }
  return out;
}

function uniqueStrings(items) {
  return [...new Set(items.map(item => String(item || '')).filter(Boolean))];
}
