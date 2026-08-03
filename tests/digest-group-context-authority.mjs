import assert from 'node:assert/strict';
import { __mainInternals } from '../src/main.js';

const fingerprint = 'a'.repeat(64);
const issuedAt = Date.now();
const incomplete = __mainInternals.rememberDigestGroupContext({
  accountId: 'wxacc_context',
  accountFingerprint: fingerprint,
  groups: [{ id: 'room@chatroom', name: 'Incomplete room' }],
  mirrorReadiness: {
    account_id: 'wxacc_context',
    scope: 'digest',
    source_snapshot_meta_hash: 'b'.repeat(64),
    refreshed_at: new Date(issuedAt).toISOString(),
    stale: false,
    source_busy: false,
    offline: false,
  },
}, issuedAt);
assert.equal(__mainInternals.digestGroupContextMirrorReadinessFromBody({
  group_context: {
    id: incomplete.id,
    account_id: 'wxacc_context',
    fetched_at_ms: incomplete.fetched_at_ms,
  },
}, {
  accountId: 'wxacc_context',
  accountFingerprint: fingerprint,
  now: issuedAt + 1,
}), null, 'a digest snapshot without a published-manifest hash must not seed a batch');

const fresh = __mainInternals.rememberDigestGroupContext({
  accountId: 'wxacc_context',
  accountFingerprint: fingerprint,
  groups: [{ id: 'room@chatroom', name: 'Current room', last_msg_at: 123 }],
  mirrorReadiness: {
    account_id: 'wxacc_context',
    scope: 'digest',
    source_snapshot_meta_hash: 'c'.repeat(64),
    published_manifest_hash: 'e'.repeat(64),
    refreshed_at: new Date(issuedAt).toISOString(),
    stale: false,
    source_busy: false,
    offline: false,
  },
}, issuedAt);

assert.ok(fresh?.id, 'the server must issue an opaque group-context id');
const matchingBody = {
  group_context: {
    id: fresh.id,
    account_id: 'wxacc_context',
    group_id: 'room@chatroom',
    fetched_at_ms: fresh.fetched_at_ms,
  },
};
const resolved = __mainInternals.digestGroupContextFromBody(matchingBody, {
  accountId: 'wxacc_context',
  accountFingerprint: fingerprint,
  groupId: 'room@chatroom',
  now: issuedAt + 1,
});
assert.equal(resolved?.name, 'Current room', 'a matching server-owned context may return the server-observed group');
assert.equal(__mainInternals.digestGroupContextMaySkipRevalidation(resolved), true,
  'only a fresh, non-busy, online server context may skip another group-list read');

const batchReadiness = __mainInternals.digestGroupContextMirrorReadinessFromBody({
  group_context: {
    id: fresh.id,
    account_id: 'wxacc_context',
    fetched_at_ms: fresh.fetched_at_ms,
  },
}, {
  accountId: 'wxacc_context',
  accountFingerprint: fingerprint,
  now: issuedAt + 1,
});
assert.equal(batchReadiness?.scope, 'digest', 'a fresh server-owned digest snapshot may seed the new batch');
assert.equal(batchReadiness?.source_snapshot_meta_hash, 'c'.repeat(64), 'the client must only refer to server-owned mirror evidence by opaque context id');
assert.equal(batchReadiness?.published_manifest_hash, 'e'.repeat(64), 'batch seeding must retain the published mirror generation proof');

const groupsOnly = __mainInternals.rememberDigestGroupContext({
  accountId: 'wxacc_context',
  accountFingerprint: fingerprint,
  groups: [{ id: 'room@chatroom', name: 'Current room' }],
  mirrorReadiness: {
    account_id: 'wxacc_context',
    scope: 'groups',
    source_snapshot_meta_hash: 'd'.repeat(64),
    published_manifest_hash: 'f'.repeat(64),
    refreshed_at: new Date(issuedAt).toISOString(),
    stale: false,
    source_busy: false,
    offline: false,
  },
}, issuedAt + 1);
assert.equal(__mainInternals.digestGroupContextMirrorReadinessFromBody({
  group_context: {
    id: groupsOnly.id,
    account_id: 'wxacc_context',
    fetched_at_ms: groupsOnly.fetched_at_ms,
  },
}, {
  accountId: 'wxacc_context',
  accountFingerprint: fingerprint,
  now: issuedAt + 2,
}), null, 'a groups-only snapshot must not bypass digest-scope mirror preparation');

assert.equal(__mainInternals.digestGroupContextFromBody({
  group_context: {
    account_id: 'wxacc_context',
    group_id: 'room@chatroom',
    fetched_at_ms: issuedAt,
  },
}, {
  accountId: 'wxacc_context',
  accountFingerprint: fingerprint,
  groupId: 'room@chatroom',
  now: issuedAt + 1,
}), null, 'an unsigned legacy object with a client timestamp must never authorize the fast path');

assert.equal(__mainInternals.digestGroupContextFromBody({
  group_context: {
    ...matchingBody.group_context,
    fetched_at_ms: issuedAt + 60_000,
  },
}, {
  accountId: 'wxacc_context',
  accountFingerprint: fingerprint,
  groupId: 'room@chatroom',
  now: issuedAt + 1,
}), null, 'a client-supplied future timestamp must not extend context validity');

assert.equal(__mainInternals.digestGroupContextFromBody(matchingBody, {
  accountId: 'wxacc_context',
  accountFingerprint: 'b'.repeat(64),
  groupId: 'room@chatroom',
  now: issuedAt + 1,
}), null, 'a context from another account fingerprint must be rejected even when the path-derived account id is unchanged');

const stale = __mainInternals.rememberDigestGroupContext({
  accountId: 'wxacc_context',
  accountFingerprint: fingerprint,
  groups: [{ id: 'room@chatroom', name: 'Stale room' }],
  mirrorReadiness: { stale: true, source_busy: true, offline: false },
}, issuedAt + 2);
const staleResolved = __mainInternals.digestGroupContextFromBody({
  group_context: {
    id: stale.id,
    account_id: 'wxacc_context',
    group_id: 'room@chatroom',
    fetched_at_ms: stale.fetched_at_ms,
  },
}, {
  accountId: 'wxacc_context',
  accountFingerprint: fingerprint,
  groupId: 'room@chatroom',
  now: issuedAt + 3,
});
assert.equal(staleResolved?.stale, true);
assert.equal(staleResolved?.source_busy, true);
assert.equal(__mainInternals.digestGroupContextMaySkipRevalidation(staleResolved), false,
  'stale or source-busy group evidence must force server-side revalidation before digest reads');

__mainInternals.cleanupDigestGroupContexts(issuedAt + (6 * 60 * 1000));
assert.equal(__mainInternals.digestGroupContextFromBody(matchingBody, {
  accountId: 'wxacc_context',
  accountFingerprint: fingerprint,
  groupId: 'room@chatroom',
  now: issuedAt + (6 * 60 * 1000),
}), null, 'expired server contexts must not be revived by their original client payload');

console.log('digest group-context authority tests passed');
