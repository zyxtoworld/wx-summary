import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const appSource = await fs.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const encoderSource = appSource.slice(
  appSource.indexOf('function reserveCanvasPngEncodeSlot()'),
  appSource.indexOf('function digestCurrentPngArtifact'),
);
const artifactBlobSource = appSource.slice(
  appSource.indexOf('async function digestPngArtifactBlob('),
  appSource.indexOf('function notifyLocalProgress', appSource.indexOf('async function digestPngArtifactBlob(')),
);

assert.ok(appSource.includes('let canvasPngEncodeTail = Promise.resolve();'), 'Canvas PNG encoding must share one browser-owned serialization lane');
assert.ok(encoderSource.includes('function reserveCanvasPngEncodeSlot()'), 'Canvas PNG encoding must reserve a releasable serialization slot');
assert.ok(encoderSource.includes('signal = null'), 'Canvas PNG encoding must accept an AbortSignal');
assert.ok(encoderSource.includes("signal?.addEventListener?.('abort', onAbort, { once: true })"), 'Canvas PNG encoding must react to caller cancellation while queued or active');
assert.ok(encoderSource.includes('if (!encodingStarted) releaseSlot();'), 'a queued Canvas PNG request must release its slot when cancelled or timed out before native encoding starts');
assert.match(encoderSource, /canvas\.toBlob\(blob => \{\s+releaseSlot\(\);/, 'the native Canvas PNG slot must remain held until toBlob invokes its callback');
assert.ok(encoderSource.includes('if (callerSettled || signal?.aborted) {\n          releaseSlot();'), 'a request that became stale while waiting must never start a later native encode');
assert.ok(appSource.includes('canvasToPngBlob(canvas, { signal })'), 'automatic save and history rerender must pass their cancellation signal to Canvas encoding');
assert.ok(artifactBlobSource.includes("artifact?.kind === 'canvas'") && artifactBlobSource.includes('canvasToPngBlob(artifact.canvas, { signal })'), 'the current PNG artifact helper must forward its cancellation signal to Canvas encoding');
assert.ok((appSource.match(/digestPngArtifactBlob\(artifact, \{ signal: actionAbort\.signal \}\)/g) || []).length >= 2, 'download and clipboard actions must pass their cancellation signal through the current PNG artifact helper');

console.log('canvas PNG cancellation tests passed');
