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
      const child = new FakeChild(62000 + children.length);
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
const pending = isolated.collectMessagesFromWxDbIsolated({
  batch_id: 'shutdown-late-result',
  account_id: 'wxacc_0123456789abcdef',
  raw_keys: [],
  mirror_readiness: {
    source_snapshot_meta_hash: 'a'.repeat(64),
    published_manifest_hash: 'b'.repeat(64),
  },
});
const child = children.at(-1);
assert.ok(child, 'the production collect export must create a persistent worker');
const request = child.sent.find(message => message.type === 'collect');
assert.ok(request?.request_id, 'the persistent request must carry a request id');

const shutdown = isolated.closeWxDbIsolatedWorkerAdmission('fixture shutdown');
assert.equal(shutdown.closing, true);
assert.equal(shutdown.cancelled, 1, 'shutdown must claim the active persistent worker');
assert.equal(child.sent.at(-1)?.type, 'close', 'shutdown must ask the persistent worker to close');

child.emit('message', {
  type: 'result',
  request_id: request.request_id,
  result: { messages: [] },
});

await assert.rejects(
  pending,
  error => error?.name === 'AbortError' && error?.code === 'wxdb_worker_shutdown',
  'a result arriving after shutdown admission closes must not resolve the old persistent request',
);

child.finishExit();
await isolated.releaseAllWxDbIsolatedBatchSessions('fixture cleanup');
console.log('wxdb isolated shutdown late-result tests passed');
