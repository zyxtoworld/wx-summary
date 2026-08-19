import assert from 'node:assert/strict';

process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = `outputs/.tmp/wxdb-sender-hydration-cache-owner-${process.pid}`;
process.env.WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR = `${process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR}/runtime-tmp/wxdb`;

const { __wxdbInternals } = await import('../src/wxdb/index.js');

const baseAccount = {
  account_id: 'wxacc_aaaaaaaaaaaaaaaa',
  identity_id: 'wxacct_aaaaaaaaaaaaaaaaaaaaaaaa',
  source_generation_hash: 'a'.repeat(64),
  identity_source_generation_hash: 'b'.repeat(64),
  db_storage: 'C:\\wx-summary-fixture\\wxacc_aaaaaaaaaaaaaaaa\\db',
  mirror: {
    identity_id: 'wxacct_aaaaaaaaaaaaaaaaaaaaaaaa',
    source_generation_hash: 'a'.repeat(64),
    identity_source_generation_hash: 'b'.repeat(64),
    source_snapshot_hash: 'same-snapshot',
    source_snapshot_meta_hash: 'c'.repeat(64),
    published_manifest_hash: 'd'.repeat(64),
    refreshed_at: '2026-08-18T00:00:00.000Z',
  },
};

const baseScope = __wxdbInternals.senderHydrationFailureCacheScope(baseAccount);
assert.notEqual(
  baseScope,
  __wxdbInternals.senderHydrationFailureCacheScope({
    ...baseAccount,
    identity_id: 'wxacct_' + 'e'.repeat(24),
    mirror: { ...baseAccount.mirror, identity_id: 'wxacct_' + 'e'.repeat(24) },
  }),
  'a same-path account identity change must not reuse a sender-hydration failure',
);
assert.notEqual(
  baseScope,
  __wxdbInternals.senderHydrationFailureCacheScope({
    ...baseAccount,
    source_generation_hash: 'e'.repeat(64),
    mirror: { ...baseAccount.mirror, source_generation_hash: 'e'.repeat(64) },
  }),
  'a changed source generation must not reuse a sender-hydration failure',
);
assert.notEqual(
  baseScope,
  __wxdbInternals.senderHydrationFailureCacheScope({
    ...baseAccount,
    mirror: { ...baseAccount.mirror, source_snapshot_meta_hash: 'e'.repeat(64) },
  }),
  'a changed mirror metadata snapshot must not reuse a sender-hydration failure when a legacy hash is also present',
);
assert.notEqual(
  baseScope,
  __wxdbInternals.senderHydrationFailureCacheScope({
    ...baseAccount,
    mirror: { ...baseAccount.mirror, published_manifest_hash: 'e'.repeat(64) },
  }),
  'a changed published mirror manifest must not reuse a sender-hydration failure',
);

console.log('wxdb sender-hydration cache owner tests passed');
