import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { restoreHistoryRetryFocus } from '../src/web/public/js/pages/history/view-state.js';
import { requireHistoryListItems } from '../src/web/public/js/pages/history/list-state.js';

function extractFunction(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `必须能定位 ${marker}`);
  const signatureEnd = source.indexOf(') {', start);
  assert.ok(signatureEnd >= 0, `${marker} 必须有可定位的函数体`);
  const open = signatureEnd + 2;
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
const card = control('card', documentTarget);
const retry = control('retry', documentTarget);
const heading = control('heading', documentTarget);
let mode = 'card';
const container = {
  querySelector(selector) {
    if (selector === '[data-history-focus-action="card"]' && mode === 'card') return card;
    if (selector === '.empty-state button' && mode === 'retry') return retry;
    return null;
  },
};

documentTarget.activeElement = documentTarget.body;
assert.equal(restoreHistoryRetryFocus({
  shouldRestore: true,
  container,
  documentTarget,
  focusHeading: () => heading.focus({ preventScroll: true }),
}), 'card', '首屏重试成功后焦点必须进入第一张历史卡片');
assert.equal(documentTarget.activeElement, card);
assert.deepEqual(card.focusOptions, { preventScroll: false });

mode = 'retry';
documentTarget.activeElement = documentTarget.body;
assert.equal(restoreHistoryRetryFocus({
  shouldRestore: true,
  container,
  documentTarget,
  focusHeading: () => heading.focus({ preventScroll: true }),
}), 'retry', '重试再次失败时焦点必须进入新生成的重试按钮');
assert.equal(documentTarget.activeElement, retry);

const explicit = control('explicit', documentTarget);
documentTarget.activeElement = explicit;
assert.equal(restoreHistoryRetryFocus({
  shouldRestore: true,
  container,
  documentTarget,
  focusHeading: () => heading.focus({ preventScroll: true }),
}), 'preserved', '等待期间用户已移焦时不得抢回焦点');
assert.equal(documentTarget.activeElement, explicit);

const historySource = await readFile(
  new URL('../src/web/public/js/pages/history/index.js', import.meta.url),
  'utf8',
);
assert.match(
  historySource,
  /const retryWasFocused = globalThis\.document\?\.activeElement === retry;[\s\S]*?await loadFirstPage\(\);[\s\S]*?restoreHistoryRetryFocus\(\{[\s\S]*?shouldRestore: retryWasFocused/,
  '生产首屏重试必须在替换空态前捕获焦点并在请求结算后恢复',
);
assert.match(
  historySource,
  /page\.status === 'error' && page\.items\.length[\s\S]*?当前显示上次加载结果[\s\S]*?点击“刷新”重试/,
  '保留旧卡片的刷新失败必须显示明确且可操作的旧结果警示',
);
assert.match(
  historySource,
  /catch \(error\) \{[\s\S]*?page\.status = 'error';[\s\S]*?page\.errorText =[\s\S]*?renderAll\(\);/,
  '首屏或刷新失败必须重绘警示、摘要、列表与分页完整状态',
);

// 服务端历史列表合同要求 items 为数组。畸形的 200 响应不能伪装成成功空态，
// 更不能清掉用户当前仍可查看的上一轮列表和缩略图缓存。
{
  const applyListPageSource = extractFunction(historySource, 'function applyListPage(');
  const loadFirstPageSource = extractFunction(historySource, 'async function loadFirstPage(');
  const previousItem = { history_item_key: 'history-kept', digest_id: 'digest-kept' };
  const page = {
    destroyed: false,
    listSeq: 0,
    crossTabReloadTimer: null,
    autoDiscoveryTimer: null,
    listController: null,
    moreController: null,
    loadingMore: false,
    autoDiscoveryPasses: 0,
    items: [previousItem],
    status: 'ready',
    errorText: '',
    incompleteReasons: [],
  };
  let thumbClears = 0;
  let renders = 0;
  const clearThumbCache = () => { thumbClears += 1; };
  const applyListPage = new Function(
    'page',
    'clearThumbCache',
    'itemKey',
    'requireHistoryListItems',
    `${applyListPageSource}; return applyListPage;`,
  )(
    page,
    clearThumbCache,
    item => String(item?.history_item_key || ''),
    requireHistoryListItems,
  );
  const refreshBtn = { disabled: false };
  const clearAutoDiscoveryTimer = () => {};
  const loadFirstPage = new Function(
    'page',
    'clearAutoDiscoveryTimer',
    'abortCrossTabListItemRefreshes',
    'clearThumbCache',
    'refreshBtn',
    'renderAll',
    'api',
    'historyListPath',
    'applyListPage',
    'shouldQueueHistoryAutoDiscovery',
    'HISTORY_AUTO_DISCOVERY_PASS_LIMIT',
    `${loadFirstPageSource}; return loadFirstPage;`,
  )(
    page,
    clearAutoDiscoveryTimer,
    () => {},
    clearThumbCache,
    refreshBtn,
    () => { renders += 1; },
    { async get() { return { ok: true, items: null, total: 0 }; } },
    () => '/api/history?refresh=true',
    applyListPage,
    () => false,
    2,
  );

  const loaded = await loadFirstPage({ refresh: true });
  assert.equal(loaded, false, 'items 非数组的 200 响应必须按读取失败处理');
  assert.equal(page.status, 'error', '畸形响应必须进入明确可重试的错误态');
  assert.match(page.errorText, /历史列表响应|items|格式/, '错误态必须说明响应合同无效');
  assert.deepEqual(page.items, [previousItem], '刷新失败必须保留上一轮可见历史记录');
  assert.equal(thumbClears, 0, '畸形响应不得清空上一轮缩略图缓存');
  assert.equal(refreshBtn.disabled, false, '失败结算后刷新按钮必须恢复可用');
  assert.ok(renders >= 2, '畸形响应必须从 loading 重绘到 error');
}

// 首屏重试成功到 rAF 恢复焦点之间，账号/筛选可能启动新的列表代次。
// 旧 retry 回调不得把焦点写到新列表。
{
  const renderGridSource = extractFunction(historySource, 'function renderGrid()');
  const scheduled = [];
  let restoreCalls = 0;
  let retryNode = null;
  const makeNode = (tag = '', className = '', text = '') => ({
    tag,
    className,
    textContent: text,
    children: [],
    listeners: new Map(),
    append(...nodes) { this.children.push(...nodes.filter(Boolean)); },
    appendChild(node) { if (node) this.children.push(node); return node; },
    replaceChildren(...nodes) { this.children = nodes.filter(Boolean); },
    addEventListener(type, listener) { this.listeners.set(type, listener); },
  });
  const gridNode = makeNode('div', 'grid');
  const page = {
    destroyed: false,
    status: 'error',
    items: [],
    errorText: 'A 读取失败',
    listSeq: 10,
    q: '',
    filter: 'ok',
  };
  const fakeDocument = { activeElement: null };
  const renderGrid = new Function(
    'grid',
    'page',
    'el',
    'globalThis',
    'loadFirstPage',
    'restoreHistoryRetryFocus',
    'pageTitle',
    `${renderGridSource}; return renderGrid;`,
  )(
    gridNode,
    page,
    (tag, className = '', text = '') => {
      const node = makeNode(tag, className, text);
      if (tag === 'button' && text === '重试') retryNode = node;
      return node;
    },
    {
      document: fakeDocument,
      requestAnimationFrame(callback) { scheduled.push(callback); },
    },
    async () => {
      page.listSeq += 1;
      page.status = 'ready';
      page.items = [{ id: 'account-a-item' }];
      return true;
    },
    () => { restoreCalls += 1; },
    control('history-title', fakeDocument),
  );

  renderGrid();
  assert.ok(retryNode, '生产错误态必须渲染可点击重试按钮');
  fakeDocument.activeElement = retryNode;
  retryNode.listeners.get('click')();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(scheduled.length, 1, 'A 重试成功后必须先排入焦点恢复 rAF');
  page.listSeq += 1;
  page.status = 'loading';
  page.items = [];
  scheduled[0]();
  assert.equal(restoreCalls, 0,
    'A 重试的旧 rAF 在列表切到 B 代次后不得执行焦点恢复');
}

console.log('web history list failure feedback tests passed');
