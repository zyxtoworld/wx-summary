import assert from 'node:assert/strict';
import { __llmInternals } from '../src/summarizer/llm.js';

const controller = new AbortController();
let readCount = 0;
let releaseCount = 0;
let cancelCount = 0;
const reader = {
  read() {
    readCount += 1;
    if (readCount === 1) {
      return Promise.resolve({
        done: false,
        value: new TextEncoder().encode('{"ok":true}'),
      });
    }
    if (readCount === 2) {
      // 让 abort 发生在 await 已经取得 done=true、但循环恢复前的窗口。
      return {
        then(resolve) {
          resolve({ done: true });
          controller.abort(new Error('AI 请求已取消'));
        },
      };
    }
    throw new Error('读取次数超出响应边界');
  },
  releaseLock() {
    releaseCount += 1;
  },
  cancel() {
    cancelCount += 1;
  },
};

const response = {
  headers: { get() { return null; } },
  body: { getReader() { return reader; } },
};

await assert.rejects(
  __llmInternals.readResponseTextLimited(response, { signal: controller.signal }),
  error => error?.status === 499,
  'AI 响应最后一次读取与取消竞态时不得返回已取消的成功正文',
);
assert.equal(readCount, 2, '取消竞态不得继续读取 AI 响应');
assert.equal(releaseCount, 1, '取消竞态必须释放 AI 响应 reader 锁');
assert.equal(cancelCount, 1, '取消竞态必须取消未完成的 AI 响应 body');

{
  let normalReleaseCount = 0;
  let normalCancelCount = 0;
  const normalResponse = {
    headers: { get() { return null; } },
    body: {
      getReader() {
        let reads = 0;
        return {
          read() {
            reads += 1;
            return Promise.resolve(reads === 1
              ? { done: false, value: new TextEncoder().encode('{"ok":true}') }
              : { done: true, value: undefined });
          },
          releaseLock() {
            normalReleaseCount += 1;
          },
          cancel() {
            normalCancelCount += 1;
          },
        };
      },
    },
  };
  assert.equal(
    await __llmInternals.readResponseTextLimited(normalResponse),
    '{"ok":true}',
    '正常读取仍必须返回完整正文',
  );
  assert.equal(normalReleaseCount, 1, '正常结束必须释放 AI 响应 reader 锁');
  assert.equal(normalCancelCount, 0, '正常 done 不应取消已完整读取的 AI 响应 body');
}

{
  let reads = 0;
  let exactFillCancelCount = 0;
  let exactFillReleaseCount = 0;
  const exactFillReader = {
    read() {
      reads += 1;
      return Promise.resolve({ done: false, value: new Uint8Array(1024).fill(1) });
    },
    cancel() {
      exactFillCancelCount += 1;
    },
    releaseLock() {
      exactFillReleaseCount += 1;
    },
  };
  const exactFill = await __llmInternals.readLimitedResponse(
    { body: { getReader() { return exactFillReader; } } },
    1024,
  );
  assert.equal(exactFill.length, 1024, '正好填满上限仍应返回已读取内容');
  assert.equal(reads, 1, '正好填满上限不得继续读取未结束的 body');
  assert.equal(exactFillCancelCount, 1, '正好填满上限必须取消未读完的 body');
  assert.equal(exactFillReleaseCount, 1, '正好填满上限必须释放 reader 锁');
}

{
  let overflowCancelCount = 0;
  let overflowReleaseCount = 0;
  const overflowReader = {
    read() {
      return Promise.resolve({ done: false, value: new Uint8Array(1025).fill(1) });
    },
    cancel() {
      overflowCancelCount += 1;
    },
    releaseLock() {
      overflowReleaseCount += 1;
    },
  };
  const overflow = await __llmInternals.readLimitedResponse(
    { body: { getReader() { return overflowReader; } } },
    1024,
  );
  assert.equal(overflow.length, 1024, '超限读取仍应截断到安全上限');
  assert.equal(overflowCancelCount, 1, '超限读取不得重复取消 body');
  assert.equal(overflowReleaseCount, 1, '超限读取必须释放 reader 锁');
}

{
  let errorCancelCount = 0;
  let errorReleaseCount = 0;
  const errorReader = {
    read() {
      return Promise.reject(new Error('provider stream failed'));
    },
    cancel() {
      errorCancelCount += 1;
    },
    releaseLock() {
      errorReleaseCount += 1;
    },
  };
  await assert.rejects(
    __llmInternals.readResponseTextLimited(
      { body: { getReader() { return errorReader; } } },
    ),
    /provider stream failed/,
    'reader error must remain visible to the caller',
  );
  assert.equal(errorCancelCount, 1, 'reader error 必须取消未完成的 AI 响应 body');
  assert.equal(errorReleaseCount, 1, 'reader error 必须释放 AI 响应 reader 锁');
}

{
  let declaredCancelCount = 0;
  let declaredGetReaderCount = 0;
  const declaredOversizeResponse = {
    headers: { get(name) { return String(name).toLowerCase() === 'content-length' ? '2048' : null; } },
    body: {
      getReader() {
        declaredGetReaderCount += 1;
        throw new Error('declared oversized body must be cancelled before reader acquisition');
      },
      cancel() {
        declaredCancelCount += 1;
      },
    },
  };
  await assert.rejects(
    __llmInternals.readResponseTextLimited(declaredOversizeResponse, { maxBytes: 1024 }),
    error => error?.code === 'ai_response_too_large',
    'Content-Length 超限必须保留安全上限错误合同',
  );
  assert.equal(declaredCancelCount, 1, '声明超限必须先取消尚未读取的 response body');
  assert.equal(declaredGetReaderCount, 0, '声明超限不应先获取 reader 再留下锁');
}

{
  const fallbackController = new AbortController();
  const fallbackResponse = {
    headers: { get() { return null; } },
    text() {
      return {
        then(resolve) {
          resolve('{"ok":true}');
          fallbackController.abort(new Error('AI fallback 请求已取消'));
        },
      };
    },
  };
  await assert.rejects(
    __llmInternals.readResponseTextLimited(fallbackResponse, { signal: fallbackController.signal }),
    error => error?.status === 499,
    '无流响应的最后一次 text 读取与取消竞态也不得返回成功正文',
  );
}

async function assertPendingReadAbort(readOperation, label) {
  const controller = new AbortController();
  let readCount = 0;
  let cancelCount = 0;
  let releaseCount = 0;
  let resolveRead = null;
  const reader = {
    read() {
      readCount += 1;
      return new Promise(resolve => { resolveRead = resolve; });
    },
    cancel() {
      cancelCount += 1;
      resolveRead?.({ done: true, value: undefined });
      return Promise.resolve();
    },
    releaseLock() {
      releaseCount += 1;
    },
  };
  const response = {
    headers: { get() { return null; } },
    body: { getReader() { return reader; } },
  };
  const operation = readOperation(response, controller.signal);
  await Promise.resolve();
  assert.equal(readCount, 1, `${label}: abort 前必须已经有一个挂起的底层读取`);
  controller.abort(new Error(`${label} cancelled while read was pending`));
  await assert.rejects(
    Promise.race([
      operation,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), 250)),
    ]),
    error => error?.status === 499,
    `${label}: 忽略 AbortSignal 的挂起 reader 也必须投影取消错误`,
  );
  assert.equal(readCount, 1, `${label}: abort 后不得启动第二次读取`);
  assert.equal(cancelCount, 1, `${label}: abort 后必须取消未读 response body 一次`);
  assert.equal(releaseCount, 1, `${label}: abort 后必须释放 reader 锁一次`);
}

await assertPendingReadAbort(
  (response, signal) => __llmInternals.readLimitedResponse(response, 1024, signal),
  'readLimitedResponse',
);
await assertPendingReadAbort(
  (response, signal) => __llmInternals.readResponseTextLimited(response, { signal }),
  'readResponseTextLimited',
);

console.log('llm response reader cancellation tests passed');
