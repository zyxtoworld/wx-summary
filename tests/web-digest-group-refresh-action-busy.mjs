import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/web/public/js/pages/digest/index.js', import.meta.url),
  'utf8',
);

assert.match(
  source,
  /function syncRefreshButton\(\)[\s\S]*?page\.groupsStatus === 'loading'/,
  '群列表请求进行中必须把刷新按钮纳入 busy 状态,避免重复发起请求',
);
assert.match(
  source,
  /function syncInputControls\(\)[\s\S]*?syncRefreshButton\(\)/,
  '摘要输入状态同步必须覆盖群列表刷新按钮',
);
assert.match(
  source,
  /function syncSelectionUi\(\)[\s\S]*?syncRefreshButton\(\)/,
  '群选择状态结算必须在请求完成后恢复群列表刷新按钮',
);

console.log('web digest group refresh action busy tests passed');
