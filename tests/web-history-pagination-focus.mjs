import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { restoreHistoryPaginationFocus } from '../src/web/public/js/pages/history/view-state.js';

function extractFunction(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `必须能定位 ${marker}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${marker} 函数体未闭合`);
}

function control(name, documentTarget) {
  return {
    name,
    disabled: false,
    hidden: false,
    isConnected: true,
    focusCalls: 0,
    focus(options) {
      this.focusCalls += 1;
      this.focusOptions = options;
      documentTarget.activeElement = this;
    },
  };
}

const documentTarget = {};
documentTarget.body = control('body', documentTarget);
documentTarget.documentElement = control('html', documentTarget);
const trigger = control('more', documentTarget);
const first = control('first', documentTarget);
const appended = control('appended', documentTarget);
const container = {
  querySelectorAll() { return [first, appended]; },
};

documentTarget.activeElement = documentTarget.body;
assert.equal(restoreHistoryPaginationFocus({
  trigger,
  container,
  firstNewIndex: 1,
  documentTarget,
}), 'trigger', '仍可继续分页时焦点必须回到加载更多按钮');
assert.equal(documentTarget.activeElement, trigger);

trigger.hidden = true;
documentTarget.activeElement = trigger;
assert.equal(restoreHistoryPaginationFocus({
  trigger,
  container,
  firstNewIndex: 1,
  documentTarget,
}), 'appended', '末页按钮消失时焦点必须进入首个新增卡片');
assert.equal(documentTarget.activeElement, appended);
assert.deepEqual(appended.focusOptions, { preventScroll: false });

const explicit = control('explicit', documentTarget);
documentTarget.activeElement = explicit;
assert.equal(restoreHistoryPaginationFocus({
  trigger,
  container,
  firstNewIndex: 1,
  documentTarget,
}), 'preserved', '用户已主动移焦时分页完成不得抢回焦点');
assert.equal(documentTarget.activeElement, explicit);

const historySource = await readFile(
  new URL('../src/web/public/js/pages/history/index.js', import.meta.url),
  'utf8',
);
assert.match(
  historySource,
  /function searchDraftPending\(\)[\s\S]*?searchInput\.value\.trim\(\) !== page\.q/,
  '历史页必须显式识别尚未应用的搜索草稿',
);
assert.match(
  historySource,
  /function renderMore\(\)[\s\S]*?moreBtn\.disabled = page\.loadingMore \|\| searchDraftPending\(\)/,
  '搜索草稿待应用时必须同步禁用旧 cursor 的加载更多入口',
);
assert.match(
  historySource,
  /searchInput\.addEventListener\('input',[\s\S]*?renderMore\(\)/,
  '输入事件必须立即刷新分页门禁，不能等防抖请求开始后才禁用',
);
assert.match(
  historySource,
  /const focusTarget = captureActionFocus\(\[moreBtn\][\s\S]*?restoreHistoryPaginationFocus\(\{[\s\S]*?firstNewIndex/,
  '生产分页请求必须捕获触发焦点并在重绘后调用分页焦点协调器',
);

// 分页响应成功后到 rAF 焦点恢复之间，账号/筛选可使列表代次换新。
// 旧分页回调不得把焦点投影到新列表。
{
  const loadMoreSource = extractFunction(historySource, 'async function loadMore()');
  const scheduled = [];
  let restoreCalls = 0;
  const more = control('more-current', documentTarget);
  documentTarget.activeElement = more;
  const page = {
    destroyed: false,
    loadingMore: false,
    status: 'ready',
    searchScanHasMore: false,
    nextSearchCursor: '',
    hasMore: true,
    nextCursor: 'cursor-a',
    listSeq: 7,
    items: [{ id: 'a' }],
    moreController: null,
    autoDiscoveryTimer: null,
  };
  const loadMore = new Function(
    'page',
    'clearAutoDiscoveryTimer',
    'api',
    'historyListPath',
    'captureActionFocus',
    'moreBtn',
    'globalThis',
    'renderMore',
    'applyListPage',
    'renderAll',
    'ui',
    'restoreHistoryPaginationFocus',
    'grid',
    'pageTitle',
    `${loadMoreSource}; return loadMore;`,
  )(
    page,
    () => {},
    { get: async () => ({ items: [{ id: 'a-more' }] }) },
    () => '/api/history?cursor=cursor-a',
    () => more,
    more,
    {
      document: documentTarget,
      requestAnimationFrame(callback) { scheduled.push(callback); },
    },
    () => {},
    payload => { page.items.push(...payload.items); },
    () => {},
    { toastError() {} },
    () => { restoreCalls += 1; },
    { querySelectorAll: () => [] },
    control('history-title', documentTarget),
  );

  assert.equal(await loadMore(), true, 'A 分页请求必须先真实成功并安排焦点恢复');
  assert.equal(scheduled.length, 1);
  page.listSeq += 1;
  page.status = 'loading';
  scheduled[0]();
  assert.equal(restoreCalls, 0,
    'A 分页的旧 rAF 在列表切到 B 代次后不得执行焦点恢复');
}

console.log('web history pagination focus tests passed');
