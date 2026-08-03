import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import vm from 'node:vm';

const source = await fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const start = source.indexOf('function windowsLocalActionPowerShellProbe(');
const end = source.indexOf('\nconst LOCAL_ACTION_NON_RETRYABLE_STATUSES', start);
assert.ok(start >= 0 && end > start, 'Windows local action probe must be inspectable');

class FakeStream extends EventEmitter {
  setEncoding() {}
}

const children = [];
const cleanupResolvers = [];
const timers = new Map();
let nextTimer = 0;
let terminateCalls = 0;

const sandbox = vm.createContext({
  AbortController,
  Buffer,
  Error,
  Promise,
  process: { platform: 'win32' },
  LOCAL_ACTION_FUNCTIONAL_PROBE_TIMEOUT_MS: 1000,
  LOCAL_ACTION_COMMAND_CHECK_TIMEOUT_MS: 1000,
  windowsSystemCommandPath: () => 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  windowsActiveDesktopSessionPowerShellPreamble: () => '$session = 1',
  requestAbortError(message) {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
  },
  sanitizeLocalActionUserError: value => String(value || ''),
  spawn() {
    const child = new EventEmitter();
    child.pid = 4000 + children.length;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new FakeStream();
    child.stderr = new FakeStream();
    child.kill = () => { throw new Error('probe must use process-tree termination'); };
    children.push(child);
    return child;
  },
  async terminateWindowsProcessTree(child, { isClosed }) {
    terminateCalls += 1;
    assert.equal(isClosed(), false);
    let resolveCleanup;
    const cleanup = new Promise(resolve => { resolveCleanup = resolve; });
    cleanupResolvers.push({ child, resolveCleanup, isClosed });
    return { pid: child.pid, terminated: false, cleanup };
  },
  setTimeout(callback) {
    const id = ++nextTimer;
    timers.set(id, callback);
    return id;
  },
  clearTimeout(id) {
    timers.delete(id);
  },
});

vm.runInContext(`${source.slice(start, end)}\nglobalThis.__probe = windowsLocalActionPowerShellProbe;`, sandbox, { timeout: 1000 });

let timeoutSettled = false;
const timeoutProbe = sandbox.__probe({ timeoutMs: 1000 }).then(value => {
  timeoutSettled = true;
  return value;
});
timers.get(nextTimer)();
await new Promise(resolve => setImmediate(resolve));
assert.equal(terminateCalls, 1);
assert.equal(timeoutSettled, false, 'timeout must not settle while process-tree cleanup is pending');

cleanupResolvers[0].resolveCleanup();
await new Promise(resolve => setImmediate(resolve));
assert.equal(timeoutSettled, false, 'timeout must not settle before the child close boundary');
children[0].exitCode = 1;
children[0].emit('close', 1);
assert.equal((await timeoutProbe).status, 'functional_probe_timeout');
assert.equal(cleanupResolvers[0].isClosed(), true);

const controller = new AbortController();
let abortSettled = false;
const abortedProbe = sandbox.__probe({ signal: controller.signal, timeoutMs: 1000 }).catch(error => {
  abortSettled = true;
  return error;
});
controller.abort(sandbox.requestAbortError('service shutdown'));
await new Promise(resolve => setImmediate(resolve));
assert.equal(terminateCalls, 2);
assert.equal(abortSettled, false, 'abort must wait for process-tree cleanup');
cleanupResolvers[1].resolveCleanup();
children[1].signalCode = 'SIGKILL';
children[1].emit('close', null, 'SIGKILL');
const abortError = await abortedProbe;
assert.equal(abortError.name, 'AbortError');
assert.match(abortError.message, /service shutdown/);

console.log('Windows local action probe termination tests passed');
