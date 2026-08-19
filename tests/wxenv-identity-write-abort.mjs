import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;
const fixtureRoot = path.join(root, 'outputs', '.tmp', `wxenv-identity-write-abort-${process.pid}-${Date.now()}`);
const mirrorRoot = path.join(fixtureRoot, 'wxdb-mirror');
const indexPath = path.join(mirrorRoot, 'index.json');
const accountId = 'wxacc_0123456789abcdef';
const cancellation = Object.assign(new Error('身份索引写入已取消'), {
  name: 'AbortError',
  status: 499,
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

const fileHash = 'c'.repeat(64);
const manifest = {
  version: 1,
  target_content_hash_alg: 'sha256',
  files: [{
    relative: 'contact/contact.db',
    kind: 'db',
    bytes: 1,
    sha256: fileHash,
  }],
};
const manifestHash = crypto.createHash('sha256').update(JSON.stringify({
  version: 1,
  files: [{
    kind: 'db',
    relative: 'contact/contact.db',
    bytes: 1,
    mtimeMs: 0,
    ctimeMs: 0,
    birthtimeMs: 0,
    dev: 0,
    ino: 0,
    target_ctimeMs: 0,
    target_birthtimeMs: 0,
    target_dev: 0,
    target_ino: 0,
    sha256: fileHash,
  }],
})).digest('hex');
const sourceGenerationHash = 'e'.repeat(64);
const identitySnapshotHash = 'f'.repeat(64);
const indexJson = {
  accounts: {
    [accountId]: {
      account_id: accountId,
      mirror_segment: accountId,
      published_manifest_hash: manifestHash,
      published_manifest: manifest,
      source_generation_hash: sourceGenerationHash,
      source_scopes: {
        identity: {
          source_snapshot_meta_hash: identitySnapshotHash,
          source_snapshot: { target_content_hash_alg: 'sha256', files: manifest.files },
        },
      },
    },
  },
};

const writeStarted = deferred();
const writeRelease = deferred();
let writeCalls = 0;
const realJsonStore = await import(sourceUrl('src/lib/json-store.js'));

mock.module(sourceUrl('src/lib/paths.js'), {
  namedExports: {
    DATA_DIR: fixtureRoot,
    assertAvailableDiskSpace: async () => {},
    isDiskSpaceError: () => false,
    isInside: inside,
  },
});
mock.module(sourceUrl('src/lib/json-store.js'), {
  namedExports: {
    ...realJsonStore,
    writeJsonAtomic: async (file, value, options) => {
      writeCalls += 1;
      writeStarted.resolve();
      await writeRelease.promise;
      return realJsonStore.writeJsonAtomic(file, value, options);
    },
  },
});

await fsp.mkdir(mirrorRoot, { recursive: true });
await fsp.writeFile(indexPath, JSON.stringify(indexJson, null, 2), 'utf8');

try {
  const discovery = await import(`${sourceUrl('src/wxenv/discovery.js')}?identity-write-abort-${process.pid}`);
  const controller = new AbortController();
  const pending = discovery.recordWxDbMirrorAccountIdentity({
    account_id: accountId,
    self_wxid: 'wxid_identity_write_abort',
    evidence: {
      evidence: 'direct_message_sender_across_independent_peers',
      peer_support: 2,
      matched_peer_tables: 2,
      sampled_message_dbs: ['message_0.db'],
    },
    expected_published_manifest_hash: manifestHash,
    expected_source_generation_hash: sourceGenerationHash,
    expected_identity_snapshot_hash: identitySnapshotHash,
    signal: controller.signal,
  });

  await writeStarted.promise;
  controller.abort(cancellation);
  writeRelease.resolve();

  await assert.rejects(
    pending,
    error => error === cancellation,
    '原子身份索引写入完成前取消，必须把同一 caller reason 投影给调用者',
  );
  assert.equal(writeCalls, 1, '身份索引写入应恰好发生一次');
} finally {
  await fsp.rm(fixtureRoot, { recursive: true, force: true });
}

console.log('wxenv identity write abort tests passed');
