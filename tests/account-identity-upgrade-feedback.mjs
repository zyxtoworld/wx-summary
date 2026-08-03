import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');

assert.match(
  app,
  /function accountIdentityUpgradeStatusSuffix\(meta = \{\}\)[\s\S]*?meta\?\.identityUpgraded[\s\S]*?右上角账号和账号级设置已同步更新/,
  'verified account identity upgrades must have one shared, explicit user-facing status message',
);

assert.match(
  app,
  /const accountMeta = await withSettingsPostSaveReconcile[\s\S]*?const accountIdentitySuffix = accountIdentityUpgradeStatusSuffix\(accountMeta\)[\s\S]*?successText \+= accountIdentitySuffix/,
  'saving privacy/manual-key settings must report a verified account identity upgrade',
);

assert.match(
  app,
  /const accountMeta = await refreshSettingsAccountsAfterWechatChange[\s\S]*?const accountIdentitySuffix = accountIdentityUpgradeStatusSuffix\(accountMeta\)[\s\S]*?pendingValidatedManualDraft/,
  'manual-key validation must report a verified account identity upgrade before any follow-up save',
);

assert.match(
  app,
  /const accountIdentityMeta = await refreshSetupAccountIdentityUpgrade\(result, \{ signal \}\)[\s\S]*?_account_identity_upgrade_meta: accountIdentityMeta/,
  'setup validation must retain the verified account identity upgrade for the visible completion status',
);

assert.match(
  app,
  /let manualKeyValidation = null[\s\S]*?manualKeyValidation = await withSetupValidation[\s\S]*?accountIdentityUpgradeStatusSuffix\(manualKeyValidation\?\._account_identity_upgrade_meta\)/,
  'setup pre-save validation must surface the account identity upgrade before the durable save begins',
);

console.log('account identity upgrade feedback contract passed');
