import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;

const cancellation = Object.assign(new Error('密钥探测已取消'), {
  name: 'AbortError',
  status: 499,
});
const controller = new AbortController();
let openCount = 0;

const fakeKernel32 = {
  func(signature) {
    if (String(signature).includes('OpenProcess')) {
      return () => {
        openCount += 1;
        if (openCount === 2) controller.abort(cancellation);
        return { handle: openCount };
      };
    }
    if (String(signature).includes('CloseHandle')) return () => true;
    if (String(signature).includes('GetLastError')) return () => 5;
    if (String(signature).includes('VirtualQueryEx')) {
      return () => { throw new Error('扫描器在取消后收到迟到的普通错误'); };
    }
    if (String(signature).includes('ReadProcessMemory')) return () => false;
    throw new Error(`unexpected kernel32 binding: ${signature}`);
  },
};

mock.module('koffi', {
  defaultExport: {
    load: () => fakeKernel32,
    struct: () => ({}),
    sizeof: () => 1,
  },
});
mock.module(sourceUrl('src/lib/paths.js'), {
  namedExports: { DATA_DIR: root },
});
mock.module(sourceUrl('src/wxenv/discovery.js'), {
  namedExports: {
    discoverDataRoots: async () => [],
    discoverWxAccounts: async () => [],
    getWeixinProcesses: async () => [{
      pid: 73101,
      path: 'C:\\Program Files\\Weixin\\Weixin.exe',
      command_line: 'Weixin.exe',
      is_main: true,
    }],
    isConfirmedMainWeixinProcess: process => process?.is_main === true,
    pickAccount: () => null,
    preferredWeixinProcess: processes => processes[0] || null,
  },
});
mock.module(sourceUrl('src/wxdb/image-dat.js'), {
  namedExports: { imageKeyValidationCount: () => 0 },
});

const wxkey = await import(`${sourceUrl('src/wxkey/index.js')}?probe-abort-late-error`);
await assert.rejects(
  wxkey.probeWxKey({ scan: true, signal: controller.signal }),
  error => error === cancellation,
  '扫描在 owner 取消后以普通错误迟到时，真实 probe caller 必须投影调用方取消原因',
);

console.log('wxkey probe abort-late-error tests passed');
