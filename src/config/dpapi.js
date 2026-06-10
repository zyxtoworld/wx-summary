import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

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
let winDpapi = null;

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

function runPowerShell(script, stdin, preferPwsh = true) {
  return new Promise((resolve, reject) => {
    const exe = preferPwsh ? 'pwsh' : 'powershell';
    const args = ['-NoProfile', '-NonInteractive', '-Command', script];
    const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let settled = false;
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      if (preferPwsh && error?.code === 'ENOENT') {
        runPowerShell(script, stdin, false).then(resolve, reject);
      } else {
        reject(error);
      }
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve(out);
      } else if (preferPwsh) {
        runPowerShell(script, stdin, false).then(resolve, reject);
      } else {
        reject(new Error((err || `PowerShell exited with ${code}`).trim()));
      }
    });
    child.stdin.end(stdin, 'utf-8');
  });
}

function runCommand(file, args, stdin = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(out);
      else reject(new Error((err || out || `${file} exited with ${code}`).trim()));
    });
    child.stdin.end(stdin, 'utf-8');
  });
}

async function getMacKeychainKey() {
  try {
    const existing = (await runCommand('security', [
      'find-generic-password',
      '-a', MAC_KEYCHAIN_ACCOUNT,
      '-s', MAC_KEYCHAIN_SERVICE,
      '-w',
    ])).trim();
    if (existing) return crypto.createHash('sha256').update(existing, 'utf-8').digest();
  } catch {}

  const secret = crypto.randomBytes(32).toString('base64url');
  await runCommand('security', [
    'add-generic-password',
    '-a', MAC_KEYCHAIN_ACCOUNT,
    '-s', MAC_KEYCHAIN_SERVICE,
    '-w', secret,
    '-U',
  ]);
  return crypto.createHash('sha256').update(secret, 'utf-8').digest();
}

async function protectTextMac(text) {
  const key = await getMacKeychainKey();
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
  const key = await getMacKeychainKey();
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

export async function unprotectToText(buffer) {
  if (process.platform === 'darwin') {
    return unprotectTextMac(buffer);
  }
  if (process.platform !== 'win32') {
    throw new Error('DPAPI is only available on Windows');
  }
  try {
    return await unprotectTextWin(buffer);
  } catch {
    return runPowerShell(UNPROTECT_SCRIPT, Buffer.from(buffer).toString('base64'));
  }
}
