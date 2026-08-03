import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { __discoveryInternals } from '../src/wxenv/discovery.js';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wx-summary-account-discovery-'));
const sourceRoot = path.join(root, 'source');
const aliasRoot = path.join(root, 'source-alias');
const accountName = 'wxid_discovery_test_abcd';
const dbStorage = path.join(sourceRoot, 'xwechat_files', accountName, 'db_storage');

try {
  await fsp.mkdir(dbStorage, { recursive: true });

  const dataRootDiscovery = await __discoveryInternals.discoverDataRootsFromCandidates([
    sourceRoot,
    `${root}\0unreadable-root`,
  ]);
  assert.deepEqual(dataRootDiscovery.roots, [sourceRoot], 'data-root discovery must preserve readable roots');
  assert.equal(dataRootDiscovery.unreadable.length, 1, 'data-root discovery must preserve partial unreadable roots');
  assert.equal(dataRootDiscovery.unreadable[0].scope, 'root');

  const configuredRoots = await __discoveryInternals.readWindowsConfiguredDataRootEntries([
    { name: 'good.ini', isFile: () => true },
    { name: 'unreadable.ini', isFile: () => true },
  ], {
    config_dir: root,
    read_file: async file => {
      if (path.basename(file) === 'unreadable.ini') {
        throw Object.assign(new Error('fixture config unreadable'), { code: 'EACCES' });
      }
      return `${sourceRoot}\n`;
    },
  });
  assert.deepEqual(configuredRoots.roots, [sourceRoot], 'one unreadable ini must not discard roots parsed from other ini files');
  assert.equal(configuredRoots.unreadable.length, 1, 'the unreadable ini diagnostic must survive beside successful roots');
  assert.equal(configuredRoots.unreadable[0].scope, 'configuration_file');
  assert.equal(
    __discoveryInternals.sourceDiscoveryIssueMatchesMirror(
      configuredRoots.unreadable[0],
      'wxacc_0123456789abcdef',
      { source_db_storage: path.join(sourceRoot, 'xwechat_files', accountName, 'db_storage') },
      'wxacc_0123456789abcdef',
    ),
    true,
    'an unreadable configuration file must mark otherwise-unresolved account discovery as incomplete instead of proving the source account missing',
  );

  const accounts = await __discoveryInternals.sourceWxAccountsFromDataRoots([
    sourceRoot,
    `${root}\0unreadable`,
  ]);
  assert.equal(accounts.length, 1, 'an unreadable unrelated data root must not discard a readable account');
  assert.equal(accounts[0].legacy_id, accountName);

  const discovery = await __discoveryInternals.sourceWxAccountDiscoveryFromDataRoots([
    sourceRoot,
    `${root}\0unreadable`,
  ]);
  assert.equal(discovery.accounts.length, 1, 'structured discovery must preserve readable accounts');
  assert.equal(discovery.unreadable.length, 1, 'structured discovery must preserve partial unreadable diagnostics');
  assert.equal(discovery.unreadable[0].scope, 'root');

  const unreadableAccountName = 'wxid_discovery_unreadable_abcd';
  const unreadableDbStorage = path.join(sourceRoot, 'xwechat_files', unreadableAccountName, 'db_storage');
  const unreadableError = Object.assign(new Error('fixture source directory unreadable'), {
    code: 'wxdb_source_directory_unreadable',
    public_code: 'wxdb_source_directory_unreadable',
  });
  const unreadableIssue = {
    scope: 'account',
    data_root: sourceRoot,
    xwechat_files: path.join(sourceRoot, 'xwechat_files'),
    account_name: unreadableAccountName,
    account_root: path.dirname(unreadableDbStorage),
    db_storage: unreadableDbStorage,
    account_id: __discoveryInternals.unreadableSourceAccountId(unreadableDbStorage),
    error: unreadableError,
  };
  const unreadableResolution = await __discoveryInternals.safeMirrorSourceAccountResolution(
    [],
    unreadableIssue.account_id,
    {
      legacy_id: unreadableAccountName,
      source_db_storage: unreadableDbStorage,
    },
    { unreadable: [unreadableIssue] },
  );
  assert.equal(unreadableResolution.status, 'unreadable', 'a matching unreadable account must not be mislabeled as missing');
  assert.equal(unreadableResolution.error, unreadableError);
  assert.equal(
    __discoveryInternals.sourceDiscoveryErrorForMirrorRequest(
      [unreadableIssue],
      unreadableIssue.account_id,
      {
        accounts: {
          [unreadableIssue.account_id]: {
            legacy_id: unreadableAccountName,
            source_db_storage: unreadableDbStorage,
          },
        },
      },
    ),
    unreadableError,
    'generation must recover the selected account unreadable error from the mirror index instead of returning account missing',
  );

  const unrelatedResolution = await __discoveryInternals.safeMirrorSourceAccountResolution(
    [],
    'wxacc_ffffffffffffffff',
    {
      legacy_id: 'wxid_discovery_missing_abcd',
      source_db_storage: path.join(sourceRoot, 'xwechat_files', 'wxid_discovery_missing_abcd', 'db_storage'),
    },
    { unreadable: [unreadableIssue] },
  );
  assert.equal(unrelatedResolution.status, 'missing', 'an unreadable account must not contaminate unrelated missing accounts');
  assert.equal(
    __discoveryInternals.sourceDiscoveryErrorForMirrorRequest(
      [unreadableIssue],
      'wxacc_ffffffffffffffff',
      {
        accounts: {
          wxacc_ffffffffffffffff: {
            legacy_id: 'wxid_discovery_missing_abcd',
            source_db_storage: path.join(sourceRoot, 'xwechat_files', 'wxid_discovery_missing_abcd', 'db_storage'),
          },
        },
      },
    ),
    null,
    'generation must not reuse an unrelated account unreadable error',
  );

  const sameNameOtherRoot = path.join(root, 'other-source');
  const sameNameOtherDbStorage = path.join(sameNameOtherRoot, 'xwechat_files', unreadableAccountName, 'db_storage');
  const sameNameOtherIssue = {
    ...unreadableIssue,
    data_root: sameNameOtherRoot,
    xwechat_files: path.join(sameNameOtherRoot, 'xwechat_files'),
    account_root: path.dirname(sameNameOtherDbStorage),
    db_storage: sameNameOtherDbStorage,
    account_id: __discoveryInternals.unreadableSourceAccountId(sameNameOtherDbStorage),
  };
  assert.equal(
    __discoveryInternals.sourceDiscoveryIssueMatchesMirror(
      sameNameOtherIssue,
      unreadableIssue.account_id,
      {
        legacy_id: unreadableAccountName,
        source_db_storage: unreadableDbStorage,
      },
      unreadableIssue.account_id,
    ),
    false,
    'the same account directory name under another data root must not override a contradictory physical path',
  );

  assert.equal(
    __discoveryInternals.sourceDiscoveryErrorForRequestedAccount(
      { accounts: [], unreadable: [unreadableIssue] },
      'wxacc_ffffffffffffffff',
      {
        accounts: {
          wxacc_ffffffffffffffff: {
            legacy_id: 'wxid_discovery_missing_abcd',
            source_db_storage: path.join(sourceRoot, 'xwechat_files', 'wxid_discovery_missing_abcd', 'db_storage'),
          },
        },
      },
    ),
    null,
    'zero readable accounts must not spread another account unreadable error to the selected missing account',
  );

  const unreadableAccounts = __discoveryInternals.unreadableSourceAccountsFromDiscovery([unreadableIssue]);
  assert.equal(unreadableAccounts.length, 1, 'an unreadable account without a project mirror must remain visible in account discovery');
  assert.equal(unreadableAccounts[0].account_id, unreadableIssue.account_id);
  assert.equal(unreadableAccounts[0].source, 'source-unreadable');
  assert.equal(unreadableAccounts[0].source_status, 'unreadable');

  await fsp.symlink(sourceRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const aliasedAccounts = await __discoveryInternals.sourceWxAccountsFromDataRoots([aliasRoot]);
  assert.equal(aliasedAccounts.length, 1);
  const realDbStorage = await fsp.realpath(dbStorage);
  assert.equal(
    aliasedAccounts[0].account_id,
    __discoveryInternals.accountOpaqueId(realDbStorage),
    'a new account id must be derived from the physical db_storage path, not a junction or symlink alias',
  );

  const oldMirrorId = 'wxacc_0123456789abcdef';
  const rebound = await __discoveryInternals.uniqueMirrorSourceAccount(aliasedAccounts, oldMirrorId, {
    source_db_storage: dbStorage,
  });
  assert.equal(rebound, aliasedAccounts[0], 'physical source selection must preserve the discovered source object and identity');
  const reboundResolution = __discoveryInternals.mirrorSourceAccountResolution(rebound, oldMirrorId);
  assert.equal(
    reboundResolution.storage_account_id,
    oldMirrorId,
    'refreshing an existing mirror through a path alias must retain its separate storage account id',
  );
  assert.equal(reboundResolution.source.account_id, aliasedAccounts[0].account_id, 'retaining the mirror id must not overwrite the canonical source identity');
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}

console.log('WXDB account discovery isolation tests passed');
