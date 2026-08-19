import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;
const cancellation = Object.assign(new Error('微信程序证据读取已取消'), {
  name: 'AbortError',
  status: 499,
});

let streamHandlers = new Map();
let streamDestroyReason = null;
let streamStartedResolve = null;
const streamStarted = new Promise(resolve => { streamStartedResolve = resolve; });
const fakeStream = {
  on(event, handler) {
    streamHandlers.set(event, handler);
    return this;
  },
  destroy(reason) {
    streamDestroyReason = reason;
  },
};

mock.module('node:child_process', {
  namedExports: {
    execFile(_file, _args, _options, next) {
      next(null, JSON.stringify({
        ProcessId: 73102,
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

const discovery = await import(`${sourceUrl('src/wxenv/discovery.js')}?binary-evidence-abort-late-error`);
const controller = new AbortController();
const pending = discovery.getWeixinBinaryEvidence({ signal: controller.signal });
await streamStarted;
controller.abort(cancellation);
streamHandlers.get('error')?.(new Error('文件流在取消后收到迟到的普通错误'));

assert.equal(streamDestroyReason, cancellation, '取消必须先终止当前文件流并传递调用方 reason');
await assert.rejects(
  pending,
  error => error === cancellation,
  '真实 binary evidence caller 必须把取消后的普通 stream error 投影为调用方取消原因',
);

console.log('wxenv binary evidence abort-late-error tests passed');
