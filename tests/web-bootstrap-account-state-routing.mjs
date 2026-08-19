import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createStore } from '../src/web/public/js/store.js';
import { requirePublicAccountList } from '../src/web/public/js/shared/account-context.js';
import { requireServiceStatePayload } from '../src/web/public/js/shared/service-state.js';

const source = await readFile(new URL('../src/web/public/js/main.js', import.meta.url), 'utf8');

function extractFunction(marker, { async = true } = {}) {
  const start = source.indexOf(`${async ? 'async ' : ''}function ${marker}(`);
  assert.ok(start >= 0, `必须能定位生产函数: ${marker}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`生产函数未闭合: ${marker}`);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const bootstrapSource = extractFunction('bootstrap');
const waitForLatestAccountStateRefreshSource = extractFunction('waitForLatestAccountStateRefresh');
const shellAccountIdSource = extractFunction('shellAccountId', { async: false });
const shellAccountFingerprintSource = extractFunction('shellAccountFingerprint', { async: false });
const shellAccountContextIdentitySource = extractFunction('shellAccountContextIdentity', { async: false });
const shellStateMatchesAccountSource = extractFunction('shellStateMatchesAccount', { async: false });
const shellStoredStateMatchesAccountSource = extractFunction('shellStoredStateMatchesAccount', { async: false });
const refreshStateForAccountSource = extractFunction('refreshStateForAccount');
const accountSubscriberStart = source.indexOf("store.subscribe('account',");
const accountSubscriberEnd = source.indexOf('\n});', accountSubscriberStart);
assert.ok(accountSubscriberStart >= 0 && accountSubscriberEnd > accountSubscriberStart,
  '必须能定位生产 account subscriber');
const accountSubscriberSource = source.slice(accountSubscriberStart, accountSubscriberEnd + 3);
const selectedState = deferred();
const account = { id: 'account-selected', manual_key_account_fingerprint: 'f'.repeat(64) };
const store = createStore({ state: null, accounts: [], account: null });
const navigations = [];
let starts = 0;
const api = {
  async get(path) {
    if (path === '/api/state') {
      return {
        need_setup: false,
        wechat: { account_selection_required: true, accounts: [account, { id: 'account-other' }] },
      };
    }
    if (path === '/api/accounts') return [account];
    throw new Error(`unexpected bootstrap request: ${path}`);
  },
};
const bootstrap = new Function(
  'wireThemeSwitch',
  'wireAccountSwitcher',
  'session',
  'ASSET_VERSION',
  'renderBootFailure',
  'createRouter',
  'appEl',
  'api',
  'store',
  'ui',
  'refreshAccounts',
  'createProductionRoutes',
  'accountSwitchLoadingMessage',
  'pickDefaultAccount',
  'requirePublicAccountList',
  'requireServiceStatePayload',
  'renderAccountSwitcher',
  'selectedStatePromise',
  `
    let latestAccountStateRefresh = Promise.resolve(null);
    ${waitForLatestAccountStateRefreshSource}
    const selectAccount = selected => {
      store.set('account', selected);
      latestAccountStateRefresh = selectedStatePromise.then(state => {
        store.set('state', state);
        return state;
      });
      return true;
    };
    ${bootstrapSource}
    return bootstrap;
  `,
)(
  () => {},
  () => {},
  { ensureSessionToken: async () => {} },
  'asset-test',
  () => { throw new Error('unexpected boot failure'); },
  () => ({
    navigate(target) { navigations.push(target); },
    start() { starts += 1; },
  }),
  {},
  api,
  store,
  { toastError() {} },
  async () => ({}),
  () => ({}),
  () => 'loading',
  accounts => accounts[0] || null,
  requirePublicAccountList,
  requireServiceStatePayload,
  () => {},
  selectedState.promise,
);

const running = bootstrap();
await new Promise(resolve => setImmediate(resolve));
assert.equal(starts, 0,
  '选中账号的精确 state 返回前不得挂载基于服务级 state 的首路由');
assert.deepEqual(navigations, []);

selectedState.resolve({
  need_setup: true,
  need_setup_reason: 'wechat_manual_key_required',
  wechat: { accounts: [account], manual_key_required: true },
});
await running;

assert.deepEqual(navigations, ['#/setup'],
  '目标账号实际需要配置时必须在首路由前进入 setup');
assert.equal(starts, 1);

// bootstrap 等待默认账号 A 的精确 state 时，壳层账号菜单已经可交互。
// 用户此时切到 B 会替换 latestAccountStateRefresh；A 被取消/晚到 null 后，
// 首路由必须继续等待 B，而不能拿启动时的服务级 state 提前挂载。
{
  const accountA = { id: 'bootstrap-race-account-a', manual_key_account_fingerprint: 'a'.repeat(64) };
  const accountB = { id: 'bootstrap-race-account-b', manual_key_account_fingerprint: 'b'.repeat(64) };
  const stateA = deferred();
  const stateB = deferred();
  const raceStore = createStore({ state: null, accounts: [], account: null });
  const raceNavigations = [];
  let raceStarts = 0;
  let notifyDefaultSelected;
  const defaultSelected = new Promise(resolve => { notifyDefaultSelected = resolve; });
  const raceHarness = new Function(
    'wireThemeSwitch',
    'wireAccountSwitcher',
    'session',
    'ASSET_VERSION',
    'renderBootFailure',
    'createRouter',
    'appEl',
    'api',
    'store',
    'ui',
    'refreshAccounts',
    'createProductionRoutes',
    'accountSwitchLoadingMessage',
    'pickDefaultAccount',
    'requirePublicAccountList',
    'requireServiceStatePayload',
    'renderAccountSwitcher',
    'stateForAccount',
    'onSelected',
    `
      let latestAccountStateRefresh = Promise.resolve(null);
      ${waitForLatestAccountStateRefreshSource}
      const selectAccount = selected => {
        store.set('account', selected);
        latestAccountStateRefresh = selected ? stateForAccount(selected) : Promise.resolve(null);
        onSelected(selected);
        return true;
      };
      ${bootstrapSource}
      return { bootstrap, selectAccount };
    `,
  )(
    () => {},
    () => {},
    { ensureSessionToken: async () => {} },
    'asset-test',
    () => { throw new Error('unexpected boot failure'); },
    () => ({
      navigate(target) { raceNavigations.push(target); },
      start() { raceStarts += 1; },
    }),
    {},
    {
      async get(path) {
        if (path === '/api/state') {
          return {
            need_setup: false,
            wechat: { account_selection_required: true, accounts: [accountA, accountB] },
          };
        }
        if (path === '/api/accounts') return [accountA, accountB];
        throw new Error(`unexpected bootstrap race request: ${path}`);
      },
    },
    raceStore,
    { toastError() {} },
    async () => ({}),
    () => ({}),
    () => 'loading',
    accounts => accounts[0] || null,
    requirePublicAccountList,
    requireServiceStatePayload,
    () => {},
    selected => (selected === accountA ? stateA.promise : stateB.promise),
    selected => {
      if (selected === accountA) notifyDefaultSelected();
    },
  );

  const raceRunning = raceHarness.bootstrap();
  await defaultSelected;
  raceHarness.selectAccount(accountB);
  stateA.resolve(null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(raceStarts, 0,
    'A 的旧 state 结束后不得在 B 的精确 state 返回前启动路由');
  assert.deepEqual(raceNavigations, [],
    'A 的旧 state/服务级 state 不得替 B 决定首路由');

  stateB.resolve({
    need_setup: true,
    need_setup_reason: 'wechat_manual_key_required',
    wechat: { accounts: [accountA, accountB], manual_key_required: true },
  });
  await raceRunning;
  assert.deepEqual(raceNavigations, ['#/setup'],
    'B 的精确 state 返回后才能决定进入 setup');
  assert.equal(raceStarts, 1, '当前账号 B 的 state 收敛后必须只启动一次路由');
}

// 默认账号的精确 state 连续错配或读取失败时，refreshStateForAccount 会按
// fail-closed 合同返回 null。bootstrap 不能把“账号状态未知”解释成“无需配置”
// 并直接挂载摘要页；配置向导能为当前账号重新检测并提供可操作恢复入口。
{
  const unknownAccount = {
    id: 'bootstrap-unknown-account',
    manual_key_account_fingerprint: 'u'.repeat(64),
  };
  const unknownStore = createStore({ state: null, accounts: [], account: null });
  const unknownNavigations = [];
  const unknownToasts = [];
  let unknownStarts = 0;
  const unknownBootstrap = new Function(
    'wireThemeSwitch',
    'wireAccountSwitcher',
    'session',
    'ASSET_VERSION',
    'renderBootFailure',
    'createRouter',
    'appEl',
    'api',
    'store',
    'ui',
    'refreshAccounts',
    'createProductionRoutes',
    'accountSwitchLoadingMessage',
    'pickDefaultAccount',
    'requirePublicAccountList',
    'requireServiceStatePayload',
    'renderAccountSwitcher',
    'selectedStatePromise',
    `
      let latestAccountStateRefresh = Promise.resolve(null);
      ${waitForLatestAccountStateRefreshSource}
      const selectAccount = selected => {
        store.set('account', selected);
        store.set('state', null);
        latestAccountStateRefresh = selectedStatePromise.then(nextState => {
          store.set('state', nextState);
          return nextState;
        });
        return true;
      };
      ${bootstrapSource}
      return bootstrap;
    `,
  )(
    () => {},
    () => {},
    { ensureSessionToken: async () => {} },
    'asset-test',
    () => { throw new Error('unexpected boot failure'); },
    () => ({
      navigate(target) { unknownNavigations.push(target); },
      start() { unknownStarts += 1; },
    }),
    {},
    {
      async get(path) {
        if (path === '/api/state') {
          return {
            need_setup: false,
            wechat: { account_selection_required: false, accounts: [unknownAccount] },
          };
        }
        if (path === '/api/accounts') return [unknownAccount];
        throw new Error(`unexpected unknown-state bootstrap request: ${path}`);
      },
    },
    unknownStore,
    {
      toastError(message) { unknownToasts.push(message); },
    },
    async () => ({}),
    () => ({}),
    () => 'loading',
    accounts => accounts[0] || null,
    requirePublicAccountList,
    requireServiceStatePayload,
    () => {},
    Promise.resolve(null),
  );

  await unknownBootstrap();
  assert.deepEqual(unknownNavigations, ['#/setup'],
    '默认账号精确 state 未确认时必须进入可恢复的 setup 边界');
  assert.equal(unknownStarts, 1, '未知账号 state 也只能启动一次路由');
  assert.deepEqual(unknownToasts, ['无法确认当前账号状态，已进入配置向导重新检测。'],
    '未知账号 state 必须给出明确提示，不能静默挂载业务页');
  assert.equal(unknownStore.get('state'), null, '未知账号 state 不得回退采用服务级快照');
}

// 服务端状态端点有固定对象合同。200 + null 不能静默退化成“无需配置”的
// 默认摘要路由，至少必须进入与读取失败相同的可见错误边界。
{
  const malformedStore = createStore({ state: null, accounts: [], account: null });
  const malformedToasts = [];
  const malformedNavigations = [];
  let malformedStarts = 0;
  const malformedBootstrap = new Function(
    'wireThemeSwitch',
    'wireAccountSwitcher',
    'session',
    'ASSET_VERSION',
    'renderBootFailure',
    'createRouter',
    'appEl',
    'api',
    'store',
    'ui',
    'refreshAccounts',
    'createProductionRoutes',
    'accountSwitchLoadingMessage',
    'pickDefaultAccount',
    'requirePublicAccountList',
    'requireServiceStatePayload',
    'renderAccountSwitcher',
    `
      let latestAccountStateRefresh = Promise.resolve(null);
      ${waitForLatestAccountStateRefreshSource}
      const selectAccount = selected => {
        store.set('account', selected);
        return true;
      };
      ${bootstrapSource}
      return bootstrap;
    `,
  )(
    () => {},
    () => {},
    { ensureSessionToken: async () => {} },
    'asset-test',
    () => { throw new Error('unexpected boot failure'); },
    () => ({
      navigate(target) { malformedNavigations.push(target); },
      start() { malformedStarts += 1; },
    }),
    {},
    {
      async get(path) {
        if (path === '/api/state') return null;
        if (path === '/api/accounts') return [];
        throw new Error(`unexpected malformed bootstrap request: ${path}`);
      },
    },
    malformedStore,
    { toastError(message) { malformedToasts.push(message); } },
    async () => ({}),
    () => ({}),
    () => 'loading',
    accounts => accounts[0] || null,
    requirePublicAccountList,
    requireServiceStatePayload,
    () => {},
  );

  await malformedBootstrap();
  assert.deepEqual(malformedToasts, ['服务状态响应无效，请刷新页面重试。'],
    '200 + null 必须进入可见状态读取失败边界，不能静默当成有效状态');
  assert.equal(malformedStore.get('state'), null, '畸形状态不得写入共享 store');
  assert.deepEqual(malformedNavigations, [], '畸形状态不得被解释成明确 setup 或 digest 结论');
  assert.equal(malformedStarts, 1, '状态读取失败仍允许页面自己的空态/重试 UI 挂载');
}

// 账号发现失败不能被降级成“没有账号”后继续挂载业务路由。
// 此时服务级 state 不能证明任何可用账号上下文，唯一安全边界是启动错误页，
// 让用户通过已有“重新检查”入口恢复，而不是让摘要/设置页自行猜测账号。
{
  const accountFailureStore = createStore({
    state: null,
    accounts: [],
    account: null,
  });
  const bootFailures = [];
  const accountFailureNavigations = [];
  let accountFailureStarts = 0;
  const accountFailureBootstrap = new Function(
    'wireThemeSwitch',
    'wireAccountSwitcher',
    'session',
    'ASSET_VERSION',
    'renderBootFailure',
    'createRouter',
    'appEl',
    'api',
    'store',
    'ui',
    'refreshAccounts',
    'createProductionRoutes',
    'accountSwitchLoadingMessage',
    'pickDefaultAccount',
    'requirePublicAccountList',
    'requireServiceStatePayload',
    'renderAccountSwitcher',
    `
      let latestAccountStateRefresh = Promise.resolve(null);
      ${waitForLatestAccountStateRefreshSource}
      const selectAccount = selected => {
        store.set('account', selected);
        return true;
      };
      ${bootstrapSource}
      return bootstrap;
    `,
  )(
    () => {},
    () => {},
    { ensureSessionToken: async () => {} },
    'asset-test',
    error => { bootFailures.push(error); },
    () => ({
      navigate(target) { accountFailureNavigations.push(target); },
      start() { accountFailureStarts += 1; },
    }),
    {},
    {
      async get(path) {
        if (path === '/api/state') {
          return { need_setup: false, wechat: { accounts: [] } };
        }
        if (path === '/api/accounts') {
          throw Object.assign(new Error('读取账号列表失败，请重试。'), {
            status: 503,
            code: 'account_list_unavailable',
          });
        }
        throw new Error(`unexpected account-failure request: ${path}`);
      },
    },
    accountFailureStore,
    { toastError() {} },
    async () => ({}),
    () => ({}),
    () => 'loading',
    accounts => accounts[0] || null,
    requirePublicAccountList,
    requireServiceStatePayload,
    () => {},
  );

  await accountFailureBootstrap();
  assert.equal(bootFailures.length, 1,
    '账号列表读取失败必须进入启动错误边界,不能静默吞掉异常');
  assert.equal(bootFailures[0]?.code, 'account_list_unavailable');
  assert.deepEqual(accountFailureNavigations, [],
    '账号上下文未知时不得根据服务级 state 导航到业务页');
  assert.equal(accountFailureStarts, 0,
    '账号列表读取失败时不得挂载依赖账号上下文的路由');
}

// 同一账号 ID + fingerprint 的新对象只刷新展示元数据,不得被壳层当成
// 新账号上下文清空 state 并重新请求。这里执行生产 refreshStateForAccount
// 与 account subscriber 的真实顺序,不是只检查源码字符串。
{
  assert.match(
    source,
    /store\.subscribe\('account',\s*(?:account|\(account,\s*previous\))\s*=>\s*\{[\s\S]*?refreshStateForAccount\(account\)/,
    '壳层必须存在账号订阅到 state 刷新的生产接线',
  );
  const accountA = {
    id: 'same-context-account',
    manual_key_account_fingerprint: 'a'.repeat(64),
    display_name: '旧名称',
  };
  const stateA = {
    need_setup: false,
    wechat: { accounts: [accountA] },
  };
  const sameStore = createStore({
    state: stateA,
    stateAccountContext: {
      accountId: accountA.id,
      accountFingerprint: accountA.manual_key_account_fingerprint,
    },
    account: accountA,
  });
  let stateNotifications = 0;
  sameStore.subscribe('state', () => { stateNotifications += 1; });
  let stateRequests = 0;
  const sameApi = {
    async get(path) {
      stateRequests += 1;
      assert.equal(path, `/api/state?account=${encodeURIComponent(accountA.id)}`);
      return stateA;
    },
  };
  const sameContextRefresh = new Function(
    'store',
    'api',
    'requireServiceStatePayload',
    `${shellAccountIdSource}\n${shellAccountFingerprintSource}\n${shellAccountContextIdentitySource}\n${shellStateMatchesAccountSource}\n${shellStoredStateMatchesAccountSource}\nlet accountStateRequestEpoch = 0;\nlet accountStateRequestController = null;\n${refreshStateForAccountSource}\nreturn refreshStateForAccount;`,
  )(sameStore, sameApi, requireServiceStatePayload);
  const waitForSameContextRefresh = new Function(
    'store',
    'renderAccountSwitcher',
    'refreshStateForAccount',
    `let latestAccountStateRefresh = Promise.resolve(null);\n${shellAccountIdSource}\n${shellAccountFingerprintSource}\n${shellAccountContextIdentitySource}\n${shellStateMatchesAccountSource}\n${shellStoredStateMatchesAccountSource}\n${accountSubscriberSource}\nreturn () => latestAccountStateRefresh;`,
  )(sameStore, () => {}, sameContextRefresh);

  sameStore.set('account', { ...accountA, display_name: '新名称' });
  await waitForSameContextRefresh();
  assert.equal(stateRequests, 0,
    '同上下文账号对象刷新不得重新请求账号 state');
  assert.equal(stateNotifications, 0,
    '同上下文账号对象刷新不得先清空再恢复共享 state');
  assert.strictEqual(sameStore.get('state'), stateA,
    '同上下文账号对象刷新必须保留已有精确 state');

  const missingStateStore = createStore({
    state: null,
    stateAccountContext: null,
    account: accountA,
  });
  let missingStateRequests = 0;
  const missingStateApi = {
    async get(path) {
      missingStateRequests += 1;
      assert.equal(path, `/api/state?account=${encodeURIComponent(accountA.id)}`);
      return stateA;
    },
  };
  const missingStateRefresh = new Function(
    'store',
    'api',
    'requireServiceStatePayload',
    `${shellAccountIdSource}\n${shellAccountFingerprintSource}\n${shellAccountContextIdentitySource}\n${shellStateMatchesAccountSource}\n${shellStoredStateMatchesAccountSource}\nlet accountStateRequestEpoch = 0;\nlet accountStateRequestController = null;\n${refreshStateForAccountSource}\nreturn refreshStateForAccount;`,
  )(missingStateStore, missingStateApi, requireServiceStatePayload);
  const waitForMissingStateRefresh = new Function(
    'store',
    'renderAccountSwitcher',
    'refreshStateForAccount',
    `let latestAccountStateRefresh = Promise.resolve(null);\n${shellAccountIdSource}\n${shellAccountFingerprintSource}\n${shellAccountContextIdentitySource}\n${shellStateMatchesAccountSource}\n${shellStoredStateMatchesAccountSource}\n${accountSubscriberSource}\nreturn () => latestAccountStateRefresh;`,
  )(missingStateStore, () => {}, missingStateRefresh);

  missingStateStore.set('account', { ...accountA, display_name: '状态缺失' });
  await waitForMissingStateRefresh();
  assert.equal(missingStateRequests, 1,
    '同 identity 但 state 未就绪时仍必须请求精确账号 state');
  assert.strictEqual(missingStateStore.get('state'), stateA,
    '精确账号 state 返回后必须恢复共享 state');
}

for (const malformed of [null, [], {}, { need_setup: false }, { need_setup: 'false', wechat: {} }, { need_setup: false, wechat: [] }]) {
  assert.throws(
    () => requireServiceStatePayload(malformed),
    error => error?.status === 502 && error?.code === 'service_state_response_invalid',
    '服务状态校验器必须以固定合同拒绝畸形响应',
  );
}

console.log('web bootstrap account-state routing tests passed');
