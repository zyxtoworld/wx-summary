import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/web/public/js/pages/setup/step-finish.js', import.meta.url),
  'utf8',
);

assert.match(source,
  /import \{ captureActionFocus, restoreActionFocus \} from '\/js\/shared\/action-focus\.js';/,
  '完成步骤必须复用共享动作焦点原语');
assert.match(source,
  /async function loadGroups\(\{ focusCandidates = \[\] \} = \{\}\)[\s\S]*const focusTarget = captureActionFocus\(focusCandidates, globalThis\.document\?\.activeElement\)/,
  '群列表加载必须只捕获显式传入且实际聚焦的触发按钮');
assert.match(source,
  /finally \{[\s\S]*syncReloadGroupsButton\(\);[\s\S]*restoreActionFocus\(focusTarget,[\s\S]*activeElement: globalThis\.document\?\.activeElement,[\s\S]*body: globalThis\.document\?\.body/,
  '群列表当前请求完成后必须按完成动作 busy 状态同步按钮，再安全恢复焦点');
assert.match(source,
  /finally \{[\s\S]*if \(!w\.destroyed && token === groupGeneration && w\.alive\(ownerToken\)\) \{\s*restoreActionFocus\(focusTarget,/,
  '向导销毁或步骤离开后不得把焦点恢复到完成步骤旧按钮');
assert.match(source,
  /reloadGroupsBtn\.addEventListener\('click', \(\) => \{ void loadGroups\(\{ focusCandidates: \[reloadGroupsBtn\] \}\); \}\)/,
  '只有用户显式重载才把按钮注册为焦点目标');
assert.match(source, /if \(!wiz\.groups\) void loadGroups\(\);/,
  '首次后台自动加载不得伪造焦点目标或阻塞完成');

console.log('web setup finish focus tests passed');
