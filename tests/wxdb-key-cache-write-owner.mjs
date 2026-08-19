import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  rememberVerifiedWxdbKeysForAccount,
  verifiedWxdbKeysForAccount,
} from '../src/config/wxdb-key-cache.js';

const accountId = 'wxacc_write_owner';
const accountFingerprint = 'a'.repeat(64);
const verifiedKey = 'b'.repeat(64);
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wx-summary-key-cache-write-owner-'));
const file = path.join(root, 'wxdb-keys.bin');

try {
  let checks = 0;
  let stale = false;
  const result = await rememberVerifiedWxdbKeysForAccount({
    account_id: accountId,
    account_fingerprint: accountFingerprint,
    keys: [verifiedKey],
    file,
    write_if: () => {
      checks += 1;
      if (checks === 2) {
        // The owner changes immediately after the last pre-encryption check.
        stale = true;
        return true;
      }
      return !stale;
    },
  });

  assert.deepEqual(
    result,
    { changed: false, key_count: 0, skipped: 'stale_generation' },
    'a key-cache write whose owner expires after the pre-encryption check must not commit',
  );
  assert.deepEqual(
    await verifiedWxdbKeysForAccount({
      account_id: accountId,
      account_fingerprint: accountFingerprint,
      file,
    }),
    [],
    'a stale key-cache owner must not leave an old verified key on disk',
  );
  assert.ok(checks >= 3, 'the physical write boundary must recheck the owner after encryption');
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}

console.log('wxdb key-cache write-owner tests passed');
