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
    this.index = index;
    this.stdin = new EventEmitter();
    this.stdin.end = () => {};
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killCount = 0;
  }

  kill() {
    this.killCount += 1;
    return true;
  }
}

const children = [];
let firstSpawnResolve;
const firstSpawned = new Promise(resolve => { firstSpawnResolve = resolve; });
let secondSpawnResolve;
const secondSpawned = new Promise(resolve => { secondSpawnResolve = resolve; });

mock.module('node:child_process', {
  namedExports: {
    spawn() {
      const child = new FakeChild(children.length);
      children.push(child);
      if (children.length === 1) firstSpawnResolve(child);
      if (children.length === 2) {
        secondSpawnResolve(child);
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from('ffmpeg version cache-owner-fixture'));
          child.emit('close', 0, null);
        });
      } else if (children.length >= 3) {
        queueMicrotask(() => child.emit('close', 1, null));
      }
      return child;
    },
  },
});
mock.module('node:fs/promises', {
  defaultExport: {
    readdir: async () => [],
    stat: async () => null,
  },
});
mock.module(sourceUrl('src/wxenv/discovery.js'), {
  namedExports: { getWeixinProcesses: async () => [] },
});
mock.module(sourceUrl('src/wxdb/image-dat.js'), {
  namedExports: { detectImageMime: () => null },
});

const previousFfmpegPath = process.env.FFMPEG_PATH;
process.env.FFMPEG_PATH = 'wxgf-cache-owner-ffmpeg';
try {
  const { probeMediaTools } = await import(`${sourceUrl('src/wxdb/wxgf.js')}?probe-cache-owner`);
  const first = probeMediaTools();
  const firstChild = await firstSpawned;
  const second = probeMediaTools();
  await secondSpawned;

  const secondResult = await second;
  assert.equal(secondResult.ffmpeg.available, true, 'B 诊断必须先确认可用媒体工具并写入缓存');

  firstChild.emit('close', 1, null);
  const firstResult = await first;
  assert.equal(firstResult.ffmpeg.available, false, 'A 诊断夹具必须以普通探测失败结束');

  const spawnCountBeforeThirdProbe = children.length;
  const thirdResult = await probeMediaTools();
  assert.equal(thirdResult.ffmpeg.available, true, 'A 的迟到失败不得覆盖 B 的可用媒体工具缓存');
  assert.equal(children.length, spawnCountBeforeThirdProbe,
    '保留 B 缓存时，后续诊断不得重新启动 ffmpeg 探测进程');
} finally {
  for (const child of children) child.emit('close', 1, null);
  if (previousFfmpegPath === undefined) delete process.env.FFMPEG_PATH;
  else process.env.FFMPEG_PATH = previousFfmpegPath;
}

console.log('wxgf probe cache owner tests passed');
