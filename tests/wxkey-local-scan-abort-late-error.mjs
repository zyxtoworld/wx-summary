import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const cancellation = Object.assign(new Error('密钥候选扫描已取消'), {
  name: 'AbortError',
  status: 499,
});

let discoveryMode = 'data_roots';
let discoveryStarted = null;
let discoveryGate = null;

mock.module(sourceUrl('src/lib/paths.js'), {
  namedExports: { DATA_DIR: path.join(root, 'outputs', '.tmp', 'wxkey-local-scan-fixture') },
});
mock.module(sourceUrl('src/wxenv/discovery.js'), {
  namedExports: {
    discoverDataRoots: async () => {
      if (discoveryMode !== 'data_roots') return [];
      discoveryStarted?.resolve();
      return discoveryGate.promise;
    },
    discoverWxAccounts: async () => {
      if (discoveryMode !== 'accounts') return [];
      discoveryStarted?.resolve();
      return discoveryGate.promise;
    },
    getWeixinProcesses: async () => [],
    isConfirmedMainWeixinProcess: () => false,
    pickAccount: () => null,
    preferredWeixinProcess: () => null,
  },
});
mock.module(sourceUrl('src/wxdb/image-dat.js'), {
  namedExports: { imageKeyValidationCount: () => 0 },
});

const wxkey = await import(`${sourceUrl('src/wxkey/index.js')}?local-scan-abort-late-error`);

async function assertLateDiscoveryErrorIsCancelled(mode, label) {
  discoveryMode = mode;
  discoveryStarted = deferred();
  discoveryGate = deferred();
  const controller = new AbortController();
  const pending = wxkey.scanLocalWeixinKeyCandidates({
    account_id: 'wxacc_local_scan',
    signal: controller.signal,
    max_files: 1,
    max_file_bytes: 1024,
  });
  await discoveryStarted.promise;
  controller.abort(cancellation);
  discoveryGate.reject(new Error(`${label} 在取消后收到迟到的普通错误`));
  await assert.rejects(
    pending,
    error => error === cancellation,
    `${label} 迟到普通错误必须投影调用方取消原因`,
  );
}

await assertLateDiscoveryErrorIsCancelled('data_roots', '数据根目录发现');
await assertLateDiscoveryErrorIsCancelled('accounts', '账号目录发现');

console.log('wxkey local-scan abort-late-error tests passed');
