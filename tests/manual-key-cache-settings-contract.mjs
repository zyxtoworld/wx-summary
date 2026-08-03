import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const main = await fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const settingsRoute = main.slice(
  main.indexOf("if (pathname === '/api/settings' && (req.method === 'PUT' || req.method === 'POST'))"),
  main.indexOf("if (pathname === '/api/settings/export'"),
);
const cachePreparation = main.slice(
  main.indexOf('async function prepareManualKeyCachesForSettingsTransaction'),
  main.indexOf('function pauseLegacySchedulerDuringSetupPatch'),
);

assert.match(
  main,
  /createVerifiedWxdbKeyCacheRevocationTransaction/,
  'the settings route must use the encrypted-cache revocation transaction instead of deleting cache state before settings CAS checks',
);
assert.match(
  cachePreparation,
  /settingsPatchClearsOrphanedManualKey\(body\)[\s\S]*?return \{ required: false, reason: 'orphaned_manual_key'[^}]*\}/,
  'clearing an unused orphaned manual candidate must not invalidate or delete independently verified automatic cache state',
);
assert.match(
  settingsRoute,
  /prepareManualKeyCachesForSettingsTransaction\([\s\S]*?withSettingsSaveTransaction/,
  'runtime key generations must be invalidated before the settings transaction admits a manual-key mutation',
);
assert.match(
  settingsRoute,
  /createManualKeyCacheStorageTransaction\([\s\S]*?storage_transaction:\s*keyCacheStorageTransaction/,
  'persistent cache revocation must participate in the exact settings storage transaction',
);
assert.doesNotMatch(
  settingsRoute.slice(0, settingsRoute.indexOf('withSettingsSaveTransaction')),
  /forgetVerifiedWxdbKeysForAccount|clearVerifiedWxdbKeyCache/,
  'the settings route must not destructively change persistent cache state before its final revision and account checks',
);
assert.doesNotMatch(
  cachePreparation,
  /forgetVerifiedWxdbKeysForAccount|clearVerifiedWxdbKeyCache/,
  'pre-transaction preparation may only invalidate runtime generations and wait for active reads',
);

console.log('manual key cache settings contract tests passed');
