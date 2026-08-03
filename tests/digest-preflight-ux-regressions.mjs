import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const source = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');

function between(start, end) {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.ok(startAt >= 0 && endAt > startAt, `missing source boundary: ${start} -> ${end}`);
  return source.slice(startAt, endAt);
}

assert.equal(source.includes('DIGEST_DYNAMIC_RANGE_STALE_MS'), false);
assert.equal(source.includes('digestDynamicRangeExpired'), false);
assert.equal(source.includes('scheduleDigestDynamicRangeStaleTimer'), false);
assert.doesNotMatch(
  between('function digestResultStaleKind', 'function digestStaleResultMessage'),
  /time_range/,
  'a completed point-in-time result must remain exportable when its moving range advances',
);

const backgroundRefresh = between(
  'if (cacheHasGroups && !cacheIsFresh)',
  "document.getElementById('select-whitelist').addEventListener",
);
assert.match(backgroundRefresh, /_state_digest\.generating \|\| _state_digest\.preflightConfirmationPending/);

const generate = between('async function generateDigest', 'function digestPrepareConcurrency');
assert.match(generate, /const confirmationSelectionKey = digestSelectedGroupSetKey\(\)/);
assert.match(generate, /if \(confirmationSelectionKey !== digestSelectedGroupSetKey\(\)\)/);
assert.match(generate, /群选择在确认期间发生变化/);
assert.ok(generate.indexOf('digestRangePreflightError(requestedRangeSnapshot.range)') < generate.indexOf('confirmDigestHighMinMessages'));

const buttonSync = between('function syncDigestGenerateButtons', 'function showDigestAccountRequiredMessage');
assert.match(buttonSync, /const tooManyGroups = _state_digest\.selectedGroups\.size > DIGEST_BATCH_MAX_GROUPS/);
assert.match(buttonSync, /一次最多选择 \$\{DIGEST_BATCH_MAX_GROUPS\} 个群/);

const groupPaint = between('function paint(filter = \'\')', 'function updateSelectedCount');
assert.match(groupPaint, /_state_digest\.selectedGroups\.size >= DIGEST_BATCH_MAX_GROUPS/);
assert.match(groupPaint, /最多只能选择 \$\{DIGEST_BATCH_MAX_GROUPS\} 个群/);

const whitelistSelection = between(
  "document.getElementById('select-whitelist').addEventListener",
  "document.getElementById('clear-selected-groups')",
);
assert.match(whitelistSelection, /slice\(0, remaining\)/);
assert.match(whitelistSelection, /白名单匹配 .* 个群，本次只补选到上限/);

const rangeValidation = between('function digestRangePreflightError', 'function activeDigestRangeForSummary');
assert.match(rangeValidation, /digest_range_starts_in_future/);
assert.match(rangeValidation, /digest_range_reversed/);

console.log('digest preflight UX regression test passed');
