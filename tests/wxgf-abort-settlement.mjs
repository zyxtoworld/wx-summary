import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;

class FakeChild extends EventEmitter {
  constructor(index) {
    super();
    this.pid = 70000 + index;
    this.exitCode = null;
    this.killCount = 0;
    this.stdin = new EventEmitter();
    this.stdin.end = () => {};
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  kill() {
    this.killCount += 1;
    // 模拟操作系统/外部子进程忽略 kill，直到测试显式发出 close。
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
  const promise = new Promise(nextResolve => { resolve = nextResolve; });
  return { promise, resolve };
}

const children = [];
const frameStarted = deferred();
const previousFfmpegPath = process.env.FFMPEG_PATH;
const previousSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay === 1500) {
    queueMicrotask(() => callback(...args));
    const timer = previousSetTimeout(() => {}, 60_000);
    timer.unref?.();
    return timer;
  }
  return previousSetTimeout(callback, delay, ...args);
};
process.env.FFMPEG_PATH = 'wxgf-test-ffmpeg';

mock.module('node:child_process', {
  namedExports: {
    spawn() {
      const child = new FakeChild(children.length);
      children.push(child);
      if (children.length === 1) {
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from('ffmpeg version fixture'));
          child.finishExit(0);
        });
      } else {
        frameStarted.resolve(child);
      }
      return child;
    },
  },
});
mock.module(sourceUrl('src/wxenv/discovery.js'), {
  namedExports: { getWeixinProcesses: async () => [] },
});
mock.module(sourceUrl('src/wxdb/image-dat.js'), {
  namedExports: { detectImageMime: () => null },
});

const { extractVideoFrameToImage } = await import(`${sourceUrl('src/wxdb/wxgf.js')}?abort-settlement`);
const controller = new AbortController();
const pending = extractVideoFrameToImage('fixture.mp4', { signal: controller.signal });
const frameChild = await frameStarted.promise;
const reason = Object.assign(new Error('媒体读取已取消'), { name: 'AbortError', status: 499 });
controller.abort(reason);

let outcome = 'pending';
try {
  outcome = await Promise.race([
    pending.then(() => 'resolved', error => error),
    new Promise(resolve => setTimeout(() => resolve('timed_out'), 100)),
  ]);
  assert.equal(outcome, reason, '子进程忽略 kill 时，媒体解码必须在取消后有界 reject 原因');
} finally {
  frameChild.finishExit(1);
  await pending.catch(() => {});
  globalThis.setTimeout = previousSetTimeout;
  if (previousFfmpegPath === undefined) delete process.env.FFMPEG_PATH;
  else process.env.FFMPEG_PATH = previousFfmpegPath;
}

assert.equal(frameChild.killCount >= 1, true, '取消必须先请求终止媒体子进程');
console.log('wxgf abort settlement tests passed');
