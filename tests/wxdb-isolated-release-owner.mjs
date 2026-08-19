import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;
const children = [];
let terminationCalls = 0;

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
}

mock.module('node:child_process', { namedExports: {
  fork() {
    const child = new FakeChild(67000 + children.length);
    children.push(child);
    return child;
  },
  spawn() {
    throw new Error('spawn must not be used by the persistent release-owner contract');
  },
  execFile() {
    throw new Error('execFile must not be used by the persistent release-owner contract');
  },
} });
mock.module(sourceUrl('src/lib/windows-process-tree.js'), { namedExports: {
  terminateWindowsProcessTree: async () => {
    terminationCalls += 1;
    return { terminated: false, cleanup: new Promise(() => {}) };
  },
  attachWindowsProcessCleanup: error => error,
  windowsProcessCleanupForError: () => null,
} });

mock.timers.enable({ apis: ['setTimeout'] });
try {
  const isolated = await import(`${sourceUrl('src/wxdb/isolated.js')}?persistent-release-owner`);
  const pendingCollect = isolated.collectMessagesFromWxDbIsolated({
    batch_id: 'release-owner-contract',
    account_id: 'wxacc_0123456789abcdef',
    raw_keys: [],
    mirror_readiness: {
      source_snapshot_meta_hash: 'a'.repeat(64),
      published_manifest_hash: 'b'.repeat(64),
    },
  });
  const child = children.at(-1);
  assert.ok(child, '真实 collect caller 必须创建持久读取 worker');

  const releaseByBatch = isolated.releaseWxDbIsolatedBatchSession('release-owner-contract');
  const releaseByShutdown = isolated.releaseAllWxDbIsolatedBatchSessions('service_shutdown');
  await Promise.resolve();
  assert.equal(child.sent.filter(message => message.type === 'close').length, 1,
    '同一持久 worker 的并发 release 必须共享 close owner，只发送一次 close');

  // Advance each bounded close phase explicitly. Promise microtasks are the
  // barrier between the grace timeout and the force-exit timeout.
  mock.timers.tick(3000);
  await Promise.resolve();
  mock.timers.tick(2000);
  await Promise.resolve();
  mock.timers.tick(3000);
  await Promise.resolve();
  mock.timers.tick(2000);
  await Promise.resolve();
  const [batchResult, shutdownResult] = await Promise.allSettled([releaseByBatch, releaseByShutdown]);
  assert.equal(batchResult.status, 'rejected', '无法确认 child 退出时 batch release 必须保留失败');
  assert.equal(shutdownResult.status, 'rejected', '无法确认 child 退出时 shutdown release 必须保留失败');
  assert.equal(terminationCalls, 1,
    '同一持久 worker 的并发 release 必须只启动一次进程树终止 owner');

  void pendingCollect;
  console.log('wxdb isolated release-owner tests passed');
} finally {
  mock.timers.reset();
}
