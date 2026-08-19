import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

const source = await fsp.readFile(new URL('../src/wxdb/index.js', import.meta.url), 'utf8');
const lifecycleStart = source.indexOf('function createAbortableFileHandleLifecycle(');
const readHeaderStart = source.indexOf('async function readHeader(', lifecycleStart);
const readExactlyStart = source.indexOf('async function readExactly(', readHeaderStart);
const mergeStart = source.indexOf('async function mergeWeixinV4WalIntoPlaintext(', readExactlyStart);
const walChecksumStart = source.indexOf('function walChecksum(', mergeStart);
assert.ok(
  lifecycleStart >= 0
    && readHeaderStart > lifecycleStart
    && readExactlyStart > readHeaderStart
    && mergeStart > readExactlyStart
    && walChecksumStart > mergeStart,
  'wxdb WAL merge lifecycle must remain inspectable',
);

const mergeSource = source.slice(mergeStart, walChecksumStart);
for (const pattern of [
  /readExactly\(input, header, 0, header\.length, 0, signal\)/,
  /readExactly\(input, frameHeader, 0, frameHeader\.length, frameOffset, signal\)/,
  /readExactly\(input, encryptedPage, 0, pageSize, frameOffset \+ frameHeader\.length, signal\)/,
  /readExactly\(input, encryptedPage, 0, pageSize, frame\.pageOffset, signal\)/,
]) {
  assert.match(mergeSource, pattern, 'WAL merge reads must carry the caller signal');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const lifecycleSource = source.slice(lifecycleStart, readHeaderStart);
const readExactlySource = source.slice(readExactlyStart, mergeStart);
const fakeFsp = {};
const merge = new Function(
  'Buffer',
  'fsp',
  'path',
  'assertCopiedDbRealPath',
  'throwIfAborted',
  'isMissingFileError',
  'dbTempCopyError',
  'WEIXIN_V4_PAGE_SIZE',
  'walChecksum',
  'decryptWeixinV4Page',
  'isWeixinV4PageHmacMismatch',
  'writeExactly',
  'isDiskSpaceError',
  'dbTempCopyDiskSpaceError',
  `${lifecycleSource}\n${readExactlySource}\n${mergeSource}\nreturn mergeWeixinV4WalIntoPlaintext;`,
)(
  Buffer,
  fakeFsp,
  path,
  async () => {},
  signal => {
    if (signal?.aborted) throw signal.reason;
  },
  () => false,
  (code, message, details = {}) => Object.assign(new Error(message), { code, ...details }),
  4096,
  () => [0, 0],
  () => Buffer.alloc(4096),
  () => false,
  async () => 0,
  () => false,
  error => error,
);

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
Object.assign(fakeFsp, {
  async lstat() {
    return {
      isSymbolicLink: () => false,
      isFile: () => true,
      size: 32,
    };
  },
  async open() {
    return handle;
  },
});

const cancellation = Object.assign(new Error('WAL caller cancelled'), { name: 'AbortError', status: 499 });
const controller = new AbortController();
const pending = merge('db.sqlite', 'plain.sqlite', {}, {
  signal: controller.signal,
  allow_external_test_db: true,
});
let settled = false;
const settledResult = pending.then(
  value => { settled = true; return { value }; },
  error => { settled = true; return { error }; },
);

await readStarted.promise;
controller.abort(cancellation);
await closeObserved.promise;
assert.equal(closeCalls, 1, 'WAL cancel must start one input close before read settles');
readOutcome.resolve({ bytesRead: 0 });
await new Promise(resolve => setImmediate(resolve));
assert.equal(settled, false, 'WAL merge must await the in-flight close');
closeOutcome.resolve();

const result = await settledResult;
assert.equal(result.error, cancellation, 'WAL merge must project the caller cancellation reason');
assert.equal(closeCalls, 1, 'WAL merge must join one shared close promise');

console.log('wxdb WAL merge handle abort lifecycle tests passed');
