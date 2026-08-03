import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAbortableWorkRegistry } from '../lib/abortable-work-registry.js';
import { TMP_DIR, assertSafeTmpPath, ensureOrdinaryTmpDir } from '../lib/paths.js';
import { readFileHandleBounded } from '../lib/bounded-read.js';
import {
  DIGEST_RENDERER_ENGINE_SERVER,
  DIGEST_RENDERER_VERSION,
  normalizeDigestForRender,
} from '../web/public/js/digest-view-model.js';
import {
  RENDERED_PNG_MAX_BYTES,
  RENDERED_PNG_MAX_RGBA_BYTES,
  RENDERED_PNG_MAX_SIDE,
  formatPngByteSize,
  validatePngFileHandle,
} from './png-validate.js';
import { attachWindowsProcessCleanup, terminateWindowsProcessTree, windowsProcessCleanupForError } from './windows-process-tree.js';

const SCRIPT_PATH = fileURLToPath(new URL('./render-digest.ps1', import.meta.url));
const SERVER_RENDER_TIMEOUT_MS = 60_000;
const SERVER_RENDER_TMP_MAX_AGE_MS = 30 * 60 * 1000;
const SERVER_RENDER_CONCURRENCY = 1;
const SERVER_RENDER_QUEUE_LIMIT = 6;
const SERVER_RENDER_QUEUE_TIMEOUT_MS = 75_000;
const SERVER_RENDER_PROCESS_KILL_GRACE_MS = 2000;
const SERVER_RENDER_PROCESS_POLL_MS = 50;
const SERVER_RENDER_PROCESS_RESPONSE_WAIT_MS = 5000;
const SERVER_RENDER_OUTPUT_TAIL_MAX_CHARS = 64 * 1024;
const SERVER_RENDER_OUTPUT_MAX_PNG_BYTES = RENDERED_PNG_MAX_BYTES;
const SERVER_RENDER_OUTPUT_MAX_RGBA_BYTES = RENDERED_PNG_MAX_RGBA_BYTES;
const SERVER_RENDER_MAX_PNG_SIDE = RENDERED_PNG_MAX_SIDE;
let activeServerRenders = 0;
const pendingServerRenderQueue = [];
let serverRenderProcessQuarantine = null;
const SERVER_RENDER_WORK = createAbortableWorkRegistry({
  closingError: reason => serverRenderShutdownError(reason?.message),
});

export const __serverPngInternals = {
  acquireServerRenderSlot,
};

export async function assertServerPngRenderAvailable({ signal = null } = {}) {
  throwIfRenderAborted(signal);
  if (process.platform !== 'win32') {
    throw serverRenderFailedError('后台定时摘要需要服务端 PNG 渲染，但当前平台不支持；已停止本次目标，未调用 AI。请改用手动「生成文本预览」。', 'server_render_unsupported', 501);
  }
  const scriptStat = await fsp.stat(SCRIPT_PATH).catch(() => null);
  throwIfRenderAborted(signal);
  if (!scriptStat?.isFile?.()) {
    throw serverRenderFailedError('后台定时摘要需要服务端 PNG 渲染，但缺少 render-digest.ps1；已停止本次目标，未调用 AI。', 'server_render_script_missing', 501);
  }
  if (!windowsPowerShellExecutablePath()) {
    throw serverRenderFailedError('后台定时摘要需要 PowerShell 渲染 PNG，但本机找不到 powershell.exe；已停止本次目标，未调用 AI。', 'server_render_process_missing', 501);
  }
}

export async function renderDigestPngDataUrl(digest, renderOptions = {}, { signal = null, timeout_ms = SERVER_RENDER_TIMEOUT_MS } = {}) {
  const buffer = await renderDigestPngBuffer(digest, renderOptions, { signal, timeout_ms });
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

export function renderDigestPngBuffer(digest, renderOptions = {}, { signal = null, timeout_ms = SERVER_RENDER_TIMEOUT_MS } = {}) {
  return SERVER_RENDER_WORK.run(
    ownedSignal => renderDigestPngBufferOwned(digest, renderOptions, { signal: ownedSignal, timeout_ms }),
    { signal },
  );
}

async function renderDigestPngBufferOwned(digest, renderOptions = {}, { signal = null, timeout_ms = SERVER_RENDER_TIMEOUT_MS } = {}) {
  if (process.platform !== 'win32') {
    throw serverRenderFailedError('服务端 PNG 渲染当前仅支持 Windows；请回到总结页重新生成新的前端 Canvas 长图，或改用「生成文本预览」。', 'server_render_unsupported', 501);
  }
  throwIfRenderAborted(signal);
  const releaseRenderSlot = await acquireServerRenderSlot({ signal });
  try {
    await ensureOrdinaryTmpDir();
    await cleanupStaleServerRenderTmp().catch(() => {});
    const id = crypto.randomBytes(8).toString('hex');
    const inputJson = path.join(TMP_DIR, `render-${id}.json`);
    const outputPng = path.join(TMP_DIR, `render-${id}.png`);
    const payload = { ...normalizeDigestForServerRender(digest), __render: normalizeRenderOptions(renderOptions) };
    throwIfRenderAborted(signal);
    const safeInput = await assertSafeTmpPath(inputJson, { label: 'server render input', ensureParent: true });
    const safeOutputTarget = await assertSafeTmpPath(outputPng, { label: 'server render output', ensureParent: true });
    await fsp.writeFile(safeInput.resolved, JSON.stringify(payload, null, 2), 'utf-8');
    let deferredProcessCleanup = null;
    try {
      await runPowerShell([
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', SCRIPT_PATH,
        '-InputJson', safeInput.resolved,
        '-OutputPng', safeOutputTarget.resolved,
        '-MaxRgbaBytes', String(SERVER_RENDER_OUTPUT_MAX_RGBA_BYTES),
      ], { signal, timeoutMs: timeout_ms });
      throwIfRenderAborted(signal);
      const safeOutput = await assertSafeTmpPath(safeOutputTarget.resolved, { label: 'server render output', requireFile: true });
      return await readServerRenderOutput(safeOutput, { signal });
    } catch (error) {
      deferredProcessCleanup = windowsProcessCleanupForError(error);
      throw error;
    } finally {
      const cleanup = () => cleanupServerRenderFiles(inputJson, outputPng);
      if (deferredProcessCleanup) {
        void SERVER_RENDER_WORK.track(deferredProcessCleanup.then(cleanup, cleanup)).catch(() => {});
      } else {
        await cleanup();
      }
    }
  } finally {
    releaseRenderSlot();
  }
}

function serverRenderQueueFullError() {
  return Object.assign(new Error('当前长图重渲染队列较多，请稍后再试。'), { status: 429, code: 'server_render_queue_full' });
}

function serverRenderQueueTimeoutError() {
  return Object.assign(new Error('等待长图渲染队列超时，请稍后重试；旧历史文件未修改。'), { status: 503, code: 'server_render_queue_timeout' });
}

function serverRenderShutdownError(message = '') {
  return Object.assign(new Error(message || '服务正在关闭，长图渲染未开始。'), {
    name: 'AbortError',
    status: 503,
    code: 'server_render_shutdown',
    public_code: 'server_render_shutdown',
  });
}

export function serverRenderWorkStatus() {
  const work = SERVER_RENDER_WORK.status();
  return {
    ...work,
    renders: activeServerRenders,
    queued: pendingServerRenderQueue.length,
    quarantined: !!serverRenderProcessQuarantine,
  };
}

export function cancelServerRenderWork(reason = '服务正在关闭，长图渲染已取消。') {
  const error = serverRenderShutdownError(reason);
  const before = serverRenderWorkStatus();
  const cancelled = SERVER_RENDER_WORK.cancel(error);
  rejectPendingServerRenderQueue(error);
  return { ...before, aborted: cancelled.aborted, closing: true };
}

export async function waitForServerRenderWorkToSettle(timeoutMs = 0) {
  const settled = await SERVER_RENDER_WORK.waitForSettled(timeoutMs);
  const status = serverRenderWorkStatus();
  const complete = settled.settled
    && status.renders === 0
    && status.queued === 0
    && !status.quarantined;
  return {
    settled: complete,
    active: settled.active,
    timed_out: settled.timed_out || !complete,
    renders: status.renders,
    queued: status.queued,
    quarantined: status.quarantined,
  };
}

function serverRenderProcessQuarantinedError(pid = serverRenderProcessQuarantine?.pid || 0) {
  const suffix = pid ? `（进程 ${pid}）` : '';
  return Object.assign(new Error(`上一项长图渲染进程${suffix}仍在退出，暂不启动新的渲染。请稍后重试；若持续出现请重启本地服务。`), {
    status: 503,
    code: 'server_render_process_quarantined',
    public_code: 'server_render_process_quarantined',
  });
}

function serverRenderFailedError(message, code = 'server_render_failed', status = 500) {
  const err = new Error(message || '服务端长图渲染失败。请缩短时间范围后重试，或改用「生成文本预览」。');
  err.status = status;
  err.code = code;
  err.public_code = code;
  return err;
}

function serverRenderOutputTooLargeError(bytes = 0) {
  return serverRenderFailedError(
    `服务端重渲染生成的 PNG 约 ${formatPngByteSize(bytes)}，超过安全上限 ${formatPngByteSize(SERVER_RENDER_OUTPUT_MAX_PNG_BYTES)}；旧历史 PNG 未覆盖。请缩短时间范围、减少内容，或改用「生成文本预览」。`,
    'server_render_output_too_large',
    413,
  );
}

function serverRenderOutputChangedError() {
  return serverRenderFailedError(
    '服务端重渲染临时 PNG 在读取期间发生变化，已停止保存；旧历史 PNG 没有覆盖。请重新预览或重试。',
    'server_render_output_changed',
    409,
  );
}

async function readServerRenderOutput(safeOutput, { signal = null } = {}) {
  let handle = null;
  try {
    handle = await fsp.open(safeOutput.resolved, 'r');
    const stat = await handle.stat();
    if (!stat?.isFile?.()) {
      throw serverRenderFailedError('服务端长图渲染没有生成可用 PNG。请缩短时间范围后重试，或改用「生成文本预览」。', 'server_render_invalid_png', 500);
    }
    const outputBytes = Math.max(0, Number(stat.size || 0) || 0);
    if (outputBytes > SERVER_RENDER_OUTPUT_MAX_PNG_BYTES) throw serverRenderOutputTooLargeError(outputBytes);
    try {
      await validatePngFileHandle(handle, serverRenderPngValidationOptions({ signal }));
      throwIfRenderAborted(signal);
      const buffer = await readFileHandleBounded(handle, SERVER_RENDER_OUTPUT_MAX_PNG_BYTES, {
        checkAbort: () => throwIfRenderAborted(signal),
        createTooLargeError: bytes => serverRenderOutputTooLargeError(bytes),
      });
      return buffer;
    } catch (error) {
      if (error?.code === 'bounded_read_changed') throw serverRenderOutputChangedError();
      throw error;
    }
  } finally {
    await handle?.close?.().catch(() => {});
  }
}

function windowsPowerShellExecutablePath() {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.join(root, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];
  return candidates.find(file => {
    try {
      return fs.existsSync(file);
    } catch {
      return false;
    }
  }) || '';
}

function serverRenderPngValidationOptions({ signal = null } = {}) {
  return {
    signal,
    maxBytes: SERVER_RENDER_OUTPUT_MAX_PNG_BYTES,
    maxRgbaBytes: SERVER_RENDER_OUTPUT_MAX_RGBA_BYTES,
    maxSide: SERVER_RENDER_MAX_PNG_SIDE,
    errorFactory: serverRenderFailedError,
    codes: {
      payloadTooLarge: 'server_render_output_too_large',
      invalidPng: 'server_render_invalid_png',
      dimensionsTooLarge: 'server_render_too_tall',
      rgbaTooLarge: 'server_render_canvas_too_large',
      decodedTooLarge: 'server_render_decoded_too_large',
      tooManyChunks: 'server_render_too_many_chunks',
    },
    statuses: {
      invalidPng: 500,
    },
    messages: {
      payloadTooLarge: ({ bytes, maxBytes }) => `服务端重渲染生成的 PNG 约 ${formatPngByteSize(bytes)}，超过安全上限 ${formatPngByteSize(maxBytes)}；旧历史 PNG 未覆盖。请缩短时间范围、减少内容，或改用「生成文本预览」。`,
      invalidPng: '服务端长图渲染没有生成可用 PNG。请缩短时间范围后重试，或改用「生成文本预览」。',
      dimensionsTooLarge: '摘要内容过长，服务端 PNG 宽高超过当前安全上限。请缩短时间范围、减少内容，或改用「生成文本预览」。',
      rgbaTooLarge: ({ rgbaBytes, maxRgbaBytes }) => `服务端重渲染生成的 PNG 解码后约 ${formatPngByteSize(rgbaBytes)}，超过自动保存内存上限 ${formatPngByteSize(maxRgbaBytes)}；旧历史 PNG 未覆盖。请缩短时间范围、减少内容，或改用「生成文本预览」。`,
      decodedTooLarge: ({ decodedBytes, maxInflatedBytes }) => `服务端重渲染生成的 PNG 解压后约 ${formatPngByteSize(decodedBytes)}，超过安全上限 ${formatPngByteSize(maxInflatedBytes)}；旧历史 PNG 未覆盖。请缩短时间范围、减少内容，或改用「生成文本预览」。`,
      tooManyChunks: '服务端重渲染生成的 PNG 数据分块数量异常，已停止保存；旧历史 PNG 未覆盖。请重试，若持续出现请重启本地服务。',
    },
  };
}

function serverRenderProcessError(error = {}) {
  const code = String(error?.code || '').trim();
  if (code === 'ENOENT') {
    return serverRenderFailedError('服务端 PNG 渲染进程启动失败：未找到 powershell.exe。请回到总结页重新生成新的前端 Canvas 长图，或改用「生成文本预览」。', 'server_render_process_missing', 501);
  }
  if (['EACCES', 'EPERM'].includes(code)) {
    return serverRenderFailedError('服务端 PNG 渲染进程启动失败：当前系统拒绝启动 PowerShell。请检查本机安全策略，或回到总结页重新生成新的前端 Canvas 长图。', 'server_render_process_denied', 500);
  }
  return serverRenderFailedError('服务端 PNG 渲染进程启动失败。请稍后重试，或回到总结页重新生成新的前端 Canvas 长图。', 'server_render_process_failed', 500);
}

function releaseServerRenderSlot() {
  activeServerRenders = Math.max(0, activeServerRenders - 1);
  if (SERVER_RENDER_WORK.status().closing) {
    rejectPendingServerRenderQueue(serverRenderShutdownError());
    return;
  }
  if (serverRenderProcessQuarantine) {
    rejectPendingServerRenderQueue();
    return;
  }
  while (pendingServerRenderQueue.length && activeServerRenders < SERVER_RENDER_CONCURRENCY) {
    const next = pendingServerRenderQueue.shift();
    if (!next || next.settled) continue;
    next.settled = true;
    if (next.timer) clearTimeout(next.timer);
    next.signal?.removeEventListener?.('abort', next.onAbort);
    activeServerRenders += 1;
    next.resolve(releaseServerRenderSlot);
    break;
  }
}

function acquireServerRenderSlot({ signal = null } = {}) {
  return new Promise((resolve, reject) => {
    if (SERVER_RENDER_WORK.status().closing) {
      reject(serverRenderShutdownError());
      return;
    }
    if (signal?.aborted) {
      reject(renderAbortReason(signal));
      return;
    }
    if (serverRenderProcessQuarantine) {
      reject(serverRenderProcessQuarantinedError());
      return;
    }
    if (activeServerRenders < SERVER_RENDER_CONCURRENCY) {
      activeServerRenders += 1;
      resolve(releaseServerRenderSlot);
      return;
    }
    if (pendingServerRenderQueue.length >= SERVER_RENDER_QUEUE_LIMIT) {
      reject(serverRenderQueueFullError());
      return;
    }
    const entry = {
      signal,
      settled: false,
      resolve,
      reject,
      onAbort: null,
      timer: null,
    };
    entry.onAbort = () => {
      if (entry.settled) return;
      entry.settled = true;
      if (entry.timer) clearTimeout(entry.timer);
      const index = pendingServerRenderQueue.indexOf(entry);
      if (index >= 0) pendingServerRenderQueue.splice(index, 1);
      reject(renderAbortReason(signal));
    };
    entry.timer = setTimeout(() => {
      if (entry.settled) return;
      entry.settled = true;
      const index = pendingServerRenderQueue.indexOf(entry);
      if (index >= 0) pendingServerRenderQueue.splice(index, 1);
      signal?.removeEventListener?.('abort', entry.onAbort);
      reject(serverRenderQueueTimeoutError());
    }, SERVER_RENDER_QUEUE_TIMEOUT_MS);
    entry.timer.unref?.();
    signal?.addEventListener?.('abort', entry.onAbort, { once: true });
    pendingServerRenderQueue.push(entry);
  });
}

async function cleanupStaleServerRenderTmp(now = Date.now()) {
  await ensureOrdinaryTmpDir();
  const entries = await fsp.readdir(TMP_DIR, { withFileTypes: true }).catch(e => {
    if (e?.code === 'ENOENT') return [];
    throw e;
  });
  for (const entry of entries) {
    if (!entry.isFile() || !/^render-[a-f0-9]{16}\.(?:json|png)$/i.test(entry.name)) continue;
    const file = path.join(TMP_DIR, entry.name);
    const safe = await assertSafeTmpPath(file, { label: 'server render temp', requireFile: true }).catch(() => null);
    const stat = safe?.stat || null;
    if (!stat || now - stat.mtimeMs < SERVER_RENDER_TMP_MAX_AGE_MS) continue;
    await fsp.rm(safe.resolved, { force: true }).catch(() => {});
  }
}

export function normalizeRenderOptions(options = {}) {
  const accentColor = normalizeAccentColor(options.accent_color || options.primary_color || options.accent);
  const theme = options.theme || options.default_theme;
  const fontSize = options.font_size || options.default_font_size;
  return {
    theme: ['light', 'dark'].includes(theme) ? theme : 'light',
    font_size: fontSize === 'large' ? 'large' : 'normal',
    accent_color: accentColor,
    renderer_version: DIGEST_RENDERER_VERSION,
    renderer_engine: DIGEST_RENDERER_ENGINE_SERVER,
  };
}

function normalizeDigestForServerRender(digest = {}) {
  return normalizeDigestForRender(digest);
}

function normalizeAccentColor(value) {
  const text = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toUpperCase() : '';
}

function renderAbortError(message = '渲染已取消') {
  return Object.assign(new Error(message), { name: 'AbortError', status: 499 });
}

function renderAbortReason(signal) {
  const reason = signal?.reason;
  return reason instanceof Error
    ? reason
    : renderAbortError(typeof reason === 'string' ? reason : undefined);
}

function renderTimeoutError(timeoutMs) {
  const seconds = Math.max(1, Math.round(Number(timeoutMs || 0) / 1000));
  return Object.assign(new Error(`长图重渲染超过 ${seconds} 秒仍未完成，已安全停止且未覆盖原历史 PNG。可先重试；若持续发生，请缩短时间范围、减少内容，或改用「生成文本预览」。`), { status: 504, code: 'server_render_timeout' });
}

function throwIfRenderAborted(signal) {
  if (!signal?.aborted) return;
  throw renderAbortReason(signal);
}

function runPowerShell(args, { signal = null, timeoutMs = SERVER_RENDER_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(renderAbortReason(signal));
      return;
    }
    const powerShellPath = windowsPowerShellExecutablePath();
    if (!powerShellPath) {
      reject(serverRenderFailedError('服务端 PNG 渲染进程启动失败：找不到受信任的 Windows PowerShell。', 'server_render_process_missing', 501));
      return;
    }
    let child;
    try {
      child = spawn(powerShellPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      reject(serverRenderProcessError(e));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    let pendingKillError = null;
    let childClosed = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      fn(value);
    };
    const killFor = error => {
      if (pendingKillError || settled) return;
      pendingKillError = error;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      signal?.removeEventListener?.('abort', onAbort);
      terminateWindowsProcessTree(child, {
        isClosed: () => childClosed,
        retryMs: SERVER_RENDER_PROCESS_KILL_GRACE_MS,
        pollMs: SERVER_RENDER_PROCESS_POLL_MS,
        responseWaitMs: SERVER_RENDER_PROCESS_RESPONSE_WAIT_MS,
      }).then(({ pid, terminated, cleanup }) => {
        if (!terminated) {
          quarantineServerRenderProcess(pid, cleanup);
          attachWindowsProcessCleanup(pendingKillError, cleanup);
        }
        finish(reject, pendingKillError);
      });
    };
    const onAbort = () => {
      killFor(renderAbortReason(signal));
    };
    const timeout = Math.max(1000, Number(timeoutMs || SERVER_RENDER_TIMEOUT_MS) || SERVER_RENDER_TIMEOUT_MS);
    timer = setTimeout(() => {
      killFor(renderTimeoutError(timeout));
    }, timeout);
    timer.unref?.();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', chunk => {
      stdout = appendBoundedOutputTail(stdout, chunk, SERVER_RENDER_OUTPUT_TAIL_MAX_CHARS);
    });
    child.stderr.on('data', chunk => {
      stderr = appendBoundedOutputTail(stderr, chunk, SERVER_RENDER_OUTPUT_TAIL_MAX_CHARS);
    });
    child.on('error', err => {
      if (pendingKillError) return;
      const processError = serverRenderProcessError(err);
      if (Number.isSafeInteger(child.pid) && child.pid > 0) killFor(processError);
      else finish(reject, processError);
    });
    child.on('close', code => {
      childClosed = true;
      if (pendingKillError) {
        return;
      }
      if (code === 0) finish(resolve, { stdout, stderr });
      else {
        const detail = (stderr || stdout || '').trim();
        const failure = formatPowerShellRenderFailure(detail, code);
        const err = serverRenderFailedError(failure.message, failure.code, failure.status);
        if (Number.isSafeInteger(failure.expected_height_px) && failure.expected_height_px > 0) {
          err.expected_height_px = failure.expected_height_px;
        }
        if (Number.isSafeInteger(failure.max_height_px) && failure.max_height_px > 0) {
          err.max_height_px = failure.max_height_px;
        }
        if (detail) err.raw_detail = detail;
        finish(reject, err);
      }
    });
    if (signal?.aborted) onAbort();
  });
}

function appendBoundedOutputTail(current, chunk, maxChars) {
  const combined = `${current}${String(chunk || '')}`;
  return combined.length > maxChars ? combined.slice(-maxChars) : combined;
}

async function cleanupServerRenderFiles(inputJson, outputPng) {
  await assertSafeTmpPath(inputJson, { label: 'server render input', requireFile: true })
    .then(safe => fsp.rm(safe.resolved, { force: true }))
    .catch(() => {});
  await assertSafeTmpPath(outputPng, { label: 'server render output', requireFile: true })
    .then(safe => fsp.rm(safe.resolved, { force: true }))
    .catch(() => {});
}

function rejectPendingServerRenderQueue(error = null) {
  while (pendingServerRenderQueue.length) {
    const entry = pendingServerRenderQueue.shift();
    if (!entry || entry.settled) continue;
    entry.settled = true;
    if (entry.timer) clearTimeout(entry.timer);
    entry.signal?.removeEventListener?.('abort', entry.onAbort);
    entry.reject(error || serverRenderProcessQuarantinedError());
  }
}

function quarantineServerRenderProcess(pid, cleanup) {
  const token = Symbol('server-render-process-quarantine');
  const trackedCleanup = SERVER_RENDER_WORK.track(cleanup);
  serverRenderProcessQuarantine = { token, pid, cleanup: trackedCleanup };
  rejectPendingServerRenderQueue();
  void trackedCleanup.then(() => {
    if (serverRenderProcessQuarantine?.token === token) serverRenderProcessQuarantine = null;
  }, () => {});
}

function formatPowerShellRenderFailure(detail = '', exitCode = 1) {
  const text = String(detail || '').trim();
  if (/摘要内容过长|服务端 PNG 高度超过当前安全上限/.test(text)) {
    const heightMatch = text.match(/需要\s+(\d+)\s*px[\s\S]*?当前上限\s+(\d+)\s*px/i);
    const expectedHeight = Number(heightMatch?.[1] || 0);
    const maxHeight = Number(heightMatch?.[2] || 0);
    return {
      message: '摘要内容过长，服务端 PNG 高度超过当前安全上限。请缩短时间范围、减少内容，或改用「生成文本预览」。',
      code: 'server_render_too_tall',
      status: 413,
      ...(Number.isSafeInteger(expectedHeight) && expectedHeight > 0 ? { expected_height_px: expectedHeight } : {}),
      ...(Number.isSafeInteger(maxHeight) && maxHeight > 0 ? { max_height_px: maxHeight } : {}),
    };
  }
  const firstLine = firstMeaningfulPowerShellLine(text);
  if (firstLine) {
    return {
      message: `服务端长图渲染失败：${firstLine}`,
      code: 'server_render_failed',
      status: 500,
    };
  }
  return {
    message: `服务端长图渲染进程异常退出（代码 ${exitCode}）。请缩短时间范围后重试，或改用「生成文本预览」。`,
    code: 'server_render_failed',
    status: 500,
  };
}

function firstMeaningfulPowerShellLine(detail = '') {
  const lines = String(detail || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const line = lines.find(item => !isPowerShellNoiseLine(item));
  if (!line) return '';
  return line.length > 180 ? `${line.slice(0, 177)}...` : line;
}

function isPowerShellNoiseLine(line = '') {
  return /^At\s+.+render-digest\.ps1:/i.test(line)
    || /^[+~]\s*/.test(line)
    || /^(\+?\s*)?(CategoryInfo|FullyQualifiedErrorId)\s*:/i.test(line)
    || /render-digest\.ps1:\d+\s+char:\d+/i.test(line)
    || /System\.(Management|Drawing|Runtime)/i.test(line);
}
