import assert from 'node:assert/strict';
import {
  createLatestManualKeyRuntimeSync,
  createLatestSettingsRevisionProbe,
  mergeManualKeyRuntimeSettings,
  schedulerRuntimeRevisionFromPayload,
} from '../src/web/public/js/settings-runtime-sync.js';

assert.equal(schedulerRuntimeRevisionFromPayload({ scheduler_runtime_revision: 'runtime-top' }), 'runtime-top');
assert.equal(schedulerRuntimeRevisionFromPayload({ settings: { scheduler_runtime_revision: 'runtime-settings' } }), 'runtime-settings');
assert.equal(schedulerRuntimeRevisionFromPayload({ scheduler: { scheduler_runtime_revision: 'runtime-scheduler' } }), 'runtime-scheduler');

const current = {
  settings_revision: 'settings-a',
  scheduler_runtime_revision: 'runtime-a',
  llm: { model: 'unsaved-model-draft' },
  groups: { whitelist: [{ group_id: 'draft-group' }] },
  scheduler: { enabled: true, default_interval: '17m' },
  wechat: {
    manual_key_account_ids: ['wxacct_current'],
    manual_key_verified_account_ids: [],
    manual_key_verified_account_count: 0,
    manual_key_verified_account_fingerprints_by_account: {},
    manual_key_clear_account_fingerprints_by_account: { wxacct_current: '0'.repeat(64) },
    unrelated_draft_marker: 'keep-me',
  },
};
const freshRuntime = {
  settings_revision: 'settings-a',
  scheduler_runtime_revision: 'runtime-b',
  llm: { model: 'server-model-must-not-overwrite-draft' },
  groups: { whitelist: [{ group_id: 'server-group-must-not-overwrite-draft' }] },
  scheduler: { enabled: false, default_interval: '30m' },
  wechat: {
    manual_key_account_ids: ['server-id-must-not-replace-current-snapshot'],
    manual_key_verified_account_ids: ['wxacct_current'],
    manual_key_verified_account_count: 1,
    manual_key_verified_account_fingerprints_by_account: { wxacct_current: 'a'.repeat(64) },
    manual_key_clear_account_fingerprints_by_account: { wxacct_current: 'a'.repeat(64) },
    unrelated_draft_marker: 'server-must-not-overwrite',
  },
};

const merged = mergeManualKeyRuntimeSettings(current, freshRuntime);
assert.notEqual(merged, current, 'a newer runtime generation on the same settings revision should produce a new snapshot');
assert.equal(merged.scheduler_runtime_revision, 'runtime-b');
assert.deepEqual(merged.wechat.manual_key_verified_account_ids, ['wxacct_current']);
assert.equal(merged.wechat.manual_key_verified_account_count, 1);
assert.deepEqual(merged.wechat.manual_key_verified_account_fingerprints_by_account, { wxacct_current: 'a'.repeat(64) });
assert.deepEqual(merged.wechat.manual_key_clear_account_fingerprints_by_account, { wxacct_current: 'a'.repeat(64) });
assert.deepEqual(merged.llm, current.llm, 'runtime verification sync must not overwrite an AI form draft');
assert.deepEqual(merged.groups, current.groups, 'runtime verification sync must not overwrite a whitelist draft');
assert.deepEqual(merged.scheduler, current.scheduler, 'runtime verification sync must not overwrite a scheduler draft');
assert.deepEqual(merged.wechat.manual_key_account_ids, current.wechat.manual_key_account_ids, 'runtime verification sync must not replace the saved-key ownership snapshot');
assert.equal(merged.wechat.unrelated_draft_marker, 'keep-me');
assert.equal(current.scheduler_runtime_revision, 'runtime-a', 'runtime merge must not mutate its current input');
assert.deepEqual(current.wechat.manual_key_verified_account_ids, [], 'runtime merge must not mutate nested current settings');

const changedSettingsRevision = mergeManualKeyRuntimeSettings(current, {
  ...freshRuntime,
  settings_revision: 'settings-b',
});
assert.equal(changedSettingsRevision, current, 'a real settings revision change must remain stale and require the existing conflict/reload flow');

const sameRuntimeRevision = mergeManualKeyRuntimeSettings(current, {
  ...freshRuntime,
  scheduler_runtime_revision: 'runtime-a',
});
assert.equal(sameRuntimeRevision, current, 'an unchanged runtime generation should not create repaint churn');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

let live = current;
const responses = [];
const appliedRevisions = [];
const sync = createLatestManualKeyRuntimeSync({
  getCurrent: () => live,
  fetchFresh: () => {
    const response = deferred();
    responses.push(response);
    return response.promise;
  },
  applyMerged: mergedSettings => {
    live = mergedSettings;
    appliedRevisions.push(schedulerRuntimeRevisionFromPayload(mergedSettings));
  },
});

const firstSync = sync.request({ scheduler_runtime_revision: 'runtime-b' });
assert.equal(responses.length, 1, 'the first observed runtime revision should start one request');
const coalescedSync = sync.request({ scheduler_runtime_revision: 'runtime-c' });
assert.equal(firstSync, coalescedSync, 'a newer observation should join the active drain instead of starting a parallel request');
responses[0].resolve({ ...freshRuntime, scheduler_runtime_revision: 'runtime-b' });
await Promise.resolve();
await Promise.resolve();
assert.equal(responses.length, 2, 'an old response must trigger a follow-up request for the newer observed revision');
assert.deepEqual(appliedRevisions, [], 'an old response must not repaint stale runtime verification state');
responses[1].resolve({ ...freshRuntime, scheduler_runtime_revision: 'runtime-c' });
assert.equal(await firstSync, true, 'the joined request should resolve after the latest observed revision is applied');
assert.equal(live.scheduler_runtime_revision, 'runtime-c');
assert.deepEqual(appliedRevisions, ['runtime-c']);

live = current;
responses.length = 0;
appliedRevisions.length = 0;
const aheadSync = sync.request({ scheduler_runtime_revision: 'runtime-d' });
responses[0].resolve({ ...freshRuntime, scheduler_runtime_revision: 'runtime-e' });
assert.equal(await aheadSync, true, 'an authoritative response newer than the observed event should still be accepted');
assert.equal(responses.length, 1, 'an authoritative ahead response must not cause a redundant retry loop');
assert.equal(live.scheduler_runtime_revision, 'runtime-e');

sync.dispose();

const probeResponses = [];
const probedRevisions = [];
const revisionProbe = createLatestSettingsRevisionProbe({
  fetchFresh: () => {
    const response = deferred();
    probeResponses.push(response);
    return response.promise;
  },
  applyFresh: snapshot => {
    probedRevisions.push(snapshot.settings_revision);
  },
});

const firstProbe = revisionProbe.request();
assert.equal(probeResponses.length, 1, 'the first visible/focus event should start one revision probe');
const queuedProbe = revisionProbe.request();
assert.equal(firstProbe, queuedProbe, 'a second event should join the active probe');
probeResponses[0].resolve({ settings_revision: 'settings-b' });
await Promise.resolve();
await Promise.resolve();
assert.equal(probeResponses.length, 2, 'an event received during a probe must force one follow-up snapshot');
assert.deepEqual(probedRevisions, ['settings-b'], 'the completed first snapshot may still be applied before the queued probe');
probeResponses[1].resolve({ settings_revision: 'settings-c' });
assert.equal(await firstProbe, true);
assert.deepEqual(probedRevisions, ['settings-b', 'settings-c']);

revisionProbe.dispose();
assert.equal(await revisionProbe.request(), false, 'a disposed route probe must not start another request');

console.log('settings runtime sync contract passed');
