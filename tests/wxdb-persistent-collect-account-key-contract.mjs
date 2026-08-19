import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;
const storageId = 'wxacc_aaaaaaaaaaaaaaaa';
const identityId = 'wxacct_' + 'b'.repeat(24);
const snapshotHash = 'c'.repeat(64);
const manifestHash = 'd'.repeat(64);
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
      throw new Error('spawn must not be used by this persistent-worker contract');
    },
    execFile() {
      throw new Error('execFile must not be used by this persistent-worker contract');
    },
  },
});

const isolated = await import(`${sourceUrl('src/wxdb/isolated.js')}?persistent-collect-account-key-contract`);
const internals = isolated.__wxdbIsolatedInternals;

const descriptorInput = {
  batch_id: 'account-key-contract-batch',
  account_id: storageId,
  mirror_readiness: {
    source_snapshot_meta_hash: snapshotHash,
    published_manifest_hash: manifestHash,
  },
};
const descriptor = internals.persistentCollectWorkerDescriptor('collect', descriptorInput);
assert.equal(descriptor?.account_id, storageId, 'the persistent descriptor must retain the canonical storage account id');
assert.equal(
  internals.persistentCollectWorkerDescriptor('collect', {
    ...descriptorInput,
    account_id: identityId,
  }),
  null,
  'identity_id must never become a persistent worker account key',
);
for (const alias of ['wxid_alias_account', 'legacy-alias-account', 'old-account-id']) {
  assert.equal(
    internals.persistentCollectWorkerDescriptor('collect', { ...descriptorInput, account_id: alias }),
    null,
    `account alias ${alias} must not become a persistent worker account key`,
  );
}
assert.equal(
  internals.persistentCollectWorkerDescriptor('collect', {
    ...descriptorInput,
    mirror_readiness: { source_snapshot_meta_hash: snapshotHash },
  }),
  null,
  'an old descriptor without published-manifest generation must not be reusable',
);

const baseRead = {
  account_id: storageId,
  group_id: 'contract-group',
  since: '2026-08-01 00:00:00',
  until: '2026-08-01 00:01:00',
  raw_keys: [],
  mirror_readiness: {
    source_snapshot_meta_hash: snapshotHash,
    published_manifest_hash: manifestHash,
  },
};
const first = isolated.collectMessagesFromWxDbIsolated({
  ...baseRead,
  batch_id: 'account-key-contract-batch',
});
const firstChild = children[0];
assert.ok(firstChild, 'the real isolated collect caller must create a persistent worker for a canonical storage id');
assert.deepEqual(
  internals.persistentCollectWorkerStatus().map(item => item.account_id),
  [storageId],
  'the live persistent record must be bound to the normalized storage id',
);
const firstRequest = firstChild.sent.find(message => message.type === 'collect');
assert.ok(firstRequest?.request_id, 'the first real collect request must be sent to the persistent worker');
firstChild.emit('message', { type: 'result', request_id: firstRequest.request_id, result: { messages: [] } });
await first;

const second = isolated.collectMessagesFromWxDbIsolated({
  ...baseRead,
  batch_id: 'account-key-contract-batch',
});
assert.equal(children.length, 1, 'an unchanged descriptor must reuse the existing persistent worker');
assert.deepEqual(
  internals.persistentCollectWorkerStatus().map(item => item.account_id),
  [storageId],
  'worker reuse must not rebind the record to identity_id or an alias',
);
const secondRequest = firstChild.sent.filter(message => message.type === 'collect').at(-1);
assert.ok(secondRequest?.request_id, 'the reused worker must receive the second real collect request');
firstChild.emit('message', { type: 'result', request_id: secondRequest.request_id, result: { messages: [] } });
await second;

for (const child of children) {
  if (child.exitCode === null) child.finishExit();
}
await isolated.releaseAllWxDbIsolatedBatchSessions('contract fixture cleanup');

console.log('wxdb persistent collect account-key contract tests passed');
