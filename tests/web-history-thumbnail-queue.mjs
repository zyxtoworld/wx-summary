import assert from 'node:assert/strict';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

globalThis.location = new URL('http://wx-summary.test/#/history');
const loader = createBrowserModuleLoader();
const { createHistoryThumbnailQueue } = await loader.load('js/pages/history/thumbnail-queue.js');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

class FakeIntersectionObserver {
  static instances = [];

  constructor(callback) {
    this.callback = callback;
    this.observed = new Set();
    this.disconnected = false;
    FakeIntersectionObserver.instances.push(this);
  }

  observe(target) { this.observed.add(target); }
  unobserve(target) { this.observed.delete(target); }
  disconnect() { this.disconnected = true; this.observed.clear(); }
  reveal(...targets) {
    this.callback(targets.map(target => ({ target, isIntersecting: true, intersectionRatio: 1 })));
  }
}

const pending = new Map();
const started = [];
let oldResolve = null;
let oldGenerationObserved = null;
const queue = createHistoryThumbnailQueue({
  concurrency: 2,
  observerFactory: FakeIntersectionObserver,
  load: async (key, { isCurrent }) => {
    started.push(key);
    if (key === 'same') {
      await new Promise(resolve => { oldResolve = resolve; });
      oldGenerationObserved = isCurrent();
      return;
    }
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    pending.set(key, { resolve, isCurrent });
    await promise;
    return isCurrent();
  },
});

const observer = FakeIntersectionObserver.instances.at(-1);
const cardA = {};
const cardB = {};
const cardC = {};
queue.watch('a', cardA);
queue.watch('b', cardB);
queue.watch('c', cardC);
assert.deepEqual(started, [], '未进入视口的卡片不得启动缩略图请求');
assert.equal(observer.observed.size, 3, '同一个 IntersectionObserver 必须观察所有卡片');
queue.refresh();
assert.equal(observer.observed.size, 3, '卡片插入文档后必须重新登记到同一个观察器');

observer.reveal(cardA, cardB);
await wait(0);
assert.deepEqual(started, ['a', 'b'], '进入视口后只启动并发上限内的请求');

queue.cancel('c');
pending.get('a').resolve();
pending.get('b').resolve();
await wait(0);
assert.deepEqual(started, ['a', 'b'], '取消排队项必须从队列移除,不能在前两项完成后补发');

queue.watch('same', {});
queue.request('same');
await wait(0);
queue.clear();
oldResolve();
await wait(0);
assert.equal(oldGenerationObserved, false, '清空队列后旧代任务不得继续回写当前页面');

queue.dispose();
assert.equal(observer.disconnected, true, '销毁页面必须断开共享观察器');

// 账号/列表换代会 abort 旧缩略图请求，但底层实现可能忽略 abort 并继续挂起。
// 旧代任务不得继续占用当前代次的并发槽，否则 concurrency=1 时新账号首图
// 会被旧请求拖到网络超时。
let resolveStale;
let resolveCurrent;
const generationStarts = [];
const generationQueue = createHistoryThumbnailQueue({
  concurrency: 1,
  observerFactory: null,
  load: key => {
    generationStarts.push(key);
    return new Promise(resolve => {
      if (key === 'stale') resolveStale = resolve;
      else resolveCurrent = resolve;
    });
  },
});
generationQueue.request('stale');
await wait(0);
assert.deepEqual(generationStarts, ['stale']);
generationQueue.clear();
generationQueue.request('current');
await wait(0);
assert.deepEqual(generationStarts, ['stale', 'current'],
  'clear 后当前代次不得等待忽略 abort 的旧代请求释放并发槽');
assert.equal(generationQueue.activeCount, 1,
  '旧代槽释放后 activeCount 只能统计当前代次请求');
resolveStale();
await wait(0);
assert.equal(generationQueue.activeCount, 1,
  '旧代请求晚到 settle 不得扣减当前代次的 activeCount');
resolveCurrent();
await wait(0);
assert.equal(generationQueue.activeCount, 0,
  '当前代次请求完成后必须正常归还自己的槽');
generationQueue.dispose();

console.log('web history thumbnail queue tests passed');
