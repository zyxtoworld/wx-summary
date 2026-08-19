import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/web/public/js/pages/history/index.js', import.meta.url), 'utf8');
assert.match(source,
  /import \{ captureActionFocus, restoreActionFocus \} from '\/js\/shared\/action-focus\.js';/,
  '重渲染异步按钮必须复用共享焦点恢复能力');

const rerenderStart = source.indexOf('function openRerenderModal(item)');
const rerenderEnd = source.indexOf('\n  // -------------------------------------------------------------------------', rerenderStart + 20);
assert.ok(rerenderStart >= 0 && rerenderEnd > rerenderStart, '必须能定位重渲染弹层实现');
const rerender = source.slice(rerenderStart, rerenderEnd);

assert.match(rerender,
  /async function generatePreview\(\) \{[\s\S]*?const focusTarget = captureActionFocus\(\[previewBtn\], globalThis\.document\?\.activeElement\);[\s\S]*?setBusy\(true\);/,
  '生成预览必须在禁用触发按钮前捕获焦点');
assert.match(rerender,
  /async function generatePreview\(\)[\s\S]*?finally \{[\s\S]*?setBusy\(false\);[\s\S]*?restoreActionFocus\(focusTarget, \{[\s\S]*?activeElement: globalThis\.document\?\.activeElement,[\s\S]*?body: globalThis\.document\?\.body,/,
  '生成预览完成或失败后必须安全恢复触发按钮焦点');

assert.match(rerender,
  /async function commitSave\(\) \{[\s\S]*?const focusTarget = captureActionFocus\(\[saveBtn\], globalThis\.document\?\.activeElement\);[\s\S]*?setBusy\(true\);/,
  '保存重渲染结果必须在禁用按钮前捕获焦点');
assert.match(rerender,
  /async function commitSave\(\)[\s\S]*?finally \{[\s\S]*?page\.pendingRerender -= 1;[\s\S]*?modal\.el\?\.isConnected[\s\S]*?setBusy\(false\);[\s\S]*?restoreActionFocus\(focusTarget,/,
  '保存未关闭弹层时必须恢复焦点，成功关闭时不得抢过详情层焦点');

console.log('web history rerender action focus tests passed');
