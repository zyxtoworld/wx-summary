import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { attachWindowsProcessCleanup, terminateWindowsProcessTree } from '../lib/windows-process-tree.js';

const PROTECT_SCRIPT = `
Add-Type -AssemblyName System.Security
$inputText = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($inputText)
$enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($enc))
`;

const UNPROTECT_SCRIPT = `
Add-Type -AssemblyName System.Security
$inputText = [Console]::In.ReadToEnd()
$bytes = [Convert]::FromBase64String($inputText.Trim())
$dec = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($dec))
`;

const MAC_KEYCHAIN_SERVICE = 'wx-summary.secrets';
const MAC_KEYCHAIN_ACCOUNT = 'wx-summary';
const MAC_ENVELOPE_VERSION = 1;
const COMMAND_TIMEOUT_MS = 15000;
const COMMAND_OUTPUT_LIMIT = 1024 * 1024;
let winDpapi = null;
let macKeychainNative = null;

async function loadWinDpapi() {
  if (winDpapi) return winDpapi;
  const koffi = (await import('koffi')).default;
  const crypt32 = koffi.load('crypt32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  koffi.struct('WX_SUMMARY_DATA_BLOB', {
    cbData: 'uint32',
    pbData: 'void *',
  });
  winDpapi = {
    koffi,
    CryptProtectData: crypt32.func('bool __stdcall CryptProtectData(WX_SUMMARY_DATA_BLOB *pDataIn, const wchar_t *szDataDescr, WX_SUMMARY_DATA_BLOB *pOptionalEntropy, void *pvReserved, void *pPromptStruct, uint32 dwFlags, _Out_ WX_SUMMARY_DATA_BLOB *pDataOut)'),
    CryptUnprotectData: crypt32.func('bool __stdcall CryptUnprotectData(WX_SUMMARY_DATA_BLOB *pDataIn, _Out_ void **ppszDataDescr, WX_SUMMARY_DATA_BLOB *pOptionalEntropy, void *pvReserved, void *pPromptStruct, uint32 dwFlags, _Out_ WX_SUMMARY_DATA_BLOB *pDataOut)'),
    LocalFree: kernel32.func('void* __stdcall LocalFree(void*)'),
    GetLastError: kernel32.func('uint32 __stdcall GetLastError()'),
  };
  return winDpapi;
}

function dataBlobFromBuffer(buffer) {
  const bytes = Buffer.from(buffer || Buffer.alloc(0));
  return { cbData: bytes.length, pbData: bytes };
}

function bufferFromDataBlob(api, blob) {
  if (!blob?.pbData || !blob.cbData) return Buffer.alloc(0);
  return Buffer.from(api.koffi.decode(blob.pbData, 'uint8_t', blob.cbData));
}

function appendLimited(current, chunk) {
  const next = current + chunk;
  if (next.length > COMMAND_OUTPUT_LIMIT) return next.slice(0, COMMAND_OUTPUT_LIMIT);
  return next;
}

function windowsPowerShellExecutablePath() {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return [
    path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.join(root, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ].find(file => {
    try { return fs.existsSync(file); } catch { return false; }
  }) || '';
}

function runPowerShell(script, stdin, timeoutMs = COMMAND_TIMEOUT_MS, terminateProcessTree = terminateWindowsProcessTree) {
  return new Promise((resolve, reject) => {
    const exe = windowsPowerShellExecutablePath();
    if (!exe) {
      reject(new Error('trusted Windows PowerShell is unavailable'));
      return;
    }
    const args = ['-NoProfile', '-NonInteractive', '-Command', script];
    const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let settled = false;
    let out = '';
    let err = '';
    let timer = null;
    let childClosed = false;
    let terminationStarted = false;
    let terminationFailure = null;
    let terminationCleanup = null;
    let closeListenerAttached = false;
    let childErrorDrain = null;
    let stdinErrorDrain = null;

    const clearTimer = () => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    };
    const removeOutputListeners = () => {
      child.stdout?.removeListener?.('data', onStdoutData);
      child.stderr?.removeListener?.('data', onStderrData);
    };
    const removeErrorDrains = () => {
      if (childErrorDrain) child.removeListener?.('error', childErrorDrain);
      if (stdinErrorDrain) child.stdin?.removeListener?.('error', stdinErrorDrain);
      childErrorDrain = null;
      stdinErrorDrain = null;
    };
    const attachErrorDrain = (stream, handler) => {
      if (!stream) return false;
      try {
        if (typeof stream.on === 'function') {
          stream.on('error', handler);
          return true;
        }
        if (typeof stream.once === 'function') {
          stream.once('error', handler);
          return true;
        }
      } catch {}
      return false;
    };
    const installErrorDrains = () => {
      if (!childErrorDrain) {
        const drain = () => {};
        if (attachErrorDrain(child, drain)) childErrorDrain = drain;
      }
      if (!stdinErrorDrain) {
        const drain = () => {};
        if (attachErrorDrain(child.stdin, drain)) stdinErrorDrain = drain;
      }
    };
    const removeBusinessListeners = () => {
      removeOutputListeners();
      child.stdin?.removeListener?.('error', onStdinError);
      child.removeListener?.('error', onChildError);
    };
    const ensureCloseOwner = () => {
      if (closeListenerAttached || childClosed) return;
      try {
        child.on('close', onChildClose);
        closeListenerAttached = true;
      } catch {}
    };
    const cleanupTerminalListeners = ({ childEnded = childClosed } = {}) => {
      removeBusinessListeners();
      if (childEnded) {
        removeErrorDrains();
        if (closeListenerAttached) child.removeListener?.('close', onChildClose);
        closeListenerAttached = false;
      } else {
        installErrorDrains();
      }
    };
    const preserveCleanupError = (terminalError, cleanupError) => {
      if (!terminalError || (typeof terminalError !== 'object' && typeof terminalError !== 'function')) return;
      try {
        if (!terminalError.cause) terminalError.cause = cleanupError;
      } catch {}
    };
    const rememberTerminationFailure = detail => {
      if (terminationFailure) return;
      if (detail?.error) {
        terminationFailure = detail.error;
        return;
      }
      if (detail?.result === false) {
        const cleanupError = new Error(`${exe} child kill returned false`);
        cleanupError.code = 'CHILD_KILL_FAILED';
        terminationFailure = cleanupError;
      }
    };
    const settle = (kind, value, { childEnded = childClosed } = {}) => {
      if (settled) return false;
      settled = true;
      clearTimer();
      cleanupTerminalListeners({ childEnded });
      if (kind === 'resolve') resolve(value);
      else reject(value);
      return true;
    };
    const attachTerminationEvidence = (terminalError, termination) => {
      if (terminationFailure) preserveCleanupError(terminalError, terminationFailure);
      if (!termination || typeof termination !== 'object') return;
      try { terminalError.cleanup_confirmed = termination.terminated === true; } catch {}
      if (termination.terminated !== true && termination.cleanup?.then) {
        terminationCleanup = termination.cleanup;
        attachWindowsProcessCleanup(terminalError, termination.cleanup);
        void Promise.resolve(termination.cleanup).then(() => {
          if (settled && childClosed) cleanupTerminalListeners({ childEnded: true });
        }, () => {});
      }
    };
    const beginTermination = error => {
      if (settled || terminationStarted) return terminationCleanup;
      terminationStarted = true;
      clearTimer();
      ensureCloseOwner();
      removeBusinessListeners();
      installErrorDrains();
      terminationCleanup = Promise.resolve().then(() => terminateProcessTree(child, {
        isClosed: () => childClosed,
        retryMs: 1000,
        pollMs: 25,
        responseWaitMs: 5000,
        onKillAttempt: rememberTerminationFailure,
      })).then(termination => {
        attachTerminationEvidence(error, termination);
        settle('reject', error, { childEnded: childClosed });
      }).catch(cleanupError => {
        preserveCleanupError(error, cleanupError);
        settle('reject', error, { childEnded: childClosed });
      });
      return terminationCleanup;
    };
    const onStdoutData = chunk => { out = appendLimited(out, chunk); };
    const onStderrData = chunk => { err = appendLimited(err, chunk); };
    const onStdinError = error => {
      beginTermination(error);
    };
    const onChildError = error => {
      beginTermination(error);
    };
    const onChildClose = code => {
      childClosed = true;
      if (terminationStarted) {
        cleanupTerminalListeners({ childEnded: true });
        return;
      }
      if (!settled) {
        if (code === 0) settle('resolve', out, { childEnded: true });
        else settle('reject', new Error((err || `PowerShell exited with ${code}`).trim()), { childEnded: true });
      } else {
        cleanupTerminalListeners({ childEnded: true });
      }
    };
    const onTimeout = () => {
      const timeoutError = new Error(`${exe} timed out after ${timeoutMs}ms`);
      beginTermination(timeoutError);
    };

    try {
      timer = setTimeout(onTimeout, timeoutMs);
      child.on('error', onChildError);
      ensureCloseOwner();
      child.stdout.setEncoding('utf-8');
      child.stderr.setEncoding('utf-8');
      child.stdout.on('data', onStdoutData);
      child.stderr.on('data', onStderrData);
      child.stdin.on('error', onStdinError);
      child.stdin.end(stdin, 'utf-8');
    } catch (error) {
      beginTermination(error);
    }
  });
}

function macKeychainStatusError(action = 'Keychain operation', status = 0) {
  const error = new Error(`${action} failed with OSStatus ${Number(status) || 0}`);
  error.mac_keychain_status = Number(status) || 0;
  return error;
}

function macKeychainItemMissing(error = null) {
  return Number(error?.mac_keychain_status) === -25300;
}

function macKeychainItemDuplicate(error = null) {
  return Number(error?.mac_keychain_status) === -25299;
}

function markSecretProtectionUnavailable(error, code = 'SECRET_PROTECTION_UNAVAILABLE') {
  const out = error instanceof Error ? error : new Error(String(error || 'secret protection provider unavailable'));
  out.secret_protection_code = code;
  out.secret_protection_unavailable = true;
  out.preserve_encrypted_file = true;
  return out;
}

function markMacKeychainUnavailable(error, code = 'MAC_KEYCHAIN_UNAVAILABLE') {
  return markSecretProtectionUnavailable(error, code);
}

async function loadMacKeychainNative() {
  if (macKeychainNative) return macKeychainNative;
  const koffi = (await import('koffi')).default;
  const security = koffi.load('/System/Library/Frameworks/Security.framework/Security');
  macKeychainNative = {
    koffi,
    SecKeychainFindGenericPassword: security.func('int SecKeychainFindGenericPassword(void *keychainOrArray, uint32_t serviceNameLength, const char *serviceName, uint32_t accountNameLength, const char *accountName, _Out_ uint32_t *passwordLength, _Out_ void **passwordData, void **itemRef)'),
    SecKeychainAddGenericPassword: security.func('int SecKeychainAddGenericPassword(void *keychain, uint32_t serviceNameLength, const char *serviceName, uint32_t accountNameLength, const char *accountName, uint32_t passwordLength, const void *passwordData, void **itemRef)'),
    SecKeychainItemFreeContent: security.func('int SecKeychainItemFreeContent(void *attrList, void *data)'),
  };
  return macKeychainNative;
}

async function findMacKeychainSecret() {
  const service = Buffer.from(MAC_KEYCHAIN_SERVICE, 'utf-8');
  const account = Buffer.from(MAC_KEYCHAIN_ACCOUNT, 'utf-8');
  try {
    const api = await loadMacKeychainNative();
    const passwordLength = [0];
    const passwordData = [null];
    const status = api.SecKeychainFindGenericPassword(
      null,
      service.length,
      service,
      account.length,
      account,
      passwordLength,
      passwordData,
      null,
    );
    if (status !== 0) throw macKeychainStatusError('macOS Keychain read', status);
    let existing = '';
    try {
      const byteLength = Math.max(0, Number(passwordLength[0] || 0) || 0);
      if (passwordData[0] && byteLength) {
        existing = Buffer.from(api.koffi.decode(passwordData[0], 'uint8_t', byteLength)).toString('utf-8');
      }
    } finally {
      if (passwordData[0]) api.SecKeychainItemFreeContent(null, passwordData[0]);
    }
    if (!existing) throw markMacKeychainUnavailable(new Error('macOS Keychain wrapping key is empty'), 'MAC_KEYCHAIN_KEY_EMPTY');
    return existing;
  } catch (error) {
    if (macKeychainItemMissing(error)) return '';
    throw markMacKeychainUnavailable(error);
  }
}

async function getMacKeychainKey({ createIfMissing = false } = {}) {
  const existing = await findMacKeychainSecret();
  if (existing) return crypto.createHash('sha256').update(existing, 'utf-8').digest();
  if (!createIfMissing) {
    throw markMacKeychainUnavailable(new Error('macOS Keychain wrapping key is missing'), 'MAC_KEYCHAIN_KEY_MISSING');
  }

  const secret = crypto.randomBytes(32);
  const service = Buffer.from(MAC_KEYCHAIN_SERVICE, 'utf-8');
  const account = Buffer.from(MAC_KEYCHAIN_ACCOUNT, 'utf-8');
  try {
    const api = await loadMacKeychainNative();
    const status = api.SecKeychainAddGenericPassword(
      null,
      service.length,
      service,
      account.length,
      account,
      secret.length,
      secret,
      null,
    );
    if (status !== 0) throw macKeychainStatusError('macOS Keychain write', status);
  } catch (error) {
    if (macKeychainItemDuplicate(error)) {
      const raced = await findMacKeychainSecret();
      if (raced) return crypto.createHash('sha256').update(raced, 'utf-8').digest();
    }
    throw markMacKeychainUnavailable(error);
  }
  return crypto.createHash('sha256').update(secret).digest();
}

async function protectTextMac(text) {
  const key = await getMacKeychainKey({ createIfMissing: true });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(text), 'utf-8'), cipher.final()]);
  const envelope = {
    version: MAC_ENVELOPE_VERSION,
    platform: 'darwin-keychain',
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
  return Buffer.from(JSON.stringify(envelope), 'utf-8');
}

async function unprotectTextMac(buffer) {
  const envelope = JSON.parse(Buffer.from(buffer).toString('utf-8'));
  if (envelope?.version !== MAC_ENVELOPE_VERSION || envelope?.platform !== 'darwin-keychain' || envelope?.alg !== 'aes-256-gcm') {
    throw new Error('unsupported macOS secret envelope');
  }
  const key = await getMacKeychainKey({ createIfMissing: false });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv || '', 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag || '', 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.data || '', 'base64')),
    decipher.final(),
  ]).toString('utf-8');
}

async function protectTextWin(text) {
  const api = await loadWinDpapi();
  const input = Buffer.from(String(text || ''), 'utf-8');
  const out = {};
  const ok = api.CryptProtectData(dataBlobFromBuffer(input), null, null, null, null, 0, out);
  if (!ok) throw new Error(`CryptProtectData failed with ${api.GetLastError()}`);
  try {
    return bufferFromDataBlob(api, out);
  } finally {
    if (out.pbData) api.LocalFree(out.pbData);
  }
}

async function unprotectTextWin(buffer) {
  const api = await loadWinDpapi();
  const input = Buffer.from(buffer || Buffer.alloc(0));
  const out = {};
  const description = [null];
  const ok = api.CryptUnprotectData(dataBlobFromBuffer(input), description, null, null, null, 0, out);
  if (!ok) throw new Error(`CryptUnprotectData failed with ${api.GetLastError()}`);
  try {
    return bufferFromDataBlob(api, out).toString('utf-8');
  } finally {
    if (out.pbData) api.LocalFree(out.pbData);
    if (description[0]) api.LocalFree(description[0]);
  }
}

export async function protectText(text) {
  if (process.platform === 'darwin') {
    return protectTextMac(text);
  }
  if (process.platform !== 'win32') {
    throw new Error('DPAPI is only available on Windows');
  }
  try {
    return await protectTextWin(text);
  } catch {
    const base64 = (await runPowerShell(PROTECT_SCRIPT, text)).trim();
    return Buffer.from(base64, 'base64');
  }
}

export function secretProtectionUnavailable(error = null) {
  return error?.secret_protection_unavailable === true || error?.preserve_encrypted_file === true;
}

export async function unprotectToText(buffer) {
  if (process.platform === 'darwin') {
    return unprotectTextMac(buffer);
  }
  if (process.platform !== 'win32') {
    throw markSecretProtectionUnavailable(new Error('DPAPI is only available on Windows'), 'SECRET_PROTECTION_PLATFORM_UNAVAILABLE');
  }
  let nativeError = null;
  try {
    return await unprotectTextWin(buffer);
  } catch (error) {
    nativeError = error;
  }
  try {
    return await runPowerShell(UNPROTECT_SCRIPT, Buffer.from(buffer).toString('base64'));
  } catch (fallbackError) {
    const error = markSecretProtectionUnavailable(
      new Error('Windows DPAPI is temporarily unavailable or could not decrypt the preserved secret file.'),
      'WINDOWS_DPAPI_UNAVAILABLE',
    );
    error.native_error = nativeError?.message || String(nativeError || '');
    error.fallback_error = fallbackError?.message || String(fallbackError || '');
    error.cause = fallbackError;
    throw error;
  }
}
