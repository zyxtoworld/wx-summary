import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { invalidateHistoryDetailForDeletedItem } from '../src/web/public/js/pages/history/cross-tab.js';
import { historyStorageKeys } from '../src/web/public/js/pages/history/storage.js';

const detail = { item: { key: 'history-a' }, invalidated: false };
const itemKey = item => item?.key || '';
assert.equal(invalidateHistoryDetailForDeletedItem({
  detail,
  deletedKey: 'history-a',
  itemKey,
}), true);
assert.equal(detail.invalidated, true, '跨标签删除当前详情时必须永久标记该详情结果失效');
assert.equal(detail.suppressLateActionOutcome, true,
  '跨标签删除当前详情时必须禁止旧动作离屏结果投影');

const otherDetail = { item: { key: 'history-b' }, invalidated: false };
assert.equal(invalidateHistoryDetailForDeletedItem({
  detail: otherDetail,
  deletedKey: 'history-a',
  itemKey,
}), false);
assert.equal(otherDetail.invalidated, false, '删除其他记录不得使当前详情失效');
assert.equal(invalidateHistoryDetailForDeletedItem({ detail, deletedKey: '', itemKey }), false,
  '缺少删除身份时必须 fail closed');

const historySource = await readFile(new URL('../src/web/public/js/pages/history/index.js', import.meta.url), 'utf8');

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
  const signatureEnd = source.indexOf(') {', start);
  assert.notEqual(signatureEnd, -1, `missing production function body: ${marker}`);
  const brace = signatureEnd + 2;
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '`' || char === '\'' || char === '"') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated production function: ${marker}`);
}

// 真实生产 loadFirstPage/onStorageEvent 序列：列表请求在途时，另一标签页删除同一记录，
// 旧响应即使忽略 abort 也不得把已删除记录重新写回当前页。
{
  const loadFirstPageSource = extractFunction(historySource, 'async function loadFirstPage(');
  const invalidateListRequestsSource = extractFunction(historySource, 'function invalidateCrossTabListRequests(');
  const onStorageEventSource = extractFunction(historySource, 'function onStorageEvent(');
  const pending = deferred();
  const page = {
    destroyed: false,
    crossTabReloadTimer: null,
    crossTabRefreshes: new Map(),
    listSeq: 0,
    listController: null,
    moreController: null,
    loadingMore: false,
    items: [{ key: 'history-a' }],
    status: 'ready',
    errorText: '',
    autoDiscoveryPasses: 0,
    autoDiscoveryTimer: null,
  };
  let reloadScheduled = 0;
  const refreshBtn = { disabled: false };
  const loadFirstPage = new Function(
    'page',
    'clearAutoDiscoveryTimer',
    'abortCrossTabListItemRefreshes',
    'clearTimeout',
    'setTimeout',
    'historyListPath',
    'api',
    'refreshBtn',
    'renderAll',
    'clearThumbCache',
    'applyListPage',
    'shouldQueueHistoryAutoDiscovery',
    'HISTORY_AUTO_DISCOVERY_PASS_LIMIT',
    `${loadFirstPageSource}; return loadFirstPage;`,
  )(
    page,
    () => {},
    () => {},
    globalThis.clearTimeout,
    globalThis.setTimeout,
    () => '/api/history?fixture=delete-race',
    { get() { return pending.promise; } },
    refreshBtn,
    () => {},
    () => {},
    payload => { page.items = (payload?.items || []).slice(); },
    () => false,
    3,
  );
  const invalidateCrossTabListRequests = new Function(
    'page',
    'abortCrossTabListItemRefreshes',
    `${invalidateListRequestsSource}; return invalidateCrossTabListRequests;`,
  )(page, () => {});
  const onStorageEvent = new Function(
    'page',
    'CROSS_TAB_KEY',
    'invalidateCrossTabListRequests',
    'invalidateHistoryDetailForDeletedItem',
    'closeDetail',
    'removeHistoryListItemAt',
    'renderAll',
    'closeAllModals',
    'ui',
    'pageTitle',
    'queueHistoryCrossTabItemRefresh',
    'itemKey',
    'refreshCrossTabListItemAt',
    'scheduleCrossTabListReload',
    `${onStorageEventSource}; return onStorageEvent;`,
  )(
    page,
    historyStorageKeys('http://wx-summary.test').itemUpdated,
    invalidateCrossTabListRequests,
    invalidateHistoryDetailForDeletedItem,
    () => {},
    index => { page.items.splice(index, 1); },
    () => {},
    () => {},
    { toastWarn() {} },
    { focus() {} },
    () => 'ignored',
    itemKey,
    () => {},
    () => { reloadScheduled += 1; },
  );

  const loading = loadFirstPage();
  assert.equal(page.status, 'loading', '删除事件前列表请求必须确实处于在途状态');
  onStorageEvent({
    key: historyStorageKeys('http://wx-summary.test').itemUpdated,
    newValue: JSON.stringify({ key: 'history-a', deleted: true }),
  });
  assert.deepEqual(page.items, [], '删除事件必须立即移除当前列表项');

  pending.resolve({ items: [{ key: 'history-a' }], total: 1 });
  assert.equal(await loading, false,
    '删除事件后旧列表请求即使晚到也必须被当前列表代际拒绝');
  assert.deepEqual(page.items, [], '已删除记录不得被旧列表响应重新写回');
  assert.equal(reloadScheduled, 1, '删除事件必须安排一次权威列表重载');
}

// 真实生产 onStorageEvent→closeDetail→runDetailAction 序列:
// 跨标签删除关闭详情后,旧动作即使忽略 abort 晚到,也不得把成功/未知结果投影为当前页面提示。
{
  const closeDetailSource = extractFunction(historySource, 'function closeDetail(');
  const runDetailActionSource = extractFunction(historySource, 'async function runDetailAction(');
  const onStorageEventSource = extractFunction(historySource, 'function onStorageEvent(');
  const item = { key: 'history-detail-delete-race' };
  const pending = deferred();
  const controller = new AbortController();
  const detail = {
    item,
    modal: { close() {} },
    controller,
    revalidator: null,
    pendingTimers: [],
    busy: false,
    invalidated: false,
  };
  const page = {
    destroyed: false,
    detail,
    items: [item],
    crossTabReloadTimer: null,
  };
  let toastSuccesses = 0;
  let toastWarnings = 0;
  let applied = 0;
  let statusWrites = 0;
  const ui = {
    toastSuccess() { toastSuccesses += 1; },
    toast() { toastWarnings += 1; },
    toastWarn() {},
  };
  const closeDetail = new Function(
    'page',
    'clearDetailTimers',
    `${closeDetailSource}; return closeDetail;`,
  )(page, () => {});
  const runDetailAction = new Function(
    'page',
    'detailBusy',
    'setDetailStatus',
    'actionAccountIdForItem',
    'actionAccountFingerprintForItem',
    'actionResultStillApplies',
    'ui',
    'applyOutcomeItem',
    'closeDetail',
    `${runDetailActionSource}; return runDetailAction;`,
  )(
    page,
    (busy) => { detail.busy = busy; },
    () => { statusWrites += 1; },
    () => 'account-a',
    () => '',
    () => true,
    ui,
    () => { applied += 1; },
    closeDetail,
  );
  const onStorageEvent = new Function(
    'page',
    'CROSS_TAB_KEY',
    'invalidateCrossTabListRequests',
    'invalidateHistoryDetailForDeletedItem',
    'closeDetail',
    'removeHistoryListItemAt',
    'renderAll',
    'closeAllModals',
    'ui',
    'pageTitle',
    'queueHistoryCrossTabItemRefresh',
    'itemKey',
    'refreshCrossTabListItemAt',
    'scheduleCrossTabListReload',
    `${onStorageEventSource}; return onStorageEvent;`,
  )(
    page,
    historyStorageKeys('http://wx-summary.test').itemUpdated,
    () => {},
    invalidateHistoryDetailForDeletedItem,
    closeDetail,
    index => { page.items.splice(index, 1); },
    () => {},
    () => {},
    ui,
    { focus() {} },
    () => 'ignored',
    itemKey,
    () => {},
    () => {},
  );

  const action = runDetailAction(
    '删除',
    () => pending.promise,
    { removesItem: true, closesDetail: true },
  );
  await Promise.resolve();
  assert.equal(detail.busy, true, '跨标签删除前旧详情动作必须确实持有 busy');
  onStorageEvent({
    key: historyStorageKeys('http://wx-summary.test').itemUpdated,
    newValue: JSON.stringify({ key: item.key, deleted: true }),
  });
  assert.equal(page.detail, null, '跨标签删除必须关闭当前详情');
  assert.equal(detail.invalidated, true, '跨标签删除必须使旧详情永久失效');
  assert.equal(controller.signal.aborted, true, '关闭详情必须中止旧动作信号');
  pending.resolve({ status: 'verified', message: '旧动作已完成', item });
  await action;
  assert.equal(toastSuccesses, 0, '已被跨标签删除的旧动作晚到成功不得提示成功');
  assert.equal(toastWarnings, 0, '已被跨标签删除的旧动作晚到结果未知不得提示警告');
  assert.equal(applied, 0, '已失效详情的旧动作不得归并结果');
  assert.equal(statusWrites, 1, '旧动作只允许写入开始状态,晚到收尾不得再写当前详情');
}

assert.match(historySource, /const detailDeleted = invalidateHistoryDetailForDeletedItem\(/,
  '生产 storage 删除路径必须先使匹配详情失效');
assert.match(historySource, /if \(detailDeleted\) closeDetail\(\);[\s\S]*removeHistoryListItemAt\(index\);[\s\S]*ui\.toastWarn\('这条历史已在另一个页面被删除。'\)/,
  '生产跨标签删除必须关闭旧详情、统一移除计数并给出可见反馈');
assert.match(historySource, /pageTitle\.focus\(\{ preventScroll: true \}\)/,
  '删除已打开详情后必须把焦点移到仍存在的页面标题');
assert.ok((historySource.match(/detail\.invalidated !== true/g) || []).length >= 2,
  '通用操作与导出 MD 的离屏结果都不得写回已失效详情');

console.log('web history cross-tab delete tests passed');
