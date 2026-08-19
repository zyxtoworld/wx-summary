import assert from 'node:assert/strict';
import { canvasToPngBlob } from '../src/web/public/js/shared/canvas-png.js';

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
      assert.ok(callback, '测试画布必须已有进行中的 toBlob 回调');
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
  const firstResult = canvasToPngBlob(first, { signal: controller.signal, timeoutMs: 1_000 })
    .then(value => ({ value }), error => ({ error }));
  await settle();
  assert.equal(first.calls, 1, '第一个编码必须立即开始');

  controller.abort('取消首个编码');
  const secondPromise = canvasToPngBlob(second, { timeoutMs: 1_000 });
  await settle();
  assert.equal(second.calls, 0, '调用方取消后仍须等原生回调，不能并发启动第二个编码');

  const firstOutcome = await firstResult;
  assert.equal(firstOutcome.error?.name, 'AbortError');
  assert.equal(firstOutcome.error?.status, 499);
  assert.match(firstOutcome.error?.message || '', /取消首个编码/);
  first.complete();
  await settle();
  assert.equal(second.calls, 1, '原生回调结束后才可放行下一项');
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
  const cancelledPromise = canvasToPngBlob(cancelled, {
    signal: cancelledController.signal,
    timeoutMs: 1_000,
  });
  cancelledController.abort(new Error('取消排队编码'));
  await assert.rejects(cancelledPromise, error => {
    assert.equal(error?.name, 'AbortError');
    assert.equal(error?.status, 499);
    return true;
  });
  const thirdPromise = canvasToPngBlob(third, { timeoutMs: 1_000 });
  await settle();
  assert.equal(cancelled.calls, 0, '排队时取消的任务绝不能调用 toBlob');
  assert.equal(third.calls, 0, '后续任务仍须等待当前原生编码');
  first.complete();
  await settle();
  assert.equal(third.calls, 1, '队列必须跳过已取消项并继续运行');
  third.complete();
  await firstPromise;
  await thirdPromise;
}

{
  const timedOutCanvas = deferredCanvas();
  const nextCanvas = deferredCanvas();
  const timedOut = canvasToPngBlob(timedOutCanvas, { timeoutMs: 10 });
  await settle();
  await assert.rejects(timedOut, error => error?.code === 'browser_png_timeout');
  const nextPromise = canvasToPngBlob(nextCanvas, { timeoutMs: 1_000 });
  await settle();
  assert.equal(nextCanvas.calls, 0, '调用方超时后也必须保留原生编码槽位');
  timedOutCanvas.complete();
  await settle();
  assert.equal(nextCanvas.calls, 1, '超时编码的原生回调到达后才能放行下一项');
  nextCanvas.complete();
  await nextPromise;
}

await assert.rejects(
  canvasToPngBlob({ width: 0, height: 1, toBlob() {} }),
  /还没有渲染完成/,
);

{
  const canvas = deferredCanvas();
  const controller = new AbortController();
  const reason = Object.freeze(new DOMException('冻结的取消原因', 'AbortError'));
  controller.abort(reason);
  await assert.rejects(canvasToPngBlob(canvas, { signal: controller.signal }), error => {
    assert.equal(error?.name, 'AbortError');
    assert.equal(error?.status, 499, '冻结的 DOMException 也必须归一化为取消终态');
    assert.match(error?.message || '', /冻结的取消原因/);
    return true;
  });
  assert.equal(canvas.calls, 0);
}

console.log('web digest cancellation tests passed');
