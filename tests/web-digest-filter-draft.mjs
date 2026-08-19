import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/web/public/js/pages/digest/index.js', import.meta.url),
  'utf8',
);

assert.match(
  source,
  /function createChipInput\(placeholder, onChange, onPendingChange\)/,
  '筛选 chip 必须把待提交文本变化交给页面草稿状态',
);
assert.match(
  source,
  /input\.addEventListener\('input',[\s\S]*?onPendingChange\?\.\([\s\S]*?scheduleDraftSave\(\)/,
  '输入但尚未按回车的筛选词必须立即调度账号 scope 草稿保存',
);
assert.match(
  source,
  /function currentDraftSnapshot\(\)[\s\S]*?pending_senders:\s*page\.filters\.pending_senders[\s\S]*?pending_keywords:\s*page\.filters\.pending_keywords/,
  '草稿快照必须包含两个待提交筛选输入',
);
assert.match(
  source,
  /function applyDraftState\(draft = \{\}\)[\s\S]*?pending_senders:\s*draft\.filters\.pending_senders[\s\S]*?pending_keywords:\s*draft\.filters\.pending_keywords/,
  '恢复账号草稿时必须恢复该账号自己的待提交筛选输入',
);
assert.match(
  source,
  /senderChips\.pendingValue = page\.filters\.pending_senders[\s\S]*?keywordChips\.pendingValue = page\.filters\.pending_keywords/,
  '页面控件同步必须把待提交筛选词投影回输入框',
);
assert.match(
  source,
  /const restoreFocus = document\.activeElement === x;[\s\S]*?apiChips\.render\(\);[\s\S]*?if \(restoreFocus\) input\.focus\(\{ preventScroll: true \}\)/,
  '键盘移除 chip 后必须把焦点恢复到对应输入框',
);

console.log('web digest filter draft tests passed');
