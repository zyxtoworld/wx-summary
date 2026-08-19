import assert from 'node:assert/strict';
import fs from 'node:fs';
import { __collectorInternals } from '../src/collector/index.js';
import { __schedulerInternals } from '../src/daemon/scheduler.js';
import { __wxdbInternals } from '../src/wxdb/index.js';

const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

const mirrorError = { code: 'wxdb_temp_copy_wal_invalid', error: 'WAL 临时读取失败' };
const keyError = { code: 'SQLITE_AUTH', error: 'page hmac mismatch' };
const otherError = { code: 'wxdb_unknown_reader_failure', error: 'unexpected reader state' };

assert.equal(__wxdbInternals.shardOpenFailureCause([mirrorError, keyError]), 'mixed');
assert.equal(__wxdbInternals.shardOpenFailureCause([keyError, mirrorError]), 'mixed', 'mixed classification must be order-independent');
assert.equal(__wxdbInternals.shardOpenFailureCause([keyError, otherError]), 'mixed');
assert.equal(__wxdbInternals.shardOpenFailureCause([keyError, keyError]), 'key');
assert.equal(__wxdbInternals.shardOpenFailureCause([mirrorError, mirrorError]), 'mirror');

const mixedFailure = {
  code: 'wxdb_partial_shards_unreadable',
  public_code: 'wxdb_partial_shards_unreadable',
  wxdb_diagnostics: {
    shard_open_failure_cause: 'mixed',
    error_category_counts: { mirror: 1, key: 1 },
    key_scan_summary: { shard_count: 1, initial_candidate_count_max: 2 },
    sample_errors: [mirrorError, keyError],
  },
};

assert.equal(__collectorInternals.isDbKeyFailure(mixedFailure), false, 'mixed failures must not enter pure key recovery');
assert.equal(__schedulerInternals.schedulerErrorLooksAutoKeyFailure(mixedFailure), false, 'mixed failures must not create scheduler key-failure cooldown');

assert.match(
  main,
  /function shouldRecoverDigestMirrorShardFailure[\s\S]*?error_category_counts[\s\S]*?mirror[^\n]*> 0/,
  'a mixed failure containing a mirror error must get one mirror rebuild before being reclassified',
);

console.log('mixed wxdb shard failure classification passed');
