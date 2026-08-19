import assert from 'node:assert/strict';
import { defaultSettings, normalizeSettings } from '../src/config/settings.js';

const invalid = defaultSettings();
invalid.render = { default_theme: 'unsupported', default_font_size: 'small' };
assert.deepEqual(normalizeSettings(invalid).render, {
  default_theme: 'auto',
  default_font_size: 'normal',
}, '服务端必须把不支持的渲染主题/字号归一化为稳定默认值');

const valid = defaultSettings();
valid.render = { default_theme: 'dark', default_font_size: 'large' };
assert.deepEqual(normalizeSettings(valid).render, {
  default_theme: 'dark',
  default_font_size: 'large',
}, '服务端必须保留支持的渲染主题/字号');

console.log('settings render options tests passed');
