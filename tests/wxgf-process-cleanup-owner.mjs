import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;

class FakeChild extends EventEmitter {
  constructor(index, { initialKill = 'true', forceKill = 'true' } = {}) {
    super();
    this.pid = 74000 + index;
    this.exitCode = null;
    this.signalCode = null;
    this.initialKill = initialKill;
    this.forceKill = forceKill;
    this.killCalls = [];
    this.stdin = new EventEmitter();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin.end = () => {};
  }

  kill(signal) {
    this.killCalls.push(signal || 'SIGTERM');
    const mode = signal === 'SIGKILL' ? this.forceKill : this.initialKill;
    if (mode === 'throw') throw new Error(`${signal || 'SIGTERM'} kill failed`);
    if (mode === 'false') return false;
    return true;
  }

  finishExit(code = 1) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit('close', code, null);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const timerEntries = [];
const previousSetTimeout = globalThis.setTimeout;
const previousClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (callback, delay, ...args) => {
  const entry = { callback, delay, args, cleared: false };
  timerEntries.push(entry);
  return { entry, unref() {}, ref() {} };
};
globalThis.clearTimeout = handle => {
  if (handle?.entry) handle.entry.cleared = true;
};

let cleanupMode = 'resolved-unconfirmed';
let cleanupGate = null;
let cleanupCalls = 0;
let currentFrameStarted = null;
let currentFrameConfig = null;
const children = [];
const previousFfmpegPath = process.env.FFMPEG_PATH;
process.env.FFMPEG_PATH = 'wxgf-process-cleanup-owner-ffmpeg';

mock.module('node:child_process', {
  namedExports: {
    spawn(_file, args) {
      const isProbe = args.includes('-version');
      const child = new FakeChild(children.length, currentFrameConfig || {});
      children.push(child);
      if (isProbe) {
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from('ffmpeg version fixture'));
          child.finishExit(0);
        });
      } else {
        currentFrameStarted?.resolve(child);
      }
      return child;
    },
  },
});

mock.module(sourceUrl('src/lib/windows-process-tree.js'), {
  namedExports: {
    terminateWindowsProcessTree(child, options = {}) {
      cleanupCalls += 1;
      const attempt = () => {
        try {
          const result = child.kill('SIGKILL');
          options.onKillAttempt?.({ phase: 'force', result });
        } catch (error) {
          options.onKillAttempt?.({ phase: 'force', error });
        }
      };
      if (cleanupMode === 'pending') return cleanupGate.promise;
      attempt();
      return Promise.resolve({
        pid: child.pid,
        terminated: cleanupMode === 'resolved-confirmed',
        cleanup: Promise.resolve(),
        identity_bound: true,
      });
    },
  },
});

mock.module(sourceUrl('src/wxenv/discovery.js'), {
  namedExports: { getWeixinProcesses: async () => [] },
});
mock.module(sourceUrl('src/wxdb/image-dat.js'), {
  namedExports: { detectImageMime: bytes => bytes?.length ? 'image/jpeg' : null },
});

const { extractVideoFrameToImage } = await import(`${sourceUrl('src/wxdb/wxgf.js')}?process-cleanup-owner`);

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function fireTimers(delay) {
  const pending = timerEntries.filter(entry => !entry.cleared && entry.delay === delay);
  assert.equal(pending.length, 1, `expected one ${delay}ms timer`);
  for (const entry of pending) {
    entry.cleared = true;
    entry.callback(...entry.args);
  }
}

async function startFrame(config = {}) {
  currentFrameConfig = config;
  currentFrameStarted = deferred();
  const controller = new AbortController();
  const pending = extractVideoFrameToImage('fixture.mp4', { signal: controller.signal });
  const child = await currentFrameStarted.promise;
  currentFrameStarted = null;
  return { controller, pending, child };
}

async function expectUnconfirmedTermination(config) {
  cleanupMode = 'resolved-unconfirmed';
  cleanupGate = null;
  const { controller, pending, child } = await startFrame(config);
  const cancellation = Object.assign(new Error('媒体读取已取消'), { name: 'AbortError', status: 499 });
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  controller.abort(cancellation);
  await flush();
  assert.equal(settled, false, '进程 cleanup 未完成前 Promise 不得结算');

  fireTimers(1500);
  let observed;
  try {
    await pending;
  } catch (error) {
    observed = error;
  }
  assert.equal(observed, cancellation, '取消必须保留 caller reason');
  assert.equal(cleanupCalls >= 1, true, '终止必须交给共享进程树 owner');
  assert.equal(child.killCalls.length, 2, '应先请求正常终止，再执行一次 force kill');
  assert.equal(child.stdout.listenerCount('data'), 0, '结算前必须移除 stdout 业务 listener');
  assert.equal(child.stderr.listenerCount('data'), 0, '结算前必须移除 stderr 业务 listener');
  assert.equal(child.listenerCount('close'), 0, '未确认退出后不得保留 close 业务 listener');
  assert.equal(observed.cleanup_confirmed, false, '未确认退出不得伪称 cleanup 已完成');
  assert.ok(observed.cleanup_cause || observed.cleanup_errors?.length, 'kill 失败必须保留可审计 cause');
  const killCount = child.killCalls.length;
  assert.doesNotThrow(() => {
    child.stdout.emit('data', Buffer.from('late-data'));
    child.stderr.emit('data', Buffer.from('late-error'));
    child.stdout.emit('error', new Error('late stdout error'));
    child.stderr.emit('error', new Error('late stderr error'));
    child.emit('error', new Error('late child error'));
    child.stdin.emit('error', new Error('late stdin error'));
  }, '未确认退出后的迟到错误必须由有界 drain 接住');
  assert.equal(child.killCalls.length, killCount, '迟到事件不得再次触发 kill');
}

for (const initialKill of ['false', 'throw']) {
  for (const forceKill of ['false', 'throw']) {
    await expectUnconfirmedTermination({ initialKill, forceKill });
  }
}

cleanupMode = 'pending';
cleanupGate = deferred();
const pendingCleanup = await startFrame({ initialKill: 'true', forceKill: 'true' });
const pendingReason = new Error('等待进程 cleanup');
let pendingSettled = false;
pendingCleanup.pending.then(() => { pendingSettled = true; }, () => { pendingSettled = true; });
pendingCleanup.controller.abort(pendingReason);
await flush();
fireTimers(1500);
await flush();
assert.equal(pendingSettled, false, '进程树 owner 尚未返回时不得提前结算请求');
cleanupGate.resolve({ pid: pendingCleanup.child.pid, terminated: false, cleanup: Promise.resolve(), identity_bound: true });
await assert.rejects(pendingCleanup.pending, error => error === pendingReason && error.cleanup_confirmed === false);

cleanupMode = 'pending';
cleanupGate = deferred();
const confirmedClose = await startFrame({ initialKill: 'true', forceKill: 'true' });
const confirmedReason = new Error('关闭前取消');
confirmedClose.controller.abort(confirmedReason);
await flush();
fireTimers(1500);
confirmedClose.child.finishExit(1);
await assert.rejects(confirmedClose.pending, error => error === confirmedReason && error.cleanup_confirmed === true);
cleanupGate.resolve({ pid: confirmedClose.child.pid, terminated: false, cleanup: Promise.resolve(), identity_bound: true });
await flush();
assert.equal(confirmedClose.child.listenerCount('close'), 0, '确认 close 后 owner listener 必须只清理一次');

cleanupMode = 'resolved-confirmed';
cleanupGate = null;
const normal = await startFrame({ initialKill: 'true', forceKill: 'true' });
normal.child.stdout.emit('data', Buffer.from('jpeg bytes'));
normal.child.finishExit(0);
const normalResult = await normal.pending;
assert.equal(normalResult?.mime, 'image/jpeg', '确认正常 close 仍须返回帧');
assert.equal(normal.child.listenerCount('close'), 0, '正常 close 必须清理 close listener');
assert.equal(normal.child.stdout.listenerCount('data'), 0, '正常 close 必须清理 stdout listener');

globalThis.setTimeout = previousSetTimeout;
globalThis.clearTimeout = previousClearTimeout;
if (previousFfmpegPath === undefined) delete process.env.FFMPEG_PATH;
else process.env.FFMPEG_PATH = previousFfmpegPath;

console.log('wxgf process cleanup owner tests passed');
