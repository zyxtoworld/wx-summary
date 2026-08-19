import assert from 'node:assert/strict';
import {
  browserClipboardWriteOutcomeUnknown,
  submitBrowserClipboardWrite,
  submitBrowserClipboardWriteLocked,
} from '../src/web/public/js/shared/clipboard-write-coordinator.js';

let timeoutResolve;
const timeoutOperation = new Promise(resolve => { timeoutResolve = resolve; });
await assert.rejects(
  submitBrowserClipboardWrite(() => timeoutOperation, { timeoutMs: 5, action: '复制文本' }),
  error => {
    assert.equal(browserClipboardWriteOutcomeUnknown(error), true);
    assert.equal(error.clipboard_write_submitted, true);
    return true;
  },
  'a timed-out browser write must remain outcome-unknown instead of falling back immediately',
);
timeoutResolve('late completion');
await new Promise(resolve => setImmediate(resolve));

await assert.rejects(
  () => submitBrowserClipboardWriteLocked(() => Promise.resolve(), { lockManager: null }),
  error => error?.code === 'BROWSER_CLIPBOARD_LOCK_UNAVAILABLE',
  'without a cross-tab lock the caller must stop rather than allow a late old write to overwrite a new one',
);

// 等待另一标签释放锁时，页面卸载/动作失效也必须能取消自己的等待。
// 不能等到锁最终释放后才发现 signal 已取消，否则结果操作会长期占用页面忙态。
{
  const controller = new AbortController();
  const reason = new DOMException('页面已卸载', 'AbortError');
  let seenOptions = null;
  let operationCalls = 0;
  const lockManager = {
    request(_name, options) {
      seenOptions = options;
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    },
  };
  const queued = submitBrowserClipboardWriteLocked(
    () => {
      operationCalls += 1;
      return Promise.resolve();
    },
    { lockManager, signal: controller.signal, timeoutMs: 1000, action: '复制图片' },
  );
  controller.abort(reason);
  const outcome = await Promise.race([
    queued.then(
      value => ({ kind: 'fulfilled', value }),
      error => ({ kind: 'rejected', error }),
    ),
    new Promise(resolve => setTimeout(() => resolve({ kind: 'timeout' }), 50)),
  ]);
  assert.notEqual(outcome.kind, 'timeout', '排队等跨标签锁时取消必须立即结束调用者等待');
  assert.equal(outcome.kind, 'rejected');
  assert.equal(outcome.error?.name, 'AbortError');
  assert.strictEqual(seenOptions?.signal, controller.signal,
    '跨标签锁请求必须继承调用者 signal');
  assert.equal(operationCalls, 0, '取消排队的动作不得进入浏览器原生写入');
}

let firstResolve;
const first = submitBrowserClipboardWrite(() => new Promise(resolve => { firstResolve = resolve; }), { timeoutMs: 1000 });
assert.throws(
  () => submitBrowserClipboardWrite(() => Promise.resolve(), { timeoutMs: 20 }),
  error => error?.code === 'BROWSER_CLIPBOARD_WRITE_PENDING',
  'a second browser write must be rejected while the first native operation is unresolved',
);
firstResolve('committed');
assert.equal(await first, 'committed');

console.log('clipboard fallback contract passed');
