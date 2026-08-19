import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = `outputs/.tmp/wxdb-isolated-identity-change-evidence-owner-${process.pid}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = fixtureRoot;
process.env.WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR = `${fixtureRoot}/runtime-tmp/wxdb`;

const accountId = 'wxacc_aaaaaaaaaaaaaaaa';
const children = [];

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.connected = true;
    this.sent = [];
    this.stderr = new EventEmitter();
    this.stderr.setEncoding = () => {};
  }

  send(message, callback) {
    this.sent.push(message);
    callback?.();
  }

  finishExit() {
    if (this.exitCode === null) this.exitCode = 0;
    this.connected = false;
    this.emit('exit', this.exitCode, null);
    this.emit('close', this.exitCode, null);
  }
}

mock.module('node:child_process', {
  namedExports: {
    fork() {
      const child = new FakeChild(65000 + children.length);
      children.push(child);
      return child;
    },
    spawn() {
      throw new Error('spawn must not be used by this identity evidence contract');
    },
    execFile() {
      throw new Error('execFile must not be used by this identity evidence contract');
    },
  },
});

const isolated = await import(`${pathToFileURL(path.join(root, 'src', 'wxdb', 'isolated.js')).href}?identity-change-evidence-owner`);
const { createAccountIdentityShardEvidenceCacheEntry } = await import(
  `${pathToFileURL(path.join(root, 'src', 'wxdb', 'index.js')).href}?identity-change-evidence-owner`,
);
const internals = isolated.__wxdbIsolatedInternals;
const evidence = createAccountIdentityShardEvidenceCacheEntry({
  account_id: accountId,
  message_db: 'message_0.db',
  direct_peer_fingerprint: 'a'.repeat(64),
  shard_content_fingerprint: 'b'.repeat(64),
  matched_peer_tables: 2,
  support_by_user: new Map([
    ['wxid_local_self', new Set(['wxid_peer_one', 'wxid_peer_two'])],
  ]),
});
assert.ok(evidence?.cache_key, 'the fixture must create canonical account-bound evidence');

let pending = null;
let child = null;
try {
  assert.equal(internals.rememberAccountIdentityShardEvidenceCacheEntries(accountId, [evidence]), 1);
  assert.equal(internals.accountIdentityShardEvidenceCacheEntriesForWorker(accountId).length, 1);

  pending = isolated.collectMessagesFromWxDbIsolated({
    batch_id: 'identity-change-evidence-owner',
    account_id: accountId,
    raw_keys: [],
    mirror_readiness: {
      source_snapshot_meta_hash: 'c'.repeat(64),
      published_manifest_hash: 'd'.repeat(64),
    },
  });
  child = children.at(-1);
  const request = child?.sent.find(message => message.type === 'collect');
  assert.ok(request?.request_id, 'the real collect caller must send a worker request');

  child.emit('message', {
    type: 'identity_change',
    request_id: request.request_id,
    change: {
      storage_id: accountId,
      previous_identity_id: `wxacct_${'1'.repeat(24)}`,
      identity_id: `wxacct_${'2'.repeat(24)}`,
      identity_switched: true,
    },
  });
  assert.deepEqual(
    internals.accountIdentityShardEvidenceCacheEntriesForWorker(accountId),
    [],
    'identity change must immediately clear the old account evidence cache',
  );

  child.emit('message', {
    type: 'result',
    request_id: request.request_id,
    result: { messages: [] },
    identity_shard_evidence_cache_entries: [evidence],
  });
  await pending;
  assert.deepEqual(
    internals.accountIdentityShardEvidenceCacheEntriesForWorker(accountId),
    [],
    'late terminal evidence from the superseded request must not repopulate the cleared cache',
  );

  child.finishExit();
  await isolated.releaseAllWxDbIsolatedBatchSessions('result fixture cleanup').catch(() => {});

  const errorPending = isolated.collectMessagesFromWxDbIsolated({
    batch_id: 'identity-change-evidence-owner-error',
    account_id: accountId,
    raw_keys: [],
    mirror_readiness: {
      source_snapshot_meta_hash: 'e'.repeat(64),
      published_manifest_hash: 'f'.repeat(64),
    },
  });
  const errorChild = children.at(-1);
  const errorRequest = errorChild?.sent.find(message => message.type === 'collect');
  assert.ok(errorRequest?.request_id, 'the error path must send a worker request');
  errorChild.emit('message', {
    type: 'identity_change',
    request_id: errorRequest.request_id,
    change: {
      storage_id: accountId,
      previous_identity_id: `wxacct_${'2'.repeat(24)}`,
      identity_id: `wxacct_${'3'.repeat(24)}`,
      identity_switched: true,
    },
  });
  errorChild.emit('message', {
    type: 'error',
    request_id: errorRequest.request_id,
    error: { message: 'superseded worker error', status: 409, code: 'identity_changed' },
    identity_shard_evidence_cache_entries: [evidence],
  });
  await assert.rejects(errorPending, error => error?.code === 'identity_changed');
  assert.deepEqual(
    internals.accountIdentityShardEvidenceCacheEntriesForWorker(accountId),
    [],
    'late terminal error evidence must not repopulate the cleared cache either',
  );
  errorChild.finishExit();
} finally {
  if (child?.exitCode === null) child.finishExit();
  await pending?.catch(() => {});
  await isolated.releaseAllWxDbIsolatedBatchSessions('fixture cleanup').catch(() => {});
  internals.clearAccountIdentityShardEvidenceCache(accountId);
  await fsp.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
}

console.log('wxdb isolated identity-change evidence owner tests passed');
