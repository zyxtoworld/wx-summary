import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { queueHistoryCrossTabItemRefresh } from '../src/web/public/js/pages/history/cross-tab.js';
import { historyStatusResponseIsCurrent } from '../src/web/public/js/pages/history/cross-tab.js';
import { createHistoryStatusRefreshController } from '../src/web/public/js/pages/history/status-refresh.js';
import { createHistoryAccountContextTracker } from '../src/web/public/js/pages/history/account-switch.js';

const itemKey = item => item?.key || '';
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function extractFunction(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing production function: ${marker}`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated production function: ${marker}`);
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

let scheduled = 0;
let listRefreshes = 0;
const detail = {
  item: { key: 'history-a' },
  revalidator: {
    schedule(delay) {
      assert.equal(delay, 0);
      scheduled += 1;
    },
  },
};

assert.equal(queueHistoryCrossTabItemRefresh({
  detail,
  updatedKey: 'history-a',
  itemKey,
  refreshListItem: () => { listRefreshes += 1; },
}), 'detail');
assert.equal(scheduled, 1, '当前详情的更新必须进入具备忙态协调的 revalidator');
assert.equal(listRefreshes, 0, '当前详情更新不得同时绕过协调器直接刷新列表项');

assert.equal(queueHistoryCrossTabItemRefresh({
  detail,
  updatedKey: 'history-b',
  itemKey,
  refreshListItem: () => { listRefreshes += 1; },
}), 'list');
assert.equal(scheduled, 1, '其他记录更新不得重验当前详情');
assert.equal(listRefreshes, 1, '其他记录只应走页面级列表项刷新');

assert.equal(queueHistoryCrossTabItemRefresh({
  detail,
  updatedKey: '',
  itemKey,
  refreshListItem: () => { listRefreshes += 1; },
}), 'ignored');
assert.equal(listRefreshes, 1, '缺少稳定身份时不得发请求');

const staleResponseController = new AbortController();
assert.equal(historyStatusResponseIsCurrent({
  pageDestroyed: false,
  signal: staleResponseController.signal,
}), true, '未取消的状态响应应可继续采用');
staleResponseController.abort(new Error('列表已换代'));
assert.equal(historyStatusResponseIsCurrent({
  pageDestroyed: false,
  signal: staleResponseController.signal,
}), false, '列表换代后已取消的状态响应不得继续重绘旧列表');
assert.equal(historyStatusResponseIsCurrent({
  pageDestroyed: true,
  signal: new AbortController().signal,
}), false, '页面销毁后的状态响应不得继续采用');

const pendingStatusRequest = (() => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
})();
const staleItem = { key: 'history-a' };
const activeDetail = { item: staleItem, busy: false };
let statusRequestCount = 0;
let statusRequestSignal = null;
let reconciled = 0;
let rendered = 0;
let scheduledReload = 0;
let detailUpdated = 0;
let broadcast = 0;
const refreshController = createHistoryStatusRefreshController({
  api: {
    get(_path, { signal }) {
      statusRequestCount += 1;
      statusRequestSignal = signal;
      return pendingStatusRequest.promise;
    },
  },
  getStatusPath: () => '/api/history/item-status',
  getDetail: () => activeDetail,
  isPageDestroyed: () => false,
  reconcile: () => {
    reconciled += 1;
    return { found: true };
  },
  render: () => { rendered += 1; },
  matchesFilter: () => true,
  scheduleReload: () => { scheduledReload += 1; },
  updateDetail: () => { detailUpdated += 1; },
  broadcast: () => { broadcast += 1; },
});
const listGenerationController = new AbortController();
const refreshPromise = refreshController.refresh(staleItem, {
  silent: true,
  signal: listGenerationController.signal,
});
assert.equal(statusRequestCount, 1, '列表换代前必须已经发出状态请求');
assert.equal(statusRequestSignal, listGenerationController.signal,
  '状态请求必须绑定当前列表代际的 AbortSignal');
listGenerationController.abort(new Error('列表已换代'));
pendingStatusRequest.resolve({ item: { key: 'history-a', has_blocking_issue: false } });
const staleRefreshResult = await refreshPromise;
assert.deepEqual(
  { ok: staleRefreshResult.ok, code: staleRefreshResult.code },
  { ok: false, code: 'cancelled' },
  '即使 fetch 忽略 abort 并 resolve,列表换代后的响应也必须返回 cancelled',
);
assert.equal(reconciled, 0, '过期响应不得 reconcile 当前列表');
assert.equal(rendered, 0, '过期响应不得重绘当前列表');
assert.equal(scheduledReload, 0, '过期响应不得调度列表重载');
assert.equal(detailUpdated, 0, '过期响应不得更新详情');
assert.equal(broadcast, 0, '过期响应不得广播给其他标签页');

async function assertClosedDetailResponseIsCancelled(settle) {
  const item = { key: 'history-closed-detail' };
  const detail = { item, invalidated: false, busy: false };
  let currentDetail = detail;
  const pending = deferred();
  const externalSignal = new AbortController();
  let reconciledAfterClose = 0;
  let renderedAfterClose = 0;
  let detailUpdatedAfterClose = 0;
  let broadcastAfterClose = 0;
  let failedAfterClose = 0;
  const controller = createHistoryStatusRefreshController({
    api: {
      get() {
        return pending.promise;
      },
    },
    getStatusPath: () => '/api/history/item-status',
    getDetail: () => currentDetail,
    isPageDestroyed: () => false,
    reconcile: () => {
      reconciledAfterClose += 1;
      return { found: true };
    },
    render: () => { renderedAfterClose += 1; },
    updateDetail: () => { detailUpdatedAfterClose += 1; },
    broadcast: () => { broadcastAfterClose += 1; },
    onFailure: () => { failedAfterClose += 1; },
  });

  const refreshPromise = controller.refresh(item, {
    silent: true,
    signal: externalSignal.signal,
  });
  detail.invalidated = true;
  currentDetail = null;
  settle(pending);
  const result = await refreshPromise;
  assert.deepEqual(
    { ok: result.ok, code: result.code },
    { ok: false, code: 'cancelled' },
    '详情关闭后,即使外部列表 signal 未取消,晚到状态响应也必须返回 cancelled',
  );
  assert.equal(reconciledAfterClose, 0, '关闭详情的晚到响应不得 reconcile 当前列表');
  assert.equal(renderedAfterClose, 0, '关闭详情的晚到响应不得重绘当前列表');
  assert.equal(detailUpdatedAfterClose, 0, '关闭详情的晚到响应不得更新详情');
  assert.equal(broadcastAfterClose, 0, '关闭详情的晚到响应不得广播');
  assert.equal(failedAfterClose, 0, '关闭详情的晚到错误不得进入失败投影');
}

await assertClosedDetailResponseIsCancelled(pending => {
  pending.resolve({ item: { key: 'history-closed-detail', has_blocking_issue: false } });
});
await assertClosedDetailResponseIsCancelled(pending => {
  pending.reject(new Error('详情已关闭后的晚到错误'));
});

// 旧的静默跨标签请求被列表换代取消时,不得清掉随后启动的详情刷新忙态。
const busyDetail = { item: { key: 'history-busy' }, busy: false };
const busyRequests = [];
let busyFinalizers = 0;
const busyRefreshController = createHistoryStatusRefreshController({
  api: {
    get(_path, { signal }) {
      const pending = (() => {
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        return { promise, resolve, signal };
      })();
      busyRequests.push(pending);
      return pending.promise;
    },
  },
  getStatusPath: () => '/api/history/item-status',
  getDetail: () => busyDetail,
  isPageDestroyed: () => false,
  reconcile: () => ({ found: true }),
  render: () => {},
  onStart: () => { busyDetail.busy = true; },
  onFinally: () => {
    busyFinalizers += 1;
    busyDetail.busy = false;
  },
});
const staleListSignal = new AbortController();
const staleBusyPromise = busyRefreshController.refresh(
  busyDetail.item,
  { silent: true, signal: staleListSignal.signal },
);
assert.equal(busyRequests.length, 1, '旧静默请求必须先发出');
const liveDetailPromise = busyRefreshController.refresh(busyDetail.item, { silent: false });
assert.equal(busyRequests.length, 2, '用户显式详情刷新必须随后发出');
staleListSignal.abort(new Error('列表已换代'));
busyRequests[0].resolve({ item: { key: 'history-busy', has_blocking_issue: false } });
const staleBusyResult = await staleBusyPromise;
assert.deepEqual(
  { ok: staleBusyResult.ok, code: staleBusyResult.code },
  { ok: false, code: 'cancelled' },
  '被列表换代取消的旧静默请求必须返回 cancelled',
);
assert.equal(busyFinalizers, 0, '旧静默请求不得执行新详情刷新的 onFinally');
assert.equal(busyDetail.busy, true, '旧静默请求结束后新详情刷新仍必须保持忙态');
busyRequests[1].resolve({ item: { key: 'history-busy', has_blocking_issue: false } });
const liveDetailResult = await liveDetailPromise;
assert.equal(liveDetailResult.ok, true, '新的详情刷新应正常完成');
assert.equal(busyFinalizers, 1, '只有当前详情刷新应执行一次 onFinally');
assert.equal(busyDetail.busy, false, '当前详情刷新完成后才可解除忙态');

// 200 但缺少 item 也属于状态接口合同错误。生产刷新按钮只触发
// refreshItemStatus(),不消费返回值；非静默请求必须进入可见失败回调，不能
// 让详情状态永远停在“正在刷新状态…”。
{
  const malformedItem = { key: 'history-malformed-status' };
  const malformedFailures = [];
  const malformedDetail = { item: malformedItem, busy: true };
  const malformedController = createHistoryStatusRefreshController({
    api: { get: async () => ({ ok: true }) },
    getStatusPath: () => '/api/history-item-status',
    getDetail: () => malformedDetail,
    isPageDestroyed: () => false,
    onFailure: event => malformedFailures.push(event),
    onFinally: detailValue => { detailValue.busy = false; },
  });
  const malformedResult = await malformedController.refresh(malformedItem, { silent: false });
  assert.deepEqual(
    { ok: malformedResult.ok, code: malformedResult.code },
    { ok: false, code: 'invalid_response' },
    '缺少 item 的 200 状态响应必须显式返回 invalid_response',
  );
  assert.equal(malformedFailures.length, 1,
    '非静默 malformed 状态响应必须进入失败投影,不能只返回未消费的错误码');
  assert.equal(malformedFailures[0].error?.code, 'history_status_invalid_response',
    'malformed 状态必须提供稳定错误码给详情错误提示');
  assert.equal(malformedDetail.busy, false, 'malformed 状态结算后详情忙态必须释放');
}

const historyFingerprintA = 'a'.repeat(64);
const historyFingerprintB = 'b'.repeat(64);
const historyAccountA = { id: 'history-account', manual_key_account_fingerprint: historyFingerprintA };
const historyContextTracker = createHistoryAccountContextTracker(historyAccountA);
const historyPageState = { accountId: 'history-account', cleared: 0, reloads: 0 };
const applyHistoryAccountStoreUpdate = account => {
  const change = historyContextTracker.update(account);
  if (!change.changed) return;
  historyPageState.accountId = String(account?.id || account?.account_id || '').trim();
  if (historyPageState.accountScope !== 'all') {
    historyPageState.cleared += 1;
    historyPageState.reloads += 1;
  }
};

applyHistoryAccountStoreUpdate({ ...historyAccountA, display_name: '刷新后的展示名' });
assert.equal(historyPageState.cleared, 0,
  '同账号同 fingerprint 的对象刷新不得清理历史当前结果');
assert.equal(historyPageState.reloads, 0,
  '同账号同 fingerprint 的对象刷新不得重复读取历史');

applyHistoryAccountStoreUpdate({ ...historyAccountA, manual_key_account_fingerprint: historyFingerprintB });
assert.equal(historyPageState.cleared, 1,
  '同账号 fingerprint 变化必须清理历史当前结果与详情');
assert.equal(historyPageState.reloads, 1,
  '同账号 fingerprint 变化必须重新读取当前账号历史');

const historySource = await readFile(new URL('../src/web/public/js/pages/history/index.js', import.meta.url), 'utf8');
const scheduleCrossTabReloadSource = extractFunction(historySource, 'function scheduleCrossTabListReload()');
const scheduledTimers = [];
const staleListLoad = deferred();
const crossTabPage = { destroyed: false, detail: null, crossTabReloadTimer: null };
let focusRestores = 0;
const scheduleCrossTabReload = new Function(
  'page',
  'setTimeout',
  'clearTimeout',
  'loadFirstPage',
  'restorePersistedFocus',
  `${scheduleCrossTabReloadSource}\nreturn scheduleCrossTabListReload;`,
)(
  crossTabPage,
  callback => {
    scheduledTimers.push(callback);
    return scheduledTimers.length;
  },
  () => {},
  () => staleListLoad.promise,
  async () => { focusRestores += 1; },
);
scheduleCrossTabReload();
assert.equal(scheduledTimers.length, 1, '跨标签未知记录必须调度一次防抖列表刷新');
scheduledTimers[0]();
await flush();
staleListLoad.resolve(false);
await flush();
assert.equal(focusRestores, 0,
  '跨标签列表请求被用户的新查询 supersede 后，旧完成不得恢复旧卡片焦点');
const currentTimers = [];
let currentFocusRestores = 0;
const scheduleCurrentCrossTabReload = new Function(
  'page',
  'setTimeout',
  'clearTimeout',
  'loadFirstPage',
  'restorePersistedFocus',
  `${scheduleCrossTabReloadSource}\nreturn scheduleCrossTabListReload;`,
)(
  { destroyed: false, detail: null, crossTabReloadTimer: null },
  callback => {
    currentTimers.push(callback);
    return currentTimers.length;
  },
  () => {},
  async () => true,
  async () => { currentFocusRestores += 1; },
);
scheduleCurrentCrossTabReload();
currentTimers[0]();
await flush();
assert.equal(currentFocusRestores, 1,
  '仍属当前筛选的跨标签重载成功后应恢复原有卡片焦点');

// 旧防抖 callback 可能已进入事件队列,clearTimeout 不能保证撤回它。
// 它不得夺走新 callback 的 timer owner,也不得重复触发列表重载。
const ownerTimers = new Map();
let ownerTimerId = 0;
let ownerReloads = 0;
const ownerPage = { destroyed: false, detail: null, crossTabReloadTimer: null };
const scheduleOwnerCrossTabReload = new Function(
  'page',
  'setTimeout',
  'clearTimeout',
  'loadFirstPage',
  'restorePersistedFocus',
  `${scheduleCrossTabReloadSource}\nreturn scheduleCrossTabListReload;`,
)(
  ownerPage,
  callback => {
    const id = ++ownerTimerId;
    ownerTimers.set(id, callback);
    return id;
  },
  () => {
    // 保留 callback,模拟已经排队而无法撤回的浏览器 timer。
  },
  async () => { ownerReloads += 1; return true; },
  async () => {},
);
scheduleOwnerCrossTabReload();
const oldOwnerTimer = ownerPage.crossTabReloadTimer;
scheduleOwnerCrossTabReload();
const currentOwnerTimer = ownerPage.crossTabReloadTimer;
ownerTimers.get(oldOwnerTimer)();
await flush();
assert.equal(ownerReloads, 0, '已排队的旧跨标签 timer 不得触发当前列表重载');
assert.equal(ownerPage.crossTabReloadTimer, currentOwnerTimer,
  '已排队的旧跨标签 timer 不得清掉新 timer owner');
ownerTimers.get(currentOwnerTimer)();
await flush();
assert.equal(ownerReloads, 1, '当前跨标签 timer 最终应只触发一次列表重载');

// 搜索防抖也可能遇到同样的已入队旧 callback:输入 B 后,A callback 不得
// 清掉 B 的 timer 或触发一次过期查询。
const scheduleSearchCommitSource = extractFunction(historySource, 'function scheduleSearchCommit()');
const searchTimers = new Map();
let searchTimerId = 0;
let searchLoads = 0;
let committedSearches = 0;
const searchPage = { searchTimer: null };
const scheduleSearchCommit = new Function(
  'page',
  'setTimeout',
  'clearTimeout',
  'commitSearchDraft',
  'loadFirstPage',
  'SEARCH_DEBOUNCE_MS',
  `${scheduleSearchCommitSource}\nreturn scheduleSearchCommit;`,
)(
  searchPage,
  callback => {
    const id = ++searchTimerId;
    searchTimers.set(id, callback);
    return id;
  },
  () => {
    // 保留 callback,模拟已经排队而无法撤回的浏览器 timeout。
  },
  () => { committedSearches += 1; return true; },
  () => { searchLoads += 1; },
  180,
);
scheduleSearchCommit();
const oldSearchTimer = searchPage.searchTimer;
scheduleSearchCommit();
const currentSearchTimer = searchPage.searchTimer;
searchTimers.get(oldSearchTimer)();
assert.equal(searchLoads, 0, '已排队的旧搜索 timer 不得触发过期列表查询');
assert.equal(searchPage.searchTimer, currentSearchTimer,
  '已排队的旧搜索 timer 不得清掉新搜索 timer owner');
searchTimers.get(currentSearchTimer)();
assert.equal(committedSearches, 1, '当前搜索 timer 应只提交一次搜索草稿');
assert.equal(searchLoads, 1, '当前搜索 timer 应只触发一次列表查询');

const destroyedSearchPage = { destroyed: false, searchTimer: null };
const destroyedSearchTimers = new Map();
let destroyedSearchTimerId = 0;
let destroyedSearchCommits = 0;
let destroyedSearchLoads = 0;
const scheduleDestroyedSearchCommit = new Function(
  'page',
  'setTimeout',
  'clearTimeout',
  'commitSearchDraft',
  'loadFirstPage',
  'SEARCH_DEBOUNCE_MS',
  `${scheduleSearchCommitSource}\nreturn scheduleSearchCommit;`,
)(
  destroyedSearchPage,
  callback => {
    const id = ++destroyedSearchTimerId;
    destroyedSearchTimers.set(id, callback);
    return id;
  },
  () => {},
  () => { destroyedSearchCommits += 1; return true; },
  () => { destroyedSearchLoads += 1; },
  180,
);
scheduleDestroyedSearchCommit();
const destroyedSearchTimer = destroyedSearchPage.searchTimer;
destroyedSearchPage.destroyed = true;
destroyedSearchTimers.get(destroyedSearchTimer)();
assert.equal(destroyedSearchCommits, 0, '页面销毁后的已排队搜索 timer 不得提交草稿');
assert.equal(destroyedSearchLoads, 0, '页面销毁后的已排队搜索 timer 不得发起列表查询');

// 详情 A 关闭后如果在同一帧打开详情 B,旧关闭回调不得把焦点抢回 A 卡片。
const restoreDetailFocusSource = extractFunction(historySource, 'function restoreDetailFocus(');
const restoreScheduled = [];
let staleDetailFocusWrites = 0;
let staleTitleFocusWrites = 0;
const bodyElement = {};
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalRequestAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { activeElement: bodyElement, body: bodyElement, documentElement: {} },
});
Object.defineProperty(globalThis, 'requestAnimationFrame', {
  configurable: true,
  value: callback => { restoreScheduled.push(callback); },
});
try {
  const restorePage = { destroyed: false, listSeq: 4, detail: null };
  const restoreDetailFocus = new Function(
    'page',
    'grid',
    'pageTitle',
    'findHistoryFocusTarget',
    'schedule',
    `${restoreDetailFocusSource}\nreturn restoreDetailFocus;`,
  )(
    restorePage,
    {},
    { focus() { staleTitleFocusWrites += 1; } },
    () => ({ focus() { staleDetailFocusWrites += 1; } }),
    callback => { restoreScheduled.push(callback); },
  );
  restoreDetailFocus('history-a', 'card');
  restorePage.detail = { item: { key: 'history-b' } };
  restoreScheduled.shift()();
  assert.equal(staleDetailFocusWrites, 0,
    '新详情已打开时,旧详情关闭后的晚到 focus 不得写回旧卡片');
  assert.equal(staleTitleFocusWrites, 0,
    '新详情已打开时,旧详情关闭后的晚到 focus 不得抢到页面标题');
  restorePage.detail = null;
  restoreDetailFocus('history-a', 'card');
  restoreScheduled.shift()();
  assert.equal(staleDetailFocusWrites, 1,
    '没有后继详情时,当前关闭动作仍应恢复原卡片焦点');
} finally {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete globalThis.document;
  if (originalRequestAnimationFrame) Object.defineProperty(globalThis, 'requestAnimationFrame', originalRequestAnimationFrame);
  else delete globalThis.requestAnimationFrame;
}
assert.match(historySource,
  /searchInput\.addEventListener\('input',[\s\S]*?scheduleSearchCommit\(\);[\s\S]*?renderMore\(\);/,
  '输入事件必须经过带 owner 校验的搜索防抖 helper');
assert.match(historySource, /createHistoryStatusRefreshController/, '生产 history 页面必须使用共享状态刷新协调器');
assert.match(historySource, /statusRefresh\.refresh\(item, options\)/,
  '生产 refreshItemStatus 必须委托给共享状态刷新协调器');
assert.match(historySource, /signal: detail\.controller\.signal,[\s\S]*isActive:/,
  '详情 revalidator 必须绑定详情 AbortSignal');
assert.match(historySource, /getDetail: item => page\.detail && itemKey\(page\.detail\.item\) === itemKey\(item\)[\s\S]*\? page\.detail[\s\S]*: null,/,
  '状态刷新只能捕获与目标同键的详情');
assert.match(historySource, /queueHistoryCrossTabItemRefresh\(\{[\s\S]*refreshListItem: \(\) => refreshCrossTabListItemAt\(index\)/,
  '生产 storage 更新路径必须用协调器分流同项详情与异项列表刷新');
assert.match(historySource, /function abortCrossTabListItemRefreshes\(\)[\s\S]*controller\.abort\(\)/,
  '页面级跨标签刷新必须在列表换代与卸载时可取消');
assert.doesNotMatch(historySource, /const index = page\.items\.findIndex\([^\n]+\);\s*if \(index < 0\) return;/,
  '未知列表键可能是刚进入当前筛选的记录，不得提前丢弃通知');
assert.match(historySource, /function scheduleCrossTabListReload\(\)[\s\S]*loadFirstPage\(\{ refresh: true \}\)/,
  '未知列表键必须防抖刷新当前筛选，不能永久保持旧空态');
assert.match(historySource, /createHistoryAccountContextTracker\(store\.get\('account'\)\)/,
  '历史页必须从挂载时账号初始化稳定安全上下文跟踪器');
assert.match(historySource,
  /const change = page\.accountContext\.update\(account\);[\s\S]*?if \(!change\.changed\) return;[\s\S]*?closeDetail\(\);[\s\S]*?loadFirstPage\(\{ clearItems: true \}\)/,
  '历史页账号订阅必须对 fingerprint 变化执行当前结果清理与重载');

console.log('web history cross-tab refresh tests passed');
