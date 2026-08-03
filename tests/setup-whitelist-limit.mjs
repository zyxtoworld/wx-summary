import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const appSource = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');

const addSetupWhitelistSource = appSource.match(
  /function addSetupWhitelistGroup\([\s\S]*?\n  }\n  function setupSkipWhitelistMessage/,
)?.[0] || '';

assert.match(
  addSetupWhitelistSource,
  /settingsCollectionLimit\('group_whitelist_refs',[\s\S]*?setupWhitelistHasGroup[\s\S]*?wizardData\.whitelist\.size >= limit[\s\S]*?return false;[\s\S]*?removeSetupWhitelistGroup/,
  'setup whitelist additions must reject overflow before mutating the draft',
);
assert.match(
  appSource,
  /const added = addSetupWhitelistGroup\(group,[\s\S]*?if \(!added\)[\s\S]*?input\.checked = false;[\s\S]*?showSetupWhitelistLimitWarning/,
  'a rejected checkbox selection must be reverted immediately and explain the limit',
);
assert.match(
  appSource,
  /let setupWhitelistRejectedCount = 0;[\s\S]*?setupWhitelistRejectedCount \+= 1;[\s\S]*?showSetupWhitelistLimitWarning\([\s\S]*?setupWhitelistRejectedCount/,
  'bulk selection must report how many visible groups could not be selected',
);
assert.match(
  appSource,
  /白名单总计 \$\{wizardData\.whitelist\.size\}\/\$\{whitelistLimit\} 条/,
  'the setup count must expose current capacity before save',
);

console.log('setup whitelist limit tests passed');
