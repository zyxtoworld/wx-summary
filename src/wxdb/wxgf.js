import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT } from '../lib/paths.js';
import { getWeixinProcesses } from '../wxenv/discovery.js';
import { terminateWindowsProcessTree } from '../lib/windows-process-tree.js';
import { detectImageMime } from './image-dat.js';

const MAX_WXGF_BYTES = 64 * 1024 * 1024;
let voipEngineCache = { at: 0, path: '' };
let ffmpegCache = { at: 0, path: '', source: '', checked: [] };
let voipEngineProbeGeneration = 0;
let ffmpegProbeGeneration = 0;
const WORKER_PATH = fileURLToPath(new URL('./wxgf-native-worker.js', import.meta.url));

export async function decodeWxgfToImage(data, { signal = null } = {}) {
  throwIfWxgfAborted(signal);
  if (!isWxgf(data)) return null;
  const native = await decodeWxgfWithNativeDll(data, { signal });
  if (native) return native;
  return decodeWxgfWithFfmpeg(data, { signal });
}

export async function extractVideoFrameToImage(file, { signal = null } = {}) {
  throwIfWxgfAborted(signal);
  const ffmpeg = await findFfmpeg({ signal });
  throwIfWxgfAborted(signal);
  if (!ffmpeg || !file) return null;
  const output = await runBinary(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-ss', '00:00:01', '-i', file, '-frames:v', '1', '-c:v', 'mjpeg', '-q:v', '4', '-f', 'image2', '-'],
    Buffer.alloc(0),
    { timeoutMs: 15000, signal },
  ).catch(e => {
    if (isWxgfAbort(e, signal)) throw e;
    return null;
  });
  throwIfWxgfAborted(signal);
  const mime = detectImageMime(output);
  return mime ? { mime, bytes: output } : null;
}

export async function transcodeAudioToWav(file, { signal = null } = {}) {
  throwIfWxgfAborted(signal);
  const ffmpeg = await findFfmpeg({ signal });
  throwIfWxgfAborted(signal);
  if (!ffmpeg || !file) return null;
  const output = await runBinary(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', '-'],
    Buffer.alloc(0),
    { timeoutMs: 15000, signal },
  ).catch(e => {
    if (isWxgfAbort(e, signal)) throw e;
    return null;
  });
  throwIfWxgfAborted(signal);
  return isWav(output) ? { mime: 'audio/wav', bytes: output } : null;
}

function wxgfAbortError() {
  return Object.assign(new Error('请求已取消'), { name: 'AbortError', status: 499 });
}

function throwIfWxgfAborted(signal) {
  if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : wxgfAbortError());
}

function isWxgfAbort(error, signal = null) {
  return !!signal?.aborted
    || error?.name === 'AbortError'
    || error?.status === 499
    || error?.code === 'ABORT_ERR';
}

function withWxgfAbort(promise, signal = null) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : wxgfAbortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener?.('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, signal.reason instanceof Error ? signal.reason : wxgfAbortError());
    signal.addEventListener?.('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      value => finish(resolve, value),
      error => finish(reject, error),
    );
  });
}

export async function probeMediaTools({ signal = null } = {}) {
  throwIfWxgfAborted(signal);
  const ffmpeg = await resolveFfmpeg({ signal });
  throwIfWxgfAborted(signal);
  const voipEngine = await findVoipEngineDll({ signal });
  throwIfWxgfAborted(signal);
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

async function decodeWxgfWithNativeDll(data, { signal = null } = {}) {
  throwIfWxgfAborted(signal);
  const dllPath = await findVoipEngineDll({ signal });
  throwIfWxgfAborted(signal);
  if (!dllPath) return null;
  const output = await runBinary(process.execPath, [WORKER_PATH, dllPath], data, { timeoutMs: 15000, signal }).catch(e => {
    if (isWxgfAbort(e, signal)) throw e;
    return null;
  });
  throwIfWxgfAborted(signal);
  const mime = detectImageMime(output);
  return mime ? { mime, bytes: output } : null;
}

async function decodeWxgfWithFfmpeg(data, { signal = null } = {}) {
  throwIfWxgfAborted(signal);
  const ffmpeg = await findFfmpeg({ signal });
  throwIfWxgfAborted(signal);
  if (!ffmpeg) return null;
  const partition = findWxgfPartitions(data)[0];
  if (!partition) return null;
  const frame = data.subarray(partition.offset, partition.offset + partition.size);
  const output = await runBinary(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'hevc', '-i', '-', '-vframes', '1', '-c:v', 'mjpeg', '-q:v', '4', '-f', 'image2', '-'], frame, { timeoutMs: 15000, signal }).catch(e => {
    if (isWxgfAbort(e, signal)) throw e;
    return null;
  });
  throwIfWxgfAborted(signal);
  const mime = detectImageMime(output);
  return mime ? { mime, bytes: output } : null;
}

async function findVoipEngineDll({ signal = null } = {}) {
  throwIfWxgfAborted(signal);
  if (voipEngineCache.path && Date.now() - voipEngineCache.at < 10 * 60 * 1000) return voipEngineCache.path;
  const probeGeneration = ++voipEngineProbeGeneration;
  const candidates = [];
  if (process.env.WX_SUMMARY_VOIP_ENGINE) candidates.push(process.env.WX_SUMMARY_VOIP_ENGINE);
  const processes = await getWeixinProcesses({ signal }).catch(e => {
    if (isWxgfAbort(e, signal)) throw e;
    return [];
  });
  throwIfWxgfAborted(signal);
  for (const proc of processes) {
    throwIfWxgfAborted(signal);
    const exeDir = proc.path ? path.dirname(proc.path) : '';
    if (exeDir) {
      candidates.push(path.join(exeDir, 'VoipEngine.dll'));
      const versionDirs = await withWxgfAbort(
        fsp.readdir(exeDir, { withFileTypes: true }),
        signal,
      ).catch(e => {
        if (isWxgfAbort(e, signal)) throw e;
        return [];
      });
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
    throwIfWxgfAborted(signal);
    const st = await withWxgfAbort(fsp.stat(candidate), signal).catch(e => {
      if (isWxgfAbort(e, signal)) throw e;
      return null;
    });
    if (st?.isFile()) {
      if (probeGeneration === voipEngineProbeGeneration) {
        voipEngineCache = { at: Date.now(), path: candidate };
      }
      return candidate;
    }
  }
  if (probeGeneration === voipEngineProbeGeneration) {
    voipEngineCache = { at: Date.now(), path: '' };
  }
  return '';
}

async function findFfmpeg({ signal = null } = {}) {
  return (await resolveFfmpeg({ signal })).path;
}

async function resolveFfmpeg({ signal = null } = {}) {
  throwIfWxgfAborted(signal);
  if (Date.now() - ffmpegCache.at < 10 * 60 * 1000) return ffmpegCache;
  const probeGeneration = ++ffmpegProbeGeneration;
  const checked = [];
  for (const candidate of await collectFfmpegCandidates({ signal })) {
    throwIfWxgfAborted(signal);
    checked.push(candidate.source);
    const ok = await runBinary(candidate.file, ['-version'], Buffer.alloc(0), { timeoutMs: 5000, signal }).then(() => true, e => {
      if (isWxgfAbort(e, signal)) throw e;
      return false;
    });
    if (ok) {
      const result = { at: Date.now(), path: candidate.file, source: candidate.source, checked: uniqueStrings(checked) };
      if (probeGeneration === ffmpegProbeGeneration) ffmpegCache = result;
      return result;
    }
  }
  const result = { at: Date.now(), path: '', source: '', checked: uniqueStrings(checked) };
  if (probeGeneration === ffmpegProbeGeneration) ffmpegCache = result;
  return result;
}

async function collectFfmpegCandidates({ signal = null } = {}) {
  throwIfWxgfAborted(signal);
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

  const processes = await getWeixinProcesses({ signal }).catch(e => {
    if (isWxgfAbort(e, signal)) throw e;
    return [];
  });
  throwIfWxgfAborted(signal);
  for (const proc of processes) {
    throwIfWxgfAborted(signal);
    const exeDir = proc.path ? path.dirname(proc.path) : '';
    if (exeDir) {
      add(path.join(exeDir, exe), 'Weixin install dir');
      const versionDirs = await withWxgfAbort(
        fsp.readdir(exeDir, { withFileTypes: true }),
        signal,
      ).catch(e => {
        if (isWxgfAbort(e, signal)) throw e;
        return [];
      });
      for (const entry of versionDirs) {
        if (entry.isDirectory()) add(path.join(exeDir, entry.name, exe), 'Weixin version dir');
      }
    }
    const userLibDir = String(proc.command_line || '').match(/--user-lib-dir="([^"]+)"/i)?.[1];
    if (userLibDir) add(path.join(userLibDir, exe), 'Weixin user lib dir');
  }

  return uniqueCandidates(candidates);
}

function runBinary(file, args, input, { timeoutMs, signal = null }) {
  return new Promise((resolve, reject) => {
    if (input?.length > MAX_WXGF_BYTES) {
      reject(new Error('wxgf input too large'));
      return;
    }
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : wxgfAbortError());
      return;
    }
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const stdout = [];
    const stderr = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    let childClosed = false;
    let cleanupStarted = false;
    let cleanupPromise = null;
    let terminationError = null;
    let forceKillTimer = null;
    let timeoutTimer = null;
    let drainsInstalled = false;
    const drainLateError = () => {};
    const installLateErrorDrains = () => {
      if (drainsInstalled) return;
      drainsInstalled = true;
      child.once('error', drainLateError);
      child.stdin.once('error', drainLateError);
      child.stdout.once('error', drainLateError);
      child.stderr.once('error', drainLateError);
    };
    const removeLateErrorDrains = () => {
      if (!drainsInstalled) return;
      drainsInstalled = false;
      child.removeListener('error', drainLateError);
      child.stdin.removeListener('error', drainLateError);
      child.stdout.removeListener('error', drainLateError);
      child.stderr.removeListener('error', drainLateError);
    };
    const recordKillAttempt = ({ phase, result, error }) => {
      if (settled || (result !== false && !error)) return;
      const failure = error || Object.assign(new Error(`wxgf ${phase || 'process'} kill returned false`), {
        code: 'wxgf_process_kill_failed',
        phase: phase || 'process',
      });
      if (!terminationError) {
        terminationError = failure;
        return;
      }
      try {
        const errors = Array.isArray(terminationError.cleanup_errors)
          ? terminationError.cleanup_errors
          : [];
        errors.push(failure);
        terminationError.cleanup_errors = errors;
        if (!terminationError.cleanup_cause) terminationError.cleanup_cause = failure;
      } catch {}
    };
    const rememberCleanupStatus = (confirmed, cleanup = null) => {
      if (!terminationError || typeof terminationError !== 'object') return;
      try {
        terminationError.cleanup_confirmed = confirmed;
        terminationError.cleanup_status = confirmed ? 'confirmed' : 'unconfirmed';
        if (cleanup?.then) terminationError.cleanup_promise = cleanup;
      } catch {}
    };
    const removeBusinessListeners = ({ keepClose = false } = {}) => {
      child.stdout.removeListener('data', onStdoutData);
      child.stderr.removeListener('data', onStderrData);
      child.removeListener('error', onChildError);
      child.stdin.removeListener('error', onStdinError);
      if (!keepClose) child.removeListener('close', onClose);
    };
    const finish = (fn, value, { retainDrains = false } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      signal?.removeEventListener?.('abort', onAbort);
      removeBusinessListeners();
      if (!retainDrains) removeLateErrorDrains();
      fn(value);
    };
    const startProcessTreeCleanup = () => {
      if (settled || childClosed || cleanupPromise) return;
      cleanupPromise = Promise.resolve().then(() => terminateWindowsProcessTree(child, {
        isClosed: () => childClosed,
        retryMs: 1500,
        pollMs: 25,
        responseWaitMs: 1500,
        onKillAttempt: recordKillAttempt,
      })).then(result => {
        if (settled) return;
        if (childClosed || result?.terminated === true) {
          rememberCleanupStatus(true, result?.cleanup);
          finish(reject, terminationError || new Error('wxgf process cleanup completed'), { retainDrains: true });
          return;
        }
        rememberCleanupStatus(false, result?.cleanup);
        finish(reject, terminationError || new Error('wxgf process cleanup was not confirmed'), { retainDrains: true });
      }, error => {
        if (settled) return;
        recordKillAttempt({ phase: 'owner', error });
        rememberCleanupStatus(false);
        finish(reject, terminationError || error, { retainDrains: true });
      });
    };
    const terminate = error => {
      if (settled) return;
      if (!terminationError) terminationError = error;
      if (cleanupStarted) return;
      cleanupStarted = true;
      removeBusinessListeners({ keepClose: true });
      installLateErrorDrains();
      try {
        const result = child.kill();
        recordKillAttempt({ phase: 'initial', result });
      } catch (killError) {
        recordKillAttempt({ phase: 'initial', error: killError });
      }
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => {
          forceKillTimer = null;
          startProcessTreeCleanup();
        }, 1500);
        forceKillTimer.unref?.();
      }
    };
    const onAbort = () => {
      terminate(signal.reason instanceof Error ? signal.reason : wxgfAbortError());
    };
    timeoutTimer = setTimeout(() => {
      terminate(new Error('wxgf conversion timed out'));
    }, timeoutMs);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const onChildError = err => {
      if (settled) return;
      if (!terminationError) terminationError = err;
    };
    const onStdinError = err => {
      if (settled) return;
      if (!terminationError) terminationError = err;
      terminate(terminationError);
    };
    const onClose = code => {
      childClosed = true;
      if (settled) return;
      if (cleanupStarted) {
        rememberCleanupStatus(true);
        installLateErrorDrains();
        finish(reject, terminationError || new Error('wxgf conversion process terminated'), { retainDrains: true });
        return;
      }
      const output = Buffer.concat(stdout);
      if (terminationError) {
        installLateErrorDrains();
        finish(reject, terminationError, { retainDrains: true });
        return;
      }
      installLateErrorDrains();
      if (code === 0 && output.length) finish(resolve, output, { retainDrains: true });
      else finish(reject, new Error(Buffer.concat(stderr).toString('utf-8').slice(0, 200) || `process exited ${code}`), { retainDrains: true });
    };
    const onStdoutData = chunk => {
      outBytes += chunk.length;
      if (outBytes <= MAX_WXGF_BYTES) stdout.push(chunk);
      else terminate(new Error('wxgf conversion output too large'));
    };
    const onStderrData = chunk => {
      if (errBytes >= 4096) return;
      const remaining = 4096 - errBytes;
      const limited = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      stderr.push(limited);
      errBytes += limited.length;
    };
    child.stdout.on('data', onStdoutData);
    child.stderr.on('data', onStderrData);
    child.on('error', onChildError);
    child.stdin.on('error', onStdinError);
    child.on('close', onClose);
    try {
      child.stdin.end(input || Buffer.alloc(0));
    } catch (e) {
      terminate(e);
    }
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
