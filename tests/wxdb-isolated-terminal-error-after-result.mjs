import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;
const children = [];

class FakeChild extends EventEmitter {
  constructor(pid, { deferSendCallbacks = false } = {}) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.connected = true;
    this.sent = [];
    this.deferSendCallbacks = deferSendCallbacks;
    this.sendCallbacks = [];
    this.stderr = new EventEmitter();
    this.stderr.setEncoding = () => {};
  }

  send(message, callback) {
    this.sent.push(message);
    if (this.deferSendCallbacks) this.sendCallbacks.push(callback);
    else callback?.();
  }

  finishExit() {
    if (this.exitCode === null) this.exitCode = 0;
    this.connected = false;
    this.emit('exit', this.exitCode, null);
    this.emit('close', this.exitCode, null);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const persistStarted = deferred();
const persistGate = deferred();
const terminalErrorPersistStarted = deferred();
const terminalErrorPersistGate = deferred();
let persistCallCount = 0;

mock.module('node:child_process', {
  namedExports: {
    fork() {
      const child = new FakeChild(64000 + children.length, {
        deferSendCallbacks: children.length === 2,
      });
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

mock.module(sourceUrl('src/config/wxdb-key-cache.js'), {
  namedExports: {
    persistedWxdbIdentityShardEvidence: async () => [],
    persistedWxdbIdentityShardEvidenceForAccount: async () => [],
    rememberWxdbIdentityShardEvidenceForAccount: async () => {
      persistCallCount += 1;
      if (persistCallCount === 1) {
        persistStarted.resolve();
        await persistGate.promise;
      } else if (persistCallCount === 2) {
        terminalErrorPersistStarted.resolve();
        await terminalErrorPersistGate.promise;
      }
      return { changed: true, entry_count: 1 };
    },
  },
});

const isolated = await import(`${sourceUrl('src/wxdb/isolated.js')}?terminal-error-after-result`);
const pending = isolated.collectMessagesFromWxDbIsolated({
  batch_id: 'terminal-error-after-result',
  account_id: 'wxacc_0123456789abcdef',
  raw_keys: [],
  mirror_readiness: {
    source_snapshot_meta_hash: 'a'.repeat(64),
    published_manifest_hash: 'b'.repeat(64),
  },
});
const child = children.at(-1);
assert.ok(child, '生产 collect 必须创建独立 worker');
const request = child.sent.find(message => message.type === 'collect');
assert.ok(request?.request_id, 'worker 请求必须带 request_id');

child.emit('message', {
  type: 'result',
  request_id: request.request_id,
  result: { messages: [] },
  identity_shard_evidence_cache_entries: [{ account_id: 'wxacc_0123456789abcdef' }],
});
await persistStarted.promise;
assert.ok(child.listenerCount('error') >= 1, 'the request must still own a child error listener while evidence persistence is pending');

// terminal IPC 已经交付结果；随后 transport error 不应夺走已经到达的结果。
child.exitCode = 0;
child.connected = false;
child.on('error', () => {});
child.emit('error', new Error('late child transport error'));
persistGate.resolve();

const result = await pending;
assert.deepEqual(result.messages, [], 'terminal result must remain authoritative after a late child error');

child.finishExit();
await isolated.releaseAllWxDbIsolatedBatchSessions('fixture cleanup');

const terminalWorkerErrorPending = isolated.collectMessagesFromWxDbIsolated({
  batch_id: 'terminal-worker-error-after-error',
  account_id: 'wxacc_0123456789abcdef',
  raw_keys: [],
  mirror_readiness: {
    source_snapshot_meta_hash: 'a'.repeat(64),
    published_manifest_hash: 'e'.repeat(64),
  },
});
const terminalWorkerErrorChild = children.at(-1);
const terminalWorkerErrorRequest = terminalWorkerErrorChild.sent.find(message => message.type === 'collect');
assert.ok(terminalWorkerErrorRequest?.request_id);
terminalWorkerErrorChild.emit('message', {
  type: 'error',
  request_id: terminalWorkerErrorRequest.request_id,
  error: { message: 'terminal worker error', code: 'terminal_worker_error', status: 502 },
  identity_shard_evidence_cache_entries: [{ account_id: 'wxacc_0123456789abcdef' }],
});
await terminalErrorPersistStarted.promise;
terminalWorkerErrorChild.on('error', () => {});
terminalWorkerErrorChild.emit('error', new Error('terminal IPC error 后迟到的 transport error'));
terminalErrorPersistGate.resolve();
await assert.rejects(
  terminalWorkerErrorPending,
  error => error?.code === 'terminal_worker_error' && error?.message === 'terminal worker error',
  'terminal IPC error 在证据持久化期间收到迟到 child error 时，必须保留原 worker error',
);
terminalWorkerErrorChild.finishExit();
await isolated.releaseAllWxDbIsolatedBatchSessions('fixture cleanup');

const sendErrorPending = isolated.collectMessagesFromWxDbIsolated({
  batch_id: 'terminal-send-error-after-result',
  account_id: 'wxacc_0123456789abcdef',
  raw_keys: [],
  mirror_readiness: {
    source_snapshot_meta_hash: 'a'.repeat(64),
    published_manifest_hash: 'd'.repeat(64),
  },
});
const sendErrorChild = children.at(-1);
const sendErrorRequest = sendErrorChild.sent.find(message => message.type === 'collect');
assert.ok(sendErrorRequest?.request_id);
assert.equal(sendErrorChild.deferSendCallbacks, true, '测试必须使用迟到 send callback 夹具');
assert.equal(sendErrorChild.sendCallbacks.length, 1, 'worker 请求必须保留待触发的 send callback');
sendErrorChild.emit('message', {
  type: 'result',
  request_id: sendErrorRequest.request_id,
  result: { messages: [] },
});
sendErrorChild.sendCallbacks[0]?.(new Error('terminal result 后迟到的 IPC send error'));
const sendErrorResult = await sendErrorPending;
assert.deepEqual(sendErrorResult.messages, [],
  'terminal result 后迟到的 send error 不得夺走已交付结果');
sendErrorChild.finishExit();
await isolated.releaseAllWxDbIsolatedBatchSessions('fixture cleanup');

const ordinaryPending = isolated.collectMessagesFromWxDbIsolated({
  batch_id: 'ordinary-terminal-error',
  account_id: 'wxacc_0123456789abcdef',
  raw_keys: [],
  mirror_readiness: {
    source_snapshot_meta_hash: 'a'.repeat(64),
    published_manifest_hash: 'c'.repeat(64),
  },
});
const ordinaryChild = children.at(-1);
const ordinaryRequest = ordinaryChild.sent.find(message => message.type === 'collect');
assert.ok(ordinaryRequest?.request_id);
ordinaryChild.exitCode = 0;
ordinaryChild.connected = false;
ordinaryChild.on('error', () => {});
ordinaryChild.emit('error', new Error('ordinary child transport error'));
await assert.rejects(ordinaryPending, /ordinary child transport error/,
  '没有 terminal IPC 时普通 child error 仍必须失败');
ordinaryChild.finishExit();
await isolated.releaseAllWxDbIsolatedBatchSessions('fixture cleanup');
console.log('wxdb isolated terminal error after result tests passed');
