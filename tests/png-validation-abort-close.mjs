import assert from 'node:assert/strict';
import realFsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;
const cancellation = Object.assign(new Error('PNG 校验已取消'), {
  name: 'AbortError',
  status: 499,
});
const signature = Buffer.from('89504e470d0a1a0a', 'hex');

let readStartedResolve = null;
let readStarted = Promise.resolve();
let readResolve = null;
let closeCount = 0;
let readTarget = null;

function armReadBarrier() {
  readStarted = new Promise(resolve => { readStartedResolve = resolve; });
}

armReadBarrier();

mock.module('node:fs/promises', {
  defaultExport: {
    ...realFsp,
    open: async () => ({
      async stat() {
        return { size: signature.length, isFile: () => true };
      },
      read(target, offset, length) {
        readTarget = target;
        readStartedResolve?.();
        return new Promise(resolve => {
          readResolve = () => {
            signature.copy(target, offset, 0, Math.min(length, signature.length));
            resolve({ bytesRead: Math.min(length, signature.length), buffer: target });
          };
        });
      },
      async close() {
        closeCount += 1;
      },
    }),
  },
});

const { validatePngFile } = await import(`${sourceUrl('src/renderer/png-validate.js')}?abort-close`);

const controller = new AbortController();
armReadBarrier();
const pending = validatePngFile('fixture.png', {
  signal: controller.signal,
  validateInflatedPayload: false,
});
await readStarted;

controller.abort(cancellation);
await Promise.resolve();
await Promise.resolve();
let earlyFailure = null;
try {
  assert.equal(closeCount, 1, 'PNG 校验取消必须在挂起 read 尚未结束时启动句柄关闭');
} catch (error) {
  earlyFailure = error;
}

readResolve?.();
const settledError = await pending.then(
  () => null,
  error => error,
);
if (earlyFailure) throw earlyFailure;
assert.equal(settledError, cancellation, 'PNG 校验必须投影调用方的取消 reason');
assert.equal(closeCount, 1, 'PNG 校验取消只能关闭句柄一次');
assert.ok(readTarget, '测试必须确实进入文件读取');

console.log('png validation abort-close tests passed');
