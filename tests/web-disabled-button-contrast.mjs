import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(
  new URL('../src/web/public/css/app.css', import.meta.url),
  'utf8',
);

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `必须存在 ${selector} 样式`);
  return match[1];
}

const disabled = rule('button:disabled');
assert.match(disabled, /opacity:\s*1;/, '禁用按钮不能把文字和背景整体淡化到低对比度');
assert.match(disabled, /color:\s*var\(--fg-muted\);/, '普通禁用按钮必须使用可读的次要文字色');

const primaryDisabled = rule('.btn-primary:disabled');
assert.match(primaryDisabled, /background:\s*var\(--accent-soft\);/);
assert.match(primaryDisabled, /color:\s*var\(--accent-text\);/);
assert.match(primaryDisabled, /border-color:\s*var\(--control-border\);/);
assert.match(primaryDisabled, /box-shadow:\s*none;/);

const dangerDisabled = rule('.btn-danger:disabled');
assert.match(dangerDisabled, /background:\s*var\(--danger-soft\);/);
assert.match(dangerDisabled, /color:\s*var\(--danger-text\);/);
assert.match(dangerDisabled, /border-color:\s*var\(--control-border\);/);

console.log('web disabled button contrast tests passed');
