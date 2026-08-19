import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [appCss, setupCss] = await Promise.all([
  readFile(new URL('../src/web/public/css/app.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/css/setup.css', import.meta.url), 'utf8'),
]);

function rootRule(css) {
  const match = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  assert.ok(match, '必须存在基础设计变量');
  return match[1];
}

function colorFromRule(rule, variable) {
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = rule.match(new RegExp(`${escaped}\\s*:\\s*#([0-9a-f]{6})`, 'i'));
  assert.ok(match, `${variable} 必须是可验证的六位十六进制颜色`);
  return match[1];
}

function luminance(hex) {
  const channels = hex.match(/../g).map(value => Number.parseInt(value, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((left, right) => right - left);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

const root = rootRule(appCss);
for (const variable of [
  '--accent-solid',
  '--accent-solid-hover',
  '--danger-solid',
  '--danger-solid-hover',
  '--warn-solid',
]) {
  assert.ok(
    contrast(colorFromRule(root, variable), 'ffffff') >= 4.5,
    `${variable} 上的白色文字或图标对比度必须至少 4.5:1`,
  );
}

assert.match(appCss, /\.btn-primary\s*\{[^}]*background:\s*var\(--accent-solid\)[^}]*border-color:\s*var\(--accent-solid\)[^}]*color:\s*var\(--accent-fg\)/s);
assert.match(appCss, /\.btn-primary:not\(:disabled\):hover\s*\{[^}]*background:\s*var\(--accent-solid-hover\)[^}]*border-color:\s*var\(--accent-solid-hover\)/s);
assert.match(appCss, /\.btn-danger\s*\{[^}]*background:\s*var\(--danger-solid\)[^}]*border-color:\s*var\(--danger-solid\)[^}]*color:\s*#fff/s);
assert.match(appCss, /\.btn-danger:not\(:disabled\):hover\s*\{[^}]*background:\s*var\(--danger-solid-hover\)[^}]*border-color:\s*var\(--danger-solid-hover\)/s);

for (const [selector, variable] of [
  ['stage-icon-done', 'accent-solid'],
  ['stage-icon-warn', 'warn-solid'],
  ['stage-icon-error', 'danger-solid'],
]) {
  assert.match(
    appCss,
    new RegExp(`\\.${selector}\\s*\\{[^}]*background:\\s*var\\(--${variable}\\)[^}]*border-color:\\s*var\\(--${variable}\\)[^}]*color:\\s*#fff`, 's'),
  );
}

assert.match(setupCss, /\.setup-step-item\.active \.setup-step-dot\s*\{[^}]*border-color:\s*var\(--accent-solid\)[^}]*background:\s*var\(--accent-solid\)[^}]*color:\s*var\(--accent-fg\)/s);

const accessibleBrandGradient = 'linear-gradient(135deg, var(--accent-solid), var(--accent-solid-hover))';
assert.equal(
  [appCss, setupCss].filter(css => css.includes(accessibleBrandGradient)).length,
  2,
  '壳层与向导品牌标记都必须使用可承载白色图标的渐变端点',
);

console.log('web solid control contrast tests passed');
