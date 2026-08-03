import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const appSource = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');

const stateHelperStart = appSource.indexOf('function setupPersistedManualKeyNeedsVerificationState(');
assert.ok(stateHelperStart >= 0, 'setup must define one pure persisted-manual-key verification predicate');
const stateHelperEnd = appSource.indexOf('\n}', stateHelperStart);
assert.ok(stateHelperEnd > stateHelperStart, 'setup persisted-manual-key predicate must have a bounded function body');
const stateHelperSource = appSource.slice(stateHelperStart, stateHelperEnd + 2);
const needsVerification = Function(`${stateHelperSource}; return setupPersistedManualKeyNeedsVerificationState;`)();

const cases = [
  [{ saved: false, verified: false, auto: false, recovery: false, manual: true }, false],
  [{ saved: true, verified: true, auto: false, recovery: true, manual: true }, false],
  [{ saved: true, verified: false, auto: false, recovery: false, manual: false }, true],
  [{ saved: true, verified: false, auto: true, recovery: true, manual: false }, true],
  [{ saved: true, verified: false, auto: true, recovery: false, manual: true }, true],
  [{ saved: true, verified: false, auto: true, recovery: false, manual: false }, false],
];
for (const [input, expected] of cases) {
  assert.equal(
    needsVerification(input.saved, input.verified, input.auto, input.recovery, input.manual),
    expected,
    `persisted manual-key verification predicate mismatch for ${JSON.stringify(input)}`,
  );
}

const missingHelperStart = appSource.indexOf('function setupManualKeyCandidateMissingState(');
assert.ok(missingHelperStart >= 0, 'setup must define one pure missing-manual-key predicate');
const missingHelperEnd = appSource.indexOf('\n}', missingHelperStart);
assert.ok(missingHelperEnd > missingHelperStart, 'setup missing-manual-key predicate must have a bounded function body');
const missingHelperSource = appSource.slice(missingHelperStart, missingHelperEnd + 2);
const candidateMissing = Function(`${missingHelperSource}; return setupManualKeyCandidateMissingState;`)();
assert.equal(candidateMissing(true, false, false), true, 'required setup with no saved or legacy candidate must stop');
assert.equal(candidateMissing(true, true, false), false, 'a saved candidate must proceed to validation');
assert.equal(candidateMissing(true, false, true), false, 'a legacy candidate must proceed to validation and binding');
assert.equal(candidateMissing(false, false, false), false, 'retryable automatic scanning must not require a manual candidate early');

const nextLabelSource = appSource.slice(
  appSource.indexOf('function setupNextButtonLabel()'),
  appSource.indexOf('function syncSetupNextButtonLabel()'),
);
const setupKeyStepSource = appSource.slice(
  appSource.indexOf("if (step === 3) {", appSource.indexOf("$next.addEventListener('click'")),
  appSource.indexOf('if (step === 4) {', appSource.indexOf("$next.addEventListener('click'")),
);
assert.ok(nextLabelSource.includes('setupPersistedManualKeyNeedsVerification()'), 'setup key-step button label must use the shared verification predicate');
assert.ok(setupKeyStepSource.includes('setupPersistedManualKeyNeedsVerification() || useLegacySetupManualKey'), 'setup key-step click behavior must use the same verification predicate as its help and button label');
assert.ok(setupKeyStepSource.includes('setupManualKeyCandidateMissingState(')
  && setupKeyStepSource.includes('setupManualKeyRequired()')
  && setupKeyStepSource.includes('请先填写并验证当前账号的手动密钥候选'),
'setup key-step click behavior must stop before group loading when the backend requires a manual key and no candidate exists');

const migrationHelperStart = appSource.indexOf('async function migrateSetupLegacyAccountScopesBeforeFinish(');
const migrationHelperEnd = appSource.indexOf('\n  function ', migrationHelperStart + 1);
assert.ok(migrationHelperStart >= 0 && migrationHelperEnd > migrationHelperStart, 'setup must define a bounded pre-finish legacy account-scope migration');
const migrationHelperSource = appSource.slice(migrationHelperStart, migrationHelperEnd);
assert.ok(migrationHelperSource.includes('showAppConfirmDialog({')
  && migrationHelperSource.includes('migrate_legacy_account_scope_for_current_account: true')
  && migrationHelperSource.includes("api('/api/settings'")
  && !migrationHelperSource.includes('clear_all_whitelist')
  && !migrationHelperSource.includes('replace_all_whitelist'),
'setup legacy account-scope migration must require confirmation and use a dedicated settings save without whitelist replacement');

const setupFinishSource = appSource.slice(
  appSource.indexOf('if (step === 4) {', appSource.indexOf("$next.addEventListener('click'")),
  appSource.indexOf('const wl = [...wizardData.whitelist.values()]'),
);
assert.ok(setupFinishSource.includes('await migrateSetupLegacyAccountScopesBeforeFinish('), 'setup must migrate or explicitly stop before building the final wizard payload');

console.log('setup wizard key/account contract tests passed');
