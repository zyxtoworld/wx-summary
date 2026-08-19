import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { requireGroupList } from '../src/web/public/js/shared/group-list-contract.js';
import { requireServiceStatePayload } from '../src/web/public/js/shared/service-state.js';
import { requireSettingsDocument } from '../src/web/public/js/shared/settings-document.js';

let mutationCount = 0;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function descendantText(node) {
  return [
    String(node?.textContent || ''),
    ...(Array.isArray(node?.children) ? node.children.map(descendantText) : []),
  ].join('');
}

function findElementByText(node, text) {
  if (String(node?.textContent || '') === text) return node;
  for (const child of node?.children || []) {
    const match = findElementByText(child, text);
    if (match) return match;
  }
  return null;
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.hidden = false;
    this.listeners = new Map();
    this.attributes = new Map();
    this._disabled = false;
  }

  get disabled() { return this._disabled; }
  set disabled(value) {
    this._disabled = value === true;
    mutationCount += 1;
  }

  append(...children) {
    this.children.push(...children);
    mutationCount += 1;
  }

  appendChild(child) {
    this.children.push(child);
    mutationCount += 1;
    return child;
  }

  replaceChildren(...children) {
    this.children = [...children];
    mutationCount += 1;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
}

globalThis.document = {
  createElement(tagName) { return new FakeElement(tagName); },
};
globalThis.__testRequireGroupList = requireGroupList;
globalThis.__testRequireServiceStatePayload = requireServiceStatePayload;
globalThis.__testRequireSettingsDocument = requireSettingsDocument;

let source = await readFile(
  new URL('../src/web/public/js/pages/setup/step-finish.js', import.meta.url),
  'utf8',
);
const setupIndexSource = await readFile(
  new URL('../src/web/public/js/pages/setup/index.js', import.meta.url),
  'utf8',
);
source = source.replace(
  /import \{[\s\S]*?\} from '\.\/state\.js';/,
  `const applyWizardAccountState = (_store, wiz, state) => {
    wiz.state = state;
    wiz.__adoptedStates?.push(state);
  };
const accountIdOf = account => String(account?.id || '');
const accountFingerprintOf = account => String(account?.manual_key_account_fingerprint || '').trim().toLowerCase();
const stateMatchesAccountContext = (state, account) => {
  const accountId = accountIdOf(account);
  if (!accountId) return false;
  const stateAccount = (Array.isArray(state?.wechat?.accounts) ? state.wechat.accounts : [])
    .find(candidate => accountIdOf(candidate) === accountId);
  if (!stateAccount) return false;
  const expectedFingerprint = accountFingerprintOf(account);
  return !expectedFingerprint || accountFingerprintOf(stateAccount) === expectedFingerprint;
};
const compactErrorSummary = value => String(value || '');`,
);
source = source.replace(
  "import { configureLiveRegion } from '/js/ui/live-region.js';",
  'const configureLiveRegion = node => node;',
);
source = source.replace(
  "import { captureActionFocus, restoreActionFocus } from '/js/shared/action-focus.js';",
  'const captureActionFocus = () => null; const restoreActionFocus = () => false;',
);
source = source.replace(
  "import { requireGroupList } from '/js/shared/group-list-contract.js';",
  'const requireGroupList = globalThis.__testRequireGroupList;',
);
source = source.replace(
  "import { requireServiceStatePayload } from '/js/shared/service-state.js';",
  'const requireServiceStatePayload = globalThis.__testRequireServiceStatePayload;',
);
source = source.replace(
  "import { requireSettingsDocument } from '/js/shared/settings-document.js';",
  'const requireSettingsDocument = globalThis.__testRequireSettingsDocument;',
);
source = source.replace(
  /import \{[\s\S]*?\} from '\/js\/shared\/whitelist-contract\.js';/,
  `const canonicalWhitelistRef = (ref, accountId = '') => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
    const account = String(ref.account_id || accountId || '').trim();
    const groupId = String(ref.group_id || '').trim();
    const groupName = String(ref.group_name || '').trim();
    if (!account || (!groupId && !groupName)) return null;
    return { account_id: account, ...(groupId ? { group_id: groupId } : {}), ...(groupName ? { group_name: groupName } : {}) };
  };
const whitelistRefKey = ref => typeof ref === 'string'
  ? \`legacy:\${ref}\`
  : \`\${String(ref?.account_id || '').trim()}::\${ref?.group_id ? \`id:\${String(ref.group_id).trim()}\` : \`name:\${String(ref?.group_name || '').trim()}\`}\`;
const groupRefFromGroup = (group, accountId) => ({
  account_id: String(accountId || ''),
  group_id: String(group?.id || ''),
  group_name: String(group?.name || group?.id || ''),
});
const groupDisplayName = group => String(group?.name || group?.id || '(未命名群)');`,
);
assert.doesNotMatch(source, /from '\/js\/shared\/whitelist-contract\.js'/,
  'step finish harness must inject the shared whitelist contract');
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const { createFinishStep } = await import(moduleUrl);

let resolveGroups;
const groupsPending = new Promise(resolve => { resolveGroups = resolve; });
let groupRequests = 0;
let stateRequests = 0;
let generation = 0;
let destroyed = false;
const navigations = [];
const controller = new AbortController();
const wiz = {
  account: { id: 'fixture-account' },
  accounts: [{ id: 'fixture-account' }],
  state: { scheduler: {} },
  groups: null,
};
const ctx = {
  api: {
    get(url) {
      if (url.startsWith('/api/groups?')) {
        groupRequests += 1;
        return groupsPending;
      }
      if (url.startsWith('/api/state?')) {
        stateRequests += 1;
        return Promise.resolve({
          need_setup: false,
          scheduler: {},
          wechat: { accounts: [{ id: 'fixture-account' }], account_count: 1 },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    },
  },
  store: { set() {} },
  ui: { spinner: () => new FakeElement('spinner') },
  navigate(hash) {
    navigations.push(hash);
    destroyed = true;
    controller.abort();
  },
};
const w = {
  ctx,
  wiz,
  get destroyed() { return destroyed; },
  signal: controller.signal,
  beginAsync() { generation += 1; return generation; },
  alive(token) { return !destroyed && token === generation; },
  applyAccountIdentityUpgrade() {},
  refreshButtons() {},
  gotoStep() {},
};

const step = createFinishStep(w);
step.onEnter();
assert.equal(groupRequests, 1, '进入完成步骤应在后台开始读取群列表');
assert.notEqual(step.isBusy?.(), true,
  '可选的群列表后台读取不能阻塞“完成”复核');

const finished = step.isBusy?.() === true ? false : await step.finish();
assert.equal(finished, true, '群列表仍在读取时应可立即完成配置');
assert.equal(stateRequests, 1, '完成操作应恰好复核一次当前账号状态');
assert.deepEqual(navigations, ['#/digest']);

const mutationsAfterUnmount = mutationCount;
resolveGroups({ groups: [{ id: 'fixture-group', name: 'fixture-group' }] });
await new Promise(resolve => setImmediate(resolve));
assert.equal(mutationCount, mutationsAfterUnmount,
  '完成离页后，过期群列表请求不得再写向导 DOM');

// 点击“完成”会开启新的向导 async generation,但页面尚未必立即被路由卸载。
// 群列表请求即使忽略 abort 并晚到,也不得趁这个窗口把旧 loading owner 的
// groups/status 写回当前步骤。
{
  const finishRaceGroups = deferred();
  const finishRaceState = deferred();
  let finishRaceGeneration = 0;
  let finishRaceDestroyed = false;
  const finishRaceAccount = { id: 'finish-race-account' };
  const finishRaceWiz = {
    account: finishRaceAccount,
    accounts: [finishRaceAccount],
    state: { scheduler: {} },
    groups: null,
  };
  const finishRaceCtx = {
    api: {
      get(url) {
        if (url.startsWith('/api/groups?')) return finishRaceGroups.promise;
        if (url.startsWith('/api/state?')) return finishRaceState.promise;
        throw new Error(`unexpected finish-race request: ${url}`);
      },
    },
    store: { set() {} },
    ui: { spinner: () => new FakeElement('spinner') },
  };
  const finishRaceW = {
    ctx: finishRaceCtx,
    wiz: finishRaceWiz,
    get destroyed() { return finishRaceDestroyed; },
    signal: new AbortController().signal,
    beginAsync() { finishRaceGeneration += 1; return finishRaceGeneration; },
    alive(token) { return !finishRaceDestroyed && token === finishRaceGeneration; },
    applyAccountIdentityUpgrade() {},
    refreshButtons() {},
    gotoStep() {},
  };
  const finishRaceStep = createFinishStep(finishRaceW);
  finishRaceStep.onEnter();
  const finishPending = finishRaceStep.finish();
  const mutationsBeforeLateGroups = mutationCount;
  finishRaceGroups.resolve({
    groups: [{ id: 'late-finish-group', name: 'late-finish-group' }],
    account_id: finishRaceAccount.id,
    account_fingerprint: '',
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finishRaceWiz.groups, null,
    '完成复核换代后,旧群列表响应不得写入向导缓存');
  assert.equal(mutationCount, mutationsBeforeLateGroups,
    '完成复核在途时,旧群列表响应不得写入当前步骤 DOM');
  finishRaceState.resolve({
    need_setup: true,
    need_setup_reason: 'llm_model_missing',
    scheduler: {},
    wechat: { accounts: [{ id: finishRaceAccount.id }], account_count: 1 },
  });
  assert.equal(await finishPending, false,
    '状态仍需配置时,完成复核应留在向导而不跳转');
  finishRaceDestroyed = true;
}

// 完成复核已经开启新 owner 后,旧群请求携带的账号身份升级也必须失效。
// 不能只在普通 groups 投影前检查:account_identity_upgrade 分支本身会先改写 wiz.account。
{
  const staleUpgradeGroups = deferred();
  const staleUpgradeState = deferred();
  let staleUpgradeGeneration = 0;
  let staleUpgradeDestroyed = false;
  let upgradeCalls = 0;
  const staleUpgradeAccountA = {
    id: 'stale-upgrade-account',
    manual_key_account_fingerprint: 'stale-upgrade-fingerprint-a',
  };
  const staleUpgradeAccountB = {
    id: 'stale-upgrade-account',
    manual_key_account_fingerprint: 'stale-upgrade-fingerprint-b',
  };
  const staleUpgradeWiz = {
    account: staleUpgradeAccountA,
    accounts: [staleUpgradeAccountA],
    state: { scheduler: {} },
    groups: null,
  };
  const staleUpgradeCtx = {
    api: {
      get(url) {
        if (url.startsWith('/api/groups?')) return staleUpgradeGroups.promise;
        if (url.startsWith('/api/state?')) return staleUpgradeState.promise;
        throw new Error(`unexpected stale-upgrade request: ${url}`);
      },
    },
    store: { set() {} },
    ui: { spinner: () => new FakeElement('spinner') },
  };
  const staleUpgradeW = {
    ctx: staleUpgradeCtx,
    wiz: staleUpgradeWiz,
    get destroyed() { return staleUpgradeDestroyed; },
    signal: new AbortController().signal,
    beginAsync() { staleUpgradeGeneration += 1; return staleUpgradeGeneration; },
    alive(token) { return !staleUpgradeDestroyed && token === staleUpgradeGeneration; },
    applyAccountIdentityUpgrade(account, { ownerToken = null } = {}) {
      upgradeCalls += 1;
      if (ownerToken !== null && !staleUpgradeW.alive(ownerToken)) return false;
      staleUpgradeWiz.account = account;
      staleUpgradeWiz.accounts = [account];
      return true;
    },
    refreshButtons() {},
    gotoStep() {},
  };
  const staleUpgradeStep = createFinishStep(staleUpgradeW);
  staleUpgradeStep.onEnter();
  const finishDuringGroups = staleUpgradeStep.finish();
  staleUpgradeGroups.resolve({
    groups: [{ id: 'stale-upgrade-group', name: 'stale-upgrade-group' }],
    account_id: staleUpgradeAccountB.id,
    account_fingerprint: staleUpgradeAccountB.manual_key_account_fingerprint,
    account_identity_upgrade: {
      previous_fingerprint: staleUpgradeAccountA.manual_key_account_fingerprint,
      next_fingerprint: staleUpgradeAccountB.manual_key_account_fingerprint,
    },
    account: staleUpgradeAccountB,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(upgradeCalls, 0,
    '完成复核启动后,旧群响应不得再进入账号身份升级分支');
  assert.equal(staleUpgradeWiz.account, staleUpgradeAccountA,
    '完成复核启动后,旧群响应不得改写当前向导账号');
  staleUpgradeState.resolve({
    need_setup: true,
    need_setup_reason: 'llm_model_missing',
    scheduler: {},
    wechat: { accounts: [staleUpgradeAccountA], account_count: 1 },
  });
  assert.equal(await finishDuringGroups, false,
    '完成复核仍应按发起时账号完成校验,而不是被旧群响应改写');
  staleUpgradeDestroyed = true;
}

const leavingGroupRequests = [];
let leavingDestroyed = false;
const leavingWiz = {
  account: { id: 'fixture-account' },
  accounts: [{ id: 'fixture-account' }],
  state: { scheduler: {} },
  groups: null,
};
const leavingCtx = {
  api: {
    get(url, options = {}) {
      if (url.startsWith('/api/groups?')) {
        const request = deferred();
        leavingGroupRequests.push({ ...request, signal: options.signal });
        return request.promise;
      }
      throw new Error(`unexpected leaving-step request: ${url}`);
    },
  },
  store: { set() {} },
  ui: { spinner: () => new FakeElement('spinner') },
};
const leavingW = {
  ctx: leavingCtx,
  wiz: leavingWiz,
  get destroyed() { return leavingDestroyed; },
  signal: new AbortController().signal,
  beginAsync() { return 1; },
  alive() { return !leavingDestroyed; },
  applyAccountIdentityUpgrade() {},
  refreshButtons() {},
  gotoStep() {},
};
const leavingStep = createFinishStep(leavingW);
leavingStep.onEnter();
assert.equal(leavingGroupRequests.length, 1, '离开步骤场景必须先启动群列表请求');
assert.equal(leavingGroupRequests[0].signal?.aborted, false,
  '完成步骤在途群列表请求必须暴露独立的可取消 signal');
leavingStep.onExit?.();
assert.equal(leavingGroupRequests[0].signal?.aborted, true,
  '离开完成步骤必须立即取消仍在途的群列表 I/O，不能只让晚到响应失效');
const mutationsAfterStepLeave = mutationCount;
leavingGroupRequests[0].resolve({ groups: [{ id: 'late-group', name: 'late-group' }] });
await new Promise(resolve => setImmediate(resolve));
assert.equal(mutationCount, mutationsAfterStepLeave,
  '离开完成步骤后，晚到群列表不得再写该步骤 DOM');

leavingStep.onEnter();
assert.equal(leavingGroupRequests.length, 2,
  '重新进入完成步骤必须允许新代次立即发起群列表请求');
assert.notStrictEqual(leavingGroupRequests[1].signal, leavingGroupRequests[0].signal,
  '重新进入完成步骤必须使用新的请求 signal，不能复用已取消代次');
assert.equal(leavingGroupRequests[1].signal?.aborted, false,
  '新代次群列表请求开始时必须保持可用');
leavingStep.onExit?.();
assert.equal(leavingGroupRequests[1].signal?.aborted, true,
  '再次离开完成步骤也必须取消自己当前持有的请求');
const mutationsAfterSecondLeave = mutationCount;
leavingGroupRequests[1].resolve({ groups: [{ id: 'second-late-group', name: 'second-late-group' }] });
await new Promise(resolve => setImmediate(resolve));
assert.equal(mutationCount, mutationsAfterSecondLeave,
  '重新进入后的请求晚到也不得在第二次离步后写 DOM');

let resolveRaceState;
const raceStatePending = new Promise(resolve => { resolveRaceState = resolve; });
const raceAccountA = { id: 'race-account', manual_key_account_fingerprint: 'race-fingerprint-a' };
const raceAccountB = { id: 'race-account', manual_key_account_fingerprint: 'race-fingerprint-b' };
const raceStateFromA = {
  marker: 'race-state-a',
  need_setup: false,
  wechat: { accounts: [raceAccountA], account_count: 1 },
};
let raceGeneration = 0;
let raceDestroyed = false;
let raceStateRequests = 0;
const raceNavigations = [];
const raceController = new AbortController();
const raceWiz = {
  account: raceAccountA,
  accounts: [raceAccountA],
  state: { scheduler: {} },
  groups: null,
  __adoptedStates: [],
};
const raceCtx = {
  api: {
    get(url) {
      if (url.startsWith('/api/groups?')) {
        return Promise.resolve({
          groups: [],
          account_identity_upgrade: { previous_fingerprint: raceAccountA.manual_key_account_fingerprint, next_fingerprint: raceAccountB.manual_key_account_fingerprint },
          account: raceAccountB,
        });
      }
      if (url.startsWith('/api/state?')) {
        raceStateRequests += 1;
        return raceStatePending;
      }
      throw new Error(`unexpected race request: ${url}`);
    },
  },
  store: { set() {} },
  ui: { spinner: () => new FakeElement('spinner') },
  navigate(hash) {
    raceNavigations.push(hash);
    raceDestroyed = true;
  },
};
const raceW = {
  ctx: raceCtx,
  wiz: raceWiz,
  get destroyed() { return raceDestroyed; },
  signal: raceController.signal,
  beginAsync() { raceGeneration += 1; return raceGeneration; },
  alive(token) { return !raceDestroyed && token === raceGeneration; },
  applyAccountIdentityUpgrade(account) { raceWiz.account = account; },
  refreshButtons() {},
  gotoStep() {},
};
const raceStep = createFinishStep(raceW);
raceStep.onEnter();
const raceFinish = raceStep.finish();
await new Promise(resolve => setImmediate(resolve));
assert.equal(raceStateRequests, 1, '完成竞态必须发出状态复核请求');
assert.equal(raceWiz.account, raceAccountA,
  '完成复核启动后,旧群响应不得改写向导账号');
resolveRaceState(raceStateFromA);
const raceFinished = await raceFinish;
assert.equal(raceFinished, true,
  '完成复核应按自己的 A owner 采用精确匹配的状态并继续完成');
assert.deepEqual(raceWiz.__adoptedStates, [raceStateFromA],
  '完成 owner 的 A state 必须正常采用');
assert.deepEqual(raceNavigations, ['#/digest'],
  '完成 owner 的 A state 通过后应正常跳转总结页');
raceDestroyed = true;
raceController.abort();

const ownerContractFailures = [];
function ownerContract(condition, message) {
  if (!condition) ownerContractFailures.push(message);
}

let cachedGroupRequests = 0;
let cachedDestroyed = false;
const cachedAccountA = { id: 'cached-account', manual_key_account_fingerprint: 'cached-fingerprint-a' };
const cachedAccountB = { id: 'cached-account', manual_key_account_fingerprint: 'cached-fingerprint-b' };
const cachedWiz = {
  account: cachedAccountB,
  accounts: [cachedAccountB],
  state: { scheduler: {} },
  groups: {
    account_id: cachedAccountA.id,
    account_fingerprint: cachedAccountA.manual_key_account_fingerprint,
    count: 1,
    preview: [{ id: 'cached-old-group', name: 'cached-old-group' }],
    error: '',
  },
};
const cachedCtx = {
  api: {
    get(url) {
      if (!url.startsWith('/api/groups?')) throw new Error(`unexpected cached request: ${url}`);
      cachedGroupRequests += 1;
      return Promise.resolve({
        groups: [{ id: 'cached-new-group', name: 'cached-new-group' }],
        account_id: cachedAccountB.id,
        account_fingerprint: cachedAccountB.manual_key_account_fingerprint,
      });
    },
  },
  store: { set() {} },
  ui: { spinner: () => new FakeElement('spinner') },
};
const cachedW = {
  ctx: cachedCtx,
  wiz: cachedWiz,
  get destroyed() { return cachedDestroyed; },
  signal: new AbortController().signal,
  beginAsync() { return 1; },
  alive() { return !cachedDestroyed; },
  applyAccountIdentityUpgrade(account) { cachedWiz.account = account; },
  refreshButtons() {},
  gotoStep() {},
};
const cachedStep = createFinishStep(cachedW);
cachedStep.onEnter();
ownerContract(cachedGroupRequests === 1,
  '当前 B 不得复用同 ID A 指纹的群缓存,必须重新加载');
await new Promise(resolve => setImmediate(resolve));
ownerContract(cachedWiz.groups.account_fingerprint === cachedAccountB.manual_key_account_fingerprint,
  '重新加载成功后的群缓存必须归属于 B 指纹');
cachedDestroyed = true;

let cachedReloadRequest = null;
let cachedReloadRequests = 0;
let cachedReloadGeneration = 0;
let cachedReloadDestroyed = false;
const cachedReloadAccount = {
  id: 'cached-reload-account',
  manual_key_account_fingerprint: 'cached-reload-fingerprint',
};
const cachedReloadWiz = {
  account: cachedReloadAccount,
  accounts: [cachedReloadAccount],
  state: { scheduler: {} },
  groups: {
    account_id: cachedReloadAccount.id,
    account_fingerprint: cachedReloadAccount.manual_key_account_fingerprint,
    count: 1,
    preview: [{ id: 'cached-reload-group', name: 'cached-reload-group' }],
    error: '',
  },
};
const cachedReloadStep = createFinishStep({
  ctx: {
    api: {
      get(url, options = {}) {
        if (!url.startsWith('/api/groups?')) throw new Error(`unexpected cached-reload request: ${url}`);
        cachedReloadRequests += 1;
        cachedReloadRequest = deferred();
        cachedReloadRequest.signal = options.signal;
        return cachedReloadRequest.promise;
      },
    },
    store: { set() {} },
    ui: { spinner: () => new FakeElement('spinner') },
  },
  wiz: cachedReloadWiz,
  get destroyed() { return cachedReloadDestroyed; },
  signal: new AbortController().signal,
  beginAsync() { cachedReloadGeneration += 1; return cachedReloadGeneration; },
  alive(token) { return !cachedReloadDestroyed && token === cachedReloadGeneration; },
  applyAccountIdentityUpgrade() {},
  refreshButtons() {},
  gotoStep() {},
});
cachedReloadStep.onEnter();
const cachedReloadButton = findElementByText(cachedReloadStep.el, '重新加载群列表');
ownerContract(cachedReloadButton, '已有群缓存时必须能找到重新加载入口');
cachedReloadButton.listeners.get('click')?.();
await Promise.resolve();
ownerContract(cachedReloadRequests === 1,
  '已有缓存点击重新加载必须启动新的群列表请求');
ownerContract(cachedReloadButton.disabled === true,
  '重新加载请求在途时按钮必须禁用');
cachedReloadStep.onExit();
ownerContract(cachedReloadRequest?.signal?.aborted === true,
  '离开步骤必须取消已有缓存触发的重新加载请求');
cachedReloadStep.onEnter();
ownerContract(cachedReloadButton.disabled === false,
  '取消缓存刷新后再次进入步骤,旧缓存仍可用时重新加载按钮必须恢复可用');
cachedReloadRequest?.resolve({
  groups: [{ id: 'late-cached-reload-group', name: 'late-cached-reload-group' }],
  account_id: cachedReloadAccount.id,
  account_fingerprint: cachedReloadAccount.manual_key_account_fingerprint,
});
await new Promise(resolve => setImmediate(resolve));
cachedReloadDestroyed = true;

let mismatchedRequestUrl = '';
let mismatchedDestroyed = false;
const mismatchedAccountA = {
  id: 'mismatched-account',
  manual_key_account_fingerprint: 'mismatched-fingerprint-a',
};
const mismatchedAccountB = {
  id: 'mismatched-account',
  manual_key_account_fingerprint: 'mismatched-fingerprint-b',
};
const mismatchedWiz = {
  account: mismatchedAccountB,
  accounts: [mismatchedAccountB],
  state: { scheduler: {} },
  groups: null,
};
const mismatchedCtx = {
  api: {
    get(url) {
      mismatchedRequestUrl = url;
      return Promise.resolve({
        groups: [{ id: 'mismatched-old-group', name: 'mismatched-old-group' }],
        account_id: mismatchedAccountA.id,
        account_fingerprint: mismatchedAccountA.manual_key_account_fingerprint,
      });
    },
  },
  store: { set() {} },
  ui: { spinner: () => new FakeElement('spinner') },
};
const mismatchedW = {
  ctx: mismatchedCtx,
  wiz: mismatchedWiz,
  get destroyed() { return mismatchedDestroyed; },
  signal: new AbortController().signal,
  beginAsync() { return 1; },
  alive() { return !mismatchedDestroyed; },
  applyAccountIdentityUpgrade(account) { mismatchedWiz.account = account; },
  refreshButtons() {},
  gotoStep() {},
};
const mismatchedStep = createFinishStep(mismatchedW);
mismatchedStep.onEnter();
await new Promise(resolve => setImmediate(resolve));
const mismatchedUrl = new URL(mismatchedRequestUrl, 'http://127.0.0.1');
ownerContract(
  mismatchedUrl.searchParams.get('expected_account_fingerprint')
    === mismatchedAccountB.manual_key_account_fingerprint,
  'B 的群列表请求必须把完整账号指纹交给服务端校验',
);
ownerContract(mismatchedWiz.groups === null,
  '没有合法身份升级时,A 指纹的 200 响应不得被缓存成 B 的群列表');
mismatchedDestroyed = true;

let upgradedRequestUrl = '';
let upgradedDestroyed = false;
const upgradedAccountA = {
  id: 'upgraded-account',
  manual_key_account_fingerprint: 'upgraded-fingerprint-a',
};
const upgradedAccountB = {
  id: 'upgraded-account',
  manual_key_account_fingerprint: 'upgraded-fingerprint-b',
};
const upgradedWiz = {
  account: upgradedAccountA,
  accounts: [upgradedAccountA],
  state: { scheduler: {} },
  groups: null,
};
const upgradedCtx = {
  api: {
    get(url) {
      upgradedRequestUrl = url;
      return Promise.resolve({
        groups: [{ id: 'upgraded-current-group', name: 'upgraded-current-group' }],
        account_id: upgradedAccountB.id,
        account_fingerprint: upgradedAccountB.manual_key_account_fingerprint,
        account_identity_upgrade: {
          previous_fingerprint: upgradedAccountA.manual_key_account_fingerprint,
          next_fingerprint: upgradedAccountB.manual_key_account_fingerprint,
        },
        account: upgradedAccountB,
      });
    },
  },
  store: { set() {} },
  ui: { spinner: () => new FakeElement('spinner') },
};
const upgradedW = {
  ctx: upgradedCtx,
  wiz: upgradedWiz,
  get destroyed() { return upgradedDestroyed; },
  signal: new AbortController().signal,
  beginAsync() { return 1; },
  alive() { return !upgradedDestroyed; },
  async applyAccountIdentityUpgrade(account) {
    upgradedWiz.account = account;
    upgradedWiz.accounts = [account];
    return true;
  },
  refreshButtons() {},
  gotoStep() {},
};
const upgradedStep = createFinishStep(upgradedW);
upgradedStep.onEnter();
await new Promise(resolve => setImmediate(resolve));
const upgradedUrl = new URL(upgradedRequestUrl, 'http://127.0.0.1');
ownerContract(
  upgradedUrl.searchParams.get('expected_account_fingerprint')
    === upgradedAccountA.manual_key_account_fingerprint,
  '身份升级请求必须校验发起时的 A 指纹',
);
ownerContract(
  upgradedWiz.groups?.account_fingerprint === upgradedAccountB.manual_key_account_fingerprint,
  '合法 A→B 身份升级完成后,群缓存必须归属于升级后的 B 指纹',
);
upgradedDestroyed = true;

// 身份升级已经把当前账号从 A 绑定到 B 后，随后发现群数组畸形仍属于 B 当前动作。
// 不能继续拿 A identity 把合同错误误判为 stale 并静默清掉加载提示。
let malformedUpgradeDestroyed = false;
const malformedUpgradeAccountA = {
  id: 'malformed-upgrade-account',
  manual_key_account_fingerprint: 'malformed-upgrade-fingerprint-a',
};
const malformedUpgradeAccountB = {
  id: 'malformed-upgrade-account',
  manual_key_account_fingerprint: 'malformed-upgrade-fingerprint-b',
};
const malformedUpgradeWiz = {
  account: malformedUpgradeAccountA,
  accounts: [malformedUpgradeAccountA],
  state: { scheduler: {} },
  groups: null,
};
const malformedUpgradeStep = createFinishStep({
  ctx: {
    api: {
      async get(url) {
        if (!url.startsWith('/api/groups?')) throw new Error(`unexpected malformed-upgrade request: ${url}`);
        return {
          groups: null,
          account_id: malformedUpgradeAccountB.id,
          account_fingerprint: malformedUpgradeAccountB.manual_key_account_fingerprint,
          account_identity_upgrade: {
            previous_fingerprint: malformedUpgradeAccountA.manual_key_account_fingerprint,
            next_fingerprint: malformedUpgradeAccountB.manual_key_account_fingerprint,
          },
          account: malformedUpgradeAccountB,
        };
      },
    },
    store: { set() {} },
    ui: { spinner: () => new FakeElement('spinner') },
  },
  wiz: malformedUpgradeWiz,
  get destroyed() { return malformedUpgradeDestroyed; },
  signal: new AbortController().signal,
  beginAsync() { return 1; },
  alive() { return !malformedUpgradeDestroyed; },
  async applyAccountIdentityUpgrade(account) {
    malformedUpgradeWiz.account = account;
    malformedUpgradeWiz.accounts = [account];
    return true;
  },
  refreshButtons() {},
  gotoStep() {},
});
malformedUpgradeStep.onEnter();
await new Promise(resolve => setImmediate(resolve));
const malformedUpgradeGroupSection = malformedUpgradeStep.el.children[2];
const malformedUpgradeStatus = malformedUpgradeGroupSection.children[1];
const malformedUpgradeReload = malformedUpgradeGroupSection.children[4].children[0];
assert.equal(malformedUpgradeWiz.account, malformedUpgradeAccountB,
  '畸形群数组前的合法身份升级必须已经绑定 B');
assert.equal(malformedUpgradeWiz.groups, null,
  '畸形群数组不得写入 B 的群缓存');
assert.match(descendantText(malformedUpgradeStatus), /群列表响应无效/,
  '身份升级后的当前 B 群列表合同错误必须显示为可操作失败，不能静默');
assert.equal(malformedUpgradeReload.disabled, false,
  '身份升级后的群列表合同错误必须恢复重新加载按钮');
malformedUpgradeDestroyed = true;

// applyAccountIdentityUpgrade 会先绑定 B，再因 B 状态重读失败返回 false。
// 群列表不得继续采用响应，但当前 B 仍必须结束这次群加载的 spinner/busy。
let unreadyUpgradeDestroyed = false;
const unreadyUpgradeAccountA = {
  id: 'unready-upgrade-account',
  manual_key_account_fingerprint: 'unready-upgrade-fingerprint-a',
};
const unreadyUpgradeAccountB = {
  id: 'unready-upgrade-account',
  manual_key_account_fingerprint: 'unready-upgrade-fingerprint-b',
};
const unreadyUpgradeWiz = {
  account: unreadyUpgradeAccountA,
  accounts: [unreadyUpgradeAccountA],
  state: { scheduler: {} },
  groups: null,
};
const unreadyUpgradeStep = createFinishStep({
  ctx: {
    api: {
      async get(url) {
        if (!url.startsWith('/api/groups?')) throw new Error(`unexpected unready-upgrade request: ${url}`);
        return {
          groups: [{ id: 'unready-upgrade-group' }],
          account_id: unreadyUpgradeAccountB.id,
          account_fingerprint: unreadyUpgradeAccountB.manual_key_account_fingerprint,
          account_identity_upgrade: {
            previous_fingerprint: unreadyUpgradeAccountA.manual_key_account_fingerprint,
            next_fingerprint: unreadyUpgradeAccountB.manual_key_account_fingerprint,
          },
          account: unreadyUpgradeAccountB,
        };
      },
    },
    store: { set() {} },
    ui: { spinner: () => new FakeElement('spinner') },
  },
  wiz: unreadyUpgradeWiz,
  get destroyed() { return unreadyUpgradeDestroyed; },
  signal: new AbortController().signal,
  beginAsync() { return 1; },
  alive() { return !unreadyUpgradeDestroyed; },
  async applyAccountIdentityUpgrade(account) {
    unreadyUpgradeWiz.account = account;
    unreadyUpgradeWiz.accounts = [account];
    return false;
  },
  refreshButtons() {},
  gotoStep() {},
});
unreadyUpgradeStep.onEnter();
await new Promise(resolve => setImmediate(resolve));
const unreadyUpgradeGroupSection = unreadyUpgradeStep.el.children[2];
const unreadyUpgradeProgress = unreadyUpgradeGroupSection.children[2];
const unreadyUpgradeReload = unreadyUpgradeGroupSection.children[4].children[0];
assert.equal(unreadyUpgradeWiz.account, unreadyUpgradeAccountB,
  '状态未就绪返回前，身份升级 helper 已真实绑定 B');
assert.equal(unreadyUpgradeWiz.groups, null,
  'B 状态未就绪时不得采用升级响应里的群列表');
assert.equal(unreadyUpgradeProgress.children.length, 0,
  '身份已绑定 B 但状态未就绪时仍必须结束当前群加载 spinner');
assert.equal(unreadyUpgradeReload.disabled, false,
  '身份已绑定 B 但状态未就绪时必须恢复重新加载按钮');
unreadyUpgradeDestroyed = true;

for (const [label, stateResponse] of [
  ['null', null],
  ['错指纹', {
    need_setup: false,
    wechat: {
      accounts: [{
        id: 'finish-state-account',
        manual_key_account_fingerprint: 'finish-state-fingerprint-other',
      }],
    },
  }],
]) {
  const finishAccount = {
    id: 'finish-state-account',
    manual_key_account_fingerprint: 'finish-state-fingerprint-current',
  };
  let finishGeneration = 0;
  let finishNavigations = 0;
  const finishWiz = {
    account: finishAccount,
    accounts: [finishAccount],
    state: { scheduler: {} },
    groups: {
      account_id: finishAccount.id,
      account_fingerprint: finishAccount.manual_key_account_fingerprint,
      count: 0,
      preview: [],
      error: '',
    },
  };
  const finishStep = createFinishStep({
    ctx: {
      api: {
        async get(url) {
          if (!url.startsWith('/api/state?')) throw new Error(`unexpected ${label} finish request: ${url}`);
          return stateResponse;
        },
      },
      store: { set() {} },
      ui: { spinner: () => new FakeElement('spinner') },
      navigate() { finishNavigations += 1; },
    },
    wiz: finishWiz,
    destroyed: false,
    signal: new AbortController().signal,
    beginAsync() { finishGeneration += 1; return finishGeneration; },
    alive(token) { return token === finishGeneration; },
    refreshButtons() {},
    gotoStep() {},
  });
  finishStep.onEnter();
  const finished = await finishStep.finish();
  const finishStatus = finishStep.el.children[5];
  assert.equal(finished, false, `${label} state 不得放行完成`);
  assert.equal(finishNavigations, 0, `${label} state 不得跳到总结页`);
  assert.match(descendantText(finishStatus), /响应.*当前账号.*不一致|重新复核|重试/,
    `${label} state 必须替换“正在复核”为可操作错误`);
}

const inFlightRequests = [];
let inFlightDestroyed = false;
let inFlightGeneration = 0;
const inFlightAccountA = { id: 'inflight-account', manual_key_account_fingerprint: 'inflight-fingerprint-a' };
const inFlightAccountB = { id: 'inflight-account', manual_key_account_fingerprint: 'inflight-fingerprint-b' };
const inFlightWiz = {
  account: inFlightAccountA,
  accounts: [inFlightAccountA],
  state: { scheduler: {} },
  groups: null,
};
const inFlightCtx = {
  api: {
    get(url, options = {}) {
      if (!url.startsWith('/api/groups?')) throw new Error(`unexpected in-flight request: ${url}`);
      const request = deferred();
      inFlightRequests.push({ ...request, signal: options.signal });
      return request.promise;
    },
  },
  store: { set() {} },
  ui: { spinner: () => new FakeElement('spinner') },
};
const inFlightW = {
  ctx: inFlightCtx,
  wiz: inFlightWiz,
  get destroyed() { return inFlightDestroyed; },
  signal: new AbortController().signal,
  beginAsync() { inFlightGeneration += 1; return inFlightGeneration; },
  alive(token) { return !inFlightDestroyed && token === inFlightGeneration; },
  applyAccountIdentityUpgrade(account) { inFlightWiz.account = account; },
  refreshButtons() {},
  gotoStep() {},
};
const inFlightStep = createFinishStep(inFlightW);
inFlightStep.onEnter();
ownerContract(inFlightRequests.length === 1, 'A 进入完成步骤必须发起群列表请求');
inFlightWiz.account = inFlightAccountB;
inFlightStep.onEnter();
ownerContract(inFlightRequests.length === 2,
  '同 ID 指纹切到 B 时必须立即使 A 在途请求失效并发起 B 请求');
ownerContract(inFlightRequests[0]?.signal?.aborted === true,
  '同 ID 指纹切到 B 时必须同时取消 A 在途 I/O，不能只丢弃 A 的晚到结果');
ownerContract(inFlightRequests[1]?.signal?.aborted === false,
  '身份换代后的 B 请求必须持有新的可用 signal');
if (inFlightRequests[1]) inFlightRequests[1].resolve({
    groups: [{ id: 'inflight-b-group', name: 'inflight-b-group' }],
    account_id: inFlightAccountB.id,
    account_fingerprint: inFlightAccountB.manual_key_account_fingerprint,
  });
await new Promise(resolve => setImmediate(resolve));
if (inFlightRequests[0]) inFlightRequests[0].resolve({
    groups: [{ id: 'inflight-a-group', name: 'inflight-a-group' }],
    account_id: inFlightAccountA.id,
    account_fingerprint: inFlightAccountA.manual_key_account_fingerprint,
  });
await new Promise(resolve => setImmediate(resolve));
ownerContract(inFlightWiz.groups?.account_fingerprint === inFlightAccountB.manual_key_account_fingerprint,
  'A 的晚到响应不得覆盖 B 的群缓存');
inFlightDestroyed = true;

// 完成步骤允许群列表在后台读取，但后台请求不能在“完成”复核期间重新开放
// 自己的操作入口。否则用户可真实点击“重新加载群列表”，推进全局 async
// generation，并把本应完成的 state 复核静默作废。
const finishRaceGroupRequests = [];
const finishRaceStateRequest = deferred();
let finishRaceGeneration = 0;
let finishRaceDestroyed = false;
let finishRaceNavigations = 0;
const finishRaceAccount = {
  id: 'finish-race-account',
  manual_key_account_fingerprint: 'finish-race-fingerprint',
};
const finishRaceWiz = {
  account: finishRaceAccount,
  accounts: [finishRaceAccount],
  state: { scheduler: {} },
  groups: null,
};
const finishRaceStep = createFinishStep({
  ctx: {
    api: {
      get(url, options = {}) {
        if (url.startsWith('/api/groups?')) {
          const request = deferred();
          finishRaceGroupRequests.push({ ...request, signal: options.signal });
          return request.promise;
        }
        if (url.startsWith('/api/state?')) return finishRaceStateRequest.promise;
        throw new Error(`unexpected finish-race request: ${url}`);
      },
    },
    store: { set() {} },
    ui: { spinner: () => new FakeElement('spinner') },
    navigate() {
      finishRaceNavigations += 1;
      finishRaceDestroyed = true;
    },
  },
  wiz: finishRaceWiz,
  get destroyed() { return finishRaceDestroyed; },
  signal: new AbortController().signal,
  beginAsync() { finishRaceGeneration += 1; return finishRaceGeneration; },
  alive(token) { return !finishRaceDestroyed && token === finishRaceGeneration; },
  applyAccountIdentityUpgrade() {},
  refreshButtons() {},
  gotoStep() {},
});
finishRaceStep.onEnter();
ownerContract(finishRaceGroupRequests.length === 1,
  '完成竞态场景必须先启动一轮后台群列表读取');
const finishRaceReload = finishRaceStep.el.children[2].children[4].children[0];
ownerContract(finishRaceReload.disabled === true,
  '群列表读取期间重新加载按钮必须禁用');
const finishRaceCompletion = finishRaceStep.finish();
await Promise.resolve();
ownerContract(finishRaceGroupRequests[0]?.signal?.aborted === true,
  '完成复核取得新 owner 后必须立即取消旧群列表 I/O');
finishRaceGroupRequests[0].resolve({
  groups: [{ id: 'finish-race-group', name: 'finish-race-group' }],
  account_id: finishRaceAccount.id,
  account_fingerprint: finishRaceAccount.manual_key_account_fingerprint,
});
await new Promise(resolve => setImmediate(resolve));
ownerContract(finishRaceReload.disabled === true,
  '旧群列表请求结束时不得在完成复核期间重新开放群列表操作入口');
if (!finishRaceReload.disabled) finishRaceReload.listeners.get('click')?.();
ownerContract(finishRaceGroupRequests.length === 1,
  '完成复核期间用户不得通过重新开放的按钮启动新群请求并取代完成 owner');
finishRaceStateRequest.resolve({
  need_setup: false,
  scheduler: {},
  wechat: { accounts: [finishRaceAccount], account_count: 1 },
});
ownerContract(await finishRaceCompletion === true,
  '后台群列表晚到不得使有效的完成复核静默失效');
ownerContract(finishRaceNavigations === 1,
  '有效完成复核必须继续进入总结页');

// 完成复核失败且页面仍停留在第 4 步时，旧群列表请求不能继续占用自己的
// 网络资源到 600 秒。完成动作已经取得新的 async owner，旧群请求应立即取消；
// 即使 fake API 忽略 abort，晚到结果也只能被 owner 检查丢弃。
const finishFailureGroupRequests = [];
const finishFailureStateRequest = deferred();
let finishFailureGeneration = 0;
let finishFailureDestroyed = false;
const finishFailureAccount = {
  id: 'finish-failure-account',
  manual_key_account_fingerprint: 'finish-failure-fingerprint',
};
const finishFailureStep = createFinishStep({
  ctx: {
    api: {
      get(url, options = {}) {
        if (url.startsWith('/api/groups?')) {
          const request = deferred();
          finishFailureGroupRequests.push({ ...request, signal: options.signal });
          return request.promise;
        }
        if (url.startsWith('/api/state?')) return finishFailureStateRequest.promise;
        throw new Error(`unexpected finish-failure request: ${url}`);
      },
    },
    store: { set() {} },
    ui: { spinner: () => new FakeElement('spinner') },
  },
  wiz: {
    account: finishFailureAccount,
    accounts: [finishFailureAccount],
    state: { scheduler: {} },
    groups: null,
  },
  get destroyed() { return finishFailureDestroyed; },
  signal: new AbortController().signal,
  beginAsync() { finishFailureGeneration += 1; return finishFailureGeneration; },
  alive(token) { return !finishFailureDestroyed && token === finishFailureGeneration; },
  applyAccountIdentityUpgrade() {},
  refreshButtons() {},
  gotoStep() {},
});
finishFailureStep.onEnter();
ownerContract(finishFailureGroupRequests.length === 1,
  '完成复核失败场景必须先启动一轮后台群列表读取');
const finishFailure = finishFailureStep.finish();
await Promise.resolve();
ownerContract(finishFailureGroupRequests[0]?.signal?.aborted === true,
  '完成复核取得新 owner 后必须立即取消旧群列表 I/O，不能只丢弃晚到响应');
finishFailureStateRequest.reject(new Error('finish state failed'));
ownerContract(await finishFailure === false,
  '完成复核普通失败必须留在当前向导并返回 false');
finishFailureGroupRequests[0]?.resolve({
  groups: [{ id: 'finish-failure-late-group', name: 'finish-failure-late-group' }],
  account_id: finishFailureAccount.id,
  account_fingerprint: finishFailureAccount.manual_key_account_fingerprint,
});
await new Promise(resolve => setImmediate(resolve));
finishFailureDestroyed = true;

// 白名单设置读取也必须按完整账号身份拥有。A 的 settings 请求在途时切到
// B，旧响应会因 identity guard 被丢弃；B 不能因为步骤级 promise 仍存在而
// 永久跳过自己的重读。
const whitelistSettingsA = deferred();
const whitelistSettingsB = deferred();
const whitelistSettingsA2 = deferred();
const whitelistSettingsB2 = deferred();
const whitelistSettingsA3 = deferred();
let whitelistSettingsRequests = 0;
let whitelistGroupsRequests = 0;
let whitelistOwnerDestroyed = false;
const whitelistOwnerAccountA = {
  id: 'whitelist-owner-account',
  manual_key_account_fingerprint: 'whitelist-owner-fingerprint-a',
};
const whitelistOwnerAccountB = {
  id: 'whitelist-owner-account',
  manual_key_account_fingerprint: 'whitelist-owner-fingerprint-b',
};
const whitelistOwnerWiz = {
  account: whitelistOwnerAccountA,
  accounts: [whitelistOwnerAccountA, whitelistOwnerAccountB],
  state: { scheduler: {} },
  settings: null,
  groups: {
    account_id: whitelistOwnerAccountA.id,
    account_fingerprint: whitelistOwnerAccountA.manual_key_account_fingerprint,
    count: 1,
    preview: [],
  },
};
const whitelistOwnerController = new AbortController();
const whitelistOwnerCtx = {
  api: {
    get(url) {
      if (url === '/api/settings') {
        whitelistSettingsRequests += 1;
        return [
          whitelistSettingsA,
          whitelistSettingsB,
          whitelistSettingsA2,
          whitelistSettingsB2,
          whitelistSettingsA3,
        ][whitelistSettingsRequests - 1].promise;
      }
      if (url.startsWith('/api/groups?')) {
        whitelistGroupsRequests += 1;
        return Promise.resolve({
          groups: [{ id: 'whitelist-owner-group', name: 'whitelist-owner-group' }],
          account_id: whitelistOwnerAccountB.id,
          account_fingerprint: whitelistOwnerAccountB.manual_key_account_fingerprint,
        });
      }
      throw new Error(`unexpected whitelist-owner request: ${url}`);
    },
  },
  store: { set() {} },
  ui: { spinner: () => new FakeElement('spinner') },
};
let whitelistOwnerGeneration = 0;
const whitelistOwnerStep = createFinishStep({
  ctx: whitelistOwnerCtx,
  wiz: whitelistOwnerWiz,
  get destroyed() { return whitelistOwnerDestroyed; },
  signal: whitelistOwnerController.signal,
  beginAsync() { whitelistOwnerGeneration += 1; return whitelistOwnerGeneration; },
  alive(token) { return !whitelistOwnerDestroyed && token === whitelistOwnerGeneration; },
  applyAccountIdentityUpgrade() {},
  refreshButtons() {},
  gotoStep() {},
});
whitelistOwnerStep.onEnter();
assert.equal(whitelistSettingsRequests, 1,
  '进入完成步骤必须为 A 发起一次白名单设置读取');
whitelistOwnerWiz.account = whitelistOwnerAccountB;
whitelistOwnerStep.onExit();
whitelistOwnerStep.onEnter();
assert.equal(whitelistGroupsRequests, 1,
  '账号换代后完成步骤应为 B 重新读取群列表');
assert.equal(whitelistSettingsRequests, 2,
  'A 白名单设置读取在途时切到 B，必须立即为 B 发起独立设置读取');
whitelistSettingsA.resolve({
  settings_revision: 'whitelist-owner-a-revision',
  groups: { whitelist: [] },
});
await new Promise(resolve => setImmediate(resolve));
assert.equal(whitelistOwnerWiz.settings, null,
  'A 的晚到设置响应不得采用到 B 上下文');
whitelistSettingsB.resolve({
  settings_revision: 'whitelist-owner-b-revision',
  groups: { whitelist: [] },
});
await new Promise(resolve => setImmediate(resolve));
assert.equal(whitelistOwnerWiz.settings?.settings_revision, 'whitelist-owner-b-revision',
  'B 的当前设置响应必须采用到 B 上下文');

// A→B→A 快速往返时，第一笔 A 请求即使忽略 abort 也不能借当前同身份
// 重新写入；只有最新 A owner 的响应可以采用。
whitelistOwnerWiz.account = whitelistOwnerAccountA;
whitelistOwnerStep.onExit();
whitelistOwnerStep.onEnter();
whitelistOwnerWiz.account = whitelistOwnerAccountB;
whitelistOwnerStep.onExit();
whitelistOwnerStep.onEnter();
whitelistOwnerWiz.account = whitelistOwnerAccountA;
whitelistOwnerStep.onExit();
whitelistOwnerStep.onEnter();
assert.equal(whitelistSettingsRequests, 5,
  'A→B→A 往返必须为每个新身份 owner 发起独立设置读取');
whitelistSettingsA2.resolve({ settings_revision: 'stale-a2', groups: { whitelist: [] } });
await new Promise(resolve => setImmediate(resolve));
assert.equal(whitelistOwnerWiz.settings, null,
  '第一笔 A 晚到响应不得覆盖最新 A owner');
whitelistSettingsB2.resolve({ settings_revision: 'stale-b2', groups: { whitelist: [] } });
await new Promise(resolve => setImmediate(resolve));
assert.equal(whitelistOwnerWiz.settings, null,
  'B 晚到响应不得覆盖当前 A owner');
whitelistSettingsA3.resolve({ settings_revision: 'latest-a3', groups: { whitelist: [] } });
await new Promise(resolve => setImmediate(resolve));
assert.equal(whitelistOwnerWiz.settings?.settings_revision, 'latest-a3',
  '最新 A owner 响应必须最终采用');
whitelistOwnerDestroyed = true;

// 离开完成步骤本身也必须释放白名单读取 owner。整页向导仍存活时，A
// 的晚到 settings 不能写隐藏步骤的状态或 DOM。
const leavingWhitelistSettings = deferred();
let leavingWhitelistSettingsSignal = null;
let leavingWhitelistSettingsRequests = 0;
let leavingWhitelistDestroyed = false;
const leavingWhitelistAccount = {
  id: 'leaving-whitelist-account',
  manual_key_account_fingerprint: 'leaving-whitelist-fingerprint',
};
const leavingWhitelistWiz = {
  account: leavingWhitelistAccount,
  accounts: [leavingWhitelistAccount],
  state: { scheduler: {} },
  settings: null,
  groups: {
    account_id: leavingWhitelistAccount.id,
    account_fingerprint: leavingWhitelistAccount.manual_key_account_fingerprint,
    count: 1,
    preview: [],
  },
};
const leavingWhitelistStep = createFinishStep({
  ctx: {
    api: {
      get(url, options = {}) {
        if (url === '/api/settings') {
          leavingWhitelistSettingsRequests += 1;
          leavingWhitelistSettingsSignal = options.signal;
          return leavingWhitelistSettings.promise;
        }
        throw new Error(`unexpected leaving-whitelist request: ${url}`);
      },
    },
    store: { set() {} },
    ui: { spinner: () => new FakeElement('spinner') },
  },
  wiz: leavingWhitelistWiz,
  get destroyed() { return leavingWhitelistDestroyed; },
  signal: new AbortController().signal,
  beginAsync() { return 1; },
  alive() { return !leavingWhitelistDestroyed; },
  applyAccountIdentityUpgrade() {},
  refreshButtons() {},
  gotoStep() {},
});
leavingWhitelistStep.onEnter();
assert.equal(leavingWhitelistSettingsRequests, 1,
  '离开步骤场景必须先启动白名单设置读取');
leavingWhitelistStep.onExit();
assert.equal(leavingWhitelistSettingsSignal?.aborted, true,
  '离开完成步骤必须立即取消白名单设置请求');
leavingWhitelistSettings.resolve({
  settings_revision: 'late-leaving-revision',
  groups: { whitelist: [] },
});
await new Promise(resolve => setImmediate(resolve));
assert.equal(leavingWhitelistWiz.settings, null,
  '离开步骤后白名单设置晚到不得写回向导状态');
leavingWhitelistDestroyed = true;

// 同一账号离开后立即重入时，旧 API 可能忽略 abort。旧 owner 必须同步失效，
// 因此第二次 onEnter 不能继续等待第一笔请求；第一笔晚到也不能采用。
const reenterWhitelistLoads = [];
const reenterWhitelistWiz = {
  account: leavingWhitelistAccount,
  accounts: [leavingWhitelistAccount],
  state: { scheduler: {} },
  settings: null,
  groups: {
    account_id: leavingWhitelistAccount.id,
    account_fingerprint: leavingWhitelistAccount.manual_key_account_fingerprint,
    count: 1,
    preview: [],
  },
};
const reenterWhitelistStep = createFinishStep({
  ctx: {
    api: {
      get(url, options = {}) {
        if (url === '/api/settings') {
          const load = deferred();
          reenterWhitelistLoads.push({ load, signal: options.signal });
          return load.promise;
        }
        throw new Error(`unexpected reenter-whitelist request: ${url}`);
      },
    },
    store: { set() {} },
    ui: { spinner: () => new FakeElement('spinner') },
  },
  wiz: reenterWhitelistWiz,
  signal: new AbortController().signal,
  beginAsync() { return 1; },
  alive() { return true; },
  applyAccountIdentityUpgrade() {},
  refreshButtons() {},
  gotoStep() {},
});
reenterWhitelistStep.onEnter();
assert.equal(reenterWhitelistLoads.length, 1,
  '同账号重入场景必须先启动第一笔白名单设置读取');
reenterWhitelistStep.onExit();
assert.equal(reenterWhitelistLoads[0].signal?.aborted, true,
  '同账号重入前必须取消第一笔白名单设置读取');
reenterWhitelistStep.onEnter();
assert.equal(reenterWhitelistLoads.length, 2,
  '第一笔忽略 abort 时，同账号重入必须立即启动第二笔设置读取');
reenterWhitelistLoads[0].load.resolve({
  settings_revision: 'stale-reenter-whitelist',
  groups: { whitelist: [] },
});
await new Promise(resolve => setImmediate(resolve));
assert.equal(reenterWhitelistWiz.settings, null,
  '第一笔同账号晚到响应不得采用');
reenterWhitelistLoads[1].load.resolve({
  settings_revision: 'current-reenter-whitelist',
  groups: { whitelist: [] },
});
await new Promise(resolve => setImmediate(resolve));
assert.equal(reenterWhitelistWiz.settings?.settings_revision, 'current-reenter-whitelist',
  '第二笔同账号设置响应必须采用');

assert.deepEqual(ownerContractFailures, [], `群列表 owner 合同失败:\n${ownerContractFailures.join('\n')}`);

assert.match(setupIndexSource,
  /if \(clamped !== page\.stepIndex\) currentStep\(\)\.onExit\?\.\(\);/,
  '向导切换步骤前必须调用当前步骤的退出失效钩子');
assert.match(source,
  /onExit\(\) \{[\s\S]*?groupGeneration \+= 1;[\s\S]*?loading = false;/,
  '完成步骤退出时必须使后台群列表请求代次失效');

delete globalThis.__testRequireGroupList;
delete globalThis.__testRequireServiceStatePayload;

console.log('web setup finish background groups tests passed');
