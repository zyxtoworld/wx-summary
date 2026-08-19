import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const source = await readFile(new URL('../src/wxdb/index.js', import.meta.url), 'utf8');

function extractFunction(sourceText, marker) {
  const start = sourceText.indexOf(marker);
  assert.ok(start >= 0, `必须能定位生产函数 ${marker}`);
  const signatureEnd = sourceText.indexOf(') {', start + marker.length);
  assert.ok(signatureEnd >= 0, `${marker} 必须定位函数签名`);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = signatureEnd + 2; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return sourceText.slice(start, index + 1);
  }
  throw new Error(`${marker} 函数体未闭合`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason;
}

const openCachedSource = extractFunction(source, 'async function openCachedWeixinV4PlaintextDb(');
const openUsableSource = extractFunction(source, 'async function openUsableCachedPlaintextDb(');
const releaseSource = extractFunction(source, 'async function releaseWeixinV4PlaintextCache(');
assert.match(
  openCachedSource,
  /openUsableCachedPlaintextDb\(Database, cache\.plainPath, \{ signal \}\)/,
  '真实缓存打开入口必须把调用方 signal 传入可用性检查',
);
assert.match(
  openUsableSource,
  /await releaseWeixinV4PlaintextCache\(plainPath, leasePath, \{ signal \}\)/,
  '先锁定当前失败清理调用点，再由行为测约束取消语义',
);

const readHeaderStarted = deferred();
const readHeaderGate = deferred();
const releaseCalled = deferred();
const releaseGate = deferred();
let releaseOptions = null;
const controller = new AbortController();
const cancellation = Object.assign(new Error('plaintext cache owner cancelled'), {
  name: 'AbortError',
  status: 499,
});

const openCachedWeixinV4PlaintextDb = new Function(
  'assertNoHotCopiedRollbackJournal',
  'pruneWeixinV4PlaintextCache',
  'weixinV4PlaintextCachePaths',
  'openReadonlyDatabase',
  'enforceQueryOnly',
  'readHeader',
  'retainWeixinV4PlaintextCache',
  'releaseWeixinV4PlaintextCache',
  'removePlaintextCacheEntryIfUnused',
  'acquirePlaintextCacheEntryLock',
  'decryptWeixinV4DbToPlaintext',
  'assertSafeTmpPath',
  'renameAtomicWithRetry',
  'assertCopiedDbRealPath',
  'isSqliteCorruptionError',
  'copiedDbCorruptionError',
  'isWxdbAbort',
  'notifyProgress',
  'throwIfAborted',
  'SQLITE_HEADER',
  'path',
  `${openUsableSource}\n${openCachedSource}\nreturn openCachedWeixinV4PlaintextDb;`,
)(
  async () => {},
  async () => {},
  async () => ({ plainPath: 'C:/fixture/cache.db', tempPath: 'C:/fixture/cache.tmp' }),
  async () => { throw new Error('openReadonlyDatabase must not run before the stale header read settles'); },
  () => {},
  async () => {
    readHeaderStarted.resolve();
    await readHeaderGate.promise;
    throw cancellation;
  },
  async () => 'C:/fixture/cache.db.123.abcdef0123456789.12345678.lease',
  async (_file, _leasePath, options = {}) => {
    releaseOptions = options;
    releaseCalled.resolve();
    if (options?.signal) return;
    await releaseGate.promise;
  },
  async () => {},
  async () => { throw new Error('cache lock must not be acquired after the stale cache open fails'); },
  async () => { throw new Error('decrypt must not run after the stale cache open fails'); },
  async () => {},
  async () => {},
  async () => {},
  () => false,
  () => false,
  () => {},
  () => {},
  throwIfAborted,
  Buffer.from('SQLite format 3\\0'),
  path,
);

const pending = openCachedWeixinV4PlaintextDb({}, 'C:/fixture/source.db', 'fake-database', {
  signal: controller.signal,
  sourceName: 'fixture-source.db',
});
await readHeaderStarted.promise;
controller.abort(cancellation);
readHeaderGate.resolve();
await releaseCalled.promise;

try {
  assert.equal(
    releaseOptions?.signal,
    controller.signal,
    '缓存打开取消后，释放 lease 的锁等待必须绑定同一调用方 signal，不能把已取消 owner 挂起在无界清理等待上',
  );
} finally {
  releaseGate.resolve();
}

await assert.rejects(
  pending,
  error => error === cancellation,
  '取消后的缓存打开仍应向真实 caller 返回原始 499/AbortError',
);

let settledSignal = null;
const releaseWeixinV4PlaintextCache = new Function(
  'WXDB_PERSISTENT_WORKER_SESSION',
  'wxDbPersistentWorkerSessionClosing',
  'weixinV4WorkerSessionPlaintextLeases',
  'weixinV4PlaintextCacheLeaseHeartbeats',
  'plaintextCacheRefKey',
  'forgetLocalPlaintextCacheLease',
  'transitionPlaintextCacheLeaseToReleasing',
  'settlePlaintextCacheRelease',
  `${releaseSource}\nreturn releaseWeixinV4PlaintextCache;`,
)(
  false,
  false,
  new Map(),
  new Map(),
  file => file,
  () => {},
  async () => 'C:/fixture/cache.db.lease.releasing',
  async (_file, _releasingPath, options = {}) => {
    settledSignal = options.signal || null;
  },
);
const releaseController = new AbortController();
releaseController.abort(cancellation);
await releaseWeixinV4PlaintextCache(
  'C:/fixture/cache.db',
  'C:/fixture/cache.db.lease',
  { signal: releaseController.signal },
);
assert.equal(
  settledSignal,
  releaseController.signal,
  '释放函数进入 durable settle 时也必须把取消 signal 传给锁等待，而不是只在 caller 侧传递',
);

console.log('wxdb plaintext cache abort-release tests passed');
