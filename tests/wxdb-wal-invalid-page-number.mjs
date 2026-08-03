import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const runId = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
const acceptanceDataDir = `outputs/.tmp/wxdb-invalid-wal-page-data-${runId}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ALLOW_EXTERNAL_TEST_DB = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = acceptanceDataDir;
process.env.WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR = `${acceptanceDataDir}/runtime-tmp/wxdb`;

const { DATA_DIR, WXDB_TMP_DIR } = await import('../src/lib/paths.js');
const { __wxdbInternals } = await import('../src/wxdb/index.js');
const sqlcipher = await import('@signalapp/sqlcipher');
const Database = sqlcipher.default || sqlcipher.Database;

function walChecksum(buffer, littleEndian, checksum = [0, 0]) {
  let s0 = checksum[0] >>> 0;
  let s1 = checksum[1] >>> 0;
  const readWord = littleEndian
    ? offset => buffer.readUInt32LE(offset)
    : offset => buffer.readUInt32BE(offset);
  for (let offset = 0; offset + 7 < buffer.length; offset += 8) {
    s0 = (s0 + readWord(offset) + s1) >>> 0;
    s1 = (s1 + readWord(offset + 4) + s0) >>> 0;
  }
  checksum[0] = s0;
  checksum[1] = s1;
  return checksum;
}

function rewriteWalChecksums(wal) {
  const magic = wal.readUInt32BE(0);
  const littleEndian = magic === 0x377f0682;
  assert.ok(littleEndian || magic === 0x377f0683, 'fixture must start from a valid SQLite WAL');
  const pageSize = wal.readUInt32BE(8);
  const frameSize = 24 + pageSize;
  const frameCount = Math.floor((wal.length - 32) / frameSize);
  assert.ok(frameCount > 0, 'fixture must contain at least one complete WAL frame');
  let checksum = walChecksum(wal.subarray(0, 24), littleEndian);
  for (let index = 0; index < frameCount; index += 1) {
    const offset = 32 + index * frameSize;
    const frameHeader = wal.subarray(offset, offset + 24);
    const page = wal.subarray(offset + 24, offset + frameSize);
    const next = walChecksum(frameHeader.subarray(0, 8), littleEndian, [...checksum]);
    walChecksum(page, littleEndian, next);
    frameHeader.writeUInt32BE(next[0], 16);
    frameHeader.writeUInt32BE(next[1], 20);
    checksum = next;
  }
}

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wx-summary-invalid-wal-page-'));
const sourcePath = path.join(dir, 'source.db');
const copiedPath = path.join(dir, 'copied.db');
const key = crypto.randomBytes(32).toString('hex');
let db = null;

try {
  db = new Database(sourcePath);
  db.pragma(`key = "x'${key}'"`);
  db.pragma('cipher_page_size = 4096');
  db.pragma('kdf_iter = 256000');
  db.pragma('cipher_hmac_algorithm = HMAC_SHA512');
  db.pragma('cipher_kdf_algorithm = PBKDF2_HMAC_SHA512');
  db.exec("create table t (id integer primary key, value text); insert into t(value) values ('base');");
  db.close();
  db = null;

  db = new Database(sourcePath);
  db.pragma(`key = "x'${key}'"`);
  db.pragma('cipher_page_size = 4096');
  db.pragma('kdf_iter = 256000');
  db.pragma('cipher_hmac_algorithm = HMAC_SHA512');
  db.pragma('cipher_kdf_algorithm = PBKDF2_HMAC_SHA512');
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec("insert into t(value) values ('wal-commit');");

  await fsp.copyFile(sourcePath, copiedPath);
  await fsp.copyFile(`${sourcePath}-wal`, `${copiedPath}-wal`);
  const wal = await fsp.readFile(`${copiedPath}-wal`);
  assert.equal(wal.readUInt32BE(8), 4096, 'fixture must retain the expected encrypted page size');
  wal.writeUInt32BE(0, 32);
  rewriteWalChecksums(wal);
  await fsp.writeFile(`${copiedPath}-wal`, wal);

  await assert.rejects(
    () => __wxdbInternals.decryptWeixinV4DbToPlaintext(copiedPath, key, { allow_external_test_db: true }),
    error => error?.code === 'wxdb_temp_copy_wal_invalid'
      && error?.wxdb_diagnostics?.cause === 'wal_page_number_invalid',
    'a checksum-valid WAL frame with page number 0 must invalidate the whole copied WAL instead of being skipped',
  );
} finally {
  try { db?.close(); } catch {}
  await new Promise(resolve => setTimeout(resolve, 100));
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(WXDB_TMP_DIR, { recursive: true, force: true }).catch(() => {});
}

console.log('wxdb invalid WAL page-number tests passed');
