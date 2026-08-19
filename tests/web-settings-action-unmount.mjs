import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { completeSettingsAction } from '../src/web/public/js/pages/settings/action-lifecycle.js';

let staleCleanupCalls = 0;
const staleToken = { id: 'stale', cleanup() { staleCleanupCalls += 1; } };
const staleActions = new Set([staleToken]);
let staleDomWrites = 0;
let staleFocusRestores = 0;

const staleCompleted = completeSettingsAction({
  actions: staleActions,
  token: staleToken,
  destroyed: true,
  syncBusy() { staleDomWrites += 1; },
  restoreFocus() { staleFocusRestores += 1; },
});

assert.equal(staleCompleted, false, '页面销毁后的异步 finally 不得执行 UI 收尾');
assert.equal(staleActions.has(staleToken), false, '过期 action token 仍应被幂等释放');
assert.equal(staleCleanupCalls, 1, '页面销毁后的异步 finally 仍必须释放 action 级监听器');
assert.equal(staleDomWrites, 0, '卸载后不得重新同步已释放按钮');
assert.equal(staleFocusRestores, 0, '卸载后不得尝试恢复焦点');

let liveCleanupCalls = 0;
const liveToken = { id: 'live', cleanup() { liveCleanupCalls += 1; } };
const liveActions = new Set([liveToken]);
let liveDomWrites = 0;
let liveFocusRestores = 0;
const liveCompleted = completeSettingsAction({
  actions: liveActions,
  token: liveToken,
  destroyed: false,
  syncBusy() { liveDomWrites += 1; },
  restoreFocus() { liveFocusRestores += 1; },
});

assert.equal(liveCompleted, true);
assert.equal(liveActions.has(liveToken), false);
assert.equal(liveCleanupCalls, 1, '正常 action 收尾必须释放 action 级监听器');
assert.equal(liveDomWrites, 1, '已挂载页面必须恢复按钮忙态');
assert.equal(liveFocusRestores, 1, '已挂载页面必须执行安全焦点恢复');
const repeatedLiveCompleted = completeSettingsAction({
  actions: liveActions,
  token: liveToken,
  destroyed: false,
  syncBusy() { liveDomWrites += 1; },
  restoreFocus() { liveFocusRestores += 1; },
});
assert.equal(repeatedLiveCompleted, false, '同一 live token 重复收尾必须识别为已释放');
assert.equal(liveCleanupCalls, 1, '同一 live token 重复收尾不得重复 cleanup');
assert.equal(liveDomWrites, 1, '同一 live token 重复收尾不得重复同步按钮忙态');
assert.equal(liveFocusRestores, 1, '同一 live token 重复收尾不得重复恢复焦点');

const settingsSource = await readFile(
  new URL('../src/web/public/js/pages/settings/index.js', import.meta.url),
  'utf8',
);
assert.match(settingsSource,
  /import \{ completeSettingsAction \} from '\.\/action-lifecycle\.js';/,
  '设置编排层必须使用可测试的统一 action 收尾原语');
assert.match(settingsSource,
  /function endAction\(token\) \{[\s\S]*?completeSettingsAction\(\{[\s\S]*?destroyed: state\.destroyed,[\s\S]*?syncBusy,[\s\S]*?restoreFocus\(\)/,
  '生产 endAction 必须把销毁态交给统一原语，并把 DOM/焦点操作放进受保护回调');
assert.match(settingsSource,
  /controller\.abort\(pageAbort\.signal\.reason \|\| new Error\('页面已卸载'\)\)/,
  '页面已先进入 aborted 状态时，设置 action 必须沿用页面 abort reason 而不是把 Signal 对象作为 reason');
assert.doesNotMatch(settingsSource,
  /controller\.abort\(pageAbort\.signal\)/,
  '设置 action 不得把 AbortSignal 对象本身作为 abort reason');
assert.match(settingsSource,
  /async function refreshFromServer\([\s\S]*?finally \{[\s\S]*?const owned = endAction\(token\);\s*if \(owned && !state\.destroyed && trigger\?\.isConnected\)/,
  '重新载入设置的额外按钮/焦点收尾必须只由仍持有 action 的当前 owner 执行');

console.log('web settings action unmount tests passed');
