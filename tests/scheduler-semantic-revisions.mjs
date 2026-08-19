import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  defaultSettings,
  settingsSchedulerRuntimeRevision,
  settingsSchedulerScheduleRevision,
} from '../src/config/settings.js';
import { __schedulerInternals } from '../src/daemon/scheduler.js';

const fingerprint = 'a'.repeat(64);
const keyHash = 'b'.repeat(64);
const base = {
  ...defaultSettings(),
  llm: { ...defaultSettings().llm, base_url: 'https://example.invalid/v1', model: 'model-a', api_key: 'secret-a' },
  groups: { whitelist: [{ account_id: 'wxacct-a', group_id: 'group-a' }], overrides: [], recent: [{ group_id: 'recent-a' }] },
  scheduler: { ...defaultSettings().scheduler, enabled: true, default_interval: '30m' },
  wechat: {
    manual_keys_by_account: { 'wxacct-a': 'c'.repeat(64) },
    manual_key_account_fingerprints_by_account: { 'wxacct-a': fingerprint },
    manual_key_verifications_by_account: {
      'wxacct-a': {
        key_hash: keyHash,
        account_fingerprint: fingerprint,
        message_sample_verified: true,
        message_coverage_verified: true,
        message_db_checked_count: 2,
        message_db_total_count: 2,
        verified_at: '2026-01-01T00:00:00.000Z',
      },
    },
  },
};

const execution = settingsSchedulerRuntimeRevision(base);
const schedule = settingsSchedulerScheduleRevision(base);
assert.match(execution, /^[a-f0-9]{16}$/);
assert.match(schedule, /^[a-f0-9]{16}$/);

const unrelated = {
  ...base,
  settings_revision: 'unrelated-storage-revision',
  web: { ...base.web, port: 7799 },
  logging: { ...base.logging, level: 'debug' },
  groups: { ...base.groups, recent: [{ group_id: 'recent-b' }] },
};
assert.equal(settingsSchedulerRuntimeRevision(unrelated), execution, 'unrelated storage and UI metadata must not invalidate an active scheduler run');
assert.equal(settingsSchedulerScheduleRevision(unrelated), schedule, 'unrelated settings must not reset the persisted next-run clock');
assert.equal(
  __schedulerInternals.schedulerResultStaleForRevision({
    settings_revision_used: 'storage-a',
    scheduler_runtime_revision_used: execution,
  }, execution),
  false,
  'a scheduler result must remain current when only the full storage revision changed',
);

const changedModel = { ...base, llm: { ...base.llm, model: 'model-b' } };
assert.notEqual(settingsSchedulerRuntimeRevision(changedModel), execution);
assert.equal(settingsSchedulerScheduleRevision(changedModel), schedule);
assert.equal(
  __schedulerInternals.schedulerResultStaleForRevision({
    settings_revision_used: 'storage-a',
    scheduler_runtime_revision_used: execution,
  }, settingsSchedulerRuntimeRevision(changedModel)),
  true,
  'a scheduler result must become stale when execution-affecting settings changed',
);

const changedOutput = { ...base, output: { ...base.output, filename_pattern: 'changed-{id8}.png' } };
assert.notEqual(settingsSchedulerRuntimeRevision(changedOutput), execution);
assert.equal(settingsSchedulerScheduleRevision(changedOutput), schedule);

const changedProof = {
  ...base,
  wechat: {
    ...base.wechat,
    manual_key_verifications_by_account: {
      'wxacct-a': {
        ...base.wechat.manual_key_verifications_by_account['wxacct-a'],
        message_db_checked_count: 3,
        message_db_total_count: 3,
      },
    },
  },
};
assert.notEqual(settingsSchedulerRuntimeRevision(changedProof), execution);
assert.equal(settingsSchedulerScheduleRevision(changedProof), schedule);

const timestampOnly = {
  ...base,
  wechat: {
    ...base.wechat,
    manual_key_verifications_by_account: {
      'wxacct-a': {
        ...base.wechat.manual_key_verifications_by_account['wxacct-a'],
        verified_at: '2026-02-02T00:00:00.000Z',
      },
    },
  },
};
assert.equal(settingsSchedulerRuntimeRevision(timestampOnly), execution, 'verification timestamps alone must remain non-semantic');

const changedInterval = { ...base, scheduler: { ...base.scheduler, default_interval: '45m' } };
assert.notEqual(settingsSchedulerRuntimeRevision(changedInterval), execution);
assert.notEqual(settingsSchedulerScheduleRevision(changedInterval), schedule);

const schedulerSource = fs.readFileSync(new URL('../src/daemon/scheduler.js', import.meta.url), 'utf8');
assert.match(schedulerSource, /version:\s*2[\s\S]*?schedule_revision:/);
assert.match(schedulerSource, /function schedulerScheduleRevision\(/);
assert.match(
  schedulerSource,
  /function schedulerRuntimeRevision\(settings = \{\}\) \{\s*return String\(settings\?\.scheduler_runtime_revision \|\| ''\)\.trim\(\);\s*\}/,
  'active-run freshness must not fall back to the full settings revision',
);
assert.doesNotMatch(
  schedulerSource.slice(schedulerSource.indexOf('function schedulerPersistedNextDelay'), schedulerSource.indexOf('async function loadSchedulerRuntimeState')),
  /schedulerRuntimeRevision\(/,
  'persisted next-run restoration must compare only the schedule revision',
);
assert.match(schedulerSource, /scheduler_runtime_revision_used:/, 'scheduler results must retain the semantic runtime revision used for execution');
assert.match(
  schedulerSource,
  /const resultRevision = String\(result\.scheduler_runtime_revision_used \|\| fallbackRevision \|\| ''\)\.trim\(\)/,
  'scheduler result freshness must compare semantic runtime revisions rather than full settings storage revisions',
);

console.log('scheduler semantic revision tests passed');
