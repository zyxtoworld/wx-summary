import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { readFileHandleBounded } from '../src/lib/bounded-read.js';

for (const [file, label] of [
  ['../src/renderer/output.js', 'output reader'],
  ['../src/renderer/server-png.js', 'server PNG reader'],
  ['../src/renderer/thumbnail.js', 'thumbnail reader'],
  ['../src/lib/json-store.js', 'JSON reader'],
]) {
  const source = await fsp.readFile(new URL(file, import.meta.url), 'utf8');
  assert.match(source, /createFileHandleCloser\(handle\)/, `${label} must create a joinable handle closer`);
  assert.match(source, /readFileHandleBounded\([\s\S]{0,700}?signal,\s*closeHandle,/, `${label} must pass signal and close owner into bounded read`);
  assert.ok(
    /await closeHandle\?\.\(\)\.catch\(\(\) => \{\}\)/.test(source)
      || /finally\s*\{\s*try\s*\{\s*await closeHandle\?\.\(\);/s.test(source),
    `${label} finally must join the same close owner`,
  );
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

const readOutcome = deferred();
const closeOutcome = deferred();
const readStarted = deferred();
const closeStarted = deferred();
const controller = new AbortController();
const cancellation = Object.assign(new Error('bounded read caller cancelled'), { name: 'AbortError', status: 499 });
let closeCalls = 0;
let closePromise = null;
const closeHandle = () => {
  if (!closePromise) {
    closeCalls += 1;
    closeStarted.resolve();
    closePromise = closeOutcome.promise;
  }
  return closePromise;
};
const handle = {
  async stat() {
    return { size: 1, dev: 1, ino: 1, mtimeMs: 1, ctimeMs: 1 };
  },
  async read() {
    readStarted.resolve();
    return readOutcome.promise;
  },
};

const pending = (async () => {
  try {
    return await readFileHandleBounded(handle, 16, {
      signal: controller.signal,
      closeHandle,
      checkAbort: () => {
        if (controller.signal.aborted) throw controller.signal.reason;
      },
    });
  } finally {
    await closeHandle();
  }
})();
let settled = false;
const settledResult = pending.then(
  value => { settled = true; return { value }; },
  error => { settled = true; return { error }; },
);

await readStarted.promise;
controller.abort(cancellation);
await new Promise(resolve => setImmediate(resolve));
assert.equal(closeCalls, 1, 'bounded read cancellation must start the shared close before read settles');
readOutcome.resolve({ bytesRead: 0 });
await new Promise(resolve => setImmediate(resolve));
assert.equal(settled, false, 'bounded read must await the in-flight close before settling');
closeOutcome.resolve();
const result = await settledResult;
assert.equal(result.error, cancellation, 'bounded read must project the caller cancellation reason');
assert.equal(closeCalls, 1, 'bounded read caller and helper must join one close promise');

console.log('bounded read abort-close lifecycle tests passed');
