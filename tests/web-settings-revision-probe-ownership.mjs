import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createLatestSettingsRevisionProbe,
  isStaleSettingsProbeResponse,
} from '../src/web/public/js/shared/settings-runtime-sync.js';
import { requireSettingsDocument } from '../src/web/public/js/shared/settings-document.js';

const source = await readFile(
  new URL('../src/web/public/js/pages/settings/index.js', import.meta.url),
  'utf8',
);
const start = source.indexOf('  const focusProbe = createLatestSettingsRevisionProbe({');
const end = source.indexOf('\n\n  const manualKeySync =', start);
assert.ok(start >= 0 && end > start, '必须能定位生产 focusProbe 配置');
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

const state = {
  destroyed: false,
  revisionEpoch: 1,
  baseRevision: 'rev-1',
  settings: { settings_revision: 'rev-1', marker: 'initial' },
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
const toasts = [];
const factory = new Function(
  'createLatestSettingsRevisionProbe',
  'isStaleSettingsProbeResponse',
  'state',
  'api',
  'pageAbort',
  'hasUnsavedDrafts',
  'adoptSettingsDocument',
  'hideNotice',
  'ui',
  'markStale',
  'isAbortError',
  'requireSettingsDocument',
  `${production}\nreturn focusProbe;`,
);
const focusProbe = factory(
  createLatestSettingsRevisionProbe,
  isStaleSettingsProbeResponse,
  state,
  api,
  new AbortController(),
  () => false,
  fresh => {
    adopted.push(fresh.settings_revision);
    state.settings = fresh;
    if (fresh.settings_revision !== state.baseRevision) {
      state.baseRevision = fresh.settings_revision;
      state.revisionEpoch += 1;
    }
  },
  () => {},
  { toast(message) { toasts.push(message); } },
  () => {},
  error => error?.name === 'AbortError',
  requireSettingsDocument,
);
const flush = () => new Promise(resolve => setImmediate(resolve));

const probing = focusProbe.request();
assert.equal(requests.length, 1, '首次 focus 必须发起一个设置探测');

// 探测响应尚未返回时，同账号保存采用了更新 revision。
state.settings = { settings_revision: 'rev-2', marker: 'local-save-2' };
state.baseRevision = 'rev-2';
state.revisionEpoch += 1;

// 旧 GET 在服务端读取了保存 1 和保存 2 之间的快照，随后才晚到浏览器。
requests[0].resolve({ settings_revision: 'rev-between', marker: 'stale-probe' });
await flush();

assert.deepEqual(adopted, [], '保存前发出的探测晚到不得采用不可排序的中间 revision');
assert.equal(state.baseRevision, 'rev-2');
assert.equal(state.settings.marker, 'local-save-2');
assert.equal(toasts.length, 0, '失效探测不得提示已同步过期设置');
assert.equal(requests.length, 2, '失效探测必须通过同一 single-flight owner 重读最新快照');

requests[1].resolve({ settings_revision: 'rev-3', marker: 'latest-probe' });
assert.equal(await probing, true);
assert.deepEqual(adopted, ['rev-3']);
assert.equal(state.baseRevision, 'rev-3');
assert.equal(state.settings.marker, 'latest-probe');
assert.equal(toasts.length, 1);

// 真实焦点同步路径收到 200 + null/畸形文档时，不能把“没有 revision”
// 当作一次成功探测；必须保持当前快照并进入受控错误路径，下一次事件仍可重试。
{
  const malformedState = {
    destroyed: false,
    revisionEpoch: 1,
    baseRevision: 'malformed-base',
    settings: { settings_revision: 'malformed-base', marker: 'keep-current' },
  };
  const malformedRequests = [];
  const malformedApi = {
    get() {
      const response = deferred();
      malformedRequests.push(response);
      return response.promise;
    },
  };
  const malformedAdopted = [];
  const malformedErrors = [];
  const malformedProbe = new Function(
    'createLatestSettingsRevisionProbe',
    'isStaleSettingsProbeResponse',
    'state',
    'api',
    'pageAbort',
    'hasUnsavedDrafts',
    'adoptSettingsDocument',
    'hideNotice',
    'ui',
    'markStale',
    'isAbortError',
    'requireSettingsDocument',
    `${production}\nreturn focusProbe;`,
  )(
    createLatestSettingsRevisionProbe,
    isStaleSettingsProbeResponse,
    malformedState,
    malformedApi,
    new AbortController(),
    () => false,
    fresh => {
      malformedAdopted.push(fresh.settings_revision);
      malformedState.settings = fresh;
    },
    () => {},
    { toast() {} },
    () => {},
    error => error?.name === 'AbortError',
    requireSettingsDocument,
  );
  const malformedRun = malformedProbe.request();
  assert.equal(malformedRequests.length, 1, '畸形焦点同步测试必须先发起真实设置读取');
  malformedRequests[0].resolve(null);
  assert.equal(await malformedRun, false,
    '200 + null 的焦点同步不得被 single-flight 标记为成功');
  assert.deepEqual(malformedAdopted, [], '畸形设置文档不得进入采用回调');
  assert.equal(malformedState.settings.marker, 'keep-current',
    '畸形设置文档不得覆盖当前有效快照');
  assert.deepEqual(malformedErrors, [],
    '生产 onError 当前只负责日志；合同由 probe 的 false 结果表示受控失败');
  malformedProbe.dispose();
}

assert.match(source,
  /store\.subscribe\('account',[\s\S]*?focusProbe\.invalidate\?\.\(\)[\s\S]*?manualKeySync\.invalidate\?\.\(\)/,
  '账号上下文变化必须同步失效独立的设置后台同步器');

// 账号订阅换代后,窗口焦点探测仍可能忽略 abort 并以旧账号快照晚到。
// 账号切换推进的是设置页 generation,而不是 settings_revision;旧响应不得
// 依赖“revision 不同”继续 adopt 到目标账号。
{
  const accountState = {
    destroyed: false,
    generation: 1,
    revisionEpoch: 1,
    baseRevision: 'account-rev-before',
    settings: { settings_revision: 'account-rev-before', marker: 'account-b-current' },
  };
  const accountRequests = [];
  const accountApi = {
    get() {
      const response = deferred();
      accountRequests.push(response);
      return response.promise;
    },
  };
  const accountAdopted = [];
  const accountToasts = [];
  const accountProbe = new Function(
    'createLatestSettingsRevisionProbe',
    'isStaleSettingsProbeResponse',
    'state',
    'api',
    'pageAbort',
    'hasUnsavedDrafts',
    'adoptSettingsDocument',
    'hideNotice',
    'ui',
    'markStale',
    'isAbortError',
    `${production}\nreturn focusProbe;`,
  )(
    createLatestSettingsRevisionProbe,
    isStaleSettingsProbeResponse,
    accountState,
    accountApi,
    new AbortController(),
    () => false,
    fresh => {
      accountAdopted.push(fresh.settings_revision);
      accountState.settings = fresh;
      accountState.baseRevision = fresh.settings_revision;
    },
    () => {},
    { toast(message) { accountToasts.push(message); } },
    () => {},
    error => error?.name === 'AbortError',
  );
  const accountProbeRun = accountProbe.request();
  assert.equal(accountRequests.length, 1, '账号 A 的焦点探测必须先发出一条请求');

  // 对应 store account subscriber:动作 generation 已换代,当前展示已属于 B。
  accountState.generation = 2;
  accountState.accountIdentity = 'id:account-b|fingerprint:b';
  accountProbe.invalidate();
  accountRequests[0].resolve({
    settings_revision: 'account-rev-a-late',
    marker: 'account-a-late',
  });
  await accountProbeRun;

  assert.deepEqual(accountAdopted, [],
    '账号换代后 A 的焦点探测晚到不得采用旧账号设置文档');
  assert.equal(accountState.settings.marker, 'account-b-current',
    '账号换代后不得用旧探测覆盖 B 当前文档');
  assert.deepEqual(accountToasts, [],
    '账号换代后的旧探测不得提示已同步旧账号设置');
  accountProbe.dispose();
}

focusProbe.dispose();
console.log('web settings revision probe ownership tests passed');
