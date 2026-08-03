import assert from 'node:assert/strict';
import { createCrossTabTaskRunner } from '../src/web/public/js/cross-tab-task-runner.js';

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

console.log('cross-tab task runner tests passed');
