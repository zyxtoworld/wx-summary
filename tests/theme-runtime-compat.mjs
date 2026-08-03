import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const source = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const themeSource = source.slice(source.indexOf('// ---------- 主题 ----------'), source.indexOf('function normalizeAppHash'));

assert.ok(themeSource.includes('function appThemeMediaQuery()'), 'theme startup should isolate matchMedia capability probing');
assert.ok(themeSource.includes("typeof window.matchMedia !== 'function'"), 'missing matchMedia must fall back without aborting startup');
assert.ok(themeSource.includes("typeof media.addEventListener === 'function'"), 'modern MediaQueryList listeners should be capability-gated');
assert.ok(themeSource.includes("typeof media.addListener === 'function'"), 'legacy WebViews should use MediaQueryList.addListener when available');
assert.equal(themeSource.includes("window.matchMedia('(prefers-color-scheme: dark)').addEventListener"), false, 'theme startup must not call modern listeners unconditionally');
assert.ok(themeSource.includes('media?.matches === true'), 'effective auto theme should tolerate a missing or throwing matchMedia implementation');

console.log('theme runtime compatibility tests passed');
