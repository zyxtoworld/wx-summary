import assert from 'node:assert/strict';
import { __collectorInternals } from '../src/collector/index.js';
import { __mainInternals } from '../src/main.js';
import { __wxdbInternals } from '../src/wxdb/index.js';

const unreadableAccount = {
  account_id: 'wxacc_0123456789abcdef',
  id: 'wxacc_0123456789abcdef',
  source: 'project-mirror',
  db_storage: 'unused-by-status-guard',
  mirror: {
    source_available: false,
    source_status: 'unreadable',
  },
};

const unreadableSourceAccount = {
  account_id: 'wxacc_fedcba9876543210',
  id: 'wxacc_fedcba9876543210',
  source: 'source-unreadable',
  source_available: false,
  source_status: 'unreadable',
};

const collectorAccount = __collectorInternals.accountListProjection(unreadableSourceAccount, { message: 'fixture' });
assert.equal(collectorAccount.source_available, false, 'collector account projection must preserve unreadable availability');
assert.equal(collectorAccount.source_status, 'unreadable', 'collector account projection must preserve unreadable status');
const publicAccount = __mainInternals.publicAccount(collectorAccount);
assert.equal(publicAccount.source_available, false, 'API account projection must not restore unreadable accounts to available');
assert.equal(publicAccount.source_status, 'unreadable');

assert.equal(
  __mainInternals.publicWeixinDataMode({ accounts: [unreadableAccount] }),
  'mirror_source_unreadable',
  'top-level state must distinguish an unreadable source directory from a missing source account',
);

assert.equal(
  __mainInternals.publicWeixinDataMode({ accounts: [unreadableSourceAccount] }),
  'mirror_source_unreadable',
  'an unreadable source account without a project mirror must not be counted as readable wxdb data',
);

await assert.rejects(
  () => __wxdbInternals.assertProjectMirrorAccount(unreadableAccount),
  error => error?.code === 'wxdb_source_directory_unreadable'
    && /暂时不可读/.test(String(error?.message || '')),
  'direct project-mirror reads must preserve the unreadable source status instead of returning account missing',
);

await assert.rejects(
  () => __wxdbInternals.assertProjectMirrorAccount(unreadableSourceAccount),
  error => error?.code === 'wxdb_source_directory_unreadable',
  'an unreadable source account without a project mirror must fail as unreadable rather than mirror-required or missing',
);

console.log('WXDB source unreadable status contract tests passed');
