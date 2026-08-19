import assert from 'node:assert/strict';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

class MemoryStorage {
  constructor() { this.data = new Map(); }
  getItem(key) { return this.data.get(String(key)) ?? null; }
  setItem(key, value) { this.data.set(String(key), String(value)); }
  removeItem(key) { this.data.delete(String(key)); }
}

class TrackingSignal {
  aborted = false;
  reason = null;
  listeners = new Set();
  addCount = 0;
  removeCount = 0;

  addEventListener(type, listener) {
    if (type !== 'abort') return;
    this.addCount += 1;
    this.listeners.add(listener);
  }

  removeEventListener(type, listener) {
    if (type !== 'abort') return;
    this.removeCount += 1;
    this.listeners.delete(listener);
  }
}

class FakeElement {
  constructor(tagName, ownerDocument, text = '') {
    this.tagName = String(tagName || '').toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.listeners = new Map();
    this.attributes = new Map();
    this._textContent = String(text ?? '');
    this.classList = {
      add: (...names) => {
        const current = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const name of names) current.add(String(name));
        this.className = [...current].join(' ');
      },
      remove: (...names) => {
        const removed = new Set(names.map(String));
        this.className = this.className.split(/\s+/).filter(name => name && !removed.has(name)).join(' ');
      },
      contains: name => this.className.split(/\s+/).includes(String(name)),
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

  addEventListener(type, listener) { this.listeners.set(String(type), listener); }

  click() {
    this.ownerDocument.activeElement = this;
    return this.listeners.get('click')?.({
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() {},
    });
  }

  userClick() {
    if (this.disabled) return Promise.resolve();
    return this.click();
  }

  focus() { this.ownerDocument.activeElement = this; }

  matches(selector) {
    const clean = String(selector || '').trim();
    if (clean.startsWith('.')) return this.className.split(/\s+/).includes(clean.slice(1));
    return this.tagName.toLowerCase() === clean.toLowerCase();
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

globalThis.location = new URL('http://wx-summary.test/#/setup');
globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage();
const documentTarget = {
  activeElement: null,
  createElement(tagName) { return new FakeElement(tagName, documentTarget); },
  createTextNode(text) { return new FakeElement('#text', documentTarget, text); },
};
documentTarget.body = new FakeElement('body', documentTarget);
documentTarget.documentElement = new FakeElement('html', documentTarget);
documentTarget.activeElement = documentTarget.body;
globalThis.document = documentTarget;

const loader = createBrowserModuleLoader();
const { waitForSetupProgressDelay, createKeyStep } = await loader.load('js/pages/setup/step-key.js');
const { saveWizardSettings } = await loader.load('js/pages/setup/state.js');
const { writeSettingsPatch } = await loader.load('js/shared/settings-write-coordinator.js');
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

try {
  const timers = new Map();
  let nextTimerId = 0;
  globalThis.setTimeout = callback => {
    const id = ++nextTimerId;
    timers.set(id, callback);
    return id;
  };
  globalThis.clearTimeout = id => {
    timers.delete(id);
  };

  const abortedSignal = new TrackingSignal();
  const abortReason = new Error('页面已卸载');
  abortedSignal.aborted = true;
  abortedSignal.reason = abortReason;
  await assert.rejects(
    waitForSetupProgressDelay(800, abortedSignal),
    error => error === abortReason,
    '已取消的向导延时应保留 signal reason',
  );
  assert.equal(abortedSignal.listeners.size, 0,
    'signal 已经 aborted 时也必须移除手动触发路径注册的监听器');
  assert.equal(abortedSignal.addCount, abortedSignal.removeCount,
    '已取消的向导延时不得泄漏 abort 监听器');
  assert.equal(timers.size, 0, '已取消的向导延时必须清除定时器');

  const completedSignal = new TrackingSignal();
  const completed = waitForSetupProgressDelay(800, completedSignal);
  assert.equal(timers.size, 1);
  const [timerId, callback] = timers.entries().next().value;
  callback();
  await completed;
  assert.equal(completedSignal.listeners.size, 0,
    '正常完成的向导延时必须移除 abort 监听器');
  assert.equal(completedSignal.addCount, completedSignal.removeCount);
  assert.equal(timers.has(timerId), false);
} finally {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}

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

async function runStaleStatusScenario({ rejectPost, rejectProgress = false }) {
  const statusRequests = [];
  const statusOptions = [];
  const progressRequests = [];
  let generation = 0;
  let destroyed = false;
  const controller = new AbortController();
  const account = { id: 'setup-account-a' };
  const wiz = {
    account,
    accounts: [account],
    baseRevision: 'settings-revision-a',
    state: { wechat: { manual_key_required: true } },
    key: { draft: '', saved: false, skipped: false },
  };
  const ctx = {
    api: {
      get(path, options = {}) {
        const value = String(path);
        if (value.startsWith('/api/state?')) {
          return Promise.resolve({
            need_setup: false,
            wechat: { accounts: [account], manual_key_required: true },
          });
        }
        if (value.startsWith('/api/wechat/status-progress')) {
          const request = deferred();
          progressRequests.push({ ...request, signal: options.signal });
          return request.promise;
        }
        throw new Error(`unexpected GET: ${path}`);
      },
      post(path, _body, options = {}) {
        if (String(path).startsWith('/api/wechat/status')) {
          const request = deferred();
          statusRequests.push(request);
          statusOptions.push(options);
          return request.promise;
        }
        throw new Error(`unexpected POST: ${path}`);
      },
    },
    store: {
      get(key) {
        if (key === 'account') return account;
        if (key === 'state') return wiz.state;
        if (key === 'stateAccountContext') return { accountId: account.id };
        if (key === 'accounts') return [account];
        return null;
      },
      set() {},
    },
    ui: { spinner: () => documentTarget.createElement('span') },
  };
  const w = {
    ctx,
    wiz,
    get destroyed() { return destroyed; },
    signal: controller.signal,
    beginAsync() { generation += 1; return generation; },
    alive(token) { return !destroyed && token === generation; },
    refreshButtons() {},
    gotoStep() {},
    showPageNotice() {},
    applyAccountIdentityUpgrade() {},
  };
  const keyStep = createKeyStep(w);
  documentTarget.body.appendChild(keyStep.el);
  keyStep.onEnter();
  await flush();
  const mainStatus = keyStep.el.querySelector('.setup-status');
  const progressLine = keyStep.el.querySelector('.setup-progress-line');
  const statusBeforeOldCompletion = mainStatus?.textContent || '';
  const scanButton = keyStep.el.querySelector('button');
  assert.ok(scanButton, '密钥步骤必须提供自动扫描按钮');

  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  let nextTimerId = 0;
  globalThis.setTimeout = (callback, _ms) => {
    const id = ++nextTimerId;
    timers.set(id, callback);
    return id;
  };
  globalThis.clearTimeout = id => { timers.delete(id); };
  try {
    scanButton.click();
    for (let attempt = 0; attempt < 10 && statusRequests.length < 1; attempt += 1) await flush();
    for (let attempt = 0; attempt < 10 && progressRequests.length < 1; attempt += 1) await flush();
    assert.equal(statusRequests.length, 1, '首个自动扫描必须发出主验证请求');
    assert.ok(statusOptions[0]?.timeoutMs >= 300_000,
      '自动扫描客户端超时必须覆盖后端五分钟扫描预算,不能在服务端合法超时前截断');
    assert.equal(progressRequests.length, 1, '首个自动扫描必须启动进度轮询');

    // 防御性 owner 合同:向导代次切换会调用 w.beginAsync();这里直接调用该生产边界，
    // 不伪造第二次 disabled button click,也不宣称建立了第二个真实 action。
    // 共享 busy 仍由首个 action 持有,当前 progress 仅作为旧 completion 不得覆盖/清空的观察 seam。
    w.beginAsync();
    progressLine.textContent = '当前 owner 进度保持动作';
    const currentProgress = progressLine?.textContent || '';
    assert.match(currentProgress, /当前 owner 进度/, 'owner seam 必须有可观察的当前进度');
    assert.equal(keyStep.isBusy(), true, '旧 owner completion 前共享 busy 必须仍被持有');

    // 旧轮询晚到且要求继续下一轮:不得投影旧 label,也不得创建第三轮请求。
    if (rejectProgress) progressRequests[0].reject(new Error('旧进度请求失败'));
    else progressRequests[0].resolve({ label: '旧代次进度', detail: '不应显示', done: false });
    await flush();
    assert.equal(progressLine?.textContent || '', currentProgress,
      '旧轮询晚到响应不得改写当前代次进度');
    assert.equal(timers.size, 0, '旧 owner 失效后不得进入下一轮轮询 sleep');

    if (rejectPost) statusRequests[0].reject(new Error('旧主请求失败'));
    else statusRequests[0].resolve({ key: { message_sample_verified: true } });
    await flush();
    assert.equal(mainStatus?.textContent || '', statusBeforeOldCompletion,
      '旧主请求完成不得改写当前步骤状态');
    assert.equal(progressLine?.textContent || '', currentProgress,
      '旧主请求完成不得清掉当前代次进度');
    assert.equal(keyStep.isBusy(), true, '旧主请求完成不得释放当前代次 busy');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    destroyed = true;
    controller.abort();
  }
}

await runStaleStatusScenario({ rejectPost: true });
await runStaleStatusScenario({ rejectPost: false, rejectProgress: true });

// 真实步骤离开边界:主验证与进度查询都已发出时切到下一步;
// onExit 必须立即终止该步骤持有的网络/定时器，并释放旧步骤 busy。
{
  const statusRequests = [];
  const statusOptions = [];
  const progressRequests = [];
  let generation = 0;
  let destroyed = false;
  const controller = new AbortController();
  const account = { id: 'setup-step-exit-account' };
  const wiz = {
    account,
    accounts: [account],
    baseRevision: 'setup-step-exit-revision',
    state: { wechat: { manual_key_required: true } },
    key: { draft: '', saved: false, skipped: false },
  };
  const ctx = {
    api: {
      get(path, options = {}) {
        const value = String(path);
        if (value.startsWith('/api/state?')) {
          return Promise.resolve({
            need_setup: false,
            wechat: { accounts: [account], manual_key_required: true },
          });
        }
        if (value.startsWith('/api/wechat/status-progress')) {
          const request = deferred();
          progressRequests.push({ ...request, signal: options.signal });
          return request.promise;
        }
        throw new Error(`unexpected step-exit GET: ${path}`);
      },
      post(path, _body, options = {}) {
        if (String(path).startsWith('/api/wechat/status')) {
          const request = deferred();
          statusRequests.push(request);
          statusOptions.push(options);
          return request.promise;
        }
        throw new Error(`unexpected step-exit POST: ${path}`);
      },
    },
    store: {
      get(key) {
        if (key === 'account') return account;
        if (key === 'state') return wiz.state;
        if (key === 'stateAccountContext') return { accountId: account.id };
        if (key === 'accounts') return [account];
        return null;
      },
      set() {},
    },
    ui: { spinner: () => documentTarget.createElement('span') },
  };
  const w = {
    ctx,
    wiz,
    get destroyed() { return destroyed; },
    signal: controller.signal,
    beginAsync() { generation += 1; return generation; },
    alive(token) { return !destroyed && token === generation; },
    refreshButtons() {},
    gotoStep() {},
    showPageNotice() {},
    applyAccountIdentityUpgrade() {},
  };
  const step = createKeyStep(w);
  documentTarget.body.appendChild(step.el);
  step.onEnter();
  await flush();
  const scanButton = step.el.querySelector('button');
  assert.ok(scanButton, '步骤离开场景必须能通过真实自动扫描按钮启动动作');
  scanButton.click();
  for (let attempt = 0; attempt < 20
    && (!statusRequests.length || !progressRequests.length); attempt += 1) await flush();
  assert.equal(statusRequests.length, 1, '步骤离开前必须发出主验证请求');
  assert.equal(progressRequests.length, 1, '步骤离开前必须发出进度请求');

  const statusBeforeLate = step.el.querySelector('.setup-status')?.textContent || '';
  const progressBeforeLate = step.el.querySelector('.setup-progress-line')?.textContent || '';
  w.beginAsync(); // 对应向导 goNext 在调用当前步骤 onExit 前推进代次。
  step.onExit?.();
  assert.equal(statusOptions[0]?.signal?.aborted, true,
    '离开密钥步骤必须立即取消仍在途的主验证请求');
  assert.equal(progressRequests[0]?.signal?.aborted, true,
    '离开密钥步骤必须立即取消仍在途的进度请求');
  assert.equal(step.isBusy(), false,
    '离开密钥步骤后旧步骤不得永久保留 busy');

  statusRequests[0].resolve({ key: { message_sample_verified: true } });
  progressRequests[0].resolve({ label: '离开后的旧进度', detail: '不得显示', done: false });
  await flush();
  assert.equal(step.el.querySelector('.setup-status')?.textContent || '', statusBeforeLate,
    '离开步骤后的主验证 late resolve 不得写旧步骤状态');
  assert.equal(step.el.querySelector('.setup-progress-line')?.textContent || '', progressBeforeLate,
    '离开步骤后的进度 late resolve 不得写旧步骤进度');
  destroyed = true;
  controller.abort();
}

{
  const statusRequests = [];
  const progressRequests = [];
  let generation = 0;
  let destroyed = false;
  const controller = new AbortController();
  const account = { id: 'progress-stop-account' };
  const wiz = {
    account,
    accounts: [account],
    baseRevision: 'progress-stop-revision',
    state: { wechat: { accounts: [account], manual_key_required: true } },
    key: { draft: '', saved: false, skipped: false },
  };
  const ctx = {
    api: {
      get(path, options = {}) {
        const value = String(path);
        if (value.startsWith('/api/state?')) {
          return Promise.resolve({
            need_setup: false,
            wechat: { accounts: [account], manual_key_verified: true },
          });
        }
        if (value.startsWith('/api/wechat/status-progress')) {
          const request = deferred();
          progressRequests.push({ ...request, signal: options.signal });
          return request.promise;
        }
        throw new Error(`unexpected progress-stop GET: ${path}`);
      },
      post(path) {
        if (!String(path).startsWith('/api/wechat/status')) {
          throw new Error(`unexpected progress-stop POST: ${path}`);
        }
        const request = deferred();
        statusRequests.push(request);
        return request.promise;
      },
    },
    store: { get() { return null; }, set() {} },
    ui: { spinner: () => documentTarget.createElement('span') },
  };
  const w = {
    ctx,
    wiz,
    get destroyed() { return destroyed; },
    signal: controller.signal,
    beginAsync() { generation += 1; return generation; },
    alive(token) { return !destroyed && token === generation; },
    refreshButtons() {},
    gotoStep() {},
    showPageNotice() {},
    applyAccountIdentityUpgrade() {},
  };
  const step = createKeyStep(w);
  documentTarget.body.appendChild(step.el);
  step.onEnter();
  await flush();
  const scanButton = step.el.querySelector('button');
  const progressLine = step.el.querySelector('.setup-progress-line');
  scanButton.click();
  for (let attempt = 0; attempt < 10 && (!statusRequests.length || !progressRequests.length); attempt += 1) await flush();
  assert.equal(statusRequests.length, 1, '真实自动扫描必须发起主请求');
  assert.equal(progressRequests.length, 1, '真实自动扫描必须同时发起一条进度请求');
  assert.equal(progressRequests[0].signal?.aborted, false,
    '主请求在途时进度请求 signal 必须保持可用');

  statusRequests[0].resolve({ db: { message_sample_verified: true } });
  for (let attempt = 0; attempt < 10 && step.isBusy(); attempt += 1) await flush();
  assert.equal(step.isBusy(), false, '主请求完成后真实动作必须退出 busy');
  assert.equal(progressRequests[0].signal?.aborted, true,
    '主请求完成必须立即取消仍在途的进度 I/O');
  const progressAfterMain = progressLine.textContent;
  progressRequests[0].resolve({ label: '主请求结束后的旧进度', detail: '不得显示', done: false });
  await flush();
  assert.equal(progressLine.textContent, progressAfterMain,
    '已停止进度请求的 late resolve 不得写进度 DOM');
  destroyed = true;
  controller.abort();
}

// 自动扫描主响应已证明成功时,仍须等精确匹配当前账号的 state 采用后才显示成功。
// state 刷新返回其他账号时,不得把主响应的 verified 直接投影成可继续状态。
{
  const scanReadinessStateRequests = [];
  const scanReadinessStatusRequests = [];
  let scanReadinessInitialStateLoaded = false;
  let scanReadinessGeneration = 0;
  let scanReadinessDestroyed = false;
  const scanReadinessController = new AbortController();
  const scanReadinessAccount = {
    id: 'scan-readiness-account',
    manual_key_account_fingerprint: 'scan-readiness-fingerprint',
  };
  const scanReadinessOtherAccount = {
    id: 'scan-readiness-other-account',
    manual_key_account_fingerprint: 'scan-readiness-other-fingerprint',
  };
  const scanReadinessWiz = {
    account: scanReadinessAccount,
    accounts: [scanReadinessAccount],
    baseRevision: 'scan-readiness-revision',
    state: {
      need_setup: true,
      wechat: {
        accounts: [scanReadinessAccount],
        manual_key_required: true,
        key_auto_scan_can_attempt: true,
      },
    },
    key: { draft: '', saved: false, skipped: false },
  };
  const scanReadinessCtx = {
    api: {
      get(path) {
        const value = String(path);
        if (value.startsWith('/api/state?')) {
          if (!scanReadinessInitialStateLoaded) {
            scanReadinessInitialStateLoaded = true;
            return Promise.resolve({
              need_setup: true,
              wechat: {
                accounts: [scanReadinessAccount],
                manual_key_required: true,
                key_auto_scan_can_attempt: true,
              },
            });
          }
          const request = deferred();
          scanReadinessStateRequests.push(request);
          return request.promise;
        }
        if (value.startsWith('/api/wechat/status-progress')) return Promise.resolve({ done: true });
        throw new Error(`unexpected scan-readiness GET: ${path}`);
      },
      post(path) {
        if (String(path).startsWith('/api/wechat/status')) {
          const request = deferred();
          scanReadinessStatusRequests.push(request);
          return request.promise;
        }
        throw new Error(`unexpected scan-readiness POST: ${path}`);
      },
    },
    store: {
      get(key) {
        if (key === 'account') return scanReadinessAccount;
        if (key === 'state') return scanReadinessWiz.state;
        if (key === 'stateAccountContext') {
          return {
            accountId: scanReadinessAccount.id,
            accountFingerprint: scanReadinessAccount.manual_key_account_fingerprint,
          };
        }
        return null;
      },
      set() {},
    },
    ui: { spinner: () => documentTarget.createElement('span') },
  };
  const scanReadinessW = {
    ctx: scanReadinessCtx,
    wiz: scanReadinessWiz,
    get destroyed() { return scanReadinessDestroyed; },
    signal: scanReadinessController.signal,
    beginAsync() { scanReadinessGeneration += 1; return scanReadinessGeneration; },
    alive(token) { return !scanReadinessDestroyed && token === scanReadinessGeneration; },
    refreshButtons() {},
    gotoStep() {},
    showPageNotice() {},
    applyAccountIdentityUpgrade() {},
  };
  const scanReadinessStep = createKeyStep(scanReadinessW);
  documentTarget.body.appendChild(scanReadinessStep.el);
  scanReadinessStep.onEnter();
  await flush();
  const scanReadinessButton = scanReadinessStep.el.querySelector('button');
  const scanReadinessStatus = scanReadinessStep.el.querySelector('.setup-status');
  scanReadinessButton.click();
  for (let attempt = 0; attempt < 20 && scanReadinessStatusRequests.length < 1; attempt += 1) await flush();
  assert.equal(scanReadinessStatusRequests.length, 1,
    '自动扫描 readiness 场景必须发出真实主请求');
  scanReadinessStatusRequests[0].resolve({ db: { message_db_verified: true } });
  for (let attempt = 0; attempt < 20 && scanReadinessStateRequests.length < 1; attempt += 1) await flush();
  assert.equal(scanReadinessStateRequests.length, 1,
    '自动扫描主请求成功后必须发起当前账号 state 刷新');
  scanReadinessStateRequests[0].resolve({
    need_setup: false,
    wechat: {
      accounts: [scanReadinessOtherAccount],
      manual_key_verified: true,
    },
  });
  await flush();
  assert.doesNotMatch(scanReadinessStatus.textContent, /自动扫描成功/,
    '自动扫描 state 不匹配时不得显示成功');
  assert.equal(scanReadinessStep.canContinue(), false,
    '自动扫描 state 不匹配时不得放行密钥步骤');
  scanReadinessDestroyed = true;
  scanReadinessController.abort();
}

const stateRefreshRequests = [];
const stateWrites = [];
let setupGeneration = 0;
let setupDestroyed = false;
const accountA = { id: 'setup-account-a', manual_key_account_fingerprint: 'fingerprint-a' };
const accountB = { id: 'setup-account-b', manual_key_account_fingerprint: 'fingerprint-b' };
const stateRefreshWiz = {
  account: accountA,
  accounts: [accountA, accountB],
  baseRevision: 'settings-a',
  state: { wechat: { manual_key_required: true } },
  key: { draft: '', saved: false, skipped: false },
};
const stateRefreshController = new AbortController();
const stateRefreshCtx = {
  api: {
    get(path, options = {}) {
      assert.match(String(path), /^\/api\/state\?/);
      const request = deferred();
      stateRefreshRequests.push({ ...request, signal: options.signal });
      return request.promise;
    },
  },
  store: {
    set(key, value) {
      stateWrites.push({ key, value });
    },
  },
  ui: { spinner: () => documentTarget.createElement('span') },
};
const stateRefreshW = {
  ctx: stateRefreshCtx,
  wiz: stateRefreshWiz,
  get destroyed() { return setupDestroyed; },
  signal: stateRefreshController.signal,
  beginAsync() { setupGeneration += 1; return setupGeneration; },
  alive(token) { return !setupDestroyed && token === setupGeneration; },
  refreshButtons() {},
  gotoStep() {},
  applyAccountIdentityUpgrade() {},
};
const stateRefreshStep = createKeyStep(stateRefreshW);
stateRefreshStep.onEnter();
assert.equal(stateRefreshRequests.length, 1,
  '第 3 步进入时必须发起一次独立的静默状态请求');
assert.equal(stateWrites.length, 0, '第 3 步进入时的静默状态请求应尚未写入 store');
stateRefreshStep.onExit?.();
assert.equal(stateRefreshRequests[0].signal?.aborted, true,
  '离开第 3 步必须立即取消静默状态 I/O，不能只让晚到响应失效');
stateRefreshWiz.account = accountB;
stateRefreshW.beginAsync();
stateRefreshStep.onEnter();
assert.equal(stateRefreshRequests.length, 2,
  '切换到 B 后重新进入第 3 步必须立即发起新请求');
assert.notStrictEqual(stateRefreshRequests[1].signal, stateRefreshRequests[0].signal,
  'B 静默刷新必须使用不同于已取消 A 的新 signal');
assert.equal(stateRefreshRequests[1].signal?.aborted, false,
  'B 静默刷新开始时必须保持可用');
stateRefreshRequests[0].resolve({
    need_setup: false,
    marker: 'account-a-late',
    wechat: { accounts: [accountA], manual_key_verified: true },
});
await flush();
assert.equal(stateWrites.length, 0,
  '回到账号步骤切换到 B 后,A 的晚到静默状态不得写入当前向导或 store');
stateRefreshStep.onExit?.();
assert.equal(stateRefreshRequests[1].signal?.aborted, true,
  '再次离开第 3 步必须取消 B 当前静默刷新');
stateRefreshRequests[1].resolve({
  need_setup: false,
  marker: 'account-b-late-after-exit',
  wechat: { accounts: [accountB], manual_key_verified: true },
});
await flush();
assert.equal(stateWrites.length, 0,
  'B 请求在离步后晚到也不得写入当前向导或 store');
stateRefreshStep.onEnter();
assert.equal(stateRefreshRequests.length, 3,
  '页面销毁场景必须先启动当前步骤自己的静默状态请求');
setupDestroyed = true;
stateRefreshController.abort();
assert.equal(stateRefreshRequests[2].signal?.aborted, true,
  '向导页面销毁必须向下取消第 3 步当前 state I/O');
stateRefreshRequests[2].resolve({
  need_setup: false,
  marker: 'account-b-late-after-page-destroy',
  wechat: { accounts: [accountB], manual_key_verified: true },
});
await flush();
assert.equal(stateWrites.length, 0,
  '页面销毁后的晚到 state 不得写入向导或 store');

const sameIdAccountA = { id: 'same-id-account', manual_key_account_fingerprint: 'fingerprint-a' };
const sameIdAccountB = { id: 'same-id-account', manual_key_account_fingerprint: 'fingerprint-b' };
const sameIdStateRefresh = deferred();
const sameIdStateWrites = [];
let sameIdDestroyed = false;
let sameIdGeneration = 0;
const sameIdWiz = {
  account: sameIdAccountB,
  accounts: [sameIdAccountA, sameIdAccountB],
  baseRevision: 'same-id-settings',
  state: { marker: 'current-b', wechat: { manual_key_required: true } },
  key: { draft: '', saved: false, skipped: false },
};
const sameIdCtx = {
  api: {
    get(path) {
      assert.match(String(path), /^\/api\/state\?refresh=1&account=same-id-account$/);
      return sameIdStateRefresh.promise;
    },
  },
  store: {
    set(key, value) {
      sameIdStateWrites.push({ key, value });
    },
  },
  ui: { spinner: () => documentTarget.createElement('span') },
};
const sameIdW = {
  ctx: sameIdCtx,
  wiz: sameIdWiz,
  get destroyed() { return sameIdDestroyed; },
  signal: new AbortController().signal,
  beginAsync() { sameIdGeneration += 1; return sameIdGeneration; },
  alive(token) { return !sameIdDestroyed && token === sameIdGeneration; },
  refreshButtons() {},
  gotoStep() {},
  applyAccountIdentityUpgrade() {},
};
const sameIdStep = createKeyStep(sameIdW);
documentTarget.body.appendChild(sameIdStep.el);
sameIdStep.onEnter();
await flush();
sameIdStateRefresh.resolve({
  need_setup: false,
  marker: 'stale-a',
  wechat: {
    accounts: [sameIdAccountA],
    manual_key_verified: true,
  },
});
await flush();
assert.equal(sameIdWiz.state.marker, 'current-b',
  '同 ID 当前为 B 时不得采用返回的 A 指纹 state');
assert.equal(sameIdStateWrites.length, 0,
  '同 ID 返回旧指纹 state 不得写入当前向导或 store');
sameIdDestroyed = true;

// 真实可达的动作边界：首个主请求完成后,其 refreshStateQuiet 仍在等待;
// 在精确 state 采用完成前,用户不得真实点击第二次扫描。
const lateRefreshStateRequests = [];
const lateStatusRequests = [];
const lateWrites = [];
let lateGeneration = 0;
let lateDestroyed = false;
const lateController = new AbortController();
const lateAccount = {
  id: 'late-refresh-account',
  manual_key_account_fingerprint: 'late-refresh-fingerprint',
};
const lateWiz = {
  account: lateAccount,
  accounts: [lateAccount],
  baseRevision: 'late-refresh-revision',
  state: { marker: 'before-actions', wechat: { manual_key_required: true } },
  key: { draft: '', saved: false, skipped: false },
};
const lateCtx = {
  api: {
    get(path, options = {}) {
      const value = String(path);
      if (value.startsWith('/api/state?')) {
        const request = deferred();
        lateRefreshStateRequests.push({ ...request, signal: options.signal });
        return request.promise;
      }
      if (value.startsWith('/api/wechat/status-progress')) {
        return Promise.resolve({ done: true });
      }
      throw new Error(`unexpected late-refresh GET: ${path}`);
    },
    post(path) {
      if (String(path).startsWith('/api/wechat/status')) {
        const request = deferred();
        lateStatusRequests.push(request);
        return request.promise;
      }
      throw new Error(`unexpected late-refresh POST: ${path}`);
    },
  },
  store: {
    get(key) {
      if (key === 'account') return lateAccount;
      if (key === 'state') return lateWiz.state;
      if (key === 'stateAccountContext') {
        return {
          accountId: lateAccount.id,
          accountFingerprint: lateAccount.manual_key_account_fingerprint,
        };
      }
      return null;
    },
    set(key, value) {
      lateWrites.push({ key, value });
    },
  },
  ui: { spinner: () => documentTarget.createElement('span') },
};
const lateW = {
  ctx: lateCtx,
  wiz: lateWiz,
  get destroyed() { return lateDestroyed; },
  signal: lateController.signal,
  beginAsync() { lateGeneration += 1; return lateGeneration; },
  alive(token) { return !lateDestroyed && token === lateGeneration; },
  refreshButtons() {},
  gotoStep() {},
  showPageNotice() {},
  applyAccountIdentityUpgrade() {},
};
const lateStep = createKeyStep(lateW);
documentTarget.body.appendChild(lateStep.el);
lateStep.onEnter();
assert.equal(lateRefreshStateRequests.length, 1,
  '动作交接场景必须先发起第 3 步进入时的静默 state 请求');
lateRefreshStateRequests[0].resolve({
  need_setup: false,
  marker: 'initial-late-refresh-state',
  wechat: { accounts: [lateAccount], manual_key_required: true },
});
await flush();
const lateScanButton = lateStep.el.querySelector('button');
assert.ok(lateScanButton, '动作交接场景必须存在自动扫描按钮');
lateScanButton.click();
for (let attempt = 0; attempt < 20 && lateStatusRequests.length < 1; attempt += 1) await flush();
assert.equal(lateStatusRequests.length, 1, '首个动作必须发出自动扫描主请求');
lateStatusRequests[0].resolve({ db: { message_sample_verified: true } });
for (let attempt = 0; attempt < 20 && lateRefreshStateRequests.length < 2; attempt += 1) await flush();
assert.equal(lateRefreshStateRequests.length, 2,
  '首个主请求完成后必须进入其静默 state 刷新');
assert.equal(lateScanButton.disabled, true,
  '静默 state 刷新期间自动扫描按钮必须继续 disabled');
await lateScanButton.userClick();
assert.equal(lateStatusRequests.length, 1,
  '静默 state 刷新期间真实点击不得启动第二个扫描动作');
lateRefreshStateRequests[1].resolve({
  need_setup: false,
  marker: 'first-action-state',
  wechat: { accounts: [lateAccount], manual_key_verified: true },
});
for (let attempt = 0; attempt < 20 && lateScanButton.disabled; attempt += 1) await flush();
assert.equal(lateScanButton.disabled, false,
  '首个动作精确 state 采用完成后扫描按钮才恢复可用');

lateScanButton.userClick();
for (let attempt = 0; attempt < 20 && lateStatusRequests.length < 2; attempt += 1) await flush();
assert.equal(lateStatusRequests.length, 2, '按钮恢复后第二次真实点击才建立新动作');
assert.equal(lateScanButton.disabled, true, '第二次动作建立后按钮必须重新进入 busy');
lateDestroyed = true;
lateController.abort();
lateStatusRequests[1].resolve({ db: { message_sample_verified: true } });
await flush();

// 同一条动作交接也必须覆盖“验证已保存候选”路径。
const savedRefreshStateRequests = [];
const savedStatusRequests = [];
const savedWrites = [];
let savedGeneration = 0;
let savedDestroyed = false;
let savedRefreshButtons = 0;
const savedController = new AbortController();
const savedAccount = {
  id: 'saved-refresh-account',
  manual_key_account_fingerprint: 'saved-refresh-fingerprint',
};
const savedWiz = {
  account: savedAccount,
  accounts: [savedAccount],
  baseRevision: 'saved-refresh-revision',
  state: { wechat: { manual_key_required: true } },
  key: { draft: '', saved: false, skipped: false },
};
const savedCtx = {
  api: {
    get(path) {
      const value = String(path);
      if (value.startsWith('/api/state?')) {
        const request = deferred();
        savedRefreshStateRequests.push(request);
        return request.promise;
      }
      if (value.startsWith('/api/wechat/status-progress')) return Promise.resolve({ done: true });
      throw new Error(`unexpected saved-refresh GET: ${path}`);
    },
    post(path) {
      if (String(path).startsWith('/api/wechat/status')) {
        const request = deferred();
        savedStatusRequests.push(request);
        return request.promise;
      }
      throw new Error(`unexpected saved-refresh POST: ${path}`);
    },
  },
  store: {
    get(key) {
      if (key === 'account') return savedAccount;
      if (key === 'state') return savedWiz.state;
      if (key === 'stateAccountContext') {
        return {
          accountId: savedAccount.id,
          accountFingerprint: savedAccount.manual_key_account_fingerprint,
        };
      }
      return null;
    },
    set(key, value) {
      savedWrites.push({ key, value });
    },
  },
  ui: { spinner: () => documentTarget.createElement('span') },
};
const savedW = {
  ctx: savedCtx,
  wiz: savedWiz,
  get destroyed() { return savedDestroyed; },
  signal: savedController.signal,
  beginAsync() { savedGeneration += 1; return savedGeneration; },
  alive(token) { return !savedDestroyed && token === savedGeneration; },
  refreshButtons() { savedRefreshButtons += 1; },
  gotoStep() {},
  showPageNotice() {},
  applyAccountIdentityUpgrade() {},
};
const savedStep = createKeyStep(savedW);
documentTarget.body.appendChild(savedStep.el);
savedStep.onEnter();
assert.equal(savedRefreshStateRequests.length, 1,
  '已保存候选场景必须先发起进入步骤时的静默 state 请求');
savedRefreshStateRequests[0].resolve({
  need_setup: false,
  marker: 'initial-saved-refresh-state',
  wechat: {
    accounts: [savedAccount],
    manual_key_configured: true,
    manual_key_required: true,
    manual_key_verified: false,
  },
});
await flush();
const savedValidateButton = savedStep.el.querySelectorAll('button')[2];
assert.ok(savedValidateButton, '已保存候选场景必须存在验证按钮');
assert.equal(savedValidateButton.hidden, false, '已有候选时验证按钮必须对用户可见');
assert.equal(savedValidateButton.disabled, false, '首个验证动作开始前按钮必须可用');
savedValidateButton.click();
for (let attempt = 0; attempt < 20 && savedStatusRequests.length < 1; attempt += 1) await flush();
assert.equal(savedStatusRequests.length, 1, '首个已保存候选验证必须发出主请求');
savedStatusRequests[0].resolve({ key: { message_db_verified: true } });
for (let attempt = 0; attempt < 20 && savedRefreshStateRequests.length < 2; attempt += 1) await flush();
assert.equal(savedRefreshStateRequests.length, 2,
  '首个已保存候选验证完成后必须进入其静默 state 刷新');
assert.equal(savedValidateButton.disabled, true,
  '已保存候选的 state 采用未完成时按钮必须继续保持 disabled');
await savedValidateButton.userClick();
assert.equal(savedStatusRequests.length, 1,
  'state 采用未完成时真实用户点击不得启动第二个验证动作');
savedRefreshStateRequests[1].resolve({
  need_setup: false,
  marker: 'first-saved-validation-state',
  wechat: { accounts: [savedAccount], manual_key_verified: true },
});
for (let attempt = 0; attempt < 20 && savedValidateButton.disabled; attempt += 1) await flush();
assert.equal(savedValidateButton.disabled, false,
  '精确 state 采用完成后已保存候选按钮才恢复可用');

const secondClick = savedValidateButton.userClick();
for (let attempt = 0; attempt < 20 && savedStatusRequests.length < 2; attempt += 1) await flush();
assert.equal(savedStatusRequests.length, 2, '已保存候选按钮恢复后第二次真实点击必须建立新动作');
assert.equal(savedValidateButton.disabled, true, '第二次已保存候选动作必须持有新 busy');
savedDestroyed = true;
savedController.abort();
savedStatusRequests[1].resolve({ key: { message_db_verified: true } });
await flush();

// 手动验证遇到 revision 冲突后会启动状态恢复读；主请求已经释放 busy，
// 因此用户可真实点击开始第二次验证。旧恢复读必须继续受首个 status action 所有权约束。
const conflictRefreshStateRequests = [];
const conflictStatusRequests = [];
const conflictWrites = [];
let conflictGeneration = 0;
let conflictDestroyed = false;
let conflictRefreshButtons = 0;
const conflictController = new AbortController();
const conflictAccount = {
  id: 'conflict-refresh-account',
  manual_key_account_fingerprint: 'conflict-refresh-fingerprint',
};
const conflictWiz = {
  account: conflictAccount,
  accounts: [conflictAccount],
  baseRevision: 'conflict-refresh-revision',
  state: { wechat: { accounts: [conflictAccount], manual_key_required: true } },
  key: { draft: '', saved: false, skipped: false },
};
const conflictCtx = {
  api: {
    get(path) {
      const value = String(path);
      if (value.startsWith('/api/state?')) {
        const request = deferred();
        conflictRefreshStateRequests.push(request);
        return request.promise;
      }
      if (value.startsWith('/api/wechat/status-progress')) return Promise.resolve({ done: true });
      throw new Error(`unexpected conflict-refresh GET: ${path}`);
    },
    post(path) {
      if (String(path).startsWith('/api/wechat/status')) {
        const request = deferred();
        conflictStatusRequests.push(request);
        return request.promise;
      }
      throw new Error(`unexpected conflict-refresh POST: ${path}`);
    },
  },
  store: {
    get(key) {
      if (key === 'account') return conflictAccount;
      if (key === 'state') return conflictWiz.state;
      if (key === 'stateAccountContext') {
        return {
          accountId: conflictAccount.id,
          accountFingerprint: conflictAccount.manual_key_account_fingerprint,
        };
      }
      return null;
    },
    set(key, value) {
      conflictWrites.push({ key, value });
    },
  },
  ui: { spinner: () => documentTarget.createElement('span') },
};
const conflictW = {
  ctx: conflictCtx,
  wiz: conflictWiz,
  get destroyed() { return conflictDestroyed; },
  signal: conflictController.signal,
  beginAsync() { conflictGeneration += 1; return conflictGeneration; },
  alive(token) { return !conflictDestroyed && token === conflictGeneration; },
  refreshButtons() { conflictRefreshButtons += 1; },
  gotoStep() {},
  showPageNotice() {},
  applyAccountIdentityUpgrade() {},
};
const conflictStep = createKeyStep(conflictW);
documentTarget.body.appendChild(conflictStep.el);
conflictStep.onEnter();
assert.equal(conflictRefreshStateRequests.length, 1,
  'revision 冲突场景必须先完成第 3 步进入时的独立状态读');
conflictRefreshStateRequests[0].resolve({
  need_setup: false,
  marker: 'initial-conflict-refresh-state',
  wechat: { accounts: [conflictAccount], manual_key_required: true },
});
await flush();
const conflictKeyInput = conflictStep.el.querySelector('textarea');
const conflictValidateButton = conflictStep.el.querySelectorAll('button')[1];
assert.ok(conflictKeyInput && conflictValidateButton, 'revision 冲突场景必须能走真实手动验证按钮');
conflictKeyInput.value = 'a'.repeat(64);
conflictValidateButton.click();
for (let attempt = 0; attempt < 20 && conflictStatusRequests.length < 1; attempt += 1) await flush();
assert.equal(conflictStatusRequests.length, 1, '首次手动验证必须发出 status 请求');
const revisionConflict = new Error('synthetic settings revision conflict');
revisionConflict.status = 409;
revisionConflict.code = 'settings_revision_conflict';
conflictStatusRequests[0].reject(revisionConflict);
for (let attempt = 0; attempt < 20 && conflictRefreshStateRequests.length < 2; attempt += 1) await flush();
assert.equal(conflictRefreshStateRequests.length, 2,
  '首次 status 冲突后必须进入状态恢复读');
assert.equal(conflictValidateButton.disabled, false,
  'status 主请求结束后验证按钮必须恢复可用，第二次点击是浏览器真实可达路径');

conflictValidateButton.click();
for (let attempt = 0; attempt < 20 && conflictStatusRequests.length < 2; attempt += 1) await flush();
assert.equal(conflictStatusRequests.length, 2, '第二次真实点击必须建立新的 status action');
assert.equal(conflictValidateButton.disabled, true, '第二次 status action 必须持有当前 busy');
const conflictStatusBeforeOldRefresh = conflictStep.el.querySelector('.setup-status')?.textContent || '';
const conflictRefreshButtonsBeforeOldRefresh = conflictRefreshButtons;
conflictRefreshStateRequests[1].resolve({
  need_setup: false,
  marker: 'old-conflict-refresh-state',
  wechat: { accounts: [conflictAccount], manual_key_verified: true },
});
await flush();
assert.equal(conflictWrites.some(({ key, value }) => key === 'state' && value?.marker === 'old-conflict-refresh-state'), false,
  '首次冲突的状态恢复晚到不得写入第二个 status action 的当前 store');
assert.equal(conflictStep.el.querySelector('.setup-status')?.textContent || '', conflictStatusBeforeOldRefresh,
  '首次冲突的状态恢复晚到不得重画第二个动作状态');
assert.equal(conflictRefreshButtons, conflictRefreshButtonsBeforeOldRefresh,
  '首次冲突的状态恢复晚到不得刷新第二个动作按钮');
assert.equal(conflictValidateButton.disabled, true,
  '首次冲突的状态恢复晚到不得释放第二个动作 busy');
conflictDestroyed = true;
conflictController.abort();
conflictStatusRequests[1].resolve({ key: { message_db_verified: true } });
await flush();

// 已保存候选主验证成功后,仍必须等精确匹配当前账号的 state 才能继续。
// state 刷新若返回其他账号/无法采用,不得仅凭 wiz.key.saved 放行第 3 步。
{
  const readinessStateRequests = [];
  const readinessStatusRequests = [];
  const readinessWrites = [];
  let readinessInitialStateLoaded = false;
  let readinessGeneration = 0;
  let readinessDestroyed = false;
  const readinessController = new AbortController();
  const readinessAccount = {
    id: 'saved-readiness-account',
    manual_key_account_fingerprint: 'saved-readiness-fingerprint',
  };
  const readinessOtherAccount = {
    id: 'saved-readiness-other-account',
    manual_key_account_fingerprint: 'saved-readiness-other-fingerprint',
  };
  const readinessWiz = {
    account: readinessAccount,
    accounts: [readinessAccount],
    baseRevision: 'saved-readiness-revision',
    state: {
      need_setup: true,
      wechat: {
        accounts: [readinessAccount],
        manual_key_required: true,
        manual_key_configured: true,
        manual_key_verified: false,
      },
    },
    key: { draft: '', saved: false, skipped: false },
  };
  const readinessCtx = {
    api: {
      get(path) {
        const value = String(path);
        if (value.startsWith('/api/state?')) {
          if (!readinessInitialStateLoaded) {
            readinessInitialStateLoaded = true;
            return Promise.resolve({
              need_setup: true,
              wechat: {
                accounts: [readinessAccount],
                manual_key_required: true,
                manual_key_configured: true,
                manual_key_verified: false,
              },
            });
          }
          const request = deferred();
          readinessStateRequests.push(request);
          return request.promise;
        }
        if (value.startsWith('/api/wechat/status-progress')) return Promise.resolve({ done: true });
        throw new Error(`unexpected readiness GET: ${path}`);
      },
      post(path) {
        if (String(path).startsWith('/api/wechat/status')) {
          const request = deferred();
          readinessStatusRequests.push(request);
          return request.promise;
        }
        throw new Error(`unexpected readiness POST: ${path}`);
      },
    },
    store: {
      get(key) {
        if (key === 'account') return readinessAccount;
        if (key === 'state') return readinessWiz.state;
        if (key === 'stateAccountContext') {
          return {
            accountId: readinessAccount.id,
            accountFingerprint: readinessAccount.manual_key_account_fingerprint,
          };
        }
        return null;
      },
      set(key, value) { readinessWrites.push({ key, value }); },
    },
    ui: { spinner: () => documentTarget.createElement('span') },
  };
  const readinessW = {
    ctx: readinessCtx,
    wiz: readinessWiz,
    get destroyed() { return readinessDestroyed; },
    signal: readinessController.signal,
    beginAsync() { readinessGeneration += 1; return readinessGeneration; },
    alive(token) { return !readinessDestroyed && token === readinessGeneration; },
    refreshButtons() {},
    gotoStep() {},
    showPageNotice() {},
    applyAccountIdentityUpgrade() {},
  };
  const readinessStep = createKeyStep(readinessW);
  documentTarget.body.appendChild(readinessStep.el);
  readinessStep.onEnter();
  await flush();
  const readinessValidateButton = readinessStep.el.querySelectorAll('button')[2];
  assert.equal(readinessValidateButton.hidden, false,
    '精确 state 已加载且候选未验证时必须显示验证已保存按钮');
  readinessValidateButton.click();
  for (let attempt = 0; attempt < 20 && readinessStatusRequests.length < 1; attempt += 1) await flush();
  assert.equal(readinessStatusRequests.length, 1,
    '验证已保存候选必须先发出真实主验证请求');
  readinessStatusRequests[0].resolve({ key: { message_db_verified: true } });
  for (let attempt = 0; attempt < 20 && readinessStateRequests.length < 1; attempt += 1) await flush();
  assert.equal(readinessStateRequests.length, 1,
    '主验证成功后必须等待当前账号 state 刷新');
  assert.equal(readinessStep.canContinue(), false,
    '精确 state 仍在等待时不得仅凭主验证成功放行密钥步骤');
  readinessStateRequests[0].resolve({
    need_setup: false,
    wechat: {
      accounts: [readinessOtherAccount],
      manual_key_verified: true,
    },
  });
  await flush();
  assert.equal(readinessStep.canContinue(), false,
    'state 账号不匹配时不得仅凭 wiz.key.saved 放行密钥步骤');
  assert.equal(readinessWiz.state.wechat.accounts[0], readinessAccount,
    '不匹配 state 不得覆盖当前账号 state');
  assert.equal(readinessWrites.some(({ key, value }) => key === 'state'
    && value?.wechat?.accounts?.[0]?.id === readinessOtherAccount.id), false,
  '不匹配 state 不得写入当前向导 store');
  readinessValidateButton.click();
  for (let attempt = 0; attempt < 20 && readinessStatusRequests.length < 2; attempt += 1) await flush();
  assert.equal(readinessStatusRequests.length, 2,
    'state 不匹配后用户必须能再次发起已保存候选验证');
  readinessStatusRequests[1].resolve({ key: { message_db_verified: true } });
  for (let attempt = 0; attempt < 20 && readinessStateRequests.length < 2; attempt += 1) await flush();
  assert.equal(readinessStateRequests.length, 2,
    '第二次主验证成功后仍必须等待精确 state');
  readinessStateRequests[1].resolve({
    need_setup: false,
    wechat: {
      accounts: [readinessAccount],
      manual_key_verified: true,
    },
  });
  await flush();
  assert.equal(readinessStep.canContinue(), true,
    '精确匹配当前账号的 state 采用后才允许继续密钥步骤');
  readinessDestroyed = true;
  readinessController.abort();
}

// “验证并保存”也必须在保存 PUT 后等精确 state 采用,不能在 refreshStateQuiet
// 失败时遗留 wiz.key.saved=true 作为越过本步骤的旁路。
{
  const saveReadinessStateRequests = [];
  const saveReadinessStatusRequests = [];
  const saveReadinessWrites = [];
  let saveReadinessInitialStateLoaded = false;
  let saveReadinessGeneration = 0;
  let saveReadinessDestroyed = false;
  const saveReadinessController = new AbortController();
  const saveReadinessAccount = {
    id: 'save-readiness-account',
    manual_key_account_fingerprint: 'save-readiness-fingerprint',
  };
  const saveReadinessOtherAccount = {
    id: 'save-readiness-other-account',
    manual_key_account_fingerprint: 'save-readiness-other-fingerprint',
  };
  const saveReadinessWiz = {
    account: saveReadinessAccount,
    accounts: [saveReadinessAccount],
    baseRevision: 'save-readiness-before-revision',
    state: {
      need_setup: true,
      wechat: {
        accounts: [saveReadinessAccount],
        manual_key_required: true,
        manual_key_configured: false,
        manual_key_verified: false,
      },
    },
    key: { draft: '', saved: false, skipped: false },
  };
  const saveReadinessCtx = {
    api: {
      get(path) {
        const value = String(path);
        if (value.startsWith('/api/state?')) {
          if (!saveReadinessInitialStateLoaded) {
            saveReadinessInitialStateLoaded = true;
            return Promise.resolve({
              need_setup: true,
              wechat: {
                accounts: [saveReadinessAccount],
                manual_key_required: true,
                manual_key_configured: false,
                manual_key_verified: false,
              },
            });
          }
          const request = deferred();
          saveReadinessStateRequests.push(request);
          return request.promise;
        }
        if (value === '/api/settings?wait_for_writes=1') {
          return Promise.resolve({ settings_revision: 'save-readiness-latest-revision' });
        }
        if (value.startsWith('/api/wechat/status-progress')) return Promise.resolve({ done: true });
        throw new Error(`unexpected save-readiness GET: ${path}`);
      },
      post(path) {
        if (String(path).startsWith('/api/wechat/status')) {
          const request = deferred();
          saveReadinessStatusRequests.push(request);
          return request.promise;
        }
        throw new Error(`unexpected save-readiness POST: ${path}`);
      },
      request(path, options) {
        assert.equal(path, '/api/settings', '验证并保存必须通过设置 PUT 保存候选');
        assert.equal(options?.method, 'PUT');
        const settings = { settings_revision: 'save-readiness-saved-revision' };
        return Promise.resolve({ ok: true, settings_revision: settings.settings_revision, settings });
      },
    },
    store: {
      get(key) {
        if (key === 'account') return saveReadinessAccount;
        if (key === 'state') return saveReadinessWiz.state;
        if (key === 'stateAccountContext') {
          return {
            accountId: saveReadinessAccount.id,
            accountFingerprint: saveReadinessAccount.manual_key_account_fingerprint,
          };
        }
        return null;
      },
      set(key, value) { saveReadinessWrites.push({ key, value }); },
    },
    ui: { spinner: () => documentTarget.createElement('span') },
  };
  const saveReadinessW = {
    ctx: saveReadinessCtx,
    wiz: saveReadinessWiz,
    get destroyed() { return saveReadinessDestroyed; },
    signal: saveReadinessController.signal,
    beginAsync() { saveReadinessGeneration += 1; return saveReadinessGeneration; },
    alive(token) { return !saveReadinessDestroyed && token === saveReadinessGeneration; },
    refreshButtons() {},
    gotoStep() {},
    showPageNotice() {},
    applyAccountIdentityUpgrade() {},
  };
  const saveReadinessStep = createKeyStep(saveReadinessW);
  documentTarget.body.appendChild(saveReadinessStep.el);
  saveReadinessStep.onEnter();
  await flush();
  const saveReadinessInput = saveReadinessStep.el.querySelector('textarea');
  const saveReadinessButton = saveReadinessStep.el.querySelectorAll('button')[1];
  assert.ok(saveReadinessInput && saveReadinessButton,
    '验证并保存夹具必须提供真实输入框和按钮');
  saveReadinessInput.value = 'a'.repeat(64);
  saveReadinessInput.listeners.get('input')?.({ target: saveReadinessInput });
  saveReadinessButton.click();
  for (let attempt = 0; attempt < 20 && saveReadinessStatusRequests.length < 1; attempt += 1) await flush();
  assert.equal(saveReadinessStatusRequests.length, 1,
    '验证并保存必须先发出真实主验证请求');
  saveReadinessStatusRequests[0].resolve({ key: { message_db_verified: true } });
  for (let attempt = 0; attempt < 20 && saveReadinessStateRequests.length < 1; attempt += 1) await flush();
  assert.equal(saveReadinessStateRequests.length, 1,
    '设置 PUT 成功后必须等待当前账号 state 刷新');
  assert.equal(saveReadinessStep.canContinue(), false,
    '保存 PUT 成功但 state 仍在等待时不得放行密钥步骤');
  saveReadinessStateRequests[0].resolve({
    need_setup: false,
    wechat: {
      accounts: [saveReadinessOtherAccount],
      manual_key_verified: true,
    },
  });
  await flush();
  assert.equal(saveReadinessStep.canContinue(), false,
    '验证并保存后的错账号 state 不得通过 wiz.key.saved 放行');
  assert.equal(saveReadinessWiz.state.wechat.accounts[0], saveReadinessAccount,
    '验证并保存后的错账号 state 不得覆盖当前向导 state');
  assert.equal(saveReadinessWrites.some(({ key, value }) => key === 'state'
    && value?.wechat?.accounts?.[0]?.id === saveReadinessOtherAccount.id), false,
  '验证并保存后的错账号 state 不得写入当前 store');
  saveReadinessButton.click();
  for (let attempt = 0; attempt < 20 && saveReadinessStatusRequests.length < 2; attempt += 1) await flush();
  assert.equal(saveReadinessStatusRequests.length, 2,
    'state 未确认时保留输入,用户应能再次发起验证并保存');
  saveReadinessStatusRequests[1].resolve({ key: { message_db_verified: true } });
  for (let attempt = 0; attempt < 20 && saveReadinessStateRequests.length < 2; attempt += 1) await flush();
  assert.equal(saveReadinessStateRequests.length, 2,
    '第二次保存仍必须等待精确 state');
  saveReadinessStateRequests[1].resolve({
    need_setup: false,
    wechat: {
      accounts: [saveReadinessAccount],
      manual_key_verified: true,
    },
  });
  await flush();
  assert.equal(saveReadinessStep.canContinue(), true,
    '验证并保存后的精确 state 采用后才允许继续密钥步骤');
  saveReadinessDestroyed = true;
  saveReadinessController.abort();
}

// Settings 写协调器拿到 latest 文档后,动作代次可能已经失效;
// 旧向导保存不得在 PUT 前 adopt latest 或继续提交。
const ownerLatest = deferred();
const ownerWrites = [];
let ownerAlive = true;
const ownerWiz = {
  settings: null,
  baseRevision: 'owner-revision-before',
};
const ownerSave = saveWizardSettings({
  api: {
    get(path) {
      assert.equal(path, '/api/settings?wait_for_writes=1');
      return ownerLatest.promise;
    },
    request(path, options) {
      ownerWrites.push({ path, options });
      return Promise.resolve({ settings_revision: 'owner-revision-after' });
    },
  },
  ui: { spinner: () => documentTarget.createElement('span') },
}, ownerWiz, { llm: { model: 'auto' } }, {
  signal: new AbortController().signal,
  isCurrent: () => ownerAlive,
});
ownerAlive = false;
ownerLatest.resolve({
  settings_revision: 'owner-revision-late',
  llm: { model: 'late-old-action-model' },
});
await assert.rejects(
  ownerSave,
  error => error?.name === 'AbortError' && error?.status === 499,
  '保存 owner 失效后必须在 latest adopt 前以取消合同结束',
);
assert.equal(ownerWrites.length, 0,
  '保存 owner 失效后不得继续发出旧动作 PUT');
assert.equal(ownerWiz.settings, null,
  '保存 owner 失效后不得采用旧动作 latest 设置文档');
assert.equal(ownerWiz.baseRevision, 'owner-revision-before',
  '保存 owner 失效后不得改写当前向导 revision');

let latestCallbackAlive = true;
let latestCallbackWrites = 0;
await assert.rejects(
  writeSettingsPatch({
    api: {
      get: async () => ({ settings_revision: 'latest-callback-revision' }),
      request: async () => {
        latestCallbackWrites += 1;
        return { settings_revision: 'must-not-be-written' };
      },
    },
    patch: { llm: { model: 'auto' } },
    isCurrent: () => latestCallbackAlive,
    onLatest: () => {
      latestCallbackAlive = false;
    },
  }),
  error => error?.name === 'AbortError' && error?.status === 499,
  'latest 回调使 owner 失效后必须停止提交',
);
assert.equal(latestCallbackWrites, 0,
  'latest 回调之后 owner 失效不得发出 PUT');

// “验证已保存候选”在主请求完成后还可能等待账号身份升级。
// 若此时真实路由离开/页面销毁,升级普通错误晚到也不得进入旧步骤的 status。
{
  const statusResponse = deferred();
  const identityUpgrade = deferred();
  const accountA = { id: 'saved-validation-account', manual_key_account_fingerprint: 'saved-validation-a' };
  const accountB = { id: 'saved-validation-account', manual_key_account_fingerprint: 'saved-validation-b' };
  const controller = new AbortController();
  const wiz = {
    account: accountA,
    accounts: [accountA],
    baseRevision: 'saved-validation-revision',
    state: { wechat: { accounts: [accountA], manual_key_required: true } },
    key: { draft: '', saved: false, skipped: false },
  };
  let generation = 0;
  let destroyed = false;
  let upgradeCalls = 0;
  const w = {
    ctx: {
      api: {
        get(path) {
          if (String(path).startsWith('/api/wechat/status-progress')) {
            return Promise.reject(new Error('progress fixture disabled'));
          }
          throw new Error(`unexpected saved-validation GET: ${path}`);
        },
        post(path) {
          assert.match(String(path), /^\/api\/wechat\/status\?/);
          return statusResponse.promise;
        },
      },
      store: {
        get(key) {
          if (key === 'account') return wiz.account;
          if (key === 'accounts') return wiz.accounts;
          if (key === 'state') return wiz.state;
          if (key === 'stateAccountContext') {
            return { accountId: accountA.id, accountFingerprint: accountA.manual_key_account_fingerprint };
          }
          return null;
        },
        set() {},
      },
      ui: { spinner: () => documentTarget.createElement('span') },
    },
    wiz,
    get destroyed() { return destroyed; },
    signal: controller.signal,
    beginAsync() { generation += 1; return generation; },
    alive(token) { return !destroyed && token === generation; },
    refreshButtons() {},
    gotoStep() {},
    showPageNotice() {},
    applyAccountIdentityUpgrade() {
      upgradeCalls += 1;
      return identityUpgrade.promise;
    },
  };
  const step = createKeyStep(w);
  const validateSavedButton = step.el.querySelectorAll('button')
    .find(button => button.textContent === '验证已保存候选');
  assert.ok(validateSavedButton, '必须通过真实“验证已保存候选”按钮进入该 caller');
  validateSavedButton.click();
  for (let attempt = 0; attempt < 20 && upgradeCalls < 1; attempt += 1) {
    await flush();
  }
  assert.equal(upgradeCalls, 0,
    '身份升级应等待主验证响应,不能在主请求完成前提前进入');
  statusResponse.resolve({
    account_identity_upgrade: { previous_fingerprint: accountA.manual_key_account_fingerprint },
    account: accountB,
    key: { message_db_verified: true },
  });
  for (let attempt = 0; attempt < 20 && upgradeCalls < 1; attempt += 1) {
    await flush();
  }
  assert.equal(upgradeCalls, 1, '主验证响应后必须进入账号身份升级等待');

  // 这是向导真实的路由 owner 失效/卸载入口:导航会推进 generation,卸载会 abort 页面 signal。
  step.onExit?.();
  w.beginAsync();
  destroyed = true;
  controller.abort(new Error('setup page destroyed'));
  identityUpgrade.reject(new Error('late ordinary identity-upgrade failure'));
  await flush();
  await flush();
  const primaryStatus = step.el.querySelectorAll('.setup-status')[0];
  assert.doesNotMatch(primaryStatus?.textContent || '', /late ordinary identity-upgrade failure/,
    '路由离开/页面销毁后的普通升级错误不得写入旧步骤 status');
}

// 主验证请求完成后,账号身份升级仍可能等待精确 state。这个等待属于同一个
// 用户动作;真实 disabled button 在此期间不得再次发起第二个验证请求。
{
  const statusResponse = deferred();
  const identityUpgrade = deferred();
  const accountA = { id: 'busy-upgrade-account', manual_key_account_fingerprint: 'busy-upgrade-a' };
  const accountB = { id: 'busy-upgrade-account', manual_key_account_fingerprint: 'busy-upgrade-b' };
  const controller = new AbortController();
  const wiz = {
    account: accountA,
    accounts: [accountA, accountB],
    baseRevision: 'busy-upgrade-revision',
    state: { wechat: { accounts: [accountA], manual_key_required: true } },
    key: { draft: '', saved: false, skipped: false },
  };
  let generation = 0;
  let upgradeCalls = 0;
  const statusPosts = [];
  const stateReads = [];
  const w = {
    ctx: {
      api: {
        get(path) {
          if (String(path).startsWith('/api/wechat/status-progress')) return Promise.resolve({ done: true });
          if (String(path).startsWith('/api/state?')) {
            stateReads.push(String(path));
            return Promise.resolve({
              need_setup: true,
              settings_revision: 'busy-upgrade-revision',
              wechat: { accounts: [accountA], manual_key_configured: true, manual_key_verified: false },
            });
          }
          throw new Error(`unexpected busy-upgrade GET: ${path}`);
        },
        post(path, body) {
          assert.match(String(path), /^\/api\/wechat\/status\?/);
          statusPosts.push({ path: String(path), body });
          if (statusPosts.length === 1) return statusResponse.promise;
          return Promise.resolve({ key: { message_db_verified: true } });
        },
      },
      store: {
        get(key) {
          if (key === 'account') return wiz.account;
          if (key === 'accounts') return wiz.accounts;
          if (key === 'state') return wiz.state;
          if (key === 'stateAccountContext') {
            return { accountId: accountA.id, accountFingerprint: accountA.manual_key_account_fingerprint };
          }
          return null;
        },
        set() {},
      },
      ui: { spinner: () => documentTarget.createElement('span') },
    },
    wiz,
    signal: controller.signal,
    get destroyed() { return false; },
    beginAsync() { generation += 1; return generation; },
    alive(token) { return token === generation; },
    refreshButtons() {},
    applyAccountIdentityUpgrade() {
      upgradeCalls += 1;
      return identityUpgrade.promise;
    },
  };
  const step = createKeyStep(w);
  const validateSavedButton = step.el.querySelectorAll('button')
    .find(button => button.textContent === '验证已保存候选');
  assert.ok(validateSavedButton, '必须找到真实保存候选验证按钮');
  const firstClick = validateSavedButton.userClick();
  for (let attempt = 0; attempt < 20 && upgradeCalls < 1; attempt += 1) await flush();
  assert.equal(upgradeCalls, 0, '身份升级必须等待主验证响应');
  statusResponse.resolve({
    account_identity_upgrade: { previous_fingerprint: accountA.manual_key_account_fingerprint },
    account: accountB,
    key: { message_db_verified: true },
  });
  for (let attempt = 0; attempt < 20 && upgradeCalls < 1; attempt += 1) await flush();
  assert.equal(upgradeCalls, 1, '主验证响应后必须进入身份升级等待');
  assert.equal(validateSavedButton.disabled, true,
    '身份升级 state 未完成时验证按钮必须继续保持 disabled');
  const secondClick = validateSavedButton.userClick();
  await flush();
  assert.equal(statusPosts.length, 1,
    '真实 disabled button 不得在身份升级等待期间发起第二个验证请求');
  identityUpgrade.resolve(true);
  await firstClick;
  await secondClick;
  assert.equal(stateReads.length, 1, '首个验证动作完成后只应进行一次精确 state 重读');
  step.onExit?.();
}

// 自动扫描的主 POST 返回身份升级时,升级与 state 重读也属于同一用户动作;
// 真实扫描按钮在这段等待期间不能重新发起第二次扫描。
{
  const statusResponse = deferred();
  const identityUpgrade = deferred();
  const accountA = { id: 'scan-busy-account', manual_key_account_fingerprint: 'scan-busy-a' };
  const accountB = { id: 'scan-busy-account', manual_key_account_fingerprint: 'scan-busy-b' };
  const controller = new AbortController();
  const wiz = {
    account: accountA,
    accounts: [accountA, accountB],
    baseRevision: 'scan-busy-revision',
    state: {
      wechat: {
        accounts: [accountA],
        key_auto_scan_state: 'failed',
        key_auto_scan_can_attempt: true,
        manual_key_required: true,
      },
    },
    key: { draft: '', saved: false, skipped: false },
  };
  let generation = 0;
  let upgradeCalls = 0;
  const statusPosts = [];
  const stateReads = [];
  const w = {
    ctx: {
      api: {
        get(path) {
          if (String(path).startsWith('/api/wechat/status-progress')) return Promise.resolve({ done: true });
          if (String(path).startsWith('/api/state?')) {
            stateReads.push(String(path));
            return Promise.resolve({
              need_setup: true,
              settings_revision: 'scan-busy-revision',
              wechat: {
                accounts: [accountA],
                key_auto_scan_state: 'failed',
                key_auto_scan_can_attempt: true,
                manual_key_required: true,
              },
            });
          }
          throw new Error(`unexpected scan-busy GET: ${path}`);
        },
        post(path, body) {
          assert.match(String(path), /^\/api\/wechat\/status\?/);
          statusPosts.push({ path: String(path), body });
          if (statusPosts.length === 1) return statusResponse.promise;
          return Promise.resolve({ db: { message_sample_verified: true } });
        },
      },
      store: {
        get(key) {
          if (key === 'account') return wiz.account;
          if (key === 'accounts') return wiz.accounts;
          if (key === 'state') return wiz.state;
          if (key === 'stateAccountContext') {
            return { accountId: accountA.id, accountFingerprint: accountA.manual_key_account_fingerprint };
          }
          return null;
        },
        set() {},
      },
      ui: { spinner: () => documentTarget.createElement('span') },
    },
    wiz,
    signal: controller.signal,
    get destroyed() { return false; },
    beginAsync() { generation += 1; return generation; },
    alive(token) { return token === generation; },
    refreshButtons() {},
    applyAccountIdentityUpgrade() {
      upgradeCalls += 1;
      return identityUpgrade.promise;
    },
  };
  const step = createKeyStep(w);
  step.onEnter();
  await flush();
  const scanButton = step.el.querySelectorAll('button')
    .find(button => button.textContent === '自动扫描重试');
  assert.ok(scanButton && !scanButton.hidden, '自动扫描失败态必须显示真实重试按钮');
  const firstClick = scanButton.userClick();
  for (let attempt = 0; attempt < 20 && statusPosts.length < 1; attempt += 1) await flush();
  assert.equal(statusPosts.length, 1, '自动扫描必须发出主 status 请求');
  statusResponse.resolve({
    account_identity_upgrade: { previous_fingerprint: accountA.manual_key_account_fingerprint },
    account: accountB,
    db: { message_sample_verified: true },
  });
  for (let attempt = 0; attempt < 20 && upgradeCalls < 1; attempt += 1) await flush();
  assert.equal(upgradeCalls, 1, '自动扫描响应后必须进入身份升级等待');
  assert.equal(scanButton.disabled, true,
    '自动扫描身份升级/state 重读未完成时真实重试按钮必须继续保持 disabled');
  const secondClick = scanButton.userClick();
  await flush();
  assert.equal(statusPosts.length, 1,
    '真实 disabled 扫描按钮不得在身份升级等待期间发起第二个 status 请求');
  identityUpgrade.resolve(true);
  await firstClick;
  await secondClick;
  assert.equal(stateReads.length, 2, '自动扫描完成后应只进行一次额外精确 state 重读');
  step.onExit?.();
}

console.log('web setup progress signal lifecycle tests passed');
