import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRecoveryActionState } from '../src/web/public/js/pages/digest/recovery-action-state.js';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

class MemoryStorage {
  #values = new Map();
  getItem(key) { return this.#values.get(String(key)) ?? null; }
  setItem(key, value) { this.#values.set(String(key), String(value)); }
  removeItem(key) { this.#values.delete(String(key)); }
}

globalThis.location = new URL('http://wx-summary.test/#/digest');
globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage();

const browserLoader = createBrowserModuleLoader();
const {
  createDigestRecoveryOwner,
  interruptedDigestBatchMatchesAccount,
  digestBatchRecoveryList,
  digestBatchPreviewRecovery,
  digestTerminalResultRequest,
  requireDigestTerminalResult,
  digestTerminalRecoveryMetadata,
} = await browserLoader
  .load('js/pages/digest/recovery.js');
const { digestBatchCancelConfirmed } = await browserLoader
  .load('js/pages/digest/batch-runner.js');
const digestBatchCancelConfirmedSource = `${digestBatchCancelConfirmed.toString()};`;

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

const source = await readFile(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');
const recoveryStart = source.indexOf('async function recoverImageBatchResults(');
const recoveryEnd = source.indexOf('\n  function buildRecoveredResultsCard', recoveryStart);
const recoverySource = source.slice(recoveryStart, recoveryEnd);
const callerStart = source.indexOf('const recovered = await recoverImageBatchResults(');
const callerEnd = source.indexOf('\n      } catch (error) {', callerStart);
const callerSource = source.slice(callerStart, callerEnd);
const releaseSource = extractFunction(source, 'async function releaseActiveBatch(');
const admissionSource = extractFunction(source, 'async function admitRecoveredBatch(');
const destroySource = extractFunction(source, 'async destroy()');
const cancelSource = extractFunction(source, 'async function cancelGeneration(reason = \'user_cancelled\')');

assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart, '必须存在恢复长图批次的生命周期边界');
assert.match(source, /recoveryOwner = createDigestRecoveryOwner\(\{[\s\S]*?record: currentRecord/,
  '生产恢复页必须把锁定记录绑定到当前恢复 owner,不能只让 helper 被孤立测试引用');
assert.match(source, /recoverImageBatchResults\(lockedRecord, items, \{[\s\S]*?isCurrent: \(\) => recoveryOwner\?\.isCurrent\(\) === true/,
  '生产长图恢复必须把同一 owner 传入每个终态请求');
assert.match(recoverySource,
  /await api\.post\('\/api\/digest-result'[\s\S]*?if \(!ownerIsCurrent\(\)\) return null;/,
  '每次终态请求返回后,页面销毁或账号 owner 变化时必须立即放弃后续状态写入');
assert.match(recoverySource,
  /if \(!ownerIsCurrent\(\)\) return null;[\s\S]*?page\.activeBatch =/,
  '页面销毁或账号 owner 变化后不得重新持有恢复批次或启动心跳');
assert.match(callerSource,
  /const recovered = await recoverImageBatchResults\([\s\S]*?if \(page\.destroyed \|\| !recovered \|\| !recoveryOwner\?\.isCurrent\(\)\) \{[\s\S]*?return;[\s\S]*?\}/,
  '恢复请求返回后必须在提交旧页面 DOM 前再次检查页面与账号 owner 生命周期');
const innerCatchStart = source.indexOf('\n      } catch (error) {', callerStart);
const innerCatchEnd = source.indexOf('\n      }\n    });', innerCatchStart);
assert.ok(innerCatchStart >= 0 && innerCatchEnd > innerCatchStart, '必须能定位长图恢复异常结算边界');
assert.match(
  source.slice(innerCatchStart, innerCatchEnd),
  /\n      \} catch \(error\) \{\s*if \(page\.destroyed\s*\|\| !recoveryAction\.isCurrent\(action\)\s*\|\| \(recoveryOwner && !recoveryOwner\.isCurrent\(\)\)\) \{[\s\S]*?finishRecoveryAction\(/,
  '长图恢复异常返回时,页面销毁或账号/action owner 失效后不得继续写恢复卡片或按钮状态',
);

// 生成流程已经进入 releaseActiveBatch 后,路由卸载仍可能同步进入 destroy。
// 两个真实 caller 必须共享同一 owner 的 finish 等待;页面销毁后未确认的
// owner 不能被旧 release 的 finally 重新放回页面或重启心跳。
{
  const page = {
    destroyed: false,
    generation: 0,
    activeBatch: null,
    progressCleanupTimer: null,
    keepaliveTimer: 'batch-a-keepalive',
    keepaliveLease: { active: true },
    running: false,
    abortController: new AbortController(),
    draftSaveTimer: null,
    onBeforeUnload() {},
    onKeydown() {},
  };
  const owner = {
    batch: { batch_id: 'release-destroy-race' },
  };
  let resolveFinish;
  const finishPending = new Promise(resolve => { resolveFinish = resolve; });
  let finishCalls = 0;
  owner.finish = async () => {
    finishCalls += 1;
    return finishPending;
  };
  page.activeBatch = owner;
  let stopKeepaliveCalls = 0;
  let startKeepaliveCalls = 0;
  const releaseActiveBatch = new Function(
    'page',
    'stopBatchKeepalive',
    'startBatchKeepalive',
    'digestBatchFinishConfirmed',
    releaseSource + '; return releaseActiveBatch;',
  )(
    page,
    () => {
      stopKeepaliveCalls += 1;
      if (page.keepaliveLease) page.keepaliveLease.active = false;
      page.keepaliveTimer = null;
    },
    () => { startKeepaliveCalls += 1; },
    value => value?.ok === true && value?.settled === true && value?.pending !== true,
  );
  const guard = () => '';
  const store = {
    get(key) { return key === 'accountSwitchGuard' ? guard : null; },
    set() {},
  };
  const lifecycle = () => ({ invalidate() {}, dispose() {} });
  const actionAbort = new AbortController();
  const clearProgressCleanupTimer = new Function(
    'page',
    'clearTimeout',
    `${extractFunction(source, 'function clearProgressCleanupTimer()')}; return clearProgressCleanupTimer;`,
  )(page, () => {});
  const destroy = new Function(
    'page',
    'store',
    'accountSwitchGuard',
    'resultOperation',
    'recoveryAction',
    'resultRenderState',
    'taskScope',
    'groupLoadScope',
    'accountContextRefresh',
    'settingsDerived',
    'invalidateTextPreviewAction',
    'window',
    'actionAbort',
    'clearProgressCleanupTimer',
    'document',
    'clipboardPermission',
    'closePageModals',
    'api',
    'cancelDigestBatch',
    'releaseActiveBatch',
    'forgetInterruptedDigestBatch',
    'saveDraft',
    `${digestBatchCancelConfirmedSource} return ({ ${destroySource} }).destroy;`,
  )(
    page,
    store,
    guard,
    lifecycle(),
    lifecycle(),
    lifecycle(),
    lifecycle(),
    lifecycle(),
    lifecycle(),
    lifecycle(),
    () => {},
    { removeEventListener() {} },
    actionAbort,
    clearProgressCleanupTimer,
    { removeEventListener() {} },
    { dispose() {} },
    () => {},
    {},
    async () => { throw new Error('running batch cancellation must not be used in this fixture'); },
    releaseActiveBatch,
    () => {},
    () => {},
  );

  const releasePromise = releaseActiveBatch({ owner });
  await Promise.resolve();
  assert.equal(finishCalls, 1, '生成 caller 必须真实启动一次 A finish');
  assert.strictEqual(page.activeBatch, owner,
    'finish 未确认前 owner 不能从页面状态丢失');

  const destroyPromise = destroy();
  let destroySettled = false;
  destroyPromise.then(() => { destroySettled = true; });
  await Promise.resolve();
  assert.equal(destroySettled, false,
    '卸载 caller 必须等待同一 A finish 完成,不能看到空槽后提前结束');
  assert.equal(finishCalls, 1, '生成与卸载 caller 必须共享同一个 A finish');

  resolveFinish({ ok: true, settled: false, pending: true, released: false });
  await releasePromise;
  await destroyPromise;
  assert.equal(page.destroyed, true, '页面卸载必须完成');
  assert.equal(page.activeBatch, null,
    '页面已销毁且 finish 未确认时不得复活 A owner');
  assert.equal(page.activeBatchRelease, null,
    '同一 owner 的 release promise 收尾后必须释放页面级 lease');
  assert.equal(startKeepaliveCalls, 0,
    '页面已销毁且 finish 未确认时不得重启 A 心跳');
  assert.equal(stopKeepaliveCalls, 1, '共享 owner release 只能停止一次 A 心跳');
}

// 真实恢复按钮在页面已有 active batch 时仍然可达: recovery card 的生产
// handler 不经过 accountSwitchGuard。恢复 B 不能直接覆盖 A 的 lease owner。
{
  const checkSource = extractFunction(source, 'async function checkInterruptedRecovery()');
  const nodes = [];
  const makeNode = (tag = 'div', className = '', text = '') => {
    const node = {
      tag,
      className,
      textContent: text,
      children: [],
      listeners: new Map(),
      disabled: false,
      isConnected: true,
      append(...children) { this.children.push(...children.filter(Boolean)); },
      appendChild(child) { if (child) this.children.push(child); return child; },
      replaceChildren(...children) { this.children = children.filter(Boolean); },
      addEventListener(type, listener) { this.listeners.set(type, listener); },
      setAttribute() {},
      removeAttribute() {},
    };
    nodes.push(node);
    return node;
  };
  let resolvePendingFinish;
  const pendingFinish = new Promise(resolve => { resolvePendingFinish = resolve; });
  const finishResults = [
    pendingFinish,
    { ok: true, settled: true, pending: false, released: false },
  ];
  let finishCalls = 0;
  const activeA = {
    batch: { batch_id: 'active-a', batch_token: 'active-token-a' },
    finish: async () => {
      finishCalls += 1;
      return finishResults.shift();
    },
  };
  const recordB = {
    batch_id: 'recovery-b',
    batch_token: 'recovery-token-b',
    service_instance_id: 'service-test',
    account_id: 'account-test',
    account_fingerprint: 'a'.repeat(64),
    batch_total: 1,
    preview_text: true,
    targets: [{ group_id: 'group-b', group_name: 'group-b' }],
  };
  const page = {
    destroyed: false,
    activeBatch: activeA,
    activeBatchRelease: null,
    previewDigests: [],
    previewMarkdown: '',
  };
  const recoveryPageAbort = new AbortController();
  let recoveredFinishSignal = null;
  let resolveRecoveredFinish;
  const recoveredFinishPending = new Promise(resolve => {
    resolveRecoveredFinish = resolve;
  });
  const recoveryAction = createRecoveryActionState();
  const recoverySlot = makeNode();
  const batchResultSlot = makeNode();
  const releaseActiveBatch = new Function(
    'page',
    'stopBatchKeepalive',
    'startBatchKeepalive',
    'digestBatchFinishConfirmed',
    releaseSource + '; return releaseActiveBatch;',
  )(
    page,
    () => {},
    () => {},
    value => value?.ok === true && value?.settled === true && value?.pending !== true,
  );
  const admitRecoveredBatch = new Function(
    'page',
    'releaseActiveBatch',
    'startBatchKeepalive',
    admissionSource + '; return admitRecoveredBatch;',
  )(page, releaseActiveBatch, () => {});
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
    'ui',
    'recoverImageBatchResults',
    'batchResultSlot',
    'buildRecoveredResultsCard',
    'digestBatchRecoveryList',
    'digestBatchPreviewRecovery',
    'admitRecoveredBatch',
    'actionAbort',
    `${digestBatchCancelConfirmedSource} ${checkSource}; return checkInterruptedRecovery;`,
  )(
    page,
    recoveryAction,
    recoverySlot,
    () => recordB,
    makeNode,
    () => null,
    { document: { activeElement: null } },
    action => {
      recoveryAction.end(action);
      return true;
    },
    () => true,
    async () => {},
    {
      async post(path, body, options = {}) {
        if (path === '/api/digest-batch-preview') {
          return {
            ok: true,
            status: 'done',
            pending: false,
            digests: [{ group_name: 'group-b', markdown: 'B' }],
          };
        }
        assert.equal(path, '/api/digest-batch-finish');
        recoveredFinishSignal = options.signal || null;
        return recoveredFinishPending;
      },
      getServiceInstanceId() { return 'service-test'; },
    },
    async (_batchId, recover) => ({ ran: true, value: await recover(recordB) }),
    () => ({ isCurrent: () => true }),
    () => ({ account_id: recordB.account_id, account_fingerprint: recordB.account_fingerprint }),
    () => 'B',
    () => true,
    () => {},
    () => {},
    { toastSuccess() {} },
    async () => { throw new Error('image recovery is not used by this preview fixture'); },
    batchResultSlot,
    () => makeNode('section'),
    digestBatchRecoveryList,
    digestBatchPreviewRecovery,
    admitRecoveredBatch,
    recoveryPageAbort,
  );

  page.accountContextBlocked = true;
  await checkInterruptedRecovery();
  assert.equal(recoverySlot.children.length, 0,
    '账号上下文 blocked 时不得重新挂出恢复卡片或允许恢复目标账号');
  page.accountContextBlocked = false;
  await checkInterruptedRecovery();
  const recoverBtn = nodes.find(node => node.tag === 'button' && node.textContent === '恢复结果');
  assert.ok(recoverBtn, '已有 active batch 时恢复卡片仍必须走真实按钮 handler');
  const status = nodes.find(node => node.className === 'result-status muted');
  const firstRecover = recoverBtn.listeners.get('click')();
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  assert.equal(finishCalls, 1, '恢复 B 前必须先尝试确认 A 的服务端收尾');
  assert.strictEqual(page.activeBatch, activeA,
    'A finish 未确认期间恢复 B 不得覆盖 A');
  let firstRecoverSettled = false;
  firstRecover.then(() => { firstRecoverSettled = true; });
  await Promise.resolve();
  assert.equal(firstRecoverSettled, false, '恢复 B 必须等待 A finish 的结果');
  resolvePendingFinish({ ok: true, settled: false, pending: true, released: false });
  await firstRecover;
  assert.strictEqual(page.activeBatch, activeA,
    'A finish 返回 pending 时恢复 B 必须保留 A 并允许重试');
  assert.match(status.textContent, /收尾|重试/, 'A 未确认时必须给出可操作重试提示');
  assert.equal(recoverBtn.disabled, false, 'A 未确认时恢复按钮必须重新可用');

  await recoverBtn.listeners.get('click')();
  assert.equal(finishCalls, 2, '重试恢复必须再次确认 A 的 finish');
  assert.notStrictEqual(page.activeBatch, activeA,
    '只有 A finish 确认成功后恢复 B 才能接管 active owner');
  assert.equal(page.activeBatch?.batch?.batch_id, recordB.batch_id,
    '确认成功后必须安装恢复批次 B');
  const recoveredOwner = page.activeBatch;
  const releaseRecovered = releaseActiveBatch({ owner: recoveredOwner });
  await Promise.resolve();
  assert.strictEqual(recoveredFinishSignal, recoveryPageAbort.signal,
    '文本恢复 owner 的 finish 请求必须绑定页面级 AbortSignal');
  recoveryPageAbort.abort(new Error('页面已卸载'));
  resolveRecoveredFinish({ ok: true, settled: true, pending: false, released: false });
  await releaseRecovered;
}

// 长图恢复 caller 也必须经过同一 admission: A 的 finish 返回 pending/null
// 时不能安装 B,只有明确 settled 才能让 B 接管。
{
  const page = {
    destroyed: false,
    activeBatch: null,
    activeBatchRelease: null,
    renderOptions: { theme: 'auto', fontSize: 'normal' },
    generationRender: null,
    savedItems: new Map(),
  };
  let resolvePendingFinish;
  const pendingFinish = new Promise(resolve => { resolvePendingFinish = resolve; });
  const finishResults = [
    pendingFinish,
    null,
    { ok: true, settled: true, pending: false, released: false },
  ];
  let finishCalls = 0;
  const activeA = {
    batch: { batch_id: 'image-active-a', batch_token: 'image-active-token-a' },
    finish: async () => {
      finishCalls += 1;
      return finishResults.shift();
    },
  };
  page.activeBatch = activeA;
  const releaseActiveBatch = new Function(
    'page',
    'stopBatchKeepalive',
    'startBatchKeepalive',
    'digestBatchFinishConfirmed',
    releaseSource + '; return releaseActiveBatch;',
  )(
    page,
    () => {},
    () => {},
    value => value?.ok === true && value?.settled === true && value?.pending !== true,
  );
  const admitRecoveredBatch = new Function(
    'page',
    'releaseActiveBatch',
    'startBatchKeepalive',
    admissionSource + '; return admitRecoveredBatch;',
  )(page, releaseActiveBatch, () => {});
  const finishController = new AbortController();
  let finishRequestSignal = null;
  let resolveRecoveredFinish;
  const recoveredFinishPending = new Promise(resolve => { resolveRecoveredFinish = resolve; });
  const recoverImageBatchResults = new Function(
    'page',
    'api',
    'interruptedDigestRenderSelection',
    'requireDigestTerminalResult',
    'digestTerminalRecoveryMetadata',
    'digestTerminalResultRequest',
    'showImageResults',
    'admitRecoveredBatch',
    'releaseActiveBatch',
    'actionAbort',
    recoverySource + '; return recoverImageBatchResults;',
  )(
    page,
    {
      async post(path, body, options = {}) {
        if (path === '/api/digest-result') {
          return { status: 'done', digest: { markdown: 'B' } };
        }
        assert.equal(path, '/api/digest-batch-finish');
        finishRequestSignal = options.signal || null;
        return recoveredFinishPending;
      },
      getServiceInstanceId() { return 'service-test'; },
    },
    () => ({ theme: 'auto', fontSize: 'normal' }),
    value => value,
    digestTerminalRecoveryMetadata,
    () => ({}),
    async () => {},
    admitRecoveredBatch,
    releaseActiveBatch,
    finishController,
  );
  const recordB = {
    batch_id: 'image-recovery-b',
    batch_token: 'image-recovery-token-b',
    service_instance_id: 'service-test',
    targets: [{ group_id: 'group-b', group_name: 'group-b' }],
  };
  const items = [{
    status: 'done',
    batch_index: 0,
    group_id: 'group-b',
    group_name: 'group-b',
  }];

  const firstRecover = recoverImageBatchResults(recordB, items, { isCurrent: () => true });
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  assert.equal(finishCalls, 1, '长图恢复安装 B 前必须先确认 A 的 finish');
  assert.strictEqual(page.activeBatch, activeA, '长图 A finish 未返回前不得覆盖 A');
  resolvePendingFinish({ ok: true, settled: false, pending: true, released: false });
  const firstResult = await firstRecover;
  assert.deepEqual(firstResult, { blocked: true }, '长图 pending finish 必须返回可重试阻断结果');
  assert.strictEqual(page.activeBatch, activeA, '长图 pending finish 后必须保留 A');

  const secondResult = await recoverImageBatchResults(recordB, items, { isCurrent: () => true });
  assert.deepEqual(secondResult, { blocked: true }, '长图 null finish 必须返回可重试阻断结果');
  assert.equal(finishCalls, 2, '长图重试必须再次确认 A 的 finish');
  assert.strictEqual(page.activeBatch, activeA, '长图 null finish 后仍不得覆盖 A');

  const thirdResult = await recoverImageBatchResults(recordB, items, { isCurrent: () => true });
  assert.equal(finishCalls, 3, '长图确认成功前不得跳过 A 的第三次 finish');
  assert.equal(page.activeBatch?.batch?.batch_id, recordB.batch_id,
    '长图仅在 A finish 确认成功后才允许安装 B');
  assert.equal(thirdResult.results.length, 1, '长图确认成功后必须返回恢复结果');

  const recoveredOwner = page.activeBatch;
  const releaseRecovered = releaseActiveBatch({ owner: recoveredOwner });
  await Promise.resolve();
  assert.strictEqual(finishRequestSignal, finishController.signal,
    '恢复 owner 的 finish 请求必须绑定页面级 AbortSignal');
  finishController.abort(new Error('页面已卸载'));
  resolveRecoveredFinish({ ok: true, settled: true, pending: false, released: false });
  await releaseRecovered;
}

// 同 lease 的 active owner 可能来自 generation 的 onBatchCreated,当时还没有
// finish。恢复结果不得替换 owner identity,但必须把可用的 finish/结果能力补回,
// 否则后续 release 会静默跳过服务端收尾。
{
  const page = {
    destroyed: false,
    activeBatch: null,
    activeBatchRelease: null,
  };
  const releaseCalls = [];
  const finishResults = [
    { ok: true, settled: false, pending: true, released: false },
    new Error('恢复 finish 暂时失败'),
    { ok: true, settled: true, pending: false, released: false },
  ];
  const activeA = {
    batch: { batch_id: 'same-lease', batch_token: 'same-token' },
    finish: null,
    results: [],
    previewText: false,
  };
  const recoveredFinish = async () => {
    releaseCalls.push('finish');
    const result = finishResults.shift();
    if (result instanceof Error) throw result;
    return result;
  };
  const recoveredOwner = {
    batch: { batch_id: 'same-lease', batch_token: 'same-token' },
    finish: recoveredFinish,
    results: [{ digest_id: 'recovered-result' }],
    previewText: true,
  };
  page.activeBatch = activeA;
  const releaseActiveBatch = new Function(
    'page',
    'stopBatchKeepalive',
    'startBatchKeepalive',
    'digestBatchFinishConfirmed',
    releaseSource + '; return releaseActiveBatch;',
  )(
    page,
    () => {},
    () => {},
    value => value?.ok === true && value?.settled === true && value?.pending !== true,
  );
  const admitRecoveredBatch = new Function(
    'page',
    'releaseActiveBatch',
    'startBatchKeepalive',
    admissionSource + '; return admitRecoveredBatch;',
  )(page, releaseActiveBatch, () => {});

  const admission = await admitRecoveredBatch(recoveredOwner);
  assert.equal(admission.admitted, true, '同 lease 恢复必须允许复用原 owner');
  assert.strictEqual(admission.owner, activeA, '同 lease 恢复不得替换原 owner identity');
  assert.strictEqual(activeA.finish, recoveredFinish,
    '同 lease 恢复必须把缺失的 finish 能力补回原 owner');
  assert.deepEqual(activeA.results, recoveredOwner.results,
    '同 lease 恢复必须把可用结果补回原 owner');
  assert.equal(activeA.previewText, true, '同 lease 恢复必须更新恢复模式');

  assert.equal(await releaseActiveBatch({ owner: activeA }), false,
    '同 lease 恢复的 pending finish 不得清除 owner');
  assert.strictEqual(page.activeBatch, activeA, 'pending finish 后 owner 必须保留可重试');
  await assert.rejects(
    releaseActiveBatch({ owner: activeA }),
    /恢复 finish 暂时失败/,
    '同 lease 恢复的 finish 异常必须透出给 caller');
  assert.strictEqual(page.activeBatch, activeA, 'finish 异常后 owner 必须保留可重试');
  assert.equal(await releaseActiveBatch({ owner: activeA }), true,
    '同 lease 恢复 finish 确认后必须允许清理 owner');
  assert.equal(page.activeBatch, null, '确认成功后才允许清除同 lease owner');
  assert.deepEqual(releaseCalls, ['finish', 'finish', 'finish'],
    '同 lease 恢复必须每次重试都调用实际 finish');
}

// 旧 owner 的 release Promise reject 不能从 admission 冒泡成不可操作错误;
// 恢复按钮必须得到统一 blocked/retryable 结果。
{
  const page = {
    destroyed: false,
    activeBatch: { batch: { batch_id: 'release-reject', batch_token: 'token' } },
    activeBatchRelease: null,
  };
  const releaseActiveBatch = async () => false;
  const admitRecoveredBatch = new Function(
    'page',
    'releaseActiveBatch',
    'startBatchKeepalive',
    admissionSource + '; return admitRecoveredBatch;',
  )(
    page,
    releaseActiveBatch,
    () => {},
  );
  const pendingRelease = Promise.reject(new Error('旧 owner finish 失败'));
  page.activeBatchRelease = {
    owner: page.activeBatch,
    promise: pendingRelease,
  };
  const result = await admitRecoveredBatch({
    batch: { batch_id: 'new-recovery', batch_token: 'new-token' },
  });
  assert.deepEqual(result, { admitted: false, blocked: true },
    '旧 release reject 必须转换为统一 blocked 结果');
}

// 直接执行生产 destroy:页面卸载时服务端取消未确认,不能先忘记本地恢复 marker。
// 只有明确收到 { ok: true, lease_released: true } 才允许删除;
// 否则下次页面仍须可恢复/重试。
function createDestroyHarness(cancelDigestBatch) {
  const calls = {
    cancel: 0,
    forgotten: 0,
    released: 0,
    saved: 0,
  };
  const guard = () => '';
  const page = {
    destroyed: false,
    generation: 0,
    activeBatch: { batch: { batch_id: 'destroy-batch' } },
    progressCleanupTimer: null,
    running: true,
    abortController: new AbortController(),
    draftSaveTimer: null,
    onBeforeUnload() {},
    onKeydown() {},
  };
  const store = {
    get(key) { return key === 'accountSwitchGuard' ? guard : null; },
    set() {},
  };
  const lifecycle = () => ({
    invalidate() {},
    dispose() {},
  });
  const actionAbort = new AbortController();
  const clearProgressCleanupTimer = new Function(
    'page',
    'clearTimeout',
    `${extractFunction(source, 'function clearProgressCleanupTimer()')}; return clearProgressCleanupTimer;`,
  )(page, () => {});
  const destroy = new Function(
    'page',
    'store',
    'accountSwitchGuard',
    'resultOperation',
    'recoveryAction',
    'resultRenderState',
    'taskScope',
    'groupLoadScope',
    'accountContextRefresh',
    'settingsDerived',
    'invalidateTextPreviewAction',
    'window',
    'actionAbort',
    'clearProgressCleanupTimer',
    'document',
    'clipboardPermission',
    'closePageModals',
    'api',
    'cancelDigestBatch',
    'releaseActiveBatch',
    'forgetInterruptedDigestBatch',
    'saveDraft',
    `${digestBatchCancelConfirmedSource} return ({ ${destroySource} }).destroy;`,
  )(
    page,
    store,
    guard,
    lifecycle(),
    lifecycle(),
    lifecycle(),
    lifecycle(),
    lifecycle(),
    lifecycle(),
    lifecycle(),
    () => {},
    { removeEventListener() {} },
    actionAbort,
    clearProgressCleanupTimer,
    { removeEventListener() {} },
    { dispose() {} },
    () => {},
    {},
    async (...args) => {
      calls.cancel += 1;
      return cancelDigestBatch(...args);
    },
    async () => { calls.released += 1; },
    () => { calls.forgotten += 1; },
    () => { calls.saved += 1; },
  );
  return { page, calls, destroy: () => destroy() };
}

// 生成刚收到 onBatchCreated 时，生产会安装 cancelOnly owner；路由离开守卫
// 已经发过一次取消后，随后 router 仍会调用页面 destroy。destroy 必须复用
// 这个 owner 的 finish，而不能再对同一批次直接发第二次取消。
function createDestroyCancelOnlyOwnerHarness() {
  const calls = { cancel: 0, forgotten: 0 };
  const batch = {
    batch_id: 'destroy-cancel-only-batch',
    batch_token: 'destroy-cancel-only-token',
    service_instance_id: 'destroy-cancel-only-service',
  };
  const page = {
    destroyed: false,
    generation: 0,
    activeBatch: null,
    progressCleanupTimer: null,
    running: true,
    abortController: new AbortController(),
    draftSaveTimer: null,
    onBeforeUnload() {},
    onKeydown() {},
    keepaliveTimer: null,
    keepaliveLease: null,
    activeBatchRelease: null,
    crossTabGenerationLease: null,
  };
  const cancel = async () => {
    calls.cancel += 1;
    return { ok: true, settled: true, pending: false, released: true, lease_released: true };
  };
  const forgetMarker = () => {
    calls.forgotten += 1;
    return true;
  };
  page.activeBatch = {
    batch,
    cancelOnly: true,
    cancelConfirmed: false,
    cancelMarkerForgotten: false,
    finish: async () => {
      if (page.activeBatch?.cancelConfirmed === true) {
        return { ok: true, settled: true, pending: false };
      }
      const response = await cancel();
      if (!digestBatchCancelConfirmed(response)) return null;
      return { ...response, settled: true, pending: false };
    },
  };
  const productionReleaseActiveBatch = new Function(
    'page',
    'stopBatchKeepalive',
    'startBatchKeepalive',
    'digestBatchFinishConfirmed',
    `${releaseSource}; return releaseActiveBatch;`,
  )(
    page,
    () => {},
    () => {},
    value => value?.ok === true && value?.settled === true && value?.pending !== true,
  );
  const releaseActiveBatch = async (...args) => {
    const result = await productionReleaseActiveBatch(...args);
    page.releaseResult = result;
    return result;
  };
  const guard = () => '';
  const store = {
    get(key) { return key === 'accountSwitchGuard' ? guard : null; },
    set() {},
  };
  const lifecycle = () => ({ invalidate() {}, dispose() {} });
  const actionAbort = new AbortController();
  const cancelGeneration = new Function(
    'page',
    'ui',
    'api',
    'cancelDigestBatch',
    'digestBatchCancelConfirmed',
    'forgetInterruptedDigestBatch',
    `${cancelSource}; return cancelGeneration;`,
  )(
    page,
    { toastWarn() {} },
    {},
    cancel,
    digestBatchCancelConfirmed,
    forgetMarker,
  );
  const clearProgressCleanupTimer = new Function(
    'page',
    'clearTimeout',
    `${extractFunction(source, 'function clearProgressCleanupTimer()')}; return clearProgressCleanupTimer;`,
  )(page, () => {});
  const destroy = new Function(
    'page',
    'store',
    'accountSwitchGuard',
    'resultOperation',
    'recoveryAction',
    'resultRenderState',
    'taskScope',
    'groupLoadScope',
    'accountContextRefresh',
    'settingsDerived',
    'invalidateTextPreviewAction',
    'window',
    'actionAbort',
    'clearProgressCleanupTimer',
    'document',
    'clipboardPermission',
    'closePageModals',
    'api',
    'cancelDigestBatch',
    'releaseActiveBatch',
    'forgetInterruptedDigestBatch',
    'saveDraft',
    `${digestBatchCancelConfirmedSource} return ({ ${destroySource} }).destroy;`,
  )(
    page,
    store,
    guard,
    lifecycle(),
    lifecycle(),
    lifecycle(),
    lifecycle(),
    lifecycle(),
    lifecycle(),
    lifecycle(),
    () => {},
    { removeEventListener() {} },
    actionAbort,
    clearProgressCleanupTimer,
    { removeEventListener() {} },
    { dispose() {} },
    () => {},
    {},
    cancel,
    releaseActiveBatch,
    forgetMarker,
    () => {},
  );
  return { page, calls, cancelGeneration, destroy: () => destroy() };
}

{
  let resolveCancel;
  const cancelPending = new Promise(resolve => { resolveCancel = resolve; });
  const harness = createDestroyHarness(() => cancelPending);
  const pendingDestroy = harness.destroy();
  await Promise.resolve();
  assert.equal(harness.calls.forgotten, 0,
    '页面卸载时取消 Promise 挂起不得删除本地恢复 marker');
  resolveCancel(null);
  await pendingDestroy;
  assert.equal(harness.calls.cancel, 1);
  assert.equal(harness.calls.forgotten, 0,
    '页面卸载时取消未明确成功不得删除本地恢复 marker');
}

{
  const harness = createDestroyHarness(() => ({ ok: true, lease_released: true }));
  await harness.destroy();
  assert.equal(harness.calls.cancel, 1);
  assert.equal(harness.calls.forgotten, 1,
    '页面卸载收到服务端明确成功后才允许删除本地恢复 marker');
}

{
  const harness = createDestroyCancelOnlyOwnerHarness();
  await harness.cancelGeneration('navigate_away');
  await harness.destroy();
  assert.equal(harness.calls.cancel, 1,
    '路由离开守卫与 destroy 必须共享 cancelOnly owner 的收尾，不得重复取消同一批次');
  assert.equal(harness.page.activeBatch, null,
    'cancelOnly owner 取消确认后必须释放页面 owner');
  assert.equal(harness.calls.forgotten, 1,
    'cancelOnly owner 取消确认后必须清理对应恢复 marker');
}

// 直接执行生产 checkInterruptedRecovery 的“恢复结果”按钮回调。
// 后端 pending=true 时明确还没有终态 items，不能被误判为永久空态并删除恢复记录；
// 畸形 items 也必须保留记录并进入可重试错误态。
for (const scenario of [
  {
    label: '恢复记录读取失败',
    readerError: Object.assign(new Error('本地恢复记录不可用'), {
      code: 'digest_recovery_storage_unavailable',
      status: 507,
    }),
    statusPattern: /读取|存储|重试/,
  },
  {
    label: '终态仍在结算',
    previewText: false,
    payload: { ok: true, status: 'pending', pending: true, items: [] },
    statusPattern: /仍在|稍后|重试/,
  },
  {
    label: '恢复清单响应畸形',
    previewText: false,
    payload: { ok: true, status: 'settled', pending: false, items: null },
    statusPattern: /恢复失败|响应格式/,
  },
  {
    label: '文本预览仍在结算',
    previewText: true,
    payload: { ok: true, status: 'pending', pending: true },
    statusPattern: /仍在|稍后|重试/,
  },
  {
    label: '文本预览响应畸形',
    previewText: true,
    payload: { ok: true, status: 'done', pending: false, digests: null },
    statusPattern: /恢复失败|响应格式/,
  },
  {
    label: '文本预览终态恢复记录未持久化',
    previewText: true,
    payload: {
      ok: true,
      status: 'done',
      pending: false,
      terminal_recovery_persisted: false,
      terminal_recovery_code: 'digest_terminal_persist_failed',
      digests: [{ digest_id: 'preview-terminal-unpersisted', group_name: 'group-test' }],
    },
    statusPattern: /持久化|重启|恢复/,
  },
]) {
  const checkSource = extractFunction(source, 'async function checkInterruptedRecovery()');
  const record = {
    batch_id: `batch-${scenario.label}`,
    batch_token: 'batch-token-123456789',
    service_instance_id: 'service-test',
    account_id: 'account-test',
    account_fingerprint: 'a'.repeat(64),
    batch_total: 1,
    preview_text: scenario.previewText,
    targets: [{ group_id: 'group-test' }],
  };
  const nodes = [];
  const makeNode = (tag, className = '', text = '') => {
    const node = {
      tag,
      className,
      textContent: text,
      children: [],
      listeners: new Map(),
      attributes: new Map(),
      disabled: false,
      isConnected: true,
      append(...children) { this.children.push(...children.filter(Boolean)); },
      appendChild(child) { if (child) this.children.push(child); return child; },
      replaceChildren(...children) { this.children = children.filter(Boolean); },
      addEventListener(type, listener) { this.listeners.set(type, listener); },
      setAttribute(name, value) { this.attributes.set(name, String(value)); },
      removeAttribute(name) { this.attributes.delete(name); },
    };
    nodes.push(node);
    return node;
  };
  const recoverySlot = makeNode('div', 'recovery-slot');
  const batchResultSlot = makeNode('div', 'batch-slot');
  const recoveryAction = createRecoveryActionState();
  let forgotten = 0;
  let finished = 0;
  const page = { destroyed: false };
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
    'ui',
    'recoverImageBatchResults',
    'batchResultSlot',
    'buildRecoveredResultsCard',
    'digestBatchRecoveryList',
    'digestBatchPreviewRecovery',
    'admitRecoveredBatch',
    `${digestBatchCancelConfirmedSource} ${checkSource}; return checkInterruptedRecovery;`,
  )(
    page,
    recoveryAction,
    recoverySlot,
    () => {
      if (scenario.readerError) throw scenario.readerError;
      return record;
    },
    makeNode,
    () => null,
    { document: { activeElement: null } },
    action => {
      if (!recoveryAction.isCurrent(action)) return false;
      recoveryAction.end(action);
      finished += 1;
      return true;
    },
    () => { forgotten += 1; return true; },
    async () => {},
    {
      async post(path) {
        assert.equal(path, scenario.previewText
          ? '/api/digest-batch-preview'
          : '/api/digest-batch-results');
        return scenario.payload;
      },
      getServiceInstanceId() { return 'service-test'; },
    },
    async (_batchId, recover) => ({ ran: true, value: await recover(record) }),
    () => ({ isCurrent: () => true }),
    () => ({ account_id: record.account_id, account_fingerprint: record.account_fingerprint }),
    () => '',
    () => true,
    () => {},
    () => {},
    { toastSuccess() {} },
    async () => { throw new Error('pending/畸形清单不得进入逐项恢复'); },
    batchResultSlot,
    () => makeNode('section'),
    digestBatchRecoveryList,
    digestBatchPreviewRecovery,
    async recovered => ({ admitted: true, owner: recovered }),
  );

  await checkInterruptedRecovery();
  if (scenario.readerError) {
    assert.equal(recoverySlot.children.length, 1,
      `${scenario.label}: 读取失败必须留下可操作提示而不是空白恢复区`);
    assert.match(recoverySlot.children[0].textContent || '', scenario.statusPattern,
      `${scenario.label}: 读取失败必须显示存储/重试提示`);
    continue;
  }
  const recoverBtn = nodes.find(node => node.tag === 'button' && node.textContent === '恢复结果');
  const discardBtn = nodes.find(node => node.tag === 'button' && node.textContent === '放弃并取消');
  const status = nodes.find(node => node.className === 'result-status muted');
  assert.ok(recoverBtn && discardBtn && status, `${scenario.label}: 必须渲染完整恢复卡片`);
  await recoverBtn.listeners.get('click')();
  assert.equal(forgotten, 0, `${scenario.label}: 可重试响应不得删除中断恢复记录`);
  assert.match(status.textContent, scenario.statusPattern, `${scenario.label}: 必须显示可操作状态`);
  assert.equal(recoverBtn.disabled, false, `${scenario.label}: 恢复按钮必须重新可用`);
  assert.equal(discardBtn.disabled, false, `${scenario.label}: 放弃按钮必须重新可用`);
  assert.equal(finished, 1, `${scenario.label}: 恢复 action lease 必须恰好释放一次`);
}

// 终态结果可以在当前连接可读取,但服务端恢复记录未持久化时返回。
// 这与普通成功不同:页面可以展示结果,但不能删除本地 marker,否则刷新或服务重启
// 后唯一的恢复证据会消失。必须沿真实恢复按钮 caller 保留卡片并允许重试。
{
  const checkSource = extractFunction(source, 'async function checkInterruptedRecovery()');
  const recoverSource = extractFunction(source, 'async function recoverImageBatchResults(');
  const record = {
    batch_id: 'batch-terminal-recovery-unpersisted',
    batch_token: 'batch-token-terminal-unpersisted-123456789',
    service_instance_id: 'service-test',
    account_id: 'account-test',
    account_fingerprint: 'a'.repeat(64),
    batch_total: 1,
    preview_text: false,
    targets: [{ group_id: 'group-test', group_name: 'group-test' }],
  };
  const terminal = {
    status: 'done',
    digest: { digest_id: 'digest-terminal-unpersisted' },
    terminal_recovery_persisted: false,
    terminal_recovery_code: 'digest_terminal_persist_failed',
  };
  const nodes = [];
  const makeNode = (tag, className = '', text = '') => {
    const node = {
      tag,
      className,
      textContent: text,
      children: [],
      listeners: new Map(),
      attributes: new Map(),
      disabled: false,
      isConnected: true,
      append(...children) { this.children.push(...children.filter(Boolean)); },
      appendChild(child) { if (child) this.children.push(child); return child; },
      replaceChildren(...children) { this.children = children.filter(Boolean); },
      addEventListener(type, listener) { this.listeners.set(type, listener); },
      setAttribute(name, value) { this.attributes.set(name, String(value)); },
      removeAttribute(name) { this.attributes.delete(name); },
    };
    nodes.push(node);
    return node;
  };
  const recoverySlot = makeNode('div', 'recovery-slot');
  const batchResultSlot = makeNode('div', 'batch-slot');
  const recoveryAction = createRecoveryActionState();
  const page = {
    destroyed: false,
    activeBatch: null,
    activeBatchRelease: null,
    renderOptions: { theme: 'auto', fontSize: 'normal' },
    generationRender: null,
    savedItems: new Map(),
  };
  let forgotten = 0;
  let finished = 0;
  const actionAbort = new AbortController();
  const api = {
    async post(path) {
      if (path === '/api/digest-batch-results') {
        return {
          ok: true,
          status: 'settled',
          pending: false,
          items: [{
            status: 'done',
            batch_index: 0,
            group_id: 'group-test',
          }],
        };
      }
      if (path === '/api/digest-result') return terminal;
      throw new Error(`unexpected recovery path: ${path}`);
    },
    getServiceInstanceId() { return 'service-test'; },
  };
  const admitRecoveredBatch = async recovered => {
    page.activeBatch = recovered;
    return { admitted: true, owner: recovered };
  };
  const recoverImageBatchResults = new Function(
    'page',
    'api',
    'interruptedDigestRenderSelection',
    'requireDigestTerminalResult',
    'digestTerminalRecoveryMetadata',
    'digestTerminalResultRequest',
    'showImageResults',
    'admitRecoveredBatch',
    'releaseActiveBatch',
    'actionAbort',
    `${recoverSource}; return recoverImageBatchResults;`,
  )(
    page,
    api,
    () => ({ theme: 'auto', fontSize: 'normal' }),
    requireDigestTerminalResult,
    digestTerminalRecoveryMetadata,
    digestTerminalResultRequest,
    async () => {},
    admitRecoveredBatch,
    async () => null,
    actionAbort,
  );
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
    'ui',
    'recoverImageBatchResults',
    'batchResultSlot',
    'buildRecoveredResultsCard',
    'digestBatchRecoveryList',
    'digestBatchPreviewRecovery',
    'actionAbort',
    `${checkSource}; return checkInterruptedRecovery;`,
  )(
    page,
    recoveryAction,
    recoverySlot,
    () => record,
    makeNode,
    () => null,
    { document: { activeElement: null } },
    action => {
      if (!recoveryAction.isCurrent(action)) return false;
      recoveryAction.end(action);
      finished += 1;
      return true;
    },
    () => { forgotten += 1; return true; },
    async () => {},
    api,
    async (_batchId, recover) => ({ ran: true, value: await recover(record) }),
    createDigestRecoveryOwner,
    () => ({ account_id: record.account_id, account_fingerprint: record.account_fingerprint }),
    () => '',
    () => true,
    () => {},
    () => {},
    { toastSuccess() {}, toastWarn() {} },
    recoverImageBatchResults,
    batchResultSlot,
    () => makeNode('section'),
    digestBatchRecoveryList,
    digestBatchPreviewRecovery,
    actionAbort,
  );

  await checkInterruptedRecovery();
  const recoverBtn = nodes.find(node => node.tag === 'button' && node.textContent === '恢复结果');
  const status = nodes.find(node => node.className === 'result-status muted');
  assert.ok(recoverBtn && status, '未持久化终态必须渲染真实恢复按钮');
  await recoverBtn.listeners.get('click')();
  assert.equal(forgotten, 0,
    'terminal_recovery_persisted=false 时恢复按钮不得删除本地 marker');
  assert.equal(recoverySlot.children.length, 1,
    '终态恢复记录未持久化时必须保留可重试恢复卡片');
  assert.equal(recoverBtn.disabled, false,
    '终态恢复记录未持久化时恢复按钮必须重新可用');
  assert.match(status.textContent, /持久化|重启|恢复/,
    '终态恢复记录未持久化时必须说明结果可用但恢复证据受限');
  assert.equal(finished, 1, '未持久化终态恢复 action 必须恰好释放一次');
}

// 恢复结果已经准入新 owner 后,本地图片渲染失败不能把批次 owner 留在页面上。
// marker 由外层恢复 caller 保留,供下一次恢复;本 helper 只负责释放自己新取得的 owner。
{
  const recoverSource = extractFunction(source, 'async function recoverImageBatchResults(');
  const record = {
    batch_id: 'batch-recovery-render-failure',
    batch_token: 'batch-token-recovery-render-failure-123456789',
    service_instance_id: 'service-test',
    account_id: 'account-test',
    account_fingerprint: 'a'.repeat(64),
    targets: [{ group_id: 'group-test', group_name: 'group-test' }],
  };
  const page = {
    destroyed: false,
    activeBatch: null,
    activeBatchRelease: null,
    renderOptions: { theme: 'auto', fontSize: 'normal' },
    generationRender: null,
    savedItems: new Map(),
  };
  let releaseCalls = 0;
  const terminal = {
    status: 'done',
    digest: { digest_id: 'digest-recovery-render-failure' },
  };
  const recoverImageBatchResults = new Function(
    'page',
    'api',
    'interruptedDigestRenderSelection',
    'requireDigestTerminalResult',
    'digestTerminalResultRequest',
    'digestTerminalRecoveryMetadata',
    'showImageResults',
    'admitRecoveredBatch',
    'releaseActiveBatch',
    'actionAbort',
    `${recoverSource}; return recoverImageBatchResults;`,
  )(
    page,
    {
      async post(path) {
        assert.equal(path, '/api/digest-result');
        return terminal;
      },
      getServiceInstanceId() { return 'service-test'; },
    },
    () => ({ theme: 'auto', fontSize: 'normal' }),
    requireDigestTerminalResult,
    digestTerminalResultRequest,
    digestTerminalRecoveryMetadata,
    async () => { throw new Error('本地渲染失败'); },
    async recovered => {
      page.activeBatch = recovered;
      return { admitted: true, owner: recovered, reused: false };
    },
    async ({ owner } = {}) => {
      releaseCalls += 1;
      if (page.activeBatch === owner) page.activeBatch = null;
      return true;
    },
    new AbortController(),
  );

  await assert.rejects(
    recoverImageBatchResults(record, [{ status: 'done', batch_index: 0, group_id: 'group-test' }]),
    /本地渲染失败/,
    '恢复长图的本地渲染错误必须仍交给外层 caller 投影',
  );
  assert.equal(releaseCalls, 1,
    '恢复长图渲染失败后必须释放本次新取得的 owner');
  assert.equal(page.activeBatch, null,
    '恢复长图渲染失败后不得把失败 owner 留在页面上');
}

// 文本预览恢复也必须在准入后的 DOM 投影失败时释放新 owner,而不是只恢复按钮状态。
{
  const checkSource = extractFunction(source, 'async function checkInterruptedRecovery()');
  const record = {
    batch_id: 'batch-preview-render-failure',
    batch_token: 'batch-token-preview-render-failure-123456789',
    service_instance_id: 'service-test',
    account_id: 'account-test',
    account_fingerprint: 'a'.repeat(64),
    batch_total: 1,
    preview_text: true,
    targets: [{ group_id: 'group-test', group_name: 'group-test' }],
  };
  const nodes = [];
  const makeNode = (tag, className = '', text = '') => {
    const node = {
      tag,
      className,
      textContent: text,
      children: [],
      listeners: new Map(),
      attributes: new Map(),
      disabled: false,
      isConnected: true,
      append(...children) { this.children.push(...children.filter(Boolean)); },
      appendChild(child) { if (child) this.children.push(child); return child; },
      replaceChildren(...children) { this.children = children.filter(Boolean); },
      addEventListener(type, listener) { this.listeners.set(type, listener); },
      setAttribute(name, value) { this.attributes.set(name, String(value)); },
      removeAttribute(name) { this.attributes.delete(name); },
    };
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
  };
  const recoveryAction = createRecoveryActionState();
  const recoverySlot = makeNode('div', 'recovery-slot');
  const actionAbort = new AbortController();
  let releaseCalls = 0;
  let forgotten = 0;
  const api = {
    async post(path) {
      assert.equal(path, '/api/digest-batch-preview');
      return {
        ok: true,
        status: 'done',
        pending: false,
        digests: [{ group_name: 'group-test', markdown: '摘要' }],
      };
    },
    getServiceInstanceId() { return 'service-test'; },
  };
  const admitRecoveredBatch = async recovered => {
    page.activeBatch = recovered;
    return { admitted: true, owner: recovered, reused: false };
  };
  const releaseActiveBatch = async ({ owner } = {}) => {
    releaseCalls += 1;
    if (page.activeBatch === owner) page.activeBatch = null;
    return true;
  };
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
    'ui',
    'recoverImageBatchResults',
    'batchResultSlot',
    'buildRecoveredResultsCard',
    'digestBatchRecoveryList',
    'digestBatchPreviewRecovery',
    'admitRecoveredBatch',
    'releaseActiveBatch',
    'actionAbort',
    `${digestBatchCancelConfirmedSource} ${checkSource}; return checkInterruptedRecovery;`,
  )(
    page,
    recoveryAction,
    recoverySlot,
    () => record,
    makeNode,
    () => null,
    { document: { activeElement: null } },
    action => {
      recoveryAction.end(action);
      return true;
    },
    () => { forgotten += 1; return true; },
    async () => {},
    api,
    async (_batchId, recover) => ({ ran: true, value: await recover(record) }),
    createDigestRecoveryOwner,
    () => ({ account_id: record.account_id, account_fingerprint: record.account_fingerprint }),
    () => 'preview',
    () => true,
    () => {},
    () => { throw new Error('文本预览渲染失败'); },
    { toastSuccess() {}, toastWarn() {} },
    async () => { throw new Error('长图恢复不应由预览夹具调用'); },
    makeNode('div', 'batch-slot'),
    () => makeNode('section'),
    digestBatchRecoveryList,
    digestBatchPreviewRecovery,
    admitRecoveredBatch,
    releaseActiveBatch,
    actionAbort,
  );

  await checkInterruptedRecovery();
  const recoverBtn = nodes.find(node => node.tag === 'button' && node.textContent === '恢复结果');
  const status = nodes.find(node => node.className === 'result-status muted');
  assert.ok(recoverBtn && status, '预览渲染失败场景必须渲染真实恢复按钮');
  await recoverBtn.listeners.get('click')();
  assert.equal(forgotten, 0, '预览渲染失败时不得清理恢复 marker');
  assert.equal(releaseCalls, 1, '预览渲染失败后必须释放本次新取得的 owner');
  assert.equal(page.activeBatch, null, '预览渲染失败后不得把失败 owner 留在页面上');
  assert.match(status.textContent, /恢复失败|渲染/, '预览渲染失败必须投影可操作错误');
}

// 终态逐项请求发出后,账号换代/页面 owner 变化时,旧响应即使忽略 abort
// 也不能进入 admission、savedItems 或渲染；普通 late reject 交给真实 caller
// 的 stale catch 处理,本 helper 不得产生任何页面副作用。
for (const mode of ['resolve', 'reject']) {
  const recoverSource = extractFunction(source, 'async function recoverImageBatchResults(');
  const record = {
    batch_id: `batch-terminal-late-${mode}`,
    batch_token: `batch-token-terminal-late-${mode}-123456789`,
    service_instance_id: 'service-test',
    account_id: 'account-test',
    account_fingerprint: 'a'.repeat(64),
    targets: [{ group_id: 'group-test', group_name: 'group-test' }],
  };
  const page = {
    destroyed: false,
    activeBatch: { batch: { batch_id: `current-owner-${mode}` } },
    activeBatchRelease: null,
    renderOptions: { theme: 'auto', fontSize: 'normal' },
    generationRender: { theme: 'dark', fontSize: 'large' },
    savedItems: new Map(),
  };
  const ownerBefore = page.activeBatch;
  let resolveRequest;
  let rejectRequest;
  let notifyRequestStarted;
  const requestStarted = new Promise(resolve => { notifyRequestStarted = resolve; });
  const pendingRequest = new Promise((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });
  let alive = true;
  let admissionCalls = 0;
  let renderCalls = 0;
  const recoverImageBatchResults = new Function(
    'page',
    'api',
    'interruptedDigestRenderSelection',
    'requireDigestTerminalResult',
    'digestTerminalResultRequest',
    'digestTerminalRecoveryMetadata',
    'showImageResults',
    'admitRecoveredBatch',
    'releaseActiveBatch',
    'actionAbort',
    `${recoverSource}; return recoverImageBatchResults;`,
  )(
    page,
    {
      post(path) {
        assert.equal(path, '/api/digest-result');
        notifyRequestStarted();
        return pendingRequest;
      },
      getServiceInstanceId() { return 'service-test'; },
    },
    () => ({ theme: 'auto', fontSize: 'normal' }),
    requireDigestTerminalResult,
    digestTerminalResultRequest,
    digestTerminalRecoveryMetadata,
    async () => { renderCalls += 1; },
    async recovered => {
      admissionCalls += 1;
      page.activeBatch = recovered;
      return { admitted: true, owner: recovered };
    },
    async () => {},
    new AbortController(),
  );
  const operation = recoverImageBatchResults(
    record,
    [{ status: 'done', batch_index: 0, group_id: 'group-test' }],
    { isCurrent: () => alive },
  );
  await requestStarted;
  alive = false;
  if (mode === 'resolve') {
    resolveRequest({ status: 'done', digest: { digest_id: `late-${mode}` } });
    assert.equal(await operation, null, '账号换代后的 late resolve 必须返回 cancelled/null');
  } else {
    const lateError = new Error(`late terminal ${mode}`);
    rejectRequest(lateError);
    await assert.rejects(operation, error => error === lateError,
      '普通 late reject 应交给外层 stale catch,不能被伪装成成功');
  }
  assert.equal(admissionCalls, 0, `${mode}:旧终态不得接管当前 owner`);
  assert.equal(renderCalls, 0, `${mode}:旧终态不得启动图片渲染`);
  assert.equal(page.savedItems.size, 0, `${mode}:旧终态不得写入 savedItems`);
  assert.strictEqual(page.activeBatch, ownerBefore, `${mode}:旧终态不得覆盖 B owner`);
  assert.deepEqual(page.generationRender, { theme: 'dark', fontSize: 'large' },
    `${mode}:旧终态不得清除 B 的渲染选择`);
}

// A 的恢复请求若忽略账号切换并以普通 Error 晚到，也不能把错误、按钮或焦点
// 投影到已经从页面移除的 A 卡片。这里执行真实生产 click handler，而非只测 owner helper。
{
  const checkSource = extractFunction(source, 'async function checkInterruptedRecovery()');
  const record = {
    batch_id: 'batch-account-a-late-error',
    batch_token: 'batch-token-account-a-123456789',
    service_instance_id: 'service-test',
    account_id: 'account-test',
    account_fingerprint: 'a'.repeat(64),
    batch_total: 1,
    preview_text: false,
    targets: [{ group_id: 'group-test' }],
  };
  const nodes = [];
  const makeNode = (tag, className = '', text = '') => {
    const node = {
      tag,
      className,
      textContent: text,
      children: [],
      listeners: new Map(),
      attributes: new Map(),
      disabled: false,
      isConnected: true,
      append(...children) { this.children.push(...children.filter(Boolean)); },
      appendChild(child) { if (child) this.children.push(child); return child; },
      replaceChildren(...children) { this.children = children.filter(Boolean); },
      addEventListener(type, listener) { this.listeners.set(type, listener); },
      setAttribute(name, value) { this.attributes.set(name, String(value)); },
      removeAttribute(name) { this.attributes.delete(name); },
    };
    nodes.push(node);
    return node;
  };
  const recoverySlot = makeNode('div', 'recovery-slot');
  const batchResultSlot = makeNode('div', 'batch-slot');
  const recoveryAction = createRecoveryActionState();
  const page = { destroyed: false };
  let currentIdentity = {
    account_id: record.account_id,
    account_fingerprint: record.account_fingerprint,
  };
  let rejectRequest;
  let notifyRequestStarted;
  let requestOptions = null;
  const requestStarted = new Promise(resolve => { notifyRequestStarted = resolve; });
  const pendingRequest = new Promise((_resolve, reject) => { rejectRequest = reject; });
  let finishCalls = 0;
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
    'ui',
    'recoverImageBatchResults',
    'batchResultSlot',
    'buildRecoveredResultsCard',
    'digestBatchRecoveryList',
    'digestBatchPreviewRecovery',
    `${digestBatchCancelConfirmedSource} ${checkSource}; return checkInterruptedRecovery;`,
  )(
    page,
    recoveryAction,
    recoverySlot,
    () => record,
    makeNode,
    () => null,
    { document: { activeElement: null } },
    action => {
      if (!recoveryAction.isCurrent(action)) return false;
      recoveryAction.end(action);
      finishCalls += 1;
      return true;
    },
    () => {},
    async () => {},
    {
      post(_path, _body, options) {
        requestOptions = options;
        notifyRequestStarted();
        return pendingRequest;
      },
      getServiceInstanceId() { return 'service-test'; },
    },
    async (_batchId, recover) => ({ ran: true, value: await recover(record) }),
    createDigestRecoveryOwner,
    () => currentIdentity,
    () => '',
    (candidate, identity) => candidate.account_id === identity.account_id
      && candidate.account_fingerprint === identity.account_fingerprint,
    () => {},
    () => {},
    { toastSuccess() {} },
    async () => { throw new Error('主恢复请求失败后不得进入逐项恢复'); },
    batchResultSlot,
    () => makeNode('section'),
    digestBatchRecoveryList,
    digestBatchPreviewRecovery,
  );

  await checkInterruptedRecovery();
  const recoverBtn = nodes.find(node => node.tag === 'button' && node.textContent === '恢复结果');
  const discardBtn = nodes.find(node => node.tag === 'button' && node.textContent === '放弃并取消');
  const status = nodes.find(node => node.className === 'result-status muted');
  const pendingClick = recoverBtn.listeners.get('click')();
  await requestStarted;

  currentIdentity = {
    account_id: record.account_id,
    account_fingerprint: 'b'.repeat(64),
  };
  recoveryAction.invalidate();
  assert.ok(requestOptions?.signal, '恢复主请求必须绑定当前 action 的取消信号');
  assert.equal(requestOptions.signal.aborted, true, '账号换代必须立即中止旧恢复请求');
  recoverySlot.replaceChildren();
  const beforeLateError = {
    status: status.textContent,
    recoverDisabled: recoverBtn.disabled,
    discardDisabled: discardBtn.disabled,
    finishCalls,
  };
  rejectRequest(new Error('A 恢复请求晚到失败'));
  await pendingClick;

  assert.deepEqual({
    status: status.textContent,
    recoverDisabled: recoverBtn.disabled,
    discardDisabled: discardBtn.disabled,
    finishCalls,
  }, beforeLateError, 'A 的普通 late reject 不得写已经失效的恢复卡片');
  assert.deepEqual(recoverySlot.children, [], 'A late reject 不得把旧卡片重新挂回 B 页面');
}

// 本地恢复记录清理失败时，生产放弃按钮不得先清空卡片或继续取消服务端批次；
// 否则刷新后记录仍在，但当前页面已经误报放弃成功。
{
  const checkSource = extractFunction(source, 'async function checkInterruptedRecovery()');
  const record = {
    batch_id: 'batch-discard-storage-failure',
    batch_token: 'batch-token-discard-123456789',
    service_instance_id: 'service-test',
    account_id: 'account-test',
    account_fingerprint: 'a'.repeat(64),
    batch_total: 1,
    preview_text: false,
    targets: [{ group_id: 'group-test' }],
  };
  const nodes = [];
  const makeNode = (tag, className = '', text = '') => {
    const node = {
      tag,
      className,
      textContent: text,
      children: [],
      listeners: new Map(),
      attributes: new Map(),
      disabled: false,
      isConnected: true,
      append(...children) { this.children.push(...children.filter(Boolean)); },
      appendChild(child) { if (child) this.children.push(child); return child; },
      replaceChildren(...children) { this.children = children.filter(Boolean); },
      addEventListener(type, listener) { this.listeners.set(type, listener); },
      setAttribute(name, value) { this.attributes.set(name, String(value)); },
      removeAttribute(name) { this.attributes.delete(name); },
    };
    nodes.push(node);
    return node;
  };
  const recoverySlot = makeNode('div', 'recovery-slot');
  const batchResultSlot = makeNode('div', 'batch-slot');
  const recoveryAction = createRecoveryActionState();
  let cancelCalls = 0;
  let finishCalls = 0;
  const page = { destroyed: false };
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
    'ui',
    'recoverImageBatchResults',
    'batchResultSlot',
    'buildRecoveredResultsCard',
    'digestBatchRecoveryList',
    'digestBatchPreviewRecovery',
    `${digestBatchCancelConfirmedSource} ${checkSource}; return checkInterruptedRecovery;`,
  )(
    page,
    recoveryAction,
    recoverySlot,
    () => record,
    makeNode,
    () => null,
    { document: { activeElement: null } },
    action => {
      if (!recoveryAction.isCurrent(action)) return false;
      recoveryAction.end(action);
      finishCalls += 1;
      return true;
    },
    () => false,
    async () => {
      cancelCalls += 1;
      return { ok: true, lease_released: true };
    },
    { async post() { throw new Error('取消夹具不应直接调用 api'); } },
    async () => ({ ran: false }),
    () => ({ isCurrent: () => true }),
    () => ({ account_id: record.account_id, account_fingerprint: record.account_fingerprint }),
    () => '',
    () => true,
    () => {},
    () => {},
    { toastSuccess() {} },
    async () => null,
    batchResultSlot,
    () => makeNode('section'),
    () => ({ pending: false, items: [] }),
    () => ({ status: 'pending' }),
  );

  await checkInterruptedRecovery();
  const card = recoverySlot.children[0];
  const recoverBtn = nodes.find(node => node.tag === 'button' && node.textContent === '恢复结果');
  const discardBtn = nodes.find(node => node.tag === 'button' && node.textContent === '放弃并取消');
  const status = nodes.find(node => node.className === 'result-status muted');
  assert.ok(card && recoverBtn && discardBtn && status, '清理失败场景必须渲染恢复卡片');
  await discardBtn.listeners.get('click')();
  assert.equal(cancelCalls, 1, '本地 marker 清理失败也必须先确认服务端取消');
  assert.equal(recoverySlot.children[0], card, '服务端已取消但本地清理失败时必须保留原恢复卡片');
  assert.match(status.textContent, /服务端已取消|清理|重试/, '本地清理失败必须显示可操作错误');
  assert.equal(recoverBtn.disabled, false, '本地清理失败后恢复按钮必须重新可用');
  assert.equal(discardBtn.disabled, false, '本地清理失败后放弃按钮必须重新可用');
  assert.equal(recoveryAction.isBusy(), false, '本地清理失败后恢复 action lease 必须释放');
  assert.equal(finishCalls, 1, '本地清理失败后的 discard action 必须只收尾一次');
}

// 服务端取消未确认时，不能先删除本地恢复 marker；否则页面刷新后会丢失
// 仍可能存在的服务端批次，也没有可操作的重试入口。
{
  const checkSource = extractFunction(source, 'async function checkInterruptedRecovery()');
  const record = {
    batch_id: 'batch-discard-cancel-failure',
    batch_token: 'batch-token-discard-failure-123456789',
    service_instance_id: 'service-test',
    account_id: 'account-test',
    account_fingerprint: 'a'.repeat(64),
    batch_total: 1,
    preview_text: false,
    targets: [{ group_id: 'group-test' }],
  };
  const nodes = [];
  const makeNode = (tag, className = '', text = '') => {
    const node = {
      tag,
      className,
      textContent: text,
      children: [],
      listeners: new Map(),
      attributes: new Map(),
      disabled: false,
      isConnected: true,
      append(...children) { this.children.push(...children.filter(Boolean)); },
      appendChild(child) { if (child) this.children.push(child); return child; },
      replaceChildren(...children) { this.children = children.filter(Boolean); },
      addEventListener(type, listener) { this.listeners.set(type, listener); },
      setAttribute(name, value) { this.attributes.set(name, String(value)); },
      removeAttribute(name) { this.attributes.delete(name); },
    };
    nodes.push(node);
    return node;
  };
  const recoverySlot = makeNode('div', 'recovery-slot');
  const batchResultSlot = makeNode('div', 'batch-slot');
  const recoveryAction = createRecoveryActionState();
  const page = { destroyed: false };
  let recordPresent = true;
  let cancelCalls = 0;
  let forgotten = 0;
  let finishCalls = 0;
  let cancelMode = 'pending';
  let resolveCancel = null;
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
    'ui',
    'recoverImageBatchResults',
    'batchResultSlot',
    'buildRecoveredResultsCard',
    'digestBatchRecoveryList',
    'digestBatchPreviewRecovery',
    `${digestBatchCancelConfirmedSource} ${checkSource}; return checkInterruptedRecovery;`,
  )(
    page,
    recoveryAction,
    recoverySlot,
    () => (recordPresent ? record : null),
    makeNode,
    () => null,
    { document: { activeElement: null } },
    action => {
      if (!recoveryAction.isCurrent(action)) return false;
      recoveryAction.end(action);
      finishCalls += 1;
      return true;
    },
    () => {
      forgotten += 1;
      recordPresent = false;
      return true;
    },
    async () => {
      cancelCalls += 1;
      if (cancelMode === 'pending') {
        return new Promise(resolve => { resolveCancel = resolve; });
      }
      if (cancelMode === 'throw') throw new Error('取消请求失败');
      return cancelMode;
    },
    { async post() { throw new Error('取消失败不应由夹具直接调用 api'); } },
    async () => ({ ran: false }),
    () => ({ isCurrent: () => true }),
    () => ({ account_id: record.account_id, account_fingerprint: record.account_fingerprint }),
    () => '',
    () => true,
    () => {},
    () => {},
    { toastSuccess() {} },
    async () => null,
    batchResultSlot,
    () => makeNode('section'),
    () => ({ pending: false, items: [] }),
    () => ({ status: 'pending' }),
  );

  await checkInterruptedRecovery();
  const card = recoverySlot.children[0];
  const recoverBtn = nodes.find(node => node.tag === 'button' && node.textContent === '恢复结果');
  const discardBtn = nodes.find(node => node.tag === 'button' && node.textContent === '放弃并取消');
  const status = nodes.find(node => node.className === 'result-status muted');
  assert.ok(card && recoverBtn && discardBtn && status, '取消失败场景必须渲染恢复卡片');
  const pendingDiscard = discardBtn.listeners.get('click')();
  await Promise.resolve();
  assert.equal(cancelCalls, 1, '取消按钮必须尝试一次服务端取消');
  assert.equal(forgotten, 0, '取消 Promise 挂起时不得删除本地恢复 marker');
  assert.equal(recordPresent, true, '服务端取消未确认时恢复 marker 必须继续存在');
  assert.equal(recoveryAction.isBusy(), true, '取消 Promise 挂起时 discard action 必须保持忙态');
  assert.equal(recoverySlot.children[0], card, '取消 Promise 挂起时不得移除恢复卡片');
  resolveCancel(null);
  await pendingDiscard;
  assert.equal(forgotten, 0, '取消返回 null 时不得删除本地恢复 marker');
  assert.equal(recoverySlot.children[0], card, '服务端取消未确认时必须保留恢复卡片');
  assert.match(status.textContent, /取消|恢复|重试|未确认/, '取消失败必须显示可操作状态');
  assert.equal(recoverBtn.disabled, false, '取消失败后恢复按钮必须重新可用');
  assert.equal(discardBtn.disabled, false, '取消失败后放弃按钮必须重新可用');
  assert.equal(recoveryAction.isBusy(), false, '取消失败后恢复 action lease 必须释放');
  assert.equal(finishCalls, 1, '取消失败后的 discard action 必须只收尾一次');

  cancelMode = { ok: true, lease_released: false };
  await discardBtn.listeners.get('click')();
  assert.equal(cancelCalls, 2, 'lease 未释放时也必须允许后续重试取消');
  assert.equal(forgotten, 0, 'lease 未释放时不得删除本地恢复 marker');
  assert.equal(recordPresent, true, 'lease 未释放时恢复 marker 必须继续存在');
  assert.equal(recoverySlot.children[0], card, 'lease 未释放时必须保留恢复卡片');

  cancelMode = 'throw';
  await discardBtn.listeners.get('click')();
  assert.equal(cancelCalls, 3, '取消抛错时也必须完成一次服务端取消尝试');
  assert.equal(forgotten, 0, '取消抛错时不得删除本地恢复 marker');
  assert.equal(recordPresent, true, '取消抛错时恢复 marker 必须继续存在');
  assert.equal(recoverySlot.children[0], card, '取消抛错时必须保留恢复卡片');

  cancelMode = 'pending';
  const staleDiscard = discardBtn.listeners.get('click')();
  await Promise.resolve();
  recoveryAction.invalidate('账号已切换');
  resolveCancel({ ok: true, lease_released: true });
  await staleDiscard;
  assert.equal(cancelCalls, 4, '失效 discard 也必须只保留自己的取消请求');
  assert.equal(forgotten, 0, 'action 失效后不得清理本地恢复 marker');
  assert.equal(recordPresent, true, 'action 失效后恢复 marker 必须继续存在');
  assert.equal(recoverySlot.children[0], card, 'action 失效后不得移除恢复卡片');

  cancelMode = { ok: true, lease_released: true };
  await discardBtn.listeners.get('click')();
  assert.equal(cancelCalls, 5, '重试取消必须再次调用服务端');
  assert.equal(forgotten, 1, '服务端确认取消后才允许最终删除本地 marker');
  assert.equal(recordPresent, false, '服务端确认取消后恢复 marker 必须删除');
  assert.deepEqual(recoverySlot.children, [], '服务端确认取消后恢复卡片必须移除');
  assert.equal(finishCalls, 4, '取消重试也必须只收尾自己的 discard action');
}

// 跨标签删除/替换恢复记录发生在终态响应已经通过一次记录复核、但恢复
// owner 仍在等待 active-batch 收尾之后:旧 A action 不得渲染结果或清掉
// 新 B marker。storage 回调是生产 wiring 的实际语义,操作忙时也必须让
// 当前 recovery owner 失效,再由重读逻辑挂出 B。
{
  assert.match(source, /onChange:\s*handleRecoveryStorageChange/,
    '恢复 storage listener 必须接入 marker owner 失效处理,不能只重新读取');
  const makeNode = (tag = 'div', className = '', text = '') => {
    const node = {
      tag,
      className,
      textContent: text,
      children: [],
      listeners: new Map(),
      attributes: new Map(),
      disabled: false,
      isConnected: true,
      append(...children) { this.children.push(...children.filter(Boolean)); },
      appendChild(child) { if (child) this.children.push(child); return child; },
      replaceChildren(...children) { this.children = children.filter(Boolean); },
      addEventListener(type, listener) { this.listeners.set(type, listener); },
      setAttribute(name, value) { this.attributes.set(name, String(value)); },
      removeAttribute(name) { this.attributes.delete(name); },
    };
    return node;
  };
  const recordA = {
    batch_id: 'recovery-owner-a',
    batch_token: 'recovery-owner-token-a',
    service_instance_id: 'service-owner-test',
    account_id: 'account-owner-test',
    account_fingerprint: 'a'.repeat(64),
    batch_total: 1,
    preview_text: true,
    targets: [{ group_id: 'group-a', group_name: 'group-a' }],
  };
  const recordB = {
    ...recordA,
    batch_id: 'recovery-owner-b',
    batch_token: 'recovery-owner-token-b',
    targets: [{ group_id: 'group-b', group_name: 'group-b' }],
  };
  let currentRecord = recordA;
  let resolveOldFinish;
  const oldFinish = new Promise(resolve => { resolveOldFinish = resolve; });
  const page = {
    destroyed: false,
    accountContextBlocked: false,
    activeBatch: {
      batch: { batch_id: 'active-owner-a', batch_token: 'active-owner-token-a' },
      finish: async () => oldFinish,
    },
    activeBatchRelease: null,
    previewDigests: [],
    previewMarkdown: '',
    renderOptions: { theme: 'auto', fontSize: 'normal' },
    savedItems: new Map(),
  };
  const recoveryAction = createRecoveryActionState();
  const recoverySlot = makeNode('div', 'recovery-slot');
  const batchResultSlot = makeNode('div', 'batch-slot');
  const releaseActiveBatch = new Function(
    'page',
    'stopBatchKeepalive',
    'startBatchKeepalive',
    'digestBatchFinishConfirmed',
    releaseSource + '; return releaseActiveBatch;',
  )(
    page,
    () => {},
    () => {},
    value => value?.ok === true && value?.settled === true && value?.pending !== true,
  );
  const admitRecoveredBatch = new Function(
    'page',
    'releaseActiveBatch',
    'startBatchKeepalive',
    admissionSource + '; return admitRecoveredBatch;',
  )(page, releaseActiveBatch, () => {});
  let externalStorageChange = null;
  let renderCalls = 0;
  let forgotten = 0;
  const checkSource = extractFunction(source, 'async function checkInterruptedRecovery()');
  const recoveryStorageChangeSource = extractFunction(source, 'function handleRecoveryStorageChange(');
  let checkInterruptedRecovery;
  const guardedAdmission = async (...args) => {
    const pending = admitRecoveredBatch(...args);
    currentRecord = recordB;
    externalStorageChange?.();
    assert.equal(recoveryAction.isBusy(), false,
      '外部 marker 替换必须在旧 admission 继续前失效 A action');
    return pending;
  };
  checkInterruptedRecovery = new Function(
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
    'ui',
    'recoverImageBatchResults',
    'batchResultSlot',
    'buildRecoveredResultsCard',
    'digestBatchRecoveryList',
    'digestBatchPreviewRecovery',
    'admitRecoveredBatch',
    'actionAbort',
    `${digestBatchCancelConfirmedSource} ${checkSource}; return checkInterruptedRecovery;`,
  )(
    page,
    recoveryAction,
    recoverySlot,
    batchId => !batchId || currentRecord?.batch_id === batchId ? currentRecord : null,
    makeNode,
    () => null,
    { document: { activeElement: null } },
    action => {
      if (!recoveryAction.isCurrent(action)) return false;
      recoveryAction.end(action);
      return true;
    },
    () => { forgotten += 1; return true; },
    async () => {},
    {
      async post(path) {
        assert.equal(path, '/api/digest-batch-preview');
        return {
          ok: true,
          status: 'done',
          pending: false,
          digests: [{ group_name: 'group-a', markdown: 'A' }],
        };
      },
      getServiceInstanceId() { return 'service-owner-test'; },
    },
    async (_batchId, recover) => ({ ran: true, value: await recover(recordA) }),
    createDigestRecoveryOwner,
    () => ({ accountId: recordA.account_id, accountFingerprint: recordA.account_fingerprint }),
    () => 'A',
    (record, identity) => interruptedDigestBatchMatchesAccount(record, identity),
    () => {},
    () => { renderCalls += 1; },
    { toastSuccess() {} },
    async () => null,
    batchResultSlot,
    () => makeNode('section'),
    digestBatchRecoveryList,
    digestBatchPreviewRecovery,
    guardedAdmission,
    new AbortController(),
  );
  const onStorageChange = new Function(
    'page',
    'recoveryAction',
    'currentRecoveryRecord',
    'checkInterruptedRecovery',
    `${recoveryStorageChangeSource}; return handleRecoveryStorageChange;`,
  )(
    page,
    recoveryAction,
    batchId => !batchId || currentRecord?.batch_id === batchId ? currentRecord : null,
    checkInterruptedRecovery,
  );
  externalStorageChange = onStorageChange;

  await checkInterruptedRecovery();
  const card = recoverySlot.children[0];
  const recoverBtn = [...card.children]
    .flatMap(child => child?.children || [])
    .find(node => node?.tag === 'button' && node.textContent === '恢复结果');
  assert.ok(recoverBtn, '旧 marker 必须挂出真实恢复按钮');
  const recover = recoverBtn.listeners.get('click')();
  await Promise.resolve();
  assert.equal(recoveryAction.isBusy(), true, '旧 A 恢复在途时必须持有 action owner');
  resolveOldFinish({ ok: true, settled: true, pending: false, released: false });
  await recover;
  assert.equal(renderCalls, 0,
    '跨标签删除/替换 marker 后旧 A 终态不得渲染到当前页面');
  assert.equal(forgotten, 0,
    '旧 A 终态不得清理已被替换的恢复记录');
  assert.equal(recoveryAction.isBusy(), false);
  assert.equal(currentRecord, recordB, '测试必须确实把当前恢复记录替换为 B');
  assert.ok(recoverySlot.children.length > 0,
    '旧 action 失效后必须保留/重挂 B 恢复卡片');
}

const mainSource = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const previewRouteStart = mainSource.indexOf("pathname === '/api/digest-batch-preview'");
const previewRouteEnd = mainSource.indexOf("pathname === '/api/digest-batch-results'", previewRouteStart);
assert.ok(previewRouteStart >= 0 && previewRouteEnd > previewRouteStart,
  '必须能定位文本预览恢复路由');
const previewRouteSource = mainSource.slice(previewRouteStart, previewRouteEnd);
assert.match(
  previewRouteSource,
  /const pendingState = digestBatchFinishPendingState\(batchId\);[\s\S]*?if \(pendingState\.pending\)[\s\S]*?status: 'pending'[\s\S]*?recoverDigestBatchPreview\(/,
  '文本预览恢复必须在读取/返回部分快照前先投影批次 pending 状态',
);

console.log('web digest recovery unmount tests passed');
