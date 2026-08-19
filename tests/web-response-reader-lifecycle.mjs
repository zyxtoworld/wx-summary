import assert from 'node:assert/strict';
import { readResponseBytesLimited } from '../src/web/public/js/shared/response-reader.js';

let readCount = 0;
let cancelCount = 0;
let releaseCount = 0;
const reader = {
  read() {
    readCount += 1;
    return new Promise(() => {});
  },
  cancel() {
    cancelCount += 1;
    return Promise.resolve();
  },
  releaseLock() {
    releaseCount += 1;
  },
};
const response = {
  headers: { get() { return null; } },
  bodyUsed: false,
  body: { getReader() { return reader; } },
};
const controller = new AbortController();
const pending = readResponseBytesLimited(response, {
  maxBytes: 16,
  signal: controller.signal,
});

// 在 readReaderChunk 安排的 microtask 执行前取消；取消不得再启动底层 read。
controller.abort();
await assert.rejects(
  pending,
  error => error?.name === 'AbortError',
  'microtask 前取消响应读取必须投影为 AbortError',
);
assert.equal(readCount, 0, '调用者在底层 read 启动前取消时不得再启动网络流读取');
assert.equal(cancelCount, 1, '取消的响应流必须只尝试取消 reader 一次');
assert.equal(releaseCount, 1, '取消的响应流必须释放 reader lock 一次');

// 响应已经返回但调用者在进入 bounded reader 前取消时，取消必须先于
// Content-Length/stream capability 分支，不能把旧响应投影成超限或 502。
{
  const preAborted = new AbortController();
  preAborted.abort();
  let bodyCancelCount = 0;
  const oversizedResponse = {
    headers: { get(name) { return name === 'Content-Length' ? '99' : null; } },
    bodyUsed: false,
    body: {
      cancel() { bodyCancelCount += 1; },
    },
  };
  await assert.rejects(
    readResponseBytesLimited(oversizedResponse, { maxBytes: 4, signal: preAborted.signal }),
    error => error?.name === 'AbortError',
    '进入 bounded reader 前已取消时必须先投影 AbortError',
  );
  assert.equal(bodyCancelCount, 1, '进入 bounded reader 前取消仍必须尝试取消响应 body');
}

console.log('web response reader lifecycle tests passed');
