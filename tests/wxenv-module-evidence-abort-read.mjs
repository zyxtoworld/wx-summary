import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;
const cancellation = Object.assign(new Error('微信模块证据读取已取消'), {
  name: 'AbortError',
  status: 499,
});
const moduleFile = 'C:\\Program Files\\Weixin\\WeixinWin.dll';

let readOptions = undefined;
let readReject = null;
let readStartedResolve = null;
const readStarted = new Promise(resolve => { readStartedResolve = resolve; });

mock.module('node:child_process', {
  namedExports: {
    execFile(_file, args, _options, next) {
      const command = String(args?.at(-1) || '');
      if (command.includes('Get-Process -Name Weixin')) {
        next(null, JSON.stringify({
          ProcessId: 73103,
          Path: 'C:\\Program Files\\Weixin\\Weixin.exe',
          StartTime: '2026-08-17T09:00:00.000Z',
          WorkingSet64: 1,
        }), '');
      } else if (command.includes('Get-Process -Id')) {
        next(null, JSON.stringify({
          ModuleName: 'WeixinWin.dll',
          FileName: moduleFile,
          BaseAddress: 65536,
          ModuleMemorySize: 4096,
        }), '');
      } else {
        next(new Error(`unexpected discovery command: ${command}`));
      }
      return { kill() {} };
    },
  },
});

mock.module('node:fs/promises', {
  defaultExport: {
    stat: async () => ({
      isFile: () => true,
      size: 4096,
      mtime: new Date('2026-08-17T09:00:00.000Z'),
    }),
    readFile(_file, options) {
      readOptions = options;
      readStartedResolve?.();
      return new Promise((resolve, reject) => {
        readReject = reject;
        const signal = options?.signal;
        if (!signal) return;
        const onAbort = () => reject(Object.assign(new Error('The operation was aborted'), {
          name: 'AbortError',
          code: 'ABORT_ERR',
          cause: signal.reason || cancellation,
        }));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    },
  },
});

const discovery = await import(`${sourceUrl('src/wxenv/discovery.js')}?module-evidence-abort-read`);
const controller = new AbortController();
const pending = discovery.getWeixinModuleEvidence({ signal: controller.signal });
await readStarted;

assert.equal(
  readOptions?.signal,
  controller.signal,
  'module evidence must pass its owner AbortSignal to the module file read',
);
controller.abort(cancellation);

await assert.rejects(
  pending,
  error => error === cancellation,
  'module evidence must stop and project the caller cancellation while module bytes are pending',
);
assert.equal(typeof readReject, 'function');

console.log('wxenv module evidence abort-read tests passed');
