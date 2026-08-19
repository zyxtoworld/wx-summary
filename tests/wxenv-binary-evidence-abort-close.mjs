import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;
const cancellation = Object.assign(new Error('微信程序证据读取已取消'), {
  name: 'AbortError',
  status: 499,
});

let streamStartedResolve;
const streamStarted = new Promise(resolve => { streamStartedResolve = resolve; });
let destroyReason = null;
const fakeStream = new EventEmitter();
fakeStream.destroy = reason => {
  destroyReason = reason;
  // 模拟底层文件流在取消后只发 close，不再发 error/end。
  queueMicrotask(() => fakeStream.emit('close'));
  return fakeStream;
};

mock.module('node:child_process', {
  namedExports: {
    execFile(_file, _args, _options, next) {
      next(null, JSON.stringify({
        ProcessId: 73103,
        Path: 'C:\\Program Files\\Weixin\\Weixin.exe',
        StartTime: '2026-08-17T09:00:00.000Z',
        WorkingSet64: 1,
      }), '');
      return { kill() {} };
    },
  },
});
mock.module('node:fs', {
  defaultExport: {
    existsSync: () => true,
    createReadStream() {
      streamStartedResolve?.();
      return fakeStream;
    },
    createWriteStream() {
      throw new Error('fixture does not write files');
    },
  },
});
mock.module('node:fs/promises', {
  defaultExport: {
    stat: async () => ({
      isFile: () => true,
      size: 1,
      mtime: new Date('2026-08-17T09:00:00.000Z'),
    }),
  },
});

const discovery = await import(`${sourceUrl('src/wxenv/discovery.js')}?binary-evidence-abort-close`);
const controller = new AbortController();
const pending = discovery.getWeixinBinaryEvidence({ signal: controller.signal });
await streamStarted;
controller.abort(cancellation);

let settled = false;
let outcome = null;
pending.then(
  value => { settled = true; outcome = value; },
  error => { settled = true; outcome = error; },
);
for (let attempt = 0; attempt < 12 && !settled; attempt += 1) await Promise.resolve();
assert.equal(settled, true, '文件流取消后只发 close 也必须立即收口 binary evidence caller');
assert.equal(outcome, cancellation, 'close-only 取消必须投影调用方 cancellation reason');
assert.equal(destroyReason, cancellation, '取消必须把调用方 reason 传给文件流 destroy');

console.log('wxenv binary evidence abort-close tests passed');
