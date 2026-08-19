import assert from 'node:assert/strict';
import realFsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;
const cancellation = Object.assign(new Error('媒体文件读取已取消'), {
  name: 'AbortError',
  status: 499,
});
const mediaFile = path.join(root, 'outputs', '.tmp', 'media', 'abort-read-owner', 'image.dat');
let currentScenarioFile = mediaFile;

let readOptions = undefined;
let readStartedResolve = null;
let readStarted = Promise.resolve();
const armReadBarrier = () => {
  readStarted = new Promise(resolve => { readStartedResolve = resolve; });
};
armReadBarrier();

mock.module('node:fs/promises', {
  defaultExport: {
    ...realFsp,
    lstat: async file => ({
      isFile: () => String(file) === currentScenarioFile,
      isSymbolicLink: () => false,
    }),
    realpath: async file => file,
    stat: async () => ({
      isFile: () => true,
      size: 1,
    }),
    readFile(_file, options) {
      readOptions = options;
      readStartedResolve?.();
      return new Promise((resolve, reject) => {
        const signal = options?.signal;
        if (!signal) return;
        const onAbort = () => reject(Object.assign(new Error('The operation was aborted'), {
          name: 'AbortError',
          code: 'ABORT_ERR',
          cause: signal.reason || cancellation,
        }));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    },
  },
});

const { __wxdbInternals } = await import(`${sourceUrl('src/wxdb/index.js')}?media-read-abort`);
const scenarios = [
  {
    label: '图片',
    file: mediaFile,
    run: (file, signal) => __wxdbInternals.readImageDataUrlIfUsable(file, [], { signal }),
  },
  {
    label: '视频',
    file: mediaFile.replace(/image\.dat$/, 'video.mp4'),
    run: (file, signal) => __wxdbInternals.readVideoFrameDataUrlIfUsable(file, { signal }),
  },
  {
    label: '音频',
    file: mediaFile.replace(/image\.dat$/, 'voice.wav'),
    run: (file, signal) => __wxdbInternals.readAudioDataUrlIfUsable(file, { signal }),
  },
];

for (const scenario of scenarios) {
  currentScenarioFile = scenario.file;
  readOptions = undefined;
  armReadBarrier();
  const controller = new AbortController();
  const pending = scenario.run(scenario.file, controller.signal);
  await readStarted;
  assert.equal(
    readOptions?.signal,
    controller.signal,
    `${scenario.label}临时副本文件读取必须绑定同一 owner AbortSignal`,
  );
  controller.abort(cancellation);
  await assert.rejects(
    pending,
    error => error === cancellation,
    `真实${scenario.label}读取 caller 必须在文件读取取消时投影调用方 reason`,
  );
}

console.log('wxdb media read abort tests passed');
