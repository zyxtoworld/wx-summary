import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAccountChangeScope } from '../src/web/public/js/shared/account-change-scope.js';
import { refreshPublicAccountIdentityUpgrade } from '../src/web/public/js/shared/account-context.js';
import { settingsAccountSwitchBlockedMessage } from '../src/web/public/js/shared/settings-account-switch.js';
import {
  createSettingsAccountContextTracker,
  invalidateSettingsActionsForAccountChange,
  settingsAccountContextIdentity,
} from '../src/web/public/js/pages/settings/account-context.js';
import { completeSettingsAction } from '../src/web/public/js/pages/settings/action-lifecycle.js';
import {
  createSettingsInitializationGate,
  createSettingsInitializationLifecycle,
} from '../src/web/public/js/pages/settings/initialization.js';
import { requireSettingsDocument } from '../src/web/public/js/shared/settings-document.js';

assert.equal(settingsAccountSwitchBlockedMessage({ destroyed: true, dirtyCount: 2 }), '',
  '设置页销毁后不得继续阻止壳层切换账号');
assert.match(settingsAccountSwitchBlockedMessage({ initializing: true }), /读取当前设置/,
  '设置页初始读取期间必须保持账号上下文稳定');
assert.match(settingsAccountSwitchBlockedMessage({ initializationFailed: true }), /初始化|重试|读取/,
  '设置初始读取失败后仍停在错误/重试页时不得放开账号切换');
assert.match(settingsAccountSwitchBlockedMessage({ busy: true }), /操作正在进行/,
  '设置页操作进行期间不得切换账号');
assert.match(settingsAccountSwitchBlockedMessage({ dirtyCount: 1 }), /未保存的更改/,
  '设置页有草稿时不得切换账号');
assert.equal(settingsAccountSwitchBlockedMessage({}), '',
  '设置页空闲且无草稿时允许切换账号');

const settingsSource = await readFile(
  new URL('../src/web/public/js/pages/settings/index.js', import.meta.url),
  'utf8',
);

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function extractFunction(sourceText, marker) {
  const start = sourceText.indexOf(marker);
  assert.ok(start >= 0, `生产设置页必须包含 ${marker}`);
  const signatureEnd = sourceText.indexOf(') {', start);
  assert.ok(signatureEnd >= 0, `${marker} 必须有可定位的函数签名`);
  const open = signatureEnd + 2;
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '`' || char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return sourceText.slice(start, index + 1);
  }
  throw new Error(`${marker} 函数体未闭合`);
}

// 设置保存可能在服务端重新确认同一账号的数据 fingerprint。有效升级响应必须
// 经共享证明校验后强制刷新账号快照；不能只显示提示而继续持有旧 fingerprint。
{
  const refreshSavedAccountIdentitySource = extractFunction(
    settingsSource,
    'async function refreshSavedAccountIdentity(',
  );
  const fingerprintA = 'a'.repeat(64);
  const fingerprintB = 'b'.repeat(64);
  const accountA = {
    id: 'settings-upgrade-account',
    manual_key_account_fingerprint: fingerprintA,
  };
  const accountB = {
    id: accountA.id,
    manual_key_account_fingerprint: fingerprintB,
  };
  const state = {
    destroyed: false,
    generation: 4,
    accountContext: createSettingsAccountContextTracker(accountA),
    baseRevision: '',
    revisionEpoch: 0,
    stale: false,
    staleDismissedRevision: '',
  };
  const toastEvents = [];
  let refreshUpgradeCalls = 0;
  let currentAccount = accountA;
  let resolveRefreshAccounts;
  const refreshAccountsResult = new Promise(resolve => { resolveRefreshAccounts = resolve; });
  const refreshAccounts = async () => {
    refreshUpgradeCalls += 1;
    const refreshed = await refreshAccountsResult;
    currentAccount = refreshed.account;
    state.accountContext.update(currentAccount);
    state.generation += 1;
    return refreshed;
  };
  const followToken = { kind: 'account-identity-refresh' };
  let followBeginCalls = 0;
  let followEndCalls = 0;
  let upgradedCallbackCalls = 0;
  const refreshSavedAccountIdentity = new Function(
    'state',
    'settingsRequestContext',
    'store',
    'refreshPublicAccountIdentityUpgrade',
    'ctx',
    'ui',
    'beginAction',
    'endAction',
    'settingsAccountContextIdentity',
    `${refreshSavedAccountIdentitySource}; return refreshSavedAccountIdentity;`,
  )(
    state,
    account => ({
      account_id: account.id,
      expected_account_fingerprint: account.manual_key_account_fingerprint,
    }),
    { get: key => (key === 'account' ? currentAccount : null) },
    refreshPublicAccountIdentityUpgrade,
    { refreshAccounts },
    {
      toast(message, options) { toastEvents.push(['toast', message, options]); },
      toastWarn(message) { toastEvents.push(['warn', message]); },
    },
    () => {
      followBeginCalls += 1;
      return followToken;
    },
    token => {
      assert.strictEqual(token, followToken);
      followEndCalls += 1;
      return true;
    },
    settingsAccountContextIdentity,
  );

  refreshSavedAccountIdentity({
    result: {
      account_identity_upgrade: {
        previous_fingerprint: fingerprintA,
        next_fingerprint: fingerprintB,
      },
      account: accountB,
      account_id: accountB.id,
      account_fingerprint: fingerprintB,
    },
    onUpgraded(account) {
      assert.strictEqual(account, accountB);
      upgradedCallbackCalls += 1;
      return true;
    },
  });
  await nextTurn();
  assert.equal(followBeginCalls, 1,
    '账号身份刷新挂起期间必须持有独立设置 action,阻止新动作抢入');
  assert.equal(followEndCalls, 0,
    '账号身份刷新未 settle 前不得提前释放 follow-up action');
  resolveRefreshAccounts({ account: accountB });
  await nextTurn();
  assert.equal(refreshUpgradeCalls, 1,
    '设置保存身份升级必须经共享协调器强制刷新一次账号快照');
  assert.equal(followEndCalls, 1,
    '账号身份刷新 settle 后必须恰好释放自己的 follow-up action');
  assert.equal(upgradedCallbackCalls, 1,
    '共享刷新精确确认 B 后必须恰好提交一次原 action 的升级回调');
  assert.deepEqual(toastEvents, [[
    'toast',
    '当前微信账号身份已更新,已按新身份保存。',
    { type: 'info' },
  ]], '只有账号刷新确认升级后才能显示身份已更新提示');
}

// 账号身份刷新有两个合法阶段：发起时仍是 A，强制刷新后恰好迁移到证明中的 B。
// 若期间切到无关 C，即使旧 refreshAccounts 晚到返回 B，也不得写 C 页面。
{
  const refreshSavedAccountIdentitySource = extractFunction(
    settingsSource,
    'async function refreshSavedAccountIdentity(',
  );
  const fingerprintA = '1'.repeat(64);
  const fingerprintB = '2'.repeat(64);
  const fingerprintC = '3'.repeat(64);
  const accountA = { id: 'settings-upgrade-race', manual_key_account_fingerprint: fingerprintA };
  const accountB = { id: accountA.id, manual_key_account_fingerprint: fingerprintB };
  const accountC = { id: 'settings-unrelated-account', manual_key_account_fingerprint: fingerprintC };
  const upgradeResult = {
    account_identity_upgrade: {
      previous_fingerprint: fingerprintA,
      next_fingerprint: fingerprintB,
    },
    account: accountB,
    account_id: accountB.id,
    account_fingerprint: fingerprintB,
  };

  async function runScenario({ nextAccount, nextAccounts = null, returnedAccount }) {
    let currentAccount = accountA;
    const state = {
      destroyed: false,
      generation: 10,
      accountContext: createSettingsAccountContextTracker(accountA),
    };
    let resolveRefresh;
    let notifyRefreshStarted;
    const refreshStarted = new Promise(resolve => { notifyRefreshStarted = resolve; });
    const refreshResult = new Promise(resolve => { resolveRefresh = resolve; });
    const callbacks = [];
    const toasts = [];
    const token = { generation: state.generation };
    const refreshSavedAccountIdentity = new Function(
      'state',
      'settingsRequestContext',
      'store',
      'refreshPublicAccountIdentityUpgrade',
      'ctx',
      'ui',
      'beginAction',
      'endAction',
      'settingsAccountContextIdentity',
      `${refreshSavedAccountIdentitySource}; return refreshSavedAccountIdentity;`,
    )(
      state,
      account => ({
        account_id: account.id,
        expected_account_fingerprint: account.manual_key_account_fingerprint,
      }),
      { get: key => (key === 'account' ? currentAccount : null) },
      refreshPublicAccountIdentityUpgrade,
      {
        refreshAccounts: async () => {
          notifyRefreshStarted();
          return refreshResult;
        },
      },
      {
        toast(message, options) { toasts.push(['toast', message, options]); },
        toastWarn(message) { toasts.push(['warn', message]); },
      },
      () => token,
      () => true,
      settingsAccountContextIdentity,
    );

    const pending = refreshSavedAccountIdentity({
      result: upgradeResult,
      onUpgraded(account) {
        callbacks.push(account);
        return true;
      },
      onIncomplete(outcome) {
        callbacks.push({ incomplete: outcome?.status });
      },
    });
    await refreshStarted;
    for (const account of (nextAccounts || [nextAccount])) {
      currentAccount = account;
      state.accountContext.update(account);
      state.generation += 1;
    }
    resolveRefresh({ account: returnedAccount });
    await pending;
    return { callbacks, toasts };
  }

  const legal = await runScenario({ nextAccount: accountB, returnedAccount: accountB });
  assert.deepEqual(legal.callbacks, [accountB], 'A→证明中的 B 必须提交一次升级回调');
  assert.equal(legal.toasts.length, 1, '合法 B 升级必须显示一次成功提示');

  const unrelated = await runScenario({ nextAccount: accountC, returnedAccount: accountB });
  assert.deepEqual(unrelated.callbacks, [], 'A→无关 C 后旧 B 刷新不得执行旧回调');
  assert.deepEqual(unrelated.toasts, [], 'A→无关 C 后旧 B 刷新不得向 C 页面写提示');

  const detour = await runScenario({ nextAccounts: [accountC, accountB], returnedAccount: accountB });
  assert.deepEqual(detour.callbacks, [], 'A→C→B 两次换代不得伪装成原动作的直接身份升级');
  assert.deepEqual(detour.toasts, [], '经历无关账号后即使最终为 B 也不得显示旧动作成功提示');
}

// 身份刷新属于保存 action 的后续交接。即使 /api/accounts 立即返回，也必须
// 先让分区 caller 采用保存结果并清 dirty，再由 endAction 启动账号快照刷新；
// 否则账号订阅提升 generation 后 caller 会把成功保存误判成 stale。
{
  const adoptSaveResultSource = extractFunction(settingsSource, 'function adoptSaveResult(');
  const saveSectionSource = extractFunction(settingsSource, 'async function saveSection(');
  const endActionSource = extractFunction(settingsSource, 'function endAction(');
  const queueAccountIdentityUpgradeSource = extractFunction(
    settingsSource,
    'function queueAccountIdentityUpgrade(',
  );
  const fingerprintA = 'c'.repeat(64);
  const fingerprintB = 'd'.repeat(64);
  const accountA = { id: 'settings-upgrade-owner', manual_key_account_fingerprint: fingerprintA };
  const accountB = { id: accountA.id, manual_key_account_fingerprint: fingerprintB };
  const upgradeResult = {
    account_identity_upgrade: {
      previous_fingerprint: fingerprintA,
      next_fingerprint: fingerprintB,
    },
    account: accountB,
    account_id: accountB.id,
    account_fingerprint: fingerprintB,
  };
  const token = {
    generation: 7,
    controller: new AbortController(),
    focusTarget: null,
    cleanup() {},
  };
  token.signal = token.controller.signal;
  const state = {
    destroyed: false,
    generation: 7,
    actions: new Set([token]),
    baseRevision: '',
    revisionEpoch: 0,
    stale: false,
    staleDismissedRevision: '',
  };
  const store = { get: key => (key === 'account' ? accountA : null) };
  let refreshCalls = 0;
  const refreshAccounts = async () => {
    await Promise.resolve();
    refreshCalls += 1;
    invalidateSettingsActionsForAccountChange(state, '账号身份已升级');
    return { account: accountB };
  };
  const startIdentityRefresh = queuedUpgrade => {
    const result = queuedUpgrade?.result || queuedUpgrade;
    const context = {
      account_id: accountA.id,
      expected_account_fingerprint: fingerprintA,
    };
    void refreshPublicAccountIdentityUpgrade(result, {
      accountId: context.account_id,
      fingerprint: context.expected_account_fingerprint,
      refreshAccounts,
      isCurrent: () => !state.destroyed,
    });
  };
  const harness = new Function(
    'state',
    'api',
    'writeSettingsPatch',
    'markStale',
    'adoptSettingsDocument',
    'hideNotice',
    'ui',
    'confirmPersisted',
    'settingsRequestContext',
    'store',
    'refreshPublicAccountIdentityUpgrade',
    'ctx',
    'completeSettingsAction',
    'syncBusy',
    'restoreActionFocus',
    'refreshSavedAccountIdentity',
    `
      const alive = token => !state.destroyed && token && token.generation === state.generation;
      ${endActionSource}
      ${queueAccountIdentityUpgradeSource}
      ${adoptSaveResultSource}
      ${saveSectionSource}
      return { alive, endAction, saveSection };
    `,
  )(
    state,
    {},
    async () => upgradeResult,
    () => {},
    () => {},
    () => {},
    { toast() {}, toastWarn() {} },
    async () => {},
    account => ({
      account_id: account.id,
      expected_account_fingerprint: account.manual_key_account_fingerprint,
    }),
    store,
    refreshPublicAccountIdentityUpgrade,
    { refreshAccounts },
    completeSettingsAction,
    () => {},
    () => {},
    startIdentityRefresh,
  );

  let dirty = true;
  let firstEndOwned = false;
  try {
    await harness.saveSection({ privacy: { redact_names: true } }, {
      signal: token.signal,
      ownerToken: token,
    });
    if (harness.alive(token)) dirty = false;
  } finally {
    firstEndOwned = harness.endAction(token);
  }
  const duplicateEndOwned = harness.endAction(token);
  await nextTurn();
  await nextTurn();
  assert.equal(dirty, false,
    '账号身份刷新不得在保存 caller 清除 dirty 前使 action 失效');
  assert.equal(refreshCalls, 1,
    '保存 action 正常交还后必须恰好启动一次账号身份刷新');
  assert.equal(firstEndOwned, true, '原保存 action 的首次 end 必须真实交还 owner');
  assert.equal(duplicateEndOwned, false, '同一 token 重复 end 必须是无副作用 no-op');
}
assert.match(settingsSource, /initializationFailed/,
  '设置页生产守卫必须区分初始化失败与已完成初始化');
assert.match(settingsSource, /initializationFailed:\s*state\.initializationFailed/,
  '设置页账号守卫必须读取初始化失败状态');
assert.match(settingsSource, /state\.initializationFailed\s*=\s*true/,
  '设置页初始读取失败必须进入 fail-closed 状态');
assert.match(settingsSource, /state\.initializationFailed\s*=\s*result\.ok\s*!==\s*true/,
  '设置页成功读取必须清除 fail-closed 状态');
assert.match(settingsSource, /createSettingsInitializationGate\(/,
  '设置页必须通过初始化采用门控决定何时解锁');
assert.match(settingsSource, /async function loadInitialSettingsDocument\([\s\S]*?initializationGate\.load\(/,
  '设置页必须用同一个加载函数执行文档校验与采用');
assert.match(settingsSource, /loadInitialSettingsDocument\(\s*\(\) => Promise\.resolve\(fresh\)/,
  '设置页重试必须经过有效文档加载门控');
assert.match(settingsSource, /const loadSettings = recovered\.settings[\s\S]*?loadInitialSettingsDocument\(loadSettings/,
  '设置页首次读取必须经过有效文档加载门控');

// 行为合同:空/非对象响应、采用或 repaint 抛错都必须保持失败状态;
// 只有完整 apply 成功后才允许清除失败状态。
{
  const gate = createSettingsInitializationGate();
  const loadedNull = await gate.load(async () => null, () => {
    throw new Error('空响应不应进入采用');
  });
  assert.equal(loadedNull.ok, false, '首次加载返回 null 不得被视为成功');
  assert.equal(loadedNull.error?.code, 'invalid_settings_document');
  assert.equal(gate.isFailed(), true, '首次加载返回 null 后必须保持 fail-closed');
  assert.match(settingsAccountSwitchBlockedMessage({ initializationFailed: gate.isFailed() }), /初始化|重试|读取/);

  const loadedMalformed = await gate.load(async () => 'malformed', () => true);
  assert.equal(loadedMalformed.ok, false, '重试返回非对象不得返回成功');
  assert.equal(loadedMalformed.error?.code, 'invalid_settings_document');
  assert.equal(gate.isFailed(), true, '重试返回非对象后必须保持 fail-closed');

  const loadedMissingRevision = await gate.load(async () => ({}), () => true);
  assert.equal(loadedMissingRevision.ok, false, '缺少 revision 的设置对象不得被视为完整文档');
  assert.equal(loadedMissingRevision.error?.code, 'invalid_settings_document');
  assert.equal(gate.isFailed(), true, '缺少 revision 时必须保持 fail-closed');

  const loadedRepaintFailure = await gate.load(async () => ({ settings_revision: 'rev-load-failure' }), () => {
    throw new Error('loaded repaint failed');
  });
  assert.equal(loadedRepaintFailure.ok, false, '重试采用/repaint 抛错不得返回成功');
  assert.equal(gate.isFailed(), true, '重试采用/repaint 抛错后必须保持 fail-closed');

  const loadedSuccess = await gate.load(async () => ({ settings_revision: 'rev-load-success' }), settings => {
    assert.equal(settings.settings_revision, 'rev-load-success');
    return true;
  });
  assert.equal(loadedSuccess.ok, true, '重试只有完整采用成功才返回成功');
  assert.equal(gate.isFailed(), false, '成功重试后才允许清除 fail-closed');
  assert.equal(settingsAccountSwitchBlockedMessage({ initializationFailed: gate.isFailed() }), '');

  const invalid = gate.attempt(null, () => { throw new Error('不应调用采用'); });
  assert.equal(invalid.ok, false, 'null 设置响应不得被视为成功');
  assert.equal(invalid.error?.code, 'invalid_settings_document');
  assert.equal(gate.isFailed(), true, 'null 设置响应后必须保持 fail-closed');
  assert.match(settingsAccountSwitchBlockedMessage({ initializationFailed: gate.isFailed() }), /初始化|重试|读取/);

  const primitive = gate.attempt('not-a-settings-document', () => {});
  assert.equal(primitive.ok, false, '非对象设置响应不得被视为成功');
  assert.equal(gate.isFailed(), true, '非对象设置响应后必须保持 fail-closed');

  const repaintFailure = gate.attempt({ settings_revision: 'rev-1' }, () => {
    throw new Error('repaint failed');
  });
  assert.equal(repaintFailure.ok, false, 'repaint 抛错不得返回成功');
  assert.equal(gate.isFailed(), true, 'repaint 抛错后必须保持 fail-closed');
  assert.match(settingsAccountSwitchBlockedMessage({ initializationFailed: gate.isFailed() }), /初始化|重试|读取/);

  const incomplete = gate.attempt({ settings_revision: 'rev-incomplete' }, () => undefined);
  assert.equal(incomplete.ok, false, '采用函数没有明确成功结果时不得解锁');
  assert.equal(incomplete.error?.code, 'settings_adoption_incomplete');
  assert.equal(gate.isFailed(), true);

  let adopted = null;
  const success = gate.attempt({ settings_revision: 'rev-2' }, settings => {
    adopted = settings;
    return true;
  });
  assert.equal(success.ok, true, '有效 settings 文档完整采用后才算成功');
  assert.equal(adopted.settings_revision, 'rev-2');
  assert.equal(gate.isFailed(), false, '完整采用成功后才允许解锁');
  assert.equal(settingsAccountSwitchBlockedMessage({ initializationFailed: gate.isFailed() }), '');

  const staleGate = createSettingsInitializationGate();
  const staleState = { destroyed: false, generation: 1 };
  let resolveStaleSettings;
  const staleSettingsPromise = new Promise(resolve => { resolveStaleSettings = resolve; });
  let staleApplyCalls = 0;
  const staleLoad = staleGate.load(
    () => staleSettingsPromise,
    () => {
      staleApplyCalls += 1;
      return true;
    },
    { isCurrent: () => !staleState.destroyed && staleState.generation === 1 },
  );
  staleState.generation = 2;
  resolveStaleSettings({ settings_revision: 'stale-account-settings' });
  const staleResult = await staleLoad;
  assert.equal(staleResult.ok, false,
    '账号上下文变化后晚到的初始化文档不得报告成功');
  assert.equal(staleResult.stale, true,
    '账号上下文变化后的初始化结果必须明确标记 stale');
  assert.equal(staleApplyCalls, 0,
    '账号上下文变化后晚到的初始化文档不得进入 adopt/repaint');
  assert.equal(staleGate.isFailed(), true,
    '初始化文档 stale 后必须保持 fail-closed');
}

// 旧代次的刷新响应即使被初始化门控判为 stale,也不能把已经可用的
// 新账号设置页重新标成初始化失败,否则会永久锁住账号切换。
{
  const loadInitialSource = extractFunction(
    settingsSource,
    'async function loadInitialSettingsDocument(',
  );
  const state = { destroyed: false, generation: 1, initializationFailed: false };
  const initializationGate = createSettingsInitializationGate();
  const loadInitialSettingsDocument = new Function(
    'state',
    'initializationGate',
    'adoptSettingsDocument',
    `${loadInitialSource}; return loadInitialSettingsDocument;`,
  )(
    state,
    initializationGate,
    () => true,
  );
  await assert.rejects(
    loadInitialSettingsDocument(
      () => Promise.resolve().then(() => {
        state.generation = 2;
        return { settings_revision: 'stale-settings' };
      }),
      { repaint: true, preserveDirty: true },
    ),
    error => error?.code === 'settings_initialization_stale',
    '旧代次初始化文档必须继续按 stale 拒绝',
  );
  assert.equal(state.initializationFailed, false,
    'stale 初始化结果不得污染新代次的 initializationFailed 守卫');
}

assert.equal(
  requireSettingsDocument({ settings_revision: 'shared-contract-revision' }).settings_revision,
  'shared-contract-revision',
  '设置页和向导必须复用同一设置文档合同',
);
for (const malformed of [null, [], {}, { settings_revision: '' }]) {
  assert.throws(
    () => requireSettingsDocument(malformed),
    error => error?.code === 'invalid_settings_document' && error?.status === 502,
    '共享设置文档合同必须拒绝空、数组或缺少 revision 的响应',
  );
}

// 整页初始化状态机合同:旧账号代次的响应晚到时不能静默停在 skeleton;
// 必须自动以最新 generation 重试,且只有最新响应才能进入成功采用回调。
{
  let generation = 1;
  let runCount = 0;
  const pending = [];
  const applied = [];
  const failures = [];
  let skeletonVisible = true;
  let retryVisible = false;
  const lifecycle = createSettingsInitializationLifecycle({
    getGeneration: () => generation,
    isActive: () => true,
    run: capturedGeneration => {
      runCount += 1;
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      pending.push({ capturedGeneration, resolve, promise });
      return promise;
    },
    onSuccess: (value, capturedGeneration) => {
      skeletonVisible = false;
      retryVisible = false;
      applied.push({ value, capturedGeneration });
    },
    onFailure: (error, capturedGeneration) => {
      skeletonVisible = false;
      retryVisible = true;
      failures.push({ error, capturedGeneration });
    },
  });
  const running = lifecycle.start();
  assert.equal(runCount, 1, '初始化状态机首次只能启动一个当前代次加载');
  generation = 2;
  pending[0].resolve({ marker: 'account-a' });
  await nextTurn();
  await nextTurn();
  assert.equal(runCount, 2, '旧代次晚到后必须为最新账号代次重新发起加载');
  assert.equal(pending[1].capturedGeneration, 2);
  assert.deepEqual(applied, [], '旧账号代次晚到响应不得进入成功采用回调');
  assert.deepEqual(failures, [], '旧账号代次晚到不应显示初始化失败而覆盖新代次');
  pending[1].resolve({ marker: 'account-b' });
  const result = await running;
  assert.equal(result.ok, true, '最新账号代次加载成功后初始化状态机必须收敛');
  assert.deepEqual(applied, [{ value: { marker: 'account-b' }, capturedGeneration: 2 }]);
  assert.equal(skeletonVisible, false, '最新代次成功后不得遗留旧 skeleton');
  assert.equal(retryVisible, false, '最新代次成功后不得错误显示重试状态');
}

assert.match(settingsSource, /initializationGate\.load\(/,
  '设置页首次读取与重试必须通过同一异步初始化加载门控');
assert.match(settingsSource,
  /async function loadInitialSettingsDocument\([\s\S]*?const generation = state\.generation[\s\S]*?isCurrent:/,
  '设置页初始化门控必须用 generation 过滤账号上下文变化后的晚到文档');
assert.match(settingsSource, /createSettingsInitializationLifecycle\(/,
  '设置页整页初始化必须使用 generation 协调状态机,不能在旧代次分支静默 return');

// 程序化账号变化不能依赖旧请求的 finally 才释放全页 busy；API 即使忽略 abort
// 或永不 settle，新账号也必须立即拿回设置页控制权。旧 finally 随后不得重复写 UI。
{
  const controller = new AbortController();
  let cleanupCalls = 0;
  let busySyncCalls = 0;
  const token = {
    controller,
    signal: controller.signal,
    cleanup() { cleanupCalls += 1; },
  };
  controller.signal.addEventListener('abort', token.cleanup, { once: true });
  const state = { destroyed: false, generation: 4, actions: new Set([token]) };
  const released = invalidateSettingsActionsForAccountChange(
    state,
    '账号上下文已变化',
    { onActionsReleased: () => { busySyncCalls += 1; } },
  );
  assert.equal(controller.signal.aborted, true, '账号变化必须立即 abort 旧设置 action');
  assert.equal(released, 1, '账号变化必须报告并释放自己持有的旧 action');
  assert.equal(state.actions.size, 0,
    '忽略 abort 或永不 settle 的旧请求不得继续占用新账号全页 busy');
  assert.equal(cleanupCalls, 1, '账号变化必须恰好清理一次 action 级监听器');
  assert.equal(busySyncCalls, 1, '释放旧 action 后必须立即重算新账号按钮 busy');

  let staleUiWrites = 0;
  const staleCompleted = completeSettingsAction({
    actions: state.actions,
    token,
    destroyed: false,
    syncBusy() { staleUiWrites += 1; },
    restoreFocus() { staleUiWrites += 1; },
  });
  assert.equal(staleCompleted, false, '旧请求晚到 finally 不再持有 action');
  assert.equal(staleUiWrites, 0, '旧 finally 不得同步或恢复新账号页面 UI');
}

// 重新载入设置的真实 owner 边界：A 请求忽略 abort 并晚到时，旧 finally
// 不得改写 B 的 trigger/busy，也不得把焦点拉回旧动作。
{
  const refreshSource = extractFunction(settingsSource, 'async function refreshFromServer(');
  let resolveRequest;
  const request = new Promise(resolve => { resolveRequest = resolve; });
  const controller = new AbortController();
  const oldToken = {
    generation: 1,
    controller,
    signal: controller.signal,
    focusTarget: {},
    cleanup() {},
  };
  const state = {
    destroyed: false,
    generation: 1,
    actions: new Set([oldToken]),
    stale: true,
    staleDismissedRevision: 'old',
  };
  let triggerWrites = 0;
  let triggerDisabled = true;
  const trigger = {
    isConnected: true,
    get disabled() { return triggerDisabled; },
    set disabled(value) { triggerWrites += 1; triggerDisabled = value; },
  };
  let focusCalls = 0;
  let hideNoticeCalls = 0;
  let adoptCalls = 0;
  const refreshFromServer = new Function(
    'state',
    'beginAction',
    'api',
    'alive',
    'loadInitialSettingsDocument',
    'hideNotice',
    'ui',
    'isAbortError',
    'endAction',
    'isBusy',
    'restoreActionFocus',
    `${refreshSource}; return refreshFromServer;`,
  )(
    state,
    () => oldToken,
    { get: () => request },
    token => !state.destroyed && token.generation === state.generation,
    async () => { adoptCalls += 1; },
    () => { hideNoticeCalls += 1; },
    { toastSuccess() {}, toastError() {} },
    error => error?.name === 'AbortError',
    token => completeSettingsAction({
      actions: state.actions,
      token,
      destroyed: state.destroyed,
      syncBusy() { throw new Error('旧 owner 不得同步 B 页面 busy'); },
      restoreFocus() { throw new Error('旧 owner 不得恢复 B 页面焦点'); },
    }),
    () => state.actions.size > 0,
    () => { focusCalls += 1; },
  );

  const pending = refreshFromServer({ announce: true, trigger });
  await Promise.resolve();
  invalidateSettingsActionsForAccountChange(state);
  const newToken = { generation: state.generation, controller: new AbortController() };
  state.actions.add(newToken);
  resolveRequest({ settings_revision: 'account-a-late' });
  assert.equal(await pending, false, 'A 的晚到刷新不得报告为 B 的成功刷新');
  assert.equal(adoptCalls, 0, 'A 的晚到设置文档不得采用到 B');
  assert.equal(hideNoticeCalls, 0, 'A 的晚到响应不得清除 B 的更新提示');
  assert.equal(triggerWrites, 0, 'A 的 finally 不得改写 B 页面 trigger disabled');
  assert.equal(focusCalls, 0, 'A 的 finally 不得恢复 B 页面焦点');
  assert.equal(state.actions.has(newToken), true, 'A 的 finally 不得释放 B action');
}

// 多分区保存序列的真实账号代际边界:第一个分区保存等待期间账号变化后,
// 旧的 save-all 协程不得继续保存后续分区或刷新当前账号文档。
{
  const saveAllSource = extractFunction(settingsSource, 'async function saveAllDraftsThenReload(');
  let resolveFirst;
  let firstCalls = 0;
  let secondCalls = 0;
  let refreshCalls = 0;
  const firstSave = new Promise(resolve => { resolveFirst = resolve; });
  const state = { destroyed: false, generation: 1, actions: new Set() };
  const sections = [
    { saveDraft: () => { firstCalls += 1; return firstSave; } },
    { saveDraft: () => { secondCalls += 1; return Promise.resolve(); } },
  ];
  const saveAllDraftsThenReload = new Function(
    'state',
    'sections',
    'isBusy',
    'hasUnsavedDrafts',
    'ui',
    'refreshFromServer',
    'scheduleStablePageFocus',
    `${saveAllSource}; return saveAllDraftsThenReload;`,
  )(
    state,
    sections,
    () => false,
    () => false,
    { toastWarn() {} },
    async () => { refreshCalls += 1; return true; },
    () => {},
  );
  const running = saveAllDraftsThenReload();
  await Promise.resolve();
  assert.equal(firstCalls, 1, 'save-all 必须先进入第一个分区保存');
  invalidateSettingsActionsForAccountChange(state);
  resolveFirst();
  await running;
  assert.equal(secondCalls, 0,
    '账号代际变化后旧 save-all 协程不得继续保存后续分区');
  assert.equal(refreshCalls, 0,
    '账号代际变化后旧 save-all 协程不得刷新当前账号设置文档');
}

// “放弃草稿并刷新”确认框不属于 beginAction；确认等待期间账号上下文变化后，
// 旧对话框返回不得在目标账号上执行刷新或恢复焦点。
{
  const confirmReloadSource = extractFunction(settingsSource, 'async function confirmReloadDiscardingDrafts(');
  let resolveConfirmation;
  const confirmation = new Promise(resolve => { resolveConfirmation = resolve; });
  const state = { destroyed: false, generation: 1, actions: new Set() };
  let refreshCalls = 0;
  let focusCalls = 0;
  const confirmReloadDiscardingDrafts = new Function(
    'state',
    'hasUnsavedDrafts',
    'ui',
    'refreshFromServer',
    'scheduleStablePageFocus',
    `${confirmReloadSource}; return confirmReloadDiscardingDrafts;`,
  )(
    state,
    () => true,
    { confirmDialog: () => confirmation },
    async () => { refreshCalls += 1; return true; },
    () => { focusCalls += 1; },
  );
  const running = confirmReloadDiscardingDrafts();
  await Promise.resolve();
  invalidateSettingsActionsForAccountChange(state);
  resolveConfirmation(true);
  await running;
  assert.equal(refreshCalls, 0,
    '旧账号确认框返回后不得刷新新账号设置文档');
  assert.equal(focusCalls, 0,
    '旧账号确认框返回后不得恢复新账号页面焦点');
}

const scope = createAccountChangeScope('account-a');
const oldRequest = scope.capture();
assert.equal(scope.isCurrent(oldRequest, 'account-a'), true);

const initiallyUnbound = createAccountChangeScope();
const initialRequest = initiallyUnbound.ensure('account-a');
assert.equal(initiallyUnbound.isCurrent(initialRequest, 'account-a'), true,
  '第一次请求必须先绑定当前账号,不能被空初始作用域误判为旧请求');

scope.switchTo('account-b');
assert.equal(scope.isCurrent(oldRequest, 'account-b'), false,
  '账号切换后旧请求不得继续写当前账号页面');
assert.equal(scope.isCurrent(oldRequest, 'account-a'), false,
  '旧请求即使携带旧账号 ID 也不得绕过账号代际');

const currentRequest = scope.capture();
assert.equal(scope.isCurrent(currentRequest, 'account-b'), true);
scope.switchTo('account-b');
assert.equal(scope.isCurrent(currentRequest, 'account-b'), false,
  '同一账号重新发现新身份时也必须使旧请求失效');

console.log('web settings account switch tests passed');
