import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const runId = `${process.pid}-${Date.now()}`;
const dataDirRelative = `outputs/.tmp/startup-port-exhaustion-${runId}`;
const dataDir = path.join(root, dataDirRelative);
const runtimeTmp = path.join(dataDir, 'runtime-tmp');
const logFile = path.join(runtimeTmp, 'startup.log');
const lockFile = path.join(dataDir, 'wx-summary.lock');
const listeners = [];

async function listen(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

async function reserveCandidateRange() {
  for (let start = 24_000; start <= 54_000; start += 17) {
    const reserved = [];
    try {
      for (let offset = 0; offset < 10; offset += 1) reserved.push(await listen(start + offset));
      listeners.push(...reserved);
      return start;
    } catch {
      await Promise.all(reserved.map(server => new Promise(resolve => server.close(resolve))));
    }
  }
  throw new Error('unable to reserve ten consecutive local ports for startup failure test');
}

function runService(startPort) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/main.js', '--no-open', '--port', String(startPort)], {
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
      reject(new Error(`startup failure child timed out; stdout=${stdout}; stderr=${stderr}`));
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
  const startPort = await reserveCandidateRange();
  const result = await runService(startPort);
  assert.equal(result.signal, null, `startup failure must exit normally instead of being killed: ${result.stderr}`);
  assert.equal(result.code, 1, `port exhaustion must exit with code 1: ${result.stderr}`);
  assert.match(result.stderr, new RegExp(`端口 ${startPort}~${startPort + 9} 都被占用`));

  const log = await fsp.readFile(logFile, 'utf8');
  assert.match(log, /ERROR startup_failed/);
  assert.match(log, /"code":"startup_ports_unavailable"/);
  assert.match(log, new RegExp(`"first_port":${startPort}`));
  assert.match(log, new RegExp(`"last_port":${startPort + 9}`));
  assert.equal(await fsp.stat(lockFile).then(() => true, () => false), false, 'startup failure must release its instance lock');
} finally {
  await Promise.all(listeners.map(server => new Promise(resolve => server.close(resolve))));
  await fsp.rm(dataDir, { recursive: true, force: true });
}

console.log('startup port-exhaustion runtime test passed');
