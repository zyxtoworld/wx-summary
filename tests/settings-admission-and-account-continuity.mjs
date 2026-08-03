import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const settingsModule = await import('../src/config/settings.js');
const appSource = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const mainSource = await fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8');

const releaseWrite = settingsModule.beginSettingsWriteRequest();
let settledReadStarted = false;
const settledRead = settingsModule.withSettledSettingsWrites(async () => {
  settledReadStarted = true;
  return 'settled';
});
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(settledReadStarted, false, 'a recovery read must wait for a settings request that has started but not entered the save queue');
releaseWrite();
assert.equal(await settledRead, 'settled');

const settingsGetRoute = mainSource.slice(
  mainSource.indexOf("if (pathname === '/api/settings' && req.method === 'GET')"),
  mainSource.indexOf("if (pathname === '/api/settings' && (req.method === 'PUT' || req.method === 'POST'))"),
);
const settingsWriteRoute = mainSource.slice(
  mainSource.indexOf("if (pathname === '/api/settings' && (req.method === 'PUT' || req.method === 'POST'))"),
  mainSource.indexOf("if (pathname === '/api/scheduler/status'"),
);
const wechatStatusRoute = mainSource.slice(
  mainSource.indexOf("if (pathname === '/api/wechat/status' && req.method === 'POST')"),
  mainSource.indexOf("if (pathname === '/api/scheduler/status'", mainSource.indexOf("if (pathname === '/api/wechat/status' && req.method === 'POST')")),
);
assert.match(settingsGetRoute, /withSettledSettingsWrites\(\(\) => publicSettings\(\)\)/, 'wait_for_writes must use the request-admission and save-queue barrier');
assert.match(settingsWriteRoute, /const finishSettingsWriteRequest = beginSettingsWriteRequest\(\)[\s\S]*?finally \{[\s\S]*?finishSettingsWriteRequest\(\)/, 'settings writes must register before request parsing and unregister in finally');
assert.match(wechatStatusRoute, /const finishSettingsWriteRequest = beginSettingsWriteRequest\(\)[\s\S]*?finally \{[\s\S]*?finishSettingsWriteRequest\(\)/, 'manual-key validation requests that may persist verification must join the same admission barrier');

const accountOptionSource = appSource.slice(
  appSource.indexOf('function renderAccountOptions('),
  appSource.indexOf('function accountFreshnessLabel('),
);
assert.match(accountOptionSource, /preserveEmptySelection = false/, 'account rendering needs an explicit empty-selection preservation mode');
assert.match(accountOptionSource, /needsExplicitChoice[\s\S]*?preserveEmptySelection/, 'a bound empty selector must keep a visible placeholder even when the refreshed list has one account');
assert.match(accountOptionSource, /orderedAccounts\.length === 1 && !preserveEmptySelection/, 'refresh must not silently acquire the only account for an already-bound empty selector');
assert.match(appSource, /const preserveEmptySelection = sel\.dataset\.bound === '1' && !previousValue/, 'account refreshes must preserve a user-visible empty selection after the selector is bound');

const recoverySource = appSource.slice(
  appSource.indexOf('function reconcileUnknownSettingsMutation('),
  appSource.indexOf('function reloadRequiredErrorMessage('),
);
assert.doesNotMatch(recoverySource, /refreshAppStateSilently\([\s\S]*?\.catch\(\(\) => null\)/, 'recovery must not swallow the final app-state refresh failure');
assert.match(recoverySource, /if \(!nextState\)[\s\S]*?throw/, 'an empty final app-state response must keep the recovery marker and retry');
assert.ok(
  recoverySource.indexOf('if (!nextState)') < recoverySource.indexOf('clearPendingSettingsMutationRecords()'),
  'recovery markers may be cleared only after the final app state is confirmed',
);

const privacySaveSource = appSource.slice(
  appSource.indexOf("savePrivacyButton.addEventListener('click'"),
  appSource.indexOf("validateManualKeyButton?.addEventListener('click'"),
);
assert.doesNotMatch(privacySaveSource, /clearDigestGroupCache\('手动密钥设置已变化'\);\s*void refreshAppStateSilently\(\)/, 'manual-key save must not start an unproved app-state refresh in parallel with identity-upgrade reconciliation');
assert.match(privacySaveSource, /refreshSettingsAccountsAfterWechatChange\([\s\S]*?acceptedIdentityUpgrade[\s\S]*?refreshAppStateForVisibleSettingsAction/, 'manual-key save must apply the accepted identity upgrade before refreshing app state');

const setupValidationSource = appSource.slice(
  appSource.indexOf('async function withSetupPostSaveReconcile('),
  appSource.indexOf('const existingWhitelistRefs'),
);
assert.match(setupValidationSource, /async function withSetupValidation[\s\S]*?settings_validation/, 'setup pre-save validation needs a non-commit pending state');
assert.match(appSource, /manualKeyValidation = await withSetupValidation\(/, 'temporary manual-key validation must not use the post-save reconcile wrapper');

console.log('settings admission and account continuity tests passed');
