import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const schedulerSource = await readFile(
  new URL('../src/web/public/js/pages/settings/scheduler.js', import.meta.url),
  'utf8',
);
const cleanLegacyRefsClickStart = schedulerSource.indexOf(
  "cleanLegacyRefsBtn.addEventListener('click'",
);
assert.notEqual(cleanLegacyRefsClickStart, -1,
  '生产调度页必须由清理按钮真实触发 cleanLegacyRefs');
const cleanLegacyRefsClickEnd = schedulerSource.indexOf('\n', cleanLegacyRefsClickStart);
const cleanLegacyRefsClickSource = schedulerSource.slice(
  cleanLegacyRefsClickStart,
  cleanLegacyRefsClickEnd === -1 ? schedulerSource.length : cleanLegacyRefsClickEnd,
).trim();

function extractFunction(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing production function: ${marker}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated production function: ${marker}`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const cleanLegacyRefsSource = extractFunction(schedulerSource, 'async function cleanLegacyRefs()');
const confirmations = [];
const saveRequests = [];
const statusEvents = [];
const endedTokens = [];
const clickHandlers = [];
const invokedActions = [];
const firstToken = { signal: new AbortController().signal, active: true };
const saveResponse = deferred();
let beginCalls = 0;
let applied = 0;

const cleanLegacyRefs = new Function(
  'ui',
  'page',
  'cleanLegacyRefsBtn',
  'saveWhitelistBtn',
  'status',
  'applySettings',
  'applySchedulerMutationResult',
  'pollSchedulerStatus',
  'isAbortError',
  'errorText',
  `${cleanLegacyRefsSource}; return cleanLegacyRefs;`,
)(
  {
    confirmDialog() {
      const confirmation = deferred();
      confirmations.push(confirmation);
      return confirmation.promise;
    },
  },
  {
    beginAction() {
      beginCalls += 1;
      return beginCalls === 1 ? firstToken : null;
    },
    alive(token) { return token === firstToken && firstToken.active; },
    saveSection(body, options) {
      saveRequests.push({ body, options });
      return saveResponse.promise;
    },
    getSettings() { return {}; },
    saveSummaryText(_result, fallback) { return fallback; },
    saveHasWarnings() { return false; },
    endAction(token) { endedTokens.push(token); },
  },
  {},
  {},
  { set(message, kind) { statusEvents.push({ message, kind }); } },
  {},
  () => { applied += 1; },
  async () => {},
  () => {},
  () => false,
  (error, fallback) => error?.message || fallback,
);

const button = {
  addEventListener(type, handler) {
    assert.equal(type, 'click');
    clickHandlers.push(handler);
  },
};
const productionCleanLegacyRefs = (...args) => {
  const promise = cleanLegacyRefs(...args);
  invokedActions.push(promise);
  return promise;
};
new Function(
  'cleanLegacyRefsBtn',
  'cleanLegacyRefs',
  `${cleanLegacyRefsClickSource};`,
)(button, productionCleanLegacyRefs);
assert.equal(clickHandlers.length, 1, '必须安装清理按钮的生产 click handler');

// 两次真实按钮点击会并行等待确认；第一笔确认后取得 owner，第二笔确认后
// beginAction 返回 null。第二笔不能访问空 token、发请求或产生未处理 rejection。
clickHandlers[0]();
clickHandlers[0]();
const [firstClick, secondClick] = invokedActions;
assert.equal(confirmations.length, 2, '两次按钮点击必须各自进入确认流程');
confirmations[0].resolve(true);
confirmations[1].resolve(true);
await Promise.resolve();
await Promise.resolve();
assert.equal(saveRequests.length, 1, '重复确认只能让第一个 action 发起一次保存');
assert.strictEqual(saveRequests[0].options.ownerToken, firstToken,
  '保存必须绑定第一个 action owner');
saveResponse.resolve({ ok: true });
const outcomes = await Promise.allSettled([firstClick, secondClick]);
assert.deepEqual(outcomes.map(outcome => outcome.status), ['fulfilled', 'fulfilled'],
  '第二次确认在 owner 已被占用时必须安全结束，不能抛空 token 异常');
assert.deepEqual(endedTokens, [firstToken], '只有实际持有 owner 的 action 才能 end');
assert.equal(applied, 1, '第一个成功 action 必须正常采用设置结果');
assert.equal(statusEvents.at(-1)?.kind, 'ok', '第一个成功 action 必须展示成功状态');

async function assertNoOwnerIsNoOp({ marker, args }) {
  const source = extractFunction(schedulerSource, marker);
  const status = [];
  const posts = [];
  const ended = [];
  let invalidations = 0;
  const values = args.values({ status, posts, ended, invalidate: () => { invalidations += 1; } });
  const fn = new Function(
    ...args.names,
    `${source}; return ${args.returnName};`,
  )(...args.names.map(name => values[name]));
  const result = await fn(...args.invoke);
  assert.equal(result, undefined, `${marker} 无 owner 时必须安全结束`);
  assert.deepEqual(status, [], `${marker} 无 owner 时不得写入进行中/错误状态`);
  assert.deepEqual(posts, [], `${marker} 无 owner 时不得发起 API 请求`);
  assert.deepEqual(ended, [], `${marker} 无 owner 时不得调用 endAction(null)`);
  assert.equal(invalidations, 0, `${marker} 无 owner 时不得使轮询代次失效`);
}

await assertNoOwnerIsNoOp({
  marker: 'async function runOnce()',
  args: {
    names: [
      'page', 'ui', 'runOnceBtn', 'saveSchedulerBtn', 'saveWhitelistBtn',
      'schedulerStatusPoll', 'runStatus', 'api', 'paintSchedulerStatus',
      'isAbortError', 'errorText', 'requireSchedulerRunOnceResult',
    ],
    returnName: 'runOnce',
    values: ({ status, posts, ended, invalidate }) => ({
      page: {
        getBaseRevision() { return 'scheduler-revision'; },
        beginAction() { return null; },
        alive(token) { return token !== null; },
        endAction(token) { ended.push(token); },
        observeRuntimePayload() {},
        markStale() {},
      },
      ui: { async confirmDialog() { return true; } },
      runOnceBtn: {},
      saveSchedulerBtn: {},
      saveWhitelistBtn: {},
      schedulerStatusPoll: { invalidate },
      runStatus: { set(message, kind) { status.push({ message, kind }); } },
      api: { async post(path) { posts.push(path); return null; } },
      paintSchedulerStatus() {},
      isAbortError() { return false; },
      errorText(_error, fallback) { return fallback; },
      requireSchedulerRunOnceResult() {},
    }),
    invoke: [],
  },
});

await assertNoOwnerIsNoOp({
  marker: 'async function revalidateStore(store)',
  args: {
    names: [
      'page', 'revalidateCursorsBtn', 'revalidatePendingBtn', 'maintainStatus',
      'api', 'pollSchedulerStatus', 'isAbortError', 'errorText',
      'requireSchedulerStoreRevalidationResult',
    ],
    returnName: 'revalidateStore',
    values: ({ status, posts, ended }) => ({
      page: {
        beginAction() { return null; },
        alive(token) { return token !== null; },
        endAction(token) { ended.push(token); },
      },
      revalidateCursorsBtn: {},
      revalidatePendingBtn: {},
      maintainStatus: { set(message, kind) { status.push({ message, kind }); } },
      api: { async post(path) { posts.push(path); return null; } },
      pollSchedulerStatus: async () => {},
      isAbortError() { return false; },
      errorText(_error, fallback) { return fallback; },
      requireSchedulerStoreRevalidationResult() {},
    }),
    invoke: ['cursors'],
  },
});

await assertNoOwnerIsNoOp({
  marker: 'async function clearLegacyCursors()',
  args: {
    names: [
      'draft', 'ui', 'page', 'clearLegacyBtn', 'maintainStatus', 'api',
      'schedulerStatusPoll', 'paintSchedulerStatus', 'pollSchedulerStatus',
      'isAbortError', 'errorText', 'requireSchedulerLegacyCursorCleanupResult',
    ],
    returnName: 'clearLegacyCursors',
    values: ({ status, posts, ended, invalidate }) => ({
      draft: { lastStatus: { legacy_cursor_cleanup_token: 'cleanup-token', running: false } },
      ui: { async confirmDialog() { return true; } },
      page: {
        beginAction() { return null; },
        alive(token) { return token !== null; },
        endAction(token) { ended.push(token); },
      },
      clearLegacyBtn: {},
      maintainStatus: { set(message, kind) { status.push({ message, kind }); } },
      api: { async post(path) { posts.push(path); return null; } },
      schedulerStatusPoll: { invalidate },
      paintSchedulerStatus() {},
      pollSchedulerStatus: async () => {},
      isAbortError() { return false; },
      errorText(_error, fallback) { return fallback; },
      requireSchedulerLegacyCursorCleanupResult() {},
    }),
    invoke: [],
  },
});

console.log('web settings scheduler clean legacy refs tests passed');
