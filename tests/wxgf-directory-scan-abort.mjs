import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;
const cancellation = Object.assign(new Error('媒体工具目录扫描已取消'), {
  name: 'AbortError',
  status: 499,
});

let readdirOptions = undefined;
let readdirResolve = null;
let readdirStartedResolve = null;
const readdirStarted = new Promise(resolve => { readdirStartedResolve = resolve; });
const readdirResult = new Promise(resolve => { readdirResolve = resolve; });

mock.module(sourceUrl('src/wxenv/discovery.js'), {
  namedExports: {
    getWeixinProcesses: async () => [{
      pid: 73104,
      path: 'C:\\Program Files\\Weixin\\Weixin.exe',
      command_line: '',
    }],
  },
});
mock.module('node:child_process', {
  namedExports: {
    spawn() {
      throw new Error('media tool process must not start before directory discovery settles');
    },
  },
});
mock.module('node:fs/promises', {
  defaultExport: {
    readdir(_directory, options) {
      readdirOptions = options;
      readdirStartedResolve?.();
      return readdirResult;
    },
    stat: async () => null,
  },
});

const previousFfmpegPath = process.env.FFMPEG_PATH;
process.env.FFMPEG_PATH = 'wxgf-directory-test-ffmpeg';
try {
  const { probeMediaTools } = await import(`${sourceUrl('src/wxdb/wxgf.js')}?directory-scan-abort`);
  const controller = new AbortController();
  const pending = probeMediaTools({ signal: controller.signal });
  await readdirStarted;

  assert.equal(readdirOptions?.withFileTypes, true, '媒体工具探测必须按目录项读取 Weixin 目录');
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  controller.abort(cancellation);
  for (let attempt = 0; attempt < 12 && !settled; attempt += 1) await Promise.resolve();
  assert.equal(settled, true, '目录扫描 pending 时取消必须立即结束媒体工具 owner');
  await assert.rejects(
    pending,
    error => error === cancellation,
    '目录扫描取消必须向真实 probeMediaTools caller 投影调用方 reason',
  );
  readdirResolve?.([]);
} finally {
  if (previousFfmpegPath === undefined) delete process.env.FFMPEG_PATH;
  else process.env.FFMPEG_PATH = previousFfmpegPath;
}

console.log('wxgf directory scan abort tests passed');
