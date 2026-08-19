import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const fixtureRoot = `outputs/.tmp/main-wxdb-identity-change-group-context-partition-${process.pid}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = fixtureRoot;
process.env.WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR = `${fixtureRoot}/runtime-tmp/wxdb`;

const { __mainInternals: internals } = await import('../src/main.js');

const accountA = 'wxacc_aaaaaaaaaaaaaaaa';
const accountB = 'wxacc_bbbbbbbbbbbbbbbb';
const fingerprintA = 'a'.repeat(64);
const fingerprintB = 'b'.repeat(64);
const readiness = accountId => ({
  account_id: accountId,
  scope: 'groups',
  source_snapshot_meta_hash: 'c'.repeat(64),
  published_manifest_hash: 'd'.repeat(64),
  refreshed_at: '2026-08-18T00:00:00.000Z',
});

try {
  const contextA = internals.rememberDigestGroupContext({
    accountId: accountA,
    accountFingerprint: fingerprintA,
    groups: [{ id: 'group-a', name: 'A' }],
    mirrorReadiness: readiness(accountA),
  }, Date.now());
  const contextB = internals.rememberDigestGroupContext({
    accountId: accountB,
    accountFingerprint: fingerprintB,
    groups: [{ id: 'group-b', name: 'B' }],
    mirrorReadiness: readiness(accountB),
  }, Date.now());
  assert.ok(contextA?.id && contextB?.id, 'the real group-context producer must issue both account-bound contexts');
  const cacheReadiness = accountId => ({
    account_id: accountId,
    scope: 'groups',
    source_snapshot_meta_hash: 'e'.repeat(64),
    published_manifest_hash: 'f'.repeat(64),
    refreshed_at: '2026-08-18T00:01:00.000Z',
  });
  const cacheKeyA = internals.groupListResultCacheKey({
    accountId: accountA,
    accountFingerprint: fingerprintA,
    mirrorReadiness: cacheReadiness(accountA),
  });
  const cacheKeyB = internals.groupListResultCacheKey({
    accountId: accountB,
    accountFingerprint: fingerprintB,
    mirrorReadiness: cacheReadiness(accountB),
  });
  assert.ok(
    internals.rememberGroupListResult(cacheKeyA, [{ id: 'group-a', name: 'A' }], Date.now())
      && internals.rememberGroupListResult(cacheKeyB, [{ id: 'group-b', name: 'B' }], Date.now()),
    'the real group-list producer must record both account-bound cache entries',
  );

  await internals.handleWxDbMirrorIdentityChanged({
    storage_id: accountA,
    previous_identity_id: `wxacct_${'1'.repeat(24)}`,
    identity_id: `wxacct_${'2'.repeat(24)}`,
    identity_switched: true,
  });

  assert.equal(
    internals.digestGroupContextFromBody({
      group_context: {
        context_id: contextA.id,
        account_id: accountA,
        fetched_at_ms: contextA.fetched_at_ms,
        group_id: 'group-a',
      },
    }, { accountId: accountA, accountFingerprint: fingerprintA, groupId: 'group-a' }),
    null,
    'an identity change for account A must invalidate account A group context',
  );
  assert.ok(
    internals.digestGroupContextFromBody({
      group_context: {
        context_id: contextB.id,
        account_id: accountB,
        fetched_at_ms: contextB.fetched_at_ms,
        group_id: 'group-b',
      },
    }, { accountId: accountB, accountFingerprint: fingerprintB, groupId: 'group-b' }),
    'an identity change for account A must retain account B group context',
  );
  assert.equal(
    internals.cachedGroupListResult(cacheKeyA),
    null,
    'an identity change for account A must invalidate account A group-list cache',
  );
  assert.deepEqual(
    internals.cachedGroupListResult(cacheKeyB),
    [{ id: 'group-b', name: 'B' }],
    'an identity change for account A must retain account B group-list cache',
  );
} finally {
  await fsp.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
}

console.log('main wxdb identity-change group-context partition tests passed');
