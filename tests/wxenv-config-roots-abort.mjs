import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;
const cancellation = Object.assign(new Error('微信配置目录读取已取消'), {
  name: 'AbortError',
  status: 499,
});

function deferred() {
  let resolve;
  const promise = new Promise(nextResolve => { resolve = nextResolve; });
  return { promise, resolve };
}

let readdirGate = deferred();
let readFileGate = { promise: Promise.resolve('') };
let statGate = { promise: Promise.resolve({ isDirectory: () => true }) };
const startedResolvers = new Map();
const waitForStart = kind => new Promise(resolve => startedResolvers.set(kind, resolve));
const markStarted = kind => {
  const resolve = startedResolvers.get(kind);
  startedResolvers.delete(kind);
  resolve?.();
};

mock.module('node:fs/promises', {
  defaultExport: {
    readdir() {
      markStarted('readdir');
      return readdirGate.promise;
    },
    readFile() {
      markStarted('readFile');
      return readFileGate.promise;
    },
    stat() {
      markStarted('stat');
      return statGate.promise;
    },
  },
});

const discovery = await import(`${sourceUrl('src/wxenv/discovery.js')}?config-roots-abort`);

async function assertCancelled(label, operation, kind, release) {
  const controller = new AbortController();
  const started = waitForStart(kind);
  const pending = operation(controller.signal);
  await started;
  controller.abort(cancellation);
  let settled = false;
  let outcome = null;
  pending.then(
    value => { settled = true; outcome = value; },
    error => { settled = true; outcome = error; },
  );
  for (let attempt = 0; attempt < 12 && !settled; attempt += 1) await Promise.resolve();
  assert.equal(settled, true, `${label}挂起时取消必须有界结束`);
  assert.equal(outcome, cancellation, `${label}取消必须向 caller 投影调用方 reason`);
  release?.();
  await pending.catch(() => {});
}

await assertCancelled(
  '配置目录 readdir',
  signal => discovery.readConfiguredDataRoots({ signal }),
  'readdir',
  () => readdirGate.resolve([]),
);

readdirGate = { promise: Promise.resolve([{ name: 'config.ini', isFile: () => true }]) };
readFileGate = deferred();
await assertCancelled(
  '微信配置文件 readFile',
  signal => discovery.readConfiguredDataRoots({ signal }),
  'readFile',
  () => readFileGate.resolve(''),
);

readdirGate = { promise: Promise.resolve([]) };
statGate = deferred();
await assertCancelled(
  '微信数据根目录 stat',
  signal => discovery.discoverDataRoots({ signal }),
  'stat',
  () => statGate.resolve({ isDirectory: () => true }),
);

console.log('wxenv config roots abort tests passed');
