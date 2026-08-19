import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCrossTabTaskRunner } from '../src/web/public/js/shared/cross-tab-task-runner.js';

const source = await readFile(
  new URL('../src/web/public/js/pages/digest/index.js', import.meta.url),
  'utf8',
);

function extractFunction(sourceText, marker) {
  const start = sourceText.indexOf(marker);
  assert.ok(start >= 0, `必须能定位 ${marker}`);
  const signatureEnd = sourceText.indexOf(') {', start);
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

const generationSource = extractFunction(source, 'async function startGeneration(previewText)');
const admissionEnd = generationSource.indexOf('\n    resultSlot.replaceChildren();');
assert.ok(admissionEnd > 0, '必须截取包含跨标签 lease 的生产启动准入阶段');
const admissionSource = `${generationSource.slice(0, admissionEnd)}\n  }`;

function deferred() {
  let resolve;
  const promise = new Promise(nextResolve => { resolve = nextResolve; });
  return { promise, resolve };
}

const locks = (() => {
  const held = new Set();
  return {
    request(name, options, callback) {
      if (options?.ifAvailable && held.has(name)) return Promise.resolve(callback(null));
      held.add(name);
      return Promise.resolve(callback({ name })).finally(() => held.delete(name));
    },
  };
})();
const runner = createCrossTabTaskRunner({ locks, namespace: 'digest-generation' });
const page = {
  generation: 0,
  destroyed: false,
  generationStarting: false,
  activeBatch: null,
  crossTabGenerationLease: null,
  minMessages: 100,
  groupsStatus: 'ready',
  groups: [{ id: 'group-1', name: '群一' }],
  selected: new Set(['group-1']),
};
const accountA = { id: 'account-a', manual_key_account_fingerprint: 'a'.repeat(64) };
const accountB = { id: 'account-b', manual_key_account_fingerprint: 'b'.repeat(64) };
let currentAccount = accountA;
const store = { get: key => key === 'account' ? currentAccount : null };
const taskIdFor = (accountId, fingerprint) => `${accountId}-${fingerprint}`;
page.acquireCrossTabGenerationLease = async (accountId, fingerprint) => {
  const taskId = taskIdFor(accountId, fingerprint);
  const current = page.crossTabGenerationLease;
  if (current) {
    if (current.taskId === taskId) return { acquired: true, reused: true };
    return { acquired: false, busy: true };
  }
  const result = await runner.acquire(taskId, { ifAvailable: true });
  if (result?.acquired === true) page.crossTabGenerationLease = { ...result, taskId };
  return result;
};
page.releaseCrossTabGenerationLease = expectedLease => {
  const lease = page.crossTabGenerationLease;
  if (expectedLease?.reused !== true
    && expectedLease?.release
    && lease?.release !== expectedLease.release) return false;
  page.crossTabGenerationLease = null;
  return lease?.release?.() === true;
};

const confirmA = deferred();
const confirmB = deferred();
const confirmationCalls = [];
const ui = {
  confirmDialog: async () => {
    const next = confirmationCalls.length === 0 ? confirmA : confirmB;
    confirmationCalls.push(next);
    return next.promise;
  },
  toastError() {},
  toastWarn() {},
};
const startGeneration = new Function(
  'page', 'store', 'ui', 'digestInputsLocked', 'accountIdOf', 'accountFingerprintOf',
  'digestGenerationGroupAdmission', 'currentRangeOrError', 'generateBtn', 'previewBtn',
  'root', 'captureActionFocus', 'setGenerationStarting', 'releaseActiveBatch', 'alive',
  'restoreActionFocus', 'forgetCancelledBatchMarker',
  `${admissionSource}; return startGeneration;`,
)(
  page,
  store,
  ui,
  () => page.generationStarting,
  account => account.id,
  account => account.manual_key_account_fingerprint,
  () => ({ allowed: true }),
  () => ({ since: '2026-08-16 00:00:00', until: '2026-08-16 23:59:59' }),
  {},
  {},
  { contains: () => false },
  () => null,
  value => { page.generationStarting = value === true; },
  async () => true,
  token => !page.destroyed && token === page.generation,
  () => {},
  () => false,
);

const startA = startGeneration(false);
for (let index = 0; index < 20 && confirmationCalls.length < 1; index += 1) {
  await Promise.resolve();
}
assert.equal(confirmationCalls.length, 1, 'A 必须从真实 startGeneration 进入确认框并持有 lease');
const leaseA = page.crossTabGenerationLease;
assert.ok(leaseA, 'A 必须持有跨标签 lease');

// 模拟真实账号 subscriber：旧启动代次失效并释放 A，B 随后在自己的
// 确认框中取得新 lease；此时 page.activeBatch 仍为空，正是旧 finally 的
// 无 owner 清理会误释放 B 的窗口。
page.generation = 1;
page.generationStarting = false;
assert.equal(page.releaseCrossTabGenerationLease(), true, '账号换代必须释放 A lease');
currentAccount = accountB;
const startB = startGeneration(false);
for (let index = 0; index < 20 && confirmationCalls.length < 2; index += 1) {
  await Promise.resolve();
}
assert.equal(confirmationCalls.length, 2, 'B 必须在同一真实启动入口取得自己的确认阶段');
const leaseB = page.crossTabGenerationLease;
assert.ok(leaseB, 'B 必须取得新 lease');
assert.notStrictEqual(leaseA, leaseB);

confirmA.resolve(false);
await startA;
assert.strictEqual(
  page.crossTabGenerationLease,
  leaseB,
  'A 的迟到 admission finally 不得释放 B 已取得的跨标签 lease',
);
assert.equal(leaseB.release(), true, '测试结束必须释放 B lease');
page.crossTabGenerationLease = null;
confirmB.resolve(false);
await startB;

console.log('web digest cross-tab generation handoff tests passed');
