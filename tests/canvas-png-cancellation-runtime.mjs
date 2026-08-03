import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const appSource = await fs.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const abortSource = appSource.slice(
  appSource.indexOf('function abortErrorForSignal('),
  appSource.indexOf('function fetchSignalWithTimeout', appSource.indexOf('function abortErrorForSignal(')),
);
const timeoutSource = appSource.slice(
  appSource.indexOf('function browserPngOperationTimeoutError('),
  appSource.indexOf('// Canvas does not expose a way to abort an in-flight toBlob encode.'),
);
const encoderSource = appSource.slice(
  appSource.indexOf('// Canvas does not expose a way to abort an in-flight toBlob encode.'),
  appSource.indexOf('function digestCurrentPngArtifact', appSource.indexOf('function reserveCanvasPngEncodeSlot(')),
);
const { canvasToPngBlob } = new Function(`
  const BROWSER_PNG_OPERATION_TIMEOUT_MS = 120000;
  ${abortSource}
  ${timeoutSource}
  ${encoderSource}
  return { canvasToPngBlob };
`)();

function deferredCanvas() {
  let callback = null;
  let calls = 0;
  return {
    width: 1,
    height: 1,
    get calls() { return calls; },
    toBlob(next) {
      calls += 1;
      callback = next;
    },
    complete(blob = { size: 1 }) {
      assert.ok(callback, 'the test canvas must have an active toBlob callback before completion');
      callback(blob);
    },
  };
}

async function settle() {
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}

{
  const first = deferredCanvas();
  const second = deferredCanvas();
  const controller = new AbortController();
  const firstPromise = canvasToPngBlob(first, { signal: controller.signal, timeoutMs: 1_000 });
  await settle();
  assert.equal(first.calls, 1, 'the first encoder should start immediately');
  controller.abort('取消首个编码');
  await assert.rejects(firstPromise, /取消首个编码/);
  const secondPromise = canvasToPngBlob(second, { timeoutMs: 1_000 });
  await settle();
  assert.equal(second.calls, 0, 'a cancelled caller must not let a second native encoder overlap the first');
  first.complete();
  await settle();
  assert.equal(second.calls, 1, 'the next encoder may start only after the first toBlob callback settles');
  second.complete();
  await secondPromise;
}

{
  const first = deferredCanvas();
  const cancelled = deferredCanvas();
  const third = deferredCanvas();
  const cancelledController = new AbortController();
  const firstPromise = canvasToPngBlob(first, { timeoutMs: 1_000 });
  await settle();
  const cancelledPromise = canvasToPngBlob(cancelled, { signal: cancelledController.signal, timeoutMs: 1_000 });
  cancelledController.abort('取消排队编码');
  await assert.rejects(cancelledPromise, /取消排队编码/);
  const thirdPromise = canvasToPngBlob(third, { timeoutMs: 1_000 });
  await settle();
  assert.equal(cancelled.calls, 0, 'a request cancelled while queued must never invoke toBlob');
  assert.equal(third.calls, 0, 'later work must still wait for the active browser encoder');
  first.complete();
  await settle();
  assert.equal(third.calls, 1, 'releasing the active slot must skip the cancelled queued request');
  third.complete();
  await firstPromise;
  await thirdPromise;
}

{
  const first = deferredCanvas();
  const second = deferredCanvas();
  const timedOut = canvasToPngBlob(first, { timeoutMs: 10 });
  await settle();
  await assert.rejects(timedOut, error => error?.code === 'browser_png_timeout');
  const secondPromise = canvasToPngBlob(second, { timeoutMs: 1_000 });
  await settle();
  assert.equal(second.calls, 0, 'a timed-out caller must keep the native slot until its old callback returns');
  first.complete();
  await settle();
  assert.equal(second.calls, 1, 'the next encoder starts after the timed-out native encode eventually calls back');
  second.complete();
  await secondPromise;
}

console.log('canvas PNG cancellation runtime tests passed');
