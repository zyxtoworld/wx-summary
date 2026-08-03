import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const acceptanceDataDir = `outputs/.tmp/settings-storage-participant-${process.pid}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = acceptanceDataDir;

const { loadSettings, saveSettingsPatch } = await import('../src/config/settings.js');
const {
  createVerifiedWxdbKeyCacheRevocationTransaction,
  rememberVerifiedWxdbKeysForAccount,
  verifiedWxdbKeysForAccount,
} = await import('../src/config/wxdb-key-cache.js');

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wx-summary-settings-participant-'));
const settingsFile = path.join(root, 'settings.json');
const secretsFile = path.join(root, 'secrets.bin');
const cacheFile = path.join(root, 'wxdb-keys.bin');
const accountId = 'wxacc_storage_participant';
const accountFingerprint = 'a'.repeat(64);
const verifiedKey = 'b'.repeat(64);

async function seedKey() {
  await rememberVerifiedWxdbKeysForAccount({
    account_id: accountId,
    account_fingerprint: accountFingerprint,
    keys: [verifiedKey],
    file: cacheFile,
  });
}

async function cachedKeys() {
  return verifiedWxdbKeysForAccount({
    account_id: accountId,
    account_fingerprint: accountFingerprint,
    file: cacheFile,
  });
}

try {
  await seedKey();

  let invalidParticipantCalled = false;
  await assert.rejects(
    () => saveSettingsPatch({ output: { dir: path.join(root, 'outside-outputs') } }, {
      settingsFile,
      secretsFile,
      storage_transaction: {
        async run(action) {
          invalidParticipantCalled = true;
          return action();
        },
      },
    }),
    /output\.dir/,
  );
  assert.equal(invalidParticipantCalled, false, 'settings validation must finish before a storage participant mutates external state');

  const failedCacheTransaction = createVerifiedWxdbKeyCacheRevocationTransaction({
    scope: 'account_keys',
    account_id: accountId,
    file: cacheFile,
  });
  let persistenceEntered = false;
  const sabotagedStorageTransaction = {
    async run(action) {
      return failedCacheTransaction.run(async () => {
        persistenceEntered = true;
        await fsp.mkdir(settingsFile);
        try {
          return await action();
        } finally {
          await fsp.rm(settingsFile, { recursive: true, force: true });
        }
      });
    },
  };
  await assert.rejects(
    () => saveSettingsPatch({ logging: { level: 'debug' } }, {
      settingsFile,
      secretsFile,
      storage_transaction: sabotagedStorageTransaction,
    }),
  );
  assert.equal(persistenceEntered, true, 'the controlled failure must occur inside the actual settings persistence callback');
  assert.deepEqual(await cachedKeys(), [verifiedKey], 'a real settings storage failure must restore the pre-transaction encrypted key cache');

  const committedCacheTransaction = createVerifiedWxdbKeyCacheRevocationTransaction({
    scope: 'account_keys',
    account_id: accountId,
    file: cacheFile,
  });
  const saved = await saveSettingsPatch({ logging: { level: 'debug' } }, {
    settingsFile,
    secretsFile,
    storage_transaction: committedCacheTransaction,
  });
  assert.equal(saved.logging.level, 'debug');
  assert.deepEqual(await cachedKeys(), [], 'a successful settings storage commit must retain the matching cache revocation');
  const reloaded = await loadSettings({ settingsFile, secretsFile });
  assert.equal(reloaded.logging.level, 'debug', 'the storage participant must not weaken normal settings durability');
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}

console.log('settings storage participant runtime tests passed');
