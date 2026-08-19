import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/web/public/js/pages/settings/scheduler.js', import.meta.url), 'utf8');
assert.match(source,
  /import \{ syncFormControlsDisabled \} from '\/js\/shared\/form-busy-controls\.js';/,
  '群与调度分区必须使用 shared 表单忙态同步器');
assert.match(source,
  /syncFormControlsDisabled\(\[[\s\S]*?groupSearch,[\s\S]*?enabledToggle,[\s\S]*?\.\.\.intervalControl\.inputs,[\s\S]*?\.\.\.windowControl\.inputs,[\s\S]*?minMessagesInput,[\s\S]*?rulePickerSelect,[\s\S]*?addRuleBtn,[\s\S]*?\.\.\.whitelistChips\.querySelectorAll\('button'\),[\s\S]*?\.\.\.pickerList\.querySelectorAll\('input'\),[\s\S]*?\.\.\.ruleList\.querySelectorAll\('input, button'\),[\s\S]*?\],\s*busy\);/,
  '生产 setBusy 必须同时锁定调度静态字段、白名单选择器和动态规则控件');
assert.match(source, /syncFormControlsDisabled\(\[removeBtn\], page\.isBusy\(\)\);/,
  'busy 中重绘白名单时新移除按钮必须保持锁定');
assert.match(source, /syncFormControlsDisabled\(\[checkbox\], page\.isBusy\(\)\);/,
  'busy 中重绘群选择器时新复选框必须保持锁定');
assert.match(source, /syncFormControlsDisabled\(\[keywordsInput, minInput, removeBtn\], page\.isBusy\(\)\);/,
  'busy 中重绘每群规则时新输入与移除按钮必须保持锁定');

console.log('web settings scheduler busy controls tests passed');
