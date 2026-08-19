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
}

const statCalls = [];
let firstStatResolve;
const firstStat = new Promise(resolve => { firstStatResolve = resolve; });

mock.module('node:child_process', {
  namedExports: {
    spawn() {
      const child = new FakeChild();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('ffmpeg version voip-cache-owner-fixture'));
        child.emit('close', 0, null);
      });
      return child;
    },
  },
});
mock.module('node:fs/promises', {
  defaultExport: {
    readdir: async () => [],
    stat(candidate) {
      statCalls.push(candidate);
      if (statCalls.length === 1) return firstStat;
      if (statCalls.length === 2) return Promise.resolve({ isFile: () => true });
      return Promise.resolve(null);
    },
  },
});
mock.module(sourceUrl('src/wxenv/discovery.js'), {
  namedExports: { getWeixinProcesses: async () => [] },
});
mock.module(sourceUrl('src/wxdb/image-dat.js'), {
  namedExports: { detectImageMime: () => null },
});

const previousFfmpegPath = process.env.FFMPEG_PATH;
const previousVoipPath = process.env.WX_SUMMARY_VOIP_ENGINE;
process.env.FFMPEG_PATH = 'wxgf-voip-cache-ffmpeg';
process.env.WX_SUMMARY_VOIP_ENGINE = 'wxgf-voip-cache-engine.dll';
let first;
let second;
try {
  const { probeMediaTools } = await import(`${sourceUrl('src/wxdb/wxgf.js')}?voip-cache-owner`);
  first = probeMediaTools();
  for (let attempt = 0; attempt < 20 && statCalls.length < 1; attempt += 1) await Promise.resolve();
  assert.equal(statCalls.length, 1, 'A 诊断必须进入 VoIP DLL 检查并保持 pending');

  second = probeMediaTools();
  for (let attempt = 0; attempt < 20 && statCalls.length < 2; attempt += 1) await Promise.resolve();
  assert.equal(statCalls.length, 2, 'B 诊断必须进入独立 VoIP DLL 检查');
  const secondResult = await second;
  assert.equal(secondResult.voip_engine.available, true, 'B 诊断必须确认 VoIP DLL 可用并写入缓存');

  firstStatResolve?.(null);
  const firstResult = await first;
  assert.equal(firstResult.voip_engine.available, false, 'A 诊断夹具必须以未发现 VoIP DLL 结束');

  const statCountBeforeThirdProbe = statCalls.length;
  const thirdResult = await probeMediaTools();
  assert.equal(thirdResult.voip_engine.available, true,
    'A 的迟到未发现结果不得覆盖 B 的可用 VoIP 缓存');
  assert.equal(statCalls.length, statCountBeforeThirdProbe,
    '保留 B 缓存时，后续诊断不得重新检查 VoIP DLL');
} finally {
  firstStatResolve?.(null);
  await Promise.allSettled([first, second].filter(Boolean));
  if (previousFfmpegPath === undefined) delete process.env.FFMPEG_PATH;
  else process.env.FFMPEG_PATH = previousFfmpegPath;
  if (previousVoipPath === undefined) delete process.env.WX_SUMMARY_VOIP_ENGINE;
  else process.env.WX_SUMMARY_VOIP_ENGINE = previousVoipPath;
}

console.log('wxgf VoIP cache owner tests passed');
