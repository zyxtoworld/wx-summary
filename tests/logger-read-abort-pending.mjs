import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import vm from 'node:vm';

const source = await fsp.readFile(new URL('../src/lib/logger.js', import.meta.url), 'utf8');
const readStart = source.indexOf('export async function readLogFileTail(');
const readEnd = source.indexOf('\nfunction throwIfLogReadAborted(', readStart);
const abortEnd = source.indexOf('\nfunction writeLog(', readEnd);
assert.ok(readStart >= 0 && readEnd > readStart && abortEnd > readEnd, 'logger tail reader source must be inspectable');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function closeObservedByNextTurn(fixture) {
  return Promise.race([
    fixture.closeObserved.then(() => true),
    new Promise(resolve => setImmediate(() => resolve(false))),
  ]);
}

async function loadReader({ readOutcome, closeOutcome = null, closeError = null }) {
  const readStarted = deferred();
  const closeObserved = deferred();
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
      if (closeOutcome) await closeOutcome.promise;
      if (closeError) throw closeError;
    },
  };
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
  const executableSource = source
    .slice(readStart, abortEnd)
    .replace('export async function readLogFileTail(', 'async function readLogFileTail(');
  vm.runInNewContext(`${executableSource}\nglobalThis.__readLogFileTail = readLogFileTail;`, sandbox, { timeout: 1000 });
  return {
    controller,
    read: sandbox.__readLogFileTail('test.log', 10, { signal: controller.signal }),
    readStarted: readStarted.promise,
    closeObserved: closeObserved.promise,
    get closeCalls() { return closeCalls; },
  };
}

{
  const readOutcome = deferred();
  const closeOutcome = deferred();
  const fixture = await loadReader({ readOutcome, closeOutcome });
  const cancellation = Object.assign(new Error('日志读取已取消。'), { status: 499 });
  const read = fixture.read;
  await fixture.readStarted;
  readOutcome.resolve({ bytesRead: 0 });
  await fixture.closeObserved;
  fixture.controller.abort(cancellation);
  closeOutcome.resolve();
  await assert.rejects(read, error => error === cancellation, '读已成功但 close 挂起期间取消仍必须投影原取消原因');
  assert.equal(fixture.closeCalls, 1, '成功读后的取消不得重复关闭句柄');
}

{
  const readOutcome = deferred();
  const closeOutcome = deferred();
  const fixture = await loadReader({
    readOutcome,
    closeOutcome,
    closeError: new Error('底层 close 迟到失败'),
  });
  const cancellation = Object.assign(new Error('日志读取已取消。'), { status: 499 });
  const read = fixture.read;
  await fixture.readStarted;
  readOutcome.resolve({ bytesRead: 0 });
  await fixture.closeObserved;
  fixture.controller.abort(cancellation);
  closeOutcome.resolve();
  await assert.rejects(read, error => error === cancellation, 'close 失败与取消同时发生时必须优先投影原取消原因');
  assert.equal(fixture.closeCalls, 1, 'close 失败后的取消不得重复关闭句柄');
}

{
  const readOutcome = deferred();
  const fixture = await loadReader({ readOutcome });
  const cancellation = Object.assign(new Error('日志读取已取消。'), { status: 499 });
  const read = fixture.read;
  await fixture.readStarted;
  fixture.controller.abort(cancellation);

  const closedBeforeReadSettles = await closeObservedByNextTurn(fixture);
  readOutcome.resolve({ bytesRead: 0 });
  await assert.rejects(read, error => error === cancellation, '迟到的正常读结果必须投影原取消原因');
  assert.equal(closedBeforeReadSettles, true, '读挂起时取消必须立即关闭文件句柄');
  assert.equal(fixture.closeCalls, 1, '取消后的 finally 不得重复关闭句柄');
}

{
  const readOutcome = deferred();
  const fixture = await loadReader({ readOutcome });
  const cancellation = Object.assign(new Error('日志读取已取消。'), { status: 499 });
  const read = fixture.read;
  await fixture.readStarted;
  fixture.controller.abort(cancellation);

  const closedBeforeReadSettles = await closeObservedByNextTurn(fixture);
  readOutcome.reject(new Error('底层读取迟到失败'));
  await assert.rejects(read, error => error === cancellation, '迟到的底层读取错误必须投影原取消原因');
  assert.equal(closedBeforeReadSettles, true, '底层读取挂起时取消必须立即关闭文件句柄');
  assert.equal(fixture.closeCalls, 1, '取消后的读取错误不得重复关闭句柄');
}

{
  const readOutcome = deferred();
  const closeOutcome = deferred();
  const fixture = await loadReader({ readOutcome, closeOutcome });
  const cancellation = Object.assign(new Error('日志读取已取消。'), { status: 499 });
  const read = fixture.read;
  let settled = false;
  const readSettled = read.then(
    value => { settled = true; return { value }; },
    error => { settled = true; return { error }; },
  );
  await fixture.readStarted;
  fixture.controller.abort(cancellation);
  await fixture.closeObserved;
  readOutcome.resolve({ bytesRead: 0 });
  await new Promise(resolve => setImmediate(resolve));
  const settledBeforeClose = settled;
  closeOutcome.resolve();
  const outcome = await readSettled;
  assert.equal(settledBeforeClose, false, 'close 未完成前取消读取不得先 settle');
  assert.equal(outcome.error, cancellation, 'close 完成后仍必须投影原取消原因');
  assert.equal(fixture.closeCalls, 1, 'deferred close 也只能调用一次');
}

{
  const readOutcome = deferred();
  const fixture = await loadReader({ readOutcome });
  const read = fixture.read;
  await fixture.readStarted;
  readOutcome.resolve({ bytesRead: 0 });
  const result = await read;
  assert.equal(Array.isArray(result), true, '正常空尾读取仍应返回数组');
  assert.equal(result.length, 0, '正常空尾读取仍应返回空数组');
  assert.equal(fixture.closeCalls, 1, '正常完成必须恰好关闭一次句柄');
}

console.log('logger pending-read abort lifecycle tests passed');
