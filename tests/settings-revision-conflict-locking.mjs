import assert from 'node:assert/strict';
import fs from 'node:fs';

const appSource = fs.readFileSync(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');

const setupSaveSource = appSource.slice(
  appSource.indexOf('async function withSetupSaveRequest'),
  appSource.indexOf('async function withSetupPostSaveReconcile'),
);
assert.ok(
  setupSaveSource.includes("e?.code === 'settings_revision_conflict' && e?.current_settings_revision")
    && setupSaveSource.includes('rememberSetupObservedRevision({ settings_revision: e.current_settings_revision })'),
  'setup saves must remember the server revision after a conflict so stale wizard controls lock',
);

const manualValidationStart = appSource.indexOf("validateManualKeyButton?.addEventListener('click'");
const manualValidationEnd = appSource.indexOf("clearManualKeyButton?.addEventListener('click'", manualValidationStart);
const manualValidationSource = appSource.slice(manualValidationStart, manualValidationEnd);
assert.ok(
  manualValidationSource.includes("e?.code === 'settings_revision_conflict' && e?.current_settings_revision")
    && manualValidationSource.includes('rememberSettingsPageObservedRevision({ settings_revision: e.current_settings_revision })'),
  'manual-key validation conflicts must lock the stale settings page before another expensive retry',
);

const legacyCleanupGuardSource = appSource.slice(
  appSource.indexOf('function schedulerLegacyCleanupConflictSlice'),
  appSource.indexOf('function schedulerEditableConflictSlice'),
);
assert.ok(
  legacyCleanupGuardSource.includes('function assertFreshLegacyCleanupTargetsUnchanged')
    && legacyCleanupGuardSource.includes(".filter(groupRefIsUnscoped)")
    && legacyCleanupGuardSource.includes(".filter(item => !String(item.account_id || item.account || '').trim())")
    && legacyCleanupGuardSource.includes('settings_scheduler_legacy_cleanup_conflict'),
  'legacy cleanup must compare the exact unscoped targets the user reviewed with the fresh settings snapshot',
);
const mergeSource = appSource.slice(
  appSource.indexOf('async function mergeFreshHiddenSettingsIntoSchedulerPayload'),
  appSource.indexOf('function schedulerMinValueForCompare'),
);
assert.ok(
  mergeSource.includes('if (cleanupOnly) {')
    && mergeSource.includes('assertFreshLegacyCleanupTargetsUnchanged(fresh, {')
    && mergeSource.includes('includeWhitelist: cleanupLegacyWhitelist')
    && mergeSource.includes('includeOverrides: cleanupLegacyOverrides'),
  'legacy cleanup must reject newly-added unscoped rules before adopting the latest revision',
);

console.log('settings revision conflict locking tests passed');
