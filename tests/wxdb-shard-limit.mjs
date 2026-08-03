import assert from 'node:assert/strict';
import { __wxdbInternals } from '../src/wxdb/index.js';

const {
  assertMessageShardCountSupported,
  messageShardCursorState,
  normalizeMessageShardRowPositions,
} = __wxdbInternals;

const shard = index => ({
  category: 'message',
  name: `message_${index}.db`,
  birthtimeMs: 1000 + index,
  dev: 12,
  ino: 1000 + index,
  sha256: String(index % 10).repeat(64),
  sidecars: [],
});
const supported = Array.from({ length: 256 }, (_, index) => shard(index));

assert.doesNotThrow(() => assertMessageShardCountSupported(supported));
const supportedGenerationPositions = Object.fromEntries(supported.map((file, index) => [
  messageShardCursorState(file, {}).key,
  index,
]));
assert.equal(Object.keys(supportedGenerationPositions).length, 256, '256 generation-bound cursor keys must remain unique');
assert.equal(
  Object.keys(normalizeMessageShardRowPositions(supportedGenerationPositions)).length,
  256,
  'cursor normalization must retain every supported generation-bound shard position',
);
assert.throws(
  () => assertMessageShardCountSupported([...supported, shard(256)]),
  error => error?.code === 'wxdb_message_shard_limit_exceeded'
    && error?.wxdb_diagnostics?.message_shard_count === 257,
  '257 message shards must fail closed before any cursor can be silently truncated',
);

const oversizedPositions = Object.fromEntries(
  Array.from({ length: 257 }, (_, index) => [`message_${index}.db`, index]),
);
assert.throws(
  () => normalizeMessageShardRowPositions(oversizedPositions),
  error => error?.code === 'wxdb_message_shard_limit_exceeded',
  'an oversized persisted cursor map must be rejected instead of slicing away its final entries',
);

assert.throws(
  () => normalizeMessageShardRowPositions({
    'message_1.db': 100,
    'MESSAGE_1.DB': 1000,
  }),
  error => error?.code === 'wxdb_message_shard_position_invalid',
  'wxdb normalization must reject case-folded shard-key collisions instead of retaining the larger watermark',
);
assert.throws(
  () => normalizeMessageShardRowPositions({ 'message_1.db': '1e3' }),
  error => error?.code === 'wxdb_message_shard_position_invalid',
  'wxdb normalization must reject non-canonical numeric syntax instead of coercing it',
);

console.log('wxdb message shard limit tests passed');
