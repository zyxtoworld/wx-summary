import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createStore } from '../src/web/public/js/store.js';
import { createAccountSelectionController } from '../src/web/public/js/shared/account-selection.js';
import {
  createHistoryAccountContextTracker,
  historyAccountSwitchBlockedMessage,
  historyActionResultAppliesToView,
} from '../src/web/public/js/pages/history/account-switch.js';

const historySource = await readFile(new URL('../src/web/public/js/pages/history/index.js', import.meta.url), 'utf8');

function extractFunction(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `生产历史页必须包含 ${marker}`);
  const signatureEnd = source.indexOf(') {', start);
  assert.ok(signatureEnd >= 0, `${marker} 必须有可定位的函数体`);
  const open = source.indexOf('{', signatureEnd + 2);
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
  throw new Error(`${marker} 函数体未闭合`);
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

// 直接执行生产 runDetailAction:同 ID fingerprint A→B 会同步关闭/失效 A 详情。
// A 的普通晚到成功或失败都不能把提示、列表写回或 busy 收尾投影到 B。
{
  const actionFingerprintA = 'a'.repeat(64);
  const actionFingerprintB = 'b'.repeat(64);
  const runDetailActionSource = extractFunction(historySource, 'async function runDetailAction(');
  const page = { destroyed: false, detail: null };
  let currentFingerprint = actionFingerprintA;
  const uiEvents = [];
  const applied = [];
  const busyWrites = [];
  const runDetailAction = new Function(
    'page',
    'actionAccountIdForItem',
    'actionAccountFingerprintForItem',
    'detailBusy',
    'setDetailStatus',
    'ui',
    'actionResultStillApplies',
    'applyOutcomeItem',
    `${runDetailActionSource}; return runDetailAction;`,
  )(
    page,
    item => String(item?.account_id || ''),
    item => String(item?.account_fingerprint || ''),
    flag => {
      busyWrites.push({ detail: page.detail, flag });
      if (page.detail) page.detail.busy = flag;
    },
    () => {},
    {
      toastSuccess(message) { uiEvents.push(['success', message]); },
      toast(message, options) { uiEvents.push(['toast', message, options]); },
      toastError(message) { uiEvents.push(['error', message]); },
    },
    (actionAccountId, actionFingerprint) => historyActionResultAppliesToView({
      accountScope: 'current',
      currentAccountId: 'account-a',
      currentAccountFingerprint: currentFingerprint,
      actionAccountId,
      actionAccountFingerprint: actionFingerprint,
    }),
    outcome => applied.push(outcome),
  );

  for (const mode of ['resolve', 'reject']) {
    const detailA = {
      item: { account_id: 'account-a', account_fingerprint: actionFingerprintA },
      busy: false,
      invalidated: false,
    };
    const detailB = {
      item: { account_id: 'account-a', account_fingerprint: actionFingerprintB },
      busy: true,
      invalidated: false,
    };
    page.detail = detailA;
    currentFingerprint = actionFingerprintA;
    const request = deferred();
    const pending = runDetailAction('复制路径', () => request.promise, { replacesItem: true });
    assert.equal(detailA.busy, true, `${mode}: A 动作必须先持有 A 详情 busy`);

    detailA.invalidated = true;
    currentFingerprint = actionFingerprintB;
    page.detail = detailB;
    if (mode === 'resolve') {
      request.resolve({ status: 'verified', tone: 'success', message: 'A 已完成', item: { id: 'old-a' } });
    } else {
      request.reject(new Error('A 普通失败'));
    }
    await pending;
    assert.deepEqual(uiEvents, [], `${mode}: A 晚到不得在 B 页面显示 toast`);
    assert.deepEqual(applied, [], `${mode}: A 晚到不得合并 B 页面列表`);
    assert.equal(detailB.busy, true, `${mode}: A 晚到不得释放 B 详情 busy`);
  }

  // 同账号同指纹也可能在旧详情关闭后立即打开另一条详情；旧详情的
  // 下载/动作结果不得向新的详情实例投影成功或失败提示。
  for (const mode of ['resolve', 'reject']) {
    const oldDetail = {
      item: { account_id: 'account-a', account_fingerprint: actionFingerprintA, digest_id: `old-${mode}` },
      busy: false,
      invalidated: false,
    };
    const newDetail = {
      item: { account_id: 'account-a', account_fingerprint: actionFingerprintA, digest_id: `new-${mode}` },
      busy: true,
      invalidated: false,
    };
    page.detail = oldDetail;
    currentFingerprint = actionFingerprintA;
    const request = deferred();
    const pending = runDetailAction('下载 PNG', () => request.promise);
    assert.equal(oldDetail.busy, true, `${mode}: 旧详情动作必须先持有旧详情 busy`);
    oldDetail.invalidated = true;
    page.detail = newDetail;
    if (mode === 'resolve') {
      request.resolve({ status: 'verified', tone: 'success', message: '旧详情 PNG 已下载' });
    } else {
      request.reject(new Error('旧详情 PNG 读取失败'));
    }
    await pending;
    assert.deepEqual(uiEvents, [], `${mode}: 同账号新详情不应收到旧详情的晚到提示`);
    assert.equal(newDetail.busy, true, `${mode}: 旧详情晚到不得释放新详情 busy`);
  }

  // 首次发现账号时 fingerprint 可能从空值升级为精确 B。空值不是通配符；
  // 旧详情动作在升级后晚到，也不能把完成提示投影到 B。
  const unboundDetail = {
    item: { account_id: 'account-a', account_fingerprint: '' },
    busy: false,
    invalidated: false,
  };
  const upgradedDetail = {
    item: { account_id: 'account-a', account_fingerprint: actionFingerprintB },
    busy: true,
    invalidated: false,
  };
  page.detail = unboundDetail;
  currentFingerprint = '';
  const upgradeRequest = deferred();
  const upgradePending = runDetailAction('复制路径', () => upgradeRequest.promise, { replacesItem: true });
  assert.equal(unboundDetail.busy, true, '空 fingerprint 动作必须先持有旧详情 busy');
  unboundDetail.invalidated = true;
  currentFingerprint = actionFingerprintB;
  page.detail = upgradedDetail;
  upgradeRequest.resolve({
    status: 'verified',
    tone: 'success',
    message: '未绑定身份的旧动作已完成',
    item: { id: 'old-unbound' },
  });
  await upgradePending;
  assert.deepEqual(uiEvents, [], '空 fingerprint 旧动作晚到不得在精确 B 页面显示 toast');
  assert.deepEqual(applied, [], '空 fingerprint 旧动作晚到不得合并精确 B 页面列表');
  assert.equal(upgradedDetail.busy, true, '空 fingerprint 旧动作晚到不得释放 B 详情 busy');

  // 同账号用户自己关闭详情仍保留原有离屏结果提示；只屏蔽跨上下文投影。
  const sameContextDetail = {
    item: { account_id: 'account-a', account_fingerprint: actionFingerprintA },
    busy: false,
    invalidated: false,
  };
  page.detail = sameContextDetail;
  currentFingerprint = actionFingerprintA;
  const sameContextRequest = deferred();
  const sameContextPending = runDetailAction('复制路径', () => sameContextRequest.promise);
  sameContextDetail.invalidated = true;
  page.detail = null;
  sameContextRequest.resolve({ status: 'verified', tone: 'success', message: '当前账号动作已完成' });
  await sameContextPending;
  assert.deepEqual(uiEvents, [['success', '当前账号动作已完成']],
    '同账号手动关闭详情后仍应收到动作完成提示');
  assert.deepEqual(applied, [], '手动关闭详情后不得把已失效详情结果合回列表');
  assert.ok(busyWrites.length >= 3, '生产动作必须真实进入详情 busy 分支');
}

// PNG→MD 导出在第二个(写入)请求 pending 时切换同 ID fingerprint，
// 旧 A 的 outcome 也不得越过账号上下文门禁向 B toast 或合并列表。
{
  const actionFingerprintA = 'a'.repeat(64);
  const actionFingerprintB = 'b'.repeat(64);
  const exportMarkdownSource = extractFunction(historySource, 'async function exportMarkdown(item)');
  const page = { destroyed: false, detail: null };
  let currentFingerprint = actionFingerprintA;
  let exportOutcome = null;
  let exportStarted = null;
  const uiEvents = [];
  const applied = [];
  const exportMarkdown = new Function(
    'page',
    'actionAccountIdForItem',
    'actionAccountFingerprintForItem',
    'detailBusy',
    'setDetailStatus',
    'api',
    'historyDigestPath',
    'digestMarkdownForDigests',
    'actions',
    'ui',
    'actionResultStillApplies',
    'applyOutcomeItem',
    'setDetailStatusWithEvidence',
    `${exportMarkdownSource}; return exportMarkdown;`,
  )(
    page,
    item => String(item?.account_id || ''),
    item => String(item?.account_fingerprint || ''),
    flag => { if (page.detail) page.detail.busy = flag; },
    () => {},
    { async get() { return { digest: { digest_id: 'digest-a', group: 'group-a' } }; } },
    () => '/api/history-digest/a',
    () => '# digest-a',
    {
      exportMarkdown() {
        exportStarted?.();
        return exportOutcome.promise;
      },
    },
    {
      toastSuccess(message) { uiEvents.push(['success', message]); },
      toast(message, options) { uiEvents.push(['toast', message, options]); },
      toastError(message) { uiEvents.push(['error', message]); },
    },
    (_accountId, actionFingerprint) => actionFingerprint === currentFingerprint,
    outcome => applied.push(outcome),
    () => {},
  );

  for (const status of ['verified', 'failed']) {
    const detailA = {
      item: { account_id: 'account-a', account_fingerprint: actionFingerprintA },
      busy: false,
      invalidated: false,
      controller: new AbortController(),
    };
    const detailB = {
      item: { account_id: 'account-a', account_fingerprint: actionFingerprintB },
      busy: true,
      invalidated: false,
      controller: new AbortController(),
    };
    page.detail = detailA;
    currentFingerprint = actionFingerprintA;
    exportOutcome = deferred();
    let markExportStarted;
    const exportEntered = new Promise(resolve => { markExportStarted = resolve; });
    exportStarted = markExportStarted;
    const pending = exportMarkdown(detailA.item);
    await exportEntered;
    assert.equal(detailA.busy, true, `${status}: A 导出必须已进入第二个写入请求`);

    detailA.invalidated = true;
    detailA.controller.abort(new Error('账号上下文已变化'));
    currentFingerprint = actionFingerprintB;
    page.detail = detailB;
    exportOutcome.resolve({
      status,
      tone: status === 'verified' ? 'success' : 'error',
      message: status === 'verified' ? 'A MD 已导出' : 'A MD 导出失败',
      item: status === 'verified' ? { id: 'old-a-md' } : null,
    });
    await pending;
    assert.deepEqual(uiEvents, [], `${status}: A 导出晚到不得在 B 页面显示 toast`);
    assert.deepEqual(applied, [], `${status}: A 导出晚到不得合并 B 页面列表`);
    assert.equal(detailB.busy, true, `${status}: A 导出晚到不得释放 B 详情 busy`);
  }
}

assert.match(historySource, /historyAccountSwitchBlockedMessage/,
  '历史页必须使用自己的账号切换忙态守卫');
assert.match(historySource, /store\.set\('accountSwitchGuard', accountSwitchGuard\)/,
  '历史页挂载时必须注册账号切换守卫');
assert.match(
  historySource,
  /closeDetail\(\);\s*closeAllModals\(\);[\s\S]*page\.focusKey = '';\s*page\.focusAction = '';[\s\S]*void loadFirstPage\(\{ clearItems: true \}\)/,
  '历史页切换到新账号后必须关闭旧详情、清除旧焦点身份和旧卡片，再读取目标账号列表',
);
assert.match(historySource, /store\.get\('accountSwitchGuard'\) === accountSwitchGuard[\s\S]*store\.set\('accountSwitchGuard', null\)/,
  '历史页销毁时必须只释放自己持有的账号切换守卫');

const accountA = { id: 'account-a' };
const accountB = { id: 'account-b' };
const fingerprintA = 'a'.repeat(64);
const fingerprintB = 'b'.repeat(64);
assert.match(historyAccountSwitchBlockedMessage({ detailBusy: true }), /历史操作/,
  '历史详情操作进行中必须返回可操作的阻止提示');
assert.match(historyAccountSwitchBlockedMessage({ pendingRerender: 1 }), /历史操作/,
  '历史重渲染提交进行中必须返回可操作的阻止提示');
assert.equal(historyAccountSwitchBlockedMessage({}), '',
  '历史页空闲时不得阻止账号切换');
assert.equal(historyActionResultAppliesToView({
  accountScope: 'current',
  currentAccountId: 'account-a',
  actionAccountId: 'account-a',
}), true, '当前账号未变化时旧详情操作结果可更新列表');
assert.equal(historyActionResultAppliesToView({
  accountScope: 'current',
  currentAccountId: 'account-a',
  currentAccountFingerprint: fingerprintB,
  actionAccountId: 'account-a',
  actionAccountFingerprint: fingerprintA,
}), false, '同一账号 ID 的 fingerprint 变化后旧详情操作结果不得更新列表');
assert.equal(historyActionResultAppliesToView({
  accountScope: 'current',
  currentAccountId: 'account-a',
  currentAccountFingerprint: fingerprintA,
  actionAccountId: 'account-a',
  actionAccountFingerprint: fingerprintA,
}), true, '同一账号上下文未变化时旧详情操作结果仍可更新列表');
assert.equal(historyActionResultAppliesToView({
  accountScope: 'current',
  currentAccountId: 'account-a',
  currentAccountFingerprint: fingerprintB,
  actionAccountId: 'account-a',
  actionAccountFingerprint: '',
}), false, '空 fingerprint 旧动作不得把精确身份当成同一上下文');
assert.equal(historyActionResultAppliesToView({
  accountScope: 'current',
  currentAccountId: 'account-a',
  currentAccountFingerprint: '',
  actionAccountId: 'account-a',
  actionAccountFingerprint: fingerprintB,
}), false, '精确 fingerprint 旧动作不得把身份降级后的空值当成同一上下文');
assert.equal(historyActionResultAppliesToView({
  accountScope: 'current',
  currentAccountId: 'account-b',
  actionAccountId: 'account-a',
}), false, '切到另一账号后旧详情操作结果不得写入新账号列表');
assert.equal(historyActionResultAppliesToView({
  accountScope: 'current',
  currentAccountId: 'account-a',
  actionAccountId: '',
}), false, '当前账号视图中缺少操作账号身份时必须 fail closed');
assert.equal(historyActionResultAppliesToView({
  accountScope: 'all',
  currentAccountId: 'account-b',
  actionAccountId: 'account-a',
}), true, '全部账号视图可以接收任一已绑定账号的操作结果');

const accountContextTracker = createHistoryAccountContextTracker({
  id: 'account-a',
  manual_key_account_fingerprint: fingerprintA,
});
const capturedDetail = { invalidated: false };
const capturedActionContext = {
  accountId: 'account-a',
  accountFingerprint: fingerprintA,
};
let activeDetail = capturedDetail;
const lateVerified = Promise.resolve({ status: 'verified', message: '旧账号动作完成' });
const switchHistoryAccount = account => {
  const change = accountContextTracker.update(account);
  if (!change.changed) return;
  capturedDetail.invalidated = true;
  activeDetail = null;
};
switchHistoryAccount({ id: 'account-a', manual_key_account_fingerprint: fingerprintB });
await lateVerified;
const wouldApplyLateVerified = lateVerified
  && activeDetail !== capturedDetail
  && capturedDetail.invalidated !== true
  && historyActionResultAppliesToView({
    accountScope: 'current',
    currentAccountId: 'account-a',
    currentAccountFingerprint: fingerprintB,
    actionAccountId: capturedActionContext.accountId,
    actionAccountFingerprint: capturedActionContext.accountFingerprint,
  });
assert.equal(wouldApplyLateVerified, false,
  '同 ID fingerprint 切换并关闭详情后,旧 verified 响应不得合入新历史上下文');
assert.equal(capturedDetail.invalidated, true,
  '账号上下文变化必须显式失效捕获的旧详情 owner');

assert.match(historySource, /historyActionResultAppliesToView/,
  '生产历史页必须按当前视图账号核对已关闭详情的异步结果');
assert.match(historySource, /detail\.invalidated = true;[\s\S]*detail\.controller\.abort\(\)/,
  '关闭详情必须先失效旧 action owner,再中止旧请求');
assert.ok((historySource.match(/actionResultStillApplies\(actionAccountId, actionAccountFingerprint\)/g) || []).length >= 3,
  '通用详情操作与导出 MD 的离屏回包都必须经过账号 fingerprint 上下文核对');
assert.match(
  historySource,
  /actions\.exportMarkdown\(item,\s*\{[\s\S]*?signal:\s*detail\.controller\.signal/,
  '历史页导出 MD 必须把当前详情 AbortSignal 传给生产导出 action',
);
const store = createStore({ account: accountA, accountSwitchGuard: null });
const blocked = [];
const controller = createAccountSelectionController({
  store,
  onBlocked: message => blocked.push(message),
});

store.set('accountSwitchGuard', () => '历史操作正在进行,请完成后再切换账号。');
const blockedResult = controller.select(accountB, { userInitiated: true });
assert.equal(blockedResult.blocked, true, '历史详情操作进行中必须阻止账号切换');
assert.equal(store.get('account'), accountA, '历史忙态被阻止后当前账号必须保持不变');
assert.match(blocked[0], /历史操作/);

store.set('accountSwitchGuard', null);
const allowedResult = controller.select(accountB, { userInitiated: true });
assert.equal(allowedResult.blocked, false, '历史页空闲时必须允许账号切换');
assert.equal(store.get('account'), accountB);

console.log('web history account switch tests passed');
