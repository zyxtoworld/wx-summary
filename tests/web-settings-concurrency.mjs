import assert from 'node:assert/strict';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

class MemoryStorage {
  #values = new Map();
  get length() { return this.#values.size; }
  key(index) { return [...this.#values.keys()][index] ?? null; }
  getItem(key) { return this.#values.get(String(key)) ?? null; }
  setItem(key, value) { this.#values.set(String(key), String(value)); }
  removeItem(key) { this.#values.delete(String(key)); }
}

globalThis.location = new URL('http://wx-summary.test/#/settings');
globalThis.localStorage = new MemoryStorage();

const loader = createBrowserModuleLoader();
const { createSettingsWriteCoordinator, writeSettingsPatch } = await loader.load('js/shared/settings-write-coordinator.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((next, fail) => { resolve = next; reject = fail; });
  return { promise, resolve, reject };
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('操作已取消');
  error.name = 'AbortError';
  return error;
}

function createFakeLockManager() {
  const queues = new Map();
  const active = new Set();

  function pump(name) {
    if (active.has(name)) return;
    const queue = queues.get(name) || [];
    let entry = queue.shift();
    while (entry?.signal?.aborted) {
      entry.reject(abortReason(entry.signal));
      entry = queue.shift();
    }
    if (!entry) {
      queues.delete(name);
      return;
    }
    active.add(name);
    entry.signal?.removeEventListener?.('abort', entry.onAbort);
    Promise.resolve()
      .then(() => entry.callback({ name }))
      .then(entry.resolve, entry.reject)
      .finally(() => {
        active.delete(name);
        pump(name);
      });
  }

  return {
    request(name, options, callback) {
      const signal = options?.signal || null;
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      return new Promise((resolve, reject) => {
        const queue = queues.get(name) || [];
        const entry = { callback, resolve, reject, signal, onAbort: null };
        entry.onAbort = () => {
          const index = queue.indexOf(entry);
          if (index < 0) return;
          queue.splice(index, 1);
          reject(abortReason(signal));
          pump(name);
        };
        signal?.addEventListener?.('abort', entry.onAbort, { once: true });
        queue.push(entry);
        queues.set(name, queue);
        pump(name);
      });
    },
  };
}

function waitForAbort(signal) {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(abortReason(signal)), { once: true });
  });
}

const locks = createFakeLockManager();

{
  const settingsTab = createSettingsWriteCoordinator({ locks });
  const setupTab = createSettingsWriteCoordinator({ locks });
  const firstGate = deferred();
  const order = [];
  let authoritativeRevision = 'rev-1';

  const settingsApi = {
    get: async path => {
      assert.equal(path, '/api/settings?wait_for_writes=1');
      return { settings_revision: authoritativeRevision };
    },
    request: async (path, options) => {
      assert.equal(path, '/api/settings');
      assert.equal(options.method, 'PUT');
      order.push(`settings-start:${options.body.base_settings_revision}`);
      await firstGate.promise;
      authoritativeRevision = 'rev-2';
      order.push('settings-end:rev-2');
      return {
        ok: true,
        settings: { settings_revision: authoritativeRevision },
        settings_revision: authoritativeRevision,
      };
    },
  };
  const setupApi = {
    get: async path => {
      assert.equal(path, '/api/settings?wait_for_writes=1');
      order.push(`setup-load:${authoritativeRevision}`);
      return { settings_revision: authoritativeRevision };
    },
    request: async (path, options) => {
      assert.equal(path, '/api/settings');
      assert.equal(options.method, 'PUT');
      order.push(`setup-start:${options.body.base_settings_revision}`);
      authoritativeRevision = 'rev-3';
      return {
        ok: true,
        settings: { settings_revision: authoritativeRevision },
        settings_revision: authoritativeRevision,
      };
    },
  };

  const first = writeSettingsPatch({
    api: settingsApi,
    patch: { output: { retention_days: 30 } },
    coordinator: settingsTab,
  });
  const second = writeSettingsPatch({
    api: setupApi,
    patch: { llm: { model: 'auto' } },
    coordinator: setupTab,
  });

  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(order, ['settings-start:rev-1'], '第二个上下文必须等待第一个设置写入完成');
  firstGate.resolve();
  assert.equal((await first).settings_revision, 'rev-2');
  assert.equal((await second).settings_revision, 'rev-3');
  assert.deepEqual(order, [
    'settings-start:rev-1',
    'settings-end:rev-2',
    'setup-load:rev-2',
    'setup-start:rev-2',
  ], 'Setup 必须在获得锁后读取第一个写入产生的新 revision');
}

{
  const firstTab = createSettingsWriteCoordinator({ locks });
  const waitingTab = createSettingsWriteCoordinator({ locks });
  const laterTab = createSettingsWriteCoordinator({ locks });
  const gate = deferred();
  const waitingAbort = new AbortController();
  let waitingCommitCalls = 0;

  const first = firstTab.write({
    loadLatest: async () => ({ settings_revision: 'rev-cancel-1' }),
    commit: async () => gate.promise,
  });
  const waiting = waitingTab.write({
    signal: waitingAbort.signal,
    loadLatest: async () => ({ settings_revision: 'rev-cancel-1' }),
    commit: async () => { waitingCommitCalls += 1; },
  });
  waitingAbort.abort(new DOMException('页面已卸载', 'AbortError'));
  await assert.rejects(waiting, error => error?.name === 'AbortError');
  assert.equal(waitingCommitCalls, 0, '等待锁时卸载不得进入提交区');
  gate.resolve({ settings_revision: 'rev-cancel-2' });
  await first;
  assert.equal((await laterTab.write({
    loadLatest: async () => ({ settings_revision: 'rev-cancel-2' }),
    commit: async ({ revision }) => revision,
  })), 'rev-cancel-2', '取消等待后不得泄漏跨标签锁');
}

{
  const abortedTab = createSettingsWriteCoordinator({ locks });
  const laterTab = createSettingsWriteCoordinator({ locks });
  const runningAbort = new AbortController();
  let entered = false;
  const running = abortedTab.write({
    signal: runningAbort.signal,
    loadLatest: async () => ({ settings_revision: 'rev-running-1' }),
    commit: async ({ signal }) => {
      entered = true;
      return waitForAbort(signal);
    },
  });
  while (!entered) await new Promise(resolve => setTimeout(resolve, 0));
  runningAbort.abort(new DOMException('页面已卸载', 'AbortError'));
  await assert.rejects(running, error => error?.name === 'AbortError');
  assert.equal((await laterTab.write({
    loadLatest: async () => ({ settings_revision: 'rev-running-2' }),
    commit: async ({ revision }) => revision,
  })), 'rev-running-2', '运行中的页面卸载后必须释放跨标签锁');
}

{
  const coordinator = createSettingsWriteCoordinator({ locks: null });
  const firstGate = deferred();
  const first = coordinator.write({
    loadLatest: async () => ({ settings_revision: 'rev-local-1' }),
    commit: async () => {
      await firstGate.promise;
      return 'first';
    },
  });
  const queuedAbort = new AbortController();
  let secondCommitCalls = 0;
  const second = coordinator.write({
    signal: queuedAbort.signal,
    loadLatest: async () => ({ settings_revision: 'rev-local-1' }),
    commit: async () => {
      secondCommitCalls += 1;
      return 'second';
    },
  });
  queuedAbort.abort(new DOMException('页面已卸载', 'AbortError'));
  const secondOutcome = await Promise.race([
    second.then(() => 'settled', () => 'settled'),
    new Promise(resolve => setTimeout(() => resolve('still-pending'), 25)),
  ]);
  assert.equal(secondOutcome, 'settled', '无 Web Locks 的真实设置协调器必须立即结束已取消的排队写入');
  assert.equal(secondCommitCalls, 0, '取消的排队写入不得进入 PUT 提交');
  const thirdPending = coordinator.write({
    loadLatest: async () => ({ settings_revision: 'rev-local-2' }),
    commit: async () => 'third',
  });
  const thirdBeforeFirst = await Promise.race([
    thirdPending.then(() => 'ran'),
    new Promise(resolve => setTimeout(() => resolve('still-pending'), 25)),
  ]);
  assert.equal(thirdBeforeFirst, 'still-pending', '真实设置协调器不得让后续写入越过仍在运行的旧写入');
  firstGate.resolve();
  assert.equal(await first, 'first');
  assert.equal(await thirdPending, 'third', '旧写入完成后真实设置协调器的后续串行仍应继续');

  const ordinaryAbort = new AbortController();
  const blockingGate = deferred();
  const blocking = coordinator.write({
    loadLatest: async () => ({ settings_revision: 'rev-ordinary-abort-1' }),
    commit: async () => {
      await blockingGate.promise;
      return 'blocking';
    },
  });
  let ordinaryCommitCalls = 0;
  const cancelled = coordinator.write({
    signal: ordinaryAbort.signal,
    loadLatest: async () => ({ settings_revision: 'rev-ordinary-abort-1' }),
    commit: async () => {
      ordinaryCommitCalls += 1;
      return 'must-not-commit';
    },
  });
  ordinaryAbort.abort(new Error('页面已卸载'));
  await assert.rejects(cancelled, error => error?.name === 'AbortError'
    && error?.status === 499
    && error?.message === '页面已卸载',
    '本地串行队列收到普通 Error 取消原因时也必须投影为 AbortError/499');
  assert.equal(ordinaryCommitCalls, 0, '普通 Error 取消的排队写入不得进入 PUT 提交');
  blockingGate.resolve();
  assert.equal(await blocking, 'blocking');
}

console.log('web settings concurrency tests passed');
