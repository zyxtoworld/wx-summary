import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import realFsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';

const cancellation = Object.assign(new Error('plaintext output owner cancelled'), {
  name: 'AbortError',
  status: 499,
});
process.env.WX_SUMMARY_ALLOW_EXTERNAL_TEST_DB = '1';
const dir = await realFsp.mkdtemp(path.join(os.tmpdir(), 'wx-summary-plaintext-output-abort-'));
const sourcePath = path.join(dir, 'source.db');
const outputPath = path.join(dir, 'output.db');
const closeFailureOutputPath = path.join(dir, 'output-close-failure.db');
const key = crypto.randomBytes(32).toString('hex');
let outputCloseCalls = 0;
let outputCloseMode = 'abort';
let unclosedOutput = null;
const outputCloseFailure = new Error('plaintext output close failed');
let db = null;

try {
  const sqlcipher = await import('@signalapp/sqlcipher');
  const Database = sqlcipher.default || sqlcipher.Database;
  db = new Database(sourcePath);
  db.pragma(`key = "x'${key}'"`);
  db.pragma('cipher_page_size = 4096');
  db.pragma('kdf_iter = 256000');
  db.pragma('cipher_hmac_algorithm = HMAC_SHA512');
  db.pragma('cipher_kdf_algorithm = PBKDF2_HMAC_SHA512');
  db.exec("create table t (id integer primary key, value text); insert into t(value) values ('cancel-me');");
  db.close();
  db = null;

  mock.module('node:fs/promises', {
    defaultExport: {
      ...realFsp,
      open: async (...args) => {
        const handle = await realFsp.open(...args);
        const openedPath = path.resolve(String(args[0] || ''));
        if (![outputPath, closeFailureOutputPath].some(file => openedPath === path.resolve(file)) || args[1] !== 'wx') return handle;
        return {
          write: handle.write.bind(handle),
          async close() {
            outputCloseCalls += 1;
            if (outputCloseMode === 'throw') {
              unclosedOutput = handle;
              throw outputCloseFailure;
            }
            controller.abort(cancellation);
            await handle.close();
          },
        };
      },
    },
  });

  const controller = new AbortController();
  const { __wxdbInternals } = await import(`../src/wxdb/index.js?plaintext-output-abort-${process.pid}-${Date.now()}`);
  await assert.rejects(
    () => __wxdbInternals.decryptWeixinV4DbToPlaintext(sourcePath, key, {
      signal: controller.signal,
      allow_external_test_db: true,
      targetPath: outputPath,
    }),
    error => error === cancellation,
    'cancellation during final plaintext close must preserve the caller reason',
  );
  assert.equal(outputCloseCalls, 1, 'plaintext output close must run exactly once');
  await assert.rejects(
    realFsp.stat(outputPath),
    error => error?.code === 'ENOENT',
    'cancelled plaintext output must be removed before the caller can publish it',
  );

  outputCloseMode = 'throw';
  await assert.rejects(
    () => __wxdbInternals.decryptWeixinV4DbToPlaintext(sourcePath, key, {
      allow_external_test_db: true,
      targetPath: closeFailureOutputPath,
    }),
    error => error === outputCloseFailure,
    'a successful plaintext operation must not publish its path when output close is unconfirmed',
  );
  assert.equal(outputCloseCalls, 2, 'the close-failure scenario must still close the output exactly once');
  await assert.rejects(
    realFsp.stat(closeFailureOutputPath),
    error => error?.code === 'ENOENT',
    'an unconfirmed output close must remove the unpublished plaintext target',
  );
} finally {
  await unclosedOutput?.close().catch(() => {});
  try { db?.close(); } catch {}
  await realFsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

console.log('wxdb plaintext output abort-owner tests passed');
