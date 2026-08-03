import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const appSource = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const cssSource = await fsp.readFile(new URL('../src/web/public/css/app.css', import.meta.url), 'utf8');

assert.match(
  appSource,
  /function floatingNoticeStackHost\(\)[\s\S]*?modalLayerStack\.at\(-1\)[\s\S]*?document\.body/,
  'floating notices must follow the active modal interaction layer',
);
assert.match(
  appSource,
  /function moveFloatingNoticeStackToActiveLayer[\s\S]*?restoreModalIsolationElement[\s\S]*?modalIsolationSnapshots\.delete\(stack\)[\s\S]*?host\.appendChild\(stack\)/,
  'moving a notice stack into a modal must remove stale inert/aria-hidden isolation first',
);
assert.match(
  appSource,
  /function registerModalLayer[\s\S]*?syncFloatingNoticeStack\(\)[\s\S]*?return \(\) => \{[\s\S]*?syncFloatingNoticeStack\(\)/,
  'opening and closing nested modals must synchronously re-home notices before a modal is removed',
);
assert.match(
  appSource,
  /function assetReloadNoticeHost\(\)[\s\S]*?modalLayerStack\.at\(-1\)[\s\S]*?\.image-modal[\s\S]*?document\.body/,
  'the persistent restart notice must use the active dialog surface instead of remaining a viewport-wide layer behind it',
);
assert.match(
  appSource,
  /function syncAssetReloadNotice\(\)[\s\S]*?restoreModalIsolationElement[\s\S]*?asset-reload-notice-inline[\s\S]*?host\.appendChild\(notice\)/,
  'the restart notice must restore stale modal isolation and become an in-flow dialog warning while a modal is active',
);
assert.match(
  appSource,
  /function registerModalLayer[\s\S]*?syncAssetReloadNotice\(\)[\s\S]*?return \(\) => \{[\s\S]*?syncAssetReloadNotice\(\)/,
  'opening and closing nested dialogs must synchronously re-home the persistent restart notice',
);
assert.match(
  appSource,
  /function showAssetReloadNotice[\s\S]*?syncAssetReloadNotice\(\)/,
  'a restart notice created while a dialog is already open must immediately join that dialog layout',
);
assert.match(
  appSource,
  /const paused = \(\) => document\.hidden[\s\S]*?visibilitychange[\s\S]*?document\.removeEventListener\('visibilitychange'/,
  'nonpersistent notices must not expire while the page is hidden',
);
assert.match(
  cssSource,
  /\.floating-notice-stack \{[\s\S]*?z-index: 120;/,
  'the active notice stack must paint above modal content in its current interaction layer',
);
assert.match(
  cssSource,
  /\.image-modal > \.asset-reload-notice-inline \{[\s\S]*?position: static;[\s\S]*?flex: 0 0 auto;[\s\S]*?box-shadow: none;/,
  'the restart notice must occupy normal dialog layout instead of covering history actions',
);

console.log('modal notice visibility tests passed');
