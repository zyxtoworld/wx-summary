import assert from 'node:assert/strict';
import realFsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';

process.env.WX_SUMMARY_ALLOW_EXTERNAL_TEST_DB = '1';

function checksum(buffer, checksumState = [0, 0], littleEndian = true) {
  let s0 = checksumState[0] >>> 0;
  let s1 = checksumState[1] >>> 0;
  const readWord = littleEndian ? Buffer.prototype.readUInt32LE : Buffer.prototype.readUInt32BE;
  for (let index = 0; index + 7 < buffer.length; index += 8) {
    s0 = (s0 + readWord.call(buffer, index) + s1) >>> 0;
    s1 = (s1 + readWord.call(buffer, index + 4) + s0) >>> 0;
  }
  return [s0, s1];
}

const dir = await realFsp.mkdtemp(path.join(os.tmpdir(), 'wx-summary-wal-close-owner-'));
const dbPath = path.join(dir, 'source.db');
const plainPath = path.join(dir, 'plain.db');
const walPath = `${dbPath}-wal`;
const closeFailure = new Error('plaintext WAL output close failed');
const page = Buffer.alloc(4096);
const header = Buffer.alloc(32);
header.writeUInt32BE(0x377f0682, 0);
header.writeUInt32BE(4096, 8);
header.writeUInt32BE(0x01020304, 16);
header.writeUInt32BE(0x05060708, 20);
const headerChecksum = checksum(header.subarray(0, 24));
header.writeUInt32BE(headerChecksum[0], 24);
header.writeUInt32BE(headerChecksum[1], 28);
const frameHeader = Buffer.alloc(24);
frameHeader.writeUInt32BE(1, 0);
frameHeader.writeUInt32BE(1, 4);
frameHeader.writeUInt32BE(0x01020304, 8);
frameHeader.writeUInt32BE(0x05060708, 12);
const frameChecksum = checksum(page, checksum(frameHeader.subarray(0, 8), headerChecksum));
frameHeader.writeUInt32BE(frameChecksum[0], 16);
frameHeader.writeUInt32BE(frameChecksum[1], 20);
const walBytes = Buffer.concat([header, frameHeader, page]);

let inputCloseCalls = 0;
let outputCloseCalls = 0;
const inputHandle = {
  async read(buffer, offset, length, position) {
    const source = position === 0 ? header : (position === 32 ? frameHeader : page);
    const bytes = source.subarray(0, length);
    bytes.copy(buffer, offset);
    return { bytesRead: bytes.length };
  },
  async close() {
    inputCloseCalls += 1;
  },
};
const outputHandle = {
  async write(_buffer, _offset, length) {
    return { bytesWritten: length };
  },
  async truncate() {},
  async close() {
    outputCloseCalls += 1;
    throw closeFailure;
  },
};

mock.module('node:fs/promises', {
  defaultExport: {
    ...realFsp,
    async lstat(file) {
      if (path.resolve(String(file)) === path.resolve(walPath)) {
        return { isSymbolicLink: () => false, isFile: () => true, size: walBytes.length };
      }
      return realFsp.lstat(file);
    },
    async open(file, flags) {
      const resolved = path.resolve(String(file));
      if (resolved === path.resolve(walPath) && flags === 'r') return inputHandle;
      if (resolved === path.resolve(plainPath) && flags === 'r+') return outputHandle;
      return realFsp.open(file, flags);
    },
  },
});

try {
  await realFsp.writeFile(dbPath, Buffer.alloc(4096));
  await realFsp.writeFile(plainPath, Buffer.alloc(4096));
  await realFsp.writeFile(walPath, walBytes);
  const { __wxdbInternals } = await import(`../src/wxdb/index.js?wal-merge-close-owner-${process.pid}-${Date.now()}`);
  assert.equal(typeof __wxdbInternals.mergeWeixinV4WalIntoPlaintext, 'function');
  await assert.rejects(
    () => __wxdbInternals.mergeWeixinV4WalIntoPlaintext(dbPath, plainPath, {}, { allow_external_test_db: true }),
    error => error === closeFailure,
    'a WAL merge must not publish success when the plaintext output handle close fails',
  );
  assert.equal(inputCloseCalls, 1, 'WAL input close must run exactly once');
  assert.equal(outputCloseCalls, 1, 'WAL output close must run exactly once');
} finally {
  await realFsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

console.log('wxdb WAL merge close-owner tests passed');
