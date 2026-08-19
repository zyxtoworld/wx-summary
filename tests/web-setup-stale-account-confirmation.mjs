import assert from 'node:assert/strict';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

class MemoryStorage {
  #values = new Map();

  getItem(key) { return this.#values.get(String(key)) ?? null; }
  setItem(key, value) { this.#values.set(String(key), String(value)); }
  removeItem(key) { this.#values.delete(String(key)); }
}

globalThis.location = new URL('http://wx-summary.test/');
globalThis.history = { state: null, replaceState() {} };
globalThis.sessionStorage = new MemoryStorage();

const browserModuleLoader = createBrowserModuleLoader();
const { createKeyStep } = await browserModuleLoader.load('js/pages/setup/step-key.js');
const { createAccountStep } = await browserModuleLoader.load('js/pages/setup/step-account.js');

class FakeText {
  constructor(text = '') {
    this.textContent = String(text ?? '');
    this.parentElement = null;
  }

  get isConnected() { return !!this.parentElement?.isConnected; }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || '').toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.type = '';
    this.value = '';
    this.id = '';
    this.placeholder = '';
    this.autocomplete = '';
    this.spellcheck = true;
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this._textContent = '';
    this.classList = {
      add: (...names) => {
        const current = new Set(this.className.split(/\s+/).filter(Boolean));
        names.forEach(name => current.add(name));
        this.className = [...current].join(' ');
      },
      remove: (...names) => {
        const current = new Set(this.className.split(/\s+/).filter(Boolean));
        names.forEach(name => current.delete(name));
        this.className = [...current].join(' ');
      },
      toggle: (name, force) => {
        const current = new Set(this.className.split(/\s+/).filter(Boolean));
        const next = force === undefined ? !current.has(name) : Boolean(force);
        if (next) current.add(name); else current.delete(name);
        this.className = [...current].join(' ');
        return next;
      },
      contains: name => this.className.split(/\s+/).includes(name),
    };
  }

  get textContent() {
    return this.children.length
      ? this.children.map(child => child.textContent || '').join('')
      : this._textContent;
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

  remove() {
    const parent = this.parentElement;
    if (!parent) return;
    parent.children = parent.children.filter(child => child !== this);
    this.parentElement = null;
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
    if (name === 'id') this.id = String(value);
  }

  getAttribute(name) { return this.attributes.get(String(name)) ?? null; }

  addEventListener(type, listener) {
    const list = this.listeners.get(String(type)) || [];
    list.push(listener);
    this.listeners.set(String(type), list);
  }

  removeEventListener(type, listener) {
    const list = this.listeners.get(String(type)) || [];
    this.listeners.set(String(type), list.filter(item => item !== listener));
  }

  click() {
    this.ownerDocument.activeElement = this;
    const event = {
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() {},
    };
    return Promise.all((this.listeners.get('click') || []).map(listener => listener(event)));
  }

  userClick() {
    if (this.disabled) return Promise.resolve([]);
    return this.click();
  }

  focus() { this.ownerDocument.activeElement = this; }

  matches(selector) {
    const clean = String(selector || '').trim();
    const attr = clean.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    if (attr) {
      const [, name, expected] = attr;
      const dataName = name.startsWith('data-')
        ? name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
        : '';
      const actual = dataName ? this.dataset[dataName] : this.getAttribute(name);
      return expected === undefined ? actual !== undefined : String(actual ?? '') === expected;
    }
    if (clean.startsWith('.')) return this.classList.contains(clean.slice(1));
    return this.tagName.toLowerCase() === clean.toLowerCase();
  }

  querySelectorAll(selector) {
    const found = [];
    const visit = node => {
      for (const child of node.children) {
        if (child.matches?.(selector)) found.push(child);
        child.children && visit(child);
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

const document = {
  activeElement: null,
  createElement(tagName) { return new FakeElement(tagName, document); },
  createTextNode(text) { return new FakeText(text); },
};
document.body = new FakeElement('body', document);
globalThis.document = document;

globalThis.localStorage = new MemoryStorage();

function account(id, fingerprint, sourceTime) {
  return {
    id,
    account_id: id,
    manual_key_account_fingerprint: fingerprint,
    source: 'project-mirror',
    source_last_write_time: sourceTime,
    mirror: { source_status: 'available', source_available: true },
  };
}

function stateFor(accountValue) {
  return {
    need_setup: true,
    settings_revision: 'revision-1',
    wechat: {
      accounts: [accountValue],
      manual_key_configured: true,
      manual_key_verified: false,
    },
  };
}

function createHarness({ post, request = async () => {
  throw new Error('unexpected settings request');
} }) {
  let generation = 0;
  const selected = account('account-old', 'fingerprint-old', '2026-01-01T00:00:00.000Z');
  const suggested = account('account-new', 'fingerprint-new', '2026-08-01T00:00:00.000Z');
  const wiz = {
    account: selected,
    accounts: [selected, suggested],
    state: stateFor(selected),
    baseRevision: 'revision-1',
    key: { saved: false, draft: '' },
  };
  const storeValues = new Map();
  const api = {
    post,
    request,
    async get(url) {
      if (String(url).includes('/status-progress')) return { done: true };
      if (String(url).includes('/api/settings?wait_for_writes=1')) {
        return { settings: { settings_revision: 'revision-1' }, settings_revision: 'revision-1' };
      }
      if (String(url).includes('/api/state')) return stateFor(wiz.account);
      throw new Error(`unexpected GET ${url}`);
    },
  };
  const w = {
    ctx: {
      api,
      store: {
        get(key, fallback = undefined) { return storeValues.has(key) ? storeValues.get(key) : fallback; },
        set(key, value) { storeValues.set(key, value); },
      },
      ui: {
        spinner() { return document.createElement('span'); },
        async confirmDialog() { return true; },
      },
    },
    wiz,
    signal: new AbortController().signal,
    get destroyed() { return false; },
    beginAsync() { generation += 1; return generation; },
    alive(token) { return token === generation; },
    refreshButtons() {},
    async applyAccountIdentityUpgrade() { return false; },
    switchToAccount: async next => {
      wiz.account = next;
      generation += 1;
      wiz.state = stateFor(next);
      return true;
    },
  };
  return { w, wiz, selected, suggested, api };
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
  await Promise.resolve();
}

const staleError = () => Object.assign(new Error('当前选中的是旧微信账号目录'), {
  status: 409,
  code: 'wechat_account_stale_selected',
  payload: {
    code: 'wechat_account_stale_selected',
    key_diagnostics: {
      account_stale_days: 120,
      selected_account_label: '旧账号',
      suggested_account_id: 'account-new',
      suggested_account_label: '新账号',
      suggested_account_last_write_time: '2026-08-01T00:00:00.000Z',
      source_account_unavailable: false,
    },
  },
});

function mountKeyStep(harness) {
  const step = createKeyStep(harness.w);
  document.body.appendChild(step.el);
  const validateSavedButton = step.el.querySelectorAll('button')
    .find(button => button.textContent === '验证已保存候选');
  const validateSaveButton = step.el.querySelectorAll('button')
    .find(button => button.textContent === '验证并保存');
  const keyInput = step.el.querySelectorAll('textarea')[0] || null;
  assert.ok(validateSavedButton, 'fixture must expose the saved-key validation action');
  assert.ok(validateSaveButton, 'fixture must expose the manual-key validation/save action');
  assert.ok(keyInput, 'fixture must expose the manual-key input');
  return { step, validateSavedButton, validateSaveButton, keyInput };
}

function staleAction(step, label) {
  return step.el.querySelectorAll('[data-manual-key-stale-action]')
    .find(button => button.textContent === label);
}

function requestParams(request) {
  return new URL(request.url, 'http://wx-summary.test/').searchParams;
}

// 409 后确认只对当前账号快照生效;服务端再次拒绝时,旧确认不能被第三次请求复用。
const confirmationPosts = [];
const confirmationHarness = createHarness({
  async post(url, body) {
    confirmationPosts.push({ url, body });
    throw staleError();
  },
});
const confirmationStep = mountKeyStep(confirmationHarness);
await confirmationStep.validateSavedButton.click();
await flush();
const firstStaleActions = confirmationStep.step.el.querySelectorAll('[data-manual-key-stale-action]');
assert.equal(firstStaleActions.length, 2,
  'stale-account 409 must expose exactly two actionable recovery choices');
assert.ok(staleAction(confirmationStep.step, '仍使用旧目录'),
  'stale-account recovery must expose the old-directory confirmation action');
assert.ok(staleAction(confirmationStep.step, '切换到最近同步账号'),
  'stale-account recovery must expose the fresh-account switch action');

await staleAction(confirmationStep.step, '仍使用旧目录').click();
await flush();
await confirmationStep.validateSavedButton.click();
await flush();
const confirmedParams = requestParams(confirmationPosts[1]);
assert.equal(confirmedParams.get('account'), 'account-old');
assert.equal(confirmedParams.get('allow_stale_account'), 'true');
assert.equal(confirmedParams.get('stale_account_confirmation'),
  'account-old|2026-01-01T00:00:00.000Z|account-new|');
assert.equal(confirmationPosts[1].body.allow_stale_account, true);
assert.equal(confirmationPosts[1].body.stale_account_confirmation,
  'account-old|2026-01-01T00:00:00.000Z|account-new|');

await confirmationStep.validateSavedButton.click();
await flush();
const afterRetryParams = requestParams(confirmationPosts[2]);
assert.equal(afterRetryParams.get('allow_stale_account'), null,
  'a stale confirmation must be one-shot after the retry response');
assert.equal(confirmationPosts[2].body.allow_stale_account, undefined);

// 关闭步骤后重新挂载也必须丢弃旧确认,不能把上一次页面的授权带进新检查。
const closedPosts = [];
const closedHarness = createHarness({
  async post(url, body) {
    closedPosts.push({ url, body });
    if (closedPosts.length === 1) throw staleError();
    return { key: { message_db_verified: true } };
  },
});
const closedStep = mountKeyStep(closedHarness);
await closedStep.validateSavedButton.click();
await flush();
await staleAction(closedStep.step, '仍使用旧目录').click();
await flush();
closedStep.step.onExit();
closedStep.step.el.remove();
const remountedClosedStep = mountKeyStep(closedHarness);
await remountedClosedStep.validateSavedButton.click();
await flush();
assert.equal(closedPosts[1].body.allow_stale_account, undefined,
  'a remounted step must not reuse a confirmation from the closed step');

// 手动验证成功后还会进入真实 PUT /api/settings;同一确认值必须沿 owner 交接传到保存请求。
const savePosts = [];
const saveRequests = [];
const saveHarness = createHarness({
  async post(url, body) {
    savePosts.push({ url, body });
    if (savePosts.length === 1) throw staleError();
    return { key: { message_db_verified: true } };
  },
  async request(url, options) {
    saveRequests.push({ url, options });
    return {
      ok: true,
      settings: { settings_revision: 'revision-2' },
      settings_revision: 'revision-2',
    };
  },
});
const saveStep = mountKeyStep(saveHarness);
saveStep.keyInput.value = 'a'.repeat(64);
await saveStep.validateSaveButton.click();
await flush();
await staleAction(saveStep.step, '仍使用旧目录').click();
await flush();
await saveStep.validateSaveButton.click();
await flush();
assert.equal(savePosts.length, 2, 'manual validation must retry exactly once after confirmation');
assert.equal(saveRequests.length, 1, 'confirmed manual validation must continue into one settings save');
assert.equal(saveRequests[0].options.body.allow_stale_account, true,
  'settings save must carry stale-account authorization');
assert.equal(saveRequests[0].options.body.stale_account_confirmation,
  'account-old|2026-01-01T00:00:00.000Z|account-new|',
  'settings save must carry the exact current stale-account confirmation');
assert.equal(saveRequests[0].options.body._request_context.allow_stale_account, true,
  'settings save request context must carry stale-account authorization');
assert.equal(saveRequests[0].options.body._request_context.stale_account_confirmation,
  'account-old|2026-01-01T00:00:00.000Z|account-new|',
  'settings save request context must carry the exact confirmation');

// “切换到最近同步账号”必须经过账号切换 seam;切换后新的检查不能携带 A 的确认值。
const switchPosts = [];
const switchHarness = createHarness({
  async post(url, body) {
    switchPosts.push({ url, body });
    if (switchPosts.length === 1) throw staleError();
    return { key: { message_db_verified: true } };
  },
});
const switchStep = mountKeyStep(switchHarness);
await switchStep.validateSavedButton.click();
await flush();
await staleAction(switchStep.step, '切换到最近同步账号').click();
await flush();
assert.equal(switchHarness.wiz.account.id, 'account-new',
  'fresh-account action must invoke the account-switch/refresh seam');
await switchStep.validateSavedButton.click();
await flush();
const switchedParams = requestParams(switchPosts[1]);
assert.equal(switchedParams.get('account'), 'account-new');
assert.equal(switchedParams.get('allow_stale_account'), null,
  'a check for the new account must not carry the old account confirmation');
assert.equal(switchPosts[1].body.allow_stale_account, undefined);

// A 请求在途时换到 B;A 的晚到 stale 409 不能生成 B 页面上的恢复按钮或污染 B 检查。
let rejectLateA;
const lateA = new Promise((resolve, reject) => { rejectLateA = reject; });
const latePosts = [];
const lateHarness = createHarness({
  post(url, body) {
    latePosts.push({ url, body });
    return latePosts.length === 1
      ? lateA
      : Promise.resolve({ key: { message_db_verified: true } });
  },
});
const lateStep = mountKeyStep(lateHarness);
await lateStep.validateSavedButton.click();
await flush();
await lateHarness.w.switchToAccount(lateHarness.suggested);
rejectLateA(staleError());
await flush();
await flush();
assert.equal(lateStep.step.el.querySelectorAll('[data-manual-key-stale-action]').length, 0,
  'late A stale response must not paint recovery actions after switching to B');
await lateStep.validateSavedButton.click();
await flush();
const lateBParams = requestParams(latePosts[1]);
assert.equal(lateBParams.get('account'), 'account-new');
assert.equal(lateBParams.get('allow_stale_account'), null);

// 切换到最近同步账号的状态读取仍在途时,密钥步骤自己的验证按钮必须锁住。
// 真实 DOM 不会为 disabled button 派发 click;若 owner 没有占用 busy,第二次验证
// 会在新账号 state 采用前发出第二个 /api/wechat/status。
let resolvePendingSwitch;
const pendingSwitch = new Promise(resolve => { resolvePendingSwitch = resolve; });
const pendingSwitchPosts = [];
const pendingSwitchHarness = createHarness({
  async post(url, body) {
    pendingSwitchPosts.push({ url, body });
    if (pendingSwitchPosts.length === 1) throw staleError();
    return { key: { message_db_verified: true } };
  },
});
pendingSwitchHarness.w.switchToAccount = async accountValue => {
  pendingSwitchHarness.wiz.account = accountValue;
  return pendingSwitch;
};
const pendingSwitchStep = mountKeyStep(pendingSwitchHarness);
await pendingSwitchStep.validateSavedButton.userClick();
await flush();
const switchClick = staleAction(pendingSwitchStep.step, '切换到最近同步账号').click();
await flush();
assert.equal(pendingSwitchHarness.wiz.account.id, 'account-new',
  'switch recovery must bind the suggested account before its state refresh resolves');
assert.equal(pendingSwitchStep.validateSavedButton.disabled, true,
  'switch recovery must keep the key-step validation controls busy while account state loads');
await pendingSwitchStep.validateSavedButton.userClick();
await flush();
assert.equal(pendingSwitchPosts.length, 1,
  'a second saved-key validation must not start before the suggested account state is ready');
resolvePendingSwitch(true);
await switchClick;
await flush();

// 账号步骤的公开 seam 必须执行真实的 bind + /api/state refresh,而不是只改 wiz.account。
const accountStepPosts = [];
const accountStepOld = account('account-old-step', 'fingerprint-old-step', '2026-01-01T00:00:00.000Z');
const accountStepNew = account('account-new-step', 'fingerprint-new-step', '2026-08-01T00:00:00.000Z');
const accountStepValues = new Map();
let accountStepGeneration = 0;
const accountStepWiz = {
  account: accountStepOld,
  accounts: [accountStepOld, accountStepNew],
  state: stateFor(accountStepOld),
  stateAccountId: accountStepOld.id,
};
const accountStepW = {
  ctx: {
    api: {
      async get(url) {
        accountStepPosts.push(String(url));
        return stateFor(accountStepNew);
      },
    },
    store: {
      get(key, fallback = undefined) { return accountStepValues.has(key) ? accountStepValues.get(key) : fallback; },
      set(key, value) { accountStepValues.set(key, value); },
    },
  },
  wiz: accountStepWiz,
  signal: new AbortController().signal,
  destroyed: false,
  beginAsync() { accountStepGeneration += 1; return accountStepGeneration; },
  alive(token) { return token === accountStepGeneration; },
  refreshButtons() {},
};
const accountStep = createAccountStep(accountStepW);
await accountStep.selectAccount(accountStepNew);
assert.equal(accountStepWiz.account.id, 'account-new-step');
assert.ok(accountStepPosts.some(url => url.includes('/api/state?refresh=1&account=account-new-step')),
  'fresh-account branch must re-read state through the account step');
assert.equal(accountStepWiz.stateAccountId, 'account-new-step');

console.log('web setup stale-account confirmation behavior passed');
