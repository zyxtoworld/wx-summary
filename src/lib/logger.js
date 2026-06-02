import fsp from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT, TMP_DIR, resolveInsideTmp } from './paths.js';
import { ensureDir } from './json-store.js';

const DEFAULT_LOG_FILE = path.join(TMP_DIR, 'wx-summary.log');
const LEVELS = new Map([['debug', 10], ['info', 20], ['warn', 30], ['error', 40]]);

let targetFile = DEFAULT_LOG_FILE;
let maxBytes = 50 * 1024 * 1024;
let minLevel = 'info';
let writeQueue = Promise.resolve();

export function configureLogger(logging = {}) {
  minLevel = LEVELS.has(logging.level) ? logging.level : 'info';
  maxBytes = Math.max(1, Math.min(500, Number(logging.max_mb || 50))) * 1024 * 1024;
  try {
    targetFile = resolveInsideTmp(logging.file || './outputs/.tmp/wx-summary.log', 'logging.file');
  } catch {
    targetFile = DEFAULT_LOG_FILE;
  }
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

export async function readLogTail(maxLines = 200) {
  const text = await fsp.readFile(targetFile, 'utf-8').catch(() => '');
  return text.split(/\r?\n/).filter(Boolean).slice(-maxLines);
}

function writeLog(level, event, fields) {
  if ((LEVELS.get(level) || 99) < (LEVELS.get(minLevel) || 20)) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${cleanToken(event)} ${stringifyFields(fields)}\n`;
  writeQueue = writeQueue
    .then(async () => {
      await ensureDir(path.dirname(targetFile));
      await rotateIfNeeded(Buffer.byteLength(line));
      await fsp.appendFile(targetFile, line, 'utf-8');
    })
    .catch(() => {});
}

async function rotateIfNeeded(incomingBytes) {
  const stat = await fsp.stat(targetFile).catch(() => null);
  if (!stat || stat.size + incomingBytes <= maxBytes) return;
  const oldFile = `${targetFile}.1`;
  await fsp.rm(oldFile, { force: true }).catch(() => {});
  await fsp.rename(targetFile, oldFile).catch(() => {});
}

function stringifyFields(fields) {
  const safe = redactSecrets(JSON.stringify(trimValue(fields ?? {})));
  return safe === '{}' ? '' : safe;
}

function trimValue(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  if (Array.isArray(value)) return value.slice(0, 30).map(item => trimValue(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, trimValue(child, depth + 1)]));
  }
  return value;
}

function cleanToken(value) {
  return String(value || 'event').replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 80);
}

function redactSecrets(text) {
  return String(text || '')
    .replace(/data:[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, '[redacted-data-url]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-[redacted]')
    .replace(/\b(?:[a-fA-F0-9]{96}|[a-fA-F0-9]{64})\b/g, '[redacted-hex-secret]')
    .replace(new RegExp(escapeRegExp(PROJECT_ROOT), 'gi'), '<project>');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
