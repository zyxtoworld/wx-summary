import assert from 'node:assert/strict';

import sqlcipher from '@signalapp/sqlcipher';

import { __wxdbInternals } from '../src/wxdb/index.js';

const Database = sqlcipher.default || sqlcipher.Database || sqlcipher;
const CANDIDATE_LIMIT = 32;

function createIdentityFixture() {
  const db = new Database(':memory:');
  db.exec(`
    create table Name2Id (user_name text);
    create table Msg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa (real_sender_id integer);
    create table Msg_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb (real_sender_id integer);
    create table Msg_cccccccccccccccccccccccccccccccc (real_sender_id integer);
  `);
  return db;
}

function insertName(db, rowid, username) {
  db.prepare('insert into Name2Id(rowid, user_name) values (?, ?)').run([rowid, username]);
}

function insertSender(db, table, senderId) {
  db.prepare(`insert into "${table}"(real_sender_id) values (?)`).run([senderId]);
}

const db = createIdentityFixture();
try {
  const noisyTable = 'Msg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  insertName(db, 1, 'wxid_peer');
  insertName(db, 2, 'room@chatroom');
  insertName(db, 3, 'wxid_self');
  insertName(db, 4, 'wxid_self');
  insertName(db, 5, '   ');
  insertName(db, 6, 'x'.repeat(201));
  insertName(db, 7, `invalid\0user`);
  for (let senderId = 1; senderId <= 7; senderId += 1) insertSender(db, noisyTable, senderId);
  for (let senderId = 1_000; senderId < 1_040; senderId += 1) insertSender(db, noisyTable, senderId);

  const filtered = __wxdbInternals.scanAccountIdentityPeerCandidates(db, noisyTable, 'wxid_peer', {
    candidate_limit: CANDIDATE_LIMIT,
  });
  assert.deepEqual(filtered.candidates, ['wxid_self']);
  assert.equal(filtered.candidate_limit_reached, false, 'unmapped and semantically impossible sender ids must not consume the identity-candidate budget');

  const exactTable = 'Msg_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  for (let index = 0; index < CANDIDATE_LIMIT; index += 1) {
    const rowid = 100 + index;
    insertName(db, rowid, `wxid_exact_${String(index).padStart(2, '0')}`);
    insertSender(db, exactTable, rowid);
  }
  const exact = __wxdbInternals.scanAccountIdentityPeerCandidates(db, exactTable, 'wxid_peer', {
    candidate_limit: CANDIDATE_LIMIT,
  });
  assert.equal(exact.candidates.length, CANDIDATE_LIMIT);
  assert.equal(exact.candidate_limit_reached, false, 'an exactly full semantic candidate set is still complete');

  const overflowTable = 'Msg_cccccccccccccccccccccccccccccccc';
  for (let index = 0; index <= CANDIDATE_LIMIT; index += 1) {
    const rowid = 200 + index;
    insertName(db, rowid, `wxid_overflow_${String(index).padStart(2, '0')}`);
    insertSender(db, overflowTable, rowid);
  }
  const overflow = __wxdbInternals.scanAccountIdentityPeerCandidates(db, overflowTable, 'wxid_peer', {
    candidate_limit: CANDIDATE_LIMIT,
  });
  assert.equal(overflow.candidates.length, CANDIDATE_LIMIT);
  assert.equal(overflow.candidate_limit_reached, true, 'the thirty-third real semantic candidate must still fail closed');
} finally {
  try { db.close(); } catch {}
}

const currentEntry = __wxdbInternals.createAccountIdentityShardEvidenceCacheEntry({
  account_id: 'wxacc_0123456789abcdef',
  message_db: 'message_0.db',
  direct_peer_fingerprint: 'a'.repeat(64),
  shard_content_fingerprint: 'b'.repeat(64),
  matched_peer_tables: 2,
  peer_candidate_limit_reached: false,
  support_by_user: new Map([['wxid_self', new Set(['wxid_peer_one', 'wxid_peer_two'])]]),
});
assert.equal(currentEntry?.version, 'wxdb-identity-shard-evidence-v2', 'candidate-scan semantics must have a new evidence version');
assert.equal(
  __wxdbInternals.normalizeAccountIdentityShardEvidenceCacheEntry({
    ...currentEntry,
    version: 'wxdb-identity-shard-evidence-v1',
  }, 'wxacc_0123456789abcdef'),
  null,
  'v1 evidence used the old row-truncation semantics and must never be reused',
);

console.log('wxdb identity candidate scan tests passed');
