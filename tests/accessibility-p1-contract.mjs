import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../src/web/public/css/app.css', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../src/web/views/index.html', import.meta.url), 'utf8');

function blockAfter(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing CSS block: ${marker}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  throw new Error(`unterminated CSS block: ${marker}`);
}

function token(block, name) {
  const match = block.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  assert.ok(match, `missing --${name}`);
  return match[1];
}

function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map(part => Number.parseInt(part, 16) / 255);
  const linear = channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(first, second) {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

for (const block of [blockAfter(css, ':root'), blockAfter(css, '[data-theme="dark"]')]) {
  assert.ok(contrast(token(block, 'primary'), token(block, 'on-primary')) >= 4.5, 'primary button text contrast must meet WCAG AA');
  assert.ok(contrast(token(block, 'primary-hover'), token(block, 'on-primary')) >= 4.5, 'hovered primary button text contrast must meet WCAG AA');
  assert.ok(contrast(token(block, 'danger'), token(block, 'on-danger')) >= 4.5, 'danger button text contrast must meet WCAG AA');
  assert.ok(contrast(token(block, 'danger-hover'), token(block, 'on-danger')) >= 4.5, 'hovered danger button text contrast must meet WCAG AA');
  assert.ok(contrast(token(block, 'focus'), token(block, 'bg')) >= 3, 'focus indicator must contrast with the page background');
  assert.ok(contrast(token(block, 'focus'), token(block, 'card')) >= 3, 'focus indicator must contrast with card surfaces');
}

assert.doesNotMatch(css, /color:\s*(?:white|#fff(?:fff)?)(?:\s*;|\s*})/i, 'role-colored controls must use on-color tokens');
assert.doesNotMatch(css, /outline:[^;]*(?:var\(--primary\)|var\(--accent\))/, 'focus indicators must use the dedicated focus token');
assert.match(css, /outline:\s*2px solid var\(--focus\)/);

const focusRouteSource = app.slice(app.indexOf('function focusRouteHeading'), app.indexOf('const modalPageScrollLocks'));
assert.match(focusRouteSource, /querySelector\('#digest-page-title'\)/, 'digest route focus must land on its heading before sidebar controls');
assert.doesNotMatch(focusRouteSource, /\.page-digest \.main-pane/);
assert.match(html, /id="wechat-notice" role="status" aria-live="polite"/, 'persistent WeChat diagnostics should not compete as a second assertive alert');

const assetNoticeSource = app.slice(app.indexOf('function showAssetReloadNotice'), app.indexOf('function hideAssetReloadNotice'));
assert.doesNotMatch(assetNoticeSource, /\.innerHTML\s*=/, 'asset polling must update the existing notice instead of replacing its focused button');
assert.match(app, /let _assetReloadNoticeState = null;/);
assert.match(assetNoticeSource, /_assetReloadNoticeState/);
assert.match(app, /announce:\s*!digestReloadFailureAnnouncementOwnedByAssetNotice/);

console.log('accessibility P1 contract tests passed');
