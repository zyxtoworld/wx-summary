import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  findPublicAccountByIdentity,
  isAccountContextRefreshError,
  requirePublicAccountList,
} from '../src/web/public/js/shared/account-context.js';
import { createStore } from '../src/web/public/js/store.js';

assert.equal(isAccountContextRefreshError({ status: 409, code: 'account_context_changed' }), true);
assert.equal(isAccountContextRefreshError({ status: 409, public_code: 'account_context_refresh_required' }), true);
assert.equal(isAccountContextRefreshError({ status: 400, code: 'account_context_changed' }), false);
assert.equal(isAccountContextRefreshError({ status: 409, code: 'account_required' }), false);
assert.deepEqual(requirePublicAccountList([]), [], '空数组必须保留为合法的无账号结果');
for (const malformed of [null, {}, [null], [{}], [{ id: '' }]]) {
  assert.throws(
    () => requirePublicAccountList(malformed),
    error => error?.status === 502 && error?.code === 'account_list_response_invalid',
    '非数组或缺少稳定 ID 的账号项必须按固定合同拒绝',
  );
}

const [mainSource, digestSource, setupAccountSource] = await Promise.all([
  readFile(new URL('../src/web/public/js/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/js/pages/setup/step-account.js', import.meta.url), 'utf8'),
]);

function extractAsyncFunction(source, name) {
  const marker = `async function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `必须能定位生产函数:${name}`);
  const signatureEnd = source.indexOf(') {', start);
  assert.ok(signatureEnd > start, `${name} 必须有可定位的函数体`);
  const open = signatureEnd + 2;
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
    if (char === '`' || char === '\'' || char === '"') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`生产函数未闭合:${name}`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

{
  const current = {
    id: 'account-old-alias',
    manual_key_account_fingerprint: 'a'.repeat(64),
  };
  const refreshed = {
    id: 'account-canonical',
    account_aliases: ['account-old-alias'],
    manual_key_account_fingerprint: 'b'.repeat(64),
  };
  const store = createStore({ account: current, accounts: [current] });
  const requests = [];
  const persisted = [];
  let renders = 0;
  const refreshAccountsSource = extractAsyncFunction(mainSource, 'refreshAccounts');
  const refreshAccounts = new Function(
    'api',
    'store',
    'findPublicAccountByIdentity',
    'requirePublicAccountList',
    'rememberConfirmedAccountId',
    'renderAccountSwitcher',
    `let accountRefreshInFlight = null;
     let accountRefreshRevision = 0;
     ${refreshAccountsSource}
     return refreshAccounts;`,
  )(
    {
      async get(path) {
        requests.push(path);
        return [refreshed];
      },
    },
    store,
    findPublicAccountByIdentity,
    requirePublicAccountList,
    value => persisted.push(value),
    () => { renders += 1; },
  );

  const result = await refreshAccounts({ forceDetect: true });
  assert.deepEqual(requests, ['/api/accounts?refresh=true']);
  assert.strictEqual(store.get('account'), refreshed,
    '账号规范 ID 变化但 alias 相交时,壳层必须替换成权威新对象而不是清空当前账号');
  assert.strictEqual(result.account, refreshed);
  assert.equal(result.changed, true);
  assert.deepEqual(persisted, [], '别名升级仍是同一账号,不得清空用户确认值');
  assert.equal(renders, 1);
}

// 普通账号快照读取在途时，409 恢复要求的 forceDetect 不能降级为 join 弱请求。
// 强调用必须等待弱请求收敛后唯一重读 ?refresh=true，并返回强结果。
{
  const fingerprintA = 'c'.repeat(64);
  const fingerprintB = 'd'.repeat(64);
  const current = { id: 'account-strength', manual_key_account_fingerprint: fingerprintA };
  const refreshed = { id: 'account-strength', manual_key_account_fingerprint: fingerprintB };
  const store = createStore({ account: current, accounts: [current] });
  const requests = [];
  const responses = [];
  const refreshAccountsSource = extractAsyncFunction(mainSource, 'refreshAccounts');
  const refreshAccounts = new Function(
    'api',
    'store',
    'findPublicAccountByIdentity',
    'requirePublicAccountList',
    'rememberConfirmedAccountId',
    'renderAccountSwitcher',
    `let accountRefreshInFlight = null;
     let accountRefreshRevision = 0;
     ${refreshAccountsSource}
     return refreshAccounts;`,
  )(
    {
      get(path) {
        requests.push(path);
        const response = deferred();
        responses.push(response);
        return response.promise;
      },
    },
    store,
    findPublicAccountByIdentity,
    requirePublicAccountList,
    () => {},
    () => {},
  );

  const weak = refreshAccounts();
  assert.deepEqual(requests, ['/api/accounts']);
  const strong = refreshAccounts({ forceDetect: true });
  const joinedStrong = refreshAccounts({ forceDetect: true });
  assert.equal(responses.length, 1, '弱请求在途时不得并发启动第二个账号扫描');

  responses[0].resolve([current]);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(requests, ['/api/accounts', '/api/accounts?refresh=true'],
    '强制刷新不能复用弱请求，弱请求收敛后必须唯一重读权威账号列表');
  responses[1].resolve([refreshed]);

  assert.strictEqual((await strong).account, refreshed,
    'forceDetect 调用必须等待并返回强制检测结果，不能提前返回弱快照');
  assert.strictEqual((await joinedStrong).account, refreshed,
    '多个强调用必须共享唯一后续强制检测并取得同一最新结果');
  await weak;
  assert.strictEqual(store.get('account'), refreshed,
    '最终 store 账号必须来自强制检测的最新 fingerprint');
}

// 全局账号列表请求没有页面 signal。请求 A 在途时，向导或身份升级流程可能
// 先把共享 account/accounts 采用为同 alias 的新 fingerprint B；A 的旧列表
// 晚到不能再把新身份降回旧对象。
{
  const accountA = {
    id: 'account-external-owner',
    manual_key_account_fingerprint: '1'.repeat(64),
  };
  const accountB = {
    id: accountA.id,
    manual_key_account_fingerprint: '2'.repeat(64),
  };
  const store = createStore({ account: accountA, accounts: [accountA] });
  const response = deferred();
  const refreshAccountsSource = extractAsyncFunction(mainSource, 'refreshAccounts');
  const refreshAccounts = new Function(
    'api',
    'store',
    'findPublicAccountByIdentity',
    'requirePublicAccountList',
    'rememberConfirmedAccountId',
    'renderAccountSwitcher',
    `let accountRefreshInFlight = null;
     let accountRefreshRevision = 0;
     ${refreshAccountsSource}
     return refreshAccounts;`,
  )(
    { get: () => response.promise },
    store,
    findPublicAccountByIdentity,
    requirePublicAccountList,
    () => {},
    () => {},
  );

  const pending = refreshAccounts();
  const authoritativeAccounts = [accountB];
  store.set('accounts', authoritativeAccounts);
  store.set('account', accountB);
  response.resolve([accountA]);
  const result = await pending;

  assert.strictEqual(store.get('account'), accountB,
    '旧账号列表晚到不得把外部新 owner 的 B fingerprint 降回 A');
  assert.strictEqual(store.get('accounts'), authoritativeAccounts,
    '旧账号列表晚到不得覆盖外部新 owner 已采用的账号列表');
  assert.strictEqual(result.account, accountB,
    '失效请求结果必须返回当前 owner，而不是声称旧 A 已采用');
  assert.equal(result.changed, false);
}

// 非数组 200 响应不是“没有账号”。畸形账号快照必须 fail-closed，不能把
// 当前账号、账号列表和用户持久选择清空成权威空态。
{
  const current = { id: 'account-invalid-response', manual_key_account_fingerprint: 'e'.repeat(64) };
  const store = createStore({ account: current, accounts: [current] });
  const persisted = [];
  let renders = 0;
  const refreshAccountsSource = extractAsyncFunction(mainSource, 'refreshAccounts');
  const refreshAccounts = new Function(
    'api',
    'store',
    'findPublicAccountByIdentity',
    'requirePublicAccountList',
    'rememberConfirmedAccountId',
    'renderAccountSwitcher',
    `let accountRefreshInFlight = null;
     let accountRefreshRevision = 0;
     ${refreshAccountsSource}
     return refreshAccounts;`,
  )(
    { get: async () => null },
    store,
    findPublicAccountByIdentity,
    requirePublicAccountList,
    value => persisted.push(value),
    () => { renders += 1; },
  );

  await assert.rejects(
    refreshAccounts({ forceDetect: true }),
    error => error?.code === 'account_list_response_invalid',
    '畸形账号列表响应必须以固定合同拒绝，不能降级为空数组',
  );
  assert.deepEqual(store.get('accounts'), [current], '畸形响应不得覆盖当前账号列表');
  assert.strictEqual(store.get('account'), current, '畸形响应不得清空当前账号');
  assert.deepEqual(persisted, [], '畸形响应不得清空用户确认账号');
  assert.equal(renders, 0, '畸形响应不得把账号菜单重绘为空态');
}

assert.match(mainSource, /async function refreshAccounts\(/,
  '壳层必须提供统一的账号快照刷新入口');
assert.match(mainSource, /const requestedForceDetect = forceDetect === true;[\s\S]*const query = requestedForceDetect \? '\?refresh=true' : '';[\s\S]*api\.get\(`\/api\/accounts\$\{query\}`/,
  '账号上下文失效时必须强制重新检测账号列表');
assert.match(mainSource, /refreshAccounts[\s\S]*store\.set\('account'/,
  '账号快照刷新后必须更新当前账号对象,触发页面账号代际切换');
assert.match(mainSource, /const accounts = requirePublicAccountList\(payload\);/,
  '壳层运行期账号刷新必须采用严格账号列表响应合同');
assert.match(mainSource, /requirePublicAccountList\(await api\.get\('\/api\/accounts'\)\)/,
  '壳层首次启动必须采用同一严格账号列表响应合同');
assert.match(setupAccountSource,
  /w\.wiz\.accounts = requirePublicAccountList\(accounts\);/,
  '首次配置向导不得把畸形账号列表响应降级为空数组');
assert.match(mainSource, /next = findPublicAccountByIdentity\(accounts, current\)/,
  '壳层账号刷新必须按 publicAccount 别名集合匹配身份升级后的对象');
assert.match(mainSource, /ctx:\s*\{[\s\S]*refreshAccounts/,
  '路由页面必须收到壳层统一的账号刷新入口');

assert.match(digestSource, /createAccountContextRefreshController\(\{[\s\S]*refreshAccounts: ctx\.refreshAccounts/,
  '总结页必须实例化壳层提供的账号上下文刷新协调器');
assert.match(digestSource, /accountContextRefresh\.handle\(error,[\s\S]*retry: \(\) => loadGroups\(\{ focusTarget \}\)/,
  '总结页群列表 409 必须交给协调器处理并由协调器发起唯一重试，同时保留显式动作焦点令牌');
assert.match(digestSource, /accountContextRefresh\.retryExplicitly\(\(\) => loadGroups\(\{ focusTarget \}\)\)/,
  '总结页可操作错误按钮必须通过协调器允许携带焦点令牌的显式重试');
assert.match(digestSource, /accountContextRefresh\.dispose\(\)/,
  '总结页卸载时必须销毁账号上下文刷新协调器');
assert.doesNotMatch(digestSource, /page\.accountContextRefreshKey|ctx\.refreshAccounts\(/,
  '总结页不得保留旧的一次性状态机或直接绕过协调器刷新账号');

console.log('web digest account context refresh contract tests passed');
