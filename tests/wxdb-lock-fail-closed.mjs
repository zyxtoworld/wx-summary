import assert from 'node:assert/strict';
import { __discoveryInternals } from '../src/wxenv/discovery.js';
import { __wxdbInternals } from '../src/wxdb/index.js';
import { __wxdbKeyCacheInternals } from '../src/config/wxdb-key-cache.js';

const now = Date.now();
const keyCacheOwner = { pid: 123, token: 'owner-token', process_start_id: 'start-a' };
const plaintextOwner = { pid: 123, process_token: '0123456789abcdef', process_start_id: 'start-a' };
const staleKeyCacheLease = { owner: keyCacheOwner, stat: { mtimeMs: now - 60_000 } };
const stalePlaintextLease = { owner: plaintextOwner, stat: { mtimeMs: now - 60_000 } };
const unknownOwnerDependencies = { processAlive: () => true, processStartIdentityFn: async () => '' };

assert.equal(
  await __wxdbKeyCacheInternals.keyCacheLockOwnerMatches(staleKeyCacheLease, unknownOwnerDependencies),
  true,
  'a live key-cache lock with an unavailable process identity must remain protected even after its heartbeat is stale',
);
assert.equal(
  await __wxdbInternals.plaintextCacheOwnerMatches(plaintextOwner, stalePlaintextLease, unknownOwnerDependencies),
  true,
  'a live plaintext-cache lease with an unavailable process identity must remain protected even after its heartbeat is stale',
);
assert.equal(
  await __wxdbKeyCacheInternals.keyCacheLockOwnerMatches(staleKeyCacheLease, { processAlive: () => false, processStartIdentityFn: async () => '' }),
  false,
  'a dead key-cache lock owner remains reclaimable',
);
assert.equal(
  await __wxdbInternals.plaintextCacheOwnerMatches(plaintextOwner, stalePlaintextLease, { processAlive: () => true, processStartIdentityFn: async () => 'start-b' }),
  false,
  'a reused plaintext-cache PID remains reclaimable when its process generation differs',
);

const expectedCodes = new Map([
  ['EBUSY', 'wxdb_source_file_busy'],
  ['EPERM', 'wxdb_source_access_denied'],
  ['EACCES', 'wxdb_source_access_denied'],
  ['ENOENT', 'wxdb_source_file_missing'],
]);
for (const [errno, expected] of expectedCodes) {
  const error = Object.assign(new Error('source copy failed'), { code: errno });
  const exhausted = __discoveryInternals.mirrorCopyRetryExhaustedError(error, 1);
  assert.equal(exhausted.code, expected, `${errno} must map to a stable public source-copy code`);
  assert.equal(exhausted.public_code, expected, `${errno} must not leak an OS errno into the public API code`);
  assert.match(exhausted.code, /^wxdb_source_[a-z0-9_]+$/, `${errno} must remain classifiable as a shared mirror failure`);
}

console.log('wxdb fail-closed lock tests passed');
