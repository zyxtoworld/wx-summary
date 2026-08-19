import assert from 'node:assert/strict';
import { createCrossTabTaskRunner } from '../src/web/public/js/shared/cross-tab-task-runner.js';

function deferred() {
  let resolve;
  const promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
}

function createFakeLocks() {
  const tails = new Map();
  return {
    request(name, _options, callback) {
      const previous = tails.get(name) || Promise.resolve();
      const current = previous.catch(() => {}).then(() => callback({ name }));
      const tracked = current.finally(() => {
        if (tails.get(name) === tracked) tails.delete(name);
      });
      tails.set(name, tracked);
      return current;
    },
  };
}

{
  const locks = createFakeLocks();
  const firstTab = createCrossTabTaskRunner({ locks, namespace: 'local-action' });
  const secondTab = createCrossTabTaskRunner({ locks, namespace: 'local-action' });
  const gate = deferred();
  const order = [];
  let pending = true;

  const first = firstTab.run('action-1', async () => {
    order.push('first-start');
    await gate.promise;
    pending = false;
    order.push('first-end');
    return 'settled';
  }, { shouldRun: () => pending });
  const second = secondTab.run('action-1', async () => {
    order.push('second-ran');
    return 'duplicate';
  }, { shouldRun: () => pending });

  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(order, ['first-start']);
  gate.resolve();
  assert.deepEqual(await first, { ran: true, coordinated: true, value: 'settled' });
  assert.deepEqual(await second, { ran: false, coordinated: true, value: undefined });
  assert.deepEqual(order, ['first-start', 'first-end']);
}

{
  const gate = deferred();
  const runner = createCrossTabTaskRunner({ locks: null, namespace: 'local-action' });
  let calls = 0;
  const first = runner.run('action-2', async () => {
    calls += 1;
    await gate.promise;
    return 'done';
  });
  const second = runner.run('action-2', async () => {
    calls += 1;
    return 'duplicate';
  });
  assert.equal(first, second, 'one tab should reuse its own active recovery promise');
  gate.resolve();
  assert.equal((await first).value, 'done');
  assert.equal(calls, 1);
}

{
  const firstGate = deferred();
  const runner = createCrossTabTaskRunner({ locks: null, namespace: 'local-action' });
  const first = runner.run('action-cancel-queued', async () => {
    await firstGate.promise;
    return 'first';
  }, { dedupe: false });
  const queuedAbort = new AbortController();
  const second = runner.run('action-cancel-queued', async () => 'second', {
    dedupe: false,
    signal: queuedAbort.signal,
  });
  queuedAbort.abort(new DOMException('页面已卸载', 'AbortError'));
  const secondOutcome = await Promise.race([
    second.then(() => 'settled', () => 'settled'),
    new Promise(resolve => setTimeout(() => resolve('still-pending'), 25)),
  ]);
  assert.equal(secondOutcome, 'settled', '无 Web Locks 时排队动作取消必须立即结束,不能等待旧动作');
  const thirdPending = runner.run('action-cancel-queued', async () => 'third', { dedupe: false });
  const thirdBeforeFirst = await Promise.race([
    thirdPending.then(() => 'ran'),
    new Promise(resolve => setTimeout(() => resolve('still-pending'), 25)),
  ]);
  assert.equal(thirdBeforeFirst, 'still-pending', '取消排队动作不得让后续动作越过仍在运行的旧动作');
  firstGate.resolve();
  await first;
  assert.equal((await thirdPending).value, 'third', '旧动作完成后后续本地串行仍应继续');
}

{
  const runner = createCrossTabTaskRunner({ locks: null, namespace: 'local-action' });
  await assert.rejects(
    runner.run('../bad-key', async () => 'no'),
    /任务标识无效/,
  );
}

{
  let calls = 0;
  const locks = {
    request(name, options, callback) {
      assert.equal(name, 'wx-summary:settings-write:mutation');
      assert.equal(options.ifAvailable, true);
      return Promise.resolve(callback(null));
    },
  };
  const runner = createCrossTabTaskRunner({ locks, namespace: 'settings-write' });
  const outcome = await runner.run('mutation', async () => {
    calls += 1;
  }, { ifAvailable: true });
  assert.deepEqual(outcome, { ran: false, coordinated: true, busy: true, value: undefined });
  assert.equal(calls, 0, 'an unavailable cross-tab lock must reject instead of queueing a stale mutation');
}

{
  let held = false;
  const locks = {
    request(name, options, callback) {
      assert.equal(name, 'wx-summary:digest-generation:account-owner');
      assert.equal(options.ifAvailable, true);
      if (held) return Promise.resolve(callback(null));
      held = true;
      return Promise.resolve(callback({ name })).finally(() => { held = false; });
    },
  };
  const first = createCrossTabTaskRunner({ locks, namespace: 'digest-generation' });
  const second = createCrossTabTaskRunner({ locks, namespace: 'digest-generation' });
  const leaseA = await first.acquire('account-owner', { ifAvailable: true });
  assert.equal(leaseA.acquired, true, '第一个生成 owner 必须获得可释放 lease');
  const busy = await second.acquire('account-owner', { ifAvailable: true });
  assert.deepEqual(busy, { acquired: false, coordinated: true, busy: true },
    '第二个标签必须在旧 owner 持有期间立即得到 busy,不能重复创建摘要');
  assert.equal(leaseA.release(), true, '旧 owner 必须能显式释放跨标签 lease');
  await Promise.resolve();
  const leaseB = await second.acquire('account-owner', { ifAvailable: true });
  assert.equal(leaseB.acquired, true, '旧 owner 释放后新标签必须能接管');
  assert.equal(leaseB.release(), true);
}

console.log('cross-tab task runner tests passed');
