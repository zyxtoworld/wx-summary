import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const modalSource = await readFile(
  new URL('../src/web/public/js/ui/modal.js', import.meta.url),
  'utf8',
);
const historySource = await readFile(
  new URL('../src/web/public/js/pages/history/index.js', import.meta.url),
  'utf8',
);

assert.match(modalSource,
  /close\(\{ restoreFocus = true \} = \{\}\)[\s\S]*?dispose\(\{ restore: restoreFocus \}\)/,
  '统一弹层必须允许生命周期所有者关闭时禁止通用焦点恢复');
assert.match(historySource,
  /function closeAllModals\([\s\S]*?entry\.modal\.close\(\{ restoreFocus \}\)/,
  '历史页必须把关闭时的焦点策略传给所有页面弹层');
assert.match(historySource,
  /async destroy\(\) \{[\s\S]*?detail\.modal\.close\(\{ restoreFocus: false \}\)[\s\S]*?closeAllModals\(\{ restoreFocus: false \}\)/,
  '历史页卸载时不得恢复详情或其他弹层的旧页面焦点');

console.log('web history modal lifecycle tests passed');
