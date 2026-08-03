import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await fsp.readFile(path.join(ROOT, 'src', 'wxdb', 'index.js'), 'utf8');
const start = source.indexOf('async function verifyAndRecordProjectMirrorAccountIdentity');
const end = source.indexOf('\nasync function extractSelfWxidFromProjectMirrorAccount', start);

assert.ok(start >= 0 && end > start, 'identity verification implementation must remain discoverable');
const identitySource = source.slice(start, end);
assert.ok(
  identitySource.includes('return withWxDbMirrorReadLock(wxDbMirrorLockIdForAccount(account), async () => {'),
  'one account mirror lock must cover the complete identity evidence and commit transaction',
);
assert.ok(
  identitySource.includes("accountMirrorReadinessTokenForLockedRead(account, 'identity')")
    && identitySource.includes('accountMatchesMirrorReadinessToken(lockedAccount, expectedReadiness, \'identity\')'),
  'the identity transaction must revalidate the caller snapshot after acquiring the account lock',
);
assert.ok(
  identitySource.indexOf('extractSelfWxidFromProjectMirrorAccount(lockedAccount')
    < identitySource.indexOf('recordWxDbMirrorAccountIdentity({'),
  'all identity evidence must be extracted from the locked account before committing it',
);
assert.ok(
  identitySource.includes('Object.assign(account, lockedAccount)')
    && identitySource.includes('expected_published_manifest_hash: accountMirrorPublishedManifestHash(lockedAccount)'),
  'the caller must continue with the exact locked account generation that was committed',
);

console.log('wxdb account identity lock coverage test passed');
