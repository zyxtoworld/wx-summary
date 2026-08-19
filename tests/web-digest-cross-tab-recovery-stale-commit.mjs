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
  replaceChildren(...children) { this.children = children.filter(Boolean); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  userClick() {
    if (this.disabled) return false;
    this.lastClickPromise = Promise.resolve(this.listeners.get('click')?.({ currentTarget: this }));
    return true;
  }
}

function collect(root, predicate, out = []) {
  if (predicate(root)) out.push(root);
  for (const child of root.children || []) collect(child, predicate, out);
  return out;
}

const loader = createBrowserModuleLoader();
globalThis.location = new URL('http://wx-summary.test/#/digest');
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.sessionStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
const recovery = await loader.load('js/pages/digest/recovery.js');
const source = await readFile(
  new URL('../src/web/public/js/pages/digest/index.js', import.meta.url),
  'utf8',
);
const checkSource = extractFunction(source, 'async function checkInterruptedRecovery()');

const identity = { accountId: 'cross-tab-stale-account', accountFingerprint: 'b'.repeat(64) };
const record = {
  batch_id: 'cross-tab-stale-batch',
  batch_token: 'cross-tab-stale-token-123456',
  service_instance_id: 'cross-tab-stale-service',
  account_id: identity.accountId,
  account_fingerprint: identity.accountFingerprint,
  batch_total: 1,
  preview_text: true,
  targets: [{ group_id: 'cross-tab-stale-group', group_name: 'cross-tab-stale-group' }],
};

const shared = { markerPresent: true, forgotten: 0 };
const nodes = [];
const makeNode = (tag = 'div', className = '', text = '') => {
  const node = new Node(tag, className, text);
  nodes.push(node);
  return node;
};
const page = { destroyed: false, accountContextBlocked: false };
const recoveryAction = createRecoveryActionState();
const recoverySlot = makeNode('div', 'recovery-slot');
const batchResultSlot = makeNode('div', 'batch-slot');
const previewGate = deferred();
const commitStarted = deferred();
const allowCommit = deferred();
const ui = { toastSuccessCalls: 0, toastSuccess() { this.toastSuccessCalls += 1; } };
const api = {
  async post(path, _body, _options) {
    assert.equal(path, '/api/digest-batch-preview');
    return previewGate.promise;
  },
  getServiceInstanceId() { return record.service_instance_id; },
};

const claim = {
  ownerId: 'claim-owner-a',
  isCurrent: () => true,
  release: () => true,
  async commit(callback) {
    commitStarted.resolve();
    await allowCommit.promise;
    return callback() === true;
  },
};

const runRecoveryOnce = async (taskId, recover) => {
  assert.equal(taskId, record.batch_id);
  const value = await recover(record, claim);
  return { ran: true, value };
};

const checkInterruptedRecovery = new Function(
  'ui',
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
  ui,
  page,
  recoveryAction,
  recoverySlot,
  batchId => (!batchId || shared.markerPresent) ? record : null,
  makeNode,
  () => null,
  { document: { activeElement: null, body: {} } },
  action => {
    if (!recoveryAction.isCurrent(action)) return false;
    recoveryAction.end(action);
    return true;
  },
  () => {
    shared.forgotten += 1;
    shared.markerPresent = false;
    return true;
  },
  async () => {},
  api,
  runRecoveryOnce,
  recovery.createDigestRecoveryOwner,
  () => identity,
  () => '',
  recovery.interruptedDigestBatchMatchesAccount,
  () => {},
  () => {},
  async () => null,
  batchResultSlot,
  () => makeNode('section'),
  recovery.digestBatchRecoveryList,
  recovery.digestBatchPreviewRecovery,
  async recovered => ({ admitted: true, owner: recovered }),
  new AbortController(),
);

await checkInterruptedRecovery();
const recoverButton = collect(
  recoverySlot,
  node => node.tag === 'button' && node.textContent === '恢复结果',
)[0];
assert.ok(recoverButton, '必须从真实恢复卡片拿到可点击按钮');
assert.equal(recoverButton.userClick(), true, '必须通过真实按钮点击启动恢复');
previewGate.resolve({ status: 'done', digests: [{ markdown: 'stale-commit' }] });
await commitStarted.promise;

// A 的恢复 action 在 marker commit 前失效;B 仍应能在后续租约窗口接管,
// 因此 A 不能删除 marker、清空恢复卡或投影成功提示。
recoveryAction.invalidate('A 页面已卸载');
allowCommit.resolve();
await recoverButton.lastClickPromise;

assert.equal(shared.forgotten, 0, '失效 A 不得清理共享恢复 marker');
assert.equal(shared.markerPresent, true, 'B 接管前 marker 必须保留');
assert.equal(ui.toastSuccessCalls, 0, '失效 A 不得投影恢复成功提示');
assert.equal(recoverySlot.children.length, 1, '失效 A 不得清空 B 仍需使用的恢复卡');

console.log('web digest cross-tab stale commit tests passed');
