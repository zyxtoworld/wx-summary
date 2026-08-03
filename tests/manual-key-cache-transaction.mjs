import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createVerifiedWxdbKeyCacheRevocationTransaction,
  persistedWxdbIdentityShardEvidenceForAccount,
  rememberVerifiedWxdbKeysForAccount,
  rememberWxdbIdentityShardEvidenceForAccount,
  verifiedWxdbKeysForAccount,
} from '../src/config/wxdb-key-cache.js';
import { createAccountIdentityShardEvidenceCacheEntry } from '../src/wxdb/index.js';

const accountA = 'wxacc_1111111111111111';
const accountB = 'wxacc_2222222222222222';
const fingerprintA = 'a'.repeat(64);
const fingerprintB = 'b'.repeat(64);
const keyA = 'c'.repeat(64);
const keyB = 'd'.repeat(64);
const replacementA = 'e'.repeat(64);
const evidence = createAccountIdentityShardEvidenceCacheEntry({
  account_id: accountA,
  message_db: 'message_0.db',
  direct_peer_fingerprint: 'f'.repeat(64),
  shard_content_fingerprint: '1'.repeat(64),
  matched_peer_tables: 2,
  support_by_user: new Map([
    ['wxid_local_self', new Set(['wxid_peer_one', 'wxid_peer_two'])],
  ]),
});

assert.ok(evidence?.cache_key, 'test setup must create canonical identity evidence');

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wx-summary-key-cache-txn-'));
const file = path.join(dir, 'wxdb-keys.bin');

async function seedCache() {
  await rememberVerifiedWxdbKeysForAccount({
    account_id: accountA,
    account_fingerprint: fingerprintA,
    keys: [keyA],
    file,
  });
  await rememberWxdbIdentityShardEvidenceForAccount({
    account_id: accountA,
    entries: [evidence],
    file,
  });
  await rememberVerifiedWxdbKeysForAccount({
    account_id: accountB,
    account_fingerprint: fingerprintB,
    keys: [keyB],
    file,
  });
}

async function assertSeeded(message) {
  assert.deepEqual(
    await verifiedWxdbKeysForAccount({ account_id: accountA, account_fingerprint: fingerprintA, file }),
    [keyA],
    `${message}: account A keys`,
  );
  assert.deepEqual(
    await verifiedWxdbKeysForAccount({ account_id: accountB, account_fingerprint: fingerprintB, file }),
    [keyB],
    `${message}: account B keys`,
  );
  assert.deepEqual(
    await persistedWxdbIdentityShardEvidenceForAccount({ account_id: accountA, file }),
    [evidence],
    `${message}: account A identity evidence`,
  );
}

try {
  await seedCache();

  const rejected = createVerifiedWxdbKeyCacheRevocationTransaction({
    scope: 'account_keys',
    account_id: accountA,
    file,
  });
  const commitFailure = Object.assign(new Error('settings commit failed'), { code: 'test_settings_commit_failed' });
  await assert.rejects(
    rejected.run(async () => {
      throw commitFailure;
    }),
    error => error === commitFailure,
  );
  await assertSeeded('a rejected settings commit must restore the exact previous cache state');

  let releaseCommit;
  const commitGate = new Promise(resolve => { releaseCommit = resolve; });
  let writerSettled = false;
  const committed = createVerifiedWxdbKeyCacheRevocationTransaction({
    scope: 'account_keys',
    account_id: accountA,
    file,
  });
  const commit = committed.run(async () => {
    await commitGate;
    return 'saved';
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  const concurrentWriter = rememberVerifiedWxdbKeysForAccount({
    account_id: accountA,
    account_fingerprint: fingerprintA,
    keys: [replacementA],
    file,
  }).finally(() => { writerSettled = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(writerSettled, false, 'a concurrent key writer must wait until the settings/cache transaction releases its lock');
  releaseCommit();
  assert.equal(await commit, 'saved');
  await concurrentWriter;
  assert.deepEqual(
    await verifiedWxdbKeysForAccount({ account_id: accountA, account_fingerprint: fingerprintA, file }),
    [replacementA],
    'a new verified key may be persisted only after the revocation transaction settles',
  );
  assert.deepEqual(
    await persistedWxdbIdentityShardEvidenceForAccount({ account_id: accountA, file }),
    [evidence],
    'account-scoped key revocation must preserve independently derived identity evidence',
  );
  assert.deepEqual(
    await verifiedWxdbKeysForAccount({ account_id: accountB, account_fingerprint: fingerprintB, file }),
    [keyB],
    'account-scoped key revocation must preserve other accounts',
  );

  const clearedAll = createVerifiedWxdbKeyCacheRevocationTransaction({ scope: 'all', file });
  await clearedAll.run(async () => 'saved');
  assert.deepEqual(
    await verifiedWxdbKeysForAccount({ account_id: accountA, account_fingerprint: fingerprintA, file }),
    [],
    'global revocation must clear account A keys',
  );
  assert.deepEqual(
    await verifiedWxdbKeysForAccount({ account_id: accountB, account_fingerprint: fingerprintB, file }),
    [],
    'global revocation must clear account B keys',
  );
  assert.deepEqual(
    await persistedWxdbIdentityShardEvidenceForAccount({ account_id: accountA, file }),
    [],
    'global revocation must clear identity evidence stored in the same encrypted cache',
  );
} finally {
  await fsp.rm(dir, { recursive: true, force: true });
}

console.log('manual key cache transaction tests passed');
