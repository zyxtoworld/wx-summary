import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const { __discoveryInternals } = await import('../src/wxenv/discovery.js');
const { __wxdbInternals } = await import('../src/wxdb/index.js');

const capturedAt = '2026-07-24T01:00:00.000Z';
const verifiedSelfWxid = 'wxid_source_busy_fixture';
const verifiedIdentityId = `wxacct_${crypto.createHash('sha256').update(verifiedSelfWxid).digest('hex').slice(0, 24)}`;
const file = (relative, hash) => ({
  kind: 'db',
  relative,
  bytes: 128,
  mtimeMs: 1000,
  ctimeMs: 1000,
  birthtimeMs: 1000,
  dev: 1,
  ino: 1,
  sha256: hash.repeat(64),
});
const account = {
  identity_id: verifiedIdentityId,
  verified_self_wxid: verifiedSelfWxid,
  identity_status: 'verified',
  identity_generation_status: 'verified',
  mirror: {
    identity_id: verifiedIdentityId,
    verified_self_wxid: verifiedSelfWxid,
    identity_status: 'verified',
    identity_generation_status: 'verified',
    source_scopes: {
      groups: {
        refreshed_at: capturedAt,
        source_snapshot_meta_hash: 'a'.repeat(64),
        source_snapshot: {
          target_content_hash_alg: 'sha256',
          files: [file('contact/contact.db', '1'), file('session/session.db', '2')],
        },
      },
      digest: {
        refreshed_at: capturedAt,
        source_snapshot_meta_hash: 'b'.repeat(64),
        source_snapshot: {
          target_content_hash_alg: 'sha256',
          files: [file('message/message_0.db', '3'), file('contact/contact.db', '1'), file('session/session.db', '2')],
        },
      },
    },
  },
};

const groupPolicy = __discoveryInternals.sourceBusyMirrorReusePolicy({
  account,
  scope: { key: 'groups' },
  reason: 'groups',
  identityAnchorCurrent: true,
});
assert.equal(groupPolicy.allowed, true,
  'a normal group-list refresh may use a hash-verified stable mirror when the live WAL never pauses');
assert.equal(groupPolicy.mode, 'verified_group_list',
  'automatic source-busy reuse must stay explicitly scoped to non-authoritative group discovery');
assert.equal(groupPolicy.requested_range_covered, false,
  'group-list fallback must never claim that a message range is complete');

const pathOnlyGroupPolicy = __discoveryInternals.sourceBusyMirrorReusePolicy({
  account,
  scope: { key: 'groups' },
  reason: 'groups',
  identityAnchorCurrent: false,
});
assert.equal(pathOnlyGroupPolicy.allowed, false,
  'the same source path and storage account id must not authorize reuse after the live WeChat account may have switched');

const boundSourcePath = 'C:\\WeChatData\\db_storage';
const boundMirrorIndex = {
  account_id: 'wxacc_0123456789abcdef',
  source_db_storage: boundSourcePath,
  identity_id: verifiedIdentityId,
  verified_self_wxid: verifiedSelfWxid,
  identity_status: 'verified',
  identity_generation_status: 'verified',
  source_generation_hash: 'f'.repeat(64),
  identity_source_generation_hash: 'f'.repeat(64),
  identity_generation_evidence: { type: 'message_identity_proof' },
  identity_evidence: {
    evidence: 'direct_message_sender_across_independent_peers',
    peer_support: 2,
    matched_peer_tables: 2,
    sampled_message_dbs: ['message_0.db'],
  },
  source_scopes: account.mirror.source_scopes,
};
const currentSource = {
  account_id: boundMirrorIndex.account_id,
  db_storage: boundSourcePath,
  wxid: verifiedSelfWxid,
  source_generation_hash: 'f'.repeat(64),
};
const copiedGroupSnapshot = {
  hash: 'd'.repeat(64),
  dbFiles: [],
};
const copiedGroupPayload = {
  target_content_hash_alg: 'sha256',
  files: [file('contact/contact.db', '1'), file('session/session.db', '9')],
};
assert.equal(__discoveryInternals.mirrorSourceBusyIdentityAnchorCurrent(
  boundMirrorIndex,
  currentSource,
  { key: 'groups' },
  copiedGroupSnapshot,
  copiedGroupPayload,
  { source_snapshot_unchanged_categories: ['contact'] },
), true, 'a verified account directory plus unchanged hash-verified contact data may retain identity while session traffic keeps changing');
assert.equal(__discoveryInternals.mirrorSourceBusyIdentityAnchorCurrent(
  boundMirrorIndex,
  currentSource,
  { key: 'groups' },
  { ...copiedGroupSnapshot, hash: 'a'.repeat(64) },
  {
    target_content_hash_alg: 'sha256',
    files: [file('contact/contact.db', '1'), file('session/session.db', '2')],
  },
  { source_snapshot_unchanged_categories: ['contact', 'session'] },
), true, 'the exact verified group-list generation may prove the current identity when the live source stays bound to it');
assert.equal(__discoveryInternals.mirrorSourceBusyIdentityAnchorCurrent(
  boundMirrorIndex,
  currentSource,
  { key: 'groups' },
  copiedGroupSnapshot,
  { ...copiedGroupPayload, files: [file('contact/contact.db', '8'), file('session/session.db', '9')] },
  { source_snapshot_unchanged_categories: ['contact'] },
), false, 'changed contact content must reject a same-path source as a potentially switched account');
assert.equal(__discoveryInternals.mirrorSourceBusyIdentityAnchorCurrent(
  boundMirrorIndex,
  currentSource,
  { key: 'groups' },
  copiedGroupSnapshot,
  copiedGroupPayload,
  { source_snapshot_unchanged_categories: ['session'] },
), false, 'a changing contact source cannot establish the current account identity');
assert.equal(__discoveryInternals.mirrorSourceBusyIdentityAnchorCurrent(
  boundMirrorIndex,
  { ...currentSource, wxid: 'wxid_other_account' },
  { key: 'groups' },
  copiedGroupSnapshot,
  copiedGroupPayload,
  { source_snapshot_unchanged_categories: ['contact'] },
), false, 'unchanged contact files must not retain identity when the source account directory names another wxid');

const sourceSnapshotWithSessionWrite = {
  hash: '7'.repeat(64),
  dbFiles: [
    { ...file('contact/contact.db', '1'), category: 'contact', name: 'contact.db', sidecars: [] },
    { ...file('session/session.db', '9'), category: 'session', name: 'session.db', mtimeMs: 2000, ctimeMs: 2000, sidecars: [] },
  ],
};
assert.equal(__discoveryInternals.mirrorCopyAttemptsForRequest({
  scope: { key: 'groups' },
  sourceBusyReusePurpose: 'groups',
  targetExists: true,
  indexedSnapshot: copiedGroupPayload,
  sourceSnapshot: sourceSnapshotWithSessionWrite,
  identityAnchorCurrent: true,
}), 2, 'session traffic must use the short group-list retry budget when contact identity data is unchanged');
assert.equal(__discoveryInternals.mirrorCopyAttemptsForRequest({
  scope: { key: 'groups' },
  sourceBusyReusePurpose: 'groups',
  targetExists: true,
  indexedSnapshot: copiedGroupPayload,
  sourceSnapshot: {
    ...sourceSnapshotWithSessionWrite,
    dbFiles: sourceSnapshotWithSessionWrite.dbFiles.map(item => item.category === 'contact'
      ? { ...item, mtimeMs: 3000, ctimeMs: 3000 }
      : item),
  },
  identityAnchorCurrent: true,
}), 8, 'a contact change must retain the full retry budget because stale group data cannot prove the current account');

const historicalRangePolicy = __discoveryInternals.sourceBusyMirrorReusePolicy({
  account,
  scope: { key: 'digest' },
  reason: 'digest',
  requiredThroughMs: Date.parse('2026-07-24T00:00:00.000Z'),
});
assert.equal(historicalRangePolicy.allowed, false,
  'mirror capture time cannot prove that later sync did not add an older-timestamped message');
assert.equal(historicalRangePolicy.requested_range_covered, false,
  'source-busy policy must never claim a requested message range is complete from capture time alone');

const explicitStalePolicy = __discoveryInternals.sourceBusyMirrorReusePolicy({
  account,
  scope: { key: 'digest' },
  reason: 'digest',
  allowStaleAccount: true,
  requiredThroughMs: Date.parse('2026-07-24T02:00:00.000Z'),
});
assert.equal(explicitStalePolicy.allowed, false,
  'source-busy digest reads must fail closed even after an explicit stale-account confirmation');
assert.equal(explicitStalePolicy.mode, '');
assert.equal(explicitStalePolicy.requested_range_covered, false);

for (const manifestScope of ['digest', 'full']) {
  const sourceHash = manifestScope === 'digest' ? 'b'.repeat(64) : 'c'.repeat(64);
  const scopeFiles = [file('message/message_0.db', '3'), file('contact/contact.db', '1'), file('session/session.db', '2')];
  const publishedManifest = {
    version: 1,
    target_content_hash_alg: 'sha256',
    files: scopeFiles,
  };
  const publishedManifestHash = __discoveryInternals.mirrorPublishedManifestHash(publishedManifest);
  assert.match(publishedManifestHash, /^[a-f0-9]{64}$/, 'source-busy readiness fixtures must carry a valid complete published generation');
  const scopeRecord = {
    refreshed_at: capturedAt,
    source_snapshot_meta_hash: sourceHash,
    source_snapshot: {
      target_content_hash_alg: 'sha256',
      files: scopeFiles,
    },
  };
  const broadOnlyAccount = {
    account_id: `account-${manifestScope}`,
    identity_id: verifiedIdentityId,
    verified_self_wxid: verifiedSelfWxid,
    identity_status: 'verified',
    identity_generation_status: 'verified',
    mirror: manifestScope === 'full'
      ? {
          identity_id: verifiedIdentityId,
          verified_self_wxid: verifiedSelfWxid,
          identity_status: 'verified',
          identity_generation_status: 'verified',
          published_manifest: publishedManifest,
          published_manifest_hash: publishedManifestHash,
          source_snapshot_meta_hash: sourceHash,
          source_scopes: { full: scopeRecord },
        }
      : {
          identity_id: verifiedIdentityId,
          verified_self_wxid: verifiedSelfWxid,
          identity_status: 'verified',
          identity_generation_status: 'verified',
          published_manifest: publishedManifest,
          published_manifest_hash: publishedManifestHash,
          source_scopes: { digest: scopeRecord },
        },
  };
  const policy = __discoveryInternals.sourceBusyMirrorReusePolicy({
    account: broadOnlyAccount,
    scope: { key: 'groups' },
    reason: 'groups',
    identityAnchorCurrent: true,
  });
  assert.equal(policy.allowed, true, `group discovery may reuse a verified ${manifestScope} manifest when no narrower manifest exists`);
  assert.equal(policy.scope, manifestScope, 'the policy must retain the manifest scope whose hash was verified');

  const token = __discoveryInternals.mirrorReadinessToken({
    accountId: broadOnlyAccount.account_id,
    scope: { key: 'groups' },
    manifestScope: { key: manifestScope },
    sourceSnapshotMetaHash: sourceHash,
    publishedManifestHash,
    refreshedAt: capturedAt,
    stale: true,
    sourceBusy: true,
    sourceBusyReuseMode: 'verified_group_list',
  });
  assert.equal(token.scope, 'groups', 'the exposed scope must authorize only group discovery');
  assert.equal(token.manifest_scope, manifestScope, 'the token must identify the manifest whose hash it carries');
  assert.equal(
    __wxdbInternals.accountMatchesMirrorReadinessToken(broadOnlyAccount, token, 'groups'),
    true,
    `a group-only token backed by ${manifestScope} must validate against that manifest hash`,
  );
  assert.equal(
    __wxdbInternals.accountMatchesMirrorReadinessToken(broadOnlyAccount, token, 'digest'),
    false,
    'a group-only fallback token must never authorize a digest read',
  );
}

console.log('wxdb source-busy fail-closed tests passed');
