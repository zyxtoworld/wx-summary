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

globalThis.location = new URL('http://wx-summary.test/');
globalThis.history = { state: null, replaceState() {} };
globalThis.document = { title: '' };
globalThis.sessionStorage = new MemoryStorage();
globalThis.localStorage = new MemoryStorage();

const loader = createBrowserModuleLoader();
const session = await loader.load('js/session.js');
session.rememberSessionToken('test-session-token');
session.rememberServiceInstanceId('test-service-id-0001');
const { createApi, isMutationOutcomeUnknown, mutationOutcomeUnknown } = await loader.load('js/api.js');
const api = createApi({ assetVersion: 'sha256-test' });
const {
  LOCAL_ACTION_PENDING_STORAGE_LIMIT,
  beginLocalActionRecovery,
  forgetLocalActionRecovery,
  localActionEvidenceSettled,
  readPendingLocalActionRecords,
} = await loader.load('js/shared/local-action-recovery.js');
const { classifyLocalActionRecovery } = await loader.load('js/shared/local-action-recovery-state.js');

assert.equal(mutationOutcomeUnknown({ mutation: false, requestStarted: true }), false);
assert.equal(mutationOutcomeUnknown({ mutation: true, requestStarted: false }), false);
assert.equal(mutationOutcomeUnknown({ mutation: true, requestStarted: true, outcomeConfirmed: true }), false);
assert.equal(mutationOutcomeUnknown({ mutation: true, requestStarted: true, outcomeConfirmed: false }), true);

assert.equal(isMutationOutcomeUnknown({ outcomeUnknown: true }), true, 'UI 必须识别新结果未知字段');
assert.equal(isMutationOutcomeUnknown({ mutation_outcome_unknown: true }), true, 'UI 必须兼容旧结果未知字段');
assert.equal(isMutationOutcomeUnknown({ payload: { mutation_outcome_unknown: true } }), true, 'UI 必须识别 HTTP 载荷中的旧字段');
assert.equal(isMutationOutcomeUnknown({ code: 'mutation_outcome_unknown' }), true, 'UI 必须识别旧结果未知错误码');
assert.equal(isMutationOutcomeUnknown({ outcomeUnknown: false }), false);

let cancellationFetchStarted = false;
globalThis.fetch = (_url, { signal } = {}) => {
  cancellationFetchStarted = true;
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    }, { once: true });
  });
};
const callerCancellation = new AbortController();
const cancelledRead = api.get('/api/cancelled-read', {
  signal: callerCancellation.signal,
  timeoutMs: 5000,
});
await new Promise(resolve => setImmediate(resolve));
callerCancellation.abort(new Error('页面已卸载'));
await assert.rejects(
  cancelledRead,
  error => error?.name === 'AbortError'
    && error?.status === 499
    && error?.outcomeUnknown !== true,
  '调用者用普通 Error reason 取消 API 请求时必须归一为 499 AbortError',
);
assert.equal(cancellationFetchStarted, true, '取消合同测试必须确实进入 fetch 等待');

// 响应流已经读到 done=true 后,reader.releaseLock() 仍可能触发调用者取消;
// 外层 API 恢复执行时必须再次检查 linked signal,不能把旧错误/成功结果投影
// 到当前页面。这里故意让 releaseLock() 同步取消,覆盖 reader 内部检查之后的
// 最后一个 post-reader 窗口。
{
  let staleNotices = 0;
  const lateCancelApi = createApi({
    assetVersion: 'asset-a',
    onStaleAsset() { staleNotices += 1; },
  });

  async function runLateReleaseCancel({ responseStatus, responseBody, invoke }) {
    const controller = new AbortController();
    const bytes = responseBody instanceof Uint8Array
      ? responseBody
      : new TextEncoder().encode(String(responseBody));
    let reads = 0;
    let releaseCalls = 0;
    let cancelCalls = 0;
    const reader = {
      read() {
        return Promise.resolve(reads++ === 0
          ? { done: false, value: bytes }
          : { done: true, value: undefined });
      },
      cancel() { cancelCalls += 1; },
      releaseLock() {
        releaseCalls += 1;
        controller.abort(new Error('页面已卸载'));
      },
    };
    globalThis.fetch = async () => ({
      ok: responseStatus >= 200 && responseStatus < 300,
      status: responseStatus,
      headers: {
        get(name) {
          return name.toLowerCase() === 'content-length' ? String(bytes.byteLength) : 'application/json';
        },
      },
      body: { getReader() { return reader; } },
      bodyUsed: false,
    });
    let error = null;
    let value;
    try {
      value = await invoke(controller.signal);
    } catch (caught) {
      error = caught;
    }
    assert.equal(releaseCalls, 1, '完整响应必须释放 reader 一次');
    assert.equal(cancelCalls, 0, '完整响应取消竞态不应再发起 reader.cancel');
    return { controller, error, value };
  }

  staleNotices = 0;
  const stale = await runLateReleaseCancel({
    responseStatus: 409,
    responseBody: JSON.stringify({ code: 'stale_frontend_asset', error: '页面资源已过期' }),
    invoke: signal => lateCancelApi.get('/api/stale', { signal }),
  });
  assert.equal(stale.value, undefined, '取消后的旧错误不得返回结果');
  assert.equal(stale.error?.name, 'AbortError', '读完错误响应后取消仍必须归一为 AbortError');
  assert.equal(stale.error?.status, 499, '读完错误响应后取消必须保持 499');
  assert.equal(staleNotices, 0, '取消后的 stale 旧资源响应不得触发刷新提示');

  const json = await runLateReleaseCancel({
    responseStatus: 200,
    responseBody: JSON.stringify({ ok: true, value: 'late-json' }),
    invoke: signal => lateCancelApi.post('/api/write', { value: 1 }, { signal }),
  });
  assert.equal(json.value, undefined, '取消后的 JSON 成功响应不得返回结果');
  assert.equal(json.error?.name, 'AbortError', '读完 JSON 后取消仍必须归一为 AbortError');
  assert.equal(json.error?.status, 499, '读完 JSON 后取消必须保持 499');
  assert.equal(json.error?.outcomeUnknown, true, '取消后的写响应必须标记结果未知');

  const bytes = await runLateReleaseCancel({
    responseStatus: 200,
    responseBody: new Uint8Array([1, 2, 3]),
    invoke: signal => lateCancelApi.postRaw('/api/file', new Uint8Array([9]), {}, {
      signal,
      expect: 'bytes',
    }),
  });
  assert.equal(bytes.value, undefined, '取消后的字节成功响应不得返回结果');
  assert.equal(bytes.error?.name, 'AbortError', '读完字节后取消仍必须归一为 AbortError');
  assert.equal(bytes.error?.status, 499, '读完字节后取消必须保持 499');
  assert.equal(bytes.error?.outcomeUnknown, true, '取消后的字节写响应必须标记结果未知');
}

// 最后一次 reader.read() 返回 done=true 后，调用者取消可能发生在
// readReaderChunk 已经 resolve、但外层 await 尚未恢复的窗口；写请求仍必须
// 以取消/结果未知结束，不能把完整响应当成成功提交。
{
  const controller = new AbortController();
  let resolveFinalRead;
  let notifyFinalReadStarted;
  const finalReadStarted = new Promise(resolve => { notifyFinalReadStarted = resolve; });
  let readCount = 0;
  globalThis.fetch = async (_url, { signal } = {}) => ({
    ok: true,
    status: 200,
    headers: { get() { return null; } },
    body: {
      getReader() {
        const removeLinkedAbortListener = signal.removeEventListener.bind(signal);
        let forcedAbort = false;
        signal.removeEventListener = (type, listener, options) => {
          const result = removeLinkedAbortListener(type, listener, options);
          if (!forcedAbort && type === 'abort' && readCount >= 2) {
            forcedAbort = true;
            controller.abort(new Error('页面已卸载'));
          }
          return result;
        };
        return {
          read() {
            readCount += 1;
            if (readCount === 1) {
              return Promise.resolve({
                done: false,
                value: new TextEncoder().encode('{"ok":true}'),
              });
            }
            if (readCount === 2) {
              notifyFinalReadStarted();
              return new Promise(resolve => { resolveFinalRead = resolve; });
            }
            throw new Error('读取次数超出响应边界');
          },
          cancel() { return Promise.resolve(); },
          releaseLock() {},
        };
      },
    },
  });
  const pending = api.post('/api/write', { value: 'late-cancel' }, {
    signal: controller.signal,
    timeoutMs: 5_000,
  });
  await finalReadStarted;
  resolveFinalRead({ done: true });
  await assert.rejects(
    pending,
    error => error?.name === 'AbortError'
      && error?.status === 499
      && error?.outcomeUnknown === true,
    '响应最后一次读取完成与页面取消竞态时，写请求不得伪装成成功',
  );
  assert.equal(readCount, 2, '取消竞态不得继续读取响应流');
}

function responseWithBrokenBody(message = 'response stream aborted') {
  return new Response(new ReadableStream({
    start(controller) { controller.error(new Error(message)); },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls += 1;
  return responseWithBrokenBody();
};
await assert.rejects(
  api.post('/api/write', { value: 1 }),
  error => error?.outcomeUnknown === true,
  'POST 已发出后响应流中断必须标记为结果未知',
);
assert.equal(fetchCalls, 1, '结果未知的写请求不得自动重试');

fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls += 1;
  return new Response(JSON.stringify({ ok: true, value: 'response-too-large' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
await assert.rejects(
  api.post('/api/write', { value: 'oversized' }, { maxBytes: 8 }),
  error => error?.outcomeUnknown === true,
  'POST 已发出后响应超过读取上限必须标记为结果未知',
);
assert.equal(fetchCalls, 1, '写响应超限不得触发自动重试');

await assert.rejects(
  api.get('/api/read', { maxBytes: 8 }),
  error => error?.outcomeUnknown !== true,
  'GET 响应超限不得误标为写入结果未知',
);

fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls += 1;
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
const cyclicBody = {};
cyclicBody.self = cyclicBody;
await assert.rejects(
  api.post('/api/write', cyclicBody),
  error => error?.outcomeUnknown !== true,
  '请求体序列化失败发生在写请求发送前，不得标记为结果未知',
);
assert.equal(fetchCalls, 0, '请求发送前失败不得调用 fetch');

fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls += 1;
  return new Response('not-json', { status: 200, headers: { 'Content-Type': 'application/json' } });
};
await assert.rejects(
  api.post('/api/write', { value: 2 }),
  error => error?.code === 'api_response_invalid_json' && error?.outcomeUnknown === true,
  'POST 的成功响应无法验证时仍必须标记为结果未知',
);
assert.equal(fetchCalls, 1, '无法验证写响应时不得自动重试');

await assert.rejects(
  api.get('/api/read'),
  error => error?.code === 'api_response_invalid_json' && error?.outcomeUnknown !== true,
  '只读请求响应损坏不得误标为写入结果未知',
);

globalThis.fetch = async () => new Response(JSON.stringify({
  ok: false,
  code: 'validation_failed',
  error: '参数错误',
}), { status: 400, headers: { 'Content-Type': 'application/json' } });
await assert.rejects(
  api.post('/api/write', { value: 3 }),
  error => error?.status === 400 && error?.code === 'validation_failed' && error?.outcomeUnknown !== true,
  '完整读取的 HTTP 错误响应是已确认失败,不得误标为结果未知',
);

globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, saved: true }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});
assert.deepEqual(await api.post('/api/write', { value: 4 }), { ok: true, saved: true });

for (let index = 0; index < LOCAL_ACTION_PENDING_STORAGE_LIMIT; index += 1) {
  beginLocalActionRecovery({
    actionId: `reveal_capacity_${String(index).padStart(3, '0')}`,
    kind: 'export_preview',
    now: Date.now(),
  });
}
fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls += 1;
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
await assert.rejects(
  api.post('/api/reveal', { local_action_id: 'reveal_capacity_overflow_0001' }),
  error => error?.code === 'local_action_recovery_capacity_reached' && error?.status === 429,
  'API 必须在恢复日志容量满时于 fetch 前拒绝本机副作用',
);
assert.equal(fetchCalls, 0, '恢复日志容量拒绝不得发送本机副作用请求');
for (const record of readPendingLocalActionRecords()) forgetLocalActionRecovery(record.action_id);

const localActionCases = [
  {
    label: 'Digest 原始 PNG 保存',
    actionId: 'savepng_test_0001',
    invoke: actionId => api.postRaw('/api/save-render', new Uint8Array([1, 2, 3]), {
      'Content-Type': 'image/png',
    }, { localActionId: actionId }),
  },
  {
    label: 'Digest 系统剪贴板',
    actionId: 'copyimg_test_0001',
    invoke: actionId => api.post('/api/copy-image', { local_action_id: actionId }),
  },
  {
    label: 'Digest 文件定位',
    actionId: 'reveal_test_0001',
    invoke: actionId => api.post('/api/reveal', { local_action_id: actionId }),
  },
  {
    label: 'Digest Markdown 导出',
    actionId: 'exportmd_test_0001',
    invoke: actionId => api.post('/api/export-preview', { local_action_id: actionId }),
  },
  {
    label: 'History 危险操作',
    actionId: 'history_delete_test_0001',
    invoke: actionId => api.post('/api/history-delete', { local_action_id: actionId }),
  },
];

for (const testCase of localActionCases) {
  fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({
      ok: true,
      local_action_committed: true,
      local_action_id: 'stale_action_response_0001',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  await assert.rejects(
    testCase.invoke(testCase.actionId),
    error => error?.code === 'local_action_response_id_mismatch'
      && error?.localActionId === testCase.actionId
      && error?.outcomeUnknown === true,
    `${testCase.label}不得把串号或陈旧响应当成本次动作成功`,
  );
  assert.equal(fetchCalls, 1, `${testCase.label}响应身份不匹配后不得自动重试`);
  assert.equal(readPendingLocalActionRecords().some(record => record.action_id === testCase.actionId), true,
    `${testCase.label}响应身份不匹配后必须保留发送前恢复记录`);
  forgetLocalActionRecovery(testCase.actionId);
}

globalThis.fetch = async (_path, options) => {
  const body = JSON.parse(String(options?.body || '{}'));
  return new Response(JSON.stringify({
    ok: true,
    local_action_committed: true,
    local_action_id: body.local_action_id,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
assert.equal(
  (await api.post('/api/reveal', { local_action_id: 'reveal_match_test_0001' })).local_action_committed,
  true,
  '动作 ID 匹配后才能确认本地动作响应',
);

// 服务端副作用已经完成,但 API 自动删除本地 marker 失败时,响应不能继续
// 被页面当成 fully verified;否则刷新后 marker 会恢复同一动作而当前页却已
// 隐藏核对入口。这里走真实 begin/complete 路径,不手工清理来掩盖失败。
{
  const previousStorage = globalThis.localStorage;
  const storage = new MemoryStorage();
  const actionId = 'export_cleanup_failure_0001';
  let cleanupAllowed = false;
  globalThis.localStorage = {
    get length() { return storage.length; },
    key(index) { return storage.key(index); },
    getItem(key) { return storage.getItem(key); },
    setItem(key, value) { storage.setItem(key, value); },
    removeItem(key) {
      if (!cleanupAllowed) throw new Error('marker cleanup denied');
      storage.removeItem(key);
    },
  };
  try {
    globalThis.fetch = async (_path, options) => {
      const body = JSON.parse(String(options?.body || '{}'));
      return new Response(JSON.stringify({
        ok: true,
        local_action_committed: true,
        local_action_id: body.local_action_id,
        verified: true,
        item: { relative_path: 'preview.md' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const response = await api.post('/api/export-preview', { local_action_id: actionId });
    assert.equal(response.local_action_recovery_cleanup_failed, true,
      'marker 清理失败必须在 API 响应上留下可投影的未完成状态');
    assert.equal(classifyLocalActionRecovery(response), 'committed_unverified',
      'marker 清理失败时 verified 副作用也不能被页面分类为成功');
    assert.equal(localActionEvidenceSettled('export_preview', response), false,
      'marker 清理失败时摘要页必须继续启动后台核对,不能跳过恢复');
    assert.equal(readPendingLocalActionRecords().some(record => record.action_id === actionId), true,
      'marker 清理失败时必须保留动作记录供页面继续核对');
  } finally {
    cleanupAllowed = true;
    storage.removeItem(`wx-summary:local-action:${globalThis.location.origin}:${actionId}`);
    globalThis.localStorage = previousStorage;
  }
}

console.log('web API mutation outcome tests passed');
