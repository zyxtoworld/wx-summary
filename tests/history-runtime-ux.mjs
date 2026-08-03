import assert from 'node:assert/strict';
import fs from 'node:fs';

const appJs = fs.readFileSync(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const appCss = fs.readFileSync(new URL('../src/web/public/css/app.css', import.meta.url), 'utf8');

const bindMdStart = appJs.indexOf('function bindHistoryCardMdAction');
const bindOpenStart = appJs.indexOf('function bindHistoryCardOpenAction');
const bindImageEnd = appJs.indexOf('function updateHistoryCardItem');
const cardBindingSource = appJs.slice(bindOpenStart, bindImageEnd);
assert.ok(bindMdStart >= 0 && bindOpenStart >= 0 && bindImageEnd > bindOpenStart);
assert.equal(cardBindingSource.includes('itemByKey = buildHistoryItemLookup(_state_history.items)'), false,
  'history card binding must not rebuild the complete item lookup for every card');
assert.equal(cardBindingSource.includes('|| itemByKey.get(lookupKey)'), false,
  'history card actions must not fall back to a stale lookup captured when the card was bound');

const thumbnailQueueSource = appJs.slice(
  appJs.indexOf('const HISTORY_THUMBNAIL_LOAD_CONCURRENCY'),
  appJs.indexOf('function historyThumbnailCanOfferOriginal'),
);
assert.ok(thumbnailQueueSource.includes('HISTORY_THUMBNAIL_LOAD_QUEUE.splice('),
  'cancelling a queued thumbnail must remove the queued closure instead of only invalidating its token');
assert.ok(thumbnailQueueSource.includes('let _historyThumbnailIntersectionObserver = null')
  && thumbnailQueueSource.includes('function historyThumbnailIntersectionObserver()'),
  'history thumbnails must share one IntersectionObserver');

const thumbnailWatchSource = appJs.slice(
  appJs.indexOf('function watchHistoryThumbnailImage'),
  appJs.indexOf('function retryUnsupportedHistoryThumbnails'),
);
assert.equal(thumbnailWatchSource.includes("img.addEventListener('load'"), false,
  'thumbnail loads must rely on the awaited decode result instead of accumulating paired DOM listeners');
assert.equal(thumbnailWatchSource.includes("img.addEventListener('error'"), false,
  'thumbnail errors must rely on the awaited decode error instead of accumulating stale listeners');
assert.ok(thumbnailWatchSource.includes('const observer = historyThumbnailIntersectionObserver()')
  && !thumbnailWatchSource.includes('const observer = new IntersectionObserver('),
  'each history card must register with the shared observer rather than allocating its own observer');

const abortImageSource = appJs.slice(
  appJs.indexOf('function abortHistoryImageLoad'),
  appJs.indexOf('function revokeHistoryObjectUrls'),
);
assert.ok(abortImageSource.includes('_historyThumbnailIntersectionObserver.unobserve(img)'),
  'removing one thumbnail must unobserve only that image without disconnecting the shared observer');

const historyLoadSource = appJs.slice(
  appJs.indexOf('async function loadHistoryPage'),
  appJs.indexOf('$more?.addEventListener', appJs.indexOf('async function loadHistoryPage')),
);
const historyAutoDiscoverySource = appJs.slice(
  appJs.indexOf('function queueHistoryAutoDiscovery'),
  appJs.indexOf('function historyPagingGate', appJs.indexOf('function queueHistoryAutoDiscovery')),
);
assert.ok(appJs.includes('const HISTORY_AUTO_DISCOVERY_PASS_LIMIT = 2')
  && historyLoadSource.includes('autoDiscovery = false')
  && historyLoadSource.includes('reset && !autoDiscovery')
  && historyLoadSource.includes('historyAutoDiscoveryPasses < HISTORY_AUTO_DISCOVERY_PASS_LIMIT')
  && historyLoadSource.includes('historyVisibleItemsForCurrentMode().length === 0')
  && historyLoadSource.includes('queueHistoryAutoDiscovery({')
  && historyAutoDiscoverySource.includes('refresh: true')
  && historyAutoDiscoverySource.includes('autoDiscovery: true')
  && historyLoadSource.includes('!background && !autoDiscoveryScheduled && !autoSearchScheduled) flushPendingHistoryBackgroundRefresh()'),
'an empty search or filter with incomplete old-directory discovery should advance a bounded number of automatic scans without racing background refreshes or removing the manual continuation path');

const deleteChangedSource = appJs.slice(
  appJs.indexOf('if (changed) {', appJs.indexOf('async function deleteHistoryCardItem')),
  appJs.indexOf('} finally {', appJs.indexOf('async function deleteHistoryCardItem')),
);
assert.ok(deleteChangedSource.includes('await refreshLoadedHistoryWindow({')
  && !deleteChangedSource.includes('void refreshLoadedHistoryWindow({'),
  'a version-conflict refresh must finish before the stale delete button is unlocked');

const zoomModalSource = appJs.slice(
  appJs.indexOf('async function showImageZoomModal'),
  appJs.indexOf('const FLOATING_NOTICE_STACK_IDS'),
);
assert.ok(zoomModalSource.includes('class="modal-body zoom-body" tabindex="0"')
  && zoomModalSource.includes('aria-label="100% 长图滚动区域"'),
  'the 100% image scroll region must be keyboard-focusable and named');
assert.ok(appCss.includes('.zoom-body:focus-visible'),
  'the keyboard-focusable 100% image scroll region must expose a visible focus state');

console.log('history runtime UX tests passed');
