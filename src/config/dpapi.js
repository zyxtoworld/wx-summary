import { spawn } from 'node:child_process';

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

export async function protectText(text) {
  if (process.platform !== 'win32') {
    throw new Error('DPAPI is only available on Windows');
  }
  const base64 = (await runPowerShell(PROTECT_SCRIPT, text)).trim();
  return Buffer.from(base64, 'base64');
}

export async function unprotectToText(buffer) {
  if (process.platform !== 'win32') {
    throw new Error('DPAPI is only available on Windows');
  }
  return runPowerShell(UNPROTECT_SCRIPT, Buffer.from(buffer).toString('base64'));
}
