import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const source = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');

assert.match(source, /SETTINGS_WRITE_RUNNER\s*=\s*createCrossTabTaskRunner\(/, 'settings writes must share one cross-tab coordinator');
assert.match(source, /async function runCrossTabSettingsWrite\(/, 'settings writes must expose one coordinated entry point');

const settingsStart = source.indexOf('async function withSettingsSaveRequest(');
const settingsEnd = source.indexOf('\n  async function withSettingsPostSaveReconcile(', settingsStart);
const setupStart = source.indexOf('async function withSetupSaveRequest(');
const setupEnd = source.indexOf('\n  async function withSetupPostSaveReconcile(', setupStart);
assert.ok(settingsStart >= 0 && settingsEnd > settingsStart, 'settings save wrapper must remain available');
assert.ok(setupStart >= 0 && setupEnd > setupStart, 'setup save wrapper must remain available');

assert.match(source.slice(settingsStart, settingsEnd), /runCrossTabSettingsWrite\(\(\) => action\(saveSignal\)\)/, 'settings-page writes must acquire the cross-tab lock before submitting');
assert.match(source.slice(setupStart, setupEnd), /runCrossTabSettingsWrite\(\(\) => action\(saveSignal\)\)/, 'setup writes must acquire the same cross-tab lock before submitting');

console.log('settings cross-tab write lock contract tests passed');
