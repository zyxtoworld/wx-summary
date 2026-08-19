import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

const source = await fsp.readFile(new URL('../src/wxdb/index.js', import.meta.url), 'utf8');
const start = source.indexOf('async function openCopiedSqlCipherDb(');
const end = source.indexOf('\nasync function openMessageSqlCipherDb(', start);
assert.ok(start >= 0 && end > start, 'copied SQLCipher open caller must remain inspectable');
const openSource = source.slice(start, end);

function extractProductionOpen({
  copyDbFile,
  assertCopiedDbRealPath,
  throwIfAborted,
  removeCopiedDb,
  loadSqlCipher = async () => ({}),
  openWeixinV4DecryptedDb = async () => null,
  notifyProgress = () => {},
  persistableRawKey = value => value,
  closeCopiedDb = async () => {},
  WEIXIN_V4_PASSPHRASE_DERIVE_CANDIDATE_LIMIT = 64,
}) {
  return new Function(
    'copyDbFile',
    'assertCopiedDbRealPath',
    'throwIfAborted',
    'removeCopiedDb',
    'loadSqlCipher',
    'openWeixinV4DecryptedDb',
    'notifyProgress',
    'persistableRawKey',
    'closeCopiedDb',
    'WEIXIN_V4_PASSPHRASE_DERIVE_CANDIDATE_LIMIT',
    'path',
    'uniqueStrings',
    `${openSource}\nreturn openCopiedSqlCipherDb;`,
  )(
    copyDbFile,
    assertCopiedDbRealPath,
    throwIfAborted,
    removeCopiedDb,
    loadSqlCipher,
    openWeixinV4DecryptedDb,
    notifyProgress,
    persistableRawKey,
    closeCopiedDb,
    WEIXIN_V4_PASSPHRASE_DERIVE_CANDIDATE_LIMIT,
    path,
    values => [...new Set(values)],
  );
}

const cancellation = Object.assign(new Error('copied database open cancelled after copy'), {
  name: 'AbortError',
  status: 499,
});
const controller = new AbortController();
const copied = { target_path: 'C:/fixture/copied.db' };
let removeCalls = 0;
const open = extractProductionOpen({
  copyDbFile: async () => copied,
  assertCopiedDbRealPath: async () => {
    controller.abort(cancellation);
    throw cancellation;
  },
  throwIfAborted(signal) {
    if (signal?.aborted) throw signal.reason;
  },
  removeCopiedDb: async targetPath => {
    removeCalls += 1;
    assert.equal(targetPath, copied.target_path, 'post-copy cleanup must use the verified copied target');
  },
});

await assert.rejects(
  () => open(
    { account_id: 'wxacc_fixture', db_storage: 'C:/fixture/db' },
    'C:/fixture/db/message.db',
    [],
    { signal: controller.signal },
  ),
  error => error === cancellation,
  'a caller cancellation after copy must preserve the original cancellation reason',
);
assert.equal(
  removeCalls,
  1,
  'a copied database must be removed when the post-copy validation/owner handoff is cancelled',
);

{
  const lateCancellation = Object.assign(new Error('copied database open cancelled after decrypt'), {
    name: 'AbortError',
    status: 499,
  });
  const lateController = new AbortController();
  const lateCopied = { target_path: 'C:/fixture/copied-late.db' };
  let lateRemoveCalls = 0;
  let lateCloseCalls = 0;
  const lateOpen = extractProductionOpen({
    copyDbFile: async () => lateCopied,
    assertCopiedDbRealPath: async () => {},
    throwIfAborted(signal) {
      if (signal?.aborted) throw signal.reason;
    },
    removeCopiedDb: async targetPath => {
      lateRemoveCalls += 1;
      assert.equal(targetPath, lateCopied.target_path, 'late cancellation cleanup must use the copied target');
    },
    loadSqlCipher: async () => ({}),
    openWeixinV4DecryptedDb: async () => {
      lateController.abort(lateCancellation);
      return {
        db: { close() {} },
        raw_key: 'raw-key',
        key_hash: 'key-hash',
        key_profile: 'profile',
        plain_path: 'C:/fixture/plain.db',
        plain_cached: false,
        plain_lease: '',
      };
    },
    persistableRawKey: value => value,
    closeCopiedDb: async (targetPath, db, plainPath, options) => {
      lateCloseCalls += 1;
      assert.equal(targetPath, lateCopied.target_path, 'late cancellation close must own the copied target');
      assert.ok(db, 'late cancellation close must receive the opened database');
      assert.equal(plainPath, 'C:/fixture/plain.db', 'late cancellation close must release the plaintext cache');
      assert.equal(options?.plainLease, '', 'late cancellation close must receive the plaintext lease');
    },
  });

  await assert.rejects(
    () => lateOpen(
      { account_id: 'wxacc_fixture', db_storage: 'C:/fixture/db' },
      'C:/fixture/db/message.db',
      ['candidate'],
      { signal: lateController.signal },
    ),
    error => error === lateCancellation,
    'cancellation after decrypted DB open must not hand the DB to the caller',
  );
  assert.equal(lateCloseCalls, 1, 'a DB opened just before cancellation must be closed by its handoff owner');
  assert.equal(lateRemoveCalls, 0, 'the handoff owner must prevent a second generic copied-target cleanup');
}

console.log('wxdb copied SQLCipher open cancellation cleanup tests passed');
