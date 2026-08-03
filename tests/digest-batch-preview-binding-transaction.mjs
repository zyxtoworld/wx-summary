import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await fsp.readFile(path.join(ROOT, 'src', 'web', 'public', 'js', 'app.js'), 'utf8');

const helperStart = source.indexOf('function commitDigestPreviewBinding');
const helperEnd = source.indexOf('\n}', helperStart) + 2;
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'rendered previews need one transactional binding helper');
const helperSource = source.slice(helperStart, helperEnd);
assert.match(helperSource, /_state_digest\.lastDigest = digest/);
assert.match(helperSource, /_state_digest\.lastSavedItem = savedItem/);
assert.match(helperSource, /_state_digest\.lastCanvasRenderKey = renderKey/);
assert.match(helperSource, /_state_digest\.lastSavedRenderKey = savedItem \? renderKey : ''/);

const queueStart = source.indexOf('await enqueueRender(async () => {');
const drawCall = source.indexOf('canvas = await drawDigestCanvas(digest, null, batchSnapshot.render', queueStart);
assert.ok(queueStart >= 0 && drawCall > queueStart, 'batch image path must enqueue and draw the preview');
const beforeDraw = source.slice(queueStart, drawCall);
assert.doesNotMatch(beforeDraw, /_state_digest\.lastSavedItem = null/,
  'starting the next group must retain the previous saved-file binding until the new preview has an outcome');
assert.doesNotMatch(beforeDraw, /_state_digest\.lastCanvasRenderKey = digestRenderStateKey\(batchSnapshot\.render\)/,
  'starting the next group must not relabel the previous canvas as the next render');

const saveCall = source.indexOf('const saved = await saveRenderedCanvas(digest, canvas', drawCall);
const successCommit = source.indexOf('commitDigestPreviewBinding(digest, batchSnapshot.render, saved.item)', saveCall);
assert.ok(saveCall > drawCall && successCommit > saveCall,
  'the new saved binding must commit only after the save response succeeds');

const uncertainBranch = source.indexOf('if (digestSaveStatusUncertain(e))', successCommit);
const uncertainCommit = source.indexOf('commitDigestPreviewBinding(digest, batchSnapshot.render)', uncertainBranch);
const capacityBranch = source.indexOf('if (digestAutoSaveCapacityError(e))', uncertainCommit);
const capacityCommit = source.indexOf('commitDigestPreviewBinding(digest, batchSnapshot.render)', capacityBranch);
const failureCommit = source.indexOf('commitDigestPreviewBinding(digest, batchSnapshot.render)', capacityCommit + 1);
assert.ok(uncertainBranch > successCommit && uncertainCommit > uncertainBranch,
  'an uncertain save must explicitly bind the visible preview as unsaved');
assert.ok(capacityBranch > uncertainCommit && capacityCommit > capacityBranch,
  'an over-capacity save must explicitly bind the visible preview as unsaved');
assert.ok(failureCommit > capacityCommit,
  'a failed save must explicitly bind the visible preview as unsaved');

console.log('digest batch preview binding transaction tests passed');
