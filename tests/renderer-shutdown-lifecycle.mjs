import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import {
  cancelServerRenderWork,
  renderDigestPngBuffer,
  serverRenderWorkStatus,
  waitForServerRenderWorkToSettle,
} from '../src/renderer/server-png.js';
import {
  __thumbnailInternals,
  cancelThumbnailRenderWork,
  renderDigestThumbnailPng,
  thumbnailRenderWorkStatus,
  waitForThumbnailRenderWorkToSettle,
} from '../src/renderer/thumbnail.js';

let activeThumbnailSignal = null;
const activeThumbnail = __thumbnailInternals.joinThumbnailFlight(
  `shutdown-lifecycle-${process.pid}`,
  null,
  signal => {
    activeThumbnailSignal = signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  },
).promise;
activeThumbnail.catch(() => {});
for (let attempt = 0; attempt < 100 && !activeThumbnailSignal; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 5));
}
assert.ok(activeThumbnailSignal, 'thumbnail producer did not start');

cancelServerRenderWork('test shutdown');
const cancelledThumbnail = cancelThumbnailRenderWork('test shutdown');
assert.ok(cancelledThumbnail.active >= 1, 'shutdown must observe the active thumbnail producer');
assert.equal(activeThumbnailSignal.aborted, true, 'shutdown must abort the producer-owned signal');
await assert.rejects(activeThumbnail, error => error?.code === 'thumbnail_shutdown');

await assert.rejects(
  renderDigestPngBuffer({ headline: 'late render', topics: [], todos: [], links: [] }),
  error => error?.code === 'server_render_shutdown',
  'server PNG rendering must reject new work once shutdown starts',
);
await assert.rejects(
  renderDigestThumbnailPng({ filePath: 'late-thumbnail.png' }),
  error => error?.code === 'thumbnail_shutdown',
  'thumbnail rendering must reject before touching the source path once shutdown starts',
);

assert.deepEqual(await waitForServerRenderWorkToSettle(50), {
  settled: true,
  active: 0,
  timed_out: false,
  renders: 0,
  queued: 0,
  quarantined: false,
});
assert.deepEqual(await waitForThumbnailRenderWorkToSettle(50), {
  settled: true,
  active: 0,
  timed_out: false,
  renders: 0,
  queued: 0,
  flights: 0,
  quarantined: false,
  cache_prune: false,
});
assert.equal(serverRenderWorkStatus().closing, true);
assert.equal(thumbnailRenderWorkStatus().closing, true);

const mainSource = await fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const shutdownStart = mainSource.indexOf('async function gracefulShutdown');
const shutdownEnd = mainSource.indexOf('\nasync function waitForLocalActionWorkToSettle', shutdownStart);
const gracefulShutdownSource = mainSource.slice(shutdownStart, shutdownEnd);
assert.match(gracefulShutdownSource, /cancelServerRenderWork\([\s\S]*?cancelThumbnailRenderWork\(/);
assert.match(gracefulShutdownSource, /waitForServerRenderWorkToSettle\([\s\S]*?waitForThumbnailRenderWorkToSettle\(/);
assert.match(
  gracefulShutdownSource,
  /const temporaryCleanupSafe = shutdownTemporaryCleanupSafe\(\{[\s\S]*?schedulerCleanupSafe,[\s\S]*?rendererCleanupSafe,[\s\S]*?if \(temporaryCleanupSafe\)[\s\S]*?clearTmpDirForShutdown/,
  'temporary cleanup must include both scheduler and renderer status in the complete shutdown gate',
);

console.log('renderer shutdown lifecycle tests passed');
