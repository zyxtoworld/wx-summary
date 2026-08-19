import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../src/web/views/index.html', import.meta.url), 'utf8');
const bootstrapMatch = html.match(/<script\s+id="theme-bootstrap"[^>]*>([\s\S]*?)<\/script>/i);
assert.ok(bootstrapMatch, '页面头部必须包含首帧主题 bootstrap');

const bootstrapStart = bootstrapMatch.index;
const stylesheetStart = html.indexOf('<link rel="stylesheet" href="/css/app.css">');
assert.ok(stylesheetStart >= 0, '页面必须加载设计系统样式');
assert.ok(
  bootstrapStart < stylesheetStart,
  '首帧主题 bootstrap 必须在 app.css 前执行，避免颜色变量未定义的首帧',
);

const bootstrapSource = bootstrapMatch[1];
const theme = await import('../src/web/public/js/theme.js');
const cases = [
  { stored: null, systemDark: false, expectedTheme: 'auto', expectedResolved: 'light' },
  { stored: null, systemDark: true, expectedTheme: 'auto', expectedResolved: 'dark' },
  { stored: 'auto', systemDark: true, expectedTheme: 'auto', expectedResolved: 'dark' },
  { stored: 'light', systemDark: true, expectedTheme: 'light', expectedResolved: 'light' },
  { stored: 'dark', systemDark: false, expectedTheme: 'dark', expectedResolved: 'dark' },
  { stored: 'unsupported', systemDark: true, expectedTheme: 'auto', expectedResolved: 'dark' },
  { stored: null, systemDark: true, storageThrows: true, expectedTheme: 'auto', expectedResolved: 'dark' },
];

for (const entry of cases) {
  const dataset = {};
  const storage = {
    getItem(key) {
      assert.equal(key, 'wx-summary:theme');
      if (entry.storageThrows) throw new Error('storage unavailable');
      return entry.stored;
    },
  };
  const matchMedia = query => {
    assert.equal(query, '(prefers-color-scheme: dark)');
    return { matches: entry.systemDark };
  };

  vm.runInNewContext(bootstrapSource, {
    document: { documentElement: { dataset } },
    localStorage: storage,
    matchMedia,
    Set,
  });
  assert.deepEqual(
    { ...dataset },
    { theme: entry.expectedTheme, themeResolved: entry.expectedResolved },
    '首帧 bootstrap 必须按合同解析主题',
  );

  globalThis.localStorage = storage;
  globalThis.matchMedia = matchMedia;
  assert.equal(theme.storedTheme(), entry.expectedTheme);
  assert.equal(theme.resolvedTheme(entry.expectedTheme), entry.expectedResolved);
}

delete globalThis.localStorage;
delete globalThis.matchMedia;

console.log('web theme first paint tests passed');
