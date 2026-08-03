import assert from 'node:assert/strict';
import { __thumbnailInternals } from '../src/renderer/thumbnail.js';
import * as serverPng from '../src/renderer/server-png.js';

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const acquireServerRenderSlot = serverPng.__serverPngInternals?.acquireServerRenderSlot;
assert.equal(typeof acquireServerRenderSlot, 'function', 'server render queue admission must remain independently testable');

const releaseServerSlot = await acquireServerRenderSlot();
const serverController = new AbortController();
const queuedServerRender = acquireServerRenderSlot({ signal: serverController.signal }).then(
  value => ({ value }),
  error => ({ error }),
);
await waitFor(() => serverPng.serverRenderWorkStatus().queued === 1, 'server render did not enter the queue');
const serverShutdown = Object.assign(new Error('server shutdown'), {
  name: 'AbortError',
  status: 503,
  code: 'server_render_shutdown',
});
serverController.abort(serverShutdown);
const queuedServerResult = await queuedServerRender;
releaseServerSlot();
assert.equal(queuedServerResult.error, serverShutdown, 'queued server render must preserve the shutdown reason');

const thumbnailGate = deferred();
let thumbnailStarted = false;
const activeThumbnail = __thumbnailInternals.withThumbnailRenderSlot(null, async () => {
  thumbnailStarted = true;
  return await thumbnailGate.promise;
});
await waitFor(() => thumbnailStarted, 'thumbnail render did not occupy the slot');

const thumbnailController = new AbortController();
const queuedThumbnail = __thumbnailInternals.withThumbnailRenderSlot(thumbnailController.signal, async () => 'unexpected').then(
  value => ({ value }),
  error => ({ error }),
);
const thumbnailShutdown = Object.assign(new Error('thumbnail shutdown'), {
  name: 'AbortError',
  status: 503,
  code: 'thumbnail_shutdown',
});
thumbnailController.abort(thumbnailShutdown);
const queuedThumbnailResult = await queuedThumbnail;
thumbnailGate.resolve('done');
assert.equal(await activeThumbnail, 'done');
assert.equal(queuedThumbnailResult.error, thumbnailShutdown, 'queued thumbnail render must preserve the shutdown reason');

console.log('renderer queued abort reason tests passed');
