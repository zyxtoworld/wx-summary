import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.WX_SUMMARY_ALLOW_EXTERNAL_TEST_DB = '1';
const { __wxdbInternals } = await import('../src/wxdb/index.js');

const source = await fs.readFile(new URL('../src/wxdb/index.js', import.meta.url), 'utf8');
const start = source.indexOf('async function openCopiedSqlCipherDb(');
const end = source.indexOf('\nasync function openMessageSqlCipherDb(', start);
assert.ok(start >= 0 && end > start, 'copied SQLCipher open path must remain available');
const openSource = source.slice(start, end);
const weixinOpenStart = source.indexOf('async function openWeixinV4DecryptedDb(');
const weixinOpenEnd = source.indexOf('\nasync function openCachedWeixinV4PlaintextDb(', weixinOpenStart);
assert.ok(weixinOpenStart >= 0 && weixinOpenEnd > weixinOpenStart, 'Weixin copied-DB open path must remain available');
const weixinOpenSource = source.slice(weixinOpenStart, weixinOpenEnd);

assert.doesNotMatch(
  source,
  /WEIXIN_V4_OPEN_PASSPHRASE_DERIVE_CANDIDATE_LIMIT/,
  'the real copied-DB open path must not silently use a smaller passphrase window than copied-page validation',
);
assert.match(
  openSource,
  /maxPassphraseDeriveCandidates: WEIXIN_V4_PASSPHRASE_DERIVE_CANDIDATE_LIMIT/,
  'the real copied-DB open path should retain every candidate covered by the bounded 96-candidate validation window',
);
assert.match(
  weixinOpenSource,
  /on_progress:\s*progress\s*=>[\s\S]*fetch_shard_passphrase_verify[\s\S]*progress\.attempted[\s\S]*progress\.total/,
  'the real copied-DB open path should expose bounded passphrase derivation progress instead of appearing frozen',
);

const pageKeyStart = source.indexOf('async function findWeixinV4PageKeyForCopiedDb(');
const pageKeyEnd = source.indexOf('\nfunction weixinV4KeyCandidates(', pageKeyStart);
assert.ok(pageKeyStart >= 0 && pageKeyEnd > pageKeyStart, 'Weixin page-key validation path must remain available');
const pageKeySource = source.slice(pageKeyStart, pageKeyEnd);
assert.match(
  pageKeySource,
  /notifyProgress\(onProgress,\s*\{\s*phase:\s*'passphrase_derive'[\s\S]*attempted:[\s\S]*total:/,
  'bounded passphrase derivation should report non-secret attempted and total counts',
);

const encryptionKey = 'a'.repeat(64);
const hmacKey = 'b'.repeat(64);
const embeddedSalt = 'c'.repeat(32);
assert.deepEqual(
  __wxdbInternals.weixinV4KeyCandidates([`${encryptionKey}${hmacKey}${embeddedSalt}`], 'd'.repeat(32)),
  [encryptionKey],
  'a 160-hex SQLCipher keyspec must not spend a direct or PBKDF2 attempt on its HMAC-key half',
);

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wx-summary-passphrase-progress-'));
try {
  const dbPath = path.join(dir, 'page.db');
  const passphrase = crypto.randomBytes(32).toString('hex');
  const salt = crypto.randomBytes(16);
  const derived = __wxdbInternals.deriveWeixinV4PassphrasePageKey(passphrase, salt);
  const page = Buffer.alloc(4096);
  salt.copy(page, 0);
  crypto.randomBytes(4096 - 16 - 64).copy(page, 16);
  const macSalt = Buffer.from(salt.map(byte => byte ^ 0x3a));
  const macKey = crypto.pbkdf2Sync(Buffer.from(derived, 'hex'), macSalt, 2, 32, 'sha512');
  const hmac = crypto.createHmac('sha512', macKey);
  hmac.update(page.subarray(16, 4096 - 64));
  const pageNo = Buffer.alloc(4);
  pageNo.writeUInt32LE(1, 0);
  hmac.update(pageNo);
  hmac.digest().copy(page, 4096 - 64);
  await fs.writeFile(dbPath, page);

  const progress = [];
  const found = await __wxdbInternals.findWeixinV4PageKeyForCopiedDb(dbPath, [passphrase], {
    derive_passphrase_keys: true,
    max_passphrase_derive_candidates: 1,
    allow_external_test_db: true,
    on_progress: event => progress.push(event),
  });
  assert.equal(found.ok, true, 'the focused fixture should exercise the real passphrase derivation path');
  assert.deepEqual(
    progress.map(event => ({ phase: event.phase, attempted: event.attempted, total: event.total })),
    [
      { phase: 'passphrase_derive', attempted: 0, total: 1 },
      { phase: 'passphrase_derive', attempted: 1, total: 1 },
    ],
    'the real derivation path should publish a bounded start and completion count without key material',
  );
  assert.equal(JSON.stringify(progress).includes(passphrase), false, 'progress events must not expose candidate key material');
  assert.equal(JSON.stringify(progress).includes(derived), false, 'progress events must not expose derived key material');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}

console.log('Weixin copied-DB passphrase window tests passed');
