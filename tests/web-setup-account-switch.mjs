import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createStore } from '../src/web/public/js/store.js';
import { requireServiceStatePayload } from '../src/web/public/js/shared/service-state.js';
import { createAccountSelectionController } from '../src/web/public/js/shared/account-selection.js';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

const setupSource = await readFile(new URL('../src/web/public/js/pages/setup/index.js', import.meta.url), 'utf8');
const accountStepSource = await readFile(new URL('../src/web/public/js/pages/setup/step-account.js', import.meta.url), 'utf8');
const keyStepSource = await readFile(new URL('../src/web/public/js/pages/setup/step-key.js', import.meta.url), 'utf8');
const shellSource = await readFile(new URL('../src/web/public/js/main.js', import.meta.url), 'utf8');
const stateModule = await createBrowserModuleLoader().load('js/pages/setup/state.js');
const {
  createWizardState,
  applyWizardAccountState,
  accountIdOf,
  bindWizardAccountContext,
  findAccountByAnyId,
  refreshWizardStateForAccount,
  resetWizardAccountScopedState,
  stateMatchesAccountContext,
  wizardAccountContextIdentity,
} = stateModule;

class RefreshFakeElement {
  constructor(tagName, ownerDocument, text = '') {
    this.tagName = String(tagName || '').toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.tabIndex = 0;
    this.attributes = new Map();
    this.listeners = new Map();
    this._textContent = String(text ?? '');
    this.classList = {
      toggle: (name, force) => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        const next = force === undefined ? !names.has(name) : Boolean(force);
        if (next) names.add(name); else names.delete(name);
        this.className = [...names].join(' ');
        return next;
      },
    };
  }

  get textContent() {
    if (this.children.length) return this.children.map(child => child.textContent).join('');
    return this._textContent;
  }

  set textContent(value) {
    this.children = [];
    this._textContent = String(value ?? '');
  }

  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }

  appendChild(node) {
    if (!node) return node;
    this._textContent = '';
    node.parentElement = this;
    this.children.push(node);
    return node;
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this._textContent = '';
    this.append(...nodes);
  }

  setAttribute(name, value) { this.attributes.set(String(name), String(value)); }
  getAttribute(name) { return this.attributes.get(String(name)) ?? null; }
  addEventListener(type, listener) { this.listeners.set(String(type), listener); }
  removeEventListener(type, listener) {
    if (this.listeners.get(String(type)) === listener) this.listeners.delete(String(type));
  }

  click() {
    this.ownerDocument.activeElement = this;
    return this.listeners.get('click')?.({
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() {},
    });
  }

  focus() { this.ownerDocument.activeElement = this; }

  matches(selector) {
    const clean = String(selector || '').trim();
    const role = clean.match(/^\[role="([^"]+)"\]$/);
    if (role) return this.getAttribute('role') === role[1];
    if (clean.startsWith('.')) return this.className.split(/\s+/).includes(clean.slice(1));
    return this.tagName.toLowerCase() === clean.toLowerCase();
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  querySelectorAll(selector) {
    const found = [];
    const visit = node => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  get isConnected() {
    return this === this.ownerDocument.body || !!this.parentElement?.isConnected;
  }
}

const refreshDocument = {
  activeElement: null,
  createElement(tagName) { return new RefreshFakeElement(tagName, refreshDocument); },
};
refreshDocument.body = new RefreshFakeElement('body', refreshDocument);
globalThis.document = refreshDocument;
globalThis.localStorage = { setItem() {}, removeItem() {} };

assert.match(setupSource, /function accountSwitchGuard\(\)/,
  '首次配置向导必须声明壳层账号切换守卫');
assert.match(setupSource, /store\.set\('accountSwitchGuard', accountSwitchGuard\)/,
  '首次配置向导挂载时必须注册账号切换守卫');
assert.match(setupSource, /store\.get\('accountSwitchGuard'\) === accountSwitchGuard[\s\S]*store\.set\('accountSwitchGuard', null\)/,
  '首次配置向导销毁时必须只释放自己持有的账号切换守卫');
assert.match(accountStepSource, /bindWizardAccountContext\(w\.wiz, account, ctx\.store\)[\s\S]*ctx\.store\.set\('account', w\.wiz\.account\)/,
  '向导第 1 步必须通过统一上下文入口更新向导账号和 store.account');
assert.doesNotMatch(accountStepSource, /w\.wiz\.account\s*=/,
  '账号点击、刷新、消失和自动选择都不能绕过统一上下文入口直接赋值');
assert.match(accountStepSource, /isBusy:\s*\(\) => loading/,
  '向导账号刷新期间必须把步骤标记为忙态,阻止底部导航继续');
assert.match(accountStepSource, /function finishLoad[\s\S]*loading = false;[\s\S]*refreshAccountsBtn\.disabled = false;[\s\S]*w\.refreshButtons\(\)/,
  '向导账号刷新结束后必须在解除 loading 后恢复底部按钮');
assert.match(accountStepSource, /finally\s*\{[\s\S]*finishLoad\(operation/,
  '每次账号状态请求都必须通过统一收尾恢复按钮');
assert.doesNotMatch(accountStepSource, /createAccountSelectionController/,
  '向导第 1 步不能经由壳层账号选择控制器,否则会被自身守卫误拦');
assert.match(accountStepSource, /refreshSelectedAccountState/,
  '向导内切换账号后必须主动读取目标账号状态');
assert.match(accountStepSource, /stateReadyIdentity\s*===\s*accountContextIdentity\(w\.wiz\.account\)/,
  '下一步门槛必须绑定精确账号上下文已就绪状态');
assert.match(accountStepSource, /bindWizardAccountContext/,
  '向导内所有账号变化必须经统一入口清理来源账号的密钥瞬态与群缓存');
assert.match(keyStepSource, /keyInput\.addEventListener\('input',[\s\S]*wiz\.key\.draft = keyInput\.value/,
  '手动密钥输入必须写入当前账号的向导草稿');
assert.match(keyStepSource, /onEnter\(\) \{[\s\S]*keyInput\.value = wiz\.key\.draft/,
  '重新进入密钥步骤时必须从当前账号作用域恢复输入，不能保留来源账号 DOM 值');
assert.match(setupSource, /wiz\.stateAccountId\s*===\s*accountIdOf\(wiz\.account\)/,
  '向导初始跳步只能使用已绑定当前账号的状态');

const stateAccountA = { id: 'state-account-a', manual_key_account_fingerprint: 'fingerprint-a' };
const stateAccountB = { id: 'state-account-b', manual_key_account_fingerprint: 'fingerprint-b' };
const stateA = { marker: 'state-a', settings_revision: 'revision-a' };
const stateB = { marker: 'state-b', settings_revision: 'revision-b', secrets_invalid: true };
const stateStore = createStore({
  state: stateA,
  stateAccountContext: { accountId: stateAccountA.id, accountFingerprint: 'fingerprint-a' },
  account: stateAccountA,
});
const wizardState = createWizardState(stateStore);
assert.equal(wizardState.stateAccountId, stateAccountA.id,
  'mount should retain an initial state only when its context matches the selected account');
applyWizardAccountState(stateStore, wizardState, stateB, stateAccountB);
assert.equal(wizardState.state, stateB, 'binding a target account state must replace the source account snapshot');
assert.equal(wizardState.stateAccountId, stateAccountB.id);
assert.equal(stateStore.get('state'), stateB);
assert.deepEqual(stateStore.get('stateAccountContext'), {
  accountId: stateAccountB.id,
  accountFingerprint: 'fingerprint-b',
});

const mismatchedStore = createStore({
  state: stateA,
  stateAccountContext: { accountId: stateAccountB.id, accountFingerprint: 'fingerprint-b' },
  account: stateAccountA,
});
assert.equal(createWizardState(mismatchedStore).stateAccountId, '',
  'a state snapshot bound to another account must not unlock the current account setup flow');

const sameIdStaleState = {
  marker: 'stale-a',
  need_setup_reason: 'wechat_manual_key_required',
  settings_revision: 'stale-revision-a',
};
const sameIdStaleStore = createStore({
  state: sameIdStaleState,
  stateAccountContext: { accountId: stateAccountA.id, accountFingerprint: 'fingerprint-a' },
  account: { ...stateAccountA, manual_key_account_fingerprint: 'fingerprint-b' },
});
const sameIdStaleWizard = createWizardState(sameIdStaleStore);
assert.equal(sameIdStaleWizard.stateAccountId, '',
  'same ID but newer account fingerprint must not treat the old initial state as current');
assert.equal(sameIdStaleWizard.state, null,
  'same ID stale initial state must not remain visible while the current account is being loaded');
assert.equal(sameIdStaleWizard.needSetupReason, '',
  'same ID stale initial setup reason must not steer the current account wizard');
assert.equal(sameIdStaleWizard.baseRevision, '',
  'same ID stale initial revision must not be reused for the current account');

const emptyInitialStateStore = createStore({
  state: null,
  stateAccountContext: { accountId: stateAccountA.id, accountFingerprint: 'fingerprint-a' },
  account: stateAccountA,
});
assert.equal(createWizardState(emptyInitialStateStore).stateAccountId, '',
  'an empty initial state must not be marked ready merely because its context key remains');

assert.equal(stateMatchesAccountContext({ wechat: { accounts: [stateAccountA] } }, {
  id: stateAccountA.id,
  manual_key_account_fingerprint: '',
}), false, '空 fingerprint 账号不得采用同 ID 的非空 fingerprint state');
assert.equal(stateMatchesAccountContext({
  wechat: { accounts: [{ id: stateAccountA.id, manual_key_account_fingerprint: '' }] },
}, {
  id: stateAccountA.id,
  manual_key_account_fingerprint: '',
}), true, '空 fingerprint 账号只能采用同样为空的 state');

assert.equal(typeof resetWizardAccountScopedState, 'function',
  'setup state must expose one shared account-scoped reset entry point');
assert.equal(typeof bindWizardAccountContext, 'function',
  'setup state must expose one shared account context binding entry point');
const scopedWizard = createWizardState(stateStore);
scopedWizard.key = {
  draft: 'source-account-secret',
  validatedText: 'source-account-secret',
  validation: { ok: true },
  savedText: 'source-account-secret',
  saved: true,
  skipped: true,
};
scopedWizard.groups = { account_id: stateAccountA.id, count: 1, preview: [{ id: 'source-group' }] };
scopedWizard.whitelist = [{ account_id: stateAccountA.id, group_id: 'source-group' }];
scopedWizard.whitelistBaseline = [...scopedWizard.whitelist];
scopedWizard.whitelistDirty = true;
scopedWizard.whitelistAccountIdentity = `${stateAccountA.id}|fingerprint-a`;
scopedWizard.done = true;
resetWizardAccountScopedState(scopedWizard);
assert.deepEqual(scopedWizard.key, {
  draft: '',
  validatedText: '',
  validation: null,
  savedText: '',
  saved: false,
  skipped: false,
}, '切换账号必须清除来源账号密钥草稿、验证证明和已完成标记');
assert.equal(scopedWizard.groups, null, '切换账号必须清除来源账号群缓存');
assert.deepEqual(scopedWizard.whitelist, [], '切换账号必须清除来源账号白名单草稿');
assert.deepEqual(scopedWizard.whitelistBaseline, [], '切换账号必须清除来源账号白名单基线');
assert.equal(scopedWizard.whitelistDirty, false, '切换账号后不得继续携带来源账号白名单脏状态');
assert.equal(scopedWizard.whitelistAccountIdentity, '');
assert.equal(scopedWizard.done, false);

const retainedWizard = createWizardState(stateStore);
retainedWizard.key.draft = 'same-account-draft';
const sameAccountChanged = bindWizardAccountContext(retainedWizard, {
  ...stateAccountA,
  display_name: 'refreshed object',
});
assert.equal(sameAccountChanged, false, '同账号的新对象刷新不是上下文切换');
assert.equal(retainedWizard.key.draft, 'same-account-draft');
const fingerprintChanged = bindWizardAccountContext(retainedWizard, {
  ...stateAccountA,
  manual_key_account_fingerprint: 'fingerprint-a-refreshed',
});
assert.equal(fingerprintChanged, true,
  '同账号 ID 的 fingerprint 变化必须建立新的向导安全上下文');
assert.equal(retainedWizard.key.draft, '',
  '同账号 fingerprint 变化必须清除来源账号密钥瞬态');
retainedWizard.key.draft = 'same-account-draft-after-refresh';
const aliasUpgradeChanged = bindWizardAccountContext(retainedWizard, {
  id: 'state-account-a-upgraded',
  account_aliases: [stateAccountA.id],
  manual_key_account_fingerprint: 'fingerprint-a-refreshed',
});
assert.equal(aliasUpgradeChanged, false, '命中稳定别名且 fingerprint 不变的身份升级必须保留同账号瞬态');
assert.equal(retainedWizard.key.draft, 'same-account-draft-after-refresh');
retainedWizard.key.draft = 'nonempty-to-empty-draft';
const fingerprintRemoved = bindWizardAccountContext(retainedWizard, {
  id: 'state-account-a-upgraded-again',
  account_aliases: [stateAccountA.id],
});
assert.equal(fingerprintRemoved, true,
  '同账号非空 fingerprint 变为空也必须建立新的安全上下文');
assert.equal(retainedWizard.key.draft, '', '非空 fingerprint 到空必须清除来源账号瞬态');
retainedWizard.key.draft = 'empty-to-nonempty-draft';
const fingerprintAdded = bindWizardAccountContext(retainedWizard, {
  id: 'state-account-a-upgraded-third',
  account_aliases: [stateAccountA.id],
  manual_key_account_fingerprint: 'fingerprint-b',
});
assert.equal(fingerprintAdded, true,
  '同账号空 fingerprint 变为非空也必须建立新的安全上下文');
assert.equal(retainedWizard.key.draft, '', '空 fingerprint 到非空必须清除来源账号瞬态');
const realSwitchChanged = bindWizardAccountContext(retainedWizard, stateAccountB);
assert.equal(realSwitchChanged, true);
assert.equal(retainedWizard.key.draft, '', 'A→B 必须清除来源账号草稿');
retainedWizard.key.draft = 'account-b-draft';
assert.equal(bindWizardAccountContext(retainedWizard, null), true);
assert.equal(retainedWizard.key.draft, '', '账号消失必须清除已失效账号草稿');

const accountA = { id: 'account-a' };
const accountB = { id: 'account-b' };
const store = createStore({ account: accountA, accountSwitchGuard: null });
const blocked = [];
const controller = createAccountSelectionController({
  store,
  onBlocked: message => blocked.push(message),
});
store.set('accountSwitchGuard', () => '首次配置向导已打开,请回到第 1 步在向导中选择账号。');
const result = controller.select(accountB, { userInitiated: true });
assert.equal(result.blocked, true, '向导期间壳层账号菜单切换必须被阻止');
assert.equal(store.get('account'), accountA, '被阻止后向导当前账号必须保持不变');
assert.match(blocked[0], /第 1 步/);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

const upgradeAccountA = { id: 'upgrade-account', manual_key_account_fingerprint: 'upgrade-a' };
const upgradeAccountB = { id: 'upgrade-account', manual_key_account_fingerprint: 'upgrade-b' };
const upgradeStore = createStore({
  account: upgradeAccountA,
  state: { marker: 'state-a' },
  stateAccountContext: {
    accountId: upgradeAccountA.id,
    accountFingerprint: upgradeAccountA.manual_key_account_fingerprint,
  },
});
const upgradeWizard = {
  account: upgradeAccountA,
  state: { marker: 'state-a' },
  stateAccountId: upgradeAccountA.id,
  needSetupReason: 'wechat_manual_key_required',
  baseRevision: 'revision-a',
  key: { draft: 'key-a', validatedText: 'key-a', saved: true },
  groups: { account_id: upgradeAccountA.id, account_fingerprint: 'upgrade-a' },
  done: true,
};
assert.equal(bindWizardAccountContext(upgradeWizard, upgradeAccountB, upgradeStore), true,
  '同 ID A→B 必须建立新的向导上下文');
assert.equal(upgradeWizard.state, null, 'A→B 必须清空向导 state');
assert.equal(upgradeWizard.stateAccountId, '', 'A→B 必须清空向导 state owner');
assert.equal(upgradeWizard.needSetupReason, '', 'A→B 必须清空旧账号 setup reason');
assert.equal(upgradeWizard.baseRevision, '', 'A→B 必须清空旧账号 revision');
assert.equal(upgradeWizard.key.draft, '', 'A→B 必须清空旧账号 key 草稿');
assert.equal(upgradeWizard.groups, null, 'A→B 必须清空旧账号群缓存');
assert.equal(upgradeWizard.done, false, 'A→B 必须清空旧账号完成标记');
assert.equal(upgradeStore.get('state'), null, 'A→B 必须清空 store state');
assert.equal(upgradeStore.get('stateAccountContext'), null,
  'A→B 必须清空 store state owner');

const emptyUpgradeStore = createStore({
  account: { id: upgradeAccountA.id, manual_key_account_fingerprint: '' },
  state: { marker: 'state-empty' },
  stateAccountContext: { accountId: upgradeAccountA.id, accountFingerprint: '' },
});
const emptyUpgradeWizard = {
  account: { id: upgradeAccountA.id, manual_key_account_fingerprint: '' },
  state: { marker: 'state-empty' },
  stateAccountId: upgradeAccountA.id,
  key: { draft: 'empty-key' },
  groups: { account_id: upgradeAccountA.id },
  done: true,
};
assert.equal(bindWizardAccountContext(emptyUpgradeWizard, upgradeAccountB, emptyUpgradeStore), true,
  '同 ID 空 fingerprint→B 必须建立新的向导上下文');
assert.equal(emptyUpgradeWizard.state, null, '空 fingerprint→B 必须清空 state');
assert.equal(emptyUpgradeWizard.key.draft, '', '空 fingerprint→B 必须清空 key 草稿');
assert.equal(emptyUpgradeWizard.groups, null, '空 fingerprint→B 必须清空群缓存');
assert.equal(emptyUpgradeWizard.done, false, '空 fingerprint→B 必须清空完成标记');

assert.equal(typeof refreshWizardStateForAccount, 'function',
  '身份升级后必须通过共享 helper 重新读取并精确绑定账号 state');
const lateStore = createStore({ account: upgradeAccountB, state: null, stateAccountContext: null });
const lateWizard = { account: upgradeAccountB, state: null, stateAccountId: '', needSetupReason: '', baseRevision: '' };
const lateA = deferred();
const lateRefresh = refreshWizardStateForAccount({
  api: {
    get(path) {
      assert.equal(path, '/api/state?refresh=1&account=upgrade-account');
      return lateA.promise;
    },
  },
  store: lateStore,
  wiz: lateWizard,
  account: upgradeAccountB,
  isCurrent: () => true,
});
lateA.resolve({ marker: 'late-a', need_setup: false, wechat: { accounts: [upgradeAccountA] } });
assert.equal(await lateRefresh, false, '升级后迟到的 A state 必须被拒绝');
assert.equal(lateWizard.state, null, '迟到 A state 不得写入向导');
assert.equal(lateStore.get('state'), null, '迟到 A state 不得写入 store');

const malformedStateStore = createStore({ account: upgradeAccountB, state: null, stateAccountContext: null });
const malformedStateWizard = {
  account: upgradeAccountB,
  state: null,
  stateAccountId: '',
  needSetupReason: '',
  baseRevision: '',
};
assert.equal(await refreshWizardStateForAccount({
  api: {
    async get() {
      return { marker: 'missing-need-setup', wechat: { accounts: [upgradeAccountB] } };
    },
  },
  store: malformedStateStore,
  wiz: malformedStateWizard,
  account: upgradeAccountB,
  isCurrent: () => true,
}), false, '账号身份匹配但缺 need_setup 的畸形 state 仍必须拒绝');
assert.equal(malformedStateWizard.state, null, '畸形 state 不得写入向导');
assert.equal(malformedStateStore.get('state'), null, '畸形 state 不得写入共享 store');

const currentB = deferred();
const currentRefresh = refreshWizardStateForAccount({
  api: { get: () => currentB.promise },
  store: lateStore,
  wiz: lateWizard,
  account: upgradeAccountB,
  isCurrent: () => true,
});
currentB.resolve({ marker: 'current-b', need_setup: false, wechat: { accounts: [upgradeAccountB] } });
assert.equal(await currentRefresh, true, '精确匹配 B state 才能完成升级后的重新绑定');
assert.equal(lateWizard.state.marker, 'current-b');
assert.deepEqual(lateStore.get('stateAccountContext'), {
  accountId: upgradeAccountB.id,
  accountFingerprint: upgradeAccountB.manual_key_account_fingerprint,
});

const sameIdAccountA = {
  id: 'same-id-account',
  manual_key_account_fingerprint: 'fingerprint-a',
  display_name: '账号 A',
};
const sameIdAccountB = {
  id: 'same-id-account',
  manual_key_account_fingerprint: 'fingerprint-b',
  display_name: '账号 B',
};
const stateFromA = {
  marker: 'state-from-a',
  need_setup: false,
  wechat: { accounts: [sameIdAccountA], account_count: 1 },
};
const stateFromB = {
  marker: 'state-from-b',
  need_setup: false,
  wechat: { accounts: [sameIdAccountB], account_count: 1 },
};
const accountsResponse = deferred();
const stateResponses = [];
const refreshStore = createStore({
  account: sameIdAccountA,
  accounts: [sameIdAccountA],
  state: null,
  stateAccountContext: null,
});
const adoptedStates = [];
refreshStore.subscribe('state', value => {
  if (value?.marker) adoptedStates.push(value);
});
let refreshGeneration = 0;
let refreshDestroyed = false;
const refreshController = new AbortController();
const refreshWiz = {
  account: sameIdAccountA,
  accounts: [sameIdAccountA],
  state: null,
  stateAccountId: '',
  needSetupReason: '',
  baseRevision: '',
  key: { draft: '', validatedText: '', validation: null, savedText: '', saved: false, skipped: false },
  groups: null,
  done: false,
};
const refreshCtx = {
  store: refreshStore,
  api: {
    get(path) {
      const value = String(path);
      if (value.startsWith('/api/accounts')) return accountsResponse.promise;
      if (value.startsWith('/api/state?')) {
        const request = deferred();
        stateResponses.push(request);
        return request.promise;
      }
      throw new Error(`unexpected setup account GET: ${path}`);
    },
  },
  ui: {},
};
const refreshW = {
  ctx: refreshCtx,
  wiz: refreshWiz,
  get destroyed() { return refreshDestroyed; },
  signal: refreshController.signal,
  beginAsync() { refreshGeneration += 1; return refreshGeneration; },
  alive(token) { return !refreshDestroyed && token === refreshGeneration; },
  refreshButtons() {},
};
const { createAccountStep } = await createBrowserModuleLoader().load('js/pages/setup/step-account.js');

const staleReadyAccount = {
  id: 'stale-ready-account',
  manual_key_account_fingerprint: 'fingerprint-current',
};
const staleReadyWizard = {
  account: staleReadyAccount,
  accounts: [staleReadyAccount],
  // 模拟旧调用方留下了 stateAccountId,但 state 本体属于同 ID 的另一指纹。
  state: {
    marker: 'stale-ready-state',
    wechat: {
      accounts: [{
        id: staleReadyAccount.id,
        manual_key_account_fingerprint: 'fingerprint-old',
      }],
    },
  },
  stateAccountId: staleReadyAccount.id,
  needSetupReason: '',
  baseRevision: '',
  key: { draft: '', validatedText: '', validation: null, savedText: '', saved: false, skipped: false },
  groups: null,
  done: false,
};
const staleReadyStep = createAccountStep({
  ctx: {
    store: createStore({ account: staleReadyAccount, accounts: [staleReadyAccount] }),
    api: { get: async () => [] },
  },
  wiz: staleReadyWizard,
  get destroyed() { return false; },
  signal: new AbortController().signal,
  beginAsync() { return 1; },
  alive() { return true; },
  refreshButtons() {},
});
assert.equal(staleReadyStep.canContinue(), false,
  '第 1 步不得仅凭 stateAccountId 放行,必须先精确匹配 state 与账号 fingerprint');

const refreshStep = createAccountStep(refreshW);
refreshStep.onEnter();
await flush();
assert.equal(stateResponses.length, 1, '首次账号刷新必须发起一次状态读取');
accountsResponse.resolve([sameIdAccountB]);
stateResponses[0].resolve(stateFromA);
await flush();
assert.equal(adoptedStates.length, 0,
  '同 ID 指纹变化后,晚到的旧账号 state 不得被当前向导采用');
assert.notEqual(refreshStore.get('state'), stateFromA,
  '旧账号 state 不得进入当前 store');
assert.equal(refreshStep.canContinue(), false,
  '同 ID 新 fingerprint 的目标 state 返回前第 1 步不得继续');
assert.equal(stateResponses.length, 2,
  '检测到账号指纹变化后必须为最新账号重新读取 state');
stateResponses[1].resolve(stateFromB);
await flush();
assert.deepEqual(adoptedStates, [stateFromB],
  '重读成功后只能采用新指纹账号的 state');
assert.deepEqual(refreshStore.get('stateAccountContext'), {
  accountId: sameIdAccountB.id,
  accountFingerprint: 'fingerprint-b',
});
assert.equal(refreshStep.canContinue(), true,
  '采用新账号 state 后第 1 步才能继续');
refreshDestroyed = true;
refreshController.abort();

// 第 1 步离开时必须释放自己的复合刷新请求。仅递增 w.generation
// 只能阻止旧响应写回，不能阻止底层 API 在页面仍存活时继续挂起；同一步
// 重入还必须拿到新的 signal，旧账号响应晚到也不能覆盖新一代 state。
{
  const leaveAccount = { id: 'leave-account', manual_key_account_fingerprint: 'leave-fingerprint' };
  const leaveWiz = {
    account: leaveAccount,
    accounts: [leaveAccount],
    state: null,
    stateAccountId: '',
    needSetupReason: '',
    baseRevision: '',
    key: { draft: '', validatedText: '', validation: null, savedText: '', saved: false, skipped: false },
    groups: null,
    done: false,
  };
  const leaveStore = createStore({ account: leaveAccount, accounts: [leaveAccount] });
  const leaveRequests = [];
  const leaveController = new AbortController();
  let leaveGeneration = 0;
  const leaveW = {
    ctx: {
      store: leaveStore,
      api: {
        get(path, options = {}) {
          const request = deferred();
          leaveRequests.push({ path: String(path), signal: options.signal, ...request });
          return request.promise;
        },
      },
      ui: {},
    },
    wiz: leaveWiz,
    destroyed: false,
    signal: leaveController.signal,
    beginAsync() { leaveGeneration += 1; return leaveGeneration; },
    alive(token) { return token === leaveGeneration; },
    refreshButtons() {},
  };
  const leaveStep = createAccountStep(leaveW);
  leaveStep.onEnter();
  await flush();
  assert.equal(leaveRequests.length, 2,
    '账号步骤离开场景必须先发出 accounts/state 两个复合刷新请求');
  const firstLeaveRequests = leaveRequests.slice();
  assert.equal(typeof leaveStep.onExit, 'function',
    '账号步骤必须提供离步生命周期,以释放自己的刷新 owner');
  leaveStep.onExit();
  assert.ok(firstLeaveRequests.every(request => request.signal?.aborted === true),
    '离开账号步骤必须立即取消自己的 accounts/state 请求,不能只依赖页面销毁');

  leaveStep.onEnter();
  await flush();
  assert.equal(leaveRequests.length, 4,
    '同一步重入必须立即发起新的 accounts/state 请求');
  const secondLeaveRequests = leaveRequests.slice(2);
  assert.ok(secondLeaveRequests.every(request => request.signal?.aborted === false),
    '同一步重入必须使用新的可用请求 signal');
  assert.ok(secondLeaveRequests.every((request, index) => request.signal !== firstLeaveRequests[index].signal),
    '同一步重入不得复用已取消的旧请求 signal');

  secondLeaveRequests[0].resolve([leaveAccount]);
  secondLeaveRequests[1].resolve({
    marker: 'current-leave-state',
    need_setup: false,
    wechat: { accounts: [leaveAccount], account_count: 1 },
  });
  await flush();
  assert.equal(leaveWiz.state?.marker, 'current-leave-state',
    '重入后的当前 state 必须正常采用');

  firstLeaveRequests[0].resolve([leaveAccount]);
  firstLeaveRequests[1].resolve({
    marker: 'stale-leave-state',
    need_setup: true,
    wechat: { accounts: [leaveAccount], account_count: 1 },
  });
  await flush();
  assert.equal(leaveWiz.state?.marker, 'current-leave-state',
    '离步旧请求即使忽略 abort 晚到也不得覆盖重入后的 state');
}

const unboundAccount = {
  id: 'unbound-account',
  manual_key_account_fingerprint: 'unbound-fingerprint',
  display_name: '待确认账号',
};
const unrelatedState = {
  marker: 'unrelated-state',
  need_setup: false,
  wechat: {
    accounts: [{ id: 'different-account', manual_key_account_fingerprint: 'different-fingerprint' }],
    account_count: 1,
  },
};
const unboundAccountsResponse = deferred();
const unboundStateResponses = [];
const unboundStore = createStore({
  account: null,
  accounts: [],
  state: null,
  stateAccountContext: null,
});
let unboundGeneration = 0;
let unboundDestroyed = false;
const unboundController = new AbortController();
const unboundWiz = {
  account: null,
  accounts: [],
  state: null,
  stateAccountId: '',
  needSetupReason: '',
  baseRevision: '',
  key: { draft: '', validatedText: '', validation: null, savedText: '', saved: false, skipped: false },
  groups: null,
  done: false,
};
const unboundStep = createAccountStep({
  ctx: {
    store: unboundStore,
    api: {
      get(path) {
        if (String(path).startsWith('/api/accounts')) return unboundAccountsResponse.promise;
        if (String(path).startsWith('/api/state?')) {
          const request = deferred();
          unboundStateResponses.push(request);
          return request.promise;
        }
        throw new Error(`unexpected unbound setup GET: ${path}`);
      },
    },
  },
  wiz: unboundWiz,
  get destroyed() { return unboundDestroyed; },
  signal: unboundController.signal,
  beginAsync() { unboundGeneration += 1; return unboundGeneration; },
  alive(token) { return !unboundDestroyed && token === unboundGeneration; },
  refreshButtons() {},
});
unboundStep.onEnter();
await flush();
assert.equal(unboundStateResponses.length, 1, '未绑定账号首次刷新必须读取一次 state');
unboundAccountsResponse.resolve([unboundAccount]);
unboundStateResponses[0].resolve(unrelatedState);
await flush();
assert.equal(unboundStore.get('state'), null,
  '未绑定账号时返回不匹配的服务级 state 不得写入账号向导 store');
assert.equal(unboundStore.get('stateAccountContext'), null,
  '未绑定账号时不得建立错误的 state 账号上下文');
assert.equal(unboundStateResponses.length, 2,
  '唯一账号的 state 归属不匹配时必须重新读取目标账号 state');
assert.equal(unboundStep.canContinue(), false,
  '唯一账号重读完成前第 1 步必须保持阻塞');
unboundStateResponses[1].resolve({
  marker: 'bound-state',
  need_setup: false,
  wechat: { accounts: [unboundAccount], account_count: 1 },
});
await flush();
assert.equal(unboundStore.get('state')?.marker, 'bound-state',
  '目标账号 state 精确匹配后才能写入向导 store');
assert.equal(unboundStep.canContinue(), true,
  '目标账号 state 精确匹配后第 1 步才能继续');
unboundDestroyed = true;
unboundController.abort();

function extractFunction(source, name, prefix = 'async') {
  const marker = prefix ? `${prefix} function ${name}(` : `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `生产壳必须包含 ${name}`);
  const open = source.indexOf('{', start);
  assert.ok(open > start, `${name} 必须有函数体`);
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
  throw new Error(`${name} 函数体未闭合`);
}

function extractAsyncMethod(source, name) {
  const marker = `async ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `生产向导必须包含 ${name}`);
  const bodyMarker = source.indexOf(') {', start);
  assert.ok(bodyMarker > start, `${name} 必须有函数体`);
  const open = bodyMarker + 2;
  assert.ok(open > start, `${name} 必须有函数体`);
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
    else if (char === '}' && --depth === 0) {
      return `async function ${name}${source.slice(start + `async ${name}`.length, index + 1)}`;
    }
  }
  throw new Error(`${name} 方法体未闭合`);
}

function extractAssignedArrow(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `生产向导必须包含 ${marker}`);
  const functionStart = source.indexOf('() => {', start);
  assert.ok(functionStart >= start, `${marker} 必须是无参箭头函数`);
  const open = functionStart + '() => '.length;
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
    else if (char === '}' && --depth === 0) return source.slice(functionStart, index + 1);
  }
  throw new Error(`${marker} 函数体未闭合`);
}

const setupRenderSource = extractAssignedArrow(setupSource, 'page.render =');
const runSetupRender = new Function(
  'wiz',
  'page',
  'accountIdOf',
  'stateMatchesAccountContext',
  'stepForNeedSetupReason',
  `const gotoStep = index => { page.stepIndex = index; };\n`
    + `page.render = ${setupRenderSource};\nreturn page.render;`,
);
const renderAccountA = { id: 'render-account', manual_key_account_fingerprint: 'render-a' };
const renderAccountB = { id: 'render-account', manual_key_account_fingerprint: 'render-b' };
const renderPage = { initializing: true, stepIndex: 0 };
const renderWiz = {
  account: renderAccountB,
  stateAccountId: renderAccountB.id,
  state: { need_setup_reason: 'wechat_manual_key_required', wechat: { accounts: [renderAccountA] } },
  needSetupReason: 'wechat_manual_key_required',
};
runSetupRender(
  renderWiz,
  renderPage,
  accountIdOf,
  stateMatchesAccountContext,
  () => 3,
)();
assert.equal(renderPage.stepIndex, 0,
  '壳层初始步骤不得仅凭 stateAccountId 跳过第 1 步,旧指纹 state 必须保持未就绪');

const shellAccountIdSource = extractFunction(shellSource, 'shellAccountId', '');
const shellAccountFingerprintSource = extractFunction(shellSource, 'shellAccountFingerprint', '');
const shellAccountIdentitySource = extractFunction(shellSource, 'shellAccountContextIdentity', '');
const shellStateMatchSource = extractFunction(shellSource, 'shellStateMatchesAccount', '');
const shellRefreshStateSource = extractFunction(shellSource, 'refreshStateForAccount');
const shellRefreshState = new Function('api', 'store', 'requireServiceStatePayload', `
  let accountStateRequestEpoch = 0;
  let accountStateRequestController = null;
  ${shellAccountIdSource}
  ${shellAccountFingerprintSource}
  ${shellAccountIdentitySource}
  ${shellStateMatchSource}
  ${shellRefreshStateSource}
  return refreshStateForAccount;
`);
const shellAccountA = {
  id: 'shell-account',
  manual_key_account_fingerprint: 'shell-fingerprint-a',
};
const shellAccountB = {
  id: 'shell-account',
  manual_key_account_fingerprint: 'shell-fingerprint-b',
};
const shellStateFromA = {
  marker: 'shell-state-a',
  need_setup: false,
  wechat: { accounts: [shellAccountA], account_count: 1 },
};
const shellStateFromB = {
  marker: 'shell-state-b',
  need_setup: false,
  settings_revision: 'settings-fresh-b',
  wechat: { accounts: [shellAccountB], account_count: 1 },
};
const shellStaleStateFromB = {
  marker: 'shell-state-b-stale',
  need_setup: true,
  need_setup_reason: 'wechat_manual_key_required',
  settings_revision: 'settings-stale-b',
  wechat: { accounts: [shellAccountB], account_count: 1 },
};
const shellStateRequests = [];
const shellStore = createStore({
  account: shellAccountB,
  state: shellStateFromA,
  stateAccountContext: {
    accountId: shellAccountA.id,
    accountFingerprint: shellAccountA.manual_key_account_fingerprint,
  },
});
const shellApi = {
  get(path, options = {}) {
    assert.equal(path, '/api/state?account=shell-account');
    const request = deferred();
    request.signal = options.signal;
    shellStateRequests.push(request);
    return request.promise;
  },
};
const refreshShellState = shellRefreshState(shellApi, shellStore, requireServiceStatePayload);

// 壳层账号状态请求必须由完整账号 identity 的最新 owner 持有。A 请求即使
// 忽略 abort 并晚到，也不能继续占用 I/O 或覆盖同 ID/new fingerprint 的 B。
shellStore.set('account', shellAccountA);
const shellAccountAPending = refreshShellState(shellAccountA);
assert.ok(shellStateRequests[0].signal instanceof AbortSignal,
  '壳层账号 state GET 必须收到可取消 signal');
assert.equal(shellStateRequests[0].signal.aborted, false);
shellStore.set('account', shellAccountB);
const shellAccountBPending = refreshShellState(shellAccountB);
assert.equal(shellStateRequests[0].signal.aborted, true,
  '同 ID/new fingerprint 切换必须立即取消 A 的在途 state GET');
assert.ok(shellStateRequests[1].signal instanceof AbortSignal);
assert.notEqual(shellStateRequests[1].signal, shellStateRequests[0].signal,
  'B 必须持有独立于 A 的新请求 signal');
assert.equal(shellStateRequests[1].signal.aborted, false,
  '取消 A 不得误伤 B 的 state GET');
shellStateRequests[0].resolve(shellStateFromA);
await flush();
assert.equal(shellStore.get('state'), null,
  '忽略 abort 的 A 晚到响应不得写入 B 的共享 state');
shellStateRequests[1].resolve(shellStateFromB);
assert.equal(await shellAccountAPending, null,
  '被取代的 A 请求必须收敛为未采用');
assert.equal(await shellAccountBPending, shellStateFromB,
  '当前 B 请求必须成功采用精确 fingerprint state');
assert.equal(shellStore.get('state'), shellStateFromB);

shellStateRequests.length = 0;
const shellPending = refreshShellState(shellAccountB);
assert.equal(shellStore.get('state'), null,
  '主壳开始读取新账号时必须先清除来源账号 state');
shellStateRequests[0].resolve(shellStateFromA);
await flush();
assert.equal(shellStore.get('state'), null,
  '主壳不得把旧指纹的 state 写入同 ID 新指纹账号');
assert.equal(shellStateRequests.length, 2,
  '首次响应指纹不匹配时只允许发起一次有界重读');
shellStateRequests[1].resolve(shellStateFromB);
await shellPending;
assert.equal(shellStore.get('state'), shellStateFromB,
  '主壳重读成功后只能采用新指纹账号 state');
assert.deepEqual(shellStore.get('stateAccountContext'), {
  accountId: shellAccountB.id,
  accountFingerprint: shellAccountB.manual_key_account_fingerprint,
});

// 身份升级时向导会用 refresh=1 重读 B，壳层 account subscriber 同时还有一条
// 普通 state 请求。向导的新 owner 已采用 fresh B 后，壳层旧包即使也是同一
// fingerprint B，仍可能是请求开始前的 stale settings 快照，不能覆盖新 owner。
shellStateRequests.length = 0;
const concurrentShellRefresh = refreshShellState(shellAccountB);
assert.equal(shellStore.get('state'), null,
  '壳层并发刷新开始时仍应先撤掉请求前的旧快照');
shellStore.set('stateAccountContext', {
  accountId: shellAccountB.id,
  accountFingerprint: shellAccountB.manual_key_account_fingerprint,
});
shellStore.set('state', shellStateFromB);
shellStateRequests[0].resolve(shellStaleStateFromB);
assert.equal(await concurrentShellRefresh, shellStateFromB,
  '壳层晚到的同 fingerprint stale B 不得覆盖新 owner 的 fresh B');
assert.equal(shellStore.get('state'), shellStateFromB);
assert.equal(shellStateRequests.length, 1,
  '已有新 owner 的精确 B state 时不应为壳层旧包再发无意义重读');

shellStore.set('state', shellStateFromB);
shellStore.set('stateAccountContext', {
  accountId: shellAccountB.id,
  accountFingerprint: shellAccountB.manual_key_account_fingerprint,
});
const boundedRetryStart = shellStateRequests.length;
const boundedRetry = refreshShellState(shellAccountB);
assert.equal(shellStore.get('state'), null,
  '再次刷新账号时仍必须先清掉已有快照');
shellStateRequests[boundedRetryStart].resolve(shellStateFromA);
await flush();
assert.equal(shellStateRequests.length, boundedRetryStart + 2,
  '连续错配时不得超过一次重读');
shellStateRequests[boundedRetryStart + 1].resolve(shellStateFromA);
await boundedRetry;
assert.equal(shellStore.get('state'), null,
  '有界重读仍返回旧指纹时必须保持空状态而不是继续循环');
assert.equal(shellStateRequests.length, boundedRetryStart + 2);

const shellEmptyFingerprintAccount = {
  id: 'shell-empty-fingerprint-account',
  manual_key_account_fingerprint: '',
};
const shellOtherFingerprintState = {
  marker: 'shell-other-fingerprint-state',
  need_setup: false,
  wechat: {
    accounts: [{
      id: shellEmptyFingerprintAccount.id,
      manual_key_account_fingerprint: 'shell-fingerprint-from-other-context',
    }],
  },
};
const shellEmptyFingerprintState = {
  marker: 'shell-empty-fingerprint-state',
  need_setup: false,
  wechat: {
    accounts: [{
      id: shellEmptyFingerprintAccount.id,
      manual_key_account_fingerprint: '',
    }],
  },
};
const emptyFingerprintRequests = [];
const emptyFingerprintStore = createStore({
  account: shellEmptyFingerprintAccount,
  state: null,
  stateAccountContext: null,
});
const emptyFingerprintApi = {
  get(path) {
    assert.equal(path, '/api/state?account=shell-empty-fingerprint-account');
    const request = deferred();
    emptyFingerprintRequests.push(request);
    return request.promise;
  },
};
const emptyFingerprintPending = shellRefreshState(
  emptyFingerprintApi,
  emptyFingerprintStore,
  requireServiceStatePayload,
)(shellEmptyFingerprintAccount);
emptyFingerprintRequests[0].resolve(shellOtherFingerprintState);
await flush();
assert.equal(emptyFingerprintStore.get('state'), null,
  '当前账号 fingerprint 为空时不得采用同 ID 的非空 fingerprint state');
assert.equal(emptyFingerprintRequests.length, 2,
  '空 fingerprint 收到另一指纹 state 后必须只进行一次有界重读');
emptyFingerprintRequests[1].resolve(shellEmptyFingerprintState);
await emptyFingerprintPending;
assert.equal(emptyFingerprintStore.get('state'), shellEmptyFingerprintState,
  '空 fingerprint 账号只能采用同样为空的 state');

const applyUpgradeSource = extractAsyncMethod(setupSource, 'applyAccountIdentityUpgrade');
function createApplyUpgrade(page, wiz, ctx, abortController, showPageNotice) {
  return new Function(
    'page',
    'wiz',
    'ctx',
    'abortController',
    'showPageNotice',
    'accountIdOf',
    'bindWizardAccountContext',
    'findAccountByAnyId',
    'refreshWizardStateForAccount',
    'wizardAccountContextIdentity',
    `${applyUpgradeSource}\nreturn applyAccountIdentityUpgrade;`,
  )(
    page,
    wiz,
    ctx,
    abortController,
    showPageNotice,
    accountIdOf,
    bindWizardAccountContext,
    findAccountByAnyId,
    refreshWizardStateForAccount,
    wizardAccountContextIdentity,
  );
}
const helperPage = { destroyed: false, generation: 1 };
const helperAccountA = { id: 'helper-account', manual_key_account_fingerprint: 'helper-a' };
const helperAccountB = { id: 'helper-account', manual_key_account_fingerprint: 'helper-b' };
const helperStore = createStore({
  account: helperAccountA,
  state: { marker: 'helper-state-a' },
  stateAccountContext: { accountId: helperAccountA.id, accountFingerprint: 'helper-a' },
});
const helperWizard = {
  account: helperAccountA,
  accounts: [helperAccountA],
  state: { marker: 'helper-state-a' },
  stateAccountId: helperAccountA.id,
  needSetupReason: 'wechat_manual_key_required',
  baseRevision: 'helper-revision-a',
  key: { draft: 'helper-key-a', saved: true },
  groups: { account_id: helperAccountA.id, account_fingerprint: 'helper-a' },
  done: true,
};
const helperStateA = deferred();
const helperStateB = deferred();
const helperRequests = [];
const helperNotices = [];
const helperCtx = {
  store: helperStore,
  api: {
    get(path) {
      helperRequests.push(path);
      return helperRequests.length === 1 ? helperStateA.promise : helperStateB.promise;
    },
  },
};
const applyUpgrade = createApplyUpgrade(
  helperPage,
  helperWizard,
  helperCtx,
  new AbortController(),
  (...notice) => helperNotices.push(notice),
);
const pendingUpgrade = applyUpgrade(helperAccountB, { ownerToken: 1 });
assert.equal(helperRequests.length, 1,
  '真实身份升级 helper 必须在绑定新身份后发起一次 refresh=1 state 重读');
assert.equal(helperWizard.account, helperAccountB,
  '真实身份升级 helper 必须先绑定服务端返回的新账号对象');
assert.equal(helperWizard.state, null,
  '真实身份升级期间必须清空旧账号 state');
helperStateA.resolve({
  marker: 'late-helper-state-a',
  need_setup: false,
  wechat: { accounts: [helperAccountA] },
});
assert.equal(await pendingUpgrade, false,
  '真实身份升级 helper 不得采用迟到的旧指纹 state');
assert.equal(helperWizard.state, null,
  '迟到旧指纹 state 不得写回真实向导 helper');
assert.equal(helperStore.get('state'), null,
  '迟到旧指纹 state 不得写回真实 store');

const pendingCurrentUpgrade = applyUpgrade(helperAccountB, { ownerToken: 1 });
assert.equal(helperRequests.length, 2,
  '身份升级重试必须重新读取当前账号 state');
helperStateB.resolve({
  marker: 'current-helper-state-b',
  need_setup: false,
  wechat: { accounts: [helperAccountB] },
});
assert.equal(await pendingCurrentUpgrade, true,
  '只有精确匹配新指纹的 state 才能完成真实身份升级');
assert.equal(helperWizard.state.marker, 'current-helper-state-b');
assert.deepEqual(helperStore.get('stateAccountContext'), {
  accountId: helperAccountB.id,
  accountFingerprint: helperAccountB.manual_key_account_fingerprint,
});
assert.equal(helperNotices.at(-1)?.[0], 'info',
  '真实身份升级成功后才允许报告同步完成');

console.log('web setup account switch tests passed');
