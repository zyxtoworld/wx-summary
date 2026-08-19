import assert from 'node:assert/strict';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';
import { readFile } from 'node:fs/promises';

class MemoryStorage {
  #values = new Map();
  getItem(key) { return this.#values.get(String(key)) ?? null; }
  setItem(key, value) { this.#values.set(String(key), String(value)); }
  removeItem(key) { this.#values.delete(String(key)); }
}

const loader = createBrowserModuleLoader();
const { historyStorageKeys } = await loader.load('js/pages/history/storage.js');
const {
  createHistoryViewStateStorage,
  restoreHistoryListFocus,
} = await loader.load('js/pages/history/view-state.js');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
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

const origin = 'http://wx-summary.test';
const keys = historyStorageKeys(origin);
const storage = new MemoryStorage();
const persisted = createHistoryViewStateStorage({ storage, keys });

persisted.write({
  filter: 'issues',
  accountScope: 'all',
  q: '目标群',
  focusKey: 'history-target-key',
  focusAction: 'related-markdown',
});
assert.deepEqual(persisted.read(), {
  filter: 'issues',
  accountScope: 'all',
  q: '目标群',
  focusKey: 'history-target-key',
  focusAction: 'related-markdown',
}, '历史视图必须通过当前无版本键保存并恢复焦点身份');
assert.equal(storage.getItem(keys.view) !== null, true);
assert.equal(storage.getItem(`wx-summary:history-view:v3:${origin}`), null, '不得写入另一个 vN 历史键');

const loadedKeys = ['first-page-item'];
const focusCalls = [];
let pageIndex = 0;
const pages = [
  ['second-page-item'],
  ['history-target-key'],
];
const restored = await restoreHistoryListFocus({
  focusKey: 'history-target-key',
  focusAction: 'related-markdown',
  findTarget: (focusKey, focusAction) => {
    if (!loadedKeys.includes(focusKey)) return null;
    return { focus: () => focusCalls.push(`${focusKey}:${focusAction}`) };
  },
  canLoadMore: () => pageIndex < pages.length,
  loadMore: async () => {
    loadedKeys.push(...pages[pageIndex]);
    pageIndex += 1;
    return true;
  },
  focusHeading: () => focusCalls.push('heading'),
});
assert.deepEqual(restored, { status: 'restored', loadedPages: 2 });
assert.deepEqual(focusCalls, ['history-target-key:related-markdown'], '目标动作必须在分页加载完成后恢复焦点');

let missingPageLoaded = false;
let headingFocused = 0;
const missing = await restoreHistoryListFocus({
  focusKey: 'deleted-history-item',
  focusAction: 'card',
  findTarget: () => null,
  canLoadMore: () => !missingPageLoaded,
  loadMore: async () => { missingPageLoaded = true; return true; },
  focusHeading: () => { headingFocused += 1; },
});
assert.deepEqual(missing, { status: 'missing', loadedPages: 1 });
assert.equal(headingFocused, 1, '保存的目标缺失时必须回退聚焦历史页标题');

let stillActive = true;
let cancelledHeadingFocused = 0;
const cancelled = await restoreHistoryListFocus({
  focusKey: 'stale-history-item',
  focusAction: 'card',
  findTarget: () => null,
  canLoadMore: () => stillActive,
  loadMore: async () => {
    stillActive = false;
    return false;
  },
  isActive: () => stillActive,
  focusHeading: () => { cancelledHeadingFocused += 1; },
});
assert.deepEqual(cancelled, { status: 'cancelled', loadedPages: 0 },
  '页面销毁或恢复代过期时不得把中止的分页恢复当成普通缺失');
assert.equal(cancelledHeadingFocused, 0, '过期焦点恢复不得再聚焦旧历史页标题');

const historySource = await readFile(
  new URL('../src/web/public/js/pages/history/index.js', import.meta.url),
  'utf8',
);
const productionRestoreSource = extractFunction(historySource, 'async function restorePersistedFocus()');
const pagination = deferred();
const productionPage = {
  status: 'ready',
  focusKey: 'stale-history-item',
  focusAction: 'card',
  listSeq: 7,
  destroyed: false,
  searchScanHasMore: false,
  hasMore: true,
};
let productionHeadingFocus = 0;
let productionPrefsWrites = 0;
const productionRestore = new Function(
  'page',
  'restoreHistoryListFocus',
  'findHistoryFocusTarget',
  'grid',
  'loadMore',
  'pageTitle',
  'saveViewPrefs',
  'historyInitialFocusCanRestore',
  `${productionRestoreSource}\nreturn restorePersistedFocus;`,
)(
  productionPage,
  restoreHistoryListFocus,
  () => null,
  {},
  () => pagination.promise,
  { focus() { productionHeadingFocus += 1; } },
  () => { productionPrefsWrites += 1; },
  () => true,
);
const staleProductionRestore = productionRestore();
await Promise.resolve();
productionPage.listSeq += 1;
pagination.resolve(false);
await staleProductionRestore;
assert.equal(productionHeadingFocus, 0,
  '分页焦点恢复期间列表换代后不得把焦点移到新列表标题');
assert.equal(productionPage.focusKey, 'stale-history-item',
  '分页焦点恢复期间列表换代不得清掉新列表仍可能使用的持久焦点身份');
assert.equal(productionPrefsWrites, 0,
  '过期焦点恢复不得回写新列表视图偏好');

// 焦点恢复分页期间打开详情时，旧恢复 owner 不得抢走当前详情的焦点。
{
  const detailRacePagination = deferred();
  const detailRacePage = {
    status: 'ready',
    focusKey: 'detail-race-target',
    focusAction: 'card',
    listSeq: 30,
    destroyed: false,
    detail: null,
    searchScanHasMore: false,
    hasMore: true,
  };
  let detailRaceHeadingFocus = 0;
  let detailRaceMoreCalls = 0;
  const detailRaceRestore = new Function(
    'page',
    'restoreHistoryListFocus',
    'findHistoryFocusTarget',
    'grid',
    'loadMore',
    'pageTitle',
    'saveViewPrefs',
    'historyInitialFocusCanRestore',
    `${productionRestoreSource}\nreturn restorePersistedFocus;`,
  )(
    detailRacePage,
    restoreHistoryListFocus,
    () => null,
    {},
    async () => {
      detailRaceMoreCalls += 1;
      await detailRacePagination.promise;
      detailRacePage.hasMore = false;
      return true;
    },
    { focus() { detailRaceHeadingFocus += 1; } },
    () => {},
    () => true,
  );
  const pendingDetailRaceRestore = detailRaceRestore();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(detailRaceMoreCalls, 1, '详情竞态前必须确实进入分页焦点恢复');
  detailRacePage.detail = { item: { key: 'detail-race-current' } };
  detailRacePagination.resolve();
  await pendingDetailRaceRestore;
  assert.equal(detailRaceHeadingFocus, 0,
    '分页焦点恢复完成前打开详情时，旧恢复不得抢当前详情焦点');
}

const claimedFocusPage = {
  ...productionPage,
  listSeq: 20,
  focusKey: 'user-focus-target',
  focusAction: 'card',
  hasMore: false,
};
let claimedHeadingFocus = 0;
const claimedFocusRestore = new Function(
  'page',
  'restoreHistoryListFocus',
  'findHistoryFocusTarget',
  'grid',
  'loadMore',
  'pageTitle',
  'saveViewPrefs',
  'historyInitialFocusCanRestore',
  `${productionRestoreSource}\nreturn restorePersistedFocus;`,
)(
  claimedFocusPage,
  restoreHistoryListFocus,
  () => null,
  {},
  async () => false,
  { focus() { claimedHeadingFocus += 1; } },
  () => { throw new Error('用户已占用焦点时不得写偏好'); },
  () => false,
);
await claimedFocusRestore();
assert.equal(claimedHeadingFocus, 0,
  '用户在恢复前已操作搜索或筛选控件时不得抢回历史标题焦点');
assert.equal(claimedFocusPage.focusKey, 'user-focus-target');
assert.match(historySource,
  /const restorationIsCurrent = \(\) => !page\.destroyed[\s\S]*?page\.listSeq === listSeq[\s\S]*?historyInitialFocusCanRestore\(\{ pageTitle \}\)[\s\S]*?isActive: restorationIsCurrent/,
  '历史页必须把列表代次、焦点身份和用户焦点所有权传给持久焦点恢复器');

console.log('history view focus persistence tests passed');
