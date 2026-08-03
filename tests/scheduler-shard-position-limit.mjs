import assert from 'node:assert/strict';

const acceptanceDataDir = `outputs/.tmp/scheduler-shard-position-limit-${process.pid}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = acceptanceDataDir;
process.env.WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR = `${acceptanceDataDir}/runtime-tmp/wxdb`;

const { __schedulerInternals } = await import('../src/daemon/scheduler.js');
const { normalizeSchedulerShardRowPositions } = __schedulerInternals;

const anchored = {
  'message_7.db': {
    row_id: 81,
    generation: 'a'.repeat(64),
    anchor_hash: 'b'.repeat(64),
  },
  'message_8.db': 12,
};
assert.deepEqual(
  normalizeSchedulerShardRowPositions(anchored),
  anchored,
  'scheduler normalization must preserve anchored records and legacy numeric positions during migration',
);
assert.throws(
  () => normalizeSchedulerShardRowPositions({
    'message_1.db': 100,
    'MESSAGE_1.DB': 1000,
  }),
  error => error?.code === 'wxdb_message_shard_position_invalid',
  'scheduler normalization must reject case-folded shard-key collisions',
);

const supported = Object.fromEntries(
  Array.from({ length: 256 }, (_, index) => [`message_${index}.db`, index]),
);
assert.deepEqual(normalizeSchedulerShardRowPositions(supported), supported);

const oversized = {
  ...supported,
  'message_256.db': 256,
};
assert.throws(
  () => normalizeSchedulerShardRowPositions(oversized),
  error => error?.code === 'wxdb_message_shard_limit_exceeded'
    && error?.wxdb_diagnostics?.message_shard_count === 257,
  'scheduler cursor normalization must reject 257 shards instead of silently truncating the last one',
);

console.log('scheduler shard-position limit tests passed');
