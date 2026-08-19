import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = name => readFile(
  new URL(`../src/web/public/js/${name}`, import.meta.url),
  'utf8',
);

const [lifecycle, digest, history, settings, setup] = await Promise.all([
  read('ui/lifecycle.js'),
  read('pages/digest/index.js'),
  read('pages/history/index.js'),
  read('pages/settings/index.js'),
  read('pages/setup/index.js'),
]);

assert.match(lifecycle, /export function createScopedUi\(baseUi, signal\)/,
  '页面 UI 作用域必须提供统一构造器');
assert.match(lifecycle, /ui\.confirmDialog\(\{ \.\.\.options, signal \}\)/,
  '页面 UI 作用域必须把生命周期信号传给确认对话框');

assert.match(digest, /createScopedUi\(baseUi, actionAbort\.signal\)/,
  '总结页确认必须绑定总结页生命周期');
assert.match(digest, /actionAbort\.abort\(new Error\('页面已卸载'\)\)/,
  '总结页销毁必须中止自己的确认对话框');

assert.match(history, /createScopedUi\(baseUi, pageAbort\.signal\)/,
  '历史页确认必须绑定历史页生命周期');
assert.match(history, /pageAbort\.abort\(new Error\('页面已卸载'\)\)/,
  '历史页销毁必须中止自己的确认对话框');

assert.match(settings, /createScopedUi\(baseUi, pageAbort\.signal\)/,
  '设置页确认必须绑定设置页生命周期');
assert.match(settings, /pageAbort\.abort\(new Error\('已离开设置页'\)\)/,
  '设置页销毁必须中止自己的确认对话框');

assert.match(setup, /createScopedUi\(baseUi, abortController\.signal\)/,
  '向导确认必须绑定向导生命周期');
assert.match(setup, /const scopedCtx = \{ \.\.\.ctx, ui \}/,
  '向导步骤必须接收带生命周期 UI 的上下文');
assert.match(setup, /ctx: scopedCtx,/,
  '向导步骤不得继续接收未绑定生命周期的原始上下文');

console.log('web page confirm lifecycle checks passed');
