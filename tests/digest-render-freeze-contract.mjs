import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const appSource = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');

const payloadStart = appSource.indexOf('function digestRenderPayload(');
const payloadEnd = appSource.indexOf('\nfunction bindGroupRefToAccountIdentity', payloadStart);
const payloadSource = appSource.slice(payloadStart, payloadEnd);
assert.ok(payloadSource.includes('const theme = effectiveDigestTheme(selection.theme)'), 'render payload must resolve auto theme once');
assert.ok(payloadSource.includes('renderer_engine: DigestView.DIGEST_RENDERER_ENGINE_BROWSER'), 'browser render payload must identify its engine');
assert.ok(payloadSource.includes('function freezeDigestRenderSelection('), 'render operations must expose a concrete frozen selection');
assert.ok(payloadSource.includes('digestRenderSelectionFromSaved(digestRenderPayload(source), source)'), 'the frozen selection must derive from the exact persisted payload');

const batchStart = appSource.indexOf('const batchDraft = currentDigestBatchSnapshot();');
const batchEnd = appSource.indexOf('const priorOutputSnapshot', batchStart);
const batchSource = appSource.slice(batchStart, batchEnd);
assert.ok(batchSource.includes('render: freezeDigestRenderSelection(batchDraft.render)'), 'a generation batch must freeze auto theme before its first asynchronous step');

const historyPreviewStart = appSource.indexOf('async function buildHistoryRerenderPreview(');
const historyPreviewEnd = appSource.indexOf('\nasync function loadHistoryImageElement', historyPreviewStart);
const historyPreviewSource = appSource.slice(historyPreviewStart, historyPreviewEnd);
assert.ok(historyPreviewSource.includes('const frozenRenderPayload = renderPayload || digestRenderPayload(selection)'), 'history preview must freeze one render payload');
assert.ok(historyPreviewSource.includes('const frozenSelection = digestRenderSelectionFromSaved(frozenRenderPayload, selection)'), 'history preview drawing must consume the frozen payload');
assert.ok(historyPreviewSource.includes('drawDigestCanvas(digest, document.createElement(\'canvas\'), frozenSelection'), 'history preview must draw with the frozen concrete theme');
assert.ok(historyPreviewSource.includes('render: frozenRenderPayload'), 'the uploaded preview metadata must reuse the exact payload used to draw');

console.log('digest render freeze contract passed');
