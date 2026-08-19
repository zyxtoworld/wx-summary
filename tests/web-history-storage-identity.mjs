import assert from 'node:assert/strict';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

const loader = createBrowserModuleLoader();
const { historyStorageKeys } = await loader.load('js/pages/history/storage.js');

assert.deepEqual(historyStorageKeys('http://wx-summary.test'), {
  view: 'wx-summary:history-view:http://wx-summary.test',
  itemUpdated: 'wx-summary:history-item-updated:http://wx-summary.test',
});
assert.equal(
  Object.values(historyStorageKeys('http://wx-summary.test')).some(key => /history-v\d/i.test(key)),
  false,
  '历史页前端身份键不得携带实现版本号',
);

console.log('web history storage identity tests passed');
