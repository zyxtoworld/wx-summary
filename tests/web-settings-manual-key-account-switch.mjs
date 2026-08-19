import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { settingsAccountSwitchBlockedMessage } from '../src/web/public/js/shared/settings-account-switch.js';
import { invalidateSettingsActionsForAccountChange } from '../src/web/public/js/pages/settings/account-context.js';

const [settingsSource, privacySource, schedulerSource, mainSource] = await Promise.all([
  readFile(new URL('../src/web/public/js/pages/settings/index.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/js/pages/settings/privacy.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/js/pages/settings/scheduler.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
]);

assert.match(settingsSource, /drafts:\s*createSettingsDraftState\(/,
  '设置页必须用统一生命周期记录普通草稿与账号级草稿');
assert.match(settingsSource, /accountDraftCount: state\.drafts\.accountScopedCount\(\)/,
  '设置页账号切换 guard 必须从统一状态统计账号级草稿');
assert.match(settingsSource, /markAccountScopedDraft\(sectionId, dirty\)/,
  '设置页必须向分区提供账号级草稿登记接口');
assert.match(settingsSource, /state\.drafts\.markAccountScoped\(sectionId, dirty\)/,
  '账号级草稿登记必须接入统一草稿生命周期');
assert.match(privacySource, /markAccountScopedDraft(?:\?\.)?\(['"]manual-key['"]/,
  '手动数据库密钥草稿必须登记为账号级草稿');

assert.match(settingsSource,
  /import \{[\s\S]*createSettingsAccountContextTracker,[\s\S]*invalidateSettingsActionsForAccountChange,[\s\S]*\} from '\.\/account-context\.js';/,
  '设置页必须接入账号上下文 action 失效边界');
assert.match(settingsSource,
  /const change = state\.accountContext\.update\(account\);[\s\S]*?if \(!change\.changed\) return;[\s\S]*?invalidateSettingsActionsForAccountChange\(state,[\s\S]*?onActionsReleased: syncBusy,[\s\S]*?notifySettingsSectionsAccountChanged\(sections, account, previous, change\)/,
  '真实账号上下文变化必须先释放进行中的 action 并重算 busy，再通知分区');

{
  const state = { destroyed: false, generation: 7, actions: new Set() };
  const controller = new AbortController();
  const token = { generation: state.generation, controller };
  state.actions.add(token);
  let staleResponseApplied = 0;
  const lateResponse = Promise.resolve({ manual_key: 'account-a-response' });

  assert.equal(invalidateSettingsActionsForAccountChange(state), 1,
    '账号上下文变化必须使当前 action 失效并中止其请求');
  assert.equal(state.generation, 8,
    '账号上下文变化必须推进页面 action generation');
  assert.equal(controller.signal.aborted, true,
    '账号上下文变化必须 abort 旧 action 的 controller');

  await lateResponse;
  const pageAlive = candidate => !state.destroyed
    && candidate.generation === state.generation;
  if (pageAlive(token)) staleResponseApplied += 1;
  assert.equal(staleResponseApplied, 0,
    '旧账号响应晚到时不得通过 page.alive 应用到当前页面');
assert.equal(state.actions.has(token), false,
  '账号变化必须同步释放旧 action，不能等待可能永不返回的 finally');
}

// 生产 saveSection 的真实收尾边界：PUT 忽略 abort 且在账号代次变化后晚到时,
// 旧结果不得再次 adopt 到当前设置文档。
function extractAsyncFunction(source, name) {
  const marker = `async function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `生产设置页必须包含 ${name}`);
  const signatureEnd = source.indexOf(') {', start);
  assert.ok(signatureEnd > start, `${name} 必须有函数体`);
  const open = signatureEnd + 2;
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
  throw new Error(`${name} 函数体未闭合`);
}

const saveSectionSource = extractAsyncFunction(settingsSource, 'saveSection');
const saveSectionFactory = new Function(
  'api',
  'writeSettingsPatch',
  'state',
  'alive',
  'adoptSettingsDocument',
  'adoptSaveResult',
  `${saveSectionSource}; return saveSection;`,
);
const saveState = { destroyed: false, generation: 11 };
const saveController = new AbortController();
const saveToken = { generation: saveState.generation, signal: saveController.signal };
let latestAdopts = 0;
let resultAdopts = 0;
const staleSaveResult = { settings: { settings_revision: 'rev-account-a-save' } };
const saveSection = saveSectionFactory(
  {},
  async ({ onLatest }) => {
    onLatest({ settings_revision: 'rev-account-a-before-switch' });
    saveState.generation = 12;
    saveController.abort(new DOMException('账号上下文已变化', 'AbortError'));
    return staleSaveResult;
  },
  saveState,
  candidate => !saveState.destroyed && candidate.generation === saveState.generation,
  () => { latestAdopts += 1; },
  () => { resultAdopts += 1; },
);
const returnedSaveResult = await saveSection(
  { privacy: { browser_clipboard_image: false } },
  { signal: saveToken.signal, ownerToken: saveToken },
);
assert.equal(returnedSaveResult, staleSaveResult, 'saveSection 仍应把原始结果交给调用方决定 UI 行为');
assert.equal(latestAdopts, 1, '账号切换发生在 PUT 之后时,切换前已采用的 latest 快照可保留');
assert.equal(resultAdopts, 0,
  '账号代次变化后晚到的保存结果不得再次 adopt 到当前设置文档');

// 清除动作的确认框期间仍可发生程序化账号上下文变化。生产函数必须在
// 确认返回后重新核对身份,不能把确认前捕获的 A 上下文提交到 B。
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

// 手动密钥验证本身可能把同一账号从 fingerprint A 升级到 B。验证 caller
// 必须把升级交给原 action handoff；刷新确认 B 后，已验证草稿也必须绑定 B，
// 不能继续携带旧 A fingerprint，也不能要求用户无故重新粘贴密钥。
{
  const validateManualKeySource = extractAsyncFunction(privacySource, 'validateManualKey');
  const fingerprintA = 'e'.repeat(64);
  const fingerprintB = 'f'.repeat(64);
  const accountId = 'settings-validation-upgrade';
  const token = { generation: 3, signal: new AbortController().signal };
  const secret = 'manual-key-validation-upgrade';
  const keyInput = { value: secret };
  const saveKeyBtn = { disabled: true };
  const draft = { validatedKey: null };
  const statuses = [];
  const queued = [];
  const appliedSettings = [];
  let currentContext = { accountId, fingerprint: fingerprintA };
  let syncDraftCalls = 0;
  const result = {
    validation_ok: true,
    key: { message_db_verified: true },
    account_identity_upgrade: {
      previous_fingerprint: fingerprintA,
      next_fingerprint: fingerprintB,
    },
    account: { id: accountId, manual_key_account_fingerprint: fingerprintB },
    account_id: accountId,
    account_fingerprint: fingerprintB,
    settings: { settings_revision: 'rev-upgrade-B', provider: 'fixture-provider' },
    settings_revision: 'rev-upgrade-B',
  };
  const validateManualKey = new Function(
    'keyInput',
    'keyStatus',
    'validationAccountContext',
    'createWechatStatusProgressId',
    'page',
    'validateKeyBtn',
    'saveKeyBtn',
    'scanKeyBtn',
    'startProgressPolling',
    'api',
    'MANUAL_VALIDATION_TIMEOUT_MS',
    'draft',
    'syncManualKeyDraftState',
    'validationBox',
    'errorText',
    'stopProgressPolling',
    'isAbortError',
    'isDbMirrorFailure',
    'rememberDbMirrorAutoFailure',
    'clearDbMirrorAutoFailure',
    `${validateManualKeySource}; return validateManualKey;`,
  )(
    keyInput,
    { set(text, kind) { statuses.push({ text, kind }); } },
    () => currentContext,
    () => 'validation-progress-id',
    {
      beginAction() { return token; },
      alive(candidate) { return candidate === token; },
      getBaseRevision() { return ''; },
      applySettingsPayload(settings) { appliedSettings.push(settings); },
      queueAccountIdentityUpgrade(payload, ownerToken, callbacks) {
        queued.push({ payload, ownerToken, callbacks });
        return true;
      },
      isActive() { return true; },
      isBusy() { return false; },
      endAction() {},
      markStale() {},
    },
    {},
    saveKeyBtn,
    {},
    () => ({}),
    { post: async () => result },
    60_000,
    draft,
    () => { syncDraftCalls += 1; },
    { hidden: false },
    error => error?.message || 'validation failed',
    () => {},
    error => error?.name === 'AbortError' || error?.status === 499,
    () => false,
    () => null,
    () => false,
  );

  await validateManualKey();
  assert.equal(appliedSettings.length, 0,
    '账号身份升级确认前不得把响应设置文档采用到旧 fingerprint 上下文');
  assert.equal(queued.length, 1,
    '验证响应的账号身份升级必须绑定原 validation action token');
  assert.strictEqual(queued[0].payload, result);
  assert.strictEqual(queued[0].ownerToken, token);
  assert.equal(draft.validatedKey, null,
    'B 身份刷新确认前不得把验证结果错误绑定旧 A fingerprint');
  assert.equal(saveKeyBtn.disabled, true,
    '账号身份刷新确认前不得允许提交旧上下文保存');

  currentContext = { accountId, fingerprint: fingerprintB };
  queued[0].callbacks.onUpgraded(result.account);
  assert.deepEqual(appliedSettings, [result.settings],
    '身份刷新确认后才允许采用响应设置文档,且只能采用一次');
  assert.deepEqual(draft.validatedKey, { text: secret, accountId, fingerprint: fingerprintB },
    '身份刷新确认后必须把已验证密钥绑定目标 B fingerprint');
  assert.equal(keyInput.value, secret,
    '内部身份升级不得让用户重新粘贴刚验证通过的密钥');
  assert.equal(saveKeyBtn.disabled, false,
    'B 上下文确认后必须恢复保存入口');
  assert.ok(syncDraftCalls >= 2,
    '等待升级和确认升级都必须同步账号级草稿门禁');
  assert.match(statuses.at(-1)?.text || '', /验证通过/,
    'B 上下文确认后必须恢复明确验证成功状态');
}

assert.match(mainSource,
  /account:\s*responsePublicAccount,[\s\S]*?account_fingerprint:\s*responsePublicAccount\?\.manual_key_account_fingerprint\s*\|\|\s*null,[\s\S]*?account_identity_upgrade:/,
  '手动密钥验证身份升级响应必须回显共享证明校验所需的公开账号 fingerprint');

// 真实 validateManualKey caller 的 deferred owner 合同:账号上下文换代后,
// API 即使忽略 abort 仍以普通 resolve/reject 晚到,也不得把 A 的验证结果或错误
// 投影到当前上下文;自己的进度轮询和 action 必须各自只收尾一次。
{
  const validateManualKeySource = extractAsyncFunction(privacySource, 'validateManualKey');
  const runLateValidation = async ({ reject = false } = {}) => {
    const accountContext = { accountId: 'account-a', fingerprint: 'a'.repeat(64) };
    const actionController = new AbortController();
    const token = { signal: actionController.signal };
    const gate = deferred();
    const requestStarted = deferred();
    const statuses = [];
    const appliedSettings = [];
    const draft = { validatedKey: null };
    const keyInput = { value: 'late-validation-secret' };
    const saveKeyBtn = { disabled: true };
    const validationBox = { hidden: false };
    const validationStops = [];
    let activeToken = token;
    let endCalls = 0;
    const page = {
      beginAction() { return token; },
      alive(candidate) { return candidate === activeToken; },
      getBaseRevision() { return ''; },
      applySettingsPayload(settings) { appliedSettings.push(settings); },
      isActive() { return true; },
      isBusy() { return true; },
      endAction(candidate) {
        if (candidate === token) endCalls += 1;
      },
    };
    const validateManualKey = new Function(
      'keyInput', 'keyStatus', 'validationAccountContext',
      'createWechatStatusProgressId', 'page', 'validateKeyBtn', 'saveKeyBtn',
      'scanKeyBtn', 'startProgressPolling', 'api', 'MANUAL_VALIDATION_TIMEOUT_MS',
      'draft', 'syncManualKeyDraftState', 'validationBox', 'errorText',
      'stopProgressPolling', 'isAbortError',
      'isDbMirrorFailure', 'rememberDbMirrorAutoFailure', 'clearDbMirrorAutoFailure',
      `${validateManualKeySource}; return validateManualKey;`,
    )(
      keyInput,
      { set(text, kind) { statuses.push({ text, kind }); } },
      () => accountContext,
      () => 'validation-progress-id-late',
      page,
      { disabled: false },
      saveKeyBtn,
      { disabled: false },
      () => {
        const pollState = { stop() { validationStops.push('stop'); } };
        return pollState;
      },
      { post() { requestStarted.resolve(); return gate.promise; } },
      60_000,
      draft,
      () => {},
      validationBox,
      error => error?.message || 'validation failed',
      pollState => pollState?.stop?.(),
      error => error?.name === 'AbortError' || error?.status === 499,
      () => false,
      () => null,
      () => false,
    );

    const pending = validateManualKey();
    await requestStarted.promise;
    activeToken = null;
    actionController.abort(new Error('账号上下文已变化'));
    gate[reject ? 'reject' : 'resolve'](reject
      ? new Error('A 验证结果未知')
      : {
        validation_ok: true,
        key: { message_db_verified: true },
        settings: { settings_revision: 'rev-a-late' },
      });
    await pending;
    return { statuses, appliedSettings, draft, validationBox, validationStops, endCalls };
  };

  const lateResolved = await runLateValidation();
  assert.deepEqual(lateResolved.appliedSettings, [],
    '账号换代后普通 late resolve 不得采用旧账号设置文档');
  assert.equal(lateResolved.draft.validatedKey, null,
    '账号换代后普通 late resolve 不得留下旧账号已验证密钥草稿');
  assert.equal(lateResolved.statuses.some(item => /验证通过|验证未通过/.test(item.text)), false,
    '账号换代后普通 late resolve 不得投影旧账号验证状态');
  assert.equal(lateResolved.validationStops.length, 1,
    'late resolve 必须只停止自己的进度轮询一次');
  assert.equal(lateResolved.endCalls, 1,
    'late resolve 必须只结束自己的验证 action 一次');

  const lateRejected = await runLateValidation({ reject: true });
  assert.deepEqual(lateRejected.appliedSettings, [],
    '账号换代后普通 late reject 不得采用旧账号设置文档');
  assert.equal(lateRejected.draft.validatedKey, null,
    '账号换代后普通 late reject 不得写入旧账号已验证密钥草稿');
  assert.equal(lateRejected.statuses.some(item => item.text.includes('A 验证结果未知')), false,
    '账号换代后普通 late reject 不得把旧错误投影到新上下文');
  assert.equal(lateRejected.validationStops.length, 1,
    'late reject 必须只停止自己的进度轮询一次');
  assert.equal(lateRejected.endCalls, 1,
    'late reject 必须只结束自己的验证 action 一次');
}

{
  const clearManualKeySource = extractAsyncFunction(privacySource, 'clearManualKey');
  const confirmation = deferred();
  const accountA = { id: 'account-a', manual_key_account_fingerprint: 'a'.repeat(64) };
  const accountB = { id: 'account-b', manual_key_account_fingerprint: 'b'.repeat(64) };
  let currentAccount = accountA;
  let currentWechat = { manual_key_account_ids: ['account-a'] };
  const submitted = [];
  const token = { generation: 2, signal: new AbortController().signal };
  const requestContext = account => ({
    account_id: account.id,
    account_aliases: [account.id],
    account_fingerprint: account.manual_key_account_fingerprint,
    expected_account_fingerprint: account.manual_key_account_fingerprint,
  });
  const clearManualKey = new Function(
    'page',
    'ui',
    'currentAccount',
    'currentAccountId',
    'wechat',
    'keyStatus',
    'draft',
    'paintKeyState',
    'clearKeyBtn',
    'saveKeyBtn',
    'validateKeyBtn',
    `${clearManualKeySource}; return clearManualKey;`,
  )(
    {
      requestContext,
      beginAction() { return token; },
      saveSection(patch, options) {
        submitted.push({ patch, options });
        return Promise.resolve({ settings: {} });
      },
      alive() { return true; },
      endAction() {},
      saveSummaryText() { return 'cleared'; },
      saveHasWarnings() { return false; },
    },
    { confirmDialog: () => confirmation.promise },
    () => currentAccount,
    () => String(currentAccount.id),
    () => currentWechat,
    { set() {} },
    { validatedKey: null },
    () => {},
    {},
    {},
    {},
  );

  const pendingClear = clearManualKey();
  await Promise.resolve();
  currentAccount = accountB;
  currentWechat = { manual_key_account_ids: ['account-b'] };
  confirmation.resolve(true);
  await pendingClear;
  assert.equal(submitted.length, 0,
    '确认期间账号变化后不得把来源账号 A 的清除请求提交到目标账号 B');
}

// saveSection 的所有生产调用都属于 beginAction owner;漏传 owner 时必须在 PUT 前拒绝。
let missingOwnerWrites = 0;
const missingOwnerSaveSection = saveSectionFactory(
  {},
  async () => {
    missingOwnerWrites += 1;
    return { settings: {} };
  },
  { destroyed: false, generation: 1 },
  () => true,
  () => {},
  () => {},
);
await assert.rejects(
  () => missingOwnerSaveSection(
    { groups: { whitelist: [] } },
    { signal: new AbortController().signal },
  ),
  /owner/i,
  'saveSection 缺少 owner token 时必须明确拒绝',
);
assert.equal(missingOwnerWrites, 0,
  'saveSection 缺少 owner token 时不得发起 PUT');

const cleanLegacyRefsSource = extractAsyncFunction(schedulerSource, 'cleanLegacyRefs');
assert.match(
  cleanLegacyRefsSource,
  /page\.saveSection\([\s\S]*?ownerToken:\s*token/,
  '清理未绑定账号引用必须把自己的 action token 交给 saveSection',
);

assert.match(
  settingsAccountSwitchBlockedMessage({ accountDraftCount: 1 }),
  /未保存的更改/,
  '存在账号级草稿时必须阻止账号切换',
);

console.log('web settings manual-key account-switch tests passed');
