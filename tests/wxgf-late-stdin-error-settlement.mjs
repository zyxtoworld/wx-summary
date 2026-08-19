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
    this.pid = 71000 + index;
    this.exitCode = null;
    this.killCount = 0;
    this.stdin = new EventEmitter();
    this.stdin.end = () => {};
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  kill() {
    this.killCount += 1;
    return true;
  }

  finishExit(code = 1) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit('close', code, null);
  }
}

const children = [];
const frameStarted = new Promise(resolve => {
  globalThis.__wxgfFrameStarted = resolve;
});
const activeTimers = new Set();
const previousFfmpegPath = process.env.FFMPEG_PATH;
const previousSetTimeout = globalThis.setTimeout;
const previousClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (callback, delay, ...args) => {
  const handle = {
    delay,
    unref() {},
    callback,
    args,
  };
  activeTimers.add(handle);
  return handle;
};
globalThis.clearTimeout = handle => {
  activeTimers.delete(handle);
};
process.env.FFMPEG_PATH = 'wxgf-late-stdin-error-ffmpeg';

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
        globalThis.__wxgfFrameStarted?.(child);
      }
      return child;
    },
  },
});
mock.module(sourceUrl('src/wxenv/discovery.js'), {
  namedExports: { getWeixinProcesses: async () => [] },
});
mock.module(sourceUrl('src/wxdb/image-dat.js'), {
  namedExports: { detectImageMime: () => 'image/jpeg' },
});

try {
  const { extractVideoFrameToImage } = await import(`${sourceUrl('src/wxdb/wxgf.js')}?late-stdin-error`);
  const pending = extractVideoFrameToImage('fixture.mp4');
  const frameChild = await frameStarted;
  frameChild.stdout.emit('data', Buffer.from('jpeg fixture'));
  frameChild.finishExit(0);
  assert.deepEqual(await pending, { mime: 'image/jpeg', bytes: Buffer.from('jpeg fixture') });
  assert.equal(activeTimers.size, 0, 'successful media completion must clear its timeout timers');

  assert.doesNotThrow(
    () => frameChild.stdin.emit('error', new Error('late stdin error')),
    'late stdin error after successful close must remain handled',
  );
  assert.equal(frameChild.killCount, 0, 'late stdin error must not terminate an already settled child');
  assert.equal(activeTimers.size, 0, 'late stdin error must not create a force-kill timer');
  assert.doesNotThrow(() => frameChild.emit('error', new Error('late child error')));
  assert.doesNotThrow(() => frameChild.emit('close', 1, null));
  assert.equal(frameChild.killCount, 0, 'late child error/close must not create a second terminal action');
  assert.equal(activeTimers.size, 0, 'late child error/close must not create timers');
} finally {
  activeTimers.clear();
  globalThis.setTimeout = previousSetTimeout;
  globalThis.clearTimeout = previousClearTimeout;
  if (previousFfmpegPath === undefined) delete process.env.FFMPEG_PATH;
  else process.env.FFMPEG_PATH = previousFfmpegPath;
  delete globalThis.__wxgfFrameStarted;
}

console.log('wxgf late stdin error settlement tests passed');
