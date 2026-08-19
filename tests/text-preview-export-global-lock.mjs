import assert from 'node:assert/strict';
import { createTextPreviewActionState } from '../src/web/public/js/pages/digest/text-preview-action-state.js';

const state = createTextPreviewActionState();
const exportAction = state.begin('export');
assert.ok(exportAction, 'a preview export must acquire the shared action lease');
assert.equal(state.isBusy(), true);
assert.equal(state.begin('copy'), null, 'copying must be blocked while the submitted export is pending');
assert.equal(state.isCurrent(exportAction), true);
assert.equal(state.signal(exportAction), exportAction.controller.signal);

assert.equal(state.invalidate('预览已更新'), true);
assert.equal(exportAction.controller.signal.aborted, true, 'replacing the preview must abort the old export');
assert.equal(state.isBusy(), false, 'invalidating a preview must release the global lock');
assert.equal(state.end(exportAction), false, 'an obsolete action cannot release a newer lease');

const copyAction = state.begin('copy');
assert.ok(copyAction);
assert.equal(state.end(exportAction), false);
assert.equal(state.end(copyAction), true);
assert.equal(state.isBusy(), false);

const downloadAction = state.begin('download');
assert.ok(downloadAction);
assert.equal(state.end(downloadAction), true);

console.log('text preview export global lock tests passed');
