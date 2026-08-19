import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DB_MIRROR_AUTO_FAILURE_STORAGE_KEY,
  DB_MIRROR_AUTO_FAILURE_VISIBLE_MS,
  dbMirrorDiagnosticsReady,
  dbMirrorFailureAccountIdFromError,
  dbMirrorFailureStorageKey,
  isDbMirrorFailure,
  readDbMirrorAutoFailure,
  rememberDbMirrorAutoFailure,
  clearDbMirrorAutoFailure,
} from '../src/web/public/js/shared/db-mirror-failure.js';

class MemoryStorage {
  #values = new Map();

  getItem(key) {
    return this.#values.has(String(key)) ? this.#values.get(String(key)) : null;
  }

  setItem(key, value) {
    this.#values.set(String(key), String(value));
  }

  removeItem(key) {
    this.#values.delete(String(key));
  }

  has(key) {
    return this.#values.has(String(key));
  }
}

const accountA = {
  id: 'account-a',
  wxid: 'wx-a',
  account_aliases: ['alias-a'],
};
const accountAOldIdentity = {
  ...accountA,
  manual_key_account_fingerprint: 'fingerprint-old',
};
const accountANewIdentity = {
  ...accountA,
  manual_key_account_fingerprint: 'fingerprint-new',
};
const accountB = {
  id: 'account-b',
  wxid: 'wx-b',
  account_aliases: ['alias-b'],
};
const accounts = [accountA, accountB];
const storage = new MemoryStorage();
const now = 10_000;

assert.equal(dbMirrorFailureAccountIdFromError({ account_id: 'alias-a' }, accounts), 'account-a');
assert.equal(dbMirrorFailureAccountIdFromError({ account: accountA }, accounts), 'account-a');
assert.equal(isDbMirrorFailure({ code: 'wxdb_mirror_readiness_changed' }), true);
assert.equal(isDbMirrorFailure({ code: 'wxdb_source_snapshot_unstable' }), true);
assert.equal(isDbMirrorFailure({ code: 'wxdb_source_account_missing' }), false);
assert.equal(isDbMirrorFailure({ code: 'account_context_changed' }), false);

const first = rememberDbMirrorAutoFailure(
  { code: 'wxdb_mirror_readiness_changed', account_id: 'alias-a', message: 'first failure' },
  '',
  { storage, accounts, now },
);
assert.equal(first.account_id, 'account-a');
assert.equal(first.count, 1);
assert.equal(readDbMirrorAutoFailure({ storage, accountId: 'account-b', accounts, now }), null,
  'a late mirror error must not become the currently selected account B record');

const second = rememberDbMirrorAutoFailure(
  { code: 'wxdb_source_snapshot_unstable', account_id: 'account-a', message: 'second failure' },
  'account-a',
  { storage, accounts, now: now + 1 },
);
assert.equal(second.count, 2);
assert.equal(dbMirrorDiagnosticsReady(second), true);
assert.deepEqual(
  readDbMirrorAutoFailure({ storage, accountId: 'alias-a', accounts, now: now + 1 }),
  second,
);

const identityScopedStorage = new MemoryStorage();
rememberDbMirrorAutoFailure(
  { code: 'wxdb_mirror_readiness_changed', account_id: 'account-a', message: 'old identity failure' },
  'account-a',
  {
    storage: identityScopedStorage,
    accounts: [accountAOldIdentity],
    accountFingerprint: 'fingerprint-old',
    now,
  },
);
const oldIdentityKey = dbMirrorFailureStorageKey('account-a', {
  accounts: [accountAOldIdentity],
  accountFingerprint: 'fingerprint-old',
});
assert.equal(identityScopedStorage.has(oldIdentityKey), true);
assert.equal(
  JSON.parse(identityScopedStorage.getItem(oldIdentityKey)).account_fingerprint,
  'fingerprint-old',
);
assert.equal(
  readDbMirrorAutoFailure({
    storage: identityScopedStorage,
    accountId: 'account-a',
    accounts: [accountANewIdentity],
    accountFingerprint: 'fingerprint-new',
    now: now + 1,
  }),
  null,
  '同一账号 ID 换数据库 fingerprint 后不得读取旧身份的镜像失败记录',
);

assert.equal(rememberDbMirrorAutoFailure(
  { code: 'wxdb_mirror_readiness_changed', message: 'no account context' },
  '',
  { storage, accounts, now: now + 2 },
), null, 'mirror failures without an explicit/request account must not attach to a selected account');

const expiredKey = dbMirrorFailureStorageKey('account-b', { accounts });
storage.setItem(expiredKey, JSON.stringify({
  account_id: 'account-b',
  count: 9,
  ts: now - DB_MIRROR_AUTO_FAILURE_VISIBLE_MS - 1,
}));
assert.equal(readDbMirrorAutoFailure({ storage, accountId: 'account-b', accounts, now }), null);
assert.equal(storage.has(expiredKey), false, 'expired records must be removed by exact key');

const unrelatedKey = `${DB_MIRROR_AUTO_FAILURE_STORAGE_KEY}:unrelated`;
storage.setItem(unrelatedKey, 'keep');
assert.equal(clearDbMirrorAutoFailure({ storage, accountId: 'account-a', accounts }), true);
assert.equal(storage.has(dbMirrorFailureStorageKey('account-a', { accounts })), false);
assert.equal(storage.has(unrelatedKey), true, 'clearing one account must not clear unrelated storage keys');

const [privacySource, schedulerSource, digestSource, setupSource] = await Promise.all([
  readFile(new URL('../src/web/public/js/pages/settings/privacy.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/js/pages/settings/scheduler.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/js/pages/setup/step-key.js', import.meta.url), 'utf8'),
]);
for (const [name, source] of [
  ['settings privacy', privacySource],
  ['settings scheduler', schedulerSource],
  ['digest groups', digestSource],
  ['setup key validation', setupSource],
]) {
  assert.match(source, /db-mirror-failure\.js/, `${name} must use the shared mirror failure contract`);
  assert.match(source, /rememberDbMirrorAutoFailure\(/, `${name} must persist failures with its request account`);
  assert.match(source, /clearDbMirrorAutoFailure\(/, `${name} must clear the record after a successful check`);
  assert.match(source, /accountFingerprint\s*:/, `${name} must scope mirror failures by account fingerprint`);
}

console.log('web DB mirror failure account-context tests passed');
