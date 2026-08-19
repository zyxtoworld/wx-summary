import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createCrossTabTaskRunner } from '../src/web/public/js/shared/cross-tab-task-runner.js';

const source = await fs.readFile(
  new URL('../src/web/public/js/pages/digest/index.js', import.meta.url),
  'utf8',
);

function extractFunction(sourceText, marker) {
  const start = sourceText.indexOf(marker);
  assert.ok(start >= 0, `必须能定位生产函数 ${marker}`);
  const signatureEnd = sourceText.indexOf(') {', start);
  assert.ok(signatureEnd >= 0, `${marker} 必须有函数体`);
  const open = sourceText.indexOf('{', signatureEnd + 2);
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

const startSource = extractFunction(source, 'async function startGeneration(previewText)');
const forgetCancelledSource = extractFunction(source, 'function forgetCancelledBatchMarker(');
assert.match(source, /generateBtn\.addEventListener\('click',[\s\S]*startGeneration\(false\)/,
  '摘要生成必须从真实生成按钮事件进入 production startGeneration');
assert.ok(source.includes("createCrossTabTaskRunner({\n    locks: globalThis.navigator?.locks || null,\n    namespace: 'digest-generation',"),
  '摘要生成页面必须创建独立的跨标签 owner runner');
assert.ok(source.includes('page.acquireCrossTabGenerationLease = async')
  && source.includes('digestGenerationRunner.acquire'),
  '真实页面必须把摘要生成 owner 接到共享跨标签 runner');

class Node {
  constructor() {
    this.children = [];
    this.hidden = false;
    this.disabled = false;
    this.firstElementChild = null;
    this.listeners = new Map();
  }

  append(...nodes) { this.children.push(...nodes.filter(Boolean)); }
  appendChild(node) { if (node) this.children.push(node); return node; }
  replaceChildren(...nodes) {
    this.children = nodes.filter(Boolean);
    this.firstElementChild = this.children[0] || null;
  }
  querySelector() { return null; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  userClick() {
    if (this.disabled) return false;
    this.lastClickPromise = Promise.resolve(this.listeners.get('click')?.({ currentTarget: this }));
    return true;
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(nextResolve => { resolve = nextResolve; });
  return { promise, resolve };
}

const digestBatchCancelConfirmed = value => !!value
  && typeof value === 'object'
  && value.ok === true
  && value.lease_released === true;
const digestBatchFinishConfirmed = value => !!value
  && typeof value === 'object'
  && value.ok === true
  && value.settled === true
  && value.pending !== true;

const shared = {
  startCalls: [],
  cancelCalls: [],
  nextBatch: 0,
};

function createTab(name, runner) {
  const page = {
    generation: 0,
    destroyed: false,
    generationStarting: false,
    running: false,
    saving: false,
    activeBatch: null,
    crossTabGenerationLease: null,
    abortController: null,
    progressView: null,
    progressCleanupTimer: null,
    doneResults: [],
    savedItems: new Map(),
    previewDigests: [],
    generationRender: null,
    renderOptions: { theme: 'auto', fontSize: 'normal' },
    selected: new Set(['group-1']),
    groupsStatus: 'ready',
    groups: [{ id: 'group-1', name: '群一' }],
    minMessages: 1,
    rangeKey: 'yesterdayToday',
    customSince: '',
    customUntil: '',
    filters: { senders: [], keywords: [], exclude_types: [] },
  };
  const account = { id: 'account-cross-tab', manual_key_account_fingerprint: 'a'.repeat(64) };
  const store = { get: key => key === 'account' ? account : null };
  const resultSlot = new Node();
  const textPreviewSlot = new Node();
  const batchResultSlot = new Node();
  const progressSlot = new Node();
  const generateBtn = new Node();
  const previewBtn = new Node();
  const root = { contains: () => false };
  const abortRun = deferred();

  page.acquireCrossTabGenerationLease = async () => {
    if (page.crossTabGenerationLease) return { acquired: true, reused: true };
    const result = await runner.acquire('digest-cross-tab-account', { ifAvailable: true });
    if (result?.acquired === true) page.crossTabGenerationLease = result;
    return result;
  };
  page.releaseCrossTabGenerationLease = () => {
    const lease = page.crossTabGenerationLease;
    page.crossTabGenerationLease = null;
    return lease?.release?.() === true;
  };

  const api = {
    getServiceInstanceId() { return 'service-cross-tab'; },
    async post(path, body) {
      if (path === '/api/digest-batch-start') {
        shared.startCalls.push({ tab: name, body });
        return {
          ok: true,
          batch_id: body.batch_id,
          service_instance_id: body.service_instance_id,
          account_id: body.account_id,
          account_fingerprint: 'a'.repeat(64),
        };
      }
      if (path === '/api/digest-batch-cancel') {
        shared.cancelCalls.push({ tab: name, body });
        return { ok: true, lease_released: true };
      }
      if (path === '/api/digest-cancel') {
        shared.cancelCalls.push({ tab: name, body });
        return { ok: true, lease_released: true };
      }
      if (path === '/api/digest-batch-finish') {
        return { ok: true, settled: true, pending: false, released: false };
      }
      if (path === '/api/digest-batch-heartbeat') return { ok: true };
      throw new Error(`unexpected API ${path}`);
    },
  };

  const runDigestBatch = async (_api, options) => {
    const batch = {
      batch_id: `batch-${++shared.nextBatch}`,
      batch_token: `token-${shared.nextBatch}`,
      service_instance_id: 'service-cross-tab',
    };
    await _api.post('/api/digest-batch-start', {
      batch_id: batch.batch_id,
      batch_token: batch.batch_token,
      service_instance_id: batch.service_instance_id,
      account_id: account.id,
      expected_account_fingerprint: account.manual_key_account_fingerprint,
    }, { signal: options.signal });
    options.onBatchCreated(batch);
    await abortRun.promise;
    const error = Object.assign(new Error(`${name} 已取消`), { name: 'AbortError', status: 499 });
    throw error;
  };

  const startBatchKeepalive = () => {};
  const rememberInterruptedDigestBatch = () => true;
  const forgetInterruptedDigestBatch = () => false;
  const finalizeInterruptedDigestBatchRecord = () => ({ retained: true });
  const digestBatchHasUsableResult = () => false;
  const digestBatchFailureNeedsRecovery = () => false;
  const isMutationOutcomeUnknown = () => false;
  const checkInterruptedRecovery = () => {};
  const showTextPreview = () => {};
  const showImageResults = async () => {};
  const lockInputs = running => { page.running = running; };
  const createProgressView = ({ onCancel }) => ({
    el: new Node(),
    setTotal() {},
    setCurrentGroup() {},
    resetStages() {},
    onStage() {},
    log() {},
    setTerminal() {},
    dispose() {},
    setCancelling() {},
    onCancel,
  });
  const ui = {
    async confirmDialog() { return true; },
    toastError() {},
    toastWarn() {},
    toast() {},
    setGlobalProgress() {},
  };
  const releaseActiveBatch = async ({ owner } = {}) => {
    if (owner !== undefined && page.activeBatch !== owner) return false;
    page.activeBatch = null;
    return true;
  };
  const alive = token => !page.destroyed && token === page.generation;
  const setGenerationStarting = value => { page.generationStarting = value; };
  const combinedSource = `${forgetCancelledSource}\n${startSource}\nreturn startGeneration;`;
  const startGeneration = new Function(
    'page', 'store', 'ui', 'api', 'digestInputsLocked', 'accountIdOf',
    'accountFingerprintOf', 'digestGenerationGroupAdmission', 'currentRangeOrError',
    'generateBtn', 'previewBtn', 'root', 'captureActionFocus', 'setGenerationStarting',
    'releaseActiveBatch', 'alive', 'restoreActionFocus', 'resultSlot', 'textPreviewSlot',
    'batchResultSlot', 'resultRenderState', 'lockInputs', 'createProgressView',
    'progressSlot', 'freezeDigestRenderSelection', 'el', 'runDigestBatch',
    'startBatchKeepalive', 'forgetInterruptedDigestBatch', 'rememberInterruptedDigestBatch',
    'digestBatchHasUsableResult', 'showTextPreview', 'showImageResults',
    'digestBatchFailureNeedsRecovery', 'isMutationOutcomeUnknown',
    'finalizeInterruptedDigestBatchRecord', 'checkInterruptedRecovery',
    'clearProgressCleanupTimer', 'scheduleProgressCleanup', 'setTimeout', 'clearTimeout',
    'digestBatchCancelConfirmed', 'cancelDigestBatch',
    `${combinedSource}`,
  )(
    page, store, ui, api, () => page.generationStarting || page.running || page.saving,
    value => value.id,
    value => value.manual_key_account_fingerprint,
    () => ({ allowed: true }),
    () => ({ since: '2026-08-16 00:00:00', until: '2026-08-16 23:59:59' }),
    generateBtn, previewBtn, root, () => null, setGenerationStarting,
    releaseActiveBatch, alive, () => {}, resultSlot, textPreviewSlot, batchResultSlot,
    { invalidate() {} }, lockInputs, createProgressView, progressSlot,
    () => ({ theme: 'auto', fontSize: 'normal' }),
    () => new Node(), runDigestBatch, startBatchKeepalive, forgetInterruptedDigestBatch,
    rememberInterruptedDigestBatch, digestBatchHasUsableResult, showTextPreview,
    showImageResults, digestBatchFailureNeedsRecovery, isMutationOutcomeUnknown,
    finalizeInterruptedDigestBatchRecord, checkInterruptedRecovery,
    () => {}, () => {}, () => {}, () => {}, digestBatchCancelConfirmed,
    async () => ({ ok: true, lease_released: true }),
  );

  generateBtn.addEventListener('click', () => {
    generateBtn.startPromise = startGeneration(false);
    void generateBtn.startPromise;
  });
  return {
    name,
    page,
    generateBtn,
    startGeneration,
    abort() {
      abortRun.resolve();
      page.abortController?.abort(Object.assign(new Error('测试取消'), {
        name: 'AbortError',
        status: 499,
      }));
    },
  };
}

let lockHeld = false;
const locks = {
  request(name, options, callback) {
    assert.equal(options.ifAvailable, true, '生成 owner 必须使用不可排队的 Web Lock');
    if (lockHeld) return Promise.resolve(callback(null));
    lockHeld = true;
    return Promise.resolve(callback({ name })).finally(() => { lockHeld = false; });
  },
};
const tabA = createTab('A', createCrossTabTaskRunner({ locks, namespace: 'digest-generation' }));
const tabB = createTab('B', createCrossTabTaskRunner({ locks, namespace: 'digest-generation' }));
assert.equal(tabA.generateBtn.userClick(), true, 'A 必须通过真实生成按钮点击启动');
for (let index = 0; index < 10 && shared.startCalls.length < 1; index += 1) {
  await Promise.resolve();
}
assert.equal(shared.startCalls.length, 1, 'A 点击后必须只创建一个批次');

assert.equal(tabB.generateBtn.userClick(), true, 'B 必须通过真实生成按钮点击尝试接管');
for (let index = 0; index < 10 && shared.startCalls.length < 2; index += 1) {
  await Promise.resolve();
}
assert.equal(shared.startCalls.length, 1,
  'A 持有同账号生成 owner 时,B 不得重复 POST 创建第二个摘要批次');

tabA.abort();
await Promise.allSettled([
  tabA.generateBtn.startPromise,
  tabB.generateBtn.startPromise,
]);
await tabA.generateBtn.startPromise;

assert.equal(tabB.generateBtn.userClick(), true, 'A 页面释放 owner 后 B 必须能再次从真实按钮接管');
for (let index = 0; index < 10 && shared.startCalls.length < 2; index += 1) {
  await Promise.resolve();
}
assert.equal(shared.startCalls.length, 2, '前 owner 释放后新的接管只允许创建一个批次');
tabB.abort();
await tabB.generateBtn.startPromise;

const tabWithoutLock = createTab('no-lock', createCrossTabTaskRunner({ locks: null, namespace: 'digest-generation' }));
assert.equal(tabWithoutLock.generateBtn.userClick(), true, '无锁页面仍应能从真实按钮进入明确失败分支');
await tabWithoutLock.generateBtn.startPromise;
assert.equal(shared.startCalls.length, 2,
  '没有跨标签原子锁时必须 fail-closed,不得退化成可重复创建摘要');

console.log('web digest cross-tab start owner tests passed');
