import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  forgetVerifiedWxdbKeysForAccount,
  persistedWxdbIdentityShardEvidenceForAccount,
  rememberVerifiedWxdbKeysForAccount,
  rememberWxdbIdentityShardEvidenceForAccount,
  verifiedWxdbKeysForAccount,
} from '../src/config/wxdb-key-cache.js';
import { __wxdbIsolatedInternals, hydrateWxDbIsolatedIdentityEvidenceCache } from '../src/wxdb/isolated.js';
import { createAccountIdentityShardEvidenceCacheEntry } from '../src/wxdb/index.js';

const accountId = 'wxacc_1234567890abcdef';
const directPeerFingerprint = 'a'.repeat(64);
const shardContentFingerprint = 'b'.repeat(64);
const supportByUser = new Map([
  ['wxid_local_self', new Set(['wxid_peer_one', 'wxid_peer_two'])],
]);
const entry = createAccountIdentityShardEvidenceCacheEntry({
  account_id: accountId,
  message_db: 'message_0.db',
  direct_peer_fingerprint: directPeerFingerprint,
  shard_content_fingerprint: shardContentFingerprint,
  matched_peer_tables: 2,
  support_by_user: supportByUser,
});
assert.ok(entry?.cache_key, 'test setup must create one canonical identity evidence entry');

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wx-summary-identity-evidence-'));
const file = path.join(dir, 'wxdb-keys.bin');
try {
  assert.deepEqual(await persistedWxdbIdentityShardEvidenceForAccount({ account_id: accountId, file }), []);

  assert.deepEqual(await rememberWxdbIdentityShardEvidenceForAccount({
    account_id: accountId,
    entries: [entry],
    file,
  }), { changed: true, entry_count: 1 });
  assert.deepEqual(
    await persistedWxdbIdentityShardEvidenceForAccount({ account_id: accountId, file }),
    [entry],
    'a canonical content-bound evidence entry should survive a fresh encrypted-cache read',
  );
  const encrypted = await fsp.readFile(file);
  assert.equal(encrypted.toString('utf8').includes('wxid_local_self'), false, 'identity evidence must never be stored as plaintext');

  assert.deepEqual(await rememberWxdbIdentityShardEvidenceForAccount({
    account_id: accountId,
    entries: [{ ...entry, evidence_hash: 'c'.repeat(64) }],
    file,
  }), { changed: false, entry_count: 1 }, 'tampered evidence must not replace a canonical cached entry');

  const accountFingerprint = 'd'.repeat(64);
  const verifiedKey = 'e'.repeat(64);
  assert.deepEqual(await rememberVerifiedWxdbKeysForAccount({
    account_id: accountId,
    account_fingerprint: accountFingerprint,
    keys: [verifiedKey],
    file,
  }), { changed: true, key_count: 1 });
  assert.deepEqual(await verifiedWxdbKeysForAccount({
    account_id: accountId,
    account_fingerprint: accountFingerprint,
    file,
  }), [verifiedKey], 'adding a verified key must preserve the evidence-only account record');
  assert.deepEqual(await persistedWxdbIdentityShardEvidenceForAccount({ account_id: accountId, file }), [entry]);

  __wxdbIsolatedInternals.clearAccountIdentityShardEvidenceCache(accountId);
  assert.deepEqual(__wxdbIsolatedInternals.accountIdentityShardEvidenceCacheEntriesForWorker(accountId), []);
  assert.equal(await __wxdbIsolatedInternals.hydrateAccountIdentityShardEvidenceCache(accountId, { file }), 1);
  assert.deepEqual(
    __wxdbIsolatedInternals.accountIdentityShardEvidenceCacheEntriesForWorker(accountId),
    [entry],
    'a restarted parent process should hydrate evidence before starting a database worker',
  );
  __wxdbIsolatedInternals.clearAccountIdentityShardEvidenceCache();
  assert.equal(await hydrateWxDbIsolatedIdentityEvidenceCache({ file }), 1);
  assert.deepEqual(
    __wxdbIsolatedInternals.accountIdentityShardEvidenceCacheEntriesForWorker(accountId),
    [entry],
    'the production startup hydrator should restore every account-bound entry before HTTP requests are accepted',
  );

  const forgotten = await forgetVerifiedWxdbKeysForAccount({ account_id: accountId, file });
  assert.equal(forgotten.changed, true, 'forgetting account-bound database material must also remove identity evidence');
  assert.deepEqual(await persistedWxdbIdentityShardEvidenceForAccount({ account_id: accountId, file }), []);
} finally {
  __wxdbIsolatedInternals.clearAccountIdentityShardEvidenceCache(accountId);
  await fsp.rm(dir, { recursive: true, force: true });
}

console.log('wxdb identity evidence persistence tests passed');
