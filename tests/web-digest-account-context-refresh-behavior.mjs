import assert from 'node:assert/strict';
import { createStore } from '../src/web/public/js/store.js';
import { readFile } from 'node:fs/promises';
import { createAccountContextRefreshController } from '../src/web/public/js/pages/digest/account-context-refresh.js';
import { digestAccountContextIdentity } from '../src/web/public/js/pages/digest/account-context.js';

const digestSource = await readFile(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');
const OLD_FINGERPRINT = 'a'.repeat(64);
const NEW_FINGERPRINT = 'b'.repeat(64);
const OTHER_FINGERPRINT = 'c'.repeat(64);
assert.equal(
  digestAccountContextIdentity({ id: 'account-a', manual_key_account_fingerprint: OLD_FINGERPRINT }),
  `id:account-a|fingerprint:${OLD_FINGERPRINT}`,
  '摘要页账号上下文身份必须包含当前 fingerprint',
);
assert.notEqual(
  digestAccountContextIdentity({ id: 'account-a', manual_key_account_fingerprint: OLD_FINGERPRINT }),
  digestAccountContextIdentity({ id: 'account-a', manual_key_account_fingerprint: NEW_FINGERPRINT }),
  '同 ID fingerprint 变化必须建立新的摘要账号上下文',
);
assert.match(digestSource, /import \{[\s\S]*digestAccountContextIdentity[\s\S]*\} from '\.\/account-context\.js';/,
  '摘要页必须使用独立的账号上下文身份 helper');
assert.match(digestSource, /digestAccountContextIdentity\(store\.get\('account'\)\)/,
  '摘要页 account subscriber 必须按 ID+fingerprint 计算上下文');
assert.match(digestSource, /createAccountContextRefreshController\(\{[\s\S]*refreshAccounts: ctx\.refreshAccounts/,
  '行为测试必须对应真实总结页的协调器实例');
assert.match(digestSource, /createAccountContextRefreshController\(\{[\s\S]*isBlocked: \(\) => page\.accountContextBlocked/,
  '总结页账号刷新协调器必须服从草稿上下文的 blocked 状态');
assert.match(digestSource, /accountContextRefresh\.handle\(error,[\s\S]*retry: \(\) => loadGroups\(\{ focusTarget \}\)/,
  '行为测试必须对应真实总结页保留焦点令牌的群列表重试接线');
assert.match(digestSource, /accountContextRefresh\.handleUpgrade\(payload,[\s\S]*retry: \(\) => loadGroups\(\{ focusTarget \}\)/,
  '群列表成功响应里的账号身份升级也必须接入同一协调器后再重试');
assert.match(digestSource, /accountContextRefresh\.retryExplicitly\(\(\) => loadGroups\(\{ focusTarget \}\)\)/,
  '行为测试必须对应真实总结页保留焦点令牌的显式按钮接线');
assert.match(digestSource, /accountContextRefresh\.queueRetryWhileBusy\(retryGroups\)/,
  '账号刷新忙态期间的账号变化必须把最新群列表重载交给协调器');
assert.match(
  digestSource,
  /if \(contextChange\.status === 'unchanged'\) \{[\s\S]*?return;\s*\}\s*accountContextRefresh\.resetForContext\?\.\(\);/,
  '真实账号 subscriber 必须为每个新上下文重置自动刷新预算',
);
assert.match(digestSource, /accountContextRefresh\.dispose\(\)/,
  '行为测试必须对应真实总结页的卸载接线');

function conflictError() {
  return Object.assign(new Error('账号数据身份已变化'), {
    status: 409,
    code: 'account_context_changed',
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function identityUpgradePayload(previousFingerprint, nextFingerprint) {
  return {
    groups: [{ id: 'group-from-upgraded-context' }],
    account_id: 'account-a',
    account_fingerprint: nextFingerprint,
    account_identity_upgrade: {
      previous_fingerprint: previousFingerprint,
      next_fingerprint: nextFingerprint,
    },
    account: {
      id: 'account-a',
      manual_key_account_fingerprint: nextFingerprint,
      account_aliases: ['account-a'],
    },
  };
}

function makeHarness({ nextFingerprint, outcomes }) {
  const oldAccount = { id: 'account-a', manual_key_account_fingerprint: OLD_FINGERPRINT };
  const store = createStore({ account: oldAccount });
  const groupRequests = [];
  const accountRefreshRequests = [];
  const domWrites = [];
  const retryButtons = [];
  let active = true;

  const controller = createAccountContextRefreshController({
    isCurrent: () => active,
    refreshAccounts: async ({ forceDetect }) => {
      accountRefreshRequests.push(forceDetect ? '/api/accounts?refresh=true' : '/api/accounts');
      const current = store.get('account');
      store.set('account', {
        ...current,
        manual_key_account_fingerprint: nextFingerprint,
      });
    },
  });

  async function loadGroups() {
    if (!active) return;
    const account = store.get('account');
    groupRequests.push({
      accountId: account.id,
      fingerprint: account.manual_key_account_fingerprint,
    });
    const outcome = outcomes.shift();
    if (outcome === 'success') {
      if (active) domWrites.push({ type: 'ready', fingerprint: account.manual_key_account_fingerprint });
      return;
    }
    const result = await controller.handle(conflictError(), {
      accountId: account.id,
      fingerprint: account.manual_key_account_fingerprint,
      retry: loadGroups,
    });
    if (!active || result.status === 'stale') return;
    if (result.status === 'blocked') {
      const retry = () => controller.retryExplicitly(loadGroups);
      retryButtons.push(retry);
      domWrites.push({ type: 'error', actionable: true });
    } else if (result.status === 'refresh_failed') {
      domWrites.push({ type: 'error', actionable: true });
    }
  }

  store.subscribe('account', () => {
    const retry = () => loadGroups();
    if (!controller.queueRetryWhileBusy(retry)) void retry();
  });

  return {
    store,
    controller,
    loadGroups,
    groupRequests,
    accountRefreshRequests,
    domWrites,
    retryButtons,
    unmount() {
      active = false;
      controller.dispose();
    },
  };
}

// 首次旧指纹 409 只能刷新一次账号快照;新指纹只发起一次新的群请求并成功。
{
  const harness = makeHarness({
    nextFingerprint: NEW_FINGERPRINT,
    outcomes: ['conflict', 'success'],
  });
  await harness.loadGroups();
  assert.deepEqual(harness.accountRefreshRequests, ['/api/accounts?refresh=true']);
  assert.deepEqual(harness.groupRequests, [
    { accountId: 'account-a', fingerprint: OLD_FINGERPRINT },
    { accountId: 'account-a', fingerprint: NEW_FINGERPRINT },
  ]);
  assert.deepEqual(harness.domWrites, [{ type: 'ready', fingerprint: NEW_FINGERPRINT }]);
}

// /api/groups 可以在同一份已验证数据源补全账号指纹并返回合法升级证明。
// A 响应携带的群不能直接挂到旧 store;必须先由壳层刷新到 B,再只发一次 B 请求。
{
  const oldAccount = { id: 'account-a', manual_key_account_fingerprint: OLD_FINGERPRINT };
  const newAccount = {
    id: 'account-a',
    manual_key_account_fingerprint: NEW_FINGERPRINT,
    account_aliases: ['account-a'],
  };
  const store = createStore({ account: oldAccount });
  const groupRequests = [];
  const accountRefreshRequests = [];
  const domWrites = [];
  let requestIndex = 0;
  const controller = createAccountContextRefreshController({
    refreshAccounts: async ({ forceDetect }) => {
      accountRefreshRequests.push(forceDetect ? '/api/accounts?refresh=true' : '/api/accounts');
      store.set('account', newAccount);
      return { accounts: [newAccount], account: newAccount, changed: true };
    },
  });
  async function loadGroups() {
    const account = store.get('account');
    groupRequests.push({
      accountId: account.id,
      fingerprint: account.manual_key_account_fingerprint,
    });
    requestIndex += 1;
    if (requestIndex === 1) {
      const result = await controller.handleUpgrade(
        identityUpgradePayload(OLD_FINGERPRINT, NEW_FINGERPRINT),
        {
          accountId: account.id,
          fingerprint: account.manual_key_account_fingerprint,
          retry: loadGroups,
        },
      );
      if (result.status === 'invalid' || result.status === 'unconfirmed') {
        domWrites.push({ type: 'error', actionable: true });
      }
      return;
    }
    domWrites.push({ type: 'ready', fingerprint: account.manual_key_account_fingerprint });
  }
  store.subscribe('account', () => {
    const retry = () => loadGroups();
    if (!controller.queueRetryWhileBusy(retry)) void retry();
  });

  await loadGroups();
  assert.deepEqual(accountRefreshRequests, ['/api/accounts?refresh=true'],
    '合法身份升级必须只刷新一次权威账号快照');
  assert.deepEqual(groupRequests, [
    { accountId: 'account-a', fingerprint: OLD_FINGERPRINT },
    { accountId: 'account-a', fingerprint: NEW_FINGERPRINT },
  ], 'A 升级响应后只能由 B 发起一次新群请求');
  assert.deepEqual(domWrites, [{ type: 'ready', fingerprint: NEW_FINGERPRINT }],
    'A payload 的群不得直接写入,只能采用 B 重读结果');
}

// A→B 身份升级刷新在途时，用户仍可切到另一个账号 C。生产 subscriber
// 不能因刷新忙态跳过 C 后永久无人接管；A 的旧 operation 会被账号切换失效，
// 升级结果也只能是 unconfirmed，因此必须由协调器交接并唯一重载当前 C。
{
  const oldAccount = { id: 'account-a', manual_key_account_fingerprint: OLD_FINGERPRINT };
  const otherAccount = { id: 'account-c', manual_key_account_fingerprint: OTHER_FINGERPRINT };
  const store = createStore({ account: oldAccount });
  let resolveRefresh;
  const refreshPending = new Promise(resolve => { resolveRefresh = resolve; });
  const groupRequests = [];
  const controller = createAccountContextRefreshController({
    refreshAccounts: async () => refreshPending,
  });
  async function loadGroups() {
    const account = store.get('account');
    groupRequests.push({
      accountId: account.id,
      fingerprint: account.manual_key_account_fingerprint,
    });
  }
  store.subscribe('account', () => {
    const retry = () => loadGroups();
    if (!controller.queueRetryWhileBusy(retry)) void retry();
  });

  const pending = controller.handleUpgrade(
    identityUpgradePayload(OLD_FINGERPRINT, NEW_FINGERPRINT),
    {
      accountId: oldAccount.id,
      fingerprint: OLD_FINGERPRINT,
      retry: loadGroups,
    },
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.isRefreshing(), true, 'A→B 权威账号刷新必须先进入在途状态');
  store.set('account', otherAccount);
  resolveRefresh({ accounts: [otherAccount], account: otherAccount, changed: false });

  const result = await pending;
  assert.equal(result.status, 'unconfirmed', 'C 不能被误认成 A→B 升级后的 B');
  assert.deepEqual(groupRequests, [{
    accountId: otherAccount.id,
    fingerprint: OTHER_FINGERPRINT,
  }], '刷新忙态期间切到 C 后必须唯一重载 C，不能永久停在空群列表');
}

// 被 A 刷新忙态延后的 C 加载是一个全新的账号加载链。C 首次 409 仍应拥有
// 自己的一次自动刷新预算，不能继承 A 的 automaticRetrying 而被误判为二次重试。
{
  const oldAccount = { id: 'account-a', manual_key_account_fingerprint: OLD_FINGERPRINT };
  const otherAccount = { id: 'account-c', manual_key_account_fingerprint: OTHER_FINGERPRINT };
  const store = createStore({ account: oldAccount });
  let resolveFirstRefresh;
  const firstRefreshPending = new Promise(resolve => { resolveFirstRefresh = resolve; });
  let refreshCalls = 0;
  let groupLoads = 0;
  const nestedStatuses = [];
  const controller = createAccountContextRefreshController({
    async refreshAccounts() {
      refreshCalls += 1;
      if (refreshCalls === 1) return firstRefreshPending;
      return { accounts: [otherAccount], account: otherAccount, changed: false };
    },
  });
  async function loadGroups() {
    groupLoads += 1;
    if (groupLoads !== 1) return;
    const result = await controller.handle(conflictError(), {
      accountId: otherAccount.id,
      fingerprint: OTHER_FINGERPRINT,
      retry: loadGroups,
    });
    nestedStatuses.push(result.status);
  }
  store.subscribe('account', () => {
    const retry = () => loadGroups();
    if (!controller.queueRetryWhileBusy(retry)) void retry();
  });

  const pending = controller.handleUpgrade(
    identityUpgradePayload(OLD_FINGERPRINT, NEW_FINGERPRINT),
    {
      accountId: oldAccount.id,
      fingerprint: OLD_FINGERPRINT,
      retry: loadGroups,
    },
  );
  await new Promise(resolve => setImmediate(resolve));
  store.set('account', otherAccount);
  resolveFirstRefresh({ accounts: [otherAccount], account: otherAccount, changed: false });
  assert.equal((await pending).status, 'unconfirmed');
  assert.equal(refreshCalls, 2, 'C 首次 409 必须获得自己的唯一账号刷新');
  assert.equal(groupLoads, 2, 'C 刷新后必须唯一重试自己的群列表');
  assert.deepEqual(nestedStatuses, ['retried'], 'C 的首次冲突不得继承 A 的自动重试预算');
}

// 即使 A 的账号刷新失败，只要刷新期间已切到 C，旧 A operation 的失败
// 也不能吞掉 C 的首次加载；错误仍返回给旧 caller，C 重载则由最新 owner 接管。
{
  const oldAccount = { id: 'account-a', manual_key_account_fingerprint: OLD_FINGERPRINT };
  const otherAccount = { id: 'account-c', manual_key_account_fingerprint: OTHER_FINGERPRINT };
  const store = createStore({ account: oldAccount });
  let rejectRefresh;
  const refreshPending = new Promise((_resolve, reject) => { rejectRefresh = reject; });
  const groupRequests = [];
  const controller = createAccountContextRefreshController({
    refreshAccounts: async () => refreshPending,
  });
  async function loadGroups() {
    const account = store.get('account');
    groupRequests.push({
      accountId: account.id,
      fingerprint: account.manual_key_account_fingerprint,
    });
  }
  store.subscribe('account', () => {
    const retry = () => loadGroups();
    if (!controller.queueRetryWhileBusy(retry)) void retry();
  });

  const pending = controller.handle(conflictError(), {
    accountId: oldAccount.id,
    fingerprint: OLD_FINGERPRINT,
    retry: loadGroups,
  });
  await new Promise(resolve => setImmediate(resolve));
  store.set('account', otherAccount);
  rejectRefresh(new Error('fixture account refresh failed'));

  const result = await pending;
  assert.equal(result.status, 'refresh_failed', 'A 的刷新失败语义必须原样返回旧 caller');
  assert.deepEqual(groupRequests, [{
    accountId: otherAccount.id,
    fingerprint: OTHER_FINGERPRINT,
  }], 'A 刷新失败也不得吞掉刷新期间切入的 C 群列表加载');
}

{
  let refreshes = 0;
  let retries = 0;
  const controller = createAccountContextRefreshController({
    async refreshAccounts() { refreshes += 1; },
  });
  const malformed = identityUpgradePayload(NEW_FINGERPRINT, OLD_FINGERPRINT);
  const result = await controller.handleUpgrade(malformed, {
    accountId: 'account-a',
    fingerprint: OLD_FINGERPRINT,
    retry: async () => { retries += 1; },
  });
  assert.equal(result.status, 'invalid',
    'previous fingerprint 与发起上下文不一致的升级证明必须 fail-closed');
  assert.equal(refreshes, 0, '非法升级证明不得触发账号刷新');
  assert.equal(retries, 0, '非法升级证明不得触发群列表重试');
}

{
  let resolveRefresh;
  const refreshPending = new Promise(resolve => { resolveRefresh = resolve; });
  let active = true;
  let retries = 0;
  const nextAccount = {
    id: 'account-a',
    manual_key_account_fingerprint: NEW_FINGERPRINT,
    account_aliases: ['account-a'],
  };
  const controller = createAccountContextRefreshController({
    isCurrent: () => active,
    refreshAccounts: async () => refreshPending,
  });
  const pending = controller.handleUpgrade(
    identityUpgradePayload(OLD_FINGERPRINT, NEW_FINGERPRINT),
    {
      accountId: 'account-a',
      fingerprint: OLD_FINGERPRINT,
      retry: async () => { retries += 1; },
    },
  );
  await new Promise(resolve => setImmediate(resolve));
  active = false;
  controller.dispose();
  resolveRefresh({ account: nextAccount, accounts: [nextAccount], changed: true });
  assert.equal((await pending).status, 'stale');
  assert.equal(retries, 0, '升级刷新期间卸载后不得再发群列表重试');
}

// 刷新仍返回同一指纹时,第二次 409 必须停住并给出可操作按钮;未点击前不得再发请求。
{
  const harness = makeHarness({
    nextFingerprint: OLD_FINGERPRINT,
    outcomes: ['conflict', 'conflict', 'success'],
  });
  await harness.loadGroups();
  assert.deepEqual(harness.accountRefreshRequests, ['/api/accounts?refresh=true']);
  assert.equal(harness.groupRequests.length, 2);
  assert.deepEqual(harness.domWrites, [{ type: 'error', actionable: true }]);
  assert.equal(harness.retryButtons.length, 1);

  await harness.retryButtons[0]();
  assert.equal(harness.groupRequests.length, 3, '只有用户点击按钮后才允许下一次显式群列表刷新');
  assert.equal(harness.groupRequests.at(-1).fingerprint, OLD_FINGERPRINT);
  assert.deepEqual(harness.domWrites.at(-1), { type: 'ready', fingerprint: OLD_FINGERPRINT });
}

// 一次用户加载动作只有一次自动账号刷新预算。即使第一次刷新得到新指纹，
// 新指纹的群请求仍返回 409 时也必须立即停住，不能再自动刷新第二次。
{
  const harness = makeHarness({
    nextFingerprint: NEW_FINGERPRINT,
    outcomes: ['conflict', 'conflict', 'success'],
  });
  await harness.loadGroups();
  assert.deepEqual(harness.accountRefreshRequests, ['/api/accounts?refresh=true'],
    '同一加载链不得因新指纹再次 409 而重复自动刷新账号');
  assert.deepEqual(harness.groupRequests, [
    { accountId: 'account-a', fingerprint: OLD_FINGERPRINT },
    { accountId: 'account-a', fingerprint: NEW_FINGERPRINT },
  ], '第一次自动刷新后只允许一次新指纹群请求');
  assert.deepEqual(harness.domWrites, [{ type: 'error', actionable: true }]);
  assert.equal(harness.retryButtons.length, 1,
    '第二次 409 必须等待用户显式重试');

  await harness.retryButtons[0]();
  assert.equal(harness.groupRequests.length, 3,
    '用户显式点击后才允许下一次群请求');
  assert.deepEqual(harness.domWrites.at(-1), { type: 'ready', fingerprint: NEW_FINGERPRINT });
}

// 刷新期间卸载/操作过期后,晚到结果不得再写 DOM。
{
  const oldAccount = { id: 'account-a', manual_key_account_fingerprint: OLD_FINGERPRINT };
  const store = createStore({ account: oldAccount });
  let resolveRefresh;
  const refreshPending = new Promise(resolve => { resolveRefresh = resolve; });
  const domWrites = [];
  let active = true;
  const controller = createAccountContextRefreshController({
    isCurrent: () => active,
    refreshAccounts: async () => refreshPending,
  });
  const pending = controller.handle(conflictError(), {
    accountId: oldAccount.id,
    fingerprint: OLD_FINGERPRINT,
    retry: async () => { domWrites.push('late retry'); },
  });
  await new Promise(resolve => setImmediate(resolve));
  active = false;
  controller.dispose();
  resolveRefresh();
  await pending;
  assert.deepEqual(domWrites, [], '卸载后的刷新结果不得触发重试或 DOM 写入');
}

// 程序化账号切换可能绕过用户 guard；若草稿上下文因持久化失败进入 blocked，
// 已在途的旧账号刷新晚到后不得绕过该状态为目标账号启动群列表重试。
{
  let blocked = false;
  let resolveRefresh;
  const refreshPending = new Promise(resolve => { resolveRefresh = resolve; });
  let retries = 0;
  const controller = createAccountContextRefreshController({
    isCurrent: () => true,
    isBlocked: () => blocked,
    refreshAccounts: async () => refreshPending,
  });
  const pending = controller.handle(conflictError(), {
    accountId: 'account-a',
    fingerprint: OLD_FINGERPRINT,
    retry: async () => { retries += 1; },
  });
  await new Promise(resolve => setImmediate(resolve));
  blocked = true;
  resolveRefresh();
  const result = await pending;
  assert.equal(result.status, 'stale', 'blocked 上下文中的旧刷新结果必须失效');
  assert.equal(retries, 0, 'blocked 上下文不得由旧刷新启动目标账号群列表请求');
}

// 账号上下文 A→B→A 必须为回到 A 的新页面链重置自动刷新预算；
// 旧 A 的 lastRefreshKey 不能让第三次真实群列表加载直接变成 blocked。
{
  let currentIdentity = 'account-a';
  let refreshes = 0;
  const groupLoads = [];
  const controller = createAccountContextRefreshController({
    async refreshAccounts() {
      refreshes += 1;
    },
  });
  async function loadGroups() {
    const accountId = currentIdentity;
    groupLoads.push(accountId);
    if (accountId === 'account-b') return { status: 'success' };
    return controller.handle(conflictError(), {
      accountId,
      fingerprint: accountId,
      retry: loadGroups,
    });
  }

  await loadGroups();
  currentIdentity = 'account-b';
  controller.resetForContext();
  await loadGroups();
  currentIdentity = 'account-a';
  controller.resetForContext();
  const returnedA = await loadGroups();
  assert.equal(refreshes, 2,
    'A→B→A 的新账号上下文必须各自拥有一次自动账号刷新预算');
  assert.equal(returnedA.status, 'retried',
    '回到 A 后的首次冲突必须自动刷新并重试,不能继承旧 A 的 blocked 状态');
  assert.deepEqual(groupLoads, [
    'account-a', 'account-a',
    'account-b',
    'account-a', 'account-a',
  ]);
}

// A 的账号刷新在途时切到 B,且 B 的首个群列表也返回冲突:
// A 的旧自动重试不得占用 automaticRetrying,必须让排队的 B 建立自己的刷新链。
{
  let currentIdentity = 'account-a';
  const refreshRequests = [];
  const groupLoads = [];
  const controller = createAccountContextRefreshController({
    refreshAccounts() {
      const pending = deferred();
      refreshRequests.push(pending);
      return pending.promise;
    },
  });
  async function loadGroups() {
    const accountId = currentIdentity;
    groupLoads.push(accountId);
    return controller.handle(conflictError(), {
      accountId,
      fingerprint: accountId,
      retry: loadGroups,
    });
  }

  const pendingA = loadGroups();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshRequests.length, 1, 'A 首次冲突必须持有自己的账号刷新请求');
  currentIdentity = 'account-b';
  controller.resetForContext();
  assert.equal(
    controller.queueRetryWhileBusy(() => loadGroups()),
    true,
    'B 账号订阅必须把新上下文群列表加载排到旧刷新之后',
  );
  refreshRequests[0].resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshRequests.length, 2,
    'B 首次冲突不得被 A 的自动重试 owner 压制,必须发起第二次账号刷新');
  refreshRequests[1].resolve();
  const staleA = await pendingA;
  assert.equal(staleA.status, 'stale', 'A 刷新完成后不得向旧 caller 返回可重试结果');
  assert.deepEqual(groupLoads, ['account-a', 'account-b', 'account-b']);
}

console.log('web digest account context refresh behavior tests passed');
