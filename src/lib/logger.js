import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import readline from 'node:readline';
import { finished } from 'node:stream/promises';
import { renameAtomicWithRetry } from './json-store.js';
import { PROJECT_ROOT, TMP_DIR, assertSafeTmpPath, resolveInsideTmp } from './paths.js';

const DEFAULT_LOG_FILE = path.join(TMP_DIR, 'wx-summary.log');
const LOG_TAIL_MAX_BYTES = 256 * 1024;
const LEVELS = new Map([['debug', 10], ['info', 20], ['warn', 30], ['error', 40]]);
const SENSITIVE_FIELD_KEYS = new Set([
  'account',
  'account_id',
  'account_root',
  'base_url',
  'backup_path',
  'command_line',
  'cursor',
  'cursor_key',
  'db_storage',
  'digest_path',
  'digest_relative_path',
  'file_name',
  'file_path',
  'group',
  'group_id',
  'group_name',
  'keyword',
  'keyword_override',
  'keywords',
  'legacy_cursor_key',
  'main_path',
  'path',
  'project_root',
  'ref',
  'refs',
  'relative_path',
  'sender',
  'senders',
  'token',
  'wxid',
]);
const SENSITIVE_FIELD_SUFFIXES = [
  'account',
  'account_id',
  'account_label',
  'account_name',
  'account_root',
  'group',
  'group_id',
  'group_label',
  'group_name',
  'sender',
  'sender_id',
  'sender_name',
  'wxid',
];

let targetFile = DEFAULT_LOG_FILE;
let maxBytes = 50 * 1024 * 1024;
let minLevel = 'info';
let writeQueue = Promise.resolve();
let loggerWriteFailureGeneration = 0;
let observedLoggerWriteFailureGeneration = 0;
const scheduledLogSanitizationFiles = new Set();

export function configureLogger(logging = {}) {
  minLevel = LEVELS.has(logging.level) ? logging.level : 'info';
  maxBytes = Math.max(1, Math.min(500, Number(logging.max_mb || 50))) * 1024 * 1024;
  try {
    targetFile = resolveInsideTmp(logging.file || './outputs/.tmp/wx-summary.log', 'logging.file');
  } catch {
    targetFile = DEFAULT_LOG_FILE;
  }
  scheduleExistingLogSanitization(targetFile);
}

export function logDebug(event, fields = {}) {
  writeLog('debug', event, fields);
}

export function logInfo(event, fields = {}) {
  writeLog('info', event, fields);
}

export function logWarn(event, fields = {}) {
  writeLog('warn', event, fields);
}

export function logError(event, fields = {}) {
  writeLog('error', event, fields);
}

export async function waitForLoggerWritesToSettle(timeoutMs = 2000) {
  const timeout = Math.max(0, Number(timeoutMs || 0) || 0);
  const deadline = Date.now() + timeout;
  const observedFailureAtStart = observedLoggerWriteFailureGeneration;
  while (true) {
    const pending = writeQueue;
    const remainingMs = Math.max(0, deadline - Date.now());
    if (remainingMs <= 0) {
      const settled = await Promise.race([
        pending.then(() => true),
        Promise.resolve(false),
      ]);
      if (!settled || pending !== writeQueue) return false;
      return finishLoggerWriteDrain(observedFailureAtStart);
    }
    let timer = null;
    const settled = await Promise.race([
      pending.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), remainingMs); }),
    ]);
    if (timer) clearTimeout(timer);
    if (!settled) return false;
    if (pending === writeQueue) return finishLoggerWriteDrain(observedFailureAtStart);
  }
}

function finishLoggerWriteDrain(observedFailureAtStart) {
  const failureAtSettlement = loggerWriteFailureGeneration;
  observedLoggerWriteFailureGeneration = Math.max(observedLoggerWriteFailureGeneration, failureAtSettlement);
  return failureAtSettlement === observedFailureAtStart;
}

function recordLoggerWriteFailure() {
  loggerWriteFailureGeneration += 1;
}

export async function readLogTail(maxLines = 200, { signal = null } = {}) {
  return readLogFileTail(targetFile, maxLines, { signal });
}

export async function readLogFileTail(file = targetFile, maxLines = 200, { signal = null } = {}) {
  throwIfLogReadAborted(signal);
  const lineLimit = Math.max(1, Math.min(1000, Number(maxLines || 200) || 200));
  const safe = await assertSafeTmpPath(file || targetFile, {
    label: 'logging.file',
    requireFile: true,
  }).catch(e => {
    if (e?.code === 'TMP_PATH_MISSING') return null;
    throw e;
  });
  throwIfLogReadAborted(signal);
  if (!safe) return [];
  const logFile = safe.resolved;
  const stat = safe.stat || await fsp.stat(logFile).catch(() => null);
  throwIfLogReadAborted(signal);
  if (!stat?.size) return [];
  const bytesToRead = Math.min(stat.size, Math.max(8192, Math.min(LOG_TAIL_MAX_BYTES, lineLimit * 2048)));
  let handle = null;
  let handleClosePromise = null;
  const closeHandle = () => {
    if (!handle) return Promise.resolve();
    if (!handleClosePromise) {
      handleClosePromise = Promise.resolve()
        .then(() => handle.close())
        .catch(() => {});
    }
    return handleClosePromise;
  };
  let text = '';
  try {
    handle = await fsp.open(logFile, 'r').catch(() => null);
    throwIfLogReadAborted(signal);
    if (!handle) return [];
    const onAbort = () => { void closeHandle(); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      throwIfLogReadAborted(signal);
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, stat.size - bytesToRead);
      throwIfLogReadAborted(signal);
      text = buffer.subarray(0, bytesRead).toString('utf-8');
    } catch (error) {
      if (signal?.aborted) throwIfLogReadAborted(signal);
      throw error;
    } finally {
      try {
        await closeHandle();
        throwIfLogReadAborted(signal);
      } finally {
        signal?.removeEventListener?.('abort', onAbort);
      }
    }
  } finally {
    await closeHandle();
    throwIfLogReadAborted(signal);
  }
  if (stat.size > bytesToRead) text = text.replace(/^[^\r\n]*(?:\r?\n|$)/, '');
  return text.split(/\r?\n/).filter(Boolean).slice(-lineLimit);
}

function throwIfLogReadAborted(signal = null) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw Object.assign(new Error('日志读取已取消。'), { name: 'AbortError', status: 499 });
}

function writeLog(level, event, fields) {
  if ((LEVELS.get(level) || 99) < (LEVELS.get(minLevel) || 20)) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${cleanToken(event)} ${stringifyFields(fields)}\n`;
  const logFile = targetFile;
  const logMaxBytes = maxBytes;
  writeQueue = writeQueue
    .then(async () => {
      await assertSafeTmpPath(logFile, { label: 'logging.file', ensureParent: true });
      await rotateIfNeeded(logFile, Buffer.byteLength(line), logMaxBytes);
      await assertSafeTmpPath(logFile, { label: 'logging.file', ensureParent: true });
      await fsp.appendFile(logFile, line, 'utf-8');
    })
    .catch(recordLoggerWriteFailure);
}

async function rotateIfNeeded(file, incomingBytes, limit) {
  const safe = await assertSafeTmpPath(file, { label: 'logging.file', ensureParent: true });
  const stat = safe.exists ? safe.stat : null;
  if (!stat || stat.size + incomingBytes <= limit) return;
  const oldFile = `${file}.1`;
  const safeOld = await assertSafeTmpPath(oldFile, { label: 'logging.file.1', ensureParent: true });
  await fsp.rm(safeOld.resolved, { force: true }).catch(() => {});
  await fsp.rename(safe.resolved, safeOld.resolved).catch(() => {});
}

function scheduleExistingLogSanitization(file) {
  const key = path.resolve(file);
  if (scheduledLogSanitizationFiles.has(key)) return;
  scheduledLogSanitizationFiles.add(key);
  writeQueue = writeQueue
    .then(async () => {
      await sanitizeLogFile(file);
      await sanitizeLogFile(`${file}.1`);
    })
    .catch(() => {
      recordLoggerWriteFailure();
      scheduledLogSanitizationFiles.delete(key);
    });
}

async function sanitizeLogFile(file) {
  const safe = await assertSafeTmpPath(file, {
    label: 'logging.file',
    requireFile: true,
  }).catch(e => {
    if (e?.code === 'TMP_PATH_MISSING') return null;
    throw e;
  });
  if (!safe) return;
  if (!safe.stat?.size) return;
  const originalEndsWithLineBreak = await logFileEndsWithLineBreak(safe.resolved, safe.stat.size);
  const temporaryFile = `${safe.resolved}.sanitize-${process.pid}-${Date.now()}-${process.hrtime.bigint().toString(36)}`;
  const temporarySafe = await assertSafeTmpPath(temporaryFile, {
    label: 'logging sanitization temp file',
    ensureParent: true,
  });
  let input = null;
  let inputClosed = null;
  let output = null;
  let outputLifecycle = null;
  let temporaryCreated = false;
  try {
    input = fs.createReadStream(safe.resolved, { encoding: 'utf-8' });
    inputClosed = once(input, 'close');
    inputClosed.catch(() => {});
    output = fs.createWriteStream(temporarySafe.resolved, { encoding: 'utf-8', flags: 'wx', mode: 0o600 });
    outputLifecycle = observeSanitizedLogOutput(output, error => input?.destroy(error));
    temporaryCreated = true;
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let previousLine = '';
    let hasPreviousLine = false;
    let changed = false;
    for await (const line of lines) {
      if (hasPreviousLine) {
        const sanitized = sanitizeSerializedLogLine(previousLine);
        changed ||= sanitized !== previousLine;
        await writeSanitizedLogChunk(output, `${sanitized}\n`, outputLifecycle);
      }
      previousLine = line;
      hasPreviousLine = true;
    }
    if (hasPreviousLine) {
      const sanitized = sanitizeSerializedLogLine(previousLine);
      changed ||= sanitized !== previousLine;
      await writeSanitizedLogChunk(output, `${sanitized}${originalEndsWithLineBreak ? '\n' : ''}`, outputLifecycle);
    }
    await inputClosed;
    await finishSanitizedLogOutput(output, outputLifecycle);
    output = null;
    outputLifecycle = null;
    if (!changed) return;
    const current = await assertSafeTmpPath(safe.resolved, { label: 'logging.file', requireFile: true });
    if (!sameLogFileSnapshot(safe.stat, current.stat)) return;
    await assertSafeTmpPath(temporarySafe.resolved, { label: 'logging sanitization temp file', requireFile: true });
    await renameAtomicWithRetry(temporarySafe.resolved, current.resolved);
    temporaryCreated = false;
  } finally {
    input?.destroy();
    await inputClosed?.catch(() => {});
    output?.destroy();
    await outputLifecycle?.closed.catch(() => {});
    if (temporaryCreated) await fsp.rm(temporarySafe.resolved, { force: true }).catch(() => {});
  }
}

async function logFileEndsWithLineBreak(file, size) {
  if (!size) return false;
  const handle = await fsp.open(file, 'r');
  try {
    const lastByte = Buffer.alloc(1);
    const { bytesRead } = await handle.read(lastByte, 0, 1, Math.max(0, size - 1));
    return bytesRead === 1 && (lastByte[0] === 10 || lastByte[0] === 13);
  } finally {
    await handle.close().catch(() => {});
  }
}

function observeSanitizedLogOutput(output, onError) {
  const closeEvent = new Promise(resolve => output.once('close', resolve));
  const closed = once(output, 'close').catch(() => closeEvent);
  const lifecycle = {
    closed,
    completion: finished(output),
    failure: null,
  };
  lifecycle.completion.catch(error => {
    lifecycle.failure ||= error;
    onError?.(lifecycle.failure);
  });
  return lifecycle;
}

async function writeSanitizedLogChunk(output, chunk, lifecycle) {
  if (lifecycle?.failure) throw lifecycle.failure;
  if (!output.write(chunk, 'utf-8')) {
    await Promise.race([once(output, 'drain'), lifecycle.completion]);
  }
  if (lifecycle?.failure) throw lifecycle.failure;
}

async function finishSanitizedLogOutput(output, lifecycle) {
  output.end();
  try {
    await lifecycle.completion;
  } finally {
    const { closed } = lifecycle;
    await closed;
  }
}

function sameLogFileSnapshot(before, after) {
  if (!before || !after) return false;
  return Number(before.size || 0) === Number(after.size || 0)
    && Number(before.mtimeMs || 0) === Number(after.mtimeMs || 0)
    && Number(before.ctimeMs || 0) === Number(after.ctimeMs || 0);
}

function sanitizeSerializedLogLine(line = '') {
  const text = String(line || '');
  if (!text.trim()) return text;
  const match = text.match(/^(\S+\s+\S+\s+\S+)(?:\s+(.+))?$/);
  if (!match?.[2]) return redactSecrets(text);
  const [, prefix, rawFields] = match;
  try {
    const parsed = JSON.parse(rawFields);
    const safeFields = stringifyFields(parsed);
    return safeFields ? `${prefix} ${safeFields}` : prefix;
  } catch {
    return `${prefix} ${redactSecrets(rawFields)}`;
  }
}

function stringifyFields(fields) {
  const safe = redactSecrets(JSON.stringify(trimValue(fields ?? {})));
  return safe === '{}' ? '' : safe;
}

function trimValue(value, depth = 0, key = '') {
  if (isSensitiveFieldKey(key)) return redactedFieldValue(key, value);
  if (depth > 4) return '[truncated]';
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  if (Array.isArray(value)) return value.slice(0, 30).map(item => trimValue(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, trimValue(child, depth + 1, childKey)]));
  }
  return value;
}

function isSensitiveFieldKey(key = '') {
  const normalized = String(key || '').trim().toLowerCase();
  if (isDiagnosticCountFieldKey(normalized)) return false;
  return SENSITIVE_FIELD_KEYS.has(normalized)
    || SENSITIVE_FIELD_SUFFIXES.some(suffix => normalized === suffix || normalized.endsWith(`_${suffix}`))
    || normalized.endsWith('_token')
    || normalized.includes('api_key')
    || normalized.includes('manual_key')
    || normalized === 'key'
    || normalized === 'raw_keys';
}

function isDiagnosticCountFieldKey(key = '') {
  const normalized = String(key || '').trim().toLowerCase();
  return /(?:^|_)(?:count|counts)$/.test(normalized);
}

function redactedFieldValue(key = '', value = null) {
  const normalized = String(key || '').trim().toLowerCase();
  if (normalized.includes('path') || normalized.includes('root') || normalized.includes('storage') || normalized === 'file_name' || normalized === 'command_line') {
    return '[redacted-path]';
  }
  if (Array.isArray(value)) return `[redacted-list:${value.length}]`;
  if (value && typeof value === 'object') return '[redacted-object]';
  return '[redacted]';
}

function cleanToken(value) {
  return String(value || 'event').replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 80);
}

function redactSecrets(text) {
  return String(text || '')
    .replace(/data:[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, '[redacted-data-url]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-[redacted]')
    .replace(/\b(?:[a-fA-F0-9]{192}|[a-fA-F0-9]{160}|[a-fA-F0-9]{128}|[a-fA-F0-9]{96}|[a-fA-F0-9]{64})\b/g, '[redacted-hex-secret]')
    .replace(/\bwxid_[a-z0-9_-]{3,}\b/gi, '[redacted-account]')
    .replace(/((?:旧)?微信账号目录|(?:旧)?账号目录|微信账号|账号|账户)「[^」\r\n]{1,120}」/g, '$1「[redacted-account]」')
    .replace(/(群聊|群|会话)「[^」\r\n]{1,160}」/g, '$1「[redacted-group]」')
    .replace(/[a-zA-Z]:\\\\[^"{}[\]]+/g, '[redacted-path]')
    .replace(/[a-zA-Z]:\\[^\r\n"{}[\]]+/g, '[redacted-path]')
    .replace(/[a-zA-Z]:\/[^\r\n"{}[\]]+/g, '[redacted-path]')
    .replace(new RegExp(escapeRegExp(PROJECT_ROOT), 'gi'), '<project>');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
