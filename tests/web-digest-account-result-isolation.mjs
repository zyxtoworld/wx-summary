import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  clearDigestAccountBoundResults,
  createDigestAccountResultContextHandler,
} from '../src/web/public/js/pages/digest/account-result-state.js';
import {
  digestAccountContextIdentity,
  invalidateDigestAccountAsyncWork,
} from '../src/web/public/js/pages/digest/account-context.js';
import { createDigestDraftScopeLifecycle } from '../src/web/public/js/pages/digest/draft-scope.js';
import { createRecoveryActionState } from '../src/web/public/js/pages/digest/recovery-action-state.js';

const state = {
  doneResults: [{ target: { group_id: 'account-a-group' } }],
  currentResultIndex: 1,
  currentRender: { digest: { digest_id: 'digest-a' } },
  generationRender: { theme: 'auto', fontSize: 'normal' },
  savedItems: new Map([['digest-a', { digest_id: 'digest-a' }]]),
  previewDigests: [{ digest_id: 'digest-a' }],
  previewMarkdown: '# account-a',
};

assert.equal(clearDigestAccountBoundResults(state), true,
  '账号上下文变化必须清理已完成的摘要结果态');
assert.deepEqual(state.doneResults, []);
assert.equal(state.currentResultIndex, 0);
assert.equal(state.currentRender, null);
assert.equal(state.generationRender, null);
assert.equal(state.savedItems.size, 0);
assert.deepEqual(state.previewDigests, []);
assert.equal(state.previewMarkdown, '');

// 账号上下文改变必须使同页生成 owner 立即失效;否则旧批次晚到会重新写入当前账号。
{
  const controller = new AbortController();
  const page = {
    destroyed: false,
    generation: 7,
    abortController: controller,
  };
  const oldGeneration = page.generation;
  let lateWrites = 0;
  invalidateDigestAccountAsyncWork(page);
  assert.equal(page.generation, oldGeneration + 1,
    '账号上下文改变必须推进摘要页 generation');
  assert.equal(controller.signal.aborted, true,
    '账号上下文改变必须 abort 旧摘要生成请求');
  assert.equal(page.abortController, null,
    '账号上下文改变后不得继续持有旧摘要 controller');
  if (!page.destroyed && page.generation === oldGeneration) lateWrites += 1;
assert.equal(lateWrites, 0,
    '旧摘要生成完成后不得通过旧 generation 写入当前账号页面');
}

// 账号上下文切换时，恢复 action 也必须释放自己的旧 lease；否则旧请求迟到前，
// 新恢复卡片永远无法开始。旧 action 的 finally 不能清掉失效后新建的 action。
{
  const recoveryAction = createRecoveryActionState();
  const oldAction = recoveryAction.begin('batch-account-a', 'recover');
  const recoveryPage = { destroyed: false, generation: 3, abortController: null };
  const recoveryState = { savedItems: new Map() };
  const recoverySlots = {
    recovery: slot(),
    batch: slot(),
    result: slot(),
    textPreview: slot(),
  };
  const accountCleanup = createDigestAccountResultContextHandler({
    state: recoveryState,
    slots: recoverySlots,
    beforeClear() {
      invalidateDigestAccountAsyncWork(recoveryPage, '账号上下文已变化');
      recoveryAction.invalidate();
    },
  });
  accountCleanup.handle({ status: 'changed' });
  assert.equal(recoveryAction.isBusy(), false,
    '账号切换后必须立即释放旧恢复 action busy');
  const newAction = recoveryAction.begin('batch-account-b', 'recover');
  assert.ok(newAction, '旧恢复 action 释放后必须允许新账号建立恢复 action');
  assert.equal(recoveryAction.isCurrent(oldAction), false,
    '旧恢复 action 失效后不得再被视为当前 action');
  assert.equal(recoveryAction.end(oldAction), undefined);
  assert.equal(recoveryAction.isCurrent(newAction), true,
    '旧恢复 action 晚到收尾不得清掉新账号的 action busy');
}

function slot() {
  return {
    children: ['account-a-result'],
    replaceCalls: 0,
    replaceChildren(...children) {
      this.replaceCalls += 1;
      this.children = children;
    },
  };
}

// 清理回调属于外部生产接线，回调异常也不能阻断旧账号结果的清空；
// 但异常必须继续向上冒泡，不能被处理器静默吞掉。
const throwingState = {
  doneResults: [{ target: { group_id: 'account-a-group' } }],
  currentResultIndex: 1,
  currentRender: { digest: { digest_id: 'digest-a' } },
  generationRender: { theme: 'auto', fontSize: 'normal' },
  savedItems: new Map([['digest-a', { digest_id: 'digest-a' }]]),
  previewDigests: [{ digest_id: 'digest-a' }],
  previewMarkdown: '# account-a',
};
const throwingSlots = {
  recovery: slot(),
  batch: slot(),
  result: slot(),
  textPreview: slot(),
};
const throwingHandler = createDigestAccountResultContextHandler({
  state: throwingState,
  slots: throwingSlots,
  beforeClear() {
    throw new Error('before-clear boom');
  },
});
assert.throws(
  () => throwingHandler.handle({ status: 'changed' }),
  /before-clear boom/,
  '清理回调异常必须继续冒泡',
);
assert.deepEqual(throwingState.doneResults, [],
  '清理回调异常时也必须清空结果态');
assert.equal(throwingState.currentRender, null);
assert.equal(throwingState.savedItems.size, 0);
for (const resultSlot of Object.values(throwingSlots)) {
  assert.deepEqual(resultSlot.children, [],
    '清理回调异常时也必须清空全部结果 slot');
  assert.equal(resultSlot.replaceCalls, 1);
}

function createSubscriberHarness() {
  const state = {
    activeBatch: null,
    doneResults: [{ target: { group_id: 'account-a-group' } }],
    currentResultIndex: 1,
    currentRender: { digest: { digest_id: 'digest-a' } },
    generationRender: { theme: 'auto', fontSize: 'normal' },
    savedItems: new Map([['digest-a', { digest_id: 'digest-a' }]]),
    previewDigests: [{ digest_id: 'digest-a' }],
    previewMarkdown: '# account-a',
  };
  const slots = {
    recovery: slot(),
    batch: slot(),
    result: slot(),
    textPreview: slot(),
  };
  let identity = 'id:A';
  let blockedNext = false;
  let persistenceFailed = false;
  let restoreCalls = 0;
  let loadCalls = 0;
  let beforeClearStatuses = [];
  const draftScopeLifecycle = {
    beginContextChange(nextIdentity) {
      if (blockedNext) {
        blockedNext = false;
        return { status: 'blocked', identity };
      }
      if (nextIdentity === identity) return { status: 'unchanged', identity };
      const previousIdentity = identity;
      identity = nextIdentity;
      return { status: 'changed', identity, previousIdentity };
    },
  };
  const accountResultContext = createDigestAccountResultContextHandler({
    state,
    slots,
    beforeClear(change) {
      beforeClearStatuses.push(change?.status || '');
    },
  });
  let account = { id: 'A' };
  const listeners = new Set();
  const store = {
    subscribe(key, listener) {
      if (key === 'account') listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setAccount(nextAccount) {
      const previous = account;
      account = nextAccount;
      for (const listener of listeners) listener(account, previous);
    },
  };
  store.subscribe('account', current => {
    const contextChange = draftScopeLifecycle.beginContextChange(`id:${current.id}`);
    const result = accountResultContext.handle(contextChange);
    if (contextChange.status === 'unchanged') return result;
    if (contextChange.status === 'blocked') {
      persistenceFailed = true;
      return result;
    }
    restoreCalls += 1;
    loadCalls += 1;
    return result;
  });
  return {
    state,
    slots,
    store,
    blockNext() { blockedNext = true; },
    get identity() { return identity; },
    get persistenceFailed() { return persistenceFailed; },
    get restoreCalls() { return restoreCalls; },
    get loadCalls() { return loadCalls; },
    get beforeClearStatuses() { return beforeClearStatuses; },
  };
}

// A→B 的真实 store subscriber 变化:即使 A 的恢复结果只有 saved 条目、没有 activeBatch,
// 结果态和所有结果 slot 也必须立即清空。
const changed = createSubscriberHarness();
changed.store.setAccount({ id: 'B' });
assert.equal(changed.identity, 'id:B');
assert.deepEqual(changed.state.doneResults, []);
assert.equal(changed.state.currentRender, null);
assert.equal(changed.state.savedItems.size, 0);
for (const resultSlot of Object.values(changed.slots)) {
  assert.deepEqual(resultSlot.children, []);
  assert.equal(resultSlot.replaceCalls, 1);
}
assert.equal(changed.restoreCalls, 1);
assert.equal(changed.loadCalls, 1);
assert.deepEqual(changed.beforeClearStatuses, ['changed']);

// 同账号对象刷新是 no-op:不应再次擦除 B 的新结果或触发读取。
changed.state.doneResults = [{ target: { group_id: 'account-b-group' } }];
changed.state.currentRender = { digest: { digest_id: 'digest-b' } };
changed.state.savedItems.set('digest-b', { digest_id: 'digest-b' });
for (const resultSlot of Object.values(changed.slots)) resultSlot.children = ['account-b-result'];
changed.store.setAccount({ id: 'B', display_name: '刷新后的对象' });
assert.equal(changed.state.doneResults.length, 1);
assert.equal(changed.state.currentRender.digest.digest_id, 'digest-b');
assert.equal(changed.state.savedItems.size, 1);
assert.equal(changed.restoreCalls, 1);
assert.equal(changed.loadCalls, 1);
assert.deepEqual(changed.beforeClearStatuses, ['changed'],
  '同账号对象刷新不得再次进入清理回调');
for (const resultSlot of Object.values(changed.slots)) assert.equal(resultSlot.replaceCalls, 1);

// programmatic A→B 后 draft 持久化失败:全局账号已经是 B,所以旧结果仍必须清空;
// blocked 只禁止 restore/load B,并保留 fail-closed 状态。
const blocked = createSubscriberHarness();
blocked.blockNext();
blocked.store.setAccount({ id: 'B' });
assert.equal(blocked.identity, 'id:A', 'blocked draft scope 必须保留旧绑定 identity');
assert.equal(blocked.persistenceFailed, true);
assert.equal(blocked.restoreCalls, 0);
assert.equal(blocked.loadCalls, 0);
assert.deepEqual(blocked.beforeClearStatuses, ['blocked'],
  'blocked 必须把状态传给生产清理回调以保持锁定态');
assert.deepEqual(blocked.state.doneResults, []);
assert.equal(blocked.state.currentRender, null);
assert.equal(blocked.state.savedItems.size, 0);
for (const resultSlot of Object.values(blocked.slots)) {
  assert.deepEqual(resultSlot.children, []);
  assert.equal(resultSlot.replaceCalls, 1);
}

// 使用生产 draft scope + 稳定身份 helper + store subscriber + 结果处理器，
// 覆盖账号列表短暂返回空账号的真实组合：A 有意义编辑且空 scope 留档失败时，
// subscriber 必须 blocked；结果清理仍要执行，但不得 reset/restore/load 当前编辑。
{
  const accountA = {
    id: 'account-null-gap',
    manual_key_account_fingerprint: 'a'.repeat(64),
  };
  const page = {
    destroyed: false,
    accountContextBlocked: false,
    draftPersistenceFailed: false,
  };
  const state = {
    doneResults: [{ target: { group_id: 'account-null-gap-group' } }],
    currentResultIndex: 1,
    currentRender: { digest: { digest_id: 'account-null-gap-digest' } },
    generationRender: { theme: 'dark', fontSize: 'normal' },
    savedItems: new Map([['account-null-gap-digest', { digest_id: 'account-null-gap-digest' }]]),
    previewDigests: [{ digest_id: 'account-null-gap-digest' }],
    previewMarkdown: '# account-null-gap',
  };
  const slots = {
    recovery: slot(),
    batch: slot(),
    result: slot(),
    textPreview: slot(),
  };
  let currentDraft = { render_options: { theme: 'dark', font_size: 'normal' } };
  let resetCalls = 0;
  let restoreCalls = 0;
  let loadCalls = 0;
  const draftScopeLifecycle = createDigestDraftScopeLifecycle({
    readDraft: () => ({ ok: true, draft: null }),
    writeDraft: () => true,
    resetDraft() {
      resetCalls += 1;
      currentDraft = {};
    },
    applyDraft() {},
    snapshot: () => currentDraft,
    isMeaningful: draft => draft?.render_options?.theme === 'dark',
  });
  assert.equal(
    draftScopeLifecycle.reconcile('scope-null-gap', {
      accountFingerprint: accountA.manual_key_account_fingerprint,
      accountIdentity: digestAccountContextIdentity(accountA),
    }).status,
    'default',
  );
  currentDraft = { render_options: { theme: 'dark', font_size: 'normal' } };
  draftScopeLifecycle.markEdited();
  assert.equal(
    draftScopeLifecycle.persist('', {
      accountFingerprint: accountA.manual_key_account_fingerprint,
    }).persistenceFailed,
    true,
  );
  const resetsBeforeChange = resetCalls;
  const accountResultContext = createDigestAccountResultContextHandler({
    state,
    slots,
    beforeClear(change) {
      page.accountContextBlocked = change.status === 'blocked';
    },
  });
  let account = accountA;
  const listeners = new Set();
  const store = {
    get(key) {
      return key === 'account' ? account : null;
    },
    subscribe(key, listener) {
      if (key === 'account') listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setAccount(next) {
      const previous = account;
      account = next;
      for (const listener of listeners) listener(next, previous);
    },
  };
  store.subscribe('account', () => {
    const contextChange = draftScopeLifecycle.beginContextChange(
      digestAccountContextIdentity(store.get('account')),
    );
    accountResultContext.handle(contextChange);
    if (contextChange.status === 'unchanged') return;
    if (contextChange.status === 'blocked') {
      page.draftPersistenceFailed = contextChange.persistenceFailed === true;
      return;
    }
    restoreCalls += 1;
    loadCalls += 1;
  });

  store.setAccount(null);
  assert.equal(page.accountContextBlocked, true,
    '真实 subscriber 在暂时空账号且草稿未落盘时必须保持 blocked');
  assert.equal(page.draftPersistenceFailed, true);
  assert.equal(draftScopeLifecycle.accountIdentity(), digestAccountContextIdentity(accountA),
    '空账号 blocked 不得清掉来源 owner');
  assert.equal(resetCalls, resetsBeforeChange,
    '真实 subscriber 的 blocked 路径不得 reset 当前编辑');
  assert.deepEqual(currentDraft, { render_options: { theme: 'dark', font_size: 'normal' } });
  assert.equal(restoreCalls, 0, '空账号 blocked 不得 restore 草稿');
  assert.equal(loadCalls, 0, '空账号 blocked 不得启动目标账号加载');
  assert.deepEqual(state.doneResults, []);
  assert.equal(state.currentRender, null);
  assert.equal(state.savedItems.size, 0);
  for (const resultSlot of Object.values(slots)) assert.deepEqual(resultSlot.children, []);
}

const digestSource = await readFile(
  new URL('../src/web/public/js/pages/digest/index.js', import.meta.url),
  'utf8',
);
assert.match(digestSource, /createDigestAccountResultContextHandler/,
  '摘要页必须接入账号结果态清理边界');
assert.match(digestSource, /beforeClear\(change\)[\s\S]*?invalidateDigestAccountAsyncWork\(page\)/,
  '真实账号 subscriber 必须先使摘要页旧 generation 与请求失效');
assert.match(digestSource, /beforeClear\(change\)[\s\S]*?recoveryAction\.invalidate\(\)/,
  '真实账号 subscriber 必须使恢复 action lease 失效，避免旧恢复占用新账号 busy');
const destroySource = digestSource.slice(digestSource.indexOf('async destroy()'));
assert.match(destroySource, /resultOperation\.invalidate\(\);[\s\S]*?recoveryAction\.invalidate\(\);/,
  '页面卸载也必须释放恢复 action lease，不能把页面状态留到晚到 finally');
assert.match(digestSource, /beforeClear\(change\)[\s\S]*?taskScope\.invalidate\(\)/,
  '真实账号 subscriber 必须使复制/路径/文件夹显示等页面 task owner 失效');
assert.match(digestSource, /accountResultContext\.handle\(contextChange\)/,
  '真实账号 subscriber 必须把 draft-scope 结果交给可执行清理处理器');
assert.match(digestSource, /slots:\s*\{[\s\S]*?recovery:\s*recoverySlot[\s\S]*?batch:\s*batchResultSlot[\s\S]*?result:\s*resultSlot[\s\S]*?textPreview:\s*textPreviewSlot/,
  '生产处理器必须持有恢复/批次/长图/文本预览四个结果 slot');
assert.match(digestSource, /if \(contextChange\.status === 'blocked'\)[\s\S]*?page\.draftPersistenceFailed\s*=\s*contextChange\.persistenceFailed === true[\s\S]*?return;/,
  'blocked 账号变化必须保留 fail-closed 提示且不得 restore/load 新账号');
const subscriberSource = digestSource.slice(
  digestSource.indexOf("subscribeAccount: notify => store.subscribe('account'"),
  digestSource.indexOf("subscribeAccount: notify => store.subscribe('account'") + 1800,
);
assert.doesNotMatch(subscriberSource, /resultRenderState\.invalidate\(\)/,
  '账号 subscriber 不得在处理器之外重复失效 render lease');

console.log('web digest account result isolation tests passed');
