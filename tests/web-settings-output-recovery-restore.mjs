import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

globalThis.location = new URL('http://wx-summary.test/#/settings');

class MemoryStorage {
  #values = new Map();
  get length() { return this.#values.size; }
  key(index) { return [...this.#values.keys()][index] ?? null; }
  getItem(key) { return this.#values.get(String(key)) ?? null; }
  setItem(key, value) { this.#values.set(String(key), String(value)); }
  removeItem(key) { this.#values.delete(String(key)); }
}

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || '').toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    this.hidden = false;
    this.title = '';
    this.classList = {
      toggle: (name, enabled) => {
        const classes = new Set(String(this.className || '').split(/\s+/).filter(Boolean));
        if (enabled) classes.add(name);
        else classes.delete(name);
        this.className = [...classes].join(' ');
      },
    };
  }

  setAttribute(name, value) {
    const key = String(name);
    this.attributes.set(key, String(value));
    if (key === 'hidden') this.hidden = true;
    if (key === 'value') this.value = String(value);
  }

  removeAttribute(name) {
    const key = String(name);
    this.attributes.delete(key);
    if (key === 'hidden') this.hidden = false;
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  append(...children) {
    for (const child of children.flat(Infinity)) {
      if (child !== null && child !== undefined && child !== false) this.children.push(child);
    }
  }

  appendChild(child) {
    this.append(child);
    return child;
  }

  click() {
    if (this.disabled) return;
    for (const listener of this.listeners.get('click') || []) listener({ currentTarget: this });
  }
}

const createdNodes = [];
globalThis.localStorage = new MemoryStorage();
const storageListeners = new Set();
globalThis.window = {
  addEventListener(type, listener) {
    if (type === 'storage') storageListeners.add(listener);
  },
  removeEventListener(type, listener) {
    if (type === 'storage') storageListeners.delete(listener);
  },
};
globalThis.document = {
  title: '',
  createElement(tag) {
    const node = new FakeNode(tag);
    createdNodes.push(node);
    return node;
  },
};

const loader = createBrowserModuleLoader();
const output = await loader.load('js/pages/settings/output.js');
const localActionRecovery = await loader.load('js/shared/local-action-recovery.js');
assert.equal(typeof output.latestPendingOutputAction, 'function',
  '输出分区必须能从持久化恢复记录恢复待核对的打开目录动作');

assert.equal(output.latestPendingOutputAction([]), null);
assert.equal(output.latestPendingOutputAction([
  { kind: 'export_preview', action_id: 'exportmd_fixture_0001', at: 20 },
]), null, '其他本机动作不得伪装成打开目录待核对项');
assert.deepEqual(
  output.latestPendingOutputAction([
    { kind: 'open_output', action_id: 'openout_fixture_old', at: 10 },
    {
      kind: 'open_output',
      action_id: 'openout_fixture_new',
      at: 30,
      target: { output_dir_identity: 'output-fixture-a' },
    },
  ]),
  {
    kind: 'open_output',
    actionId: 'openout_fixture_new',
    target: { output_dir_identity: 'output-fixture-a' },
  },
  '刷新后必须恢复最新的待核对打开目录动作及其目标身份');

const source = await readFile(new URL('../src/web/public/js/pages/settings/output.js', import.meta.url), 'utf8');
assert.match(source, /readPendingLocalActionRecords/,
  '输出分区必须读取持久化本机动作恢复记录');
assert.match(source, /latestPendingOutputAction\(/,
  '输出分区必须把持久化记录投影为当前待核对动作');
assert.match(source, /queryActionBtn\.hidden = false/,
  '恢复待核对动作后必须显示查询结果入口');

// 恢复旧动作时当前输出目录可能已经换代。查询必须把持久化的旧目标交给
// 服务端证据绑定，否则同一 action id 的证据会失去 output_dir_identity 校验。
{
  const actionId = 'openout_restore_target_1';
  globalThis.localStorage.setItem(
    localActionRecovery.pendingLocalActionStorageKey(actionId),
    JSON.stringify({
      action_id: actionId,
      kind: 'open_output',
      at: Date.now(),
      target: { output_dir_identity: 'output-restore-a' },
    }),
  );
  assert.deepEqual(
    localActionRecovery.readPendingLocalActionRecords().at(-1)?.target,
    { output_dir_identity: 'output-restore-a' },
    '持久化恢复记录读取时必须保留输出目录目标身份',
  );
  assert.deepEqual(
    output.latestPendingOutputAction(localActionRecovery.readPendingLocalActionRecords()),
    { kind: 'open_output', actionId, target: { output_dir_identity: 'output-restore-a' } },
    '恢复投影必须保留持久化动作的目标身份',
  );
  const requestPaths = [];
  const queryToken = { signal: new AbortController().signal };
  const queryPage = {
    api: {
      get(path) {
        requestPaths.push(path);
        return Promise.resolve({
          evidence: {
            kind: 'open_output',
            action_id: actionId,
            output_dir_identity: 'output-restore-a',
            local_action_committed: true,
            verified: true,
            evidence_persisted: true,
          },
        });
      },
    },
    ui: {},
    getSettings: () => ({
      render: { default_theme: 'auto', default_font_size: 'normal' },
      output: { dir: './outputs/other', retention_days: 0, filename_pattern: '{group}' },
    }),
    getOutputDirIdentity: () => 'output-restore-b',
    isBusy: () => false,
    markDirty() {},
    beginAction() { return queryToken; },
    alive() { return true; },
    endAction() {},
  };
  const before = createdNodes.length;
  output.createOutputSection(queryPage);
  const restoredQueryButton = createdNodes
    .slice(before)
    .find(node => node.textContent === '查询结果');
  assert.ok(restoredQueryButton && restoredQueryButton.hidden === false,
    '恢复目标动作后必须显示查询入口');
  restoredQueryButton.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requestPaths.length, 1, '恢复动作查询必须只发起一次证据读取');
  const query = new URL(requestPaths[0], 'http://wx-summary.test');
  assert.equal(query.searchParams.get('output_dir_identity'), 'output-restore-a',
    '输出目录已换代时,查询必须携带持久化动作的旧目标身份供服务端校验');
  localActionRecovery.forgetLocalActionRecovery(actionId);
}

// 服务端明确拒绝旧输出目录目标时,查询动作已不可恢复;生产查询路径必须
// 清掉自己的 pending 记录,不能让下一次页面恢复重复查询同一个必失败动作。
{
  const actionId = 'openout_restore_mismatch_1';
  globalThis.localStorage.setItem(
    localActionRecovery.pendingLocalActionStorageKey(actionId),
    JSON.stringify({
      action_id: actionId,
      kind: 'open_output',
      at: Date.now(),
      target: { output_dir_identity: 'output-restore-old' },
    }),
  );
  const mismatchError = Object.assign(new Error('本地动作证据不属于当前目标'), {
    status: 409,
    code: 'local_action_evidence_target_mismatch',
  });
  const mismatchToken = { signal: new AbortController().signal };
  const mismatchPage = {
    api: { get() { return Promise.reject(mismatchError); } },
    ui: {},
    getSettings: () => ({
      render: { default_theme: 'auto', default_font_size: 'normal' },
      output: { dir: './outputs/current', retention_days: 0, filename_pattern: '{group}' },
    }),
    getOutputDirIdentity: () => 'output-current',
    isBusy: () => false,
    markDirty() {},
    beginAction() { return mismatchToken; },
    alive() { return true; },
    endAction() {},
  };
  const before = createdNodes.length;
  output.createOutputSection(mismatchPage);
  const mismatchQueryButton = createdNodes
    .slice(before)
    .find(node => node.textContent === '查询结果');
  assert.ok(mismatchQueryButton && mismatchQueryButton.hidden === false,
    '目标拒绝的 pending 动作必须先显示查询入口');
  mismatchQueryButton.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(
    localActionRecovery.readPendingLocalActionRecords()
      .some(record => record.action_id === actionId),
    false,
    '查询路径遇到明确目标拒绝后必须清理 pending 记录',
  );
}

// 服务端证据已确认不等于浏览器恢复记录已经清理。若精确 key 删除失败，
// 查询入口必须保留并显示可操作错误，不能让下次加载再次恢复时才暴露。
{
  const previousStorage = globalThis.localStorage;
  const backingStorage = new MemoryStorage();
  const actionId = 'openout_cleanup_storage_failure_1';
  const key = localActionRecovery.pendingLocalActionStorageKey(actionId);
  backingStorage.setItem(key, JSON.stringify({
    action_id: actionId,
    kind: 'open_output',
    at: Date.now(),
    target: { output_dir_identity: 'output-cleanup-a' },
  }));
  globalThis.localStorage = {
    get length() { return backingStorage.length; },
    key(index) { return backingStorage.key(index); },
    getItem(name) { return backingStorage.getItem(name); },
    setItem(name, value) { backingStorage.setItem(name, value); },
    removeItem(name) {
      if (name === key) throw new Error('pending cleanup denied');
      backingStorage.removeItem(name);
    },
  };
  try {
    const token = { signal: new AbortController().signal };
    const before = createdNodes.length;
    const cleanupPage = {
      api: {
        get() {
          return Promise.resolve({
            evidence: {
              kind: 'open_output',
              action_id: actionId,
              output_dir_identity: 'output-cleanup-a',
              local_action_committed: true,
              verified: true,
              evidence_persisted: true,
            },
          });
        },
      },
      ui: {},
      getSettings: () => ({
        render: { default_theme: 'auto', default_font_size: 'normal' },
        output: { dir: './outputs/current', retention_days: 0, filename_pattern: '{group}' },
      }),
      getOutputDirIdentity: () => 'output-cleanup-a',
      isBusy: () => false,
      markDirty() {},
      beginAction() { return token; },
      alive() { return true; },
      endAction() {},
    };
    const cleanupSection = output.createOutputSection(cleanupPage);
    const cleanupNodes = createdNodes.slice(before);
    const cleanupQueryButton = cleanupNodes.find(node => node.textContent === '查询结果');
    const cleanupStatus = cleanupNodes
      .filter(node => String(node.className || '').split(/\s+/).includes('settings-status'))
      .at(-1);
    assert.ok(cleanupQueryButton && cleanupQueryButton.hidden === false);
    cleanupQueryButton.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cleanupQueryButton.hidden, false,
      '恢复记录删除失败时不得隐藏查询入口');
    assert.match(cleanupStatus.textContent, /查询失败|本地存储|恢复记录/,
      '恢复记录删除失败必须显示可操作错误,不能宣称已确认完成');
    assert.notEqual(cleanupSection, null);
    assert.notEqual(backingStorage.getItem(key), null,
      '删除失败时 pending 记录必须仍可供下次核对');
  } finally {
    globalThis.localStorage = previousStorage;
  }
}

let resolveOpen;
let requestBody = null;
let currentOutputIdentity = 'output-A';
const openResponse = new Promise(resolve => { resolveOpen = resolve; });
const page = {
  api: {
    post(path, body) {
      assert.equal(path, '/api/open-output');
      requestBody = body;
      return openResponse;
    },
    get() {
      return Promise.resolve({ evidence: {
        kind: 'open_output',
        action_id: requestBody?.local_action_id,
        output_dir_identity: 'output-A',
        local_action_committed: true,
        verified: true,
        evidence_persisted: true,
      } });
    },
  },
  ui: {},
  getSettings: () => ({
    render: { default_theme: 'auto', default_font_size: 'normal' },
    output: { dir: './outputs/digests', retention_days: 0, filename_pattern: '{group}' },
  }),
  getOutputDirIdentity: () => currentOutputIdentity,
  isBusy: () => false,
  markDirty() {},
  beginAction() { return { signal: new AbortController().signal }; },
  alive: () => true,
  endAction() {},
};
const pageNodesBefore = createdNodes.length;
const section = output.createOutputSection(page);
const pageNodes = createdNodes.slice(pageNodesBefore);
const openButton = pageNodes.find(node => node.textContent === '打开输出目录');
const queryButton = pageNodes.find(node => node.textContent === '查询结果');
const statusNodes = pageNodes.filter(node => node.className === 'settings-status');
assert.ok(openButton && queryButton && statusNodes.length >= 2,
  '设置输出分区必须暴露打开/查询按钮和状态行');

openButton.click();
assert.ok(requestBody?.local_action_id, '打开目录必须携带本机动作标识');
currentOutputIdentity = 'output-B';
resolveOpen({
  local_action_id: requestBody.local_action_id,
  local_action_committed: true,
  verified: true,
  status: 'verified',
  opener: { local_action_committed: true, verification_status: 'verified' },
  local_action_after_commit_reason: 'output_dir_changed_after_commit',
  local_action_after_commit_error: '输出目录已在操作期间切换；本次动作针对的是开始时的原输出目录。',
});
await new Promise(resolve => setImmediate(resolve));
const openStatus = statusNodes.at(-1);
assert.notEqual(openStatus.textContent, '输出目录已在文件管理器中打开。',
  '提交后输出目录换代时不得把针对旧目录的响应投影为成功');
assert.equal(queryButton.hidden, false,
  '提交后输出目录换代时必须保留查询/核对入口');
assert.match(openStatus.textContent, /未能完成核对|结果未知|重新载入|旧目录/,
  '提交后输出目录换代必须显示可操作的非成功状态');

// 另一窗口可能在服务已经接受旧目录请求后才把当前设置切到新目录;
// 即使响应没有附带 after-commit reason,当前页面也不能把旧目录动作显示为
// 当前目录已成功打开。
{
  let resolveLateOpen;
  let lateRequestBody = null;
  const lateResponse = new Promise(resolve => { resolveLateOpen = resolve; });
  let lateOutputIdentity = 'output-C';
  const latePage = {
    api: {
      post(path, body) {
        assert.equal(path, '/api/open-output');
        lateRequestBody = body;
        return lateResponse;
      },
      get() {
        return Promise.resolve({ evidence: {
          kind: 'open_output',
          action_id: lateRequestBody?.local_action_id,
          output_dir_identity: 'output-C',
          local_action_committed: true,
          verified: true,
          evidence_persisted: true,
        } });
      },
    },
    ui: {},
    getSettings: page.getSettings,
    getOutputDirIdentity: () => lateOutputIdentity,
    isBusy: () => false,
    markDirty() {},
    beginAction() { return { signal: new AbortController().signal }; },
    alive: () => true,
    endAction() {},
  };
  const beforeLateNodes = createdNodes.length;
  const lateSection = output.createOutputSection(latePage);
  lateSection.applySettings(latePage.getSettings());
  const lateNodes = createdNodes.slice(beforeLateNodes);
  const lateOpenButton = lateNodes.find(node => node.textContent === '打开输出目录');
  const lateQueryButton = lateNodes.find(node => node.textContent === '查询结果');
  const lateStatus = lateNodes
    .filter(node => node.className === 'settings-status')
    .at(-1);
  assert.ok(lateOpenButton && lateQueryButton && lateStatus,
    '旧目录晚到响应夹具必须创建完整的输出操作控件');
  lateOpenButton.click();
  assert.equal(lateRequestBody?.expected_output_dir_identity, 'output-C');
  lateOutputIdentity = 'output-D';
  resolveLateOpen({
    local_action_id: lateRequestBody.local_action_id,
    local_action_committed: true,
    verified: true,
    status: 'verified',
    opener: { local_action_committed: true, verification_status: 'verified' },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(lateStatus.textContent, '输出目录已在文件管理器中打开。',
    '当前输出目录已换代时,无 after-commit reason 的旧 verified 响应也不得误报成功');
  assert.equal(lateQueryButton.hidden, false,
    '当前输出目录已换代时必须保留旧动作查询入口');
  lateQueryButton.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(lateStatus.textContent, '已确认:输出目录已在文件管理器中打开。',
    '查询到已完成的旧目录动作时,当前目录已换代也不得误报当前目录成功');
  assert.equal(lateQueryButton.hidden, true,
    '旧目录证据已确认且 marker 已清理后,不得继续保留无效查询入口');
  assert.equal(lateOpenButton.disabled, false,
    '旧动作已确认清理后必须重新允许打开当前目录');
  localActionRecovery.forgetLocalActionRecovery(lateRequestBody.local_action_id);
}

// 另一窗口切换输出目录后,旧查询请求的普通失败也不能把 A 的错误写到
// 当前 B 状态行。这个路径不依赖 Abort:跨标签设置同步只会更新当前目录身份。
{
  const actionId = 'openout_stale_query_error_1';
  globalThis.localStorage.setItem(
    localActionRecovery.pendingLocalActionStorageKey(actionId),
    JSON.stringify({
      action_id: actionId,
      kind: 'open_output',
      at: Date.now() + 1000,
      target: { output_dir_identity: 'output-stale-a' },
    }),
  );
  let rejectStaleQuery;
  let staleQueryCalls = 0;
  const staleQuery = new Promise((resolve, reject) => { rejectStaleQuery = reject; });
  let currentOutputIdentity = 'output-stale-a';
  const staleQueryToken = { signal: new AbortController().signal };
  const staleQueryPage = {
    api: { get() { staleQueryCalls += 1; return staleQuery; } },
    ui: {},
    getSettings: () => ({
      render: { default_theme: 'auto', default_font_size: 'normal' },
      output: { dir: './outputs/stale', retention_days: 0, filename_pattern: '{group}' },
    }),
    getOutputDirIdentity: () => currentOutputIdentity,
    isBusy: () => false,
    markDirty() {},
    beginAction() { return staleQueryToken; },
    alive() { return true; },
    endAction() {},
  };
  const beforeStaleQueryNodes = createdNodes.length;
  output.createOutputSection(staleQueryPage);
  const staleQueryNodes = createdNodes.slice(beforeStaleQueryNodes);
  const staleQueryButton = staleQueryNodes.find(node => node.textContent === '查询结果');
  assert.ok(staleQueryButton && staleQueryButton.hidden === false,
    '旧输出目录动作必须先显示查询入口');
  staleQueryButton.click();
  await Promise.resolve();
  assert.equal(staleQueryCalls, 1, '旧输出目录查询必须真实发起一次请求');
  currentOutputIdentity = 'output-stale-b';
  rejectStaleQuery(new Error('A 目录查询失败'));
  await new Promise(resolve => setImmediate(resolve));
  const staleQueryStatus = staleQueryNodes
    .filter(node => String(node.className || '').split(/\s+/).includes('settings-status'))
    .at(-1);
  assert.ok(staleQueryStatus, '旧查询夹具必须能定位打开目录状态行');
  assert.doesNotMatch(staleQueryStatus.textContent, /A 目录查询失败/,
    '输出目录换代后旧查询晚到错误不得投影到当前状态行');
  assert.equal(staleQueryButton.hidden, false,
    '旧查询失败后仍应保留待核对入口,不能误清当前动作');
  assert.equal(
    localActionRecovery.readPendingLocalActionRecords()
      .some(record => record.action_id === actionId),
    true,
    '旧查询晚到普通错误时必须保留恢复记录,等待用户在当前目录重新核对',
  );
  localActionRecovery.forgetLocalActionRecovery(actionId);
}

// 服务端已验证但证据尚未持久化时,不能丢掉本地 marker;否则刷新页面会
// 再次恢复旧动作,而当前页却已经失去查询/清理入口。
{
  const actionId = 'openout_verified_marker_unpersisted_1';
  const key = localActionRecovery.pendingLocalActionStorageKey(actionId);
  globalThis.localStorage.setItem(key, JSON.stringify({
    action_id: actionId,
    kind: 'open_output',
    at: Date.now(),
    target: { output_dir_identity: 'output-unpersisted' },
  }));
  const unpersistedPage = {
    api: {
      get() {
        return Promise.resolve({ evidence: {
          kind: 'open_output',
          action_id: actionId,
          output_dir_identity: 'output-unpersisted',
          local_action_committed: true,
          verified: true,
          status: 'verified',
          evidence_persisted: false,
        } });
      },
    },
    ui: {},
    getSettings: () => ({
      render: { default_theme: 'auto', default_font_size: 'normal' },
      output: { dir: './outputs/unpersisted', retention_days: 0, filename_pattern: '{group}' },
    }),
    getOutputDirIdentity: () => 'output-unpersisted',
    isBusy: () => false,
    markDirty() {},
    beginAction() { return { signal: new AbortController().signal }; },
    alive() { return true; },
    endAction() {},
  };
  const beforeUnpersisted = createdNodes.length;
  const unpersistedSection = output.createOutputSection(unpersistedPage);
  unpersistedSection.applySettings(unpersistedPage.getSettings());
  const unpersistedNodes = createdNodes.slice(beforeUnpersisted);
  const unpersistedOpenButton = unpersistedNodes.find(node => node.textContent === '打开输出目录');
  const unpersistedQueryButton = unpersistedNodes.find(node => node.textContent === '查询结果');
  assert.ok(unpersistedOpenButton && unpersistedQueryButton && !unpersistedQueryButton.hidden,
    '本地证据未持久化时必须保留查询入口');
  unpersistedQueryButton.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(unpersistedQueryButton.hidden, false,
    'verified 但 marker 未持久化时不得隐藏查询入口');
  assert.equal(unpersistedOpenButton.disabled, true,
    'marker 未持久化时不得重新开放重复打开动作');
  assert.equal(
    localActionRecovery.readPendingLocalActionRecords()
      .some(record => record.action_id === actionId),
    true,
    'evidence_persisted=false 时必须保留物理恢复 marker');
  localActionRecovery.forgetLocalActionRecovery(actionId);
}

// 恢复到结果未知的动作时,不能重新开放同一“打开目录”入口;
// 必须先查询旧 action,否则用户会在服务端结果未知时重复执行本地动作。
{
  const actionId = 'openout_restore_pending_gate_1';
  const key = localActionRecovery.pendingLocalActionStorageKey(actionId);
  globalThis.localStorage.setItem(key, JSON.stringify({
    action_id: actionId,
    kind: 'open_output',
    at: Date.now(),
    target: { output_dir_identity: 'output-pending-gate' },
  }));
  let openCalls = 0;
  const pendingGatePage = {
    api: {
      post() {
        openCalls += 1;
        return Promise.resolve({});
      },
      get() { return Promise.resolve({ evidence: { pending: true } }); },
    },
    ui: {},
    getSettings: () => ({
      render: { default_theme: 'auto', default_font_size: 'normal' },
      output: { dir: './outputs/pending-gate', retention_days: 0, filename_pattern: '{group}' },
    }),
    getOutputDirIdentity: () => 'output-pending-gate',
    isBusy: () => false,
    markDirty() {},
    beginAction() { return { signal: new AbortController().signal }; },
    alive() { return true; },
    endAction() {},
  };
  const beforePendingGate = createdNodes.length;
  const pendingGateSection = output.createOutputSection(pendingGatePage);
  pendingGateSection.applySettings(pendingGatePage.getSettings());
  const pendingGateNodes = createdNodes.slice(beforePendingGate);
  const pendingOpenButton = pendingGateNodes.find(node => node.textContent === '打开输出目录');
  const pendingQueryButton = pendingGateNodes.find(node => node.textContent === '查询结果');
  assert.ok(pendingOpenButton && pendingQueryButton && pendingQueryButton.hidden === false,
    '恢复结果未知动作后必须同时保留查询入口');
  assert.equal(pendingOpenButton.disabled, true,
    '存在结果未知 marker 时不得重新启用打开输出目录按钮');
  pendingOpenButton.click();
  assert.equal(openCalls, 0,
    '结果未知 marker 未核对前,用户点击不得再次发起打开目录请求');
  localActionRecovery.forgetLocalActionRecovery(actionId);
}

// createApi 在已验证响应后会尝试删除本机 marker;删除失败不会改变业务响应,
// 但输出分区仍必须保留查询入口,否则当前页看似完成而刷新后又恢复同一动作。
{
  const previousStorage = globalThis.localStorage;
  const backingStorage = new MemoryStorage();
  let actionKey = '';
  globalThis.localStorage = {
    get length() { return backingStorage.length; },
    key(index) { return backingStorage.key(index); },
    getItem(name) { return backingStorage.getItem(name); },
    setItem(name, value) { backingStorage.setItem(name, value); },
    removeItem(name) {
      if (name === actionKey) throw new Error('open-output marker cleanup denied');
      backingStorage.removeItem(name);
    },
  };
  try {
    const cleanupPage = {
      api: {
        post(path, body) {
          assert.equal(path, '/api/open-output');
          actionKey = localActionRecovery.pendingLocalActionStorageKey(body.local_action_id);
          localActionRecovery.beginLocalActionRecovery({
            actionId: body.local_action_id,
            kind: 'open_output',
            target: { output_dir_identity: 'output-cleanup-on-open' },
          });
          try { localActionRecovery.forgetLocalActionRecovery(body.local_action_id); } catch {}
          return Promise.resolve({
            local_action_id: body.local_action_id,
            local_action_committed: true,
            verified: true,
            status: 'verified',
            evidence_persisted: true,
            opener: { local_action_committed: true, verification_status: 'verified' },
          });
        },
      },
      ui: {},
      getSettings: () => ({
        render: { default_theme: 'auto', default_font_size: 'normal' },
        output: { dir: './outputs/cleanup-on-open', retention_days: 0, filename_pattern: '{group}' },
      }),
      getOutputDirIdentity: () => 'output-cleanup-on-open',
      isBusy: () => false,
      markDirty() {},
      beginAction() { return { signal: new AbortController().signal }; },
      alive() { return true; },
      endAction() {},
    };
    const beforeCleanupOpen = createdNodes.length;
    output.createOutputSection(cleanupPage);
    const cleanupOpenNodes = createdNodes.slice(beforeCleanupOpen);
    const cleanupOpenButton = cleanupOpenNodes.find(node => node.textContent === '打开输出目录');
    const cleanupQueryButton = cleanupOpenNodes.find(node => node.textContent === '查询结果');
    const cleanupOpenStatus = cleanupOpenNodes
      .filter(node => String(node.className || '').split(/\s+/).includes('settings-status'))
      .at(-1);
    assert.ok(cleanupOpenButton && cleanupQueryButton && cleanupOpenStatus);
    cleanupOpenButton.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(actionKey, '成功打开动作必须建立可核对的本机 marker');
    assert.notEqual(backingStorage.getItem(actionKey), null,
      '模拟 API 清理失败后 marker 必须仍然存在');
    assert.equal(cleanupQueryButton.hidden, false,
      '已验证但 marker 清理失败时必须保留查询入口');
    assert.match(cleanupOpenStatus.textContent, /清理|查询|记录/,
      'marker 清理失败必须给出可操作提示,不能静默宣称已完成');
  } finally {
    globalThis.localStorage = previousStorage;
  }
}

// 另一标签页在当前设置页已经打开后发起本机打开动作；当前页必须通过
// localStorage storage 事件立即接管恢复 marker，不能再发送第二个窗口动作。
{
  const actionId = 'openout_cross_tab_marker_1';
  const markerKey = localActionRecovery.pendingLocalActionStorageKey(actionId);
  const crossTabPage = {
    api: {
      post() {
        throw Object.assign(new Error('已有文件管理器操作正在等待最终确认'), {
          status: 409,
          code: 'local_window_action_in_progress',
        });
      },
    },
    ui: {},
    getSettings: () => ({
      render: { default_theme: 'auto', default_font_size: 'normal' },
      output: { dir: './outputs/cross-tab', retention_days: 0, filename_pattern: '{group}' },
    }),
    getOutputDirIdentity: () => 'output-cross-tab',
    isBusy: () => false,
    markDirty() {},
    beginAction() { return { signal: new AbortController().signal }; },
    alive() { return true; },
    endAction() {},
  };
  const before = createdNodes.length;
  output.createOutputSection(crossTabPage);
  const nodes = createdNodes.slice(before);
  const openButton = nodes.find(node => node.textContent === '打开输出目录');
  const queryButton = nodes.find(node => node.textContent === '查询结果');
  assert.ok(openButton && queryButton && queryButton.hidden === true,
    '跨标签测试必须从没有 pending marker 的空闲输出分区开始');
  globalThis.localStorage.setItem(markerKey, JSON.stringify({
    action_id: actionId,
    kind: 'open_output',
    at: Date.now(),
    target: { output_dir_identity: 'output-cross-tab' },
  }));
  for (const listener of [...storageListeners]) {
    listener({ key: markerKey, storageArea: globalThis.localStorage });
  }
  assert.equal(queryButton.hidden, false,
    '另一标签页登记打开动作后,当前页必须立即显示查询结果入口');
  assert.equal(openButton.disabled, true,
    '另一标签页登记打开动作后,当前页必须阻止重复打开');
  localActionRecovery.forgetLocalActionRecovery(actionId);
}

// A 的查询仍在途时,另一标签页登记 B。A 的晚到 verified 结果不得清理
// A/B marker 或覆盖当前 B 的查询状态;分区销毁还必须注销自己的 listener。
{
  const actionA = 'openout_cross_tab_query_a';
  const actionB = 'openout_cross_tab_query_b';
  const now = Date.now();
  globalThis.localStorage.setItem(
    localActionRecovery.pendingLocalActionStorageKey(actionA),
    JSON.stringify({
      action_id: actionA,
      kind: 'open_output',
      at: now,
      target: { output_dir_identity: 'output-cross-tab-query' },
    }),
  );
  let resolveQuery;
  let queryCalls = 0;
  const queryResult = new Promise(resolve => { resolveQuery = resolve; });
  const queryPage = {
    api: {
      get() {
        queryCalls += 1;
        return queryResult;
      },
    },
    ui: {},
    getSettings: () => ({
      render: { default_theme: 'auto', default_font_size: 'normal' },
      output: { dir: './outputs/cross-tab-query', retention_days: 0, filename_pattern: '{group}' },
    }),
    getOutputDirIdentity: () => 'output-cross-tab-query',
    isBusy: () => false,
    markDirty() {},
    beginAction() { return { signal: new AbortController().signal }; },
    alive() { return true; },
    endAction() {},
  };
  const listenersBefore = storageListeners.size;
  const before = createdNodes.length;
  const querySection = output.createOutputSection(queryPage);
  const nodes = createdNodes.slice(before);
  const queryButton = nodes.find(node => node.textContent === '查询结果');
  const openButton = nodes.find(node => node.textContent === '打开输出目录');
  const openStatus = nodes
    .filter(node => String(node.className || '').split(/\s+/).includes('settings-status'))
    .at(-1);
  assert.ok(queryButton && openButton && openStatus && !queryButton.hidden);
  assert.equal(storageListeners.size, listenersBefore + 1,
    '每个输出分区只能注册一个跨标签 marker listener');
  queryButton.click();
  await Promise.resolve();
  assert.equal(queryCalls, 1, '跨标签换代前必须只发起一次 A 证据查询');
  globalThis.localStorage.setItem(
    localActionRecovery.pendingLocalActionStorageKey(actionB),
    JSON.stringify({
      action_id: actionB,
      kind: 'open_output',
      at: now + 1,
      target: { output_dir_identity: 'output-cross-tab-query' },
    }),
  );
  for (const listener of [...storageListeners]) {
    listener({
      key: localActionRecovery.pendingLocalActionStorageKey(actionB),
      storageArea: globalThis.localStorage,
    });
  }
  assert.equal(queryButton.hidden, false, 'B marker 到达后必须保留当前查询入口');
  assert.equal(openButton.disabled, true, 'B marker 到达后不得重新开放重复动作');
  resolveQuery({ evidence: {
    kind: 'open_output',
    action_id: actionA,
    output_dir_identity: 'output-cross-tab-query',
    local_action_committed: true,
    verified: true,
    evidence_persisted: true,
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queryButton.hidden, false,
    'A 的晚到结果不得隐藏 B 的查询入口');
  assert.equal(
    localActionRecovery.readPendingLocalActionRecords()
      .some(record => record.action_id === actionB),
    true,
    'A 的晚到结果不得清理 B marker',
  );
  assert.doesNotMatch(openStatus.textContent, /已确认:输出目录已在文件管理器中打开/,
    'A 的晚到结果不得投影为当前 B 已完成');
  querySection.destroy();
  assert.equal(storageListeners.size, listenersBefore,
    '输出分区销毁后必须移除自己的跨标签 listener');
  localActionRecovery.forgetLocalActionRecovery(actionA);
  localActionRecovery.forgetLocalActionRecovery(actionB);
}

console.log('web settings output recovery restore tests passed');
