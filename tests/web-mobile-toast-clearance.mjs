import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

globalThis.location = new URL('http://wx-summary.test/#/setup');

const loader = createBrowserModuleLoader();
const toastModule = await loader.load('js/ui/toast.js');
assert.equal(typeof toastModule.toastViewportTop, 'function',
  'toast 模块必须导出可测试的移动端顶部避让计算');
assert.equal(toastModule.toastViewportTop({ viewportWidth: 320, sidebarBottom: 117 }), 125,
  '窄屏 toast 必须位于实际 sidebar 下方并保留 8px 间距');
assert.equal(toastModule.toastViewportTop({ viewportWidth: 320, sidebarBottom: 117, accountMenuBottom: 174 }), 182,
  '窄屏账号菜单打开时 toast 必须下移到菜单底部之后,不能遮挡账号选项');
assert.equal(toastModule.toastViewportTop({ viewportWidth: 760, sidebarBottom: 109.2 }), 118,
  '移动端边界宽度也必须向上取整避让 sidebar');
assert.equal(toastModule.toastViewportTop({ viewportWidth: 761, sidebarBottom: 117 }), 16,
  '桌面布局继续使用右上角 16px 定位');
assert.equal(toastModule.toastViewportTop({ viewportWidth: 320, sidebarBottom: 0 }), 16,
  'sidebar 尚未布局时必须安全回退');

const toastSource = await readFile(new URL('../src/web/public/js/ui/toast.js', import.meta.url), 'utf8');
assert.match(toastSource,
  /root\.style\.setProperty\('--toast-top', `\$\{toastViewportTop\([\s\S]*?\)\}px`\);/,
  '每次创建或复用 toast root 都必须同步实际移动端偏移');
assert.match(toastSource, /querySelector\?\.\('\.account-menu'\)/,
  'toast 偏移同步必须查询账号菜单');
assert.match(toastSource, /accountMenu && accountMenu\.hidden !== true/,
  '隐藏账号菜单不得改变 toast 偏移');
assert.match(toastSource, /toastViewportTop\(\{[\s\S]*?accountMenuBottom,/,
  'toast 偏移计算必须接收可见账号菜单的底部位置');

const uiIndexSource = await readFile(new URL('../src/web/public/js/ui/index.js', import.meta.url), 'utf8');
assert.match(uiIndexSource, /syncToastViewportOffset/,
  'UI 统一出口必须暴露 toast 视口偏移同步入口');
const mainSource = await readFile(new URL('../src/web/public/js/main.js', import.meta.url), 'utf8');
assert.match(mainSource, /function toggleAccountMenu[\s\S]*?syncToastViewportOffset/,
  '账号菜单打开和关闭时必须同步现有 toast 的避让位置');

const css = await readFile(new URL('../src/web/public/css/app.css', import.meta.url), 'utf8');
assert.match(css, /\.toast-root\s*\{[\s\S]*?top:\s*var\(--toast-top,\s*16px\);/,
  'toast CSS 必须消费运行时顶部偏移');
assert.match(css, /max-height:\s*calc\(100dvh - var\(--toast-top,\s*16px\) - 16px\);/,
  'toast 可滚动高度必须随顶部避让同步缩小');
const zIndexOf = selector => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{[\\s\\S]*?z-index:\\s*(\\d+);`));
  return match ? Number(match[1]) : NaN;
};
const toastZIndex = zIndexOf('.toast-root');
const modalZIndex = zIndexOf('.modal-overlay');
assert.ok(Number.isFinite(toastZIndex) && Number.isFinite(modalZIndex),
  'toast 与 modal 必须声明可比较的稳定层级');
assert.ok(modalZIndex > toastZIndex,
  '模态确认框必须位于非阻塞 toast 之上，窄屏旧通知不得遮挡标题、正文和操作按钮');
const modalOverlayRule = css.match(/\.modal-overlay\s*\{([^}]+)\}/)?.[1] || '';
const fadeInKeyframes = css.match(/@keyframes\s+fade-in\s*\{([\s\S]*?)\n\}/)?.[1] || '';
const modalInKeyframes = css.match(/@keyframes\s+modal-in\s*\{([\s\S]*?)\n\}/)?.[1] || '';
assert.doesNotMatch(modalOverlayRule, /animation\s*:/,
  '阻塞遮罩必须立即盖住既有 toast，不能让整个遮罩从透明态淡入');
assert.doesNotMatch(fadeInKeyframes, /opacity\s*:/,
  '遮罩动画不得通过父级 opacity 让 toast 穿透到确认框区域');
assert.doesNotMatch(modalInKeyframes, /opacity\s*:/,
  '确认框本体必须立即不透明，位移动画期间也不得透出底层 toast');

console.log('web mobile toast clearance tests passed');
