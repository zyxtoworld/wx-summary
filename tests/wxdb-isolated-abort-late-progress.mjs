import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;
const accountId = 'wxacc_abcdef0123456789';
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

function deferred() {
  let resolve;
  const promise = new Promise(nextResolve => { resolve = nextResolve; });
  return { promise, resolve };
}

const persistStarted = deferred();
const persistGate = deferred();
mock.module('node:child_process', {
  namedExports: {
    fork() {
      const child = new FakeChild(63000 + children.length);
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
      persistStarted.resolve();
      await persistGate.promise;
      return { changed: true, entry_count: 1 };
    },
  },
});

const isolated = await import(`${sourceUrl('src/wxdb/isolated.js')}?abort-late-progress`);
const controller = new AbortController();
const progress = [];
const pending = isolated.collectMessagesFromWxDbIsolated({
  batch_id: 'abort-late-progress',
  account_id: accountId,
  raw_keys: [],
  signal: controller.signal,
  onProgress: value => progress.push(value),
});
const child = children.at(-1);
assert.ok(child, '生产 collect 必须创建独立 worker');
const request = child.sent.find(message => message.type === 'collect');
assert.ok(request?.request_id, 'worker 请求必须带 request_id');

child.emit('message', {
  type: 'result',
  request_id: request.request_id,
  result: { messages: [] },
  identity_shard_evidence_cache_entries: [{ account_id: accountId }],
});
await persistStarted.promise;
controller.abort(new Error('collector owner cancelled while evidence persistence is pending'));
persistGate.resolve();

await assert.rejects(
  pending,
  error => error?.message === 'collector owner cancelled while evidence persistence is pending',
  '持久化期间取消必须让旧 collect owner 立即失败',
);
assert.equal(
  progress.some(value => value?.phase === 'fetch_worker_done'),
  false,
  '取消后的身份证据持久化晚到不得再投影 worker done 进度',
);

child.finishExit();
await isolated.releaseAllWxDbIsolatedBatchSessions('fixture cleanup');
console.log('wxdb isolated abort late-progress tests passed');
