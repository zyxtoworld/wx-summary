import assert from 'node:assert/strict';
import sqlcipher from '@signalapp/sqlcipher';
import { __wxdbInternals } from '../src/wxdb/index.js';

const {
  messageShardCursorRecord,
  messageShardCursorState,
  messageShardGenerationFingerprint,
  messageShardRowAnchorHash,
  normalizeMessageShardRowPositions,
} = __wxdbInternals;

const file = {
  category: 'message',
  name: 'message_7.db',
  birthtimeMs: 500,
  dev: 12,
  ino: 107,
  sha256: 'a'.repeat(64),
};

const anchorRow = {
  rowid: 81,
  local_id: 81,
  server_id: 'server-81',
  local_type: 1,
  sort_seq: '9007199254740993123',
  real_sender_id: 17,
  create_time: 1_725_000_000,
  message_content_bytes: 14,
  message_content_prefix: Buffer.from('anchor content'),
  message_content_suffix: Buffer.from('anchor content'),
  compress_content_bytes: 3,
  compress_content_prefix: Buffer.from([1, 2, 3]),
  compress_content_suffix: Buffer.from([1, 2, 3]),
  packed_info_data_bytes: null,
  packed_info_data_prefix: null,
  packed_info_data_suffix: null,
};

function dbWithRow(row = anchorRow) {
  return {
    prepare(sql) {
      assert.match(sql, /where rowid = \?/i);
      return {
        get(params) {
          return Number(params?.[0]) === Number(row?.rowid) ? row : undefined;
        },
      };
    },
  };
}

const originalDb = dbWithRow();
const originalHash = messageShardRowAnchorHash(originalDb, 'Msg_anchor', 81);
assert.match(originalHash, /^[a-f0-9]{64}$/);
assert.equal(messageShardRowAnchorHash(originalDb, 'Msg_anchor', 81), originalHash);
assert.notEqual(
  messageShardRowAnchorHash(dbWithRow({
    ...anchorRow,
    message_content_prefix: Buffer.from('rebuilt content'),
    message_content_suffix: Buffer.from('rebuilt content'),
  }), 'Msg_anchor', 81),
  originalHash,
  'the cursor anchor must change when an in-place rebuild replaces the watermark row',
);
assert.throws(
  () => messageShardRowAnchorHash(dbWithRow(null), 'Msg_anchor', 81),
  error => error?.code === 'wxdb_message_shard_anchor_missing',
  'a missing positive watermark row must fail closed',
);

const record = messageShardCursorRecord(file, originalDb, 'Msg_anchor', 81);
assert.deepEqual(record, {
  row_id: 81,
  generation: messageShardGenerationFingerprint(file),
  anchor_hash: originalHash,
});
assert.deepEqual(normalizeMessageShardRowPositions({ [file.name]: record }), { [file.name]: record });

const continued = messageShardCursorState(file, { [file.name]: record }, {
  db: originalDb,
  table_name: 'Msg_anchor',
});
assert.equal(continued.has_previous, true);
assert.equal(continued.previous_row_id, 81);

const rebuilt = messageShardCursorState(file, { [file.name]: record }, {
  db: dbWithRow({
    ...anchorRow,
    message_content_prefix: Buffer.from('rebuilt content'),
    message_content_suffix: Buffer.from('rebuilt content'),
  }),
  table_name: 'Msg_anchor',
});
assert.equal(rebuilt.has_previous, false, 'same-inode in-place rebuilds must not inherit the old rowid');
assert.equal(rebuilt.reset_reason, 'anchor_mismatch');

const legacy = messageShardCursorState(file, { [file.name]: 81 }, {
  db: originalDb,
  table_name: 'Msg_anchor',
});
assert.equal(legacy.has_previous, false, 'legacy numeric watermarks have no continuity proof and must be reread safely');
assert.equal(legacy.reset_reason, 'legacy_unverified');

const Database = sqlcipher.default || sqlcipher.Database || sqlcipher;
const realDb = new Database(':memory:');
try {
  realDb.exec(`
    create table Msg_anchor (
      local_id integer,
      server_id integer,
      local_type integer,
      sort_seq integer,
      real_sender_id integer,
      create_time integer,
      message_content blob,
      compress_content blob,
      packed_info_data blob
    )
  `);
  realDb.prepare(`
    insert into Msg_anchor(
      rowid, local_id, server_id, local_type, sort_seq, real_sender_id, create_time,
      message_content, compress_content, packed_info_data
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run([81, 81, 9001, 1, 123456789, 17, 1725000000, 'anchor content', Buffer.from([1, 2, 3]), null]);
  const firstRealHash = messageShardRowAnchorHash(realDb, 'Msg_anchor', 81);
  assert.match(firstRealHash, /^[a-f0-9]{64}$/, 'the real SQLite query must produce a bounded anchor hash');
  realDb.prepare('update Msg_anchor set message_content = ? where rowid = ?').run(['rebuilt content', 81]);
  assert.notEqual(
    messageShardRowAnchorHash(realDb, 'Msg_anchor', 81),
    firstRealHash,
    'the real SQLite anchor query must detect replacement of the watermark row',
  );
} finally {
  try { realDb.close(); } catch {}
}

console.log('wxdb shard anchor integrity tests passed');
