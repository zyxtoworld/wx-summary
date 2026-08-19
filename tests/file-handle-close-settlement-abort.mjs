import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import vm from 'node:vm';

const loggerSource = await fsp.readFile(new URL('../src/lib/logger.js', import.meta.url), 'utf8');
const loggerStart = loggerSource.indexOf('export async function readLogFileTail(');
const loggerAbortStart = loggerSource.indexOf('\nfunction throwIfLogReadAborted(', loggerStart);
const loggerWriteStart = loggerSource.indexOf('\nfunction writeLog(', loggerAbortStart);
assert.ok(loggerStart >= 0 && loggerAbortStart > loggerStart && loggerWriteStart > loggerAbortStart, 'logger reader source must remain inspectable');

const wxdbSource = await fsp.readFile(new URL('../src/wxdb/index.js', import.meta.url), 'utf8');
const lifecycleStart = wxdbSource.indexOf('function createAbortableFileHandleLifecycle(');
const readHeaderStart = wxdbSource.indexOf('async function readHeader(', lifecycleStart);
assert.ok(lifecycleStart >= 0 && readHeaderStart > lifecycleStart, 'wxdb file-handle lifecycle source must remain inspectable');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function loadLoggerReader({ signal, handle }) {
  const sandbox = {
    Buffer,
    Error,
    LOG_TAIL_MAX_BYTES: 1024 * 1024,
    targetFile: 'test.log',
    assertSafeTmpPath: async () => ({
      resolved: 'test.log',
      stat: { size: 32 },
    }),
    fsp: {
      stat: async () => ({ size: 32 }),
      open: async () => handle,
    },
  };
  const executableSource = loggerSource
    .slice(loggerStart, loggerWriteStart)
    .replace('export async function readLogFileTail(', 'async function readLogFileTail(');
  vm.runInNewContext(`${executableSource}\nglobalThis.__readLogFileTail = readLogFileTail;`, sandbox, { timeout: 1000 });
  return sandbox.__readLogFileTail('test.log', 10, { signal });
}

{
  const closeGate = deferred();
  const closeStarted = deferred();
  const controller = new AbortController();
  const cancellation = Object.assign(new Error('logger close-settlement cancellation'), { status: 499 });
  const signal = {
    get aborted() { return controller.signal.aborted; },
    get reason() { return controller.signal.reason; },
    addEventListener(...args) { return controller.signal.addEventListener(...args); },
    removeEventListener(...args) {
      const result = controller.signal.removeEventListener(...args);
      // Inject the caller abort in the exact post-inner-finally / outer-finally
      // gap. The real contract must still inspect the signal before settling.
      queueMicrotask(() => controller.abort(cancellation));
      return result;
    },
  };
  let closeCalls = 0;
  const handle = {
    async read() {
      return { bytesRead: 0 };
    },
    async close() {
      closeCalls += 1;
      closeStarted.resolve();
      await closeGate.promise;
    },
  };
  const pending = loadLoggerReader({ signal, handle });
  await closeStarted.promise;
  closeGate.resolve();
  await assert.rejects(pending, error => error === cancellation, 'logger must project abort in the final settlement window');
  assert.equal(closeCalls, 1, 'logger settlement-window cancellation must not close twice');
}

const lifecycleSource = wxdbSource.slice(lifecycleStart, readHeaderStart);
const { withAbortableFileHandle } = new Function(
  'throwIfAborted',
  `'use strict';\n${lifecycleSource}\nreturn { withAbortableFileHandle };`,
)(signal => {
  if (signal?.aborted) throw signal.reason;
});

async function runWxDbScenario({ closeError = null } = {}) {
  const closeGate = deferred();
  const closeStarted = deferred();
  const controller = new AbortController();
  const cancellation = Object.assign(new Error('wxdb close-settlement cancellation'), { status: 499 });
  let closeCalls = 0;
  const handle = {
    async close() {
      closeCalls += 1;
      closeStarted.resolve();
      await closeGate.promise;
      if (closeError) throw closeError;
    },
  };
  const pending = withAbortableFileHandle(handle, controller.signal, async () => 'operation-result');
  await closeStarted.promise;
  controller.abort(cancellation);
  closeGate.resolve();
  await assert.rejects(pending, error => error === cancellation, 'wxdb must project abort after successful operation while close is pending');
  assert.equal(closeCalls, 1, 'wxdb close-settlement cancellation must not close twice');
}

async function runOperationErrorPriorityScenario() {
  const operationError = new Error('wxdb operation failed');
  const closeError = new Error('wxdb close failed after operation error');
  let closeCalls = 0;
  const pending = withAbortableFileHandle({
    async close() {
      closeCalls += 1;
      throw closeError;
    },
  }, null, async () => {
    throw operationError;
  });
  await assert.rejects(
    pending,
    error => error === operationError && error.cleanup_cause === closeError,
    'operation error must remain primary while close failure is attached diagnostically',
  );
  assert.equal(closeCalls, 1, 'operation/close failure must close exactly once');
}

async function runCloseErrorPrimaryScenario() {
  const closeError = new Error('wxdb close failed after success');
  let closeCalls = 0;
  const pending = withAbortableFileHandle({
    async close() {
      closeCalls += 1;
      throw closeError;
    },
  }, null, async () => 'operation-result');
  await assert.rejects(
    pending,
    error => error === closeError,
    'close failure must be primary when the operation succeeds',
  );
  assert.equal(closeCalls, 1, 'successful operation/close failure must close exactly once');
}

async function runFrozenOperationErrorScenario() {
  const operationError = Object.freeze(new Error('frozen wxdb operation failed'));
  const closeError = new Error('wxdb close failed after frozen operation error');
  let closeCalls = 0;
  const pending = withAbortableFileHandle({
    async close() {
      closeCalls += 1;
      throw closeError;
    },
  }, null, async () => {
    throw operationError;
  });
  await assert.rejects(
    pending,
    error => error === operationError,
    'cleanup diagnostics must not replace a frozen operation error',
  );
  assert.equal(closeCalls, 1, 'frozen operation/close failure must close exactly once');
}

await runWxDbScenario();
await runWxDbScenario({ closeError: new Error('late close failure') });
await runOperationErrorPriorityScenario();
await runCloseErrorPrimaryScenario();
await runFrozenOperationErrorScenario();

console.log('file-handle close-settlement abort tests passed');
