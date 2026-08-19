import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createModalStack } from '../src/web/public/js/ui/modal-stack.js';

const stack = createModalStack();
const bottomStates = [];
const topStates = [];
const bottom = { id: 'bottom', setTopmost: value => bottomStates.push(value) };
const top = { id: 'top', setTopmost: value => topStates.push(value) };

assert.equal(stack.push(bottom), true);
assert.equal(stack.isTop(bottom), true);
assert.deepEqual(bottomStates, [true], '首个弹层必须成为可交互栈顶');
assert.equal(stack.push(top), true);
assert.equal(stack.isTop(bottom), false);
assert.equal(stack.isTop(top), true);
assert.deepEqual(bottomStates, [true, false], '新弹层打开后底层必须进入 covered 状态');
assert.deepEqual(topStates, [true], '新弹层必须成为唯一栈顶');
assert.equal(stack.size(), 2);

assert.equal(stack.remove(bottom), true, '程序化关闭底层必须只移除自己的栈项');
assert.equal(stack.isTop(top), true, '移除底层后顶层身份必须保持');
assert.equal(stack.size(), 1);
assert.equal(stack.remove(bottom), false, '重复关闭必须幂等');
assert.equal(stack.remove(top), true);
assert.equal(stack.size(), 0);
assert.equal(stack.isTop(top), false);

const restoreStack = createModalStack();
const restoredBottomStates = [];
const restoredTopStates = [];
const restoredBottom = { setTopmost: value => restoredBottomStates.push(value) };
const restoredTop = { setTopmost: value => restoredTopStates.push(value) };
restoreStack.push(restoredBottom);
restoreStack.push(restoredTop);
assert.equal(restoreStack.remove(restoredTop), true);
assert.deepEqual(restoredBottomStates, [true, false, true],
  '关闭栈顶后底层必须恢复为可交互模态层');
assert.deepEqual(restoredTopStates, [true]);

const source = await readFile(new URL('../src/web/public/js/ui/modal.js', import.meta.url), 'utf8');
assert.match(source, /const modalStack = createModalStack\(\)/,
  '生产 modal 必须使用共享栈');
assert.match(source, /modalStack\.push\(api\)/,
  '弹层挂载后必须登记栈身份');
assert.match(source, /modalStack\.remove\(api\)/,
  '关闭时必须只移除自己的栈身份');
assert.match(source, /setTopmost\(topmost\)[\s\S]*dialog\.setAttribute\('aria-modal',[\s\S]*dialog\.setAttribute\('aria-hidden',[\s\S]*overlay\.inert/,
  '生产 modal 必须把栈 top/covered 状态同步到可访问性与交互边界');
assert.match(source, /event\.key === 'Escape'[\s\S]*modalStack\.isTop\(api\)/,
  'Escape 只能由栈顶弹层消费');

const css = await readFile(new URL('../src/web/public/css/app.css', import.meta.url), 'utf8');
assert.match(css, /\.modal-overlay\.modal-covered\s+\.modal-body\s*\{[^}]*overflow:\s*hidden;/,
  '被覆盖的底层弹层必须隐藏自己的滚动轨，避免嵌套弹层出现多重滚动条');

console.log('web modal stack tests passed');
