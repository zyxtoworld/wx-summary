import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { historyInitialFocusCanRestore } from '../src/web/public/js/pages/history/view-state.js';

const body = { name: 'body' };
const documentElement = { name: 'html' };
const pageTitle = { name: 'title' };
const searchInput = { name: 'search' };

assert.equal(historyInitialFocusCanRestore({
  activeElement: pageTitle,
  pageTitle,
  body,
  documentElement,
}), true, '路由仍停在初始标题时，列表完成后应恢复持久化卡片焦点');
assert.equal(historyInitialFocusCanRestore({
  activeElement: body,
  pageTitle,
  body,
  documentElement,
}), true, '焦点尚未进入页面控件时允许恢复持久化焦点');
assert.equal(historyInitialFocusCanRestore({
  activeElement: searchInput,
  pageTitle,
  body,
  documentElement,
}), false, '列表等待期间用户已操作搜索框时不得抢走焦点');

const source = await readFile(
  new URL('../src/web/public/js/pages/history/index.js', import.meta.url),
  'utf8',
);
const initStart = source.indexOf('async init()');
const initEnd = source.indexOf('\n    async destroy()', initStart);
assert.ok(initStart >= 0 && initEnd > initStart, '必须能定位历史页初始化流程');
const initSource = source.slice(initStart, initEnd);
assert.doesNotMatch(
  initSource,
  /await loadFirstPage\(\)/,
  '初始历史扫描不得阻塞页面 mount 和后续路由导航',
);
assert.match(
  initSource,
  /startInitialHistoryLoad\(\)/,
  '历史页初始化必须显式启动可卸载的后台列表任务',
);
assert.match(
  source,
  /function startInitialHistoryLoad\(\)[\s\S]*?loadFirstPage\(\)\.then\([\s\S]*?historyInitialFocusCanRestore\([\s\S]*?restorePersistedFocus\(\)/,
  '后台初始列表完成后只能在页面仍有效且用户未移焦时恢复持久化焦点',
);

console.log('web history initial load routing tests passed');
