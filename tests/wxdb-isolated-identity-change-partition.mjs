import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
      const child = new FakeChild(64000 + children.length);
      children.push(child);
      return child;
    },
    spawn() {
      throw new Error('spawn must not be used by this isolated-worker contract');
    },
    execFile() {
      throw new Error('execFile must not be used by this isolated-worker contract');
    },
  },
});

const isolated = await import(
  pathToFileURL(path.join(root, 'src', 'wxdb', 'isolated.js')).href,
);

const accountA = 'wxacc_aaaaaaaaaaaaaaaa';
const accountB = 'wxacc_bbbbbbbbbbbbbbbb';
const pending = [];

try {
  for (const [batchId, accountId, snapshotHash, manifestHash] of [
    ['identity-change-a', accountA, 'a'.repeat(64), '1'.repeat(64)],
    ['identity-change-a2', accountA, 'c'.repeat(64), '3'.repeat(64)],
    ['identity-change-b', accountB, 'b'.repeat(64), '2'.repeat(64)],
  ]) {
    pending.push(isolated.collectMessagesFromWxDbIsolated({
      batch_id: batchId,
      account_id: accountId,
      raw_keys: [],
      mirror_readiness: {
        source_snapshot_meta_hash: snapshotHash,
        published_manifest_hash: manifestHash,
      },
    }));
  }

  const childA = children[0];
  const childA2 = children[1];
  const childB = children[2];
  assert.ok(childA && childA2 && childB, 'the real isolated collect caller must create one worker per account snapshot');
  const requestA = childA.sent.find(message => message.type === 'collect');
  const requestA2 = childA2.sent.find(message => message.type === 'collect');
  const requestB = childB.sent.find(message => message.type === 'collect');
  assert.ok(requestA?.request_id && requestA2?.request_id && requestB?.request_id, 'each worker request must carry a distinct request id');

  childA.emit('message', {
    type: 'identity_change',
    request_id: requestA.request_id,
    change: {
      storage_id: accountA,
      previous_identity_id: `wxacct_${'1'.repeat(24)}`,
      identity_id: `wxacct_${'2'.repeat(24)}`,
      identity_switched: true,
    },
  });

  assert.equal(
    childB.sent.some(message => message.type === 'close'),
    false,
    'an identity change in account A must not close account B persistent worker',
  );
  assert.equal(
    childA2.sent.some(message => message.type === 'close'),
    true,
    'an identity change in account A must retire another persistent worker for account A',
  );

  childA.emit('message', { type: 'result', request_id: requestA.request_id, result: { messages: [] } });
  childA2.emit('message', { type: 'result', request_id: requestA2.request_id, result: { messages: [] } });
  childB.emit('message', { type: 'result', request_id: requestB.request_id, result: { messages: [] } });
  await Promise.all(pending);
} finally {
  for (const [index, child] of children.entries()) {
    if (child.exitCode === null) {
      const request = child.sent.find(message => message.type === 'collect');
      if (request?.request_id) {
        child.emit('message', { type: 'result', request_id: request.request_id, result: { messages: [] } });
      }
      child.finishExit();
    }
    void index;
  }
  await Promise.allSettled(pending);
  await isolated.releaseAllWxDbIsolatedBatchSessions('fixture cleanup').catch(() => {});
}

console.log('wxdb isolated identity-change partition tests passed');
