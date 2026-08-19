import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const testFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(testFile), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;

const accountFingerprint = 'f'.repeat(64);
const verifiedKey = 'a'.repeat(64);
const mirrorReadiness = {
  account_id: 'wxacc_collect_owner',
  scope: 'digest',
  manifest_scope: 'digest',
  source_snapshot_meta_hash: 'digest-snapshot',
  published_manifest_hash: 'published-manifest',
};
const account = {
  account_id: 'wxacc_collect_owner',
  id: 'wxacc_collect_owner',
  identity_id: 'wxacct_collect_owner',
  identity_status: 'verified',
  identity_generation_status: 'verified',
  verified_self_wxid: 'wxid_collect_owner',
  source: 'project-mirror',
  source_db_storage: 'C:\\wx-summary-fixture\\db',
  source_account_root: 'C:\\wx-summary-fixture',
  mirror_relative_root: 'data/wxdb-mirror/wxacc_collect_owner',
  mirror: {
    identity_id: 'wxacct_collect_owner',
    identity_status: 'verified',
    identity_generation_status: 'verified',
    verified_self_wxid: 'wxid_collect_owner',
    relative_root: 'data/wxdb-mirror/wxacc_collect_owner',
    published_manifest_hash: mirrorReadiness.published_manifest_hash,
    source_scopes: {
      digest: { source_snapshot_meta_hash: mirrorReadiness.source_snapshot_meta_hash },
    },
  },
};

function deferred() {
  let resolve;
  const promise = new Promise(nextResolve => { resolve = nextResolve; });
  return { promise, resolve };
}

const autoBindingReadStarted = deferred();
const autoBindingReadGate = deferred();
let mirrorReads = 0;

mock.module(sourceUrl('src/wxenv/discovery.js'), { namedExports: {
  discoverWeixinEnvironment: async () => ({ accounts: [account] }),
  discoverDataRoots: async () => [],
  discoverWxAccounts: async () => [account],
  ensureWxDbMirror: async () => ({
    account_id: account.account_id,
    refreshed: false,
    reused: true,
    mirror_readiness: mirrorReadiness,
  }),
  getWeixinProcesses: async () => [],
  hasWxDbMirrorIdentityAnchor: () => true,
  isConfirmedMainWeixinProcess: () => false,
  isWxDbMirrorIdentityVerified: () => true,
  pickAccount: (accounts, requested) => accounts.find(item => item.account_id === requested) || accounts[0] || null,
  preferredWeixinProcess: () => null,
  readWxDbMirrorAccount: async () => {
    mirrorReads += 1;
    if (mirrorReads === 3) {
      autoBindingReadStarted.resolve();
      return autoBindingReadGate.promise;
    }
    return account;
  },
  withWxDbMirrorReadLock: async (_accountId, action) => action(),
  wxDbMirrorScopeRecordsForRead: (_mirror, scope) => String(scope || '').trim().toLowerCase() === 'digest'
    ? [{ key: 'digest', record: { source_snapshot_meta_hash: mirrorReadiness.source_snapshot_meta_hash } }]
    : [],
} });
mock.module(sourceUrl('src/wxkey/index.js'), { namedExports: {
  STANDARD_WEIXIN_KEY_SCAN_MAX_MS: 1000,
  clearLocalWeixinKeyScanCache: () => {},
  currentWxKeyProcessGeneration: async () => ({ process_generation: 'collect-owner-test' }),
  probeWxKey: async () => null,
  scanLocalWeixinKeyCandidates: async () => ({ raw_candidates: [verifiedKey], rawKeys: [verifiedKey], diagnostics: {} }),
} });
mock.module(sourceUrl('src/wxdb/isolated.js'), { namedExports: {
  collectMessagesFromWxDbIsolated: async () => ({
    account,
    messages: [{ id: 'message-1', time: '2026-08-01T00:00:00.000Z', type: 'text', content: 'fixture' }],
    message_count: 1,
    scanned_message_count: 1,
    pre_filter_message_count: 1,
    __verified_raw_keys: [verifiedKey],
    mirror_snapshot: { mirror_readiness: mirrorReadiness },
  }),
  listChatroomsFromWxDbIsolated: async () => [],
  probeWxDbIsolated: async () => ({}),
} });
mock.module(sourceUrl('src/config/settings.js'), { namedExports: {
  loadSettings: async () => ({}),
  manualKeyAccountFingerprint: () => accountFingerprint,
  manualKeysForAccount: () => [],
  splitManualKeys: () => [],
} });
mock.module(sourceUrl('src/config/wxdb-key-cache.js'), { namedExports: {
  rememberVerifiedWxdbKeysForAccount: async () => ({ changed: true, key_count: 1 }),
  verifiedWxdbKeyCacheInvalidInfo: () => null,
  verifiedWxdbKeysForAccount: async () => [],
} });
mock.module(sourceUrl('src/summarizer/llm.js'), { namedExports: {
  redactSecrets: value => String(value ?? ''),
} });

const collector = await import(`${sourceUrl('src/collector/index.js')}?collector-collect-messages-auto-key-owner`);
const controller = new AbortController();
const pending = collector.collectMessages({
  account_id: account.account_id,
  group_id: 'group-1',
  group_name: 'fixture group',
  since: '2026-08-01T00:00',
  until: '2026-08-01T01:00',
  min_messages: 1,
  signal: controller.signal,
});

await autoBindingReadStarted.promise;
controller.abort(new Error('collect caller cancelled'));
autoBindingReadGate.resolve(account);
await assert.rejects(
  pending,
  error => error?.status === 499 || error?.name === 'AbortError',
  'collectMessages 取消后必须拒绝迟到的自动密钥缓存绑定',
);
assert.equal(
  await collector.hasVerifiedAutoRawKeys(account.account_id),
  false,
  '已取消的真实消息读取不得把迟到验证密钥提升为自动缓存能力',
);

console.log('collector collect-messages auto-key owner tests passed');
