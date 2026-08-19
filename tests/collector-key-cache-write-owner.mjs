import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const testFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(testFile), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;

const account = {
  account_id: 'wxacc_aaaaaaaaaaaaaaaa',
  id: 'wxacc_aaaaaaaaaaaaaaaa',
  identity_id: 'wxacct_aaaaaaaaaaaaaaaaaaaaaaaa',
  identity_status: 'verified',
  identity_generation_status: 'verified',
  verified_self_wxid: 'wxid_cache_owner',
  source: 'project-mirror',
  source_db_storage: 'C:\\wx-summary-fixture\\db',
  source_account_root: 'C:\\wx-summary-fixture',
  mirror_relative_root: 'data/wxdb-mirror/wxacc_aaaaaaaaaaaaaaaa',
  mirror: {
    identity_id: 'wxacct_aaaaaaaaaaaaaaaaaaaaaaaa',
    identity_status: 'verified',
    identity_generation_status: 'verified',
    verified_self_wxid: 'wxid_cache_owner',
    relative_root: 'data/wxdb-mirror/wxacc_aaaaaaaaaaaaaaaa',
  },
};
const accountFingerprint = 'f'.repeat(64);
const verifiedKey = 'a'.repeat(64);
let abortController = null;
let abortOnNextFingerprint = false;
let persistentWrites = 0;
let committedWrites = 0;
let persistentWriteGate = null;
let persistentWriteStarted = null;
let concurrentWriteMode = false;
let concurrentWriteGates = [];
let concurrentAReleased = false;
let concurrentBStartedBeforeARelease = false;

function deferred() {
  let resolve;
  const promise = new Promise(nextResolve => { resolve = nextResolve; });
  return { promise, resolve };
}

mock.module(sourceUrl('src/wxenv/discovery.js'), { namedExports: {
  discoverWeixinEnvironment: async () => ({ accounts: [account] }),
  discoverDataRoots: async () => [],
  discoverWxAccounts: async () => [account],
  ensureWxDbMirror: async () => ({ refreshed: false, reused: true }),
  getWeixinProcesses: async () => [],
  hasWxDbMirrorIdentityAnchor: () => true,
  isConfirmedMainWeixinProcess: () => false,
  isWxDbMirrorIdentityVerified: () => true,
  pickAccount: (accounts, requested) => accounts.find(item => item.account_id === requested) || accounts[0] || null,
  preferredWeixinProcess: () => null,
  readWxDbMirrorAccount: async () => account,
  withWxDbMirrorReadLock: async (_accountId, action) => action(),
  wxDbMirrorScopeRecordsForRead: () => [],
} });
mock.module(sourceUrl('src/wxkey/index.js'), { namedExports: {
  STANDARD_WEIXIN_KEY_SCAN_MAX_MS: 1000,
  clearLocalWeixinKeyScanCache: () => {},
  currentWxKeyProcessGeneration: async () => ({ process_generation: 'cache-owner-test' }),
  probeWxKey: async () => null,
  scanLocalWeixinKeyCandidates: async () => ({ rawKeys: [], diagnostics: {} }),
} });
mock.module(sourceUrl('src/wxdb/isolated.js'), { namedExports: {
  collectMessagesFromWxDbIsolated: async () => [],
  listChatroomsFromWxDbIsolated: async () => [],
  probeWxDbIsolated: async () => ({}),
} });
mock.module(sourceUrl('src/config/settings.js'), { namedExports: {
  loadSettings: async () => ({}),
  manualKeyAccountFingerprint: () => {
    if (abortOnNextFingerprint && abortController) {
      abortOnNextFingerprint = false;
      abortController.abort(new Error('collector owner stopped'));
    }
    return accountFingerprint;
  },
  manualKeysForAccount: () => [],
  splitManualKeys: () => [],
} });
mock.module(sourceUrl('src/config/wxdb-key-cache.js'), { namedExports: {
  rememberVerifiedWxdbKeysForAccount: async options => {
    persistentWrites += 1;
    if (concurrentWriteMode) {
      const current = concurrentWriteGates.shift();
      if (current) {
        if (current.label === 'B' && !concurrentAReleased) {
          concurrentBStartedBeforeARelease = true;
        }
        current.started.resolve();
        await current.gate.promise;
      }
    }
    if (persistentWriteGate) {
      persistentWriteStarted.resolve();
      await persistentWriteGate.promise;
      if (!options?.write_if?.()) return { changed: false, key_count: 0, skipped: 'stale_generation' };
    }
    committedWrites += 1;
    return { changed: true, key_count: 1 };
  },
  verifiedWxdbKeyCacheInvalidInfo: () => null,
  verifiedWxdbKeysForAccount: async () => [],
} });
mock.module(sourceUrl('src/summarizer/llm.js'), { namedExports: {
  redactSecrets: value => String(value ?? ''),
} });

const collector = await import(`${sourceUrl('src/collector/index.js')}?collector-key-cache-write-owner`);
const expectedStateVersion = collector.dbKeyRuntimeStateVersion();
abortController = new AbortController();
abortOnNextFingerprint = true;

await assert.rejects(
  collector.rememberVerifiedRawKeys(account.account_id, [verifiedKey], {
    account,
    expected_state_version: expectedStateVersion,
    signal: abortController.signal,
  }),
  error => error?.status === 499 || error?.name === 'AbortError',
  'a collector owner cancelled after identity binding must not complete as a successful cache write',
);
assert.equal(persistentWrites, 0, 'a cancelled collector owner must not persist verified keys');

persistentWriteGate = deferred();
persistentWriteStarted = deferred();
abortController = new AbortController();
const pendingPersistentWrite = collector.rememberVerifiedRawKeys(account.account_id, [verifiedKey], {
  account,
  expected_state_version: expectedStateVersion,
  signal: abortController.signal,
});
await persistentWriteStarted.promise;
abortController.abort(new Error('collector owner stopped during persistence'));
persistentWriteGate.resolve();
await assert.rejects(
  pendingPersistentWrite,
  error => error?.status === 499 || error?.name === 'AbortError',
  'a collector owner cancelled while its cache write is pending must not publish a successful result',
);
assert.equal(committedWrites, 0, 'a cancelled owner must fail the physical cache write boundary');
persistentWriteGate = null;
persistentWriteStarted = null;

abortController = new AbortController();
abortOnNextFingerprint = true;
await assert.rejects(
  collector.rememberVerifiedAutoRawKeys(account.account_id, [verifiedKey], {
    account,
    expected_state_version: expectedStateVersion,
    verified_scope: 'message_sample',
    signal: abortController.signal,
  }),
  error => error?.status === 499 || error?.name === 'AbortError',
  'a collector owner cancelled after identity binding must not promote an old key to runtime capability',
);
assert.equal(
  await collector.hasVerifiedAutoRawKeys(account.account_id),
  false,
  'a cancelled collector owner must not leave an old automatic key capability in memory',
);

collector.__collectorInternals.clearDbKeyRuntimeCache();
const concurrentKeyA = 'b'.repeat(64);
const concurrentKeyB = 'c'.repeat(64);
const concurrentGateA = deferred();
const concurrentGateB = deferred();
const concurrentStartedA = deferred();
const concurrentStartedB = deferred();
concurrentWriteMode = true;
concurrentWriteGates = [
  { label: 'A', gate: concurrentGateA, started: concurrentStartedA },
  { label: 'B', gate: concurrentGateB, started: concurrentStartedB },
];
const concurrentWriteA = collector.rememberVerifiedRawKeys(account.account_id, [concurrentKeyA], {
  account,
  expected_state_version: collector.dbKeyRuntimeStateVersion(),
});
await concurrentStartedA.promise;
const concurrentWriteB = collector.rememberVerifiedRawKeys(account.account_id, [concurrentKeyB], {
  account,
  expected_state_version: collector.dbKeyRuntimeStateVersion(),
});
// A correct owner queues B behind A. Releasing A is the deterministic barrier
// that lets either implementation make progress; the flag below preserves the
// old-red assertion without depending on a wall-clock delay.
concurrentGateA.resolve();
concurrentAReleased = true;
await concurrentStartedB.promise;
concurrentGateB.resolve();
await Promise.all([concurrentWriteA, concurrentWriteB]);
concurrentWriteMode = false;
assert.equal(
  concurrentBStartedBeforeARelease,
  false,
  '同一账号的第二次验证写入必须等待前一次完成，不能并发读旧缓存后覆盖前一次结果',
);
const concurrentBundle = await collector.dbRawKeyCandidateBundle({
  account_id: account.account_id,
  memoryScan: false,
});
assert.equal(concurrentBundle.rawKeys.includes(concurrentKeyA), true,
  `同账号并发验证写入不得丢掉第一个运行时缓存键：${JSON.stringify({ keys: concurrentBundle.rawKeys, diagnostics: concurrentBundle.diagnostics })}`);
assert.equal(concurrentBundle.rawKeys.includes(concurrentKeyB), true,
  `同账号并发验证写入不得丢掉第二个运行时缓存键：${JSON.stringify({ keys: concurrentBundle.rawKeys, diagnostics: concurrentBundle.diagnostics })}`);

const collectorSource = await readFile(path.join(root, 'src', 'collector', 'index.js'), 'utf8');
const listGroupsSource = collectorSource.slice(
  collectorSource.indexOf('export async function listGroups'),
  collectorSource.indexOf('function groupCacheKey'),
);
const collectMessagesSource = collectorSource.slice(
  collectorSource.indexOf('export async function collectMessages'),
  collectorSource.indexOf('function senderFilterActive'),
);
assert.match(
  listGroupsSource,
  /rememberVerifiedRawKeys\([\s\S]*?expected_state_version:\s*keyRuntimeStateVersionAtStart,[\s\S]*?signal,/,
  'the real group-list cache writer must inherit the request owner signal',
);
assert.match(
  collectMessagesSource,
  /rememberVerifiedRawKeys\([\s\S]*?expected_state_version:\s*keyRuntimeStateVersionAtStart,[\s\S]*?signal,/,
  'the real message collector cache writer must inherit the request owner signal',
);

console.log('collector key-cache write-owner tests passed');
