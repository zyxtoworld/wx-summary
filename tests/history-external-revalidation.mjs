import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const [appSource, mainSource] = await Promise.all([
  fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8'),
  fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
]);
const sideEffectGuardStart = mainSource.indexOf('function sideEffectGetRequiresFreshFrontendAsset(');
const sideEffectGuardEnd = mainSource.indexOf('\n}', sideEffectGuardStart);
const sideEffectGuardSource = mainSource.slice(sideEffectGuardStart, sideEffectGuardEnd + 2);

assert.ok(
  mainSource.includes("pathname.startsWith('/api/history-item-status/')")
    && sideEffectGuardSource.includes("pathname.startsWith('/api/history-item-status/')")
    && mainSource.includes('findHistoryItemWithStatus(settings, lookup.digest_id, lookup')
    && mainSource.includes('{ ok: true, item: publicOutputItem(item) }'),
  'the server must expose a lightweight exact history-artifact status endpoint',
);
assert.ok(
  appSource.includes('function historyItemStatusApiPath(')
    && appSource.includes('function bindHistoryArtifactRevalidationOnReturn(')
    && appSource.includes("window.addEventListener('focus', onFocus)")
    && appSource.includes("document.addEventListener('visibilitychange', onVisibilityChange)"),
  'history modals must share a coalesced focus/visibility revalidation helper',
);

const historyStart = appSource.indexOf('async function renderHistory()');
const historyEnd = appSource.indexOf('\nfunction historyItemStableKey(', historyStart);
assert.ok(historyStart >= 0 && historyEnd > historyStart, 'history route source must be bounded');
const historySource = appSource.slice(historyStart, historyEnd);
assert.ok(
  historySource.includes("window.addEventListener('focus', onHistoryWindowFocus)")
    && historySource.includes("document.addEventListener('visibilitychange', onHistoryVisibilityChange)")
    && historySource.includes("window.removeEventListener('focus', onHistoryWindowFocus)")
    && historySource.includes("document.removeEventListener('visibilitychange', onHistoryVisibilityChange)")
    && historySource.includes('refreshLoadedHistoryWindow({')
    && historySource.includes('refresh: true')
    && historySource.includes('background: true'),
  'returning from Explorer must refresh the loaded history window while preserving route state',
);

const markdownModalStart = appSource.indexOf('function showHistoryMarkdownModal(');
const imageModalStart = appSource.indexOf('function showHistoryModal(', markdownModalStart);
const imageModalEnd = appSource.indexOf('\nfunction historyImagePath(', imageModalStart);
const markdownModalSource = appSource.slice(markdownModalStart, imageModalStart);
const imageModalSource = appSource.slice(imageModalStart, imageModalEnd);
assert.ok(
  markdownModalSource.includes('bindHistoryArtifactRevalidationOnReturn({')
    && markdownModalSource.includes('removeHistoryExternalRevalidationListeners()'),
  'Markdown history modal must revalidate and clean up its external-state listeners',
);
assert.ok(
  imageModalSource.includes('bindHistoryArtifactRevalidationOnReturn({')
    && imageModalSource.includes('removeHistoryExternalRevalidationListeners()'),
  'PNG history modal must revalidate and clean up its external-state listeners',
);

console.log('history external revalidation contract passed');
