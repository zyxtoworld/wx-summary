import assert from 'node:assert/strict';
import { __llmInternals } from '../src/summarizer/llm.js';

const url = 'http://127.0.0.1/docs';
const controller = new AbortController();
let fetchCalled = false;
let resolveFetch;
let resolveRead;
let resolveReadStarted;
let releaseCount = 0;
const fetchDeferred = new Promise(resolve => { resolveFetch = resolve; });
const readStarted = new Promise(resolve => { resolveReadStarted = resolve; });

const pending = __llmInternals.enrichMessagesWithLinkPreviews(
  [{ time: '09:00', sender: '测试', type: 'text', content: url }],
  {
    enabled: true,
    allow_private_networks: true,
    max_related_links: 0,
    _fetch: async () => {
      fetchCalled = true;
      return fetchDeferred;
    },
  },
  null,
  controller.signal,
);

for (let attempt = 0; attempt < 10 && !fetchCalled; attempt += 1) await Promise.resolve();
assert.equal(fetchCalled, true, 'link preview must reach the injected fetch boundary');

resolveFetch({
  ok: true,
  status: 200,
  url,
  headers: { get(name) { return String(name).toLowerCase() === 'content-type' ? 'text/html' : null; } },
  body: {
    getReader() {
      return {
        read() {
          resolveReadStarted();
          return new Promise(resolve => { resolveRead = resolve; });
        },
        cancel() {},
        releaseLock() {
          releaseCount += 1;
        },
      };
    },
  },
});
await readStarted;

// 模拟 API/ReadableStream 忽略 abort：取消后仍晚到 done=true。
controller.abort(new Error('页面已卸载'));
resolveRead({ done: true, value: undefined });

await assert.rejects(
  pending,
  error => error?.status === 499,
  'body 读取完成与取消竞态下，网页预览不得继续投影到消息；必须返回统一取消合同',
);
assert.equal(releaseCount, 1, '链接预览取消后必须释放响应 reader 锁');

console.log('llm link preview cancellation test passed');
