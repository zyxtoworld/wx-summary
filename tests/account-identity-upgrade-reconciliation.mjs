import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');

const setAppStateSource = app.slice(
  app.indexOf('function setAppState('),
  app.indexOf('function accountSelectionNeedsStableContextForStateSync('),
);
assert.match(
  setAppStateSource,
  /appStateAccountListSyncDeferred\(\)[\s\S]*?syncAccountsFromAppState\(state\)[\s\S]*?_appAccounts/,
  'app-state polling must retain the last reconciled account list while an identity-sensitive settings operation is pending',
);

const manualValidationSource = app.slice(
  app.indexOf("validateManualKeyButton?.addEventListener('click'"),
  app.indexOf('async function exportSettingsDiagnostics('),
);
const acceptedRefreshIndex = manualValidationSource.indexOf('const accountMeta = await refreshSettingsAccountsAfterWechatChange({');
const visibleStateRefreshIndex = manualValidationSource.indexOf('const stateRefreshWarning = await refreshAppStateForVisibleSettingsAction({');
assert.ok(acceptedRefreshIndex >= 0, 'manual-key validation must reconcile the returned account identity proof');
assert.ok(visibleStateRefreshIndex >= 0, 'manual-key validation must refresh app state after validation');
assert.ok(
  acceptedRefreshIndex < visibleStateRefreshIndex,
  'manual-key validation must apply the accepted identity upgrade before app-state account synchronization',
);
assert.match(
  manualValidationSource.slice(acceptedRefreshIndex, visibleStateRefreshIndex),
  /acceptedIdentityUpgrade:\s*result\?\.account_identity_upgrade \|\| null/,
  'manual-key validation must pass the response-bound identity proof into account reconciliation',
);

console.log('account identity upgrade reconciliation contract passed');
