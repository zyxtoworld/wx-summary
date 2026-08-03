import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ACCOUNT_IDENTITY_MAX_MESSAGE_SHARDS,
  accountIdentityMessageShardCandidates,
} from '../src/wxdb/identity-scope.js';
import { __discoveryInternals, wxDbMirrorScopeCoverageCandidates } from '../src/wxenv/discovery.js';
import { __collectorInternals } from '../src/collector/index.js';
import { __wxdbInternals } from '../src/wxdb/index.js';

const shards = Array.from({ length: 40 }, (_, index) => ({
  category: 'message',
  name: `message_${index}.db`,
  path: `C:/source/message/message_${index}.db`,
  bytes: 1000 + index * 97,
  mtimeMs: Date.UTC(2026, 6, 1 + index),
  last_write_time: new Date(Date.UTC(2026, 6, 1 + index)).toISOString(),
}));
const selected = accountIdentityMessageShardCandidates(shards);
const selectedAgain = accountIdentityMessageShardCandidates([...shards].reverse());
assert.equal(selected.length, shards.length, 'identity preparation must include every source message shard below the hard limit');
assert.deepEqual(selected.map(item => item.name), selectedAgain.map(item => item.name), 'identity shard selection must not depend on source enumeration order');
assert.ok(selected.some(item => item.name === 'message_39.db'), 'the identity sample must include recent shards');
assert.ok(selected.some(item => item.name === 'message_0.db'), 'the identity sample must include small shards');

const overLimitShards = Array.from({ length: 80 }, (_, index) => ({
  category: 'message',
  name: `message_${index}.db`,
  path: `C:/source/message/message_${index}.db`,
  bytes: 1000 + index * 97,
  mtimeMs: Date.UTC(2026, 4, 1 + index),
  last_write_time: new Date(Date.UTC(2026, 4, 1 + index)).toISOString(),
}));
assert.equal(
  accountIdentityMessageShardCandidates(overLimitShards).length,
  ACCOUNT_IDENTITY_MAX_MESSAGE_SHARDS,
  'identity preparation must enforce the global source message shard hard limit',
);

assert.deepEqual(wxDbMirrorScopeCoverageCandidates('groups'), ['groups', 'identity', 'digest', 'full']);
assert.deepEqual(wxDbMirrorScopeCoverageCandidates('identity'), ['identity', 'digest', 'full']);
assert.deepEqual(wxDbMirrorScopeCoverageCandidates('digest'), ['digest', 'full']);
assert.equal(__collectorInternals.mirrorReadinessCoversRequiredScope('groups', { scope: 'identity' }), true, 'identity contains contact/session and may serve a group read');
assert.equal(__collectorInternals.mirrorReadinessCoversRequiredScope('identity', { scope: 'identity' }), true, 'identity readiness must serve identity verification');
assert.equal(__collectorInternals.mirrorReadinessCoversRequiredScope('digest', { scope: 'identity' }), false, 'a partial identity sample must never authorize digest reads');
assert.equal(__wxdbInternals.mirrorReadinessCovers('digest', 'identity'), false, 'the isolated DB reader must reject identity readiness for full digest reads');

const digestRecord = {
  scope: 'digest',
  categories: ['message', 'contact', 'session', 'hardlink'],
  source_snapshot_meta_hash: 'digest-hash',
  source_snapshot: { files: [] },
};
const fullRecord = {
  scope: 'full',
  categories: ['message', 'contact', 'session', 'hardlink'],
  source_snapshot_meta_hash: 'full-hash',
  source_snapshot: { files: [] },
};
const nextScopes = __discoveryInternals.mirrorSourceScopesForWrite({
  source_scopes: { digest: digestRecord, full: fullRecord },
}, {
  key: 'identity',
  label: '账号身份',
  categories: ['message', 'contact', 'session'],
}, {
  hash: 'identity-hash',
  db_count: 3,
  bytes: 123,
  eligible_message_count: 80,
  selected_message_count: ACCOUNT_IDENTITY_MAX_MESSAGE_SHARDS,
  selection_limit: ACCOUNT_IDENTITY_MAX_MESSAGE_SHARDS,
  selection_strategy: 'complete_up_to_hard_limit',
}, '2026-07-30T00:00:00.000Z', 'source_snapshot_changed', 'replace', {
  db_count: 3,
  bytes: 123,
  files: [],
  eligible_message_count: 80,
  selected_message_count: ACCOUNT_IDENTITY_MAX_MESSAGE_SHARDS,
  selection_limit: ACCOUNT_IDENTITY_MAX_MESSAGE_SHARDS,
  selection_strategy: 'complete_up_to_hard_limit',
});
assert.equal(nextScopes.digest, undefined, 'publishing a partial identity message category must invalidate the old digest scope');
assert.equal(nextScopes.full, undefined, 'publishing a partial identity message category must invalidate the old full scope');
assert.equal(nextScopes.identity?.source_snapshot?.eligible_message_count, 80, 'identity scope must retain the source candidate count for truncation diagnostics');

const completeIdentityFiles = [
  { relative: 'message/message_0.db', kind: 'db', bytes: 10, mtimeMs: 1, sha256: '1'.repeat(64) },
  { relative: 'contact/contact.db', kind: 'db', bytes: 20, mtimeMs: 2, sha256: '2'.repeat(64) },
  { relative: 'session/session.db', kind: 'db', bytes: 30, mtimeMs: 3, sha256: '3'.repeat(64) },
];
const completeDigestRecord = {
  scope: 'digest',
  categories: ['message', 'contact', 'session', 'hardlink'],
  source_snapshot: {
    target_content_hash_alg: 'sha256',
    target_content_verified_at: '2026-07-29T00:00:00.000Z',
    files: completeIdentityFiles,
  },
};
const completeSmallIdentityScopes = __discoveryInternals.mirrorSourceScopesForWrite({
  source_scopes: { digest: completeDigestRecord },
}, {
  key: 'identity',
  label: '账号身份',
  categories: ['message', 'contact', 'session'],
}, {
  hash: 'complete-identity-hash',
  db_count: 3,
  bytes: 60,
  eligible_message_count: 1,
  selected_message_count: 1,
  selection_limit: ACCOUNT_IDENTITY_MAX_MESSAGE_SHARDS,
  selection_strategy: 'complete_up_to_hard_limit',
}, '2026-07-30T00:00:00.000Z', 'source_snapshot_changed', 'replace', {
  target_content_hash_alg: 'sha256',
  target_content_verified_at: '2026-07-30T00:00:00.000Z',
  db_count: 3,
  bytes: 60,
  files: completeIdentityFiles,
  eligible_message_count: 1,
  selected_message_count: 1,
  selection_limit: ACCOUNT_IDENTITY_MAX_MESSAGE_SHARDS,
  selection_strategy: 'complete_up_to_hard_limit',
});
assert.ok(completeSmallIdentityScopes.digest, 'publishing every eligible identity shard must preserve complete digest authorization');

const reusedScopes = __discoveryInternals.mirrorSourceScopesForWrite({
  source_scopes: { digest: digestRecord, full: fullRecord },
}, {
  key: 'identity',
  label: '账号身份',
  categories: ['message', 'contact', 'session'],
}, {
  hash: 'identity-hash',
  db_count: 3,
  bytes: 123,
}, '2026-07-30T00:00:00.000Z', 'source_snapshot_unchanged', 'reuse', {
  db_count: 3,
  bytes: 123,
  files: [],
});
assert.ok(reusedScopes.digest && reusedScopes.full, 'an identity check that reuses an already complete mirror must preserve its digest/full authorization');

const sourceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'wx-summary-identity-scope-'));
try {
  await fsp.mkdir(path.join(sourceRoot, 'message'), { recursive: true });
  await fsp.mkdir(path.join(sourceRoot, 'contact'), { recursive: true });
  await fsp.mkdir(path.join(sourceRoot, 'session'), { recursive: true });
  await fsp.writeFile(path.join(sourceRoot, 'contact', 'contact.db'), 'contact');
  await fsp.writeFile(path.join(sourceRoot, 'session', 'session.db'), 'session');
  for (let index = 0; index < 40; index++) {
    const file = path.join(sourceRoot, 'message', `message_${index}.db`);
    await fsp.writeFile(file, 'x'.repeat(index + 1));
    const modified = new Date(Date.UTC(2026, 5, 1 + index));
    await fsp.utimes(file, modified, modified);
  }
  const identityScope = __discoveryInternals.mirrorScopeForReason('identity');
  const snapshot = await __discoveryInternals.collectMirrorSourceSnapshot({ db_storage: sourceRoot }, {
    categories: identityScope.categories,
    scope: identityScope,
  });
  assert.equal(snapshot.eligible_message_count, 40, 'identity snapshot metadata must count all eligible source shards');
  assert.equal(snapshot.selected_message_count, 40, 'identity snapshot must publish every source shard below the hard limit');
  assert.equal(snapshot.dbFiles.filter(file => file.category === 'message').length, 40, 'copy input must contain the complete bounded identity set');
  assert.equal(snapshot.db_count, 42, 'identity snapshot must include contact.db, session.db, and every eligible message shard');
  const confirmed = await __discoveryInternals.confirmMirrorSourceSnapshotStillStable({ db_storage: sourceRoot }, snapshot, {
    scope: identityScope,
  });
  assert.equal(confirmed.hash, snapshot.hash, 'stable identity source selection must reproduce the same snapshot hash');
} finally {
  await fsp.rm(sourceRoot, { recursive: true, force: true });
}

console.log('WXDB identity-scope tests passed');
