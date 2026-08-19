import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const cssFiles = await Promise.all([
  'app.css', 'settings.css', 'setup.css', 'history.css',
].map(name => readFile(new URL(`../src/web/public/css/${name}`, import.meta.url), 'utf8')));
const appCss = cssFiles[0];
const allCss = cssFiles.join('\n');

function themeRule(theme) {
  const match = appCss.match(new RegExp(`:root\\[data-theme-resolved="${theme}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `必须存在 ${theme} 主题变量`);
  return match[1];
}

function colorFromRule(rule, variable) {
  const match = rule.match(new RegExp(`${variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*#([0-9a-f]{6})`, 'i'));
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

for (const theme of ['light', 'dark']) {
  const rule = themeRule(theme);
  for (const textVariable of ['--accent-text', '--danger-text', '--warn-text', '--info-text']) {
    const textColor = colorFromRule(rule, textVariable);
    for (const backgroundVariable of ['--bg', '--bg-elevated', '--bg-sunken']) {
      const background = colorFromRule(rule, backgroundVariable);
      assert.ok(
        contrast(textColor, background) >= 4.5,
        `${theme} 主题 ${textVariable} 对 ${backgroundVariable} 的对比度必须至少 4.5:1`,
      );
    }
  }
}

for (const legacyTextVariable of ['accent-strong', 'danger', 'warn', 'info']) {
  assert.doesNotMatch(
    allCss,
    new RegExp(`(?<!-)color:\\s*var\\(--${legacyTextVariable}\\)`),
    `文字颜色必须使用主题专用语义变量，不能继续复用 --${legacyTextVariable} 填充色`,
  );
}

console.log('web semantic text contrast tests passed');
