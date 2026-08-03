import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const appSource = fs.readFileSync(path.join(projectRoot, 'src', 'web', 'public', 'js', 'app.js'), 'utf8');

const accountContextSource = appSource.slice(
  appSource.indexOf('function accountFingerprintForValue'),
  appSource.indexOf('function accountFingerprintMissingMessage'),
);
const settingsSaveSource = appSource.slice(
  appSource.indexOf('async function withSettingsSaveRequest'),
  appSource.indexOf('async function withSettingsPostSaveReconcile'),
);
const setupSaveSource = appSource.slice(
  appSource.indexOf('async function withSetupSaveRequest'),
  appSource.indexOf('async function withSetupPostSaveReconcile'),
);

assert.ok(accountContextSource.includes('function accountRequestContextSnapshot'), 'account-scoped writes should capture one reusable account identity snapshot');
assert.ok(accountContextSource.includes('function accountRequestContextStillCurrent'), 'account-scoped writes should compare the response against the captured identity snapshot');
assert.ok(accountContextSource.includes("/^[a-f0-9]{64}$/.test(requestFingerprint)"), 'an account-scoped response must not apply without a verified request fingerprint');
assert.ok(accountContextSource.includes('requestFingerprint === currentFingerprint'), 'the current database identity must exactly match the request identity');

assert.ok(settingsSaveSource.includes('accountRequestContextSnapshot(currentSettingsRequestAccountId())'), 'settings saves should capture the selected account fingerprint before starting');
assert.ok(settingsSaveSource.includes('accountRequestContextStillCurrent(requestAccountContext)'), 'settings saves should reject a same-ID response after the database identity changes');
assert.ok(settingsSaveSource.includes('throw settingsSaveResponseDetachedError(label, requestAccountContext)'), 'settings saves should stop caller-side form mutation after a detached response');

assert.ok(setupSaveSource.includes('accountRequestContextSnapshot(currentSetupRequestAccountId())'), 'setup saves should capture the selected account fingerprint before starting');
assert.ok(setupSaveSource.includes('accountRequestContextStillCurrent(requestAccountContext)'), 'setup saves should reject a same-ID response after the database identity changes');
assert.ok(setupSaveSource.includes('throw settingsSaveResponseDetachedError(label, requestAccountContext)'), 'setup saves should stop wizard state mutation after a detached response');

assert.ok(appSource.includes("code = 'settings_save_response_context_changed'"), 'detached successful saves should use a stable error code');
assert.ok(appSource.includes('if (settingsSaveResponseDetached(error) && statusEl)'), 'settings UIs should render detached successful saves as a warning instead of a failed write');

console.log('settings save account context contract passed');
