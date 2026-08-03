import assert from 'node:assert/strict';
import { normalizeMessageShardCursorPosition } from '../src/lib/message-shard-cursor.js';

assert.equal(normalizeMessageShardCursorPosition(0), 0);
assert.equal(normalizeMessageShardCursorPosition(81), 81);
assert.equal(normalizeMessageShardCursorPosition('0'), 0);
assert.equal(normalizeMessageShardCursorPosition('81'), 81);

for (const invalid of ['', ' ', '01', '1e3', '0x10', '+1', '-0', 1.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
  assert.equal(normalizeMessageShardCursorPosition(invalid), null, `legacy position ${JSON.stringify(invalid)} must be rejected`);
}

const validRecord = {
  row_id: 81,
  generation: 'a'.repeat(64),
  anchor_hash: 'b'.repeat(64),
};
assert.deepEqual(normalizeMessageShardCursorPosition(validRecord), validRecord);
assert.equal(
  normalizeMessageShardCursorPosition({ ...validRecord, row_id: '81' }),
  null,
  'structured row_id must be a JSON safe integer, not a coercible string',
);

console.log('message shard cursor normalization tests passed');
