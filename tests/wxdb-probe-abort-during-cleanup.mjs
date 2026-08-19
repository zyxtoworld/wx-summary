import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;
const fixtureRoot = path.join(root, 'outputs', '.tmp', `wxdb-probe-cleanup-${process.pid}-${Date.now()}`);
const mirrorRoot = path.join(fixtureRoot, 'wxdb-mirror');
const tempRoot = path.join(fixtureRoot, 'tmp');
const dbStorage = path.join(mirrorRoot, 'wxacc_cleanup_probe', 'db_storage');
const dbPath = path.join(dbStorage, 'contact', 'contact.db');
const sessionPath = path.join(dbStorage, 'session', 'session.db');
const dbBytes = Buffer.concat([Buffer.from('SQLite format 3\0', 'ascii'), Buffer.alloc(128, 0x5a)]);
const dbHash = crypto.createHash('sha256').update(dbBytes).digest('hex');
const sessionBytes = Buffer.concat([Buffer.from('SQLite format 3\0', 'ascii'), Buffer.alloc(96, 0x33)]);
const sessionHash = crypto.createHash('sha256').update(sessionBytes).digest('hex');
const manifestFiles = [
  { relative: 'contact/contact.db', kind: 'db', bytes: dbBytes.length, sha256: dbHash },
  { relative: 'session/session.db', kind: 'db', bytes: sessionBytes.length, sha256: sessionHash },
];
const sourceSnapshotMetaHash = 'a'.repeat(64);
const publishedManifestHash = 'b'.repeat(64);
const cancellation = Object.assign(new Error('数据库探测已取消'), { name: 'AbortError', status: 499 });
const controller = new AbortController();
const progress = [];
let cleanupRemoveCalls = 0;
const cleanupTargets = [];
let activeController = controller;
let abortOnCleanup = true;
const account = {
  account_id: 'wxacc_cleanup_probe',
  id: 'wxacc_cleanup_probe',
  source: 'project-mirror',
  source_status: 'available',
  db_storage: dbStorage,
  mirror: {
    source_status: 'available',
    published_manifest_hash: publishedManifestHash,
    source_scopes: {
      groups: {
        source_snapshot_meta_hash: sourceSnapshotMetaHash,
        source_snapshot: {
          target_content_hash_alg: 'sha256',
          files: manifestFiles,
        },
      },
      full: {
        source_snapshot_meta_hash: sourceSnapshotMetaHash,
        source_snapshot: {
          target_content_hash_alg: 'sha256',
          files: manifestFiles,
        },
      },
    },
  },
};

await fsp.mkdir(path.dirname(dbPath), { recursive: true });
await fsp.mkdir(path.dirname(sessionPath), { recursive: true });
await fsp.mkdir(tempRoot, { recursive: true });
await fsp.writeFile(dbPath, dbBytes);
await fsp.writeFile(sessionPath, sessionBytes);

const realFsp = fsp;
mock.module('node:fs/promises', {
  defaultExport: {
    ...realFsp,
    rm: async (...args) => {
      cleanupRemoveCalls += 1;
      cleanupTargets.push(String(args[0] || ''));
      if (abortOnCleanup && !activeController.signal.aborted) activeController.abort(cancellation);
      return realFsp.rm(...args);
    },
  },
});
mock.module(sourceUrl('src/lib/paths.js'), {
  namedExports: {
    DATA_DIR: fixtureRoot,
    PROJECT_ROOT: fixtureRoot,
    TMP_DIR: tempRoot,
    WXDB_TMP_DIR: tempRoot,
    assertAvailableDiskSpace: async () => {},
    assertSafeTmpPath: async target => {
      const resolved = path.resolve(target);
      await realFsp.mkdir(path.dirname(resolved), { recursive: true });
      return { resolved };
    },
    isDiskSpaceError: () => false,
    isInside: (parent, child) => {
      const relative = path.relative(path.resolve(parent), path.resolve(child));
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    },
    resolveInsideTmp: target => path.resolve(tempRoot, target),
  },
});
mock.module(sourceUrl('src/wxenv/discovery.js'), {
  namedExports: {
    discoverWxAccounts: async () => [account],
    ensureWxDbMirror: async () => ({ reused: true, account_id: account.account_id }),
    getWeixinModuleEvidence: async () => null,
    getWeixinProcesses: async () => [],
    isWxDbMirrorIdentityVerified: () => false,
    listDbFiles: async () => [
      {
        path: dbPath,
        category: 'contact',
        name: 'contact.db',
        bytes: dbBytes.length,
        last_write_time: new Date().toISOString(),
        sidecars: [],
      },
      {
        path: sessionPath,
        category: 'session',
        name: 'session.db',
        bytes: sessionBytes.length,
        last_write_time: new Date().toISOString(),
        sidecars: [],
      },
    ],
    pickAccount: (accounts, accountId) => accounts.find(item => item.account_id === accountId) || null,
    processOwnerState: () => null,
    processStartIdentity: async () => '',
    recordWxDbMirrorAccountIdentity: async () => ({}),
    withWxDbMirrorReadLock: async (_id, action) => action(),
    wxDbMirrorScopeRecordsForRead: (mirror, scope) => {
      const record = mirror?.source_scopes?.[scope];
      return record ? [{ record }] : [];
    },
  },
});
mock.module(sourceUrl('src/wxkey/index.js'), {
  namedExports: {
    allocateSharedProcessScanMs: () => 0,
    orderWeixinProcessesForKeyScan: values => values,
    probeWxKey: async () => ({}),
    scanProcessForCodecContextKeyCandidates: async () => ({}),
    scanProcessForVerifiedWeixinV4DbKeys: async () => ({}),
    shouldPrioritizeWeixinProcessScan: () => false,
    STANDARD_WEIXIN_KEY_SCAN_MAX_MS: 1_000,
  },
});
mock.module(sourceUrl('src/wxdb/image-dat.js'), {
  namedExports: {
    extractPlainImage: () => null,
    validateImageKeyCandidate: () => false,
    weChatV4ValidationSample: () => null,
  },
});
mock.module(sourceUrl('src/wxdb/wxgf.js'), {
  namedExports: {
    decodeWxgfToImage: async () => null,
    extractVideoFrameToImage: async () => null,
    transcodeAudioToWav: async () => null,
  },
});
mock.module(sourceUrl('src/wxdb/identity-scope.js'), {
  namedExports: {
    ACCOUNT_IDENTITY_MAX_MESSAGE_SHARDS: 16,
    accountIdentityMessageShardCandidates: () => [],
  },
});

try {
  const { probeWxDb } = await import(`${sourceUrl('src/wxdb/index.js')}?probe-abort-during-cleanup`);
  let observedResult;
  let observedError;
  try {
    observedResult = await probeWxDb({
      account_id: account.account_id,
      probe_scope: 'groups',
      signal: controller.signal,
      onProgress: event => progress.push(event),
    });
  } catch (error) {
    observedError = error;
  }
  assert.equal(controller.signal.aborted, true, `测试必须在 cleanup 中触发取消（rm=${cleanupRemoveCalls}，phases=${progress.map(event => event.phase).join(',')}，error=${observedError?.code || observedError?.message || 'none'}）`);
  assert.equal(observedError, cancellation, `取消发生在临时副本 cleanup 期间时，probe 必须投影同一 caller cancellation（result=${observedResult ? 'resolved' : 'none'}）`);
  assert.equal(
    progress.some(event => event.phase === 'fetch_key_probe_sample_done'),
    false,
    '取消后的样本不得再投影完成进度',
  );
  assert.equal(progress.filter(event => event.phase === 'fetch_key_probe_sample_start').length, 1,
    '取消后的探测不得启动第二个样本');
  assert.ok(cleanupRemoveCalls >= 1, '取消路径仍必须完成临时副本 cleanup');
  for (const target of cleanupTargets.slice(0, 1)) {
    await assert.rejects(realFsp.stat(target), error => error?.code === 'ENOENT',
      '取消路径 cleanup 必须实际移除已复制的临时目录');
  }

  const normalController = new AbortController();
  const normalProgress = [];
  activeController = normalController;
  abortOnCleanup = false;
  const normalResult = await probeWxDb({
    account_id: account.account_id,
    probe_scope: 'groups',
    signal: normalController.signal,
    onProgress: event => normalProgress.push(event),
  });
  assert.equal(normalController.signal.aborted, false, '未取消路径不得被 cleanup 夹具误取消');
  assert.equal(normalResult.request_completed, true, '未取消路径仍必须完成真实 probe');
  assert.equal(normalProgress.filter(event => event.phase === 'fetch_key_probe_sample_start').length, 2,
    '未取消路径必须继续检查两个样本');
  assert.equal(normalProgress.filter(event => event.phase === 'fetch_key_probe_sample_done').length, 2,
    '未取消路径必须为两个样本投影完成进度');
} finally {
  await realFsp.rm(fixtureRoot, { recursive: true, force: true });
}

console.log('wxdb probe abort during cleanup tests passed');
