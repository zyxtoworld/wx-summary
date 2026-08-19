import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

globalThis.location = new URL('http://wx-summary.test/#/history');
const loader = createBrowserModuleLoader();
const {
  HISTORY_AUTO_DISCOVERY_PASS_LIMIT,
  shouldQueueHistoryAutoDiscovery,
} = await loader.load('js/pages/history/auto-discovery.js');

assert.equal(HISTORY_AUTO_DISCOVERY_PASS_LIMIT, 2, '自动发现必须有明确的两次上限');
assert.equal(shouldQueueHistoryAutoDiscovery({
  items: [],
  incompleteReasons: ['history_base_scan_limited'],
  pass: 0,
}), true, '空结果且旧目录扫描未完成时应触发自动刷新扫描');
assert.equal(shouldQueueHistoryAutoDiscovery({
  items: [],
  incompleteReasons: [{ code: 'history_search_scan_pending' }],
  pass: 1,
}), true, '搜索扫描仍在进行时第二轮自动扫描仍可执行');
assert.equal(shouldQueueHistoryAutoDiscovery({
  items: [],
  incompleteReasons: ['history_base_scan_limited'],
  pass: 2,
}), false, '达到上限后不得继续自动刷新');
assert.equal(shouldQueueHistoryAutoDiscovery({
  items: [{ digest_id: 'visible' }],
  incompleteReasons: ['history_base_scan_limited'],
  pass: 0,
}), false, '已有可见结果时不得用自动刷新覆盖用户列表');
assert.equal(shouldQueueHistoryAutoDiscovery({
  items: [],
  incompleteReasons: ['history_search_index_bounded'],
  pass: 0,
}), false, '与发现无关的警示不得触发额外刷新');

// 首屏空结果安排自动发现后，真实“加载更多”caller 仍可能在同一事件循环
// 启动（例如持久化焦点恢复需要先翻页）。自动任务不得抢占这次分页并使其
// 晚到结果因 listSeq 换代而丢失。
{
  const source = await readFile(
    new URL('../src/web/public/js/pages/history/index.js', import.meta.url),
    'utf8',
  );
  const extractFunction = (marker) => {
    const start = source.indexOf(marker);
    assert.ok(start >= 0, `必须能定位生产函数: ${marker}`);
    const parameterEnd = source.indexOf(')', start);
    const bodyStart = source.indexOf('{', parameterEnd + 1);
    assert.ok(parameterEnd >= 0 && bodyStart > parameterEnd,
      `必须能定位生产函数体: ${marker}`);
    let depth = 0;
    let quote = '';
    let escaped = false;
    for (let index = bodyStart; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = '';
        continue;
      }
      if (char === '\'' || char === '"' || char === '`') {
        quote = char;
        continue;
      }
      if (char === '{') depth += 1;
      else if (char === '}' && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`无法提取生产函数: ${marker}`);
  };
  const loadFirstPageSource = extractFunction('async function loadFirstPage(');
  const loadMoreSource = extractFunction('async function loadMore()');
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
  const timers = new Map();
  let nextTimerId = 0;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const runTimers = () => {
    for (const [id, entry] of [...timers]) {
      timers.delete(id);
      entry.callback(...entry.args);
    }
  };
  globalThis.setTimeout = (callback, _delay = 0, ...args) => {
    const id = ++nextTimerId;
    timers.set(id, { callback, args });
    return id;
  };
  globalThis.clearTimeout = id => { timers.delete(id); };
  try {
    const page = {
      destroyed: false,
      crossTabReloadTimer: null,
      listSeq: 0,
      listController: null,
      moreController: null,
      loadingMore: false,
      autoDiscoveryPasses: 0,
      items: [],
      status: 'idle',
      errorText: '',
      incompleteReasons: [],
      hasMore: false,
      nextCursor: '',
      searchScanHasMore: false,
      nextSearchCursor: '',
      autoDiscoveryTimer: null,
      q: '',
      filter: 'ok',
      accountScope: 'current',
    };
    const first = deferred();
    const more = deferred();
    const refresh = deferred();
    const requests = [];
    const api = {
      get(path, options) {
        requests.push({ path, signal: options.signal });
        if (requests.length === 1) return first.promise;
        if (requests.length === 2) return more.promise;
        return refresh.promise;
      },
    };
    const applyListPage = (payload, { reset }) => {
      const items = Array.isArray(payload?.items) ? payload.items : [];
      page.items = reset ? items.slice() : [...page.items, ...items];
      page.hasMore = payload?.has_more === true && !!String(payload?.next_cursor || '').trim();
      page.nextCursor = String(payload?.next_cursor || '').trim();
      page.searchScanHasMore = false;
      page.nextSearchCursor = '';
      page.incompleteReasons = Array.isArray(payload?.incomplete_reasons)
        ? payload.incomplete_reasons : [];
    };
    const refreshBtn = { disabled: false };
    const moreBtn = { disabled: false };
    const fakeGlobal = { document: { activeElement: null } };
    const clearAutoDiscoveryTimer = () => {
      if (page.autoDiscoveryTimer === null) return;
      globalThis.clearTimeout(page.autoDiscoveryTimer);
      page.autoDiscoveryTimer = null;
    };
    const loadFirstPage = new Function(
      'page', 'clearAutoDiscoveryTimer', 'abortCrossTabListItemRefreshes', 'clearThumbCache', 'refreshBtn',
      'renderAll', 'api', 'historyListPath', 'applyListPage',
      'shouldQueueHistoryAutoDiscovery', 'HISTORY_AUTO_DISCOVERY_PASS_LIMIT',
      `${loadFirstPageSource}; return loadFirstPage;`,
    )(
      page, clearAutoDiscoveryTimer, () => {}, () => {}, refreshBtn, () => {}, api, () => '/api/history',
      applyListPage, shouldQueueHistoryAutoDiscovery, HISTORY_AUTO_DISCOVERY_PASS_LIMIT,
    );
    const loadMore = new Function(
      'page', 'clearAutoDiscoveryTimer', 'api', 'historyListPath', 'captureActionFocus', 'globalThis', 'moreBtn',
      'moreStatus', 'renderMore', 'renderAll', 'applyListPage', 'ui', 'restoreHistoryPaginationFocus', 'grid',
      'pageTitle', `${loadMoreSource}; return loadMore;`,
    )(
      page, clearAutoDiscoveryTimer, api, () => '/api/history?cursor=cursor-1', () => null, fakeGlobal, moreBtn,
      { textContent: '' }, () => {}, () => {}, applyListPage, { toastError() {} }, () => {}, {}, {},
    );

    const initial = loadFirstPage();
    first.resolve({
      ok: true,
      items: [],
      has_more: true,
      next_cursor: 'cursor-1',
      incomplete_reasons: ['history_base_scan_limited'],
    });
    assert.equal(await initial, true,
      `首屏空结果必须完成并安排自动发现: status=${page.status} error=${page.errorText} seq=${page.listSeq} requests=${requests.length}`);
    assert.equal(timers.size, 1, '空结果必须留下一个待执行自动发现任务');

    const pagination = loadMore();
    assert.equal(requests.length, 2, '用户分页必须先发出自己的请求');
    runTimers();
    assert.equal(requests.length, 2,
      '分页开始后必须取消待执行自动发现，不得再启动抢占式首屏请求');
    more.resolve({
      ok: true,
      items: [{ history_item_key: 'loaded-by-more' }],
      has_more: false,
      next_cursor: '',
      incomplete_reasons: [],
    });
    assert.equal(await pagination, true,
      `被允许完成的分页请求必须成功结算: status=${page.status} seq=${page.listSeq} error=${page.errorText}`);
    assert.deepEqual(page.items, [{ history_item_key: 'loaded-by-more' }],
      '分页结果必须保留在当前列表');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

console.log('web history auto discovery tests passed');
