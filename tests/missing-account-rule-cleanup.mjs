import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { __schedulerInternals } from '../src/daemon/scheduler.js';

const liveAccount = {
  account_id: 'wxacct_aaaaaaaaaaaaaaaaaaaaaaaa',
  account_aliases: ['live-account-dir'],
};
const missingScope = 'wxacct_bbbbbbbbbbbbbbbbbbbbbbbb';
const settings = {
  settings_revision: 'revision-a',
  groups: {
    whitelist: [
      { account_id: liveAccount.account_id, group_id: 'live@chatroom' },
      { account_id: 'live-account-dir', group_id: 'live-alias@chatroom' },
      { account_id: missingScope, group_id: 'missing-white@chatroom' },
      { group_id: 'unscoped@chatroom' },
    ],
  },
  scheduler: {
    per_group: [
      { account_id: missingScope, group_id: 'missing-rule@chatroom', keywords: ['x'] },
      { account_id: liveAccount.account_id, group_id: 'live-rule@chatroom', keywords: ['y'] },
    ],
  },
};

const plan = __schedulerInternals.schedulerMissingAccountCleanupPlan(settings, [liveAccount]);
assert.deepEqual(plan.scopes, [missingScope], 'only scopes that fail exact and alias account resolution should be removable');
assert.equal(plan.ref_count, 2, 'the cleanup count should include both whitelist and per-group references for a missing account');
assert.match(plan.token, /^[a-f0-9]{64}$/, 'the cleanup confirmation should bind to a stable server token');

const accountReturned = __schedulerInternals.schedulerMissingAccountCleanupPlan(settings, [
  liveAccount,
  { account_id: missingScope },
]);
assert.equal(accountReturned.ref_count, 0, 'a rule must stop being removable when its account is detected again');
assert.notEqual(accountReturned.token, plan.token, 'the confirmation token must change when account discovery changes');

const noAccounts = __schedulerInternals.schedulerMissingAccountCleanupPlan(settings, []);
assert.equal(noAccounts.ref_count, 0, 'an empty account scan must fail closed instead of classifying every scoped rule as stale');

const mainSource = await fs.readFile(new URL('../src/main.js', import.meta.url), 'utf8');
assert.ok(mainSource.includes('normalizeSettingsMissingAccountRulesCleanup')
  && mainSource.includes("'server_missing_account_cleanup'")
  && mainSource.includes('missing_account_cleanup_token_changed'),
'settings cleanup must be expanded from fresh server account discovery and revalidated immediately before commit');

console.log('missing account rule cleanup tests passed');
