import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [appCss, settingsCss, historyCss] = await Promise.all([
  readFile(new URL('../src/web/public/css/app.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/css/settings.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/css/history.css', import.meta.url), 'utf8'),
]);

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
  const controlBorder = colorFromRule(rule, '--control-border');
  for (const backgroundVariable of ['--bg', '--bg-elevated', '--bg-sunken']) {
    const background = colorFromRule(rule, backgroundVariable);
    assert.ok(
      contrast(controlBorder, background) >= 3,
      `${theme} 主题可编辑控件边界对 ${backgroundVariable} 的对比度必须至少 3:1`,
    );
  }
}

assert.match(
  appCss,
  /\.input, \.select\s*\{[^}]*border:\s*1px solid var\(--control-border\);/,
  '通用输入框和下拉框必须使用专用控件边界色',
);
assert.match(
  settingsCss,
  /\.settings-key-input\s*\{[^}]*border:\s*1px solid var\(--control-border\);/,
  '手动密钥文本区必须使用专用控件边界色',
);
assert.match(
  historyCss,
  /\.history-rerender-accent input\[type="color"\]\s*\{[^}]*border:\s*1px solid var\(--control-border\);/,
  '历史重渲染颜色输入必须使用专用控件边界色',
);

console.log('web control boundary contrast tests passed');
