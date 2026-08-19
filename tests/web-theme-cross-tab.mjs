import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let stored = 'auto';
let systemDark = false;
let storageWriteThrows = false;
const globalHandlers = new Map();
const mediaHandlers = new Map();
const dataset = {};

globalThis.document = { documentElement: { dataset } };
globalThis.localStorage = {
  getItem(key) {
    assert.equal(key, 'wx-summary:theme');
    return stored;
  },
  setItem(key, value) {
    assert.equal(key, 'wx-summary:theme');
    if (storageWriteThrows) throw new Error('storage unavailable');
    stored = String(value);
  },
};
globalThis.matchMedia = query => {
  assert.equal(query, '(prefers-color-scheme: dark)');
  return {
    get matches() { return systemDark; },
    addEventListener(type, listener) { mediaHandlers.set(type, listener); },
  };
};
globalThis.addEventListener = (type, listener) => globalHandlers.set(type, listener);

const theme = await import('../src/web/public/js/theme.js');
const changes = [];
const unsubscribe = theme.onThemeChange((value, resolved) => changes.push([value, resolved]));
theme.initTheme();

assert.deepEqual(dataset, { theme: 'auto', themeResolved: 'light' });
const storageHandler = globalHandlers.get('storage');
assert.equal(typeof storageHandler, 'function', '主题运行时必须监听其他同源页面的 localStorage 变化');

stored = 'dark';
storageHandler({ key: 'wx-summary:theme' });
assert.deepEqual(dataset, { theme: 'dark', themeResolved: 'dark' });
assert.deepEqual(changes, [['dark', 'dark']], '跨页主题同步必须通知壳层刷新按钮状态');

stored = 'light';
storageHandler({ key: 'unrelated-key' });
assert.deepEqual(dataset, { theme: 'dark', themeResolved: 'dark' }, '无关 storage 变化不得改主题');
assert.equal(changes.length, 1);

stored = 'auto';
systemDark = true;
storageHandler({ key: null });
assert.deepEqual(dataset, { theme: 'auto', themeResolved: 'dark' }, 'localStorage.clear 必须恢复 auto 并按系统解析');
assert.deepEqual(changes.at(-1), ['auto', 'dark']);

systemDark = false;
mediaHandlers.get('change')?.({ matches: false });
assert.deepEqual(dataset, { theme: 'auto', themeResolved: 'light' });
assert.deepEqual(changes.at(-1), ['auto', 'light'], 'auto 模式下系统配色变化必须通知订阅者');

storageWriteThrows = true;
theme.setTheme('dark');
assert.deepEqual(
  dataset,
  { theme: 'dark', themeResolved: 'dark' },
  '主题持久化失败时当前页面仍必须立即应用用户选择',
);
assert.equal(theme.getTheme(), 'dark', '主题持久化失败时壳层按钮仍必须保持临时选择');
assert.deepEqual(changes.at(-1), ['dark', 'dark']);

storageWriteThrows = false;
stored = 'light';
storageHandler({ key: 'wx-summary:theme' });
assert.deepEqual(dataset, { theme: 'light', themeResolved: 'light' });

unsubscribe();
stored = 'dark';
storageHandler({ key: 'wx-summary:theme' });
assert.equal(changes.length, 5, '取消订阅后不得继续回调');

const themeNotificationOrder = [];
const themeNotificationDiagnostics = [];
const originalConsoleError = console.error;
console.error = (...args) => themeNotificationDiagnostics.push(args);
const unsubscribeBadThemeListener = theme.onThemeChange(() => {
  themeNotificationOrder.push('bad');
  throw new Error('theme listener failed');
});
const unsubscribeLaterThemeListener = theme.onThemeChange(() => themeNotificationOrder.push('later'));
try {
  theme.setTheme('light');
} finally {
  console.error = originalConsoleError;
  unsubscribeBadThemeListener();
  unsubscribeLaterThemeListener();
}
assert.deepEqual(themeNotificationOrder, ['bad', 'later'],
  '坏主题观察者不得阻断后续观察者');
assert.equal(themeNotificationDiagnostics.length, 1,
  '坏主题观察者必须留下可观测诊断');
assert.equal(themeNotificationDiagnostics[0][0], 'theme listener failed');
assert.equal(themeNotificationDiagnostics[0][1]?.message, 'theme listener failed');

// 主诊断 sink 自身异常时，主题 fan-out 仍必须留下备用诊断并继续通知后续观察者。
{
  const order = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = () => {
    order.push('diagnostic-error');
    throw new Error('diagnostic sink failed');
  };
  console.warn = (...args) => {
    order.push('diagnostic-fallback');
    assert.equal(args[0], 'theme listener failed');
    assert.equal(args[1]?.message, 'theme listener failed');
  };
  const unsubscribeSinkBad = theme.onThemeChange(() => {
    order.push('bad');
    throw new Error('theme listener failed');
  });
  const unsubscribeSinkLater = theme.onThemeChange(() => order.push('later'));
  try {
    theme.setTheme('dark');
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
    unsubscribeSinkBad();
    unsubscribeSinkLater();
  }
  assert.deepEqual(order, [
    'bad',
    'diagnostic-error',
    'diagnostic-fallback',
    'later',
  ], '主诊断 sink 失败时主题 fan-out 必须走备用诊断并继续通知');
}

const mainSource = await readFile(new URL('../src/web/public/js/main.js', import.meta.url), 'utf8');
assert.match(
  mainSource,
  /import \{[^}]*onThemeChange[^}]*\} from '\.\/theme\.js'/,
  '应用壳必须导入主题变化订阅边界',
);
assert.match(
  mainSource,
  /function wireThemeSwitch\(\)[\s\S]*?onThemeChange\(syncThemeButtons\)/,
  '应用壳必须在主题变化时同步三个按钮的选中态',
);

delete globalThis.document;
delete globalThis.localStorage;
delete globalThis.matchMedia;
delete globalThis.addEventListener;

console.log('web theme cross-tab tests passed');
