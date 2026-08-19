import assert from 'node:assert/strict';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

globalThis.location = new URL('http://wx-summary.test/#/digest');
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });

const loader = createBrowserModuleLoader();
const selection = await loader.load('js/pages/digest/render-selection.js');
const {
  DIGEST_RENDERER_ENGINE_BROWSER,
  DIGEST_RENDERER_VERSION,
  digestRenderPayload,
  digestRenderPayloadKey,
  digestRenderSelectionFromSaved,
  freezeDigestRenderSelection,
} = selection;

const auto = freezeDigestRenderSelection(
  { theme: 'auto', fontSize: 'large', accentColor: '#07c160' },
  { resolveTheme: () => 'dark' },
);
assert.deepEqual(auto, {
  theme: 'dark',
  fontSize: 'large',
  accentColor: '#07C160',
  rendererVersion: DIGEST_RENDERER_VERSION,
  rendererEngine: DIGEST_RENDERER_ENGINE_BROWSER,
}, 'auto 主题必须在异步请求前冻结为具体主题');

const payload = digestRenderPayload(auto, { resolveTheme: () => 'light' });
assert.equal(payload.theme, 'dark', '冻结后的主题不得被后续系统主题变化覆盖');
assert.equal(payload.renderer_engine, DIGEST_RENDERER_ENGINE_BROWSER);
assert.equal(payload.renderer_version, DIGEST_RENDERER_VERSION);
assert.equal(digestRenderPayloadKey(payload), digestRenderPayloadKey({ ...payload }), '同一渲染选择必须产生稳定 key');

const restored = digestRenderSelectionFromSaved({
  theme: 'light',
  font_size: 'large',
  accent_color: '#AABBCC',
  renderer_engine: DIGEST_RENDERER_ENGINE_BROWSER,
}, { theme: 'dark', fontSize: 'normal' }, { resolveTheme: () => 'dark' });
assert.deepEqual(restored, {
  theme: 'light',
  fontSize: 'large',
  accentColor: '#AABBCC',
  rendererVersion: DIGEST_RENDERER_VERSION,
  rendererEngine: DIGEST_RENDERER_ENGINE_BROWSER,
});

console.log('web digest render freeze tests passed');
