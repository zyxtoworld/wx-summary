import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';

const source = await fsp.readFile(new URL('../src/wxdb/index.js', import.meta.url), 'utf8');
const lifecycleStart = source.indexOf('function createAbortableFileHandleLifecycle(');
const readHeaderStart = source.indexOf('async function readHeader(', lifecycleStart);
const sha256PrefixStart = source.indexOf('async function sha256Prefix(', readHeaderStart);
const sha256CopiedFileStart = source.indexOf('async function sha256CopiedFile(', sha256PrefixStart);
assert.ok(lifecycleStart >= 0 && readHeaderStart > lifecycleStart && sha256PrefixStart > readHeaderStart && sha256CopiedFileStart > sha256PrefixStart, 'wxdb copied-file readers must remain inspectable');
assert.match(
  source.slice(source.indexOf('async function copyDbFileLocked('), readHeaderStart),
  /await readHeader\(safeTarget\.resolved, \{ signal \}\)[\s\S]*?await sha256Prefix\(safeTarget\.resolved, \{ signal \}\)/,
  'the copied-file production caller must use both signal-aware readers',
);

const readerSource = source.slice(lifecycleStart, sha256CopiedFileStart);
const readerFsp = { open: fsp.open };
const { readHeader, sha256Prefix } = new Function(
  'Buffer',
  'crypto',
  'fsp',
  'assertCopiedDbRealPath',
  'throwIfAborted',
  `${readerSource}\nreturn { readHeader, sha256Prefix };`,
)(
  Buffer,
  crypto,
  readerFsp,
  async () => {},
  signal => {
    if (signal?.aborted) throw signal.reason;
  },
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function runReaderScenario(label, reader, { lateError = false } = {}) {
  const readOutcome = deferred();
  const closeOutcome = deferred();
  const readStarted = deferred();
  const closeObserved = deferred();
  const cancellation = Object.assign(new Error(`${label} caller cancelled`), { name: 'AbortError', status: 499 });
  const controller = new AbortController();
  let closeCalls = 0;
  const handle = {
    async read() {
      readStarted.resolve();
      return readOutcome.promise;
    },
    async close() {
      closeCalls += 1;
      closeObserved.resolve();
      await closeOutcome.promise;
    },
  };
  const originalOpen = readerFsp.open;
  readerFsp.open = async () => handle;
  try {
    const pending = reader('test.db', { signal: controller.signal, allow_external_test_db: true });
    let settled = false;
    const settledResult = pending.then(
      value => { settled = true; return { value }; },
      error => { settled = true; return { error }; },
    );
    await readStarted.promise;
    controller.abort(cancellation);
    await new Promise(resolve => setImmediate(resolve));
    const closeStartedBeforeReadSettles = closeCalls === 1;
    if (lateError) readOutcome.reject(new Error(`${label} late I/O error`));
    else readOutcome.resolve({ bytesRead: 0 });
    await closeObserved.promise;
    await new Promise(resolve => setImmediate(resolve));
    const settledBeforeClose = settled;
    closeOutcome.resolve();
    const result = await settledResult;
    assert.equal(closeStartedBeforeReadSettles, true, `${label} 取消必须在 read settle 前启动 close`);
    assert.equal(settledBeforeClose, false, `${label} close 未完成前不得 settle`);
    assert.equal(result.error, cancellation, `${label} 迟到结果必须投影原 caller cancellation`);
    assert.equal(closeCalls, 1, `${label} 取消只允许 close 一次`);
  } finally {
    readerFsp.open = originalOpen;
  }
}

async function runNormalScenario(label, reader) {
  const readOutcome = deferred();
  const closeOutcome = deferred();
  const readStarted = deferred();
  const closeObserved = deferred();
  let closeCalls = 0;
  const handle = {
    async read() {
      readStarted.resolve();
      return readOutcome.promise;
    },
    async close() {
      closeCalls += 1;
      closeObserved.resolve();
      await closeOutcome.promise;
    },
  };
  const originalOpen = readerFsp.open;
  readerFsp.open = async () => handle;
  try {
    const pending = reader('test.db', { allow_external_test_db: true });
    await readStarted.promise;
    readOutcome.resolve({ bytesRead: 0 });
    await closeObserved.promise;
    closeOutcome.resolve();
    const result = await pending;
    assert.ok(result, `${label} 正常 EOF 必须返回结果`);
    assert.equal(closeCalls, 1, `${label} 正常 EOF 必须恰好 close 一次`);
  } finally {
    readerFsp.open = originalOpen;
  }
}

async function runPostReadAbortScenario(label, reader, { closeError = null } = {}) {
  const readOutcome = deferred();
  const closeOutcome = deferred();
  const readStarted = deferred();
  const closeObserved = deferred();
  const cancellation = Object.assign(new Error(`${label} caller cancelled after read`), { name: 'AbortError', status: 499 });
  const controller = new AbortController();
  let closeCalls = 0;
  const handle = {
    async read() {
      readStarted.resolve();
      return readOutcome.promise;
    },
    async close() {
      closeCalls += 1;
      closeObserved.resolve();
      await closeOutcome.promise;
      if (closeError) throw closeError;
    },
  };
  const originalOpen = readerFsp.open;
  readerFsp.open = async () => handle;
  try {
    const pending = reader('test.db', { signal: controller.signal, allow_external_test_db: true });
    await readStarted.promise;
    readOutcome.resolve({ bytesRead: 0 });
    await closeObserved.promise;
    controller.abort(cancellation);
    closeOutcome.resolve();
    const result = await pending.then(value => ({ value }), error => ({ error }));
    assert.equal(result.error, cancellation, `${label} close pending 时取消必须投影原 caller cancellation`);
    assert.equal(closeCalls, 1, `${label} close pending 时取消不得重复关闭句柄`);
  } finally {
    readerFsp.open = originalOpen;
  }
}

for (const [label, reader] of [['readHeader', readHeader], ['sha256Prefix', sha256Prefix]]) {
  await runReaderScenario(label, reader);
  await runReaderScenario(label, reader, { lateError: true });
  await runNormalScenario(label, reader);
  await runPostReadAbortScenario(label, reader);
  await runPostReadAbortScenario(label, reader, { closeError: new Error(`${label} close failed late`) });
}

console.log('wxdb copied-file handle abort lifecycle tests passed');
