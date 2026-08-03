import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const appSource = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');

function sourceBetween(start, end) {
  const startAt = appSource.indexOf(start);
  const endAt = appSource.indexOf(end, startAt + start.length);
  assert.ok(startAt >= 0 && endAt > startAt, `missing source boundary: ${start} -> ${end}`);
  return appSource.slice(startAt, endAt);
}

const visibleProgressWait = sourceBetween(
  'async function waitForVisibleDigestProgress',
  'function waitForDigestStageVisibility',
);
assert.match(visibleProgressWait, /await waitForBrowserPaint\(\)/);
assert.doesNotMatch(
  visibleProgressWait,
  /waitForDigestStageVisibility|DIGEST_CLIENT_STAGE_MIN_VISIBLE_MS|setTimeout/,
  'client progress painting must yield to the browser without delaying the business flow for presentation timing',
);

const currentState = sourceBetween(
  'function digestProgressCurrentState',
  'function digestProgressCancelledText',
);
const cancelledBatchAt = currentState.indexOf("stage.status === 'cancelled' && (key === 'batch' || name === 'batch' || stageName === 'batch')");
const errorBatchAt = currentState.indexOf("stage.status === 'error' && (key === 'batch' || name === 'batch' || stageName === 'batch')");
assert.ok(cancelledBatchAt >= 0 && cancelledBatchAt < errorBatchAt, 'an explicit cancelled batch terminal must outrank earlier per-group failures');

const cancelFailure = sourceBetween(
  'function showDigestCancelConfirmationFailure',
  'async function confirmDigestCancelRequest',
);
assert.match(
  cancelFailure,
  /_state_digest\.progress\?\.previewText\s*\?\s*'text-preview-status'\s*:\s*'preview-status'/,
  'cancel confirmation failures must be routed to the visible text or image output panel',
);

const generateDigest = sourceBetween(
  'async function generateDigest',
  'function digestPrepareConcurrency',
);
assert.match(generateDigest, /const imageConfirmedSuccessCount = previewText \? doneDigests\.length : imageHistoryBoundCount/);
assert.match(generateDigest, /doneCount: imageConfirmedSuccessCount/);
assert.match(generateDigest, /historyUnboundCount: imageHistoryUnboundCount/);
assert.match(generateDigest, /\$\{imageHistoryUnboundCount\} 个 PNG 已写入但历史索引未绑定/);

const failureTitle = sourceBetween(
  'function digestBatchFailureTitle',
  'function digestClientErrorMessage',
);
assert.match(failureTitle, /historyUnboundCount = 0/);
assert.match(failureTitle, /需处理 \$\{historyUnbound\} 个/);

console.log('digest progress flow regression test passed');
