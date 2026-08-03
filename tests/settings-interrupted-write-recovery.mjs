import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(projectRoot, 'src', 'web', 'public', 'js', 'app.js'), 'utf8');

const settingsSaveSource = source.slice(
  source.indexOf('async function withSettingsSaveRequest'),
  source.indexOf('async function withSettingsPostSaveReconcile'),
);
const setupSaveSource = source.slice(
  source.indexOf('async function withSetupSaveRequest'),
  source.indexOf('async function withSetupPostSaveReconcile'),
);
const recoverySource = source.slice(
  source.indexOf('function pendingSettingsMutationRecords'),
  source.indexOf('function reloadRequiredErrorMessage'),
);

function extractFunction(name) {
  const nextFunctionByName = {
    createPendingSettingsMutationId: 'settingsMutationRecoveryStorageUnavailableError',
    settingsMutationRecoveryStorageUnavailableError: 'beginPendingSettingsMutation',
    beginPendingSettingsMutation: 'forgetPendingSettingsMutation',
  };
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  const nextName = nextFunctionByName[name];
  assert.ok(nextName, `${name} needs an explicit extraction boundary`);
  const end = source.indexOf(`function ${nextName}(`, start + 1);
  assert.notEqual(end, -1, `${name} boundary should exist`);
  return source.slice(start, end).trim();
}

function settingsMutationStarter(localStorage) {
  return Function('localStorage', 'window', `
    const SETTINGS_PENDING_MUTATION_STORAGE_PREFIX = 'test:pending-settings:';
    function pendingSettingsMutationRecords() { return []; }
    ${extractFunction('createPendingSettingsMutationId')}
    ${extractFunction('settingsMutationRecoveryStorageUnavailableError')}
    ${extractFunction('beginPendingSettingsMutation')}
    return beginPendingSettingsMutation;
  `)(localStorage, { crypto: { randomUUID: () => '01234567-89ab-cdef-0123-456789abcdef' } });
}
const manualKeyValidationSource = source.slice(
  source.indexOf("validateManualKeyButton?.addEventListener('click'"),
  source.indexOf('syncDbMirrorDiagnostics();'),
);

assert.ok(source.includes('SETTINGS_PENDING_MUTATION_STORAGE_PREFIX'), 'interrupted settings writes need a durable per-request storage namespace');
assert.ok(source.includes('queueMicrotask(() => restorePendingSettingsMutationRecovery())'), 'startup must restore settings writes left unknown by a reload or forced close after module state is initialized');
assert.ok(recoverySource.includes('const key = `${SETTINGS_PENDING_MUTATION_STORAGE_PREFIX}${mutationId}`') && recoverySource.includes('localStorage.setItem(key, serialized)'), 'recovery records must survive page reloads without storing settings payloads');
assert.ok(recoverySource.includes('localStorage.getItem(key) !== serialized'), 'settings recovery records must be read back before a side-effecting request is allowed');
assert.ok(recoverySource.includes("out.code = 'settings_recovery_storage_unavailable'"), 'settings saves must expose a typed pre-submit error when recovery storage is unavailable');
assert.equal(recoverySource.includes("return '';"), false, 'settings recovery storage failures must not silently return an empty marker and continue submitting');
assert.ok(recoverySource.includes("await api('/api/settings?wait_for_writes=1'"), 'recovery must wait for serialized settings writes before reading the final revision');
assert.ok(recoverySource.includes('clearPendingSettingsMutationRecords()'), 'confirmed recovery must clear every reconciled marker');
assert.ok(recoverySource.includes('if (!settingsSaveStateUnknownError(error)) forgetPendingSettingsMutation(mutationId)'), 'only a definitive response may clear a request marker');

for (const [label, block] of [['settings page', settingsSaveSource], ['setup wizard', setupSaveSource]]) {
  assert.ok(block.includes('beginPendingSettingsMutation('), `${label} saves must persist a marker before submitting`);
  assert.ok(block.indexOf('beginPendingSettingsMutation(') < block.indexOf('new AbortController()'), `${label} saves must verify recovery storage before creating request UI state`);
  assert.ok(block.indexOf('beginPendingSettingsMutation(') < block.indexOf('await runCrossTabSettingsWrite(() => action(saveSignal))'), `${label} saves must verify recovery storage before the coordinated request can submit`);
  assert.ok(block.includes('completePendingSettingsMutationAfterResponse(pendingMutationId)'), `${label} saves must clear the marker after a definitive response`);
  assert.ok(block.includes('completePendingSettingsMutationAfterError(pendingMutationId, e)'), `${label} saves must retain the marker when the response is unknown`);
}

assert.ok(manualKeyValidationSource.includes("beginPendingSettingsMutation('手动密钥验证记录'"), 'manual-key validation must persist a recovery marker before its side-effecting status request');
assert.ok(manualKeyValidationSource.indexOf("beginPendingSettingsMutation('手动密钥验证记录'") < manualKeyValidationSource.indexOf("await api(`/api/wechat/status?"), 'manual-key validation must not submit before recovery storage is verified');
assert.ok(manualKeyValidationSource.includes('completePendingSettingsMutationAfterResponse(pendingValidationMutationId)'), 'manual-key validation must clear its marker after a definitive response');
assert.ok(manualKeyValidationSource.includes('completePendingSettingsMutationAfterError(pendingValidationMutationId, e)'), 'manual-key validation must retain its marker when the response is unknown');

const stored = new Map();
const workingStorage = {
  setItem: (key, value) => stored.set(key, value),
  getItem: key => stored.get(key) ?? null,
  removeItem: key => stored.delete(key),
};
assert.match(settingsMutationStarter(workingStorage)('测试设置'), /^settings-/);
assert.equal(stored.size, 1, 'a verified recovery record should remain until the request receives a definitive result');

for (const failingStorage of [
  { setItem: () => { throw new Error('quota'); }, getItem: () => null, removeItem: () => {} },
  { setItem: () => {}, getItem: () => null, removeItem: () => {} },
]) {
  assert.throws(
    () => settingsMutationStarter(failingStorage)('测试设置'),
    error => error?.code === 'settings_recovery_storage_unavailable' && /尚未发送/.test(error.message),
    'storage write or readback failures must stop the settings mutation before submission',
  );
}

console.log('settings interrupted-write recovery contract passed');
