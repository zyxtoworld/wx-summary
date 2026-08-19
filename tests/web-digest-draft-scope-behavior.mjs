import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDigestDraftScopeLifecycle } from '../src/web/public/js/pages/digest/draft-scope.js';

const digestSource = await readFile(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');
assert.match(
  digestSource,
  /const contextChange = draftScopeLifecycle\.beginContextChange\([\s\S]*?\n\s*if \(contextChange\.status === 'unchanged'\) \{[\s\S]*?notify\(\);[\s\S]*?return;[\s\S]*?\n\s*\}/,
  '生产摘要页同账号对象刷新必须尊重 unchanged,不得清空草稿/群列表或重发请求',
);

const scopeA = '["PROJECT_ROOT","account-a"]';
const scopeB = '["PROJECT_ROOT","account-b"]';
const drafts = new Map([
  [scopeA, { render_options: { theme: 'dark', font_size: 'large' } }],
  [scopeB, { render_options: { theme: 'light', font_size: 'normal' } }],
]);
const events = [];
let currentDraft = { render_options: { theme: 'auto', font_size: 'normal' } };
let meaningful = false;
const applied = [];
const resetCount = () => events.filter(event => event.type === 'reset').length;

const lifecycle = createDigestDraftScopeLifecycle({
  readDraft(scope, options) {
    events.push({ type: 'read', scope, fingerprint: options.accountFingerprint });
    return { ok: true, draft: drafts.get(scope) || null };
  },
  writeDraft(scope, draft, options) {
    events.push({ type: 'write', scope, fingerprint: options.accountFingerprint });
    drafts.set(scope, draft);
    return true;
  },
  resetDraft() {
    events.push({ type: 'reset' });
    currentDraft = { render_options: { theme: 'auto', font_size: 'normal' } };
  },
  applyDraft(draft) {
    applied.push(draft.render_options);
    currentDraft = draft;
  },
  snapshot() {
    return currentDraft;
  },
  isMeaningful() {
    return meaningful;
  },
});

assert.equal(lifecycle.reconcile('', { accountFingerprint: 'a' }).status, 'waiting');
assert.equal(events.length, 0, '空 project_root 不得读取或写入任何账号草稿键');
assert.equal(
  lifecycle.reconcile(scopeA, {
    accountFingerprint: 'a',
    accountIdentity: 'id:account-a',
  }).status,
  'restored',
);
assert.deepEqual(applied.at(-1), { theme: 'dark', font_size: 'large' });
assert.equal(events.filter(event => event.type === 'read').length, 1);

meaningful = true;
currentDraft = { render_options: { theme: 'dark', font_size: 'normal' } };
lifecycle.markEdited();
const beforeSameAccountRefreshEvents = events.length;
assert.equal(
  lifecycle.beginContextChange('id:account-a').status,
  'unchanged',
  '同账号的新对象必须按稳定身份视为 no-op，而不是按对象实例切换',
);
assert.equal(events.length, beforeSameAccountRefreshEvents, '同账号对象刷新不得重新读取或重置当前编辑');
assert.deepEqual(currentDraft, { render_options: { theme: 'dark', font_size: 'normal' } });

const beforeBlockedSwitchEvents = events.length;
assert.equal(
  lifecycle.beginContextChange('id:account-b').status,
  'blocked',
  '真实切换前存在未持久化编辑时必须 fail-closed',
);
assert.equal(events.length, beforeBlockedSwitchEvents, '被阻止的切换不得清除或读取草稿');
assert.deepEqual(currentDraft, { render_options: { theme: 'dark', font_size: 'normal' } });

assert.equal(
  lifecycle.persist(scopeA, { accountFingerprint: 'a' }).persisted,
  true,
  '来源账号草稿持久化成功后才允许切换',
);
assert.equal(lifecycle.beginContextChange('id:account-b').status, 'changed');
assert.equal(
  lifecycle.reconcile(scopeB, {
    accountFingerprint: 'b',
    accountIdentity: 'id:account-b',
  }).status,
  'restored',
);
assert.deepEqual(applied.at(-1), { theme: 'light', font_size: 'normal' });
assert.equal(lifecycle.beginContextChange('id:account-a').status, 'changed');
assert.equal(
  lifecycle.reconcile(scopeA, {
    accountFingerprint: 'a',
    accountIdentity: 'id:account-a',
  }).status,
  'restored',
);
assert.deepEqual(applied.at(-1), { theme: 'dark', font_size: 'normal' });
assert.ok(resetCount() >= 3, '真实账号切换必须先清除来源账号的页面草稿状态');

assert.equal(lifecycle.beginContextChange('id:account-b').status, 'changed');
currentDraft = { render_options: { theme: 'dark', font_size: 'normal' } };
lifecycle.markEdited();
const readsBeforePendingEdit = events.filter(event => event.type === 'read').length;
assert.equal(
  lifecycle.reconcile(scopeB, {
    accountFingerprint: 'b',
    accountIdentity: 'id:account-b',
  }).status,
  'preserved',
);
assert.equal(
  events.filter(event => event.type === 'read').length,
  readsBeforePendingEdit,
  '目标 state 到达时若用户已编辑，不得用目标草稿覆盖当前编辑',
);
assert.equal(events.at(-1).type, 'write');
assert.equal(events.at(-1).scope, scopeB);

// state 尚未绑定 project/account scope 时，用户仍可能先修改摘要选项。
// 这时没有可写入的键，失败必须进入离开保护；不能把“空 scope 未写入”
// 当成已处理并清掉 persistenceFailed。
{
  let pendingDraft = {
    render_options: { theme: 'dark', font_size: 'normal' },
  };
  const noScopeLifecycle = createDigestDraftScopeLifecycle({
    readDraft: () => ({ ok: true, draft: null }),
    writeDraft: () => {
      throw new Error('scope 尚未就绪');
    },
    resetDraft() {},
    applyDraft() {},
    snapshot: () => pendingDraft,
    isMeaningful: draft => draft?.render_options?.theme === 'dark',
  });
  const result = noScopeLifecycle.persist('', { accountFingerprint: 'a' });
  assert.equal(result.persisted, false, '空 scope 不得声称草稿已保存');
  assert.equal(result.persistenceFailed, true,
    '空 scope 下有意义草稿必须进入持久化失败保护');
  assert.equal(noScopeLifecycle.persistenceRisk(), true,
    '空 scope 未保存时离开保护必须保持开启');
  pendingDraft = {};
  assert.equal(noScopeLifecycle.persistenceRisk(), false,
    '草稿恢复为默认值后不应继续阻止离开');
}

// 已绑定 A 且有意义编辑时，账号列表短暂变为空身份也不能走 changed 清空
// 当前页面；否则 store 的暂时 null 会在真实 account subscriber 中直接丢草稿。
{
  let resetCalls = 0;
  let currentDraft = {
    render_options: { theme: 'dark', font_size: 'normal' },
  };
  const emptyIdentityLifecycle = createDigestDraftScopeLifecycle({
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
    emptyIdentityLifecycle.reconcile('scope-a', {
      accountFingerprint: 'a',
      accountIdentity: 'id:account-a',
    }).status,
    'default',
  );
  currentDraft = { render_options: { theme: 'dark', font_size: 'normal' } };
  emptyIdentityLifecycle.markEdited();
  const failedEmptyPersist = emptyIdentityLifecycle.persist('', { accountFingerprint: 'a' });
  assert.equal(failedEmptyPersist.ready, false);
  assert.equal(failedEmptyPersist.persistenceFailed, true,
    '已绑定 A 的空 scope 留档失败必须保留失败状态');
  const resetsBeforeEmptyChange = resetCalls;
  const emptyChange = emptyIdentityLifecycle.beginContextChange('');
  assert.equal(emptyChange.status, 'blocked',
    '有意义 A 草稿未持久化时暂时空账号必须 fail-closed');
  assert.equal(emptyIdentityLifecycle.accountIdentity(), 'id:account-a',
    '被阻止的空账号换代不得清掉来源 owner');
  assert.equal(resetCalls, resetsBeforeEmptyChange,
    '被阻止的空账号换代不得 reset 当前草稿');
assert.deepEqual(currentDraft, { render_options: { theme: 'dark', font_size: 'normal' } },
    '被阻止的空账号换代不得清掉当前编辑');
}

// 已绑定 scope 的最后成功基线是有意义草稿时，用户把表单重置为默认，
// 随后的覆盖写失败也不能因为“当前快照无意义”而放行账号切换；否则回到 A
// 时仍会恢复旧的有意义草稿，吞掉用户明确的清空意图。
{
  let currentDraft = {
    render_options: { theme: 'dark', font_size: 'large' },
  };
  let resetCalls = 0;
  let failWrites = false;
  const baselineLifecycle = createDigestDraftScopeLifecycle({
    readDraft: () => ({
      ok: true,
      draft: { render_options: { theme: 'dark', font_size: 'large' } },
    }),
    writeDraft: (scope, draft) => {
      if (failWrites) throw new Error(`写入失败: ${scope}`);
      currentDraft = structuredClone(draft);
      return true;
    },
    resetDraft() {
      resetCalls += 1;
      currentDraft = { render_options: { theme: 'auto', font_size: 'normal' } };
    },
    applyDraft(draft) {
      currentDraft = structuredClone(draft);
    },
    snapshot: () => currentDraft,
    isMeaningful: draft => draft?.render_options?.theme !== 'auto'
      || draft?.render_options?.font_size !== 'normal',
  });

  assert.equal(
    baselineLifecycle.reconcile('scope-a', { accountIdentity: 'id:account-a' }).status,
    'restored',
    '先建立 A 的有意义成功恢复基线',
  );
  currentDraft = { render_options: { theme: 'auto', font_size: 'normal' } };
  baselineLifecycle.markEdited();
  failWrites = true;
  const failedResetPersist = baselineLifecycle.persist('scope-a', { accountFingerprint: 'a' });
  assert.equal(failedResetPersist.persisted, false);
  assert.equal(failedResetPersist.persistenceFailed, true,
    '有意义基线被重置后写失败必须保留失败保护');
  const resetsBeforeBlockedReset = resetCalls;
  assert.equal(
    baselineLifecycle.beginContextChange('id:account-b').status,
    'blocked',
    '有意义基线到默认快照的失败覆盖仍不得放行账号切换',
  );
  assert.equal(baselineLifecycle.accountIdentity(), 'id:account-a');
  assert.equal(resetCalls, resetsBeforeBlockedReset,
    '被阻止的切换不得清空用户刚刚恢复默认的表单');
  assert.deepEqual(currentDraft, { render_options: { theme: 'auto', font_size: 'normal' } });
}

// 对称边界：默认基线上的编辑最终回到默认值时，即使覆盖写失败也没有
// 净变化，不能仅因 boundScope 存在就永久阻止切换。
{
  let currentDraft = { render_options: { theme: 'auto', font_size: 'normal' } };
  let failWrites = false;
  const defaultBaselineLifecycle = createDigestDraftScopeLifecycle({
    readDraft: () => ({ ok: true, draft: null }),
    writeDraft: () => {
      if (failWrites) throw new Error('写入失败');
      return true;
    },
    resetDraft() {
      currentDraft = { render_options: { theme: 'auto', font_size: 'normal' } };
    },
    applyDraft() {},
    snapshot: () => currentDraft,
    isMeaningful: draft => draft?.render_options?.theme !== 'auto'
      || draft?.render_options?.font_size !== 'normal',
  });
  assert.equal(
    defaultBaselineLifecycle.reconcile('scope-a', { accountIdentity: 'id:account-a' }).status,
    'default',
  );
  currentDraft = { render_options: { theme: 'dark', font_size: 'normal' } };
  defaultBaselineLifecycle.markEdited();
  currentDraft = { render_options: { theme: 'auto', font_size: 'normal' } };
  failWrites = true;
  const revertedDefaultPersist = defaultBaselineLifecycle.persist('scope-a');
  assert.equal(revertedDefaultPersist.persistenceFailed, false,
    '回到默认基线时失败写入不应制造净脏风险');
  assert.equal(defaultBaselineLifecycle.beginContextChange('id:account-b').status, 'changed',
    '回到默认基线后应允许账号切换');
}

// 账号列表刷新可能暂时移除当前选择；重新选回同一账号时，空身份也必须
// 成为一次真实 context change，否则旧的 A identity 会把回到 A 误判成 no-op，
// 群列表和草稿都不会重新绑定。
{
  const gapLifecycle = createDigestDraftScopeLifecycle({
    readDraft: () => ({ ok: true, draft: null }),
    writeDraft: () => true,
    resetDraft() {},
    applyDraft() {},
    snapshot: () => ({}),
    isMeaningful: () => false,
  });
  assert.equal(
    gapLifecycle.reconcile('scope-a', { accountIdentity: 'id:account-a' }).status,
    'default',
  );
  assert.equal(gapLifecycle.beginContextChange('').status, 'changed',
    '当前账号暂时消失时必须清空账号绑定');
  assert.equal(gapLifecycle.beginContextChange('id:account-a').status, 'changed',
    '重新选回同一账号必须重新建立账号上下文');

  // 用户编辑后又恢复默认值时，当前快照已经没有需要保护的内容；
  // 空 scope 留档失败不应仅凭 editVersion 差异把账号上下文永久锁住。
  gapLifecycle.markEdited();
  const meaninglessEmptyPersist = gapLifecycle.persist('', { accountFingerprint: 'a' });
  assert.equal(meaninglessEmptyPersist.ready, false);
  assert.equal(meaninglessEmptyPersist.persistenceFailed, false,
    '无意义草稿的空 scope 留档不应制造失败风险');
  assert.equal(gapLifecycle.beginContextChange('').status, 'changed',
    '当前草稿无意义时即使空 scope 留档失败也应允许清空账号绑定');
}

console.log('web digest draft scope behavior tests passed');
