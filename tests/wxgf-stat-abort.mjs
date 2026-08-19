import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new EventEmitter();
    this.stdin.end = () => {};
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  kill() {}
}

const statCalls = [];
let releaseStat;
const pendingStat = new Promise(resolve => { releaseStat = resolve; });

mock.module('node:child_process', {
  namedExports: {
    spawn() {
      const child = new FakeChild();
      queueMicrotask(() => child.emit('close', 1, null));
      return child;
    },
  },
});
mock.module('node:fs/promises', {
  defaultExport: {
    readdir: async () => [],
    stat(candidate) {
      statCalls.push(candidate);
      return pendingStat;
    },
  },
});
mock.module(sourceUrl('src/wxenv/discovery.js'), {
  namedExports: {
    getWeixinProcesses: async () => [{
      pid: 73105,
      path: 'C:\\Weixin\\Weixin.exe',
      command_line: '',
    }],
  },
});
mock.module(sourceUrl('src/wxdb/image-dat.js'), {
  namedExports: { detectImageMime: () => null },
});

const previousFfmpegPath = process.env.FFMPEG_PATH;
process.env.FFMPEG_PATH = 'wxgf-stat-abort-ffmpeg';
try {
  const { probeMediaTools } = await import(`${sourceUrl('src/wxdb/wxgf.js')}?stat-abort`);
  const controller = new AbortController();
  const pending = probeMediaTools({ signal: controller.signal });
  for (let attempt = 0; attempt < 20 && statCalls.length === 0; attempt += 1) {
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.ok(statCalls.length > 0, '媒体工具探测必须进入候选 DLL stat');

  const reason = Object.assign(new Error('媒体工具探测已取消'), {
    name: 'AbortError',
    status: 499,
  });
  controller.abort(reason);
  let settled = false;
  let outcome = null;
  pending.then(
    value => { settled = true; outcome = value; },
    error => { settled = true; outcome = error; },
  );
  for (let attempt = 0; attempt < 12 && !settled; attempt += 1) await Promise.resolve();
  assert.equal(settled, true, '候选 DLL stat 挂起时取消必须有界结束');
  assert.equal(outcome, reason,
    '候选 DLL stat 挂起时取消必须立即向 probeMediaTools 投影 caller reason');
  releaseStat?.(null);
  await pending.catch(() => {});
} finally {
  if (previousFfmpegPath === undefined) delete process.env.FFMPEG_PATH;
  else process.env.FFMPEG_PATH = previousFfmpegPath;
}

console.log('wxgf stat abort tests passed');
