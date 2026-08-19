import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createLatestManualKeyRuntimeSync } from '../src/web/public/js/shared/settings-runtime-sync.js';

const source = await readFile(
  new URL('../src/web/public/js/pages/settings/index.js', import.meta.url),
  'utf8',
);
const start = source.indexOf('  const manualKeySync = createLatestManualKeyRuntimeSync({');
const end = source.indexOf('\n\n  // 调度状态等响应里携带的 revision', start);
assert.ok(start >= 0 && end > start, '必须能定位生产 manualKeySync 配置');
const production = source.slice(start, end);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function settings(runtimeRevision, verifiedCount) {
  return {
    settings_revision: 'settings-stable',
    scheduler_runtime_revision: runtimeRevision,
    llm: { model: 'keep-current' },
    groups: { whitelist: [] },
    scheduler: { enabled: true },
    wechat: {
      manual_key_verified_account_ids: verifiedCount ? ['account-current'] : [],
      manual_key_verified_account_count: verifiedCount,
      manual_key_verified_account_fingerprints_by_account: verifiedCount
        ? { 'account-current': 'a'.repeat(64) }
        : {},
      manual_key_clear_account_fingerprints_by_account: {},
    },
  };
}

const state = {
  destroyed: false,
  settings: settings('runtime-a', 0),
};
const requests = [];
const api = {
  get() {
    const response = deferred();
    requests.push(response);
    return response.promise;
  },
};
const adopted = [];
const factory = new Function(
  'createLatestManualKeyRuntimeSync',
  'state',
  'api',
  'pageAbort',
  'adoptSettingsDocument',
  `${production}\nreturn manualKeySync;`,
);
const manualKeySync = factory(
  createLatestManualKeyRuntimeSync,
  state,
  api,
  new AbortController(),
  merged => {
    adopted.push(merged.scheduler_runtime_revision);
    state.settings = merged;
  },
);

const syncing = manualKeySync.request({ scheduler_runtime_revision: 'runtime-b' });
assert.equal(requests.length, 1);

// 同一 GET 在途时，手动密钥动作已直接采用更晚的运行时快照 C。
state.settings = settings('runtime-c', 2);
requests[0].resolve(settings('runtime-b', 1));

assert.equal(await syncing, false, 'owner 已换代的旧 runtime 响应必须收敛为未采用');
assert.deepEqual(adopted, [], '旧 runtime 响应不得回滚直接动作已经采用的快照');
assert.equal(state.settings.scheduler_runtime_revision, 'runtime-c');
assert.equal(state.settings.wechat.manual_key_verified_account_count, 2);

manualKeySync.dispose();
console.log('web settings manual-key runtime ownership tests passed');
