import assert from 'node:assert/strict';
import { rangeSummaryText } from '../src/web/public/js/pages/digest/ranges.js';
import { parseLocalDateTime } from '../src/web/public/js/shared/local-date-time.js';
import { validateMessageTimeRange } from '../src/collector/index.js';
import { __wxdbInternals } from '../src/wxdb/index.js';

const startText = '2026-07-29 00:00:00';
const endText = '2026-07-29 23:59:59';

assert.equal(
  rangeSummaryText('custom', { customSince: '2026-07-29 00:00', customUntil: '' }),
  '自定义:2026-07-29 00:00 ~ 现在',
  '自定义结束时间留空时,范围摘要必须显示现在',
);

const defaultEnd = parseLocalDateTime(endText);
assert.equal(defaultEnd?.getMilliseconds(), 0, 'default local date parsing must retain an exact second');

const minuteEnd = parseLocalDateTime('2026-07-29 23:59', {
  endOfMinuteWhenSecondsMissing: true,
  endOfSecond: true,
});
assert.equal(minuteEnd?.getSeconds(), 59, 'minute-only end values must resolve to their final second');
assert.equal(minuteEnd?.getMilliseconds(), 999, 'minute-only end values must include the final millisecond');
assert.equal(parseLocalDateTime('2026-02-31 00:00:00'), null, 'local date parsing must reject rolled-over calendar dates');

const range = validateMessageTimeRange(startText, endText);
assert.equal(range.end.getMilliseconds(), 999, 'textual digest ranges must include the final millisecond of an explicit end second');

const bounds = __wxdbInternals.messageTimeBounds(
  Math.floor(range.start.getTime() / 1000),
  Math.floor(range.end.getTime() / 1000),
  { since_ms: range.start.getTime(), until_ms: range.end.getTime() },
);
const packedLastMillisecond = (BigInt(range.end.getTime()) * 1_048_576n + 42n).toString();
const matchingRows = __wxdbInternals.mergeMessageRowsByTimeSources(
  [{ local_id: 1, server_id: 'create-last-millisecond', create_time: range.end.getTime(), sort_seq: 0 }],
  [{ local_id: 2, server_id: 'sort-last-millisecond', create_time: 0, sort_seq: packedLastMillisecond, __sort_seq_packed: true }],
  bounds,
);
assert.deepEqual(
  matchingRows.rows.map(row => row.server_id),
  ['create-last-millisecond', 'sort-last-millisecond'],
  'create_time and packed sort_seq messages in the final millisecond must stay in the requested range',
);

const afterEndRows = __wxdbInternals.mergeMessageRowsByTimeSources(
  [{ local_id: 3, server_id: 'create-after-end', create_time: range.end.getTime() + 1, sort_seq: 0 }],
  [{
    local_id: 4,
    server_id: 'sort-after-end',
    create_time: 0,
    sort_seq: (BigInt(range.end.getTime() + 1) * 1_048_576n + 42n).toString(),
    __sort_seq_packed: true,
  }],
  bounds,
);
assert.equal(afterEndRows.rows.length, 0, 'the inclusive end rule must not include the next millisecond');

const explicitEndMs = range.end.getTime() - 500;
const explicitRange = validateMessageTimeRange(startText, endText, {
  since_ms: range.start.getTime(),
  until_ms: explicitEndMs,
});
assert.equal(explicitRange.end.getTime(), explicitEndMs, 'explicit epoch-millisecond bounds must remain exact');

console.log('DIGEST TIME RANGE BOUNDARY TEST PASSED');
