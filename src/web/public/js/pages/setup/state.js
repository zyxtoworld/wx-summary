// 向导共享状态与工具:账号上下文、设置版本(revision)、手动密钥候选规范化。
// 所有函数都不直接操作 DOM;DOM 由各步骤模块负责。
import { writeSettingsPatch } from '/js/shared/settings-write-coordinator.js';
import { serviceStatePayloadIsValid } from '/js/shared/service-state.js';
import { requireSettingsResponseDocument } from '/js/shared/settings-document.js';

// 本地动作 ID 使用服务端接受的稳定格式。
export function createLocalActionId(kind = 'action') {
  const cleanKind = String(kind || 'action').replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'action';
  const bytes = new Uint8Array(6);
  try { globalThis.crypto?.getRandomValues?.(bytes); } catch {}
  const random = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('')
    || Math.random().toString(16).slice(2, 14);
  return `${cleanKind}_${Date.now().toString(36)}_${random}`;
}

// 微信验证进度 ID 必须符合服务端 /^[a-zA-Z0-9_-]{8,80}$/ 约束。
export function createWechatStatusProgressId() {
  if (globalThis.crypto?.randomUUID) {
    return `wst_${globalThis.crypto.randomUUID().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48)}`;
  }
  const bytes = new Uint8Array(8);
  try { globalThis.crypto?.getRandomValues?.(bytes); } catch {}
  const random = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('')
    || Math.random().toString(16).slice(2, 18);
  return `wst_${Date.now().toString(36)}_${random}`;
}

// ---------------------------------------------------------------------------
// 手动密钥候选规范化只用于输入校验与预览;
// 服务端 normalizeManualKeysText 才是权威,这里只做输入校验与预览,不回显无效原文)。
// ---------------------------------------------------------------------------
function isHexCharCode(code) {
  return (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x46)
    || (code >= 0x61 && code <= 0x66);
}

function normalizeManualKeyTokens(value) {
  const text = String(value || '').trim().toLowerCase().replace(/^['"`]+|['"`]+$/g, '');
  if (/^[a-f0-9]{192}$/.test(text)) return [text];
  return /^(?:[a-f0-9]{64}|[a-f0-9]{96}|[a-f0-9]{128}|[a-f0-9]{160})$/.test(text) ? [text] : [];
}

function manualKeyCandidateMatches(value) {
  const text = String(value || '');
  const matches = [];
  const explicit = /[xX]'([a-fA-F0-9]{64,192})'|0[xX]([a-fA-F0-9]{64,192})/g;
  let match;
  while ((match = explicit.exec(text))) {
    const token = match[1] || match[2];
    matches.push({ index: match.index, end: match.index + match[0].length, token });
  }
  const bare = /[a-fA-F0-9]{64,192}/g;
  while ((match = bare.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    const before = start > 0 ? text.charCodeAt(start - 1) : 0;
    const after = end < text.length ? text.charCodeAt(end) : 0;
    if (isHexCharCode(before) || isHexCharCode(after)) continue;
    matches.push({ index: start, end, token: match[0] });
  }
  return matches.sort((a, b) => a.index - b.index);
}

// 返回 { keys, invalid, text }:keys 为识别出的候选,invalid 为未识别片段(只计数),
// text 为规范化后(每行一条)的提交文本。
export function normalizeManualKeysText(value) {
  const text = String(value || '').trim();
  const keys = [];
  const seen = new Set();
  for (const item of manualKeyCandidateMatches(value)) {
    for (const key of normalizeManualKeyTokens(item.token)) {
      if (!key || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  const invalid = [];
  if (text) {
    for (const item of manualKeyCandidateMatches(value)) {
      if (normalizeManualKeyTokens(item.token).length > 0) continue;
      invalid.push(item.token);
    }
    if (!keys.length && !invalid.length) invalid.push(text);
  }
  return { keys, invalid, text: keys.join('\n') };
}

export function manualKeyInvalidMessage(manualKeys = {}) {
  const invalid = Array.isArray(manualKeys.invalid) ? manualKeys.invalid : [];
  return `手动密钥里检测到 ${invalid.length || 1} 处未识别的行/片段。为避免泄露密钥,错误信息不会回显原文;请删除无效行,或填写 64/96/128/160/192 位 hex、all_keys.json、导出 blob、x'...' / 0x... 片段`;
}

// ---------------------------------------------------------------------------
// 账号工具(publicAccount 字段见 src/main.js publicAccount)。
// ---------------------------------------------------------------------------
export function accountIdOf(account) {
  return String(account?.id || account?.account_id || '').trim();
}

export function accountFingerprintOf(account) {
  return String(account?.manual_key_account_fingerprint || '').trim().toLowerCase();
}

export function accountAliasesOf(account) {
  const aliases = [
    accountIdOf(account),
    account?.account_id,
    account?.legacy_id,
    account?.wxid,
    ...(Array.isArray(account?.account_aliases) ? account.account_aliases : []),
  ];
  return [...new Set(aliases.map(value => String(value || '').trim()).filter(Boolean))];
}

function staleAccountOptionValue(account) {
  return String(account?.account_id || account?.id || account?.wxid || '').trim();
}

function staleAccountAliasesOf(account) {
  return [...new Set([
    ...accountAliasesOf(account),
    account?.account,
  ].map(value => String(value || '').trim()).filter(Boolean))];
}

function staleAccountLastWriteTime(account) {
  const sourceTime = String(account?.source_last_write_time || account?.mirror?.source_last_write_time || '').trim();
  if (sourceTime) return sourceTime;
  if (account?.source === 'project-mirror') return '';
  return String(account?.last_write_time || account?.summary?.last_write_time || '').trim();
}

function staleAccountDateMs(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  const utc = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/);
  const local = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,9}))?$/);
  const match = utc || local;
  if (!match) return 0;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0', millisecondsText = '0'] = match;
  const milliseconds = Number(String(millisecondsText).slice(0, 3).padEnd(3, '0'));
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (![year, month, day, hour, minute, second, milliseconds].every(Number.isInteger)) return 0;
  const date = utc
    ? new Date(Date.UTC(year, month - 1, day, hour, minute, second, milliseconds))
    : new Date(year, month - 1, day, hour, minute, second, milliseconds);
  const time = date.getTime();
  if (!Number.isFinite(time)) return 0;
  const valid = utc
    ? date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day
      && date.getUTCHours() === hour
      && date.getUTCMinutes() === minute
      && date.getUTCSeconds() === second
      && date.getUTCMilliseconds() === milliseconds
    : date.getFullYear() === year
      && date.getMonth() === month - 1
      && date.getDate() === day
      && date.getHours() === hour
      && date.getMinutes() === minute
      && date.getSeconds() === second
      && date.getMilliseconds() === milliseconds;
  return valid ? time : 0;
}

function staleAccountLastWriteTimeMs(account) {
  return staleAccountDateMs(staleAccountLastWriteTime(account));
}

// 必须与服务端 staleAccountConfirmationKeyFromAccounts 保持同一字段顺序。
// 确认值只由当前账号列表计算,不保存密钥或响应正文。
export function staleAccountConfirmationKeyFromAccounts(accounts = [], accountId = '') {
  const requested = String(accountId || '').trim();
  if (!requested) return '';
  const list = Array.isArray(accounts) ? accounts : [];
  const selected = list.find(account => staleAccountAliasesOf(account).includes(requested)) || null;
  if (!selected) return '';
  const sourceStatus = String(
    selected?.mirror?.source_status
      || (selected?.mirror?.source_available === true ? 'available' : 'missing'),
  ).trim();
  const sourceUnavailable = selected?.source === 'project-mirror' && sourceStatus !== 'available';
  const selectedTime = staleAccountLastWriteTimeMs(selected);
  if (!sourceUnavailable
    && (!selectedTime || Math.floor((Date.now() - selectedTime) / 86400000) < 30)) return '';
  const selectedAliases = new Set(staleAccountAliasesOf(selected));
  const suggested = list
    .filter(account => account !== selected
      && !staleAccountAliasesOf(account).some(alias => selectedAliases.has(alias))
      && staleAccountLastWriteTimeMs(account) - selectedTime >= 7 * 24 * 60 * 60 * 1000)
    .sort((a, b) => staleAccountLastWriteTimeMs(b) - staleAccountLastWriteTimeMs(a))[0] || null;
  if (!suggested && !sourceUnavailable) return '';
  return [
    staleAccountOptionValue(selected),
    staleAccountLastWriteTime(selected),
    staleAccountOptionValue(suggested),
    sourceUnavailable ? 'source_unavailable' : '',
  ].map(value => String(value || '').trim()).join('|');
}

export function accountDisplayName(account) {
  return String(account?.display_name || account?.name || account?.wxid || account?.id || '微信账号');
}

// 判断服务端返回的账号是否仍是当前确认账号(id/wxid/别名任一命中同一对象)。
export function findAccountByAnyId(accounts = [], account = null) {
  if (!account) return null;
  const ids = new Set(accountAliasesOf(account));
  for (const candidate of accounts || []) {
    if (accountAliasesOf(candidate).some(alias => ids.has(alias))) return candidate;
  }
  return null;
}

// 服务端 state 必须明确属于当前账号,同 ID 也必须匹配最新指纹。
export function stateMatchesAccountContext(state, account) {
  const accountId = accountIdOf(account);
  if (!accountId) return false;
  const stateAccounts = Array.isArray(state?.wechat?.accounts)
    ? state.wechat.accounts
    : [];
  const stateAccount = findAccountByAnyId(stateAccounts, account);
  if (!stateAccount) return false;
  return accountFingerprintOf(stateAccount) === accountFingerprintOf(account);
}

// 账号身份升级后重新读取 state;迟到/错指纹响应只能返回 false,不得写入向导或 store。
export async function refreshWizardStateForAccount({
  api,
  store,
  wiz,
  account = wiz?.account || null,
  signal = null,
  isCurrent = () => true,
} = {}) {
  const accountId = accountIdOf(account);
  const accountIdentity = wizardAccountContextIdentity(account);
  if (!api?.get || !accountId || !isCurrent()
    || wizardAccountContextIdentity(wiz?.account) !== accountIdentity) return false;
  const state = await api.get(
    `/api/state?refresh=1&account=${encodeURIComponent(accountId)}`,
    { signal },
  );
  if (!isCurrent()
    || wizardAccountContextIdentity(wiz?.account) !== accountIdentity
    || !serviceStatePayloadIsValid(state)
    || !stateMatchesAccountContext(state, account)) return false;
  applyWizardAccountState(store, wiz, state, account);
  return true;
}

// 微信验证/密钥验证结果是否覆盖全部消息库分片。
export function manualKeyMessageVerified(result = {}) {
  return result?.key?.message_db_verified === true
    || result?.db?.message_db_verified === true
    || result?.key?.message_coverage_verified === true
    || result?.db?.message_coverage_verified === true;
}

// 把服务端错误整理成一行可读文案;network/timeout 由调用方另行处理。
export function compactErrorSummary(value = '', limit = 200) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// ---------------------------------------------------------------------------
// 向导共享可变状态(mount 时重建)。
// ---------------------------------------------------------------------------
function createWizardKeyState() {
  return {
    draft: '',
    validatedText: '',
    validation: null,
    savedText: '',
    saved: false,
    skipped: false,
  };
}

export function resetWizardAccountScopedState(wiz) {
  if (!wiz) return;
  wiz.key = createWizardKeyState();
  wiz.groups = null;
  wiz.whitelist = [];
  wiz.whitelistBaseline = [];
  wiz.whitelistDirty = false;
  wiz.whitelistAccountIdentity = '';
  wiz.done = false;
}

export function clearWizardAccountState(store, wiz) {
  if (!wiz) return;
  wiz.state = null;
  wiz.stateAccountId = '';
  wiz.needSetupReason = '';
  wiz.baseRevision = '';
  if (store?.set) {
    store.set('stateAccountContext', null);
    store.set('state', null);
  }
}

export function wizardAccountContextIdentity(account) {
  return `${accountIdOf(account)}|${accountFingerprintOf(account)}`;
}

export function bindWizardAccountContext(wiz, account, store = null) {
  if (!wiz) return false;
  const previous = wiz.account || null;
  const next = account || null;
  const previousAliases = new Set(accountAliasesOf(previous));
  const previousFingerprint = accountFingerprintOf(previous);
  const nextFingerprint = accountFingerprintOf(next);
  const fingerprintChanged = Boolean(
    previous && next && previousFingerprint !== nextFingerprint,
  );
  const sameContext = (!previous && !next)
    || (!!previous && !!next
      && !fingerprintChanged
      && accountAliasesOf(next).some(alias => previousAliases.has(alias)));
  if (!sameContext) {
    resetWizardAccountScopedState(wiz);
    clearWizardAccountState(store, wiz);
  }
  wiz.account = next;
  return !sameContext;
}

export function createWizardState(store) {
  const initialState = store?.get?.('state') || null;
  const initialAccount = store?.get?.('account') || null;
  const initialAccountId = accountIdOf(initialAccount);
  const initialStateAccountContext = store?.get?.('stateAccountContext') || null;
  const initialStateAccountId = String(initialStateAccountContext?.accountId || '').trim();
  const initialStateAccountFingerprint = String(initialStateAccountContext?.accountFingerprint || '')
    .trim()
    .toLowerCase();
  const initialAccountFingerprint = accountFingerprintOf(initialAccount);
  const initialStateMatchesAccount = Boolean(
    initialState
      && initialAccountId
      && initialStateAccountId === initialAccountId
      && initialStateAccountFingerprint === initialAccountFingerprint,
  );
  const usableInitialState = initialStateMatchesAccount ? initialState : null;
  return {
    // 服务端 /api/state 最近一次快照(向导内每次动作后刷新)。
    state: usableInitialState,
    // 只有显式绑定当前账号的 state 才能解锁后续步骤;服务级初始 state 不算账号快照。
    stateAccountId: initialStateMatchesAccount ? initialAccountId : '',
    needSetupReason: String(usableInitialState?.need_setup_reason || '').trim(),
    // 账号
    accounts: Array.isArray(store?.get?.('accounts')) ? store.get('accounts') : [],
    account: initialAccount, // 用户确认/选中的 publicAccount
    // 设置快照与版本
    settings: null,            // GET /api/settings 响应(已脱敏,无 api_key/manual_key 明文)
    baseRevision: String(usableInitialState?.settings_revision || '').trim(),
    // 第 2 步 AI 接入草稿
    llm: {
      provider: 'openai',
      base_url: '',
      api_key: '',
      apiKeyTouched: false,    // true 表示用户输入了新 key;false 且已配置时沿用已保存 key
      model: '',
      long_context_model: '',
      dirty: false,             // true 表示本次向导会话有尚未保存的表单草稿
      available_models: [],
      modelsForIdentity: '',   // provider+base_url+api_key 指纹,端点变化需重新拉模型
      testedIdentity: '',      // test-llm 通过时的指纹
      saved: false,
      skipWarned: false,
    },
    // 第 3 步手动密钥
    key: createWizardKeyState(),
    // 第 4 步
    groups: null,              // { count, preview, groups, error }
    // 第 4 步白名单草稿;只存当前确认账号的规范引用。
    whitelist: [],
    whitelistBaseline: [],
    whitelistDirty: false,
    whitelistAccountIdentity: '',
    done: false,
  };
}

// 用最新 /api/state 同步向导状态;返回服务端最新 need_setup_reason。
export function syncWizardStateFromState(wiz, state, { accountId = '' } = {}) {
  wiz.state = state || null;
  wiz.stateAccountId = state ? String(accountId || '').trim() : '';
  wiz.needSetupReason = String(state?.need_setup_reason || '').trim();
  if (String(state?.settings_revision || '').trim()) {
    wiz.baseRevision = String(state.settings_revision).trim();
  }
  return wiz.needSetupReason;
}

// 账号绑定 state 的唯一提交入口:先写上下文,再写 state,让所有订阅者看到一致快照。
export function applyWizardAccountState(store, wiz, state, account = wiz?.account || null) {
  const accountId = state ? accountIdOf(account) : '';
  syncWizardStateFromState(wiz, state, { accountId });
  if (store?.set) {
    store.set('stateAccountContext', accountId ? {
      accountId,
      accountFingerprint: accountFingerprintOf(account),
    } : null);
    store.set('state', state || null);
  }
  return state || null;
}

// 用 PUT /api/settings(或 POST /api/wechat/status 带 settings)响应同步向导状态。
export function syncWizardStateFromSettingsResponse(wiz, response) {
  if (response?.settings !== undefined) {
    const settings = requireSettingsResponseDocument(response);
    wiz.settings = settings;
    wiz.baseRevision = String(settings.settings_revision).trim();
  } else {
    const revision = String(response?.settings_revision || '').trim();
    if (revision) wiz.baseRevision = revision;
  }
  if (typeof response?.need_setup === 'boolean' || response?.need_setup_reason !== undefined) {
    wiz.needSetupReason = String(response?.need_setup_reason || '').trim();
  }
}

export async function saveWizardSettings(ctx, wiz, patch, {
  signal = null,
  timeoutMs = 180_000,
  isCurrent = null,
} = {}) {
  return writeSettingsPatch({
    api: ctx?.api,
    patch,
    signal,
    timeoutMs,
    isCurrent,
    onLatest: latest => {
      syncWizardStateFromSettingsResponse(wiz, {
        settings: latest,
        settings_revision: latest?.settings_revision,
      });
    },
  });
}

// 当前确认账号在向导内的设置请求上下文。
export function wizardAccountRequestContext(wiz, { manualKeyValidationRequired = false } = {}) {
  const accountId = accountIdOf(wiz.account);
  if (!accountId) return { accountId: '', fingerprint: '', body: {} };
  const fingerprint = accountFingerprintOf(wiz.account);
  const aliases = accountAliasesOf(wiz.account);
  const context = {
    account_id: accountId,
    account_aliases: aliases,
    ...(fingerprint ? {
      account_fingerprint: fingerprint,
      expected_account_fingerprint: fingerprint,
    } : {}),
    ...(manualKeyValidationRequired ? { manual_key_validation_required: true } : {}),
  };
  return { accountId, fingerprint, aliases, body: { _request_context: context } };
}

// secrets_invalid 时,服务端要求 _request_context.replace_invalid_secrets === true 才允许
// 写入新密钥(settings.js assertInvalidSecretsReplacementConfirmed,否则
// 428 secrets_replacement_confirmation_required)。
// 返回 { required, confirmed };confirmed 时调用方把 replace_invalid_secrets 合入 _request_context。
export async function confirmInvalidSecretsReplacement(ctx, wiz) {
  const invalid = wiz.state?.secrets_invalid === true || wiz.settings?._secrets_invalid === true;
  if (!invalid) return { required: false, confirmed: false };
  const info = wiz.state?.secrets_invalid_info || wiz.settings?._secrets_invalid_info || {};
  const backupPath = String(info.backup_relative_path || info.backup_path || '').trim();
  const confirmed = await ctx.ui.confirmDialog({
    title: '建立新密钥库',
    message: `当前 Windows 用户无法解密原密钥库。继续后会先保留原密文备份,再用当前填写的密钥建立新密钥库;`
      + `未重新填写的其他账号手动密钥不会进入新密钥库。`
      + `${backupPath ? `原密文已备份到 ${backupPath}。` : '如果旧密文无法完成安全备份,本次保存会被拒绝。'}`,
    confirmLabel: '备份并建立新密钥库',
    cancelLabel: '取消',
    danger: true,
  });
  return { required: true, confirmed };
}
