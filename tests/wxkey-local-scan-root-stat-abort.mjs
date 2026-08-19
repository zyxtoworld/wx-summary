import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;

function deferred() {
  let resolve;
  const promise = new Promise(nextResolve => { resolve = nextResolve; });
  return { promise, resolve };
}

const cancellation = Object.assign(new Error('本地密钥根目录扫描已取消'), {
  name: 'AbortError',
  status: 499,
});
const statStarted = deferred();
const statGate = deferred();
let statCalls = 0;

mock.module(sourceUrl('src/lib/paths.js'), {
  namedExports: { DATA_DIR: 'C:\\wx-summary-data' },
});
mock.module(sourceUrl('src/wxenv/discovery.js'), {
  namedExports: {
    discoverDataRoots: async () => ['C:\\wx-data-root'],
    discoverWxAccounts: async () => [],
    getWeixinProcesses: async () => [],
    isConfirmedMainWeixinProcess: () => false,
    pickAccount: () => null,
    preferredWeixinProcess: () => null,
  },
});
mock.module(sourceUrl('src/wxdb/image-dat.js'), {
  namedExports: { imageKeyValidationCount: () => 0 },
});
mock.module('node:fs/promises', {
  defaultExport: {
    stat() {
      statCalls += 1;
      statStarted.resolve();
      return statGate.promise;
    },
    realpath: async file => file,
    readdir: async () => [],
    readFile: async () => Buffer.alloc(0),
  },
});

const wxkey = await import(`${sourceUrl('src/wxkey/index.js')}?local-scan-root-stat-abort`);
const controller = new AbortController();
const pending = wxkey.scanLocalWeixinKeyCandidates({
  account_id: 'wxacc_local_root_stat',
  signal: controller.signal,
  max_files: 1,
  max_file_bytes: 1024,
});
await statStarted.promise;
assert.ok(statCalls >= 1, '本地密钥扫描必须进入候选根目录 stat');
controller.abort(cancellation);

let settled = false;
let outcome = null;
pending.then(
  value => { settled = true; outcome = value; },
  error => { settled = true; outcome = error; },
);
for (let attempt = 0; attempt < 12 && !settled; attempt += 1) await Promise.resolve();
assert.equal(settled, true, '候选根目录 stat 挂起时取消必须立即收口真实扫描 caller');
assert.equal(outcome, cancellation, '候选根目录 stat 取消必须投影调用方 reason');

statGate.resolve({ isDirectory: () => false });
await pending.catch(() => {});
console.log('wxkey local-scan root-stat abort tests passed');
