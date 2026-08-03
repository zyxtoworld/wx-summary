import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WINDOWS_POWERSHELL_EXE = [
  path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
].find(file => {
  try { return fs.existsSync(file); } catch { return false; }
}) || '';

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? String(process.argv[idx + 1] || '') : fallback;
}

function repoPath(value) {
  return path.resolve(ROOT, value || '');
}

function powershellJson(command) {
  return new Promise((resolve, reject) => {
    if (!WINDOWS_POWERSHELL_EXE) {
      reject(new Error('trusted Windows PowerShell is unavailable'));
      return;
    }
    const child = spawn(WINDOWS_POWERSHELL_EXE, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => {
      if (code !== 0) {
        reject(new Error((stderr || stdout || `PowerShell exited with ${code}`).trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value)}\n`, 'utf-8');
  await fsp.rename(tmp, file);
}

function normalizeRows(text) {
  if (!text) return [];
  const parsed = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map(row => ({
    ProcessId: row.ProcessId,
    ExecutablePath: decodeB64(row.ExecutablePathB64),
    CommandLine: decodeB64(row.CommandLineB64),
  }));
}

function decodeB64(value) {
  if (!value) return '';
  return Buffer.from(String(value), 'base64').toString('utf-8');
}

function pickMainWeixin(rows) {
  const withPath = rows.filter(row => row?.ExecutablePath);
  return withPath.find(row => /Weixin\.exe/i.test(String(row.CommandLine || '')) && !/--type=/i.test(String(row.CommandLine || '')))
    || withPath[0]
    || null;
}

async function capture() {
  const outFile = repoPath(argValue('--out', 'data/prelaunch-weixin-binary.json'));
  const source = argValue('--source', 'cmd_pre_tray') || 'cmd_pre_tray';
  const capturedAt = new Date().toISOString();
  if (process.platform !== 'win32') {
    await writeJsonAtomic(outFile, { ok: false, source, captured_at: capturedAt, running: false, process_count: 0, reason: 'non_windows' });
    return;
  }
  try {
    const command = [
      "$ErrorActionPreference = 'SilentlyContinue';",
      "Get-CimInstance Win32_Process -Filter \"name = 'Weixin.exe'\"",
      "Select-Object ProcessId,@{n='ExecutablePathB64';e={[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$_.ExecutablePath))}},@{n='CommandLineB64';e={[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$_.CommandLine))}}",
      'ConvertTo-Json -Compress -Depth 4',
    ].join(' | ').replace('; |', ';');
    const rows = normalizeRows(await powershellJson(command));
    const main = pickMainWeixin(rows);
    const evidence = {
      ok: false,
      source,
      captured_at: capturedAt,
      running: rows.length > 0,
      process_count: rows.length,
    };
    if (main?.ExecutablePath) {
      const stat = await fsp.stat(main.ExecutablePath);
      evidence.ok = true;
      evidence.pid = Number(main.ProcessId);
      evidence.path = String(main.ExecutablePath);
      evidence.bytes = stat.size;
      evidence.modified_at = stat.mtime.toISOString();
      evidence.sha256 = await sha256File(main.ExecutablePath);
    } else {
      evidence.reason = 'weixin_not_found_or_no_main_path';
    }
    await writeJsonAtomic(outFile, evidence);
  } catch (e) {
    await writeJsonAtomic(outFile, {
      ok: false,
      source,
      captured_at: capturedAt,
      error: String(e?.message || e).slice(0, 500),
    });
  }
}

capture().catch(() => {
  process.exitCode = 0;
});
