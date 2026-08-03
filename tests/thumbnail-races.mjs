import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { TMP_DIR } from '../src/lib/paths.js';
import { __mainInternals } from '../src/main.js';
import { RENDERED_PNG_MAX_BYTES, RENDERED_PNG_MAX_RGBA_BYTES } from '../src/renderer/png-validate.js';
import { __thumbnailInternals, renderDigestThumbnailPng } from '../src/renderer/thumbnail.js';

const TEST_DIR = path.join(TMP_DIR, `thumbnail-races-${process.pid}-${Date.now()}`);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function samplePng(red, green, blue) {
  return __thumbnailInternals.encodeRgbaPng(1, 1, Buffer.from([0, red, green, blue, 255]));
}

function v2Version(stat, data) {
  const fingerprint = [
    stat.size,
    Math.round(stat.mtimeMs * 1000),
    Math.round(stat.ctimeMs * 1000),
  ].join(':');
  return `v2:${fingerprint}:${crypto.createHash('sha256').update(data).digest('hex')}`;
}

function fileStat({ size = 1, mtimeMs = 1, ctimeMs = 1 } = {}) {
  return { size, mtimeMs, ctimeMs, isFile: () => true };
}

assert.equal(
  __thumbnailInternals.thumbnailFileContentStatMatches(fileStat({ ctimeMs: 10 }), fileStat({ ctimeMs: 20 })),
  true,
  'thumbnail reads should tolerate ctime-only metadata churn when bytes and mtime are unchanged',
);
assert.equal(
  __thumbnailInternals.thumbnailFileContentStatMatches(fileStat({ mtimeMs: 10 }), fileStat({ mtimeMs: 20 })),
  false,
  'thumbnail reads must still reject a content-relevant modification time change',
);

assert.equal(typeof __thumbnailInternals.thumbnailSourceMaxBytes, 'function');
assert.equal(typeof __thumbnailInternals.thumbnailSourceMaxRgbaBytes, 'function');
for (const platform of ['win32', 'darwin', 'linux']) {
  assert.equal(
    __thumbnailInternals.thumbnailSourceMaxBytes(platform),
    RENDERED_PNG_MAX_BYTES,
    `${platform} thumbnail admission should use the same compressed PNG limit`,
  );
  assert.equal(
    __thumbnailInternals.thumbnailSourceMaxRgbaBytes(platform),
    RENDERED_PNG_MAX_RGBA_BYTES,
    `${platform} thumbnail admission should use the same decoded RGBA limit`,
  );
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function verifyImmutableSnapshotAcrossPathReplacement() {
  const source = path.join(TEST_DIR, 'source.png');
  const detached = path.join(TEST_DIR, 'source-a.png');
  const snapshotPath = path.join(TEST_DIR, 'snapshot.tmp.png');
  const sourceA = samplePng(220, 20, 30);
  const sourceB = samplePng(10, 180, 90);
  await fsp.writeFile(source, sourceA, { flag: 'wx' });
  const handle = await fsp.open(source, 'r');
  const stat = await handle.stat();
  try {
    await fsp.rename(source, detached);
    await fsp.writeFile(source, sourceB, { flag: 'wx' });
    const snapshot = await __thumbnailInternals.createThumbnailSourceSnapshotFromHandle(
      handle,
      snapshotPath,
      { expectedFileVersion: v2Version(stat, sourceA) },
    );
    assert.deepEqual(await fsp.readFile(snapshot.path), sourceA, 'opened A handle must produce an A snapshot after the path is replaced by B');
    assert.deepEqual(await fsp.readFile(source), sourceB, 'source path should now point at B');
    assert.equal(snapshot.sha256, crypto.createHash('sha256').update(sourceA).digest('hex'));
  } finally {
    await handle.close();
  }
}

async function verifyThumbnailLimitError() {
  const source = path.join(TEST_DIR, 'limit-source.png');
  const snapshot = path.join(TEST_DIR, 'limit-source.snapshot.png');
  await fsp.writeFile(source, samplePng(80, 120, 200), { flag: 'wx' });
  const handle = await fsp.open(source, 'r');
  try {
    await assert.rejects(
      () => __thumbnailInternals.createThumbnailSourceSnapshotFromHandle(handle, snapshot, { maxBytes: 1 }),
      error => error?.code === 'thumbnail_limit_exceeded' && error?.status === 413,
      'thumbnail safety limits must not be reported as renderer failures',
    );
  } finally {
    await handle.close();
  }
}

async function verifySingleFlightAndWaiterCancellation() {
  const gate = deferred();
  let producerCalls = 0;
  const jobs = Array.from({ length: 20 }, () => __thumbnailInternals.joinThumbnailFlight(
    'same-cache-identity',
    null,
    async () => {
      producerCalls += 1;
      return await gate.promise;
    },
  ).promise);
  await waitFor(() => producerCalls === 1, 'single-flight producer did not start');
  assert.equal(producerCalls, 1, 'same cache identity must start exactly one producer');
  gate.resolve('shared-result');
  assert.deepEqual(await Promise.all(jobs), Array(20).fill('shared-result'));
  await waitFor(() => __thumbnailInternals.thumbnailFlightCount() === 0, 'completed flight was not removed');

  const oneGate = deferred();
  let oneProducerSignal = null;
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = __thumbnailInternals.joinThumbnailFlight('one-waiter-cancel', firstController.signal, async signal => {
    oneProducerSignal = signal;
    return await oneGate.promise;
  }).promise;
  const second = __thumbnailInternals.joinThumbnailFlight('one-waiter-cancel', secondController.signal, async () => assert.fail('duplicate producer started')).promise;
  await waitFor(() => oneProducerSignal !== null, 'shared producer did not start');
  firstController.abort(Object.assign(new Error('first waiter cancelled'), { name: 'AbortError' }));
  await assert.rejects(first, error => error?.name === 'AbortError');
  assert.equal(oneProducerSignal.aborted, false, 'cancelling one waiter must not abort a producer still needed by another waiter');
  oneGate.resolve('second-result');
  assert.equal(await second, 'second-result');

  let allProducerSignal = null;
  const allA = new AbortController();
  const allB = new AbortController();
  const producerStopped = deferred();
  const allFirst = __thumbnailInternals.joinThumbnailFlight('all-waiters-cancel', allA.signal, signal => {
    allProducerSignal = signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
      producerStopped.resolve();
      reject(signal.reason);
    }, { once: true }));
  }).promise;
  const allSecond = __thumbnailInternals.joinThumbnailFlight('all-waiters-cancel', allB.signal, async () => assert.fail('duplicate producer started')).promise;
  await waitFor(() => allProducerSignal !== null, 'all-cancel producer did not start');
  allA.abort(Object.assign(new Error('waiter A cancelled'), { name: 'AbortError' }));
  assert.equal(allProducerSignal.aborted, false, 'one remaining waiter must keep the producer alive');
  allB.abort(Object.assign(new Error('waiter B cancelled'), { name: 'AbortError' }));
  await Promise.all([
    assert.rejects(allFirst, error => error?.name === 'AbortError'),
    assert.rejects(allSecond, error => error?.name === 'AbortError'),
    producerStopped.promise,
  ]);
  assert.equal(allProducerSignal.aborted, true, 'the producer must abort after every waiter cancels');
  await waitFor(() => __thumbnailInternals.thumbnailFlightCount() === 0, 'cancelled flight was not removed');
}

async function verifyVersionedRenderCreatesOneSnapshot() {
  const source = path.join(TEST_DIR, 'versioned-source.png');
  const input = samplePng(40, 90, 210);
  await fsp.writeFile(source, input, { flag: 'wx' });
  const stat = await fsp.stat(source);
  const fileVersion = v2Version(stat, input);
  const beforeSnapshots = __thumbnailInternals.thumbnailSourceSnapshotCount();
  const digestId = `race-${Date.now().toString(36)}`;
  const outputs = await Promise.all(Array.from({ length: 20 }, () => renderDigestThumbnailPng({
    filePath: source,
    digestId,
    fileVersion,
    width: 8,
    height: 8,
  })));
  assert.equal(new Set(outputs).size, 1, 'same versioned cache identity must return one cache file');
  assert.equal(
    __thumbnailInternals.thumbnailSourceSnapshotCount() - beforeSnapshots,
    1,
    'same v2 cache identity must create one producer-owned source snapshot',
  );
  await fsp.rm(outputs[0], { force: true });
}

async function verifyPortableWorkerExitBarrier() {
  class FakeWorker extends EventEmitter {
    constructor() {
      super();
      this.termination = deferred();
      this.terminateCalls = 0;
    }

    terminate() {
      this.terminateCalls += 1;
      return this.termination.promise;
    }
  }

  const fake = new FakeWorker();
  const controller = new AbortController();
  let settled = false;
  const workerPromise = __thumbnailInternals.runPortableThumbnailWorker('source', 'output', {
    width: 1,
    height: 1,
    signal: controller.signal,
    timeoutMs: 5000,
    workerFactory: () => fake,
  });
  workerPromise.then(() => { settled = true; }, () => { settled = true; });
  controller.abort(Object.assign(new Error('cancel worker'), { name: 'AbortError' }));
  await waitFor(() => fake.terminateCalls === 1, 'worker terminate was not requested');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(settled, false, 'worker promise must not settle before terminate confirms exit');
  fake.termination.resolve(1);
  await assert.rejects(workerPromise, error => error?.name === 'AbortError');
  assert.equal(settled, true);

  const successful = new FakeWorker();
  let successSettled = false;
  const successPromise = __thumbnailInternals.runPortableThumbnailWorker('source', 'output', {
    width: 1,
    height: 1,
    timeoutMs: 5000,
    workerFactory: () => successful,
  });
  successPromise.then(() => { successSettled = true; }, () => { successSettled = true; });
  successful.emit('message', { ok: true });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(successSettled, false, 'successful message must still wait for worker exit');
  successful.emit('exit', 0);
  assert.equal(await successPromise, 'output');
}

async function verifyWorkerExitBlocksSlotReleaseAndCleanup() {
  class FakeWorker extends EventEmitter {
    constructor() {
      super();
      this.termination = deferred();
    }

    terminate() {
      return this.termination.promise;
    }
  }

  const firstWorker = new FakeWorker();
  const firstController = new AbortController();
  let firstStarted = false;
  let thirdStarted = false;
  let firstCleaned = false;
  const first = __thumbnailInternals.withThumbnailRenderSlot(firstController.signal, async () => {
    firstStarted = true;
    try {
      return await __thumbnailInternals.runPortableThumbnailWorker('source', 'output', {
        width: 1,
        height: 1,
        signal: firstController.signal,
        timeoutMs: 5000,
        workerFactory: () => firstWorker,
      });
    } finally {
      firstCleaned = true;
    }
  });
  const blockerCount = Math.max(0, __thumbnailInternals.thumbnailRenderConcurrency - 1);
  const blockers = Array.from({ length: blockerCount }, () => {
    const gate = deferred();
    let started = false;
    const promise = __thumbnailInternals.withThumbnailRenderSlot(null, async () => {
      started = true;
      return await gate.promise;
    });
    return { gate, promise, started: () => started };
  });
  const third = __thumbnailInternals.withThumbnailRenderSlot(null, async () => {
    thirdStarted = true;
    return 'third-result';
  });
  await waitFor(() => firstStarted && blockers.every(item => item.started()), 'render slots did not reach capacity');
  firstController.abort(Object.assign(new Error('cancel occupied worker slot'), { name: 'AbortError' }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(firstCleaned, false, 'temporary cleanup must wait for worker termination');
  assert.equal(thirdStarted, false, 'queued render must not start while the cancelled worker is still exiting');
  firstWorker.termination.resolve(1);
  await assert.rejects(first, error => error?.name === 'AbortError');
  assert.equal(firstCleaned, true, 'cleanup should run after worker termination completes');
  await waitFor(() => thirdStarted, 'queued render did not start after the worker slot was released');
  assert.equal(await third, 'third-result');
  for (const blocker of blockers) blocker.gate.resolve('blocker-result');
  assert.deepEqual(await Promise.all(blockers.map(item => item.promise)), Array(blockerCount).fill('blocker-result'));
}

function verifyNegativeCachePolicy() {
  __thumbnailInternals.clearThumbnailFailureCache();
  const nondeterministic = [
    Object.assign(new Error('changed'), { code: 'history_file_changed', status: 409 }),
    Object.assign(new Error('timeout'), { code: 'thumbnail_timeout', status: 504 }),
    Object.assign(new Error('quarantined'), { code: 'thumbnail_process_quarantined', status: 503 }),
    Object.assign(new Error('process'), { code: 'thumbnail_failed', status: 500 }),
  ];
  for (const error of nondeterministic) {
    assert.equal(__thumbnailInternals.rememberThumbnailFailure(`no-${error.code}`, error), false, `${error.code} must not enter the negative cache`);
    assert.equal(__thumbnailInternals.cachedThumbnailFailure(`no-${error.code}`), null);
  }
  const invalid = Object.assign(new Error('invalid png'), { code: 'thumbnail_invalid_png', status: 422 });
  assert.equal(__thumbnailInternals.rememberThumbnailFailure('invalid-content', invalid), true);
  assert.equal(__thumbnailInternals.cachedThumbnailFailure('invalid-content')?.code, 'thumbnail_invalid_png');
  __thumbnailInternals.clearThumbnailFailureCache();
}

function verifyQuarantineHttp503() {
  const quarantined = __thumbnailInternals.thumbnailProcessQuarantinedError(4321);
  const response = __mainInternals.thumbnailHttpFailure(quarantined);
  assert.deepEqual(response, {
    status: 503,
    code: 'thumbnail_process_quarantined',
    message: '上一项缩略图渲染进程仍在退出，请稍后重试或点开查看原图',
    retryAfterSeconds: 2,
  });
}

function verifyLimitHttp413() {
  const limit = Object.assign(new Error('too large'), {
    code: 'thumbnail_limit_exceeded',
    public_code: 'thumbnail_limit_exceeded',
    status: 413,
  });
  const response = __mainInternals.thumbnailHttpFailure(limit);
  assert.deepEqual(response, {
    status: 413,
    code: 'thumbnail_limit_exceeded',
    message: '缩略图超出安全范围，请点开查看原图',
    retryAfterSeconds: 0,
  });
}

async function main() {
  await fsp.mkdir(TEST_DIR, { recursive: true });
  try {
    await verifyImmutableSnapshotAcrossPathReplacement();
    await verifyThumbnailLimitError();
    await verifySingleFlightAndWaiterCancellation();
    await verifyVersionedRenderCreatesOneSnapshot();
    await verifyPortableWorkerExitBarrier();
    await verifyWorkerExitBlocksSlotReleaseAndCleanup();
    verifyNegativeCachePolicy();
    verifyQuarantineHttp503();
    verifyLimitHttp413();
    console.log('thumbnail race tests passed');
  } finally {
    const relative = path.relative(path.resolve(TMP_DIR), path.resolve(TEST_DIR));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'test cleanup escaped TMP_DIR');
    await fsp.rm(TEST_DIR, { recursive: true, force: true });
  }
}

await main();
