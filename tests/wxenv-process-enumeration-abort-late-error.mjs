import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;
const cancellation = Object.assign(new Error('进程枚举已取消'), {
  name: 'AbortError',
  status: 499,
});

let callback = null;
mock.module('node:child_process', {
  namedExports: {
    execFile(_file, _args, _options, next) {
      callback = next;
      return { kill() {} };
    },
  },
});

const discovery = await import(`${sourceUrl('src/wxenv/discovery.js')}?process-enumeration-abort-late-error`);
const controller = new AbortController();
const pending = discovery.getWeixinProcesses({ signal: controller.signal });
for (let attempt = 0; attempt < 20 && !callback; attempt += 1) await Promise.resolve();
assert.equal(typeof callback, 'function', 'Windows 进程枚举必须进入底层 execFile caller');

controller.abort(cancellation);
callback(new Error('进程枚举在取消后收到迟到的普通错误'));

await assert.rejects(
  pending,
  error => error === cancellation,
  '真实进程枚举 caller 必须把取消后的普通错误投影为调用方取消原因',
);

console.log('wxenv process enumeration abort-late-error tests passed');
