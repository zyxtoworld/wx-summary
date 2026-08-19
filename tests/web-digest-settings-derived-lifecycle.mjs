import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const indexSource = await readFile(
  new URL('../src/web/public/js/pages/digest/index.js', import.meta.url),
  'utf8',
);
assert.match(indexSource, /createDigestSettingsDerivedLoader\(/,
  '生产摘要页必须使用设置派生数据生命周期 loader');
assert.match(indexSource, /settingsDerived\.dispose\(\)/,
  '摘要页卸载必须释放设置派生数据 loader');

const { createDigestSettingsDerivedLoader } = await import(
  '../src/web/public/js/pages/digest/settings-derived.js',
);

let resolveSettings;
let requestOptions = null;
const applied = [];
const controller = new AbortController();
const api = {
  get(path, options) {
    assert.equal(path, '/api/settings');
    requestOptions = options;
    return new Promise(resolve => { resolveSettings = resolve; });
  },
};

const loader = createDigestSettingsDerivedLoader({
  api,
  signal: controller.signal,
  isActive: () => true,
  apply: value => applied.push(value),
});
const pending = loader.load();
assert.ok(requestOptions.signal instanceof AbortSignal,
  '设置派生数据请求必须持有可取消 signal');
assert.notEqual(requestOptions.signal, controller.signal,
  '设置派生数据请求应持有 loader 自己的请求 signal');
assert.equal(requestOptions.signal.aborted, false);
loader.dispose();
assert.equal(requestOptions.signal.aborted, true,
  '释放 loader 必须立即取消仍在途的设置派生请求');
controller.abort(new Error('摘要页已卸载'));
resolveSettings({
  settings_revision: 'disposed-settings',
  groups: { whitelist: [{ account_id: 'account-a', group_id: 'group-a' }] },
});
assert.equal(await pending, false, '卸载后的设置响应必须标记为未应用');
assert.deepEqual(applied, [], '卸载后的迟到设置响应不得应用到页面状态');

let currentIdentity = 'A';
const resolvers = [];
const requestSignals = [];
const appliedByIdentity = [];
const reloadLoader = createDigestSettingsDerivedLoader({
  api: {
    get(path, options) {
      assert.equal(path, '/api/settings');
      requestSignals.push(options.signal);
      return new Promise(resolve => resolvers.push(resolve));
    },
  },
  isActive: () => true,
  apply(value) {
    appliedByIdentity.push(value);
  },
});
const oldRequest = reloadLoader.load({ isCurrent: () => currentIdentity === 'A' });
assert.equal(requestSignals[0].aborted, false);
reloadLoader.invalidate();
assert.equal(requestSignals[0].aborted, true,
  '账号变化必须立即取消旧账号仍在途的设置派生 I/O');
currentIdentity = 'B';
const newRequest = reloadLoader.load({ isCurrent: () => currentIdentity === 'B' });
assert.notEqual(requestSignals[1], requestSignals[0],
  '新账号重载必须使用独立的新请求 signal');
assert.equal(requestSignals[1].aborted, false,
  '旧账号请求取消不得误伤新账号重载');
resolvers[0]({ settings_revision: 'settings-a', groups: { recent: [{ account_id: 'A', group_id: 'old' }] } });
resolvers[1]({ settings_revision: 'settings-b', groups: { recent: [{ account_id: 'B', group_id: 'new' }] } });
assert.equal(await oldRequest, false, '账号变化后旧设置派生请求必须被代次失效');
assert.equal(await newRequest, true, '新账号设置派生请求必须可以成功应用');
assert.deepEqual(appliedByIdentity, [{ recentRefs: [{ account_id: 'B', group_id: 'new' }], whitelistRefs: [] }]);

const malformedApplied = [];
const malformedLoader = createDigestSettingsDerivedLoader({
  api: { get: async () => ({}) },
  apply(value) { malformedApplied.push(value); },
});
assert.equal(await malformedLoader.load(), false,
  '200+空对象不得被当作成功的摘要设置派生文档');
assert.deepEqual(malformedApplied, [],
  '畸形设置文档不得清空当前白名单或最近群引用');

assert.match(indexSource, /settingsDerived\.invalidate\(\)/,
  '摘要账号变化必须先失效旧设置派生请求');
assert.match(indexSource, /settingsDerived\.load\(\{[\s\S]*?isCurrent:/,
  '摘要账号变化必须按当前账号 identity 重载设置派生数据');

console.log('web digest settings-derived lifecycle tests passed');
