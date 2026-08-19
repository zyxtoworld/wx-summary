import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');

assert.match(source, /groupList\.setAttribute\('role',\s*'group'\)/,
  '群选择区必须使用兼容原生复选框的 group 语义');
assert.match(source, /groupList\.setAttribute\('aria-label',\s*'可总结群列表'\)/,
  '群选择区必须有稳定的可访问名称');
assert.doesNotMatch(source, /groupList\.setAttribute\('role',\s*'listbox'\)/,
  '原生复选框列表不得伪装成要求方向键模型的 listbox');
assert.doesNotMatch(source, /groupList\.setAttribute\('aria-multiselectable'/,
  '原生复选框已表达多选，不得重复声明 listbox 多选状态');
assert.doesNotMatch(source, /row\.setAttribute\('role',\s*'option'\)/,
  '包含原生复选框的 label 不得伪装成 option');
assert.doesNotMatch(source, /row\.setAttribute\('aria-selected'/,
  '复选框 checked 是唯一选择状态，不得维护重复 aria-selected 状态');
assert.match(source, /const row = el\('label',\s*'group-row'\)/,
  '群名与复选框必须继续由原生 label 关联');
assert.match(source, /box\.type = 'checkbox'/,
  '群选择必须继续使用原生复选框键盘行为');

console.log('web digest group selection semantics tests passed');
