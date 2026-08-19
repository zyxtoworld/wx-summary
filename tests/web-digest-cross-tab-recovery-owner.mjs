import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRecoveryActionState } from '../src/web/public/js/pages/digest/recovery-action-state.js';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function extractFunction(sourceText, marker) {
  const start = sourceText.indexOf(marker);
  assert.ok(start >= 0, `必须能定位 ${marker}`);
  const signatureEnd = sourceText.indexOf(') {', start);
  assert.ok(signatureEnd >= 0, `${marker} 必须有可定位的函数体`);
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
    if (char === '`' || char === '\'' || char === '"') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return sourceText.slice(start, index + 1);
  }
  throw new Error(`${marker} 函数体未闭合`);
}

class Node {
  constructor(tag = 'div', className = '', text = '') {
    this.tag = tag;
    this.className = className;
    this.textContent = text;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.disabled = false;
    this.isConnected = true;
  }

  append(...children) { this.children.push(...children.filter(Boolean)); }
  appendChild(child) { if (child) this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children.filter(Boolean); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  userClick() {
    if (this.disabled) return false;
    this.lastClickPromise = Promise.resolve(
      this.listeners.get('click')?.({ currentTarget: this }),
    );
    return true;
  }
}

class MemoryStorage {
  #values = new Map();
  getItem(key) { return this.#values.get(String(key)) ?? null; }
  setItem(key, value) { this.#values.set(String(key), String(value)); }
  removeItem(key) { this.#values.delete(String(key)); }
}

function collect(root, predicate, out = []) {
  if (predicate(root)) out.push(root);
  for (const child of root.children || []) collect(child, predicate, out);
  return out;
}

function createTabHarness({ checkSource, runRecoveryOnce, record, api, shared }) {
  const nodes = [];
  const makeNode = (tag = 'div', className = '', text = '') => {
    const node = new Node(tag, className, text);
    nodes.push(node);
    return node;
  };
  const page = {
    destroyed: false,
    accountContextBlocked: false,
    activeBatch: null,
    activeBatchRelease: null,
    previewDigests: [],
    previewMarkdown: '',
    renderOptions: { theme: 'auto', fontSize: 'normal' },
  };
  const recoveryAction = createRecoveryActionState();
  const recoverySlot = makeNode('div', 'recovery-slot');
  const batchResultSlot = makeNode('div', 'batch-slot');
  let renderCalls = 0;

  const checkInterruptedRecovery = new Function(
    'page',
    'recoveryAction',
    'recoverySlot',
    'currentRecoveryRecord',
    'el',
    'captureActionFocus',
    'globalThis',
    'finishRecoveryAction',
    'forgetInterruptedDigestBatch',
    'cancelDigestBatch',
    'api',
    'runRecoveryOnce',
    'createDigestRecoveryOwner',
    'currentRecoveryIdentity',
    'digestMarkdownForDigests',
    'interruptedDigestBatchMatchesAccount',
    'startBatchKeepalive',
    'renderTextPreviewCard',
    'recoverImageBatchResults',
    'batchResultSlot',
    'buildRecoveredResultsCard',
    'digestBatchRecoveryList',
    'digestBatchPreviewRecovery',
    'admitRecoveredBatch',
    'actionAbort',
    `${checkSource}; return checkInterruptedRecovery;`,
  )(
    page,
    recoveryAction,
    recoverySlot,
    batchId => (!batchId || shared.markerPresent) && record,
    makeNode,
    () => null,
    { document: { activeElement: null, body: {} } },
    action => {
      if (!recoveryAction.isCurrent(action)) return false;
      recoveryAction.end(action);
      return true;
    },
    batchId => {
      if (String(batchId || '').trim() !== record.batch_id) return false;
      shared.markerPresent = false;
      return true;
    },
    async () => {},
    api,
    runRecoveryOnce,
    shared.createDigestRecoveryOwner,
    () => ({ account_id: record.account_id, account_fingerprint: record.account_fingerprint }),
    () => '',
    shared.interruptedDigestBatchMatchesAccount,
    () => {},
    () => { renderCalls += 1; },
    async () => null,
    batchResultSlot,
    () => makeNode('section'),
    shared.digestBatchRecoveryList,
    shared.digestBatchPreviewRecovery,
    async recovered => ({ admitted: true, owner: recovered }),
    new AbortController(),
  );

  return {
    page,
    recoveryAction,
    recoverySlot,
    get renderCalls() { return renderCalls; },
    checkInterruptedRecovery,
    recoverButton() {
      return collect(recoverySlot, node => node.tag === 'button'
        && node.textContent === '恢复结果')[0] || null;
    },
  };
}

globalThis.location = new URL('http://wx-summary.test/#/digest');
globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage();

const loader = createBrowserModuleLoader();
const recovery = await loader.load('js/pages/digest/recovery.js');
const batchRunner = await loader.load('js/pages/digest/batch-runner.js');
const source = await readFile(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');
const checkSource = extractFunction(source, 'async function checkInterruptedRecovery()');

const identity = { accountId: 'cross-tab-account', accountFingerprint: 'a'.repeat(64) };
const record = {
  batch_id: 'cross-tab-recovery-batch',
  batch_token: 'cross-tab-recovery-token-123456',
  service_instance_id: 'cross-tab-service',
  account_id: identity.accountId,
  account_fingerprint: identity.accountFingerprint,
  batch_total: 1,
  preview_text: true,
  targets: [{ group_id: 'cross-tab-group', group_name: 'cross-tab-group' }],
};

const shared = {
  markerPresent: true,
  createDigestRecoveryOwner: recovery.createDigestRecoveryOwner,
  interruptedDigestBatchMatchesAccount: recovery.interruptedDigestBatchMatchesAccount,
  digestBatchRecoveryList: recovery.digestBatchRecoveryList,
  digestBatchPreviewRecovery: recovery.digestBatchPreviewRecovery,
};

let lockBusy = false;
const locks = {
  request(_name, options, callback) {
    if (Object.hasOwn(options, 'ifAvailable')) {
      assert.equal(options.ifAvailable, true, '恢复跨标签协调必须使用 ifAvailable Web Lock');
    }
    if (lockBusy) return Promise.resolve(callback(null));
    lockBusy = true;
    return Promise.resolve(callback({ name: 'cross-tab-recovery' }))
      .finally(() => { lockBusy = false; });
  },
};

let nowMs = Date.now();
const runnerA = recovery.createInterruptedDigestRecoveryRunner({
  locks,
  storage: globalThis.localStorage,
  now: () => nowMs,
  readRecords: () => shared.markerPresent ? [record] : [],
});
const runnerB = recovery.createInterruptedDigestRecoveryRunner({
  locks,
  storage: globalThis.localStorage,
  now: () => nowMs,
  readRecords: () => shared.markerPresent ? [record] : [],
});

const afterLockA = deferred();
const allowACommit = deferred();
const releaseA = deferred();
const releaseB = deferred();
const bStarted = deferred();
let apiCalls = 0;
const api = {
  async post(path, _body, options = {}) {
    assert.equal(path, '/api/digest-batch-preview');
    assert.ok(options.signal, '恢复请求必须绑定页面 action signal');
    apiCalls += 1;
    if (apiCalls === 1) {
      return releaseA.promise;
    }
    bStarted.resolve();
    return releaseB.promise;
  },
  getServiceInstanceId() { return record.service_instance_id; },
};

const tabA = createTabHarness({
  checkSource,
  record,
  api,
  shared,
  runRecoveryOnce: (taskId, recover, options) => runnerA.run(taskId, {
    getIdentity: options.getIdentity,
    signal: options.signal,
    recover,
  }).then(async result => {
    afterLockA.resolve();
    await allowACommit.promise;
    return result;
  }),
});
const tabB = createTabHarness({
  checkSource,
  record,
  api,
  shared,
  runRecoveryOnce: (taskId, recover, options) => runnerB.run(taskId, {
    getIdentity: options.getIdentity,
    signal: options.signal,
    recover,
  }),
});

await tabA.checkInterruptedRecovery();
const recoverA = tabA.recoverButton();
assert.ok(recoverA, 'A 必须通过真实恢复卡片挂出恢复按钮');
assert.equal(recoverA.userClick(), true, 'A 必须从真实可用按钮点击启动恢复');
await Promise.resolve();
assert.equal(apiCalls, 1, 'A 点击后必须只发起一次恢复请求');

releaseA.resolve({ ok: true, status: 'done', pending: false, digests: [{ markdown: 'A' }] });
await afterLockA.promise;
tabA.page.destroyed = true;
tabA.recoveryAction.invalidate('A 页面已卸载');

await tabB.checkInterruptedRecovery();
const recoverB = tabB.recoverButton();
assert.ok(recoverB, 'A 卸载后 B 必须能看到同一恢复 marker');
assert.equal(recoverB.userClick(), true, 'B 必须从自己的真实恢复按钮点击接管');
await recoverB.lastClickPromise;
assert.equal(apiCalls, 1,
  'A 已完成跨标签恢复读取但尚未提交时,B 不得因 marker 尚未清除而重复 POST');

nowMs += recovery.DIGEST_RECOVERY_CLAIM_TTL_MS + 1;
assert.equal(recoverB.userClick(), true, '恢复 claim 过期后 B 必须能从同一按钮重试接管');
await bStarted.promise;
assert.equal(apiCalls, 2, 'claim 过期后只能由 B 发起一次接管恢复请求');
assert.equal(recovery.forgetInterruptedDigestBatch(record.batch_id), false,
  '旧页面的直接 marker 清理不得删除 B 已取得的恢复 claim');
releaseB.resolve({ ok: true, status: 'done', pending: false, digests: [{ markdown: 'B' }] });
allowACommit.resolve();
await recoverB.lastClickPromise;
await Promise.resolve();
assert.equal(tabA.renderCalls, 0, 'A 卸载后的迟到恢复结果不得渲染');
assert.equal(shared.markerPresent, false, 'B 接管成功后必须由当前 claim 清理恢复 marker');

// 真实 Web Locks 不可重入:恢复 callback 在外层 task lock 内执行,claim.commit
// 不能再次申请同名锁,否则提交会与外层 callback 互相等待。
{
  const strictLocks = (() => {
    let held = false;
    const queue = [];
    const pump = () => {
      if (held || !queue.length) return;
      held = true;
      const { callback, resolve, reject } = queue.shift();
      Promise.resolve().then(() => callback({ name: 'strict-recovery-lock' }))
        .then(resolve, reject)
        .finally(() => {
          held = false;
          pump();
        });
    };
    return {
      request(name, options, callback) {
        if (held && options?.ifAvailable === true) return Promise.resolve(callback(null));
        return new Promise((resolve, reject) => {
          queue.push({ name, callback, resolve, reject });
          pump();
        });
      },
    };
  })();
  const strictStorage = new MemoryStorage();
  const strictRecord = {
    ...record,
    batch_id: 'cross-tab-claim-commit-lock',
    started_at: Date.now(),
    updated_at: Date.now(),
  };
  const strictRunner = recovery.createInterruptedDigestRecoveryRunner({
    locks: strictLocks,
    storage: strictStorage,
    readRecords: () => [strictRecord],
  });
  const strictRun = strictRunner.run(strictRecord.batch_id, {
    getIdentity: () => ({
      accountId: strictRecord.account_id,
      accountFingerprint: strictRecord.account_fingerprint,
    }),
    recover: async (_currentRecord, claim) => claim.commit(async () => true),
  });
  const strictOutcome = await Promise.race([
    strictRun,
    new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), 100)),
  ]);
  assert.notEqual(strictOutcome?.timedOut, true,
    '恢复 callback 内提交 claim 不得嵌套申请同名不可重入 Web Lock');
  assert.equal(strictOutcome?.ran, true, 'claim 提交完成后外层恢复任务必须正常收口');
}

console.log('web digest cross-tab recovery owner tests passed');
