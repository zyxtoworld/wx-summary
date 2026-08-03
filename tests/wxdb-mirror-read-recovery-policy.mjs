import assert from 'node:assert/strict';

import { __wxdbInternals } from '../src/wxdb/index.js';

const manifestChanged = Object.assign(new Error('manifest changed'), {
  code: 'wxdb_mirror_manifest_changed',
});
const readinessChanged = Object.assign(new Error('snapshot changed'), {
  code: 'wxdb_mirror_readiness_changed',
});

assert.equal(
  __wxdbInternals.mirrorReadRecoveryAction(readinessChanged, 0),
  'propagate',
  'a legitimate published-snapshot race must escape to the caller instead of rebuilding the project mirror',
);
assert.equal(
  __wxdbInternals.mirrorReadRecoveryAction(manifestChanged, 0),
  'rebuild',
  'manifest corruption should trigger exactly one forced project-mirror rebuild',
);
assert.equal(
  __wxdbInternals.mirrorReadRecoveryAction(manifestChanged, 1),
  'fail_repair',
  'a second manifest mismatch after rebuilding must fail closed',
);
assert.equal(
  __wxdbInternals.mirrorReadRecoveryAction(Object.assign(new Error('key'), { code: 'db_key_invalid' }), 0),
  'propagate',
  'unrelated database errors must not trigger mirror replacement',
);

const account = (snapshotHash, manifestHash) => ({
  account_id: 'wxacc_0123456789abcdef',
  mirror: {
    published_manifest_hash: manifestHash,
    source_scopes: {
      groups: {
        source_snapshot_meta_hash: snapshotHash,
      },
    },
  },
});
const originalToken = {
  account_id: 'wxacc_0123456789abcdef',
  scope: 'groups',
  manifest_scope: 'groups',
  source_snapshot_meta_hash: 'a'.repeat(64),
  published_manifest_hash: '1'.repeat(64),
};

assert.equal(
  __wxdbInternals.accountMatchesMirrorReadinessToken(
    account('a'.repeat(64), '2'.repeat(64)),
    originalToken,
    'groups',
  ),
  false,
  'the ordinary read guard must still reject a changed published manifest identity',
);
assert.equal(
  __wxdbInternals.accountMatchesMirrorSourceSnapshotToken(
    account('a'.repeat(64), '2'.repeat(64)),
    originalToken,
    'groups',
  ),
  true,
  'a forced repair may publish new file identities when the account and source snapshot are unchanged',
);
assert.equal(
  __wxdbInternals.accountMatchesMirrorSourceSnapshotToken(
    account('b'.repeat(64), '2'.repeat(64)),
    originalToken,
    'groups',
  ),
  false,
  'a forced repair must not silently cross into a different source snapshot',
);

console.log('wxdb mirror read recovery policy tests passed');
