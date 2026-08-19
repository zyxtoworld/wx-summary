import assert from 'node:assert/strict';
import { createSharedRequestLease } from '../src/web/public/js/shared/shared-request-lease.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

{
  const work = deferred();
  const route = new AbortController();
  const lease = createSharedRequestLease({ abortMessage: '群列表读取已取消' });
  const underlying = work.promise.finally(() => lease.settle());
  void underlying.catch(() => {});
  const waiter = lease.wait(underlying, route.signal);
  route.abort(Object.assign(new Error('已离开页面'), { name: 'AbortError' }));
  await assert.rejects(waiter, error => error?.name === 'AbortError');
  assert.equal(lease.signal.aborted, true, 'the last cancelled consumer should abort the shared HTTP request');
  assert.equal(lease.consumerCount, 0);
  work.reject(lease.signal.reason);
  await underlying.catch(() => {});
}

{
  const work = deferred();
  const firstRoute = new AbortController();
  const secondRoute = new AbortController();
  const lease = createSharedRequestLease({ abortMessage: '群列表读取已取消' });
  const underlying = work.promise.finally(() => lease.settle());
  const first = lease.wait(underlying, firstRoute.signal);
  const second = lease.wait(underlying, secondRoute.signal);
  firstRoute.abort(Object.assign(new Error('第一个页面已离开'), { name: 'AbortError' }));
  await assert.rejects(first, error => error?.name === 'AbortError');
  assert.equal(lease.signal.aborted, false, 'one cancelled consumer must not abort work still needed by another consumer');
  assert.equal(lease.consumerCount, 1);
  work.resolve(['group-a']);
  assert.deepEqual(await second, ['group-a']);
  assert.equal(lease.signal.aborted, false, 'normal settlement must not be rewritten as cancellation');
  assert.equal(lease.consumerCount, 0);
}

{
  const work = deferred();
  const lease = createSharedRequestLease({ abortMessage: '缓存已失效' });
  const underlying = work.promise.finally(() => lease.settle());
  void lease.wait(underlying).catch(() => {});
  lease.abort('账号上下文已变化');
  assert.equal(lease.signal.aborted, true, 'cache invalidation should explicitly abort detached shared work');
  assert.match(String(lease.signal.reason?.message || ''), /账号上下文已变化/);
  work.reject(lease.signal.reason);
  await underlying.catch(() => {});
}

console.log('shared request lease tests passed');
