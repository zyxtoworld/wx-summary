import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const runId = `${process.pid}-${Date.now()}`;
const dataDirRelative = `outputs/.tmp/startup-prelogger-failure-${runId}`;
const dataDir = path.join(root, dataDirRelative);
const runtimeTmp = path.join(dataDir, 'runtime-tmp');
const requestedLogFile = path.join(runtimeTmp, 'startup.log');
const defaultLogFile = path.join(runtimeTmp, 'wx-summary.log');
const lockFile = path.join(dataDir, 'wx-summary.lock');

function runService() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/main.js', '--no-open'], {
      cwd: root,
      env: {
        ...process.env,
        WX_SUMMARY_ACCEPTANCE_MODE: '1',
        WX_SUMMARY_ACCEPTANCE_DATA_DIR: dataDirRelative,
        WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR: `${dataDirRelative}/runtime-tmp/wxdb`,
        WX_SUMMARY_LOG_FILE: `${dataDirRelative}/runtime-tmp/startup.log`,
        WX_SUMMARY_NO_RUNTIME_FILE: '1',
        WX_SUMMARY_SKIP_TMP_CLEAR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`pre-logger startup failure child timed out; stdout=${stdout}; stderr=${stderr}`));
    }, 30_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

try {
  await fsp.mkdir(runtimeTmp, { recursive: true });
  await fsp.writeFile(lockFile, JSON.stringify({
    pid: process.pid,
    lock_token: 'parent-owned-startup-lock',
    started_at: new Date().toISOString(),
    project_root: root,
  }), 'utf8');

  const result = await runService();
  assert.equal(result.signal, null, `startup failure must exit normally instead of being killed: ${result.stderr}`);
  assert.equal(result.code, 1, `startup ownership failure must exit with code 1: ${result.stderr}`);
  assert.match(result.stderr, /另一个 wx-summary 实例正在启动/);

  const requestedLog = await fsp.readFile(requestedLogFile, 'utf8');
  assert.match(requestedLog, /ERROR startup_failed/);
  assert.match(requestedLog, /另一个 wx-summary 实例正在启动/);
  assert.equal(
    await fsp.stat(defaultLogFile).then(() => true, () => false),
    false,
    'an early startup failure must honor the requested runtime log instead of silently falling back to wx-summary.log',
  );
  assert.equal(await fsp.stat(lockFile).then(() => true, () => false), true, 'a failed contender must not delete another process lock');
} finally {
  await fsp.rm(dataDir, { recursive: true, force: true });
}

console.log('startup pre-logger failure runtime test passed');
