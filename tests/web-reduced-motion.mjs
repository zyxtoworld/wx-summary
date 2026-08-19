import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(
  new URL('../src/web/public/css/app.css', import.meta.url),
  'utf8',
);
const reduced = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';

assert.ok(reduced, '设计系统必须响应系统“减少动态效果”偏好');
assert.match(reduced, /\*,\s*\*::before,\s*\*::after\s*\{/, '降动效合同必须覆盖页面私有动画和伪元素');
assert.match(reduced, /animation-duration:\s*0\.01ms\s*!important;/, '动画必须压缩为近零时长');
assert.match(reduced, /animation-iteration-count:\s*1\s*!important;/, '无限动画必须只运行一次');
assert.match(reduced, /animation-delay:\s*0ms\s*!important;/, '骨架等交错动画不得保留等待延迟');
assert.match(reduced, /transition-duration:\s*0\.01ms\s*!important;/, '过渡必须压缩为近零时长');
assert.match(reduced, /transition-delay:\s*0ms\s*!important;/, '过渡不得保留延迟');
assert.match(reduced, /scroll-behavior:\s*auto\s*!important;/, '程序内滚动不得强制平滑移动');

console.log('web reduced motion tests passed');
