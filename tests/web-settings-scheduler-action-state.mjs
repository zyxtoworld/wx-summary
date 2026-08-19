import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';
import { refreshPublicAccountIdentityUpgrade } from '../src/web/public/js/shared/account-context.js';
import { requireGroupList } from '../src/web/public/js/shared/group-list-contract.js';

globalThis.location = new URL('http://wx-summary.test/#/settings');

const loader = createBrowserModuleLoader();
const scheduler = await loader.load('js/pages/settings/scheduler.js');
const schedulerSource = await fs.readFile(new URL('../src/web/public/js/pages/settings/scheduler.js', import.meta.url), 'utf8');
const settingsSource = await fs.readFile(new URL('../src/web/public/js/pages/settings/index.js', import.meta.url), 'utf8');
const digestSource = await fs.readFile(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');
const setupFinishSource = await fs.readFile(new URL('../src/web/public/js/pages/setup/step-finish.js', import.meta.url), 'utf8');

function extractFunction(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `生产调度分区必须包含 ${marker}`);
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
assert.equal(typeof scheduler.syncSchedulerMaintenanceButtons, 'function',
  '调度分区必须导出可测试的维护按钮状态同步器');
assert.equal(typeof scheduler.createLatestSchedulerStatusPoll, 'function',
  '调度分区必须导出生产使用的最新状态轮询器');
const validRunOnceResult = {
  ok: true,
  request_ok: true,
  cancelled_after_commit: false,
  result: { ok: true, checked: 2, generated: 1, skipped: 1, failed: 0 },
};
assert.strictEqual(scheduler.requireSchedulerRunOnceResult(validRunOnceResult), validRunOnceResult,
  '合法手动检查响应必须原样保留给状态渲染');
const validCursorCleanupResult = {
  ok: true,
  attempted: 2,
  target_count: 2,
  cleared: 2,
  failed_count: 0,
  scheduler: {},
};
assert.strictEqual(
  scheduler.requireSchedulerLegacyCursorCleanupResult(validCursorCleanupResult),
  validCursorCleanupResult,
  '完整成功的游标清理响应必须保留',
);
for (const valid of [
  { ...validCursorCleanupResult, ok: false, cleared: 1, failed_count: 1 },
  { ...validCursorCleanupResult, attempted: 1, cleared: 1, cancelled_after_commit: true },
]) {
  assert.strictEqual(scheduler.requireSchedulerLegacyCursorCleanupResult(valid), valid,
    '部分失败和提交后取消仍是需要投影的合法清理结果');
}
for (const malformed of [
  null,
  {},
  { ...validCursorCleanupResult, scheduler: null },
  { ...validCursorCleanupResult, attempted: '2' },
  { ...validCursorCleanupResult, cleared: 3 },
  { ...validCursorCleanupResult, ok: true, failed_count: 1 },
  { ...validCursorCleanupResult, cancelled_after_commit: 'yes' },
]) {
  assert.throws(
    () => scheduler.requireSchedulerLegacyCursorCleanupResult(malformed),
    error => error?.status === 502 && error?.code === 'scheduler_legacy_cursor_cleanup_response_invalid',
    '畸形游标清理响应必须按固定 502 合同拒绝',
  );
}
for (const malformed of [
  null,
  {},
  { ...validRunOnceResult, request_ok: false },
  { ...validRunOnceResult, cancelled_after_commit: null },
  { ...validRunOnceResult, result: null },
  { ...validRunOnceResult, result: { ...validRunOnceResult.result, ok: null } },
  { ...validRunOnceResult, result: { ...validRunOnceResult.result, checked: '2' } },
  { ...validRunOnceResult, result: { ...validRunOnceResult.result, failed: -1 } },
]) {
  assert.throws(
    () => scheduler.requireSchedulerRunOnceResult(malformed),
    error => error?.status === 502 && error?.code === 'scheduler_run_once_response_invalid',
    '畸形手动检查响应必须按固定 502 合同拒绝',
  );
}
assert.equal(scheduler.requireSchedulerStoreRevalidationResult({
  ok: true,
  store: 'cursors',
  remaining_blocked_store_count: 0,
}, 'cursors'), 0, '合法的零阻塞响应必须保留成功路径');
assert.equal(scheduler.requireSchedulerStoreRevalidationResult({
  ok: true,
  store: 'pending_cursors',
  remaining_blocked_store_count: 2,
}, 'pending_cursors'), 2, '合法的非零阻塞响应必须保留警告计数');
for (const malformed of [
  null,
  {},
  { ok: true, store: 'pending_cursors', remaining_blocked_store_count: 0 },
  { ok: true, store: 'cursors', remaining_blocked_store_count: '0' },
  { ok: true, store: 'cursors', remaining_blocked_store_count: -1 },
  { ok: true, store: 'cursors', remaining_blocked_store_count: 0.5 },
]) {
  assert.throws(
    () => scheduler.requireSchedulerStoreRevalidationResult(malformed, 'cursors'),
    error => error?.status === 502 && error?.code === 'scheduler_store_revalidation_response_invalid',
    '畸形重新校验响应必须按固定 502 合同拒绝',
  );
}

// 状态轮询的 200 + null 不能被包装成“当前状态”;否则 paintSchedulerStatus(null)
// 会保留旧 DOM,用户看不到可重试错误。
{
  const fetchStatusSource = extractFunction(schedulerSource, 'async fetchStatus({ signal })');
  let requestCount = 0;
  const fetchStatus = new Function(
    'page',
    'accountScope',
    'currentAccountContextIdentity',
    'api',
    'isAbortError',
    'requireSchedulerStatusResult',
    `return ({ ${fetchStatusSource} }).fetchStatus;`,
  )(
    {
      softToken() { return { generation: 1 }; },
      alive() { return true; },
    },
    {
      ensure() { return { generation: 1 }; },
      isCurrent() { return true; },
    },
    () => 'account-a|fingerprint-a',
    {
      async get() {
        requestCount += 1;
        return null;
      },
    },
    () => false,
    scheduler.requireSchedulerStatusResult,
  );
  await assert.rejects(
    fetchStatus({ signal: new AbortController().signal }),
    error => error?.status === 502 && error?.code === 'scheduler_status_response_invalid',
    '调度状态轮询的 200 + null 必须进入固定错误合同,不能静默保留旧状态',
  );
  assert.equal(requestCount, 1, '畸形状态响应只允许发起一次读取');
}

assert.deepEqual(requireGroupList({ groups: [] }), [], '空群数组必须保留为合法无群结果');
assert.equal(requireGroupList({ groups: [{ group_id: 'group-alias' }] })[0].group_id, 'group-alias',
  '共享合同必须接受服务端规范化前仍带 group_id 的稳定群身份');
for (const malformed of [{}, { groups: null }, { groups: [null] }, { groups: [{}] }]) {
  assert.throws(
    () => requireGroupList(malformed),
    error => error?.status === 502 && error?.code === 'group_list_response_invalid',
    '群列表缺失、非数组或群项缺少稳定 ID 时必须按固定合同拒绝',
  );
}
for (const [productionSource, label] of [
  [digestSource, '摘要页'],
  [schedulerSource, '设置调度页'],
  [setupFinishSource, '向导完成页'],
]) {
  assert.match(productionSource, /requireGroupList\(/,
    `${label}必须调用同一严格群列表响应合同`);
}
assert.ok(
  schedulerSource.includes("text: '清理未验证游标'")
    && schedulerSource.includes("text: '清理未绑定账号的白名单引用'")
    && schedulerSource.includes('另有 ${legacyCount} 条未绑定账号引用')
    && schedulerSource.includes("title: '清理未验证游标'")
    && schedulerSource.includes("title: '清理未绑定账号的白名单引用'")
    && !schedulerSource.includes('清理未验证旧游标')
    && !schedulerSource.includes('清理旧格式白名单引用')
    && !schedulerSource.includes('旧格式引用未在列表中显示')
    && !schedulerSource.includes('清理旧游标'),
  '维护区用户可见文案必须使用中性业务语义,不能暴露前端迁移版本身份',
);
assert.ok(
  schedulerSource.includes("/api/scheduler/clear-unverified-legacy-cursors")
    && schedulerSource.includes('legacy_cursor_cleanup_token')
    && schedulerSource.includes('remove_unscoped_legacy_whitelist'),
  '维护区中性化文案不得删除或改写内部协议字段和 API',
);
assert.ok(
  schedulerSource.includes('syncSchedulerMaintenanceButtons({')
    && schedulerSource.includes('}, { busy });')
    && !schedulerSource.includes('maintenanceActionCount'),
  '生产维护按钮必须只服从全页 action busy，不能由跨账号的第二套计数继续锁定',
);

function buttons() {
  return {
    cursors: { disabled: false },
    pending: { disabled: false },
    legacyRefs: { disabled: false },
  };
}

{
  const state = buttons();
  scheduler.syncSchedulerMaintenanceButtons(state, { busy: true });
  assert.equal(state.cursors.disabled, true, '维护请求进行中必须锁定游标校验按钮');
  assert.equal(state.pending.disabled, true, '维护请求进行中必须锁定待提交游标校验按钮');
  assert.equal(state.legacyRefs.disabled, true, '维护请求进行中必须锁定未绑定账号引用清理按钮');

  scheduler.syncSchedulerMaintenanceButtons(state, { busy: false });
  assert.equal(state.cursors.disabled, false, '维护请求完成后必须恢复游标校验按钮');
  assert.equal(state.pending.disabled, false, '维护请求完成后必须恢复待提交游标校验按钮');
  assert.equal(state.legacyRefs.disabled, false, '维护请求完成后必须恢复未绑定账号引用清理按钮');
}

{
  const state = buttons();
  scheduler.syncSchedulerMaintenanceButtons(state, { busy: true });
  assert.equal(state.cursors.disabled, true, '设置页其他操作忙时仍必须锁定游标校验按钮');
  assert.equal(state.pending.disabled, true, '设置页其他操作忙时仍必须锁定待提交游标校验按钮');
  assert.equal(state.legacyRefs.disabled, true, '设置页其他操作忙时仍必须锁定未绑定账号引用清理按钮');
}

{
  const revalidateStoreSource = extractFunction(schedulerSource, 'async function revalidateStore(');
  const statusEvents = [];
  let polls = 0;
  const token = { signal: new AbortController().signal };
  const revalidateStore = new Function(
    'page',
    'revalidateCursorsBtn',
    'revalidatePendingBtn',
    'maintainStatus',
    'api',
    'pollSchedulerStatus',
    'isAbortError',
    'errorText',
    'requireSchedulerStoreRevalidationResult',
    `${revalidateStoreSource}; return revalidateStore;`,
  )(
    {
      beginAction() { return token; },
      alive(candidate) { return candidate === token; },
      endAction(candidate) { return candidate === token; },
    },
    { disabled: false },
    { disabled: false },
    { set(message, kind) { statusEvents.push({ message, kind }); } },
    {
      async post(path, body) {
        assert.equal(path, '/api/scheduler/revalidate-store');
        assert.deepEqual(body, { store: 'cursors' });
        return null;
      },
    },
    async () => { polls += 1; },
    () => false,
    (error, fallback) => error?.message || fallback,
    scheduler.requireSchedulerStoreRevalidationResult,
  );

  await revalidateStore('cursors');
  assert.equal(statusEvents.at(-1)?.kind, 'err',
    '重新校验接口的 200 + null 必须进入错误态，不能误报没有损坏文件');
  assert.match(statusEvents.at(-1)?.message || '', /响应无效/,
    '畸形重新校验响应必须给出可操作的固定错误');
  assert.equal(polls, 0,
    '畸形重新校验响应不得触发会掩盖错误的后续状态轮询');
}

{
  const runOnceSource = extractFunction(schedulerSource, 'async function runOnce(');
  const statusEvents = [];
  let invalidations = 0;
  let paints = 0;
  let observations = 0;
  const token = { signal: new AbortController().signal };
  const runOnce = new Function(
    'page',
    'ui',
    'runOnceBtn',
    'saveSchedulerBtn',
    'saveWhitelistBtn',
    'schedulerStatusPoll',
    'runStatus',
    'api',
    'paintSchedulerStatus',
    'isAbortError',
    'errorText',
    'requireSchedulerRunOnceResult',
    `${runOnceSource}; return runOnce;`,
  )(
    {
      getBaseRevision() { return 'scheduler-revision'; },
      beginAction() { return token; },
      alive(candidate) { return candidate === token; },
      endAction(candidate) { return candidate === token; },
      observeRuntimePayload() { observations += 1; },
      markStale() {},
    },
    { async confirmDialog() { return true; } },
    { disabled: false },
    { disabled: false },
    { disabled: false },
    { invalidate() { invalidations += 1; } },
    { set(message, kind) { statusEvents.push({ message, kind }); } },
    {
      async post(path, body) {
        assert.equal(path, '/api/scheduler/run-once');
        assert.deepEqual(body, { base_settings_revision: 'scheduler-revision' });
        return null;
      },
    },
    () => { paints += 1; },
    () => false,
    (error, fallback) => error?.message || fallback,
    scheduler.requireSchedulerRunOnceResult,
  );

  await runOnce();
  assert.equal(statusEvents.at(-1)?.kind, 'err',
    '手动检查接口的 200 + null 必须进入错误态，不能回退成“检查已执行”');
  assert.match(statusEvents.at(-1)?.message || '', /响应无效/,
    '畸形手动检查响应必须给出固定错误');
  assert.equal(paints, 0, '畸形手动检查响应不得重画调度状态');
  assert.equal(observations, 0, '畸形手动检查响应不得写入运行时快照');
  assert.equal(invalidations, 1,
    '畸形响应只能保留请求前的旧轮询失效，不能伪装成权威成功再次失效');
}

{
  const clearLegacyCursorsSource = extractFunction(schedulerSource, 'async function clearLegacyCursors(');
  const statusEvents = [];
  let invalidations = 0;
  let paints = 0;
  let polls = 0;
  let response = null;
  const token = { signal: new AbortController().signal };
  const clearLegacyCursors = new Function(
    'draft',
    'ui',
    'page',
    'clearLegacyBtn',
    'maintainStatus',
    'api',
    'schedulerStatusPoll',
    'paintSchedulerStatus',
    'pollSchedulerStatus',
    'isAbortError',
    'errorText',
    'requireSchedulerLegacyCursorCleanupResult',
    `${clearLegacyCursorsSource}; return clearLegacyCursors;`,
  )(
    { lastStatus: { legacy_cursor_cleanup_token: 'cleanup-token', running: false } },
    { async confirmDialog() { return true; } },
    {
      beginAction() { return token; },
      alive(candidate) { return candidate === token; },
      endAction(candidate) { return candidate === token; },
    },
    { disabled: false },
    { set(message, kind) { statusEvents.push({ message, kind }); } },
    { async post() { return response; } },
    { invalidate() { invalidations += 1; } },
    () => { paints += 1; },
    async () => { polls += 1; },
    () => false,
    (error, fallback) => error?.message || fallback,
    scheduler.requireSchedulerLegacyCursorCleanupResult,
  );

  await clearLegacyCursors();
  assert.notEqual(statusEvents.at(-1)?.kind, 'ok',
    '清理游标接口的 200 + null 不得误报“未验证游标已清理”');
  assert.match(statusEvents.at(-1)?.message || '', /响应无效|确认/,
    '畸形清理响应必须提示用户先确认状态，避免重复执行');
  assert.equal(paints, 0, '畸形清理响应不得把 null 投影到调度状态');
  assert.equal(invalidations, 0, '畸形清理响应不得伪装成权威状态使旧轮询失效');
  assert.equal(polls, 1, '可能已提交的畸形清理响应必须触发一次权威状态轮询');

  response = {
    ok: false,
    attempted: 2,
    target_count: 2,
    cleared: 1,
    failed_count: 1,
    local_action_after_commit_error: '有一个游标未能清理',
    scheduler: {},
  };
  await clearLegacyCursors();
  assert.equal(statusEvents.at(-1)?.kind, 'warn', '部分清理失败必须显示警告而不是成功');
  assert.equal(statusEvents.at(-1)?.message, '有一个游标未能清理');
  assert.equal(paints, 1, '合法部分失败响应必须更新权威调度状态');
  assert.equal(invalidations, 1, '合法部分失败响应必须失效旧状态轮询');
  assert.equal(polls, 2, '部分失败后必须再次轮询确认最终状态');

  response = {
    ok: true,
    attempted: 2,
    target_count: 2,
    cleared: 2,
    failed_count: 0,
    scheduler: {},
  };
  await clearLegacyCursors();
  assert.equal(statusEvents.at(-1)?.kind, 'ok', '完整成功才允许显示清理成功');
  assert.equal(paints, 2);
  assert.equal(invalidations, 2);
  assert.equal(polls, 2, '完整成功响应本身已含权威状态，不需要额外轮询');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

{
  const loadGroupsSource = extractFunction(schedulerSource, 'async function loadGroups(');
  const accountA = {
    id: 'scheduler-account',
    manual_key_account_fingerprint: 'scheduler-fingerprint-a',
  };
  const accountB = {
    id: 'scheduler-account',
    manual_key_account_fingerprint: 'scheduler-fingerprint-b',
  };
  let currentAccount = accountB;
  let response = {
    groups: [{ id: 'scheduler-old-group', name: 'scheduler-old-group' }],
    account_id: accountA.id,
    account_fingerprint: accountA.manual_key_account_fingerprint,
  };
  const requestUrls = [];
  const statusEvents = [];
  const draft = { groups: null, groupsLoading: false };
  let renders = 0;
  let actionRevision = 0;
  const accountScopeModule = await loader.load('js/shared/account-change-scope.js');
  const accountScope = accountScopeModule.createAccountChangeScope();
  const page = {
    requestContext(account) {
      return {
        account_id: account.id,
        expected_account_fingerprint: account.manual_key_account_fingerprint,
      };
    },
    beginAction() {
      return { revision: ++actionRevision, signal: new AbortController().signal };
    },
    alive() { return true; },
    endAction() { return true; },
  };
  const loadGroups = new Function(
    'page',
    'currentAccount',
    'currentAccountId',
    'currentAccountContextIdentity',
    'refreshGroupsBtn',
    'accountScope',
    'draft',
    'renderGroupPicker',
    'api',
    'status',
    'isAbortError',
    'requireGroupList',
    'errorText',
    'isDbMirrorFailure',
    'rememberDbMirrorAutoFailure',
    'dbMirrorDiagnosticsReady',
    'readDbMirrorAutoFailure',
    'clearDbMirrorAutoFailure',
    `let activeGroupAction = null; ${loadGroupsSource}; return loadGroups;`,
  )(
    page,
    () => currentAccount,
    () => currentAccount.id,
    () => `${currentAccount.id}|${currentAccount.manual_key_account_fingerprint}`,
    { disabled: false },
    accountScope,
    draft,
    () => { renders += 1; },
    {
      async get(url) {
        requestUrls.push(url);
        return response;
      },
    },
    { set(message, kind) { statusEvents.push([kind, message]); } },
    error => error?.name === 'AbortError' || error?.status === 499,
    requireGroupList,
    (error, fallback) => error?.message || fallback,
    () => false,
    () => null,
    () => false,
    () => null,
    () => false,
  );

  await loadGroups();
  const mismatchedUrl = new URL(requestUrls[0], 'http://127.0.0.1');
  assert.equal(
    mismatchedUrl.searchParams.get('expected_account_fingerprint'),
    accountB.manual_key_account_fingerprint,
    '调度器 B 的群列表请求必须把完整账号指纹交给服务端校验',
  );
  assert.equal(draft.groups, null,
    '没有合法身份升级时,A 指纹的 200 响应不得写入调度器 B 草稿');

  response = {
    groups: [{ id: 'scheduler-current-group', name: 'scheduler-current-group' }],
    account_id: accountB.id,
    account_fingerprint: accountB.manual_key_account_fingerprint,
  };
  await loadGroups();
  assert.equal(requestUrls.length, 2, '拒绝错账号响应后必须允许用户重新读取当前账号群列表');
  assert.equal(draft.groups?.length, 1, '精确匹配 B 的响应必须保留正常群列表路径');
  assert.equal(statusEvents.at(-1)?.[0], 'ok', '精确匹配 B 后必须投影成功状态');

  response = {
    groups: null,
    account_id: accountB.id,
    account_fingerprint: accountB.manual_key_account_fingerprint,
  };
  await loadGroups();
  assert.equal(draft.groups, null,
    '精确账号的畸形 groups 响应必须进入未读取错误态，不能采用成权威空列表');
  assert.equal(statusEvents.at(-1)?.[0], 'err',
    '畸形群列表响应必须显示可重试错误，不能误报已读取 0 个群');
  assert.ok(renders >= 4, '两次真实 loadGroups 必须分别进入 loading 和 finally 重画');
}

{
  const loadGroupsSource = extractFunction(schedulerSource, 'async function loadGroups(');
  const accountA = {
    id: 'scheduler-upgrade-account',
    manual_key_account_fingerprint: 'scheduler-upgrade-fingerprint-a',
  };
  const accountB = {
    id: 'scheduler-upgrade-account',
    account_aliases: ['scheduler-upgrade-account'],
    manual_key_account_fingerprint: 'scheduler-upgrade-fingerprint-b',
  };
  let currentAccount = accountA;
  const requestUrls = [];
  let refreshes = 0;
  let actionRevision = 0;
  let currentAction = null;
  const draft = { groups: null, groupsLoading: false };
  const accountScopeModule = await loader.load('js/shared/account-change-scope.js');
  const accountScope = accountScopeModule.createAccountChangeScope();
  const identity = () => `${currentAccount.id}|${currentAccount.manual_key_account_fingerprint}`;
  const page = {
    requestContext(account) {
      return {
        account_id: account.id,
        expected_account_fingerprint: account.manual_key_account_fingerprint,
      };
    },
    beginAction() {
      const token = { revision: ++actionRevision, signal: new AbortController().signal };
      currentAction = token;
      return token;
    },
    alive(token) { return currentAction === token; },
    endAction(token) {
      if (currentAction !== token) return false;
      currentAction = null;
      return true;
    },
    isActive() { return true; },
    async refreshAccounts({ forceDetect }) {
      assert.equal(forceDetect, true);
      refreshes += 1;
      currentAction = null;
      currentAccount = accountB;
      accountScope.switchTo(identity());
      draft.groups = null;
      draft.groupsLoading = false;
      return { accounts: [accountB], account: accountB, changed: true };
    },
  };
  let requestIndex = 0;
  const loadGroups = new Function(
    'page',
    'currentAccount',
    'currentAccountId',
    'currentAccountContextIdentity',
    'refreshGroupsBtn',
    'accountScope',
    'draft',
    'renderGroupPicker',
    'api',
    'status',
    'isAbortError',
    'refreshPublicAccountIdentityUpgrade',
    'requireGroupList',
    'isDbMirrorFailure',
    'rememberDbMirrorAutoFailure',
    'dbMirrorDiagnosticsReady',
    'readDbMirrorAutoFailure',
    'clearDbMirrorAutoFailure',
    `let activeGroupAction = null; ${loadGroupsSource}; return loadGroups;`,
  )(
    page,
    () => currentAccount,
    () => currentAccount.id,
    identity,
    { disabled: false },
    accountScope,
    draft,
    () => {},
    {
      async get(url) {
        requestUrls.push(url);
        requestIndex += 1;
        if (requestIndex === 1) {
          return {
            groups: [{ id: 'scheduler-upgrade-old-group' }],
            account_id: accountB.id,
            account_fingerprint: accountB.manual_key_account_fingerprint,
            account_identity_upgrade: {
              previous_fingerprint: accountA.manual_key_account_fingerprint,
              next_fingerprint: accountB.manual_key_account_fingerprint,
            },
            account: accountB,
          };
        }
        return {
          groups: [{ id: 'scheduler-upgrade-current-group' }],
          account_id: accountB.id,
          account_fingerprint: accountB.manual_key_account_fingerprint,
        };
      },
    },
    { set() {} },
    error => error?.name === 'AbortError' || error?.status === 499,
    refreshPublicAccountIdentityUpgrade,
    requireGroupList,
    () => false,
    () => null,
    () => false,
    () => null,
    () => false,
  );

  await loadGroups();
  assert.equal(refreshes, 1, '合法 A→B 升级只能刷新一次权威账号列表');
  assert.equal(requestUrls.length, 2, '升级后必须由 B 自动发起唯一一次群列表重读');
  assert.equal(
    new URL(requestUrls[0], 'http://127.0.0.1').searchParams.get('expected_account_fingerprint'),
    accountA.manual_key_account_fingerprint,
  );
  assert.equal(
    new URL(requestUrls[1], 'http://127.0.0.1').searchParams.get('expected_account_fingerprint'),
    accountB.manual_key_account_fingerprint,
  );
  assert.equal(draft.groups?.[0]?.id, 'scheduler-upgrade-current-group',
    'A 升级 payload 的群不得直接采用,最终草稿只能来自 B 重读');
}

// A 的群响应触发身份升级后，强制账号刷新可能挂起；用户此时切到无关 C，
// 旧刷新即使随后返回 unconfirmed，也不得把 A 的警告投影到 C 设置页。
{
  const loadGroupsSource = extractFunction(schedulerSource, 'async function loadGroups(');
  const accountA = {
    id: 'scheduler-upgrade-race-a',
    manual_key_account_fingerprint: 'a'.repeat(64),
  };
  const accountB = {
    id: accountA.id,
    account_aliases: [accountA.id],
    manual_key_account_fingerprint: 'b'.repeat(64),
  };
  const accountC = {
    id: 'scheduler-unrelated-c',
    manual_key_account_fingerprint: 'c'.repeat(64),
  };
  let currentAccount = accountA;
  let currentAction = null;
  let actionRevision = 0;
  const refresh = deferred();
  let notifyRefreshStarted;
  const refreshStarted = new Promise(resolve => { notifyRefreshStarted = resolve; });
  const statusEvents = [];
  const draft = { groups: null, groupsLoading: false };
  const accountScopeModule = await loader.load('js/shared/account-change-scope.js');
  const accountScope = accountScopeModule.createAccountChangeScope();
  const identity = () => `${currentAccount.id}|${currentAccount.manual_key_account_fingerprint}`;
  const page = {
    requestContext(account) {
      return {
        account_id: account.id,
        expected_account_fingerprint: account.manual_key_account_fingerprint,
      };
    },
    beginAction() {
      const controller = new AbortController();
      const token = { revision: ++actionRevision, controller, signal: controller.signal };
      currentAction = token;
      return token;
    },
    alive(token) { return currentAction === token; },
    endAction(token) {
      if (currentAction !== token) return false;
      currentAction = null;
      return true;
    },
    isActive() { return true; },
    async refreshAccounts() {
      notifyRefreshStarted();
      return refresh.promise;
    },
  };
  const loadGroups = new Function(
    'page',
    'currentAccount',
    'currentAccountId',
    'currentAccountContextIdentity',
    'refreshGroupsBtn',
    'accountScope',
    'draft',
    'renderGroupPicker',
    'api',
    'status',
    'isAbortError',
    'refreshPublicAccountIdentityUpgrade',
    'requireGroupList',
    'errorText',
    'isDbMirrorFailure',
    'rememberDbMirrorAutoFailure',
    'dbMirrorDiagnosticsReady',
    'readDbMirrorAutoFailure',
    'clearDbMirrorAutoFailure',
    `let activeGroupAction = null; ${loadGroupsSource}; return loadGroups;`,
  )(
    page,
    () => currentAccount,
    () => currentAccount.id,
    identity,
    { disabled: false },
    accountScope,
    draft,
    () => {},
    {
      async get() {
        return {
          groups: [{ id: 'scheduler-old-a-group' }],
          account_id: accountB.id,
          account_fingerprint: accountB.manual_key_account_fingerprint,
          account_identity_upgrade: {
            previous_fingerprint: accountA.manual_key_account_fingerprint,
            next_fingerprint: accountB.manual_key_account_fingerprint,
          },
          account: accountB,
        };
      },
    },
    { set(message, kind) { statusEvents.push([kind, message]); } },
    error => error?.name === 'AbortError' || error?.status === 499,
    refreshPublicAccountIdentityUpgrade,
    requireGroupList,
    (error, fallback) => error?.message || fallback,
    () => false,
    () => null,
    () => false,
    () => null,
    () => false,
  );

  const pendingA = loadGroups();
  await refreshStarted;
  currentAction?.controller.abort(new Error('账号上下文已变化'));
  currentAction = null;
  currentAccount = accountC;
  accountScope.switchTo(identity());
  draft.groups = null;
  draft.groupsLoading = false;
  refresh.resolve({ accounts: [accountC], account: accountC, changed: false });
  await pendingA;

  assert.deepEqual(statusEvents, [],
    'A 身份刷新晚到 unconfirmed 不得把旧账号警告写入无关 C 设置页');
  assert.equal(draft.groups, null, 'A 升级响应不得写入 C 群列表草稿');
}

{
  const loadGroupsSource = extractFunction(schedulerSource, 'async function loadGroups(');
  const accountA = {
    id: 'scheduler-race-account',
    manual_key_account_fingerprint: 'scheduler-race-fingerprint-a',
  };
  const accountB = {
    id: 'scheduler-race-account',
    manual_key_account_fingerprint: 'scheduler-race-fingerprint-b',
  };
  let currentAccount = accountA;
  const responses = [];
  const requestUrls = [];
  const draft = { groups: null, groupsLoading: false };
  let actionRevision = 0;
  let currentAction = null;
  const accountScopeModule = await loader.load('js/shared/account-change-scope.js');
  const accountScope = accountScopeModule.createAccountChangeScope();
  const identity = () => `${currentAccount.id}|${currentAccount.manual_key_account_fingerprint}`;
  const page = {
    requestContext(account) {
      return {
        account_id: account.id,
        expected_account_fingerprint: account.manual_key_account_fingerprint,
      };
    },
    beginAction() {
      const token = { revision: ++actionRevision, signal: new AbortController().signal };
      currentAction = token;
      return token;
    },
    alive(token) { return currentAction === token; },
    endAction(token) {
      if (currentAction !== token) return false;
      currentAction = null;
      return true;
    },
  };
  const loadGroups = new Function(
    'page',
    'currentAccount',
    'currentAccountId',
    'currentAccountContextIdentity',
    'refreshGroupsBtn',
    'accountScope',
    'draft',
    'renderGroupPicker',
    'api',
    'status',
    'isAbortError',
    'requireGroupList',
    'isDbMirrorFailure',
    'rememberDbMirrorAutoFailure',
    'dbMirrorDiagnosticsReady',
    'readDbMirrorAutoFailure',
    'clearDbMirrorAutoFailure',
    `let activeGroupAction = null; ${loadGroupsSource}; return loadGroups;`,
  )(
    page,
    () => currentAccount,
    () => currentAccount.id,
    identity,
    { disabled: false },
    accountScope,
    draft,
    () => {},
    {
      get(url) {
        requestUrls.push(url);
        const response = deferred();
        responses.push(response);
        return response.promise;
      },
    },
    { set() {} },
    error => error?.name === 'AbortError' || error?.status === 499,
    requireGroupList,
    () => false,
    () => null,
    () => false,
    () => null,
    () => false,
  );

  const pendingA = loadGroups();
  assert.equal(responses.length, 1, 'A 必须先进入在途群列表请求');
  currentAction = null;
  currentAccount = accountB;
  accountScope.switchTo(identity());
  draft.groupsLoading = false;
  draft.groups = null;
  const pendingB = loadGroups();
  assert.equal(responses.length, 2, '同 ID/B 指纹必须能立即启动自己的群列表请求');
  const actionB = currentAction;

  responses[0].resolve({
    groups: [{ id: 'scheduler-race-old-group', name: 'scheduler-race-old-group' }],
    account_id: accountA.id,
    account_fingerprint: accountA.manual_key_account_fingerprint,
  });
  await pendingA;
  assert.strictEqual(currentAction, actionB, 'A 的晚到 finally 不得结束 B 当前 action');
  assert.equal(draft.groupsLoading, true, 'A 的晚到 finally 不得清掉 B 的 loading');
  assert.equal(draft.groups, null, 'A 的晚到响应不得写入 B 草稿');

  responses[1].resolve({
    groups: [{ id: 'scheduler-race-current-group', name: 'scheduler-race-current-group' }],
    account_id: accountB.id,
    account_fingerprint: accountB.manual_key_account_fingerprint,
  });
  await pendingB;
  assert.equal(currentAction, null, 'B 正常完成后必须只释放自己的 action');
  assert.equal(draft.groupsLoading, false, 'B 正常完成后必须结束自己的 loading');
  assert.equal(draft.groups?.[0]?.id, 'scheduler-race-current-group',
    '只有 B 响应可以成为当前调度群列表');
  assert.equal(
    new URL(requestUrls[0], 'http://127.0.0.1').searchParams.get('expected_account_fingerprint'),
    accountA.manual_key_account_fingerprint,
  );
  assert.equal(
    new URL(requestUrls[1], 'http://127.0.0.1').searchParams.get('expected_account_fingerprint'),
    accountB.manual_key_account_fingerprint,
  );
}

{
  const fetchStatusSource = extractFunction(schedulerSource, 'async fetchStatus({ signal })')
    .replace('async fetchStatus({ signal })', 'async function fetchStatus({ signal })');
  const account = {
    id: 'scheduler-shared-scope-account',
    manual_key_account_fingerprint: 'scheduler-shared-scope-fingerprint',
  };
  const identity = `${account.id}|${account.manual_key_account_fingerprint}`;
  const accountScopeModule = await loader.load('js/shared/account-change-scope.js');
  const accountScope = accountScopeModule.createAccountChangeScope();
  const groupLoadToken = accountScope.ensure(identity);
  const response = deferred();
  const fetchStatus = new Function(
    'page',
    'accountScope',
    'currentAccountId',
    'currentAccountContextIdentity',
    'api',
    'isAbortError',
    'requireSchedulerStatusResult',
    `${fetchStatusSource}; return fetchStatus;`,
  )(
    {
      softToken() { return { signal: new AbortController().signal }; },
      alive() { return true; },
    },
    accountScope,
    () => account.id,
    () => identity,
    { get(_path, options) {
      assert.strictEqual(options.signal, requestController.signal,
        '真实 scheduler status caller 必须把 poller 请求 signal 交给 API');
      return response.promise;
    } },
    error => error?.name === 'AbortError' || error?.status === 499,
    scheduler.requireSchedulerStatusResult,
  );

  const requestController = new AbortController();
  const pendingStatus = fetchStatus({ signal: requestController.signal });
  assert.equal(
    accountScope.isCurrent(groupLoadToken, identity),
    true,
    '同账号 scheduler status 轮询不得把共享 scope 从完整 identity 降级成纯 ID 并误杀在途群列表',
  );
  response.resolve({ ok: true, scheduler: { running: false } });
  const statusResult = await pendingStatus;
  assert.equal(accountScope.isCurrent(statusResult.accountToken, identity), true,
    'scheduler status 响应必须继续归属于当前完整账号身份');
}

{
  const requests = [];
  const applied = [];
  const poll = scheduler.createLatestSchedulerStatusPoll({
    fetchStatus({ signal } = {}) {
      const response = deferred();
      requests.push({ ...response, signal });
      return response.promise;
    },
    applyStatus(payload) {
      applied.push(payload.id);
    },
  });

  const accountA = poll.request();
  assert.equal(requests.length, 1, 'A 调度状态轮询必须先发起唯一请求');
  assert.equal(requests[0].signal?.aborted, false,
    'A 请求必须持有协调器自己的可取消 signal');
  poll.invalidate();
  assert.equal(requests[0].signal?.aborted, true,
    '账号上下文失效必须立即取消 A 在途状态 I/O');
  const accountB = poll.request();
  assert.strictEqual(accountB, accountA,
    'B 请求必须加入同一收敛 Promise，保持至多一个请求在途');
  requests[0].reject(Object.assign(new Error('A 已取消'), { name: 'AbortError', status: 499 }));
  await flush();
  assert.equal(requests.length, 2,
    'A 响应取消后必须立即发起排队的 B 状态请求');
  assert.equal(requests[1].signal?.aborted, false,
    'B 必须使用新的可用 signal');
  requests[1].resolve({ id: 'account-b-current' });
  assert.equal(await accountB, true);
  assert.deepEqual(applied, ['account-b-current'],
    '账号换代后只能投影 B 的调度状态');

  const disposing = poll.request();
  assert.equal(requests.length, 3, '销毁场景必须先启动当前状态请求');
  poll.dispose();
  assert.equal(requests[2].signal?.aborted, true,
    '设置页卸载销毁 poller 时必须取消当前调度状态 I/O');
  requests[2].resolve({ id: 'late-after-dispose' });
  assert.equal(await disposing, false);
  assert.deepEqual(applied, ['account-b-current'],
    '销毁后的 late resolve 不得投影调度状态');
}

{
  const responses = [];
  const applied = [];
  let boundaryRequest = null;
  let poll;
  poll = scheduler.createLatestSchedulerStatusPoll({
    fetchStatus() {
      const response = deferred();
      responses.push(response);
      return response.promise;
    },
    applyStatus(payload) {
      applied.push(payload.id);
      if (payload.id === 'settling-first') {
        queueMicrotask(() => { boundaryRequest = poll.request(); });
      }
    },
  });

  const first = poll.request();
  responses[0].resolve({ id: 'settling-first' });
  await flush();
  assert.equal(responses.length, 2,
    '结算 finally 前到达的刷新不得只留下重跑标记而丢失请求');
  assert.equal(boundaryRequest, first,
    '结算边界到达的调用方必须加入同一条收敛 Promise');
  responses[1].resolve({ id: 'settling-latest' });
  assert.equal(await first, true,
    '首个调用方必须等待结算边界补跑完成');
  assert.deepEqual(applied, ['settling-first', 'settling-latest']);
  poll.dispose();
}

{
  const responses = [];
  const applied = [];
  const errors = [];
  const poll = scheduler.createLatestSchedulerStatusPoll({
    fetchStatus() {
      const response = deferred();
      responses.push(response);
      return response.promise;
    },
    applyStatus(payload) {
      applied.push(payload.id);
    },
    onError(error) {
      errors.push(error.message);
    },
  });

  const first = poll.request();
  assert.equal(responses.length, 1, '首次轮询必须立即发起一次请求');
  const queued = poll.request();
  poll.request();
  assert.equal(queued, first, '并发轮询必须加入当前单飞任务');
  assert.equal(responses.length, 1, '在途期间的多次轮询只能合并为一次重跑');

  responses[0].resolve({ id: 'stale-before-maintenance' });
  await flush();
  assert.equal(responses.length, 2, '在途期间收到轮询要求后必须补跑一次最新请求');
  assert.deepEqual(applied, [], '被更新轮询取代的旧响应不得写入页面');
  responses[1].resolve({ id: 'latest-after-maintenance' });
  assert.equal(await first, true, '最新重跑成功后整轮请求必须成功收敛');
  assert.deepEqual(applied, ['latest-after-maintenance'], '只允许最后一次状态响应写入页面');

  const invalidated = poll.request();
  assert.equal(responses.length, 3);
  poll.invalidate();
  responses[2].resolve({ id: 'stale-after-authoritative-action' });
  assert.equal(await invalidated, false, '权威操作响应应使更早的轮询响应失效');
  assert.deepEqual(applied, ['latest-after-maintenance'], '失效的旧轮询不得覆盖权威操作状态');

  const failed = poll.request();
  poll.request();
  responses[3].reject(new Error('superseded poll failure'));
  await flush();
  assert.equal(responses.length, 5, '被取代的失败请求之后仍须兑现排队的最新轮询');
  assert.deepEqual(errors, [], '被取代请求的错误不得覆盖当前状态提示');
  responses[4].resolve({ id: 'recovered-latest' });
  assert.equal(await failed, true);
  assert.deepEqual(applied, ['latest-after-maintenance', 'recovered-latest']);

  const standaloneFailure = poll.request();
  responses[5].reject(new Error('current poll failure'));
  assert.equal(await standaloneFailure, false);
  assert.deepEqual(errors, ['current poll failure'], '当前轮询失败必须交给受控错误处理');

  const disposing = poll.request();
  poll.dispose();
  responses[6].resolve({ id: 'after-dispose' });
  assert.equal(await disposing, false);
  assert.deepEqual(applied, ['latest-after-maintenance', 'recovered-latest'], '销毁后的响应不得写页面');
  assert.equal(await poll.request(), false, '销毁后不得再发请求');
  assert.equal(responses.length, 7);
}

// 已有刷新排队后被权威动作/账号换代失效时,旧排队标记也必须一起丢弃;
// 否则旧响应晚到会在没有新的调用者请求时凭空启动下一次状态读取。
{
  const responses = [];
  const applied = [];
  const poll = scheduler.createLatestSchedulerStatusPoll({
    fetchStatus() {
      const response = deferred();
      responses.push(response);
      return response.promise;
    },
    applyStatus(payload) {
      applied.push(payload.id);
    },
  });

  poll.request();
  poll.request();
  assert.equal(responses.length, 1, '失效前的重复刷新必须先合并为一条在途请求');
  poll.invalidate();
  responses[0].resolve({ id: 'late-invalidated-status' });
  await flush();
  const requestCountAfterLateResponse = responses.length;
  poll.dispose();
  assert.equal(requestCountAfterLateResponse, 1,
    '失效后的旧响应不得凭遗留排队标记再发起状态请求');
  assert.deepEqual(applied, [], '失效后的旧状态不得投影到页面');
}

// A 群列表响应进入身份升级等待后,如果 B 已启动新的群列表动作接管,
// A 的升级完成不得再递归发起第三次请求或覆盖 B 的动作所有权。
{
  const loadGroupsSource = extractFunction(schedulerSource, 'async function loadGroups(');
  const accountA = {
    id: 'scheduler-upgrade-owner-account',
    manual_key_account_fingerprint: 'a'.repeat(64),
  };
  const accountB = {
    id: accountA.id,
    account_aliases: [accountA.id],
    manual_key_account_fingerprint: 'b'.repeat(64),
  };
  let currentAccount = accountA;
  let actionRevision = 0;
  let currentAction = null;
  const accountScopeModule = await loader.load('js/shared/account-change-scope.js');
  const accountScope = accountScopeModule.createAccountChangeScope();
  const identity = () => `${currentAccount.id}|${currentAccount.manual_key_account_fingerprint}`;
  const refresh = deferred();
  const bResponse = deferred();
  const requestUrls = [];
  const draft = { groups: null, groupsLoading: false };
  const page = {
    requestContext(account) {
      return {
        account_id: account.id,
        expected_account_fingerprint: account.manual_key_account_fingerprint,
      };
    },
    beginAction() {
      const controller = new AbortController();
      const token = { revision: ++actionRevision, controller, signal: controller.signal };
      currentAction = token;
      return token;
    },
    alive(token) { return currentAction === token; },
    endAction(token) {
      if (currentAction !== token) return false;
      currentAction = null;
      return true;
    },
    isActive() { return true; },
    async refreshAccounts() {
      return refresh.promise;
    },
  };
  let requestIndex = 0;
  const loadGroups = new Function(
    'page',
    'currentAccount',
    'currentAccountId',
    'currentAccountContextIdentity',
    'refreshGroupsBtn',
    'accountScope',
    'draft',
    'renderGroupPicker',
    'api',
    'status',
    'isAbortError',
    'refreshPublicAccountIdentityUpgrade',
    'requireGroupList',
    'errorText',
    'isDbMirrorFailure',
    'rememberDbMirrorAutoFailure',
    'dbMirrorDiagnosticsReady',
    'readDbMirrorAutoFailure',
    'clearDbMirrorAutoFailure',
    `let activeGroupAction = null; ${loadGroupsSource}; return loadGroups;`,
  )(
    page,
    () => currentAccount,
    () => currentAccount.id,
    identity,
    { disabled: false },
    accountScope,
    draft,
    () => {},
    {
      async get(url) {
        requestUrls.push(url);
        requestIndex += 1;
        if (requestIndex === 1) {
          return {
            groups: [{ id: 'scheduler-upgrade-owner-old-group' }],
            account_id: accountB.id,
            account_fingerprint: accountB.manual_key_account_fingerprint,
            account_identity_upgrade: {
              previous_fingerprint: accountA.manual_key_account_fingerprint,
              next_fingerprint: accountB.manual_key_account_fingerprint,
            },
            account: accountB,
          };
        }
        if (requestIndex === 2) return bResponse.promise;
        return {
          groups: [{ id: 'scheduler-upgrade-owner-stale-group' }],
          account_id: accountB.id,
          account_fingerprint: accountB.manual_key_account_fingerprint,
        };
      },
    },
    { set() {} },
    error => error?.name === 'AbortError' || error?.status === 499,
    refreshPublicAccountIdentityUpgrade,
    requireGroupList,
    (error, fallback) => error?.message || fallback,
    () => false,
    () => null,
    () => false,
    () => null,
    () => false,
  );

  const pendingA = loadGroups();
  await flush();
  assert.equal(requestUrls.length, 1, 'A 首次响应必须只发起一个群列表请求');

  currentAccount = accountB;
  accountScope.switchTo(identity());
  const pendingB = loadGroups();
  assert.equal(requestUrls.length, 2, 'B 接管后必须发起自己的群列表请求');

  refresh.resolve({ accounts: [accountB], account: accountB, changed: true });
  await flush();
  assert.equal(requestUrls.length, 2,
    'A 的身份升级晚到不得在 B 已接管后递归发起第三次群列表请求');

  bResponse.resolve({
    groups: [{ id: 'scheduler-upgrade-owner-current-group' }],
    account_id: accountB.id,
    account_fingerprint: accountB.manual_key_account_fingerprint,
  });
  await Promise.all([pendingA, pendingB]);
  assert.deepEqual(draft.groups, [{ id: 'scheduler-upgrade-owner-current-group' }],
    'B 的群列表必须保留为最终草稿');
}

assert.ok(
  schedulerSource.includes('const schedulerStatusPoll = createLatestSchedulerStatusPoll({')
    && schedulerSource.includes('return schedulerStatusPoll.request();')
    && schedulerSource.includes('schedulerStatusPoll.invalidate();')
    && schedulerSource.includes('schedulerStatusPoll.dispose();')
    && (schedulerSource.match(/void pollSchedulerStatus\(\);/g) || []).length >= 6,
  '生产调度页必须接入最新状态轮询器,并在权威响应、账号切换和销毁时失效旧请求',
);
assert.match(
  settingsSource,
  /for \(const section of sections\) \{\s*try \{ section\.destroy\?\.\(\); \} catch \{\}\s*\}/,
  '设置页卸载必须销毁各分区持有的后台协调器',
);
assert.match(
  schedulerSource,
  /async function runOnce\(\) \{[\s\S]*?const confirmed = await ui\.confirmDialog\([\s\S]*?if \(!confirmed\) return;\s*const revision = page\.getBaseRevision\(\);/,
  '手动检查必须在用户确认后读取当前设置 revision,不能提交弹框打开前的旧快照',
);
assert.match(
  schedulerSource,
  /async function clearLegacyCursors\(\) \{[\s\S]*?const confirmed = await ui\.confirmDialog\([\s\S]*?if \(!confirmed\) return;\s*const tokenValue = String\(draft\.lastStatus\?\.legacy_cursor_cleanup_token \|\| ''\)\.trim\(\);/,
  '清理游标必须在用户确认后读取当前 cleanup token,不能提交轮询前的旧令牌',
);

console.log('web settings scheduler action state tests passed');
