import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRecoveryActionState } from '../src/web/public/js/pages/digest/recovery-action-state.js';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

function extractFunction(sourceText, marker) {
  const start = sourceText.indexOf(marker);
  assert.ok(start >= 0, `必须能定位 ${marker}`);
  const signatureEnd = sourceText.indexOf(') {', start);
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
    if (char === '`' || char === '\'' || char === '"') quote = char;
    else if (char === '{') depth += 1;
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
    this.disabled = false;
    this.isConnected = true;
  }

  append(...children) { this.children.push(...children.filter(Boolean)); }
  replaceChildren(...children) { this.children = children.filter(Boolean); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute() {}
  removeAttribute() {}
  userClick() {
    if (this.disabled) return false;
    this.lastClickPromise = Promise.resolve(this.listeners.get('click')?.({ currentTarget: this }));
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

globalThis.location = new URL('http://wx-summary.test/#/digest');
globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage();
const loader = createBrowserModuleLoader();
const recovery = await loader.load('js/pages/digest/recovery.js');
const source = await readFile(
  new URL('../src/web/public/js/pages/digest/index.js', import.meta.url),
  'utf8',
);
const checkSource = extractFunction(source, 'async function checkInterruptedRecovery()');

const identity = { accountId: 'cross-tab-no-lock-account', accountFingerprint: 'd'.repeat(64) };
const record = {
  batch_id: 'cross-tab-no-lock-batch',
  batch_token: 'cross-tab-no-lock-token-123456',
  service_instance_id: 'cross-tab-no-lock-service',
  account_id: identity.accountId,
  account_fingerprint: identity.accountFingerprint,
  batch_total: 1,
  preview_text: true,
  targets: [{ group_id: 'cross-tab-no-lock-group', group_name: 'cross-tab-no-lock-group' }],
};
const shared = { markerPresent: true };
let apiCalls = 0;

function createTab(runner) {
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
  const ui = { messages: [], toastSuccess() { this.messages.push('success'); } };
  const api = {
    async post(path) {
      assert.equal(path, '/api/digest-batch-preview');
      apiCalls += 1;
      return { status: 'done', digests: [{ markdown: 'duplicate' }] };
    },
    getServiceInstanceId() { return record.service_instance_id; },
  };
  const checkInterruptedRecovery = new Function(
    'ui', 'page', 'recoveryAction', 'recoverySlot', 'currentRecoveryRecord', 'el',
    'captureActionFocus', 'globalThis', 'finishRecoveryAction',
    'forgetInterruptedDigestBatch', 'cancelDigestBatch', 'api', 'runRecoveryOnce',
    'createDigestRecoveryOwner', 'currentRecoveryIdentity', 'digestMarkdownForDigests',
    'interruptedDigestBatchMatchesAccount', 'startBatchKeepalive', 'renderTextPreviewCard',
    'recoverImageBatchResults', 'batchResultSlot', 'buildRecoveredResultsCard',
    'digestBatchRecoveryList', 'digestBatchPreviewRecovery', 'admitRecoveredBatch',
    'actionAbort',
    `${checkSource}; return checkInterruptedRecovery;`,
  )(
    ui, page, recoveryAction, recoverySlot,
    batchId => (!batchId || shared.markerPresent) ? record : null,
    makeNode, () => null, { document: { activeElement: null, body: {} } },
    action => { if (!recoveryAction.isCurrent(action)) return false; recoveryAction.end(action); return true; },
    () => { shared.markerPresent = false; return true; },
    async () => {}, api,
    (taskId, recover, options) => runner.run(taskId, {
      getIdentity: options.getIdentity,
      signal: options.signal,
      recover,
    }),
    recovery.createDigestRecoveryOwner, () => identity, () => '',
    recovery.interruptedDigestBatchMatchesAccount, () => {}, () => {}, async () => null,
    batchResultSlot, () => makeNode('section'), recovery.digestBatchRecoveryList,
    recovery.digestBatchPreviewRecovery, async recovered => ({ admitted: true, owner: recovered }),
    new AbortController(),
  );
  return {
    page,
    recoverySlot,
    checkInterruptedRecovery,
    recoverButton() {
      return collect(recoverySlot, node => node.tag === 'button'
        && node.textContent === '恢复结果')[0] || null;
    },
  };
}

const storage = new MemoryStorage();
const runnerA = recovery.createInterruptedDigestRecoveryRunner({
  locks: null,
  storage,
  readRecords: () => shared.markerPresent ? [record] : [],
});
const runnerB = recovery.createInterruptedDigestRecoveryRunner({
  locks: null,
  storage,
  readRecords: () => shared.markerPresent ? [record] : [],
});
const tabA = createTab(runnerA);
const tabB = createTab(runnerB);

await tabA.checkInterruptedRecovery();
await tabB.checkInterruptedRecovery();
const recoverA = tabA.recoverButton();
const recoverB = tabB.recoverButton();
assert.ok(recoverA && recoverB, '两个独立 tab 都必须从真实恢复卡片拿到按钮');
assert.equal(recoverA.userClick(), true);
assert.equal(recoverB.userClick(), true);
await Promise.all([recoverA.lastClickPromise, recoverB.lastClickPromise]);

assert.equal(apiCalls, 0,
  '缺少 Web Locks 时必须 fail-closed，不能让两个 tab 同时进入恢复 API');
assert.equal(shared.markerPresent, true, '协调能力不可用时必须保留恢复 marker');
assert.match(tabA.recoverySlot.children[0]?.children?.at(-1)?.textContent || '', /协调|重试/);
assert.match(tabB.recoverySlot.children[0]?.children?.at(-1)?.textContent || '', /协调|重试/);

console.log('web digest cross-tab recovery no-lock tests passed');
