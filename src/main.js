import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { clearDbKeyRuntimeCache, collectMessages, detectWeixin, listAccounts, listGroups } from './collector/index.js';
import { clearTmpDir, ensureRuntimeDirs, loadSettings, normalizeBaseUrl, publicSettings, saveSettingsPatch } from './config/settings.js';
import { getSchedulerStatus, restartScheduler, runSchedulerOnce, startScheduler, stopScheduler } from './daemon/scheduler.js';
import { DATA_DIR, DEFAULT_DIGESTS_DIR, PROJECT_ROOT, PUBLIC_DIR, TMP_DIR, VIEWS_DIR, isInside, outputDirFromSettings, resolveInsideTmp } from './lib/paths.js';
import { configureLogger, logError, logInfo, logWarn, readLogTail } from './lib/logger.js';
import { listModels, redactContent, sanitizeText, summarizeDigest, testLlmConnectivity } from './summarizer/llm.js';
import { assertRevealable, cleanupOldDigests, findHistoryItem, listHistory, overwriteRenderedPng, readHistoryDigest, savePreviewMarkdown, saveRenderedPng } from './renderer/output.js';
import { renderDigestPngDataUrl } from './renderer/server-png.js';
import { renderDigestThumbnailPng } from './renderer/thumbnail.js';
import { probeWxKey, scanLocalWeixinKeyCandidates } from './wxkey/index.js';
import { probeWxDb, readDbInventory } from './wxdb/index.js';
import { probeMediaTools } from './wxdb/wxgf.js';
import { getWeixinBinaryEvidence, getWeixinModuleEvidence } from './wxenv/discovery.js';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 7788;
const SESSION_TOKEN = crypto.randomBytes(16).toString('hex');
const SHUTDOWN_TOKEN = crypto.randomBytes(16).toString('hex');
const RUNTIME_INFO_FILE = path.join(TMP_DIR, 'server.json');
const EXTERNAL_WEIXIN_BASELINE_FILE = path.join(DATA_DIR, 'external-weixin-binary-baseline.json');
const PRELAUNCH_WEIXIN_BASELINE_FILE = path.join(DATA_DIR, 'prelaunch-weixin-binary.json');
const LAUNCHER_WEIXIN_BASELINE_FILE = path.join(DATA_DIR, 'launcher-weixin-binary.json');
const SAVE_RENDER_BODY_LIMIT = 120 * 1024 * 1024;
const MAX_ACTIVE_DIGEST_REQUESTS = 6;
const DIGEST_BATCH_SETTINGS_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_DIGEST_BATCH_SETTINGS = 20;
const SERVICE_STARTED_AT = new Date();
let ACTIVE_SERVER = null;
let ACTIVE_PORT = null;
let SHUTTING_DOWN = false;
let WEIXIN_BINARY_EXTERNAL_BASELINE = null;
let WEIXIN_BINARY_PRELAUNCH_BASELINE = null;
let WEIXIN_BINARY_LAUNCHER_BASELINE = null;
let WEIXIN_BINARY_BASELINE = null;
let ACTIVE_DIGEST_REQUESTS = new Map();
const DIGEST_BATCH_SETTINGS = new Map();
let NEXT_DIGEST_REQUEST_ID = 1;
let ACTIVE_DEEP_KEY_STATUS = null;
let LAST_CLIPBOARD_COPY_EVIDENCE = null;
let LAST_REVEAL_EVIDENCE = null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

function apiError(res, err) {
  const status = err?.status && Number.isInteger(err.status) ? err.status : 500;
  sendJson(res, status, { ok: false, status, error: sanitizeText(err?.message || String(err)) });
}

function shouldOpenBrowser(settings) {
  return settings.web?.open_browser !== false && !process.argv.includes('--no-open');
}

function openInBrowser(targetUrl, settings) {
  if (!shouldOpenBrowser(settings)) return;
  if (process.platform === 'win32') {
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', targetUrl], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [targetUrl], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [targetUrl], { detached: true, stdio: 'ignore' }).unref();
  }
}

async function writeRuntimeInfo(port) {
  const info = {
    pid: process.pid,
    host: HOST,
    port,
    url: `http://${HOST}:${port}`,
    shutdown_token: SHUTDOWN_TOKEN,
    started_at: new Date().toISOString(),
    project_root: PROJECT_ROOT,
  };
  await fsp.mkdir(TMP_DIR, { recursive: true });
  await fsp.writeFile(RUNTIME_INFO_FILE, JSON.stringify(info, null, 2), 'utf-8');
}

function removeRuntimeInfo() {
  try { fs.rmSync(RUNTIME_INFO_FILE, { force: true }); } catch {}
}

function normalizeDigestBatchId(value) {
  const id = String(value || '').trim();
  return /^[a-zA-Z0-9_.:-]{8,80}$/.test(id) ? id : '';
}

async function loadDigestBatchSettings(batchId) {
  const id = normalizeDigestBatchId(batchId);
  const now = Date.now();
  cleanupDigestBatchSettings(now);
  if (!id) return loadSettings({ includeSecrets: true });
  const cached = DIGEST_BATCH_SETTINGS.get(id);
  if (cached && now - cached.created_at < DIGEST_BATCH_SETTINGS_TTL_MS) {
    return cached.settings;
  }
  const settings = await loadSettings({ includeSecrets: true });
  DIGEST_BATCH_SETTINGS.set(id, { settings, created_at: now });
  trimDigestBatchSettings();
  return settings;
}

function cleanupDigestBatchSettings(now = Date.now()) {
  for (const [id, item] of DIGEST_BATCH_SETTINGS.entries()) {
    if (!item?.created_at || now - item.created_at > DIGEST_BATCH_SETTINGS_TTL_MS) {
      DIGEST_BATCH_SETTINGS.delete(id);
    }
  }
  trimDigestBatchSettings();
}

function trimDigestBatchSettings() {
  while (DIGEST_BATCH_SETTINGS.size > MAX_DIGEST_BATCH_SETTINGS) {
    const oldest = [...DIGEST_BATCH_SETTINGS.entries()]
      .sort((a, b) => Number(a[1]?.created_at || 0) - Number(b[1]?.created_at || 0))[0]?.[0];
    if (!oldest) break;
    DIGEST_BATCH_SETTINGS.delete(oldest);
  }
}

async function readWeixinBaselineFile(file, { relativePath, expectedSources, fallbackSource, freshness = 'service_start' }) {
  try {
    const text = await fsp.readFile(file, 'utf-8');
    const raw = JSON.parse(text);
    const capturedMs = Date.parse(raw?.captured_at || '');
    const deltaMs = Number.isFinite(capturedMs) ? SERVICE_STARTED_AT.getTime() - capturedMs : null;
    const fresh = Number.isFinite(deltaMs) && deltaMs >= -30_000 && deltaMs <= 10 * 60_000;
    const requiresFresh = freshness === 'service_start';
    const source = typeof raw?.source === 'string' && expectedSources.includes(raw.source) ? raw.source : 'unknown';
    const clean = {
      ok: !!raw?.ok,
      source,
      relative_path: relativePath,
      captured_at: typeof raw?.captured_at === 'string' ? raw.captured_at : '',
      running: !!raw?.running,
      process_count: Number.isInteger(Number(raw?.process_count)) ? Number(raw.process_count) : 0,
      age_vs_service_start_ms: deltaMs,
      fresh_for_this_service: requiresFresh ? !!fresh : null,
    };
    if (Number.isInteger(Number(raw?.pid))) clean.pid = Number(raw.pid);
    if (typeof raw?.path === 'string') clean.path = raw.path;
    if (Number.isFinite(Number(raw?.bytes))) clean.bytes = Number(raw.bytes);
    if (typeof raw?.modified_at === 'string') clean.modified_at = raw.modified_at;
    if (/^[a-f0-9]{64}$/i.test(String(raw?.sha256 || ''))) clean.sha256 = String(raw.sha256).toLowerCase();
    if (raw?.reason) clean.reason = sanitizeText(String(raw.reason));
    if (raw?.error) clean.error = sanitizeText(String(raw.error));
    if (requiresFresh && !fresh) {
      clean.stale_reason = deltaMs === null
        ? 'missing_or_invalid_captured_at'
        : deltaMs < -30_000
          ? 'captured_after_service_start'
          : 'stale_from_previous_launch';
    }
    return clean;
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    return {
      ok: false,
      source: fallbackSource,
      relative_path: relativePath,
      fresh_for_this_service: false,
      error: sanitizeText(e?.message || String(e)),
    };
  }
}

async function readExternalWeixinBaseline() {
  return readWeixinBaselineFile(EXTERNAL_WEIXIN_BASELINE_FILE, {
    relativePath: 'data/external-weixin-binary-baseline.json',
    expectedSources: ['external_user_prelaunch'],
    fallbackSource: 'external_user_prelaunch',
    freshness: 'external_baseline',
  });
}

async function readPrelaunchWeixinBaseline() {
  return readWeixinBaselineFile(PRELAUNCH_WEIXIN_BASELINE_FILE, {
    relativePath: 'data/prelaunch-weixin-binary.json',
    expectedSources: ['cmd_pre_tray', 'cmd_pre_console'],
    fallbackSource: 'cmd_pre_tray',
  });
}

async function readLauncherWeixinBaseline() {
  return readWeixinBaselineFile(LAUNCHER_WEIXIN_BASELINE_FILE, {
    relativePath: 'data/launcher-weixin-binary.json',
    expectedSources: ['tray_pre_node'],
    fallbackSource: 'tray_pre_node',
  });
}

function compareSha256(left, right) {
  return left?.sha256 && right?.sha256 ? left.sha256 === right.sha256 : null;
}

function weixinExecutableLabel() {
  return process.platform === 'darwin' ? 'WeChat' : 'Weixin.exe';
}

function secretStorageLabel() {
  if (process.platform === 'darwin') return 'macOS Keychain';
  if (process.platform === 'win32') return 'Windows DPAPI';
  return '本机密钥存储';
}

function freshLauncherBaseline() {
  return WEIXIN_BINARY_LAUNCHER_BASELINE?.fresh_for_this_service ? WEIXIN_BINARY_LAUNCHER_BASELINE : null;
}

function freshPrelaunchBaseline() {
  return WEIXIN_BINARY_PRELAUNCH_BASELINE?.fresh_for_this_service ? WEIXIN_BINARY_PRELAUNCH_BASELINE : null;
}

async function gracefulShutdown(code = 0) {
  if (SHUTTING_DOWN) return;
  SHUTTING_DOWN = true;
  stopScheduler();
  const server = ACTIVE_SERVER;
  if (server) {
    await new Promise(resolve => server.close(() => resolve())).catch(() => {});
  }
  await clearTmpDir().catch(() => removeRuntimeInfo());
  process.exit(code);
}

function openerLaunchError(command, err) {
  const message = sanitizeText(err?.message || String(err));
  const out = new Error(`无法启动 ${command}：${message}`);
  out.status = 500;
  return out;
}

function logOpenerLaunchFailure(command, err, { late = false } = {}) {
  logWarn('reveal_in_folder_failed', {
    platform: process.platform,
    opener: command,
    late: !!late,
    error: sanitizeText(err?.message || String(err)),
  });
}

function launchDetachedOpener(command, args, options = {}, result = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore', ...options });
    } catch (err) {
      logOpenerLaunchFailure(command, err);
      reject(openerLaunchError(command, err));
      return;
    }
    let settled = false;
    let timer = null;
    const cleanup = ({ keepErrorListener = false } = {}) => {
      clearTimeout(timer);
      child.off('spawn', onSpawn);
      if (!keepErrorListener) child.off('error', onError);
    };
    const onSpawn = () => {
      if (settled) return;
      settled = true;
      cleanup({ keepErrorListener: true });
      child.unref();
      resolve(result);
    };
    const onError = err => {
      logOpenerLaunchFailure(command, err, { late: settled });
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(openerLaunchError(command, err));
    };
    child.on('spawn', onSpawn);
    child.on('error', onError);
    timer = setTimeout(onSpawn, 1000);
  });
}

async function revealInFolder(targetPath) {
  let command;
  let args;
  let options = {};
  let result;
  if (process.platform === 'win32') {
    command = 'explorer.exe';
    args = ['/select,', targetPath];
    options = { windowsHide: true };
    result = { platform: 'win32', opener: 'explorer.exe', mode: 'select' };
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = ['-R', targetPath];
    result = { platform: 'darwin', opener: 'open', mode: 'reveal' };
  } else {
    command = 'xdg-open';
    args = [path.dirname(targetPath)];
    result = { platform: process.platform, opener: 'xdg-open', mode: 'open_parent' };
  }
  return launchDetachedOpener(command, args, options, result);
}

async function openDirectoryInSystem(dir) {
  if (process.platform === 'win32') {
    return launchDetachedOpener('explorer.exe', [dir], { windowsHide: true }, { platform: 'win32', opener: 'explorer.exe', mode: 'open_dir' });
  }
  if (process.platform === 'darwin') {
    return launchDetachedOpener('open', [dir], {}, { platform: 'darwin', opener: 'open', mode: 'open_dir' });
  }
  return launchDetachedOpener('xdg-open', [dir], {}, { platform: process.platform, opener: 'xdg-open', mode: 'open_dir' });
}

function copyPngToClipboard(targetPath) {
  if (process.platform !== 'win32') {
    throw Object.assign(new Error('系统剪贴板图片复制目前仅支持 Windows'), { status: 501 });
  }
  const encodedPath = Buffer.from(targetPath, 'utf-8').toString('base64');
  const script = [
    `$ImagePath = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$image = [System.Drawing.Image]::FromFile($ImagePath)',
    '$bitmap = $null',
    'try { $bitmap = [System.Drawing.Bitmap]::new($image) } finally { $image.Dispose() }',
    'try { [System.Windows.Forms.Clipboard]::SetImage($bitmap); Write-Output ("copied {0}x{1}" -f $bitmap.Width,$bitmap.Height) } finally { if ($bitmap) { $bitmap.Dispose() } }',
  ].join('; ');
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-STA',
      '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encodedCommand,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(Object.assign(new Error('复制到系统剪贴板超时'), { status: 504 }));
    }, 15000);
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr, clipboard: parseClipboardImageSize(stdout) });
      else reject(Object.assign(new Error((stderr || stdout || `PowerShell exited with ${code}`).trim()), { status: 500 }));
    });
  });
}

function parseClipboardImageSize(stdout = '') {
  const match = String(stdout || '').match(/copied\s+(\d+)x(\d+)/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function projectRelativePath(targetPath) {
  const resolved = path.resolve(targetPath || '');
  if (!isInside(PROJECT_ROOT, resolved)) return path.basename(resolved);
  return path.relative(PROJECT_ROOT, resolved).replaceAll(path.sep, '/');
}

function recordRevealEvidence(file, reveal) {
  LAST_REVEAL_EVIDENCE = {
    requested_at: new Date().toISOString(),
    relative_path: projectRelativePath(file),
    platform: reveal?.platform || process.platform,
    opener: reveal?.opener || '',
    mode: reveal?.mode || '',
    explorer_selection: process.platform === 'win32' ? { checked_at: '', matched: null } : null,
  };
  scheduleRevealSelectionVerification(file);
  return LAST_REVEAL_EVIDENCE;
}

function scheduleRevealSelectionVerification(file) {
  if (process.platform !== 'win32') return;
  const expected = projectRelativePath(file);
  setTimeout(async () => {
    try {
      const result = await probeExplorerSelection(file);
      if (LAST_REVEAL_EVIDENCE?.relative_path === expected) {
        LAST_REVEAL_EVIDENCE.explorer_selection = result;
      }
    } catch (e) {
      if (LAST_REVEAL_EVIDENCE?.relative_path === expected) {
        LAST_REVEAL_EVIDENCE.explorer_selection = {
          checked_at: new Date().toISOString(),
          matched: false,
          error: sanitizeText(e?.message || String(e)),
        };
      }
    }
  }, 1500).unref();
}

function probeExplorerSelection(targetPath) {
  const encodedPath = Buffer.from(path.resolve(targetPath || ''), 'utf-8').toString('base64');
  const script = [
    `$Target = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    '$matched = $false',
    '$selectedCount = 0',
    '$shell = New-Object -ComObject Shell.Application',
    'foreach ($window in @($shell.Windows())) { try { foreach ($item in @($window.Document.SelectedItems())) { $p = [string]$item.Path; if ($p -eq $Target) { $matched = $true; $selectedCount += 1 } } } catch {} }',
    '[pscustomobject]@{ checked_at = (Get-Date).ToUniversalTime().ToString("o"); matched = $matched; selected_count = $selectedCount } | ConvertTo-Json -Compress',
  ].join('; ');
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-STA',
      '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encodedCommand,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(Object.assign(new Error('Explorer 选中文件验证超时'), { status: 504 }));
    }, 7000);
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(Object.assign(new Error((stderr || stdout || `PowerShell exited with ${code}`).trim()), { status: 500 }));
        return;
      }
      try {
        const parsed = JSON.parse(stdout || '{}');
        resolve({
          checked_at: parsed.checked_at || new Date().toISOString(),
          matched: parsed.matched === true,
          selected_count: Number(parsed.selected_count || 0),
        });
      } catch (e) {
        reject(Object.assign(new Error(`Explorer 选中文件验证输出不可解析：${e.message}`), { status: 500 }));
      }
    });
  });
}

function normalizedClipboardSize(value) {
  const width = Number(value?.width || 0);
  const height = Number(value?.height || 0);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function recordClipboardCopyEvidence(file, copied = {}) {
  LAST_CLIPBOARD_COPY_EVIDENCE = {
    copied_at: new Date().toISOString(),
    relative_path: projectRelativePath(file),
    clipboard: normalizedClipboardSize(copied?.clipboard),
    platform: process.platform,
    method: sanitizeText(copied?.method || 'system_clipboard'),
  };
  return LAST_CLIPBOARD_COPY_EVIDENCE;
}

async function serveStatic(res, urlPath) {
  const safe = path.normalize(urlPath).replace(/^([\\/]+)/, '');
  const file = path.resolve(PUBLIC_DIR, safe);
  if (!isInside(PUBLIC_DIR, file)) return send(res, 403, 'forbidden');
  try {
    const data = await fsp.readFile(file);
    return send(res, 200, data, { 'Content-Type': mimeOf(file) });
  } catch {
    return send(res, 404, 'not found');
  }
}

async function serveIndex(res) {
  const template = await fsp.readFile(path.join(VIEWS_DIR, 'index.html'), 'utf-8');
  const assetVersion = await currentAssetVersion();
  const html = template
    .replaceAll('__SESSION_TOKEN__', SESSION_TOKEN)
    .replaceAll('__ASSET_VERSION__', assetVersion);
  send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
}

async function currentAssetVersion() {
  const files = [
    path.join(PUBLIC_DIR, 'js', 'app.js'),
    path.join(PUBLIC_DIR, 'css', 'app.css'),
  ];
  const mtimes = await Promise.all(files.map(file => fsp.stat(file).then(stat => stat.mtimeMs).catch(() => 0)));
  const maxMtime = Math.max(...mtimes);
  return String(Math.trunc(maxMtime > 0 ? maxMtime : Date.now())).replace(/\D/g, '');
}

async function readBody(req, maxBytes = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(Object.assign(new Error('Request body too large'), { status: 413 }));
      req.destroy();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function hasToken(req, parsedUrl) {
  return req.headers['x-wx-token'] === SESSION_TOKEN || parsedUrl.searchParams.get('token') === SESSION_TOKEN;
}

function assertJsonMutationRequest(req) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (!type.includes('application/json')) throw Object.assign(new Error('Content-Type must be application/json'), { status: 415 });
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) {
    throw Object.assign(new Error('invalid origin'), { status: 403 });
  }
}

function assertApiAccess(req, parsedUrl) {
  if (!hasToken(req, parsedUrl)) throw Object.assign(new Error('invalid token'), { status: 403 });
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    assertJsonMutationRequest(req);
  }
}

async function sanitizedLogTail(limit = 200, loadedSettings = null) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));
  const settings = loadedSettings || await loadSettings();
  let logFile = path.join(TMP_DIR, 'wx-summary.log');
  try {
    logFile = resolveInsideTmp(settings.logging.file || './outputs/.tmp/wx-summary.log', 'logging.file');
  } catch {}
  const log = await fsp.readFile(logFile, 'utf-8').catch(() => '');
  const lines = log.split(/\r?\n/).map(line => sanitizeText(line)).filter(Boolean).slice(-safeLimit);
  return lines.length ? lines : (await readLogTail(safeLimit)).map(line => sanitizeText(line)).filter(Boolean);
}

async function postSaveSettingsWarnings(patch) {
  const warnings = [];
  if (!patch?.llm) return warnings;
  const saved = await loadSettings({ includeSecrets: true });
  if (!saved.llm.api_key) {
    warnings.push({ code: 'llm_api_key_missing', message: 'AI 设置已保存，但 API Key 为空，生成摘要前需要补齐。' });
    return warnings;
  }
  const ids = new Set((saved.llm.available_models || []).map(model => model.id));
  const modelMissing = saved.llm.model && ids.size > 0 && !saved.llm.custom_model && !ids.has(saved.llm.model);
  const longModelMissing = saved.llm.long_context_model && ids.size > 0 && !saved.llm.custom_long_context_model && !ids.has(saved.llm.long_context_model);
  if (modelMissing || longModelMissing) {
    warnings.push({
      code: 'llm_model_not_listed',
      message: 'AI 设置已保存，但所选模型不在已缓存的模型列表里；如确认可用，请开启自定义模型后保存，或刷新模型列表。',
    });
  }
  const capabilitySnapshot = patch.llm.capabilities === undefined ? saved.llm.capabilities : patch.llm.capabilities;
  if (hasFailedLlmCapability(capabilitySnapshot) || hasFailedLlmCapability(saved.llm.capabilities)) {
    warnings.push({
      code: 'llm_connectivity_failed',
      message: 'AI 设置已保存，但最近一次连通能力检查有失败项；生成前建议重新测试连通。',
    });
  }
  return warnings;
}

function hasFailedLlmCapability(value, depth = 0) {
  if (!value || depth > 5) return false;
  if (Array.isArray(value)) {
    return value.some(item => hasFailedLlmCapability(item, depth + 1));
  }
  if (typeof value !== 'object') return false;
  if (Object.hasOwn(value, 'ok') && value.ok === false) return true;
  return Object.values(value).some(item => hasFailedLlmCapability(item, depth + 1));
}

function settingsPatchNeedsSchedulerRestart(patch = {}) {
  if (patch?.scheduler) return true;
  if (!patch?.groups || typeof patch.groups !== 'object') return false;
  return Object.hasOwn(patch.groups, 'whitelist') || Object.hasOwn(patch.groups, 'overrides');
}

function settingsPatchTouchesManualKey(patch = {}) {
  return !!patch?.wechat
    && (Object.hasOwn(patch.wechat, 'manual_key') || Object.hasOwn(patch.wechat, 'clear_manual_key'));
}

async function handleApi(req, res, parsedUrl) {
  const pathname = parsedUrl.pathname;

  if (pathname === '/api/shutdown' && req.method === 'POST') {
    assertJsonMutationRequest(req);
    const body = await readBody(req, 1024);
    const shutdownToken = body.shutdown_token || req.headers['x-wx-shutdown'];
    if (shutdownToken !== SHUTDOWN_TOKEN) {
      throw Object.assign(new Error('invalid shutdown token'), { status: 403 });
    }
    sendJson(res, 200, { ok: true });
    setTimeout(() => gracefulShutdown(0), 20);
    return;
  }

  assertApiAccess(req, parsedUrl);

  if (pathname === '/api/state' && req.method === 'GET') {
    const settings = await loadSettings();
    const refresh = parsedUrl.searchParams.get('refresh') === 'true';
    const wechat = await detectWeixin({ force: refresh });
    const needSetup = settings._secrets_invalid || !settings.llm.base_url || !settings.llm.api_key_set;
    return sendJson(res, 200, {
      ok: true,
      need_setup: needSetup,
      platform: process.platform,
      project_root: PROJECT_ROOT,
      output_dir: outputDirFromSettings(settings),
      default_output_dir: DEFAULT_DIGESTS_DIR,
      session_token: SESSION_TOKEN,
      data_mode: wechat.accounts?.length ? 'wxdb' : 'unavailable',
      wechat,
      scheduler: getSchedulerStatus(),
      secrets_invalid: settings._secrets_invalid,
    });
  }

  if (pathname === '/api/accounts' && req.method === 'GET') {
    return sendJson(res, 200, await listAccounts());
  }

  if (pathname === '/api/groups' && req.method === 'GET') {
    return sendJson(res, 200, await listGroups({ account_id: parsedUrl.searchParams.get('account') || '' }));
  }

  if (pathname === '/api/settings' && req.method === 'GET') {
    return sendJson(res, 200, await publicSettings());
  }

  if (pathname === '/api/settings' && (req.method === 'PUT' || req.method === 'POST')) {
    const body = await readBody(req);
    const saved = await saveSettingsPatch(body);
    configureLogger(saved.logging);
    if (settingsPatchTouchesManualKey(body)) {
      clearDbKeyRuntimeCache({ clearVerified: true });
      logInfo('db_key_runtime_cache_cleared', { reason: 'manual_key_settings_changed' });
    }
    const warnings = await postSaveSettingsWarnings(body);
    logInfo('settings_saved', { sections: Object.keys(body || {}) });
    if (settingsPatchNeedsSchedulerRestart(body)) {
      await restartScheduler().catch(e => {
        logWarn('scheduler_restart_after_settings_failed', { error: sanitizeText(e?.message || String(e)) });
      });
    }
    return sendJson(res, 200, { ok: true, settings: saved, warnings });
  }

  if (pathname === '/api/scheduler/status' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, scheduler: getSchedulerStatus() });
  }

  if (pathname === '/api/scheduler/run-once' && req.method === 'POST') {
    const result = await runSchedulerOnce({ reason: 'manual_api', force: true });
    return sendJson(res, 200, { ok: true, result, scheduler: getSchedulerStatus() });
  }

  if (pathname === '/api/list-models' && req.method === 'POST') {
    const body = await readBody(req);
    const current = await loadSettings({ includeSecrets: true });
    const provider = body.provider || current.llm.provider;
    const baseUrl = normalizeBaseUrl(body.base_url || current.llm.base_url);
    const apiKey = body.api_key || current.llm.api_key;
    const result = await listModels({
      provider,
      base_url: baseUrl,
      api_key: apiKey,
      timeout_ms: Math.min(Number(current.llm.timeout_ms || 30000), 20000),
      persist: body.persist !== false,
    });
    logInfo('models_listed', { provider, base_url: baseUrl, ok: result.ok, count: result.models?.length || 0 });
    return sendJson(res, 200, result);
  }

  if (pathname === '/api/test-llm' && req.method === 'POST') {
    const body = await readBody(req);
    const current = await loadSettings({ includeSecrets: true });
    const provider = body.provider || current.llm.provider;
    const baseUrl = normalizeBaseUrl(body.base_url || current.llm.base_url);
    const apiKey = body.api_key || current.llm.api_key;
    const model = body.model || current.llm.model || current.llm.available_models?.[0]?.id || '';
    const longContextModel = body.long_context_model || current.llm.long_context_model || model;
    const targets = [{ role: 'model', model }];
    if (longContextModel && longContextModel !== model) targets.push({ role: 'long_context', model: longContextModel });
    const started = Date.now();
    const timeoutMs = Math.min(Number(current.llm.timeout_ms || 15000), 15000);
    const modelResults = await Promise.all(targets.map(async target => ({
      role: target.role,
      ...(await testLlmConnectivity({
        provider,
        base_url: baseUrl,
        api_key: apiKey,
        model: target.model,
        timeout_ms: timeoutMs,
      })),
    })));
    const result = modelResults[0];
    logInfo('llm_connectivity_checked', {
      provider,
      base_url: baseUrl,
      model,
      long_context_model: longContextModel || '',
      ok: modelResults.every(item => item.ok),
      latency_ms: Date.now() - started,
      results: modelResults.map(item => ({
        role: item.role,
        model: item.model,
        ok: item.ok,
        capabilities: item.capabilities?.map(capability => ({ name: capability.name, ok: capability.ok, latency_ms: capability.latency_ms })),
      })),
    });
    const allOk = modelResults.every(item => item.ok);
    const anyOk = modelResults.some(item => item.ok);
    return sendJson(res, 200, {
      ...result,
      ok: allOk,
      partial_ok: anyOk && !allOk,
      long_context_model: longContextModel || '',
      latency_ms: Date.now() - started,
      model_results: modelResults,
    });
  }

  if (pathname === '/api/wechat/status' && req.method === 'GET') {
    const scan = parsedUrl.searchParams.get('scan_key') === 'true';
    const deepScan = parsedUrl.searchParams.get('deep_key') === 'true';
    const allowBlockingDeepScan = parsedUrl.searchParams.get('allow_blocking') === 'true';
    if (deepScan && !allowBlockingDeepScan) {
      return sendJson(res, 409, {
        ok: false,
        status: 409,
        error: '深度 key 诊断会长时间占用本地服务；普通页面和群列表只使用标准扫描。需要开发者深度诊断时，请显式追加 allow_blocking=true。',
      });
    }
    if (deepScan && ACTIVE_DEEP_KEY_STATUS) {
      return sendJson(res, 409, {
        ok: false,
        status: 409,
        error: `深度 key 诊断正在运行，开始时间：${ACTIVE_DEEP_KEY_STATUS.started_at}`,
      });
    }
    if (deepScan) {
      ACTIVE_DEEP_KEY_STATUS = { started_at: new Date().toISOString() };
    }
    try {
      const processStatus = await detectWeixin({ force: scan || deepScan });
      const localKeyStatus = scan ? await scanLocalWeixinKeyCandidates({ include_raw: true }).catch(e => ({ ok: false, error: sanitizeText(e?.message || String(e)) })) : null;
      const keyStatus = await probeWxKey({ scan, include_raw: scan, scan_all_processes: scan });
      const rawKeys = [
        ...(Array.isArray(localKeyStatus?.raw_candidates) ? localKeyStatus.raw_candidates : []),
        ...(Array.isArray(keyStatus._raw_candidates) ? keyStatus._raw_candidates : []),
      ];
      if (localKeyStatus) delete localKeyStatus.raw_candidates;
      delete keyStatus._raw_candidates;
      delete keyStatus._raw_image_keys;
      const dbStatus = await probeWxDb({ raw_keys: rawKeys, deep_scan: deepScan });
      return sendJson(res, 200, { ok: true, process: processStatus, local_key_scan: localKeyStatus, key: keyStatus, db: dbStatus });
    } finally {
      if (deepScan) ACTIVE_DEEP_KEY_STATUS = null;
    }
  }

  if (pathname === '/api/wechat/db-inventory' && req.method === 'GET') {
    const account = parsedUrl.searchParams.get('account') || '';
    return sendJson(res, 200, { ok: true, ...(await readDbInventory(account)) });
  }

  if (pathname === '/api/digest' && req.method === 'POST') {
    const body = await readBody(req);
    if (ACTIVE_DIGEST_REQUESTS.size >= MAX_ACTIVE_DIGEST_REQUESTS) {
      throw Object.assign(new Error('当前摘要准备任务较多，请稍后再试。'), { status: 429 });
    }
    const requestId = NEXT_DIGEST_REQUEST_ID++;
    ACTIVE_DIGEST_REQUESTS.set(requestId, {
      started_at: new Date().toISOString(),
      account_id: body.account_id || '',
      group_id: body.group_id || body.groups?.[0]?.id || body.groups?.[0] || '',
      group: body.group_name || '',
    });
    try {
      return await runDigestSSE(req, res, body);
    } finally {
      ACTIVE_DIGEST_REQUESTS.delete(requestId);
    }
  }

  if (pathname === '/api/save-render' && req.method === 'POST') {
    const body = await readBody(req, SAVE_RENDER_BODY_LIMIT);
    const settings = await loadSettings();
    const item = await saveRenderedPng({ settings, digest: body.digest, png_data_url: body.png_data_url });
    logInfo('digest_render_saved', { digest_id: item.digest_id, group: item.group, relative_path: item.relative_path });
    return sendJson(res, 200, { ok: true, item });
  }

  if (pathname === '/api/export-preview' && req.method === 'POST') {
    const body = await readBody(req);
    const settings = await loadSettings();
    const markdown = redactContent(body.markdown || '', settings.privacy || {});
    const item = await savePreviewMarkdown({ settings, title: body.title || '文本预览', markdown });
    logInfo('preview_markdown_exported', { relative_path: item.relative_path });
    return sendJson(res, 200, { ok: true, item });
  }

  if (pathname === '/api/history' && req.method === 'GET') {
    const settings = await loadSettings();
    return sendJson(res, 200, await listHistory(settings));
  }

  if (pathname.startsWith('/api/digest-file/') && req.method === 'GET') {
    const digestId = decodeURIComponent(pathname.slice('/api/digest-file/'.length));
    const settings = await loadSettings();
    const item = await findHistoryItem(settings, digestId);
    if (!item) return sendJson(res, 404, { error: 'digest not found' });
    const file = await assertRevealable(settings, item.file_path, { extensions: ['.png'] });
    const data = await fsp.readFile(file);
    return send(res, 200, data, { 'Content-Type': 'image/png' });
  }

  if (pathname.startsWith('/api/digest-thumb/') && req.method === 'GET') {
    const digestId = decodeURIComponent(pathname.slice('/api/digest-thumb/'.length));
    const settings = await loadSettings();
    const item = await findHistoryItem(settings, digestId);
    if (!item) return sendJson(res, 404, { error: 'digest not found' });
    const file = await assertRevealable(settings, item.file_path, { extensions: ['.png'] });
    let data;
    try {
      const thumb = await renderDigestThumbnailPng({ filePath: file, digestId: item.digest_id });
      data = await fsp.readFile(thumb);
    } catch (e) {
      if (e?.status !== 501) throw e;
      data = await fsp.readFile(file);
    }
    return send(res, 200, data, { 'Content-Type': 'image/png' });
  }

  if (pathname.startsWith('/api/history-digest/') && req.method === 'GET') {
    const digestId = decodeURIComponent(pathname.slice('/api/history-digest/'.length));
    const settings = await loadSettings();
    const digest = await readHistoryDigest(settings, digestId);
    if (!digest) return sendJson(res, 404, { error: 'saved digest json not found' });
    return sendJson(res, 200, { ok: true, digest });
  }

  if (pathname === '/api/rerender-history' && req.method === 'POST') {
    if (process.platform !== 'win32') {
      throw Object.assign(new Error('历史重新渲染当前仅支持 Windows；macOS 可回到总结页重新生成摘要长图。'), { status: 501 });
    }
    const body = await readBody(req);
    const settings = await loadSettings();
    const item = await findHistoryItem(settings, body.digest_id || '');
    if (!item) return sendJson(res, 404, { error: 'digest not found' });
    const digest = await readHistoryDigest(settings, item.digest_id);
    if (!digest) return sendJson(res, 404, { error: 'saved digest json not found' });
    const savedRenderOptions = digest.__render && typeof digest.__render === 'object' && !Array.isArray(digest.__render) ? digest.__render : {};
    const renderOptions = body.render && typeof body.render === 'object' && !Array.isArray(body.render)
      ? { ...settings.render, ...body.render }
      : { ...settings.render, ...savedRenderOptions };
    const digestForSave = { ...digest, __render: persistedRenderOptions(renderOptions) };
    const pngDataUrl = await renderDigestPngDataUrl(digestForSave, renderOptions);
    const next = await overwriteRenderedPng({ settings, item, digest: digestForSave, png_data_url: pngDataUrl });
    return sendJson(res, 200, { ok: true, item: next });
  }

  if (pathname === '/api/reveal' && req.method === 'POST') {
    const body = await readBody(req);
    const settings = await loadSettings();
    let target = body.path || '';
    if (body.digest_id) {
      const item = await findHistoryItem(settings, body.digest_id);
      target = item?.file_path || '';
    }
    const file = await assertRevealable(settings, target, { extensions: ['.png'] });
    const reveal = await revealInFolder(file);
    recordRevealEvidence(file, reveal);
    return sendJson(res, 200, { ok: true, reveal });
  }

  if (pathname === '/api/copy-image' && req.method === 'POST') {
    const body = await readBody(req);
    const settings = await loadSettings();
    let target = body.path || '';
    if (body.digest_id) {
      const item = await findHistoryItem(settings, body.digest_id);
      target = item?.file_path || '';
    }
    const file = await assertRevealable(settings, target, { extensions: ['.png'] });
    const copied = await copyPngToClipboard(file);
    const evidence = recordClipboardCopyEvidence(file, copied);
    return sendJson(res, 200, { ok: true, clipboard: evidence.clipboard });
  }

  if (pathname === '/api/record-clipboard-copy' && req.method === 'POST') {
    const body = await readBody(req);
    const settings = await loadSettings();
    let target = body.path || '';
    if (body.digest_id) {
      const item = await findHistoryItem(settings, body.digest_id);
      target = item?.file_path || '';
    }
    const file = await assertRevealable(settings, target, { extensions: ['.png'] });
    const evidence = recordClipboardCopyEvidence(file, {
      clipboard: body.clipboard,
      method: body.method || 'browser_clipboard',
    });
    return sendJson(res, 200, { ok: true, clipboard: evidence.clipboard });
  }

  if (pathname === '/api/open-output' && req.method === 'POST') {
    const body = await readBody(req);
    const settings = await loadSettings();
    const requestedDir = String(body.dir || settings.output?.dir || '').trim();
    const dir = outputDirFromSettings({
      ...settings,
      output: { ...settings.output, dir: requestedDir || settings.output?.dir },
    });
    await fsp.mkdir(dir, { recursive: true });
    const opener = await openDirectoryInSystem(dir);
    return sendJson(res, 200, { ok: true, opener });
  }

  if (pathname === '/api/logs' && req.method === 'GET') {
    const limit = parsedUrl.searchParams.get('limit') || 200;
    return sendJson(res, 200, { ok: true, log_tail: await sanitizedLogTail(limit) });
  }

  if (pathname === '/api/diagnostics' && req.method === 'GET') {
    const scope = parsedUrl.searchParams.get('scope') || '';
    const lightweight = scope === 'acceptance' || parsedUrl.searchParams.get('light') === 'true';
    const settings = await loadSettings();
    const logTail = await sanitizedLogTail(lightweight ? 40 : 200, settings);
    const [
      currentBinary,
      weixinModules,
      mediaTools,
      externalBinary,
    ] = await Promise.all([
      getWeixinBinaryEvidence().catch(e => ({ ok: false, error: sanitizeText(e?.message || String(e)) })),
      lightweight
        ? Promise.resolve({ skipped: true, reason: 'lightweight_acceptance_scope' })
        : getWeixinModuleEvidence().catch(e => ({ ok: false, error: sanitizeText(e?.message || String(e)) })),
      lightweight
        ? Promise.resolve({ skipped: true, reason: 'lightweight_acceptance_scope' })
        : probeMediaTools().catch(e => ({ error: sanitizeText(e?.message || String(e)) })),
      readExternalWeixinBaseline(),
    ]);
    const prelaunchBinary = freshPrelaunchBaseline();
    const launcherBinary = freshLauncherBaseline();
    const service = {
      pid: process.pid,
      host: HOST,
      port: ACTIVE_PORT,
      url: ACTIVE_PORT ? `http://${HOST}:${ACTIVE_PORT}` : '',
      loopback_only: HOST === '127.0.0.1',
      started_at: SERVICE_STARTED_AT.toISOString(),
      uptime_ms: Date.now() - SERVICE_STARTED_AT.getTime(),
      uptime_hours: Number(((Date.now() - SERVICE_STARTED_AT.getTime()) / 3_600_000).toFixed(3)),
      active_digest_requests: ACTIVE_DIGEST_REQUESTS.size,
      max_active_digest_requests: MAX_ACTIVE_DIGEST_REQUESTS,
    };
    const localActionEvidence = {
      last_clipboard_copy: LAST_CLIPBOARD_COPY_EVIDENCE,
      last_reveal_request: LAST_REVEAL_EVIDENCE,
    };
    const secrets = {
      storage: secretStorageLabel(),
      ok: !settings._secrets_invalid,
      dpapi_ok: process.platform === 'win32' ? !settings._secrets_invalid : null,
      invalid: !!settings._secrets_invalid,
    };
    const weixinBinary = {
      external_user_baseline: externalBinary,
      prelaunch: WEIXIN_BINARY_PRELAUNCH_BASELINE,
      launcher_pre_node: WEIXIN_BINARY_LAUNCHER_BASELINE,
      startup: WEIXIN_BINARY_BASELINE,
      current: currentBinary,
      external_to_startup_unchanged: compareSha256(externalBinary, WEIXIN_BINARY_BASELINE),
      external_to_current_unchanged: compareSha256(externalBinary, currentBinary),
      unchanged: compareSha256(WEIXIN_BINARY_BASELINE, currentBinary),
      prelaunch_to_launcher_unchanged: compareSha256(prelaunchBinary, launcherBinary),
      prelaunch_to_startup_unchanged: compareSha256(prelaunchBinary, WEIXIN_BINARY_BASELINE),
      prelaunch_to_current_unchanged: compareSha256(prelaunchBinary, currentBinary),
      launcher_to_startup_unchanged: compareSha256(launcherBinary, WEIXIN_BINARY_BASELINE),
      launcher_to_current_unchanged: compareSha256(launcherBinary, currentBinary),
      comparison_scope: 'service_startup_vs_diagnostics_export',
      launcher_comparison_scope: 'cmd_pre_tray_and_tray_pre_node_vs_service_startup_and_diagnostics_export_when_fresh',
      external_baseline_required: true,
      external_baseline_instruction: '退出 wx-summary 后运行项目根目录的 验收-记录微信哈希.cmd，生成 data/external-weixin-binary-baseline.json；这是启动本工具前独立记录的 SHA256。',
      prelaunch_scope_note: 'prelaunch 由启动.cmd 在托盘启动前采集；launcher_pre_node 由托盘在启动 Node 前采集。',
      verification_note: `external_user_baseline 是启动本工具前由用户独立记录的 ${weixinExecutableLabel()} SHA256，可写入 data/external-weixin-binary-baseline.json；launcher_pre_node 由托盘在启动 Node 前采集；prelaunch 仅在本地另行提供 data/prelaunch-weixin-binary.json 时参与比较。external_to_* 为 true 时可作为 A3 的外部基线证据；launcher_to_* 可加强证明本工具启动链路内没有改动 ${weixinExecutableLabel()}。`,
    };
    return sendJson(res, 200, {
      ok: true,
      diagnostic_scope: lightweight ? 'acceptance' : 'full',
      project_root: PROJECT_ROOT,
      service,
      acceptance_manual_checks: manualAcceptanceChecks({ service, localActionEvidence, secrets, weixinBinary, platform: process.platform }),
      local_action_evidence: localActionEvidence,
      log_tail: logTail,
      secrets,
      capabilities: {
        system_clipboard_image: process.platform === 'win32',
        reveal_in_folder: true,
        ffmpeg: !!mediaTools.ffmpeg?.available,
        wxgf_native_decoder: !!mediaTools.voip_engine?.available,
      },
      media_tools: mediaTools,
      weixin_binary: weixinBinary,
      weixin_modules: weixinModules,
    });
  }

  return sendJson(res, 404, { error: 'no such api' });
}

function imageSizeSummary(size) {
  const width = Number(size?.width || 0);
  const height = Number(size?.height || 0);
  return width > 0 && height > 0 ? `${width}x${height}` : '';
}

function persistedRenderOptions(options = {}) {
  const theme = ['light', 'dark'].includes(options.theme)
    ? options.theme
    : ['light', 'dark'].includes(options.default_theme)
      ? options.default_theme
      : 'light';
  const fontSize = options.font_size === 'large' || options.default_font_size === 'large' ? 'large' : 'normal';
  const accentColor = /^#[0-9a-fA-F]{6}$/.test(String(options.accent_color || ''))
    ? String(options.accent_color).toUpperCase()
    : '';
  return { theme, font_size: fontSize, accent_color: accentColor };
}

function manualAcceptanceChecks({ service = {}, localActionEvidence = {}, secrets = {}, weixinBinary = {}, platform = process.platform } = {}) {
  const binaryLabel = platform === 'darwin' ? 'WeChat' : 'Weixin.exe';
  const fileManagerLabel = platform === 'darwin' ? 'Finder' : 'Windows 资源管理器';
  const secretLabel = secrets.storage || (platform === 'darwin' ? 'macOS Keychain' : 'Windows DPAPI');
  const uptimeHours = Number(service.uptime_hours || 0);
  const uptimeReady = uptimeHours >= 24;
  const clipboardEvidence = localActionEvidence.last_clipboard_copy;
  const clipboardSize = imageSizeSummary(clipboardEvidence?.clipboard);
  const revealEvidence = localActionEvidence.last_reveal_request;
  const explorerSelection = revealEvidence?.explorer_selection;
  const explorerMatched = explorerSelection?.matched === true;
  const a3SoftwareReady = weixinBinary.unchanged === true
    && (
      weixinBinary.prelaunch_to_current_unchanged === true
      || weixinBinary.launcher_to_current_unchanged === true
    );
  const d5SecretEvidenceReady = !!secrets.invalid;
  const externalAgeMs = Number(weixinBinary.external_user_baseline?.age_vs_service_start_ms);
  const externalBeforeServiceStart = Number.isFinite(externalAgeMs) && externalAgeMs >= -30_000;
  const externalBaselineMatched = weixinBinary.external_to_current_unchanged === true && externalBeforeServiceStart;
  const externalBaselineLate = weixinBinary.external_to_current_unchanged === true && !externalBeforeServiceStart;
  const a3Summary = externalBaselineMatched
    ? `独立外部基线已记录，且与当前 ${binaryLabel} 哈希一致；仍需用户确认这份记录是在启动 wx-summary 前生成。`
    : externalBaselineLate
      ? `已找到独立基线记录且与当前 ${binaryLabel} 哈希一致，但记录时间晚于本轮服务启动，只能作为下一轮验收准备。`
    : a3SoftwareReady
      ? `本工具启动入口、托盘、服务内的 ${binaryLabel} 哈希对照已可用；仍需用户启动前外部哈希。`
      : `本工具链路内哈希对照不完整，请重启后导出诊断包或检查 ${binaryLabel} 是否运行。`;
  return [
    {
      id: 'A3',
      title: `${binaryLabel} 启动前外部哈希对照`,
      status: 'needs_user_confirmation',
      user_confirmation_required: true,
      ready_for_user_confirmation: externalBaselineMatched || a3SoftwareReady,
      software_evidence_status: externalBaselineMatched ? 'external_baseline_matched' : (externalBaselineLate ? 'external_baseline_after_service_start' : (a3SoftwareReady ? 'ready_for_external_baseline_check' : 'software_evidence_incomplete')),
      software_evidence_summary: a3Summary,
      evidence_available: ['weixin_binary.external_user_baseline', 'weixin_binary.prelaunch', 'weixin_binary.launcher_pre_node', 'weixin_binary.startup', 'weixin_binary.current', 'weixin_binary.unchanged', 'weixin_binary.external_to_current_unchanged', 'weixin_binary.prelaunch_to_current_unchanged', 'weixin_binary.launcher_to_current_unchanged'],
      next_step: externalBaselineMatched
        ? '确认 data/external-weixin-binary-baseline.json 是启动 wx-summary 前独立生成；确认后即可作为 A3 的外部基线证据。'
        : externalBaselineLate
          ? `下次验收时先退出 wx-summary，再运行 验收-记录微信哈希.cmd 独立记录 ${binaryLabel} SHA256，然后启动 wx-summary 并导出诊断包。`
        : `启动 wx-summary 前先运行 验收-记录微信哈希.cmd 独立记录 ${binaryLabel} SHA256 作为外部基线；已启动后只能作为下一轮验收的准备证据。`,
    },
    {
      id: 'A6',
      title: '24 小时微信状态与已读位置',
      status: 'needs_user_confirmation',
      user_confirmation_required: true,
      ready_for_user_confirmation: uptimeReady,
      software_evidence_status: uptimeReady ? 'ready_for_user_confirmation' : 'waiting_for_24h_uptime',
      software_evidence_summary: uptimeReady
        ? `服务本轮已运行 ${uptimeHours} 小时，可开始做另一设备微信状态确认。`
        : `服务本轮已运行 ${uptimeHours} 小时，距离 24 小时证据还差约 ${Math.max(0, 24 - uptimeHours).toFixed(3)} 小时。`,
      evidence_available: ['service.started_at', 'service.uptime_hours'],
      next_step: '服务连续运行满 24 小时后，从另一设备确认在线状态、已读位置和回执无异常。',
    },
    {
      id: 'B7',
      title: '复制 PNG 后粘贴到微信',
      status: 'needs_user_confirmation',
      user_confirmation_required: true,
      ready_for_user_confirmation: !!clipboardEvidence,
      software_evidence_status: clipboardEvidence ? 'ready_for_user_paste_confirmation' : 'needs_local_copy_action',
      software_evidence_summary: clipboardEvidence
        ? `最近一次剪贴板写入：${clipboardEvidence.relative_path || '未知文件'}${clipboardSize ? `，尺寸 ${clipboardSize}` : ''}。`
        : '本轮服务还没有成功复制 PNG 到剪贴板的动作证据。',
      evidence_available: [platform === 'win32' ? 'Windows 剪贴板 fallback 支持' : '浏览器剪贴板复制需人工确认', 'local_action_evidence.last_clipboard_copy'],
      latest_evidence: clipboardEvidence,
      next_step: '在 Edge 或 Chrome 中复制长图后，实际 Ctrl+V 到微信窗口并发送。',
    },
    {
      id: 'B8',
      title: '在文件夹中显示',
      status: 'needs_user_confirmation',
      user_confirmation_required: true,
      ready_for_user_confirmation: !!revealEvidence,
      software_evidence_status: revealEvidence ? (explorerMatched ? 'explorer_selection_matched' : 'reveal_requested_needs_visual_confirmation') : 'needs_local_reveal_action',
      software_evidence_summary: revealEvidence
        ? `最近一次请求打开：${revealEvidence.relative_path || '未知文件'}；${fileManagerLabel} 选中匹配=${explorerMatched ? 'true' : String(explorerSelection?.matched ?? 'unknown')}。`
        : '本轮服务还没有“在文件夹中显示”的动作证据。',
      evidence_available: ['reveal API 路径边界', 'local_action_evidence.last_reveal_request'],
      latest_evidence: revealEvidence,
      next_step: `点击“在文件夹中显示”后，目测确认 ${fileManagerLabel} 弹出并选中目标 PNG。`,
    },
    {
      id: 'D5',
      title: `跨系统用户 ${secretLabel}`,
      status: 'needs_user_confirmation',
      user_confirmation_required: true,
      ready_for_user_confirmation: d5SecretEvidenceReady,
      software_evidence_status: d5SecretEvidenceReady ? 'bad_secret_detected_external_user_needed' : 'needs_bad_secret_or_external_user_test',
      software_evidence_summary: secrets.invalid
        ? `当前用户已检测到 ${secretLabel} 密钥不可解并会回到向导；真实跨系统用户仍需人工切换确认。`
        : `当前用户 ${secretLabel} 密钥可读；本轮诊断没有坏密钥或跨系统用户切换证据。`,
      evidence_available: ['secrets.invalid', '向导提示'],
      next_step: '换另一个系统用户登录后，确认密钥解密失败会回到向导，且不展示旧密文。',
    },
  ];
}

async function runDigestSSE(req, res, body) {
  const controller = new AbortController();
  let completed = false;
  const abortForClientClose = () => {
    if (!completed) controller.abort();
  };
  req.once('aborted', abortForClientClose);
  res.once('close', abortForClientClose);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const ensureActive = () => {
    if (controller.signal.aborted) {
      throw Object.assign(new Error('请求已取消'), { status: 499 });
    }
  };
  const sendEvent = (event, data) => {
    if (controller.signal.aborted || res.destroyed || res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  let currentStage = '';
  let currentStageLabel = '';
  let currentStageDetail = '';
  let stageStartedAt = 0;
  const sendStage = (data) => {
    if (data?.status === 'running') {
      const nextStage = data?.name || currentStage;
      if (currentStage !== nextStage || !stageStartedAt) stageStartedAt = Date.now();
      currentStage = nextStage;
      currentStageLabel = data?.label || currentStageLabel;
      currentStageDetail = data?.detail || '';
    } else if (currentStage === data?.name) {
      currentStage = '';
      currentStageLabel = '';
      currentStageDetail = '';
      stageStartedAt = 0;
    }
    sendEvent('stage', data);
  };
  const progressDetail = () => {
    if (!currentStage || !stageStartedAt) return '';
    const elapsedSeconds = Math.max(1, Math.round((Date.now() - stageStartedAt) / 1000));
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    const elapsed = minutes ? `仍在处理，已用时 ${minutes}分${String(seconds).padStart(2, '0')}秒` : `仍在处理，已用时 ${seconds}秒`;
    return currentStageDetail ? `${currentStageDetail} · ${elapsed}` : elapsed;
  };
  const heartbeat = setInterval(() => {
    if (controller.signal.aborted || res.destroyed || res.writableEnded) return;
    res.write(`: ping ${Date.now()}\n\n`);
    if (currentStage) {
      sendEvent('stage', {
        name: currentStage,
        label: currentStageLabel || (currentStage === 'summarizing' ? 'AI 总结' : (currentStage === 'fetching' ? '拉取消息' : '处理中')),
        status: 'running',
        detail: progressDetail(),
      });
    }
  }, 15000);
  heartbeat.unref?.();
  try {
    const settings = await loadDigestBatchSettings(body.batch_id);
    const groupId = body.group_id || body.groups?.[0]?.id || body.groups?.[0] || '';
    const groupName = body.group_name || body.groups?.[0]?.name || '未命名会话';
    const since = body.since || '';
    const until = body.until || 'now';
    const accountId = body.account_id || '';
    logInfo('digest_started', { account_id: accountId, group_id: groupId, group: groupName, since, until, preview_text: !!body.preview_text, batch_id: normalizeDigestBatchId(body.batch_id) });

    ensureActive();
    sendStage({ name: 'fetching', label: '拉取消息', status: 'running' });
    const collection = await collectMessages({
      group_id: groupId,
      group_name: groupName,
      account_id: accountId,
      since,
      until,
      filters: body.filters || {},
      min_messages: body.min_messages,
      signal: controller.signal,
    });
    ensureActive();
    sendStage({
      name: 'fetching',
      label: '拉取消息',
      status: 'done',
      detail: `${collection.message_count} 条${collection.truncated ? ` / 已截取 ${collection.scanned_message_count} 条` : ''} · ${collection.source_label}`,
    });
    logInfo('digest_messages_collected', {
      account_id: accountId,
      group_id: groupId,
      message_count: collection.message_count,
      scanned_message_count: collection.scanned_message_count || collection.message_count,
      source_label: collection.source_label,
    });

    if (!collection.message_count || !Array.isArray(collection.messages) || collection.messages.length === 0) {
      throw Object.assign(new Error('所选时间范围内没有可总结的消息，请换一个时间范围或群聊。'), { status: 400 });
    }

    if (collection.below_minimum) {
      sendStage({ name: 'fetching', label: `消息数少于阈值，仍继续总结`, status: 'done' });
      logWarn('digest_below_minimum', { group_id: groupId, message_count: collection.message_count, min_messages: body.min_messages });
    }

    sendStage({ name: 'summarizing', label: 'AI 总结', status: 'running', detail: `${collection.message_count} 条消息${collection.messages?.some(m => m.link_previews?.length) ? ' · 含链接打开结果' : ''}` });
    const digest = await summarizeDigest({
      settings,
      groupName: collection.group_name,
      since: collection.since,
      until: collection.until,
      messages: collection.messages,
      signal: controller.signal,
      onProgress: progress => {
        sendStage({
          name: 'summarizing',
          label: progress?.label || 'AI 总结',
          status: 'running',
          detail: progress?.detail || '',
        });
      },
    });
    ensureActive();
    digest.input_message_count = collection.message_count;
    digest.scanned_message_count = collection.scanned_message_count || collection.message_count;
    digest.truncated = !!collection.truncated;
    digest.source_label = collection.source_label;
    sendStage({ name: 'summarizing', label: 'AI 总结', status: 'done', detail: digest.model });
    logInfo('digest_summarized', { group_id: groupId, digest_id: digest.digest_id, model: digest.model, topics: digest.topics?.length || 0, links: digest.links?.length || 0 });

    sendStage({ name: 'rendering', label: body.preview_text ? '生成文本预览' : '渲染长图', status: 'running' });
    sendEvent('digest', { ...digest, preview_text: !!body.preview_text });
    sendStage({ name: 'rendering', label: body.preview_text ? '生成文本预览' : '渲染长图', status: 'done' });
    sendEvent('done', { digest_id: digest.digest_id, preview_text: !!body.preview_text });
    logInfo('digest_done', { group_id: groupId, digest_id: digest.digest_id, preview_text: !!body.preview_text });
  } catch (e) {
    if (e?.status === 499 || controller.signal.aborted) {
      logWarn('digest_cancelled', { error: e?.message || '请求已取消' });
    } else {
      logError('digest_failed', { error: e?.message || String(e) });
    }
    sendEvent('error', { message: sanitizeText(e?.message || String(e)) });
  } finally {
    clearInterval(heartbeat);
    completed = true;
    req.off('aborted', abortForClientClose);
    res.off('close', abortForClientClose);
    if (!res.destroyed && !res.writableEnded) res.end();
  }
}

function handle(req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || HOST}`);
  if (parsedUrl.pathname === '/') {
    serveIndex(res).catch(e => send(res, 500, sanitizeText(e?.message || String(e))));
    return;
  }
  if (parsedUrl.pathname.startsWith('/api/')) {
    handleApi(req, res, parsedUrl).catch(e => {
      logError('api_error', { method: req.method, path: parsedUrl.pathname, status: e?.status || 500, error: e?.message || String(e) });
      apiError(res, e);
    });
    return;
  }
  if (parsedUrl.pathname === '/favicon.ico') return send(res, 204, '');
  serveStatic(res, parsedUrl.pathname).catch(e => send(res, 500, sanitizeText(e?.message || String(e))));
}

function tryListen(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handle);
    server.once('error', err => {
      if (err.code === 'EADDRINUSE') resolve(null);
      else reject(err);
    });
    server.listen(port, HOST, () => resolve(server));
  });
}

function argValue(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

export async function main() {
  const settings = await loadSettings();
  await ensureRuntimeDirs(settings);
  if (process.env.WX_SUMMARY_SKIP_TMP_CLEAR !== '1') await clearTmpDir();
  configureLogger(settings.logging);
  WEIXIN_BINARY_EXTERNAL_BASELINE = await readExternalWeixinBaseline();
  WEIXIN_BINARY_PRELAUNCH_BASELINE = await readPrelaunchWeixinBaseline();
  WEIXIN_BINARY_LAUNCHER_BASELINE = await readLauncherWeixinBaseline();
  logInfo('startup_begin', { pid: process.pid, project_root: PROJECT_ROOT, no_open: !shouldOpenBrowser(settings), open_browser: settings.web?.open_browser !== false });
  if (WEIXIN_BINARY_EXTERNAL_BASELINE) {
    logInfo('external_weixin_binary_baseline', {
      ok: !!WEIXIN_BINARY_EXTERNAL_BASELINE.ok,
      source: WEIXIN_BINARY_EXTERNAL_BASELINE.source,
      process_count: WEIXIN_BINARY_EXTERNAL_BASELINE.process_count,
    });
  }
  if (WEIXIN_BINARY_PRELAUNCH_BASELINE) {
    logInfo('prelaunch_weixin_binary_evidence', {
      ok: !!WEIXIN_BINARY_PRELAUNCH_BASELINE.ok,
      source: WEIXIN_BINARY_PRELAUNCH_BASELINE.source,
      fresh_for_this_service: !!WEIXIN_BINARY_PRELAUNCH_BASELINE.fresh_for_this_service,
      process_count: WEIXIN_BINARY_PRELAUNCH_BASELINE.process_count,
    });
  }
  if (WEIXIN_BINARY_LAUNCHER_BASELINE) {
    logInfo('launcher_weixin_binary_evidence', {
      ok: !!WEIXIN_BINARY_LAUNCHER_BASELINE.ok,
      fresh_for_this_service: !!WEIXIN_BINARY_LAUNCHER_BASELINE.fresh_for_this_service,
      process_count: WEIXIN_BINARY_LAUNCHER_BASELINE.process_count,
    });
  }
  await cleanupOldDigests(settings);
  WEIXIN_BINARY_BASELINE = await getWeixinBinaryEvidence().catch(e => ({ ok: false, error: sanitizeText(e?.message || String(e)) }));

  let port = Number(argValue('--port') || settings.web.port || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) port = DEFAULT_PORT;
  let server = null;
  for (let i = 0; i < 10; i++) {
    server = await tryListen(port);
    if (server) break;
    port += 1;
  }
  if (!server) {
    logError('startup_failed', { error: 'ports_unavailable', first_port: DEFAULT_PORT, last_port: DEFAULT_PORT + 9 });
    console.error('[wx-summary] 端口 7788~7797 都被占用，请关闭其他服务后重试');
    process.exit(1);
  }

  ACTIVE_SERVER = server;
  ACTIVE_PORT = port;
  if (process.env.WX_SUMMARY_NO_RUNTIME_FILE !== '1') {
    await writeRuntimeInfo(port);
    process.once('exit', removeRuntimeInfo);
  }
  process.once('SIGINT', () => { gracefulShutdown(0); });
  process.once('SIGTERM', () => { gracefulShutdown(0); });

  const wx = await detectWeixin();
  await startScheduler().catch(() => {});
  logInfo('server_listening', { url: `http://${HOST}:${port}`, wechat_running: !!wx.running, wechat_message: wx.message, scheduler: getSchedulerStatus() });
  console.log([
    '',
    'wx-summary v0.1.0',
    `✓ 服务：http://${HOST}:${port}`,
    `${wx.running ? '✓' : '!'} 微信：${wx.message}`,
    `✓ 项目根：${PROJECT_ROOT}`,
    '按 Ctrl+C 停止',
    '',
  ].join('\n'));

  setTimeout(() => openInBrowser(`http://${HOST}:${port}`, settings), 300);
  return server;
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry === url.fileURLToPath(import.meta.url)) {
  main().catch(e => {
    configureLogger();
    logError('startup_failed', { error: e?.message || String(e) });
    console.error('启动失败：', sanitizeText(e?.message || String(e)));
    process.exit(1);
  });
}

export const __mainInternals = {
  settingsPatchNeedsSchedulerRestart,
};
