import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const appSource = await fs.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const exportStateSource = appSource.slice(
  appSource.indexOf('function bumpTextPreviewExportVersion('),
  appSource.indexOf('function clearTextPreviewServerSnapshotUnavailable('),
);

const state = {
  textExportVersion: 8,
  textExportInFlight: true,
  lastTextExportItem: { relative_path: 'old.md' },
};
const button = {
  dataset: { busy: '1' },
  disabled: true,
};
let aborted = 0;
let exportSyncs = 0;
let selectionLockSyncs = 0;

const { invalidateTextPreviewExportTarget } = new Function(
  '_state_digest',
  'document',
  'abortTextPreviewActions',
  'compactErrorSummary',
  'updateDigestSelectionLock',
  'syncTextPreviewDownloadButton',
  'syncTextPreviewRevealButton',
  'syncTextPreviewExportButton',
  `${exportStateSource}\nreturn { invalidateTextPreviewExportTarget };`,
)(
  state,
  { getElementById: id => (id === 'btn-export-md' ? button : null) },
  () => { aborted += 1; },
  value => String(value || ''),
  () => { selectionLockSyncs += 1; },
  () => {},
  () => {},
  () => { exportSyncs += 1; },
);

invalidateTextPreviewExportTarget();

assert.equal(aborted, 1, 'invalidating the export target should abort the current export request');
assert.equal(state.textExportInFlight, false, 'invalidating the export target should release the JS in-flight state');
assert.equal(button.dataset.busy, undefined, 'invalidating the export target must release the matching DOM busy state');
assert.equal(selectionLockSyncs, 1, 'invalidating the export target should release the digest input lock after clearing the in-flight state');
assert.equal(exportSyncs, 1, 'invalidating the export target should resync the export button after releasing busy state');

console.log('text preview export invalidation runtime tests passed');
