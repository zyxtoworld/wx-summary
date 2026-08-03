import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const source = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');

function functionSource(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`\nfunction ${nextName}(`, start + 1);
  assert.ok(start >= 0 && end > start, `${name} source must remain available`);
  return source.slice(start, end);
}

const stateSync = functionSource('syncAccountsFromAppState', 'syncAppStateFromSettingsSave');
const bootstrap = source.slice(
  source.indexOf('function applyBootstrapAccountsResult('),
  source.indexOf('\nasync function refreshTopbarAccounts(', source.indexOf('function applyBootstrapAccountsResult(')),
);
const refresh = source.slice(
  source.indexOf('async function refreshTopbarAccounts('),
  source.indexOf('\nasync function refreshAppStateSilently(', source.indexOf('async function refreshTopbarAccounts(')),
);
const explicitSwitch = source.slice(
  source.indexOf('async function handleAccountSwitch('),
  source.indexOf('\nfunction digestAccountSwitchLockMessage(', source.indexOf('async function handleAccountSwitch(')),
);

assert.doesNotMatch(stateSync, /writeConfirmedAccountValue\(/, 'background app-state sync must not overwrite another tab\'s confirmed account');
assert.doesNotMatch(bootstrap, /writeConfirmedAccountValue\(/, 'bootstrap account discovery must not overwrite another tab\'s confirmed account');
assert.doesNotMatch(refresh, /writeConfirmedAccountValue\(/, 'background account refresh must not overwrite another tab\'s confirmed account');
assert.match(explicitSwitch, /writeConfirmedAccountValue\(nextValue\)/, 'an explicitly confirmed account switch must update the shared default');

console.log('account confirmation cross-tab contract tests passed');
