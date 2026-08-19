import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;
const cancellation = Object.assign(new Error('验证扫描已取消'), {
  name: 'AbortError',
  status: 499,
});
const controller = new AbortController();
let readCalls = 0;
let closeCalls = 0;

const fakeKernel32 = {
  func(signature) {
    const name = String(signature);
    if (name.includes('OpenProcess')) return () => ({ handle: 1 });
    if (name.includes('CloseHandle')) return () => { closeCalls += 1; return true; };
    if (name.includes('GetLastError')) return () => 5;
    if (name.includes('VirtualQueryEx')) {
      return (_handle, address, info) => {
        if (BigInt(address || 0) !== 0n) return 0;
        info.BaseAddress = 0n;
        info.RegionSize = BigInt(16 * 1024 * 1024);
        info.State = 0x1000;
        info.Protect = 0x04;
        info.Type = 0x20000;
        return 1;
      };
    }
    if (name.includes('ReadProcessMemory')) {
      return (_handle, _address, _buffer, length, readOut) => {
        readCalls += 1;
        readOut[0] = BigInt(length);
        if (readCalls === 16) controller.abort(cancellation);
        return true;
      };
    }
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
    getWeixinProcesses: async () => [],
    isConfirmedMainWeixinProcess: () => false,
    pickAccount: () => null,
    preferredWeixinProcess: processes => processes[0] || null,
  },
});
mock.module(sourceUrl('src/wxdb/image-dat.js'), {
  namedExports: { imageKeyValidationCount: () => 0 },
});

const wxkey = await import(`${sourceUrl('src/wxkey/index.js')}?verified-scan-abort-late-progress`);
const page = Buffer.alloc(4096);
Buffer.from('00112233445566778899aabbccddeeff', 'hex').copy(page, 0);
const progress = [];
const pending = wxkey.scanProcessForVerifiedWeixinV4DbKeys(73106, {
  db_pages: [page],
  max_bytes: 16 * 1024 * 1024,
  max_region_bytes: 16 * 1024 * 1024,
  max_ms: 60_000,
  on_progress: value => progress.push(value),
  signal: controller.signal,
});

let outcome = null;
try {
  outcome = await pending;
} catch (error) {
  outcome = error;
}
assert.equal(readCalls, 16, 'verified scan must reach the controlled boundary memory read');
assert.equal(outcome, cancellation, 'memory read cancellation must reject the production scan caller');
assert.deepEqual(progress, [], 'cancellation during memory read must not project stale scan progress');
assert.equal(closeCalls >= 1, true, 'cancelled scan must still close its read-only process handle');

console.log('wxkey verified-scan abort-late-progress tests passed');
