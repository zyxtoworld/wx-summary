import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await fsp.readFile(path.join(root, 'src', 'wxdb', 'message-worker.js'), 'utf8');
const start = source.indexOf('function sendWorkerMessage(');
const end = source.indexOf('\nfunction shutdownWorker', start);
assert.ok(start >= 0 && end > start, '生产 message-worker 必须保留可执行 sendWorkerMessage seam');
const sendWorkerMessageSource = source.slice(start, end).trim();

function makeWorkerSend(processLike, shutdownCalls) {
  const shutdownWorker = exitCode => {
    shutdownCalls.push(exitCode);
    return Promise.resolve();
  };
  return new Function('persistentWorker', 'shutdownWorker', 'process', `return (${sendWorkerMessageSource});`)(
    false,
    shutdownWorker,
    processLike,
  );
}

const synchronousFailureCalls = [];
const synchronousFailure = makeWorkerSend({
  connected: true,
  send() {
    throw Object.assign(new Error('IPC channel closed during send'), { code: 'ERR_IPC_CHANNEL_CLOSED' });
  },
}, synchronousFailureCalls);
assert.doesNotThrow(
  () => synchronousFailure({ type: 'result', request_id: 'r-sync' }, { exitCode: 0 }),
  'parent disconnect racing the connected check must not escape as an uncaught worker error',
);
assert.deepEqual(synchronousFailureCalls, [0], 'a terminal synchronous IPC failure must enter the one shutdown owner');

const progressFailureCalls = [];
const progressFailure = makeWorkerSend({
  connected: true,
  send() {
    throw Object.assign(new Error('IPC channel closed during progress'), { code: 'ERR_IPC_CHANNEL_CLOSED' });
  },
}, progressFailureCalls);
assert.doesNotThrow(
  () => progressFailure({ type: 'progress', request_id: 'r-progress' }),
  'a progress send racing disconnect must not crash the worker before disconnect cleanup runs',
);
assert.deepEqual(progressFailureCalls, [1], 'a synchronous progress IPC failure must still request worker shutdown');

const callbackFailureCalls = [];
let callback = null;
const callbackFailure = makeWorkerSend({
  connected: true,
  send(_message, next) {
    callback = next;
  },
}, callbackFailureCalls);
callbackFailure({ type: 'error', request_id: 'r-callback' }, { exitCode: 1 });
callback(Object.assign(new Error('late IPC callback failure'), { code: 'ERR_IPC_CHANNEL_CLOSED' }));
assert.deepEqual(callbackFailureCalls, [1], 'asynchronous IPC callback failure must retain existing terminal shutdown behavior');

console.log('wxdb message worker send race tests passed');
