import assert from 'node:assert/strict';
import realFsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;
const payload = Buffer.from('{"ready":true}', 'utf8');
const cancellation = Object.assign(new Error('JSON 读取已取消'), {
  name: 'AbortError',
  status: 499,
});

let closeStartedResolve = null;
const closeStarted = new Promise(resolve => { closeStartedResolve = resolve; });
let releaseClose = null;
const closeGate = new Promise(resolve => { releaseClose = resolve; });
let closeCount = 0;

mock.module('node:fs/promises', {
  defaultExport: {
    ...realFsp,
    open: async () => ({
      async stat() {
        return { size: payload.length, isFile: () => true, mtimeMs: 1, ctimeMs: 1, dev: 1, ino: 1 };
      },
      async read(target, offset, length, position) {
        const bytesRead = Math.min(length, Math.max(0, payload.length - position));
        if (bytesRead) payload.copy(target, offset, position, position + bytesRead);
        return { bytesRead, buffer: target };
      },
      async close() {
        closeCount += 1;
        closeStartedResolve?.();
        await closeGate;
      },
    }),
  },
});

const { readJson } = await import(`${sourceUrl('src/lib/json-store.js')}?read-abort-close`);
const controller = new AbortController();
const pending = readJson('fixture.json', null, {
  strict: true,
  signal: controller.signal,
});

await closeStarted;
controller.abort(cancellation);
releaseClose();
const settledError = await pending.then(
  () => null,
  error => error,
);
assert.equal(settledError, cancellation, 'JSON read must project cancellation that arrives while its final close is pending');
assert.equal(closeCount, 1, 'JSON read must join one shared close owner');

console.log('json-store read abort-close tests passed');
