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

function runPowerShell(script, stdin, preferPwsh = true) {
  return new Promise((resolve, reject) => {
    const exe = preferPwsh ? 'pwsh' : 'powershell';
    const args = ['-NoProfile', '-NonInteractive', '-Command', script];
    const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', error => {
      if (preferPwsh && error?.code === 'ENOENT') {
        runPowerShell(script, stdin, false).then(resolve, reject);
      } else {
        reject(error);
      }
    });
    child.on('close', code => {
      if (code === 0) resolve(out);
      else reject(new Error((err || `PowerShell exited with ${code}`).trim()));
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

export async function protectText(text) {
  if (process.platform === 'darwin') {
    return protectTextMac(text);
  }
  if (process.platform !== 'win32') {
    throw new Error('DPAPI is only available on Windows');
  }
  const base64 = (await runPowerShell(PROTECT_SCRIPT, text)).trim();
  return Buffer.from(base64, 'base64');
}

export async function unprotectToText(buffer) {
  if (process.platform === 'darwin') {
    return unprotectTextMac(buffer);
  }
  if (process.platform !== 'win32') {
    throw new Error('DPAPI is only available on Windows');
  }
  return runPowerShell(UNPROTECT_SCRIPT, Buffer.from(buffer).toString('base64'));
}
