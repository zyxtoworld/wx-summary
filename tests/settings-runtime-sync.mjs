import assert from 'node:assert/strict';
import {
  createLatestManualKeyRuntimeSync,
  createLatestSettingsRevisionProbe,
  isStaleSettingsProbeResponse,
  mergeManualKeyRuntimeSettings,
  schedulerRuntimeRevisionFromPayload,
} from '../src/web/public/js/shared/settings-runtime-sync.js';

assert.equal(isStaleSettingsProbeResponse({
  probe: { epoch: 4, baseRevision: 'settings-a' },
  currentEpoch: 4,
  responseRevision: 'settings-a',
}), false, '同一代探测响应不是旧响应');
assert.equal(isStaleSettingsProbeResponse({
  probe: { epoch: 4, baseRevision: 'settings-a' },
  currentEpoch: 5,
  responseRevision: 'settings-a',
}), true, '保存前已发出的同一旧 revision 必须丢弃');
assert.equal(isStaleSettingsProbeResponse({
  probe: { epoch: 4, baseRevision: 'settings-a' },
  currentEpoch: 5,
  responseRevision: 'settings-b',
}), true, 'revision 是不可排序哈希，owner 换代后不同 revision 的旧响应也必须丢弃');

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

const runtimeApplyErrors = [];
const runtimeApplyFailure = createLatestManualKeyRuntimeSync({
  getCurrent: () => current,
  fetchFresh: () => Promise.resolve({
    ...freshRuntime,
    scheduler_runtime_revision: 'runtime-apply-failure',
  }),
  applyMerged: () => {
    throw new Error('synthetic runtime repaint failure');
  },
  onError: error => runtimeApplyErrors.push(error.message),
});
assert.equal(
  await runtimeApplyFailure.request({ scheduler_runtime_revision: 'runtime-apply-failure' }),
  false,
  '运行时字段采用抛错时后台同步必须收敛为失败,不能把 rejected Promise 泄漏给生产调用方',
);
assert.deepEqual(runtimeApplyErrors, ['synthetic runtime repaint failure'],
  '运行时字段采用异常必须交给受控错误回调');
runtimeApplyFailure.dispose();

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

const failedProbeResponses = [];
const probeErrors = [];
const recoveredProbeRevisions = [];
const recoveringProbe = createLatestSettingsRevisionProbe({
  fetchFresh: () => {
    const response = deferred();
    failedProbeResponses.push(response);
    return response.promise;
  },
  applyFresh: snapshot => {
    recoveredProbeRevisions.push(snapshot.settings_revision);
  },
  onError: error => {
    probeErrors.push(error.message);
  },
});

const recoveringRequest = recoveringProbe.request();
assert.equal(recoveringProbe.request(), recoveringRequest, '失败前到达的第二次可见事件必须加入同一探测');
failedProbeResponses[0].reject(new Error('synthetic probe failure'));
await Promise.resolve();
await Promise.resolve();
assert.equal(failedProbeResponses.length, 2, '在途探测失败后必须兑现期间排队的最后一次探测');
assert.deepEqual(probeErrors, ['synthetic probe failure'], '后台探测失败必须交给受控错误回调而不是形成未处理拒绝');
failedProbeResponses[1].resolve({ settings_revision: 'settings-recovered' });
assert.equal(await recoveringRequest, true, '排队探测成功后原请求必须正常收敛');
assert.deepEqual(recoveredProbeRevisions, ['settings-recovered']);

const standaloneFailure = recoveringProbe.request();
failedProbeResponses[2].reject(new Error('standalone probe failure'));
assert.equal(await standaloneFailure, false, '没有排队事件的后台探测失败必须受控返回 false');
assert.deepEqual(probeErrors, ['synthetic probe failure', 'standalone probe failure']);
recoveringProbe.dispose();

// 账号上下文变化只应丢弃旧运行时响应,不能把旧账号的晚到字段合并到新页面。
const staleRuntimeResponses = [];
let staleRuntimeApplied = 0;
const staleRuntimeSync = createLatestManualKeyRuntimeSync({
  getCurrent: () => current,
  fetchFresh: () => {
    const response = deferred();
    staleRuntimeResponses.push(response);
    return response.promise;
  },
  applyMerged: () => { staleRuntimeApplied += 1; },
});
const staleRuntimeRequest = staleRuntimeSync.request({ scheduler_runtime_revision: 'runtime-stale-account' });
assert.equal(staleRuntimeResponses.length, 1);
staleRuntimeSync.invalidate();
staleRuntimeResponses[0].resolve({
  ...freshRuntime,
  scheduler_runtime_revision: 'runtime-stale-account',
});
assert.equal(await staleRuntimeRequest, false,
  '账号上下文失效后的旧运行时请求必须收敛为未采用');
assert.equal(staleRuntimeApplied, 0,
  '账号上下文失效后的旧运行时响应不得合并到当前设置');
staleRuntimeSync.dispose();

console.log('settings runtime sync contract passed');
