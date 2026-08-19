// 设置页 · 群与调度分区:白名单编辑、调度开关/频率、每群规则、调度状态轮询与维护操作。
import { parseStrictIntegerInput } from '/js/shared/numeric-input.js';
import {
  el,
  createStatusLine,
  errorText,
  isAbortError,
  fmtDateTime,
  fmtIntervalMs,
  durationToMs,
  parseDurationText,
  canonicalWhitelistRef,
  whitelistRefKey,
  whitelistRefLabel,
  groupRefFromGroup,
  groupDisplayName,
} from './core.js';
import { createAccountChangeScope } from '/js/shared/account-change-scope.js';
import { refreshPublicAccountIdentityUpgrade } from '/js/shared/account-context.js';
import {
  dbMirrorDiagnosticsReady,
  isDbMirrorFailure,
  readDbMirrorAutoFailure,
  clearDbMirrorAutoFailure,
  rememberDbMirrorAutoFailure,
} from '/js/shared/db-mirror-failure.js';
import { syncFormControlsDisabled } from '/js/shared/form-busy-controls.js';
import { requireGroupList } from '/js/shared/group-list-contract.js';
import {
  associateFormLabels,
  focusFirstInvalid,
  setFieldInvalid,
} from '/js/shared/form-accessibility.js';

const MIN_MESSAGES_LIMIT = Object.freeze({ min: 1, max: 9999 });
const DURATION_UNITS = Object.freeze([['m', '分钟'], ['h', '小时'], ['d', '天']]);

export function syncSchedulerMaintenanceButtons(buttons, { busy = false } = {}) {
  const disabled = Boolean(busy);
  if (buttons?.cursors) buttons.cursors.disabled = disabled;
  if (buttons?.pending) buttons.pending.disabled = disabled;
  if (buttons?.legacyRefs) buttons.legacyRefs.disabled = disabled;
}

export function applySchedulerMutationResult(applySettings, settings) {
  if (typeof applySettings !== 'function') return false;
  applySettings(settings, { preserveDirty: true });
  return true;
}

export function requireSchedulerStoreRevalidationResult(value, expectedStore = '') {
  const count = value?.remaining_blocked_store_count;
  const valid = value
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.ok === true
    && String(value.store || '').trim() === String(expectedStore || '').trim()
    && Number.isSafeInteger(count)
    && count >= 0;
  if (!valid) {
    const error = new Error('调度文件重新校验响应无效，请稍后重试。');
    error.status = 502;
    error.code = 'scheduler_store_revalidation_response_invalid';
    throw error;
  }
  return count;
}

export function requireSchedulerRunOnceResult(value) {
  const result = value?.result;
  const counts = ['checked', 'generated', 'skipped', 'failed'];
  const valid = value
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.request_ok === true
    && typeof value.cancelled_after_commit === 'boolean'
    && result
    && typeof result === 'object'
    && !Array.isArray(result)
    && typeof result.ok === 'boolean'
    && counts.every(key => Number.isSafeInteger(result[key]) && result[key] >= 0);
  if (!valid) {
    const error = new Error('手动检查响应无效，请稍后重试。');
    error.status = 502;
    error.code = 'scheduler_run_once_response_invalid';
    throw error;
  }
  return value;
}

export function requireSchedulerLegacyCursorCleanupResult(value) {
  const plainObject = item => item && typeof item === 'object' && !Array.isArray(item);
  const count = key => value?.[key];
  const failedCount = value?.failed_count ?? 0;
  const valid = plainObject(value)
    && typeof value.ok === 'boolean'
    && plainObject(value.scheduler)
    && ['attempted', 'target_count', 'cleared'].every(key => Number.isSafeInteger(count(key)) && count(key) >= 0)
    && Number.isSafeInteger(failedCount)
    && failedCount >= 0
    && value.attempted <= value.target_count
    && value.cleared <= value.attempted
    && (value.ok === false || failedCount === 0)
    && (value.cancelled_after_commit === undefined || typeof value.cancelled_after_commit === 'boolean');
  if (!valid) {
    const error = new Error('清理未验证游标响应无效，请刷新调度状态确认结果。');
    error.status = 502;
    error.code = 'scheduler_legacy_cursor_cleanup_response_invalid';
    throw error;
  }
  return value;
}

export function requireSchedulerStatusResult(value) {
  const valid = value
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.ok === true
    && value.scheduler
    && typeof value.scheduler === 'object'
    && !Array.isArray(value.scheduler);
  if (!valid) {
    const error = new Error('调度状态响应无效，请稍后重试。');
    error.status = 502;
    error.code = 'scheduler_status_response_invalid';
    throw error;
  }
  return value;
}

export function createLatestSchedulerStatusPoll({
  fetchStatus,
  applyStatus,
  isActive = () => true,
  onError = () => {},
} = {}) {
  if (typeof fetchStatus !== 'function' || typeof applyStatus !== 'function') {
    throw new TypeError('latest scheduler status poll requires fetchStatus and applyStatus callbacks');
  }
  let generation = 0;
  let activePromise = null;
  let activeController = null;
  let rerunRequested = false;
  let disposed = false;

  const active = () => !disposed && isActive() !== false;
  const abortActive = message => {
    const controller = activeController;
    if (!controller || controller.signal.aborted) return false;
    const error = new Error(message);
    error.name = 'AbortError';
    error.status = 499;
    controller.abort(error);
    return true;
  };
  const drain = async () => {
    let applied = false;
    do {
      rerunRequested = false;
      if (!active()) break;
      const requestGeneration = generation;
      const controller = new AbortController();
      activeController = controller;
      try {
        const payload = await fetchStatus({ signal: controller.signal });
        if (!active() || requestGeneration !== generation) continue;
        applyStatus(payload);
        applied = true;
      } catch (error) {
        if (active() && requestGeneration === generation) {
          try { onError(error); } catch {}
        }
      } finally {
        if (activeController === controller) activeController = null;
      }
    } while (rerunRequested && active());
    return applied;
  };

  const ensureActivePromise = () => {
    if (activePromise) return activePromise;
    const run = drain();
    const tracked = run.then(async applied => {
      if (activePromise === tracked) activePromise = null;
      if (active() && rerunRequested) {
        const followupApplied = await ensureActivePromise();
        return applied || followupApplied;
      }
      return applied;
    }, async error => {
      if (activePromise === tracked) activePromise = null;
      if (active() && rerunRequested) await ensureActivePromise();
      throw error;
    });
    activePromise = tracked;
    return tracked;
  };

  return {
    request() {
      if (!active()) return Promise.resolve(false);
      generation += 1;
      if (activePromise) {
        rerunRequested = true;
        return activePromise;
      }
      return ensureActivePromise();
    },
    invalidate() {
      generation += 1;
      rerunRequested = false;
      abortActive('调度状态上下文已失效');
    },
    dispose() {
      disposed = true;
      generation += 1;
      rerunRequested = false;
      abortActive('调度状态轮询已销毁');
    },
  };
}

// 时长控件:数值输入 + 单位下拉,输出后端格式(如 30m / 4h / 1d)。
function createDurationControl({ ariaLabel, onChange }) {
  const amount = el('input', {
    class: 'input', type: 'text', inputmode: 'numeric', 'aria-label': `${ariaLabel}数值`,
  });
  const unit = el('select', { class: 'select', 'aria-label': `${ariaLabel}单位` },
    DURATION_UNITS.map(([value, label]) => el('option', { value, text: label })),
  );
  const wrap = el('div', { class: 'settings-duration' }, amount, unit);
  amount.addEventListener('input', onChange);
  unit.addEventListener('change', onChange);
  return {
    el: wrap,
    inputs: [amount, unit],
    set(text) {
      const parts = parseDurationText(text);
      amount.value = parts.amount;
      unit.value = parts.unit;
    },
    // 返回 { ok, text };文本为后端 durationToMs 可解析格式。
    get() {
      const parsed = parseStrictIntegerInput(amount.value, { min: 1, max: 9999 });
      if (!parsed.ok) return { ok: false, text: '' };
      return { ok: true, text: `${parsed.value}${unit.value}` };
    },
  };
}

function ruleDisplayName(rule) {
  return String(rule?.group_name || rule?.group_id || rule?.group || '(未命名群)').trim() || '(未命名群)';
}

export function createSchedulerSection(page) {
  const { api, ui } = page;
  const accountScope = createAccountChangeScope();
  let activeGroupAction = null;
  const status = createStatusLine();
  const runStatus = createStatusLine();
  const maintainStatus = createStatusLine();

  // ---- 白名单 ----------------------------------------------------------------
  const whitelistChips = el('div', { class: 'chip-list' });
  const whitelistLegacyNote = el('div', { class: 'settings-hint' });
  const groupSearch = el('input', {
    class: 'input', type: 'search', placeholder: '搜索群名', 'aria-label': '搜索群',
  });
  const pickerList = el('div', { class: 'settings-picker-list' });
  const pickerStatus = el('div', { class: 'settings-hint' });
  const refreshGroupsBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '刷新群列表' });

  // ---- 调度开关与频率 ----------------------------------------------------------
  const enabledToggle = el('input', { type: 'checkbox' });
  const enabledLabel = el('label', { class: 'settings-check' }, enabledToggle,
    el('span', { text: '启用后台自动检查(按白名单定期生成总结)' }));
  const disabledReasonNote = el('div', { class: 'settings-hint' });
  const intervalControl = createDurationControl({ ariaLabel: '检查间隔', onChange: handleDraftChange });
  const windowControl = createDurationControl({ ariaLabel: '总结窗口', onChange: handleDraftChange });
  const minMessagesInput = el('input', {
    class: 'input', type: 'text', inputmode: 'numeric', 'aria-label': '最少消息数',
  });

  // ---- 每群规则 ----------------------------------------------------------------
  const ruleList = el('div', { class: 'settings-rule-list' });
  const rulePickerSelect = el('select', { class: 'select', 'aria-label': '选择群添加规则' });
  const addRuleBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '添加每群规则' });

  // ---- 调度状态 ----------------------------------------------------------------
  const statusGrid = el('div', { class: 'settings-scheduler-grid' });
  const progressWrap = el('div', { class: 'settings-progress' });
  const lastResultWrap = el('div', { class: 'settings-test-results' });
  const runOnceBtn = el('button', { class: 'btn btn-ghost', type: 'button', text: '立即检查一次' });
  const revalidateCursorsBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '重新校验游标文件' });
  const revalidatePendingBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '重新校验待提交游标' });
  const clearLegacyBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '清理未验证游标' });
  const cleanLegacyRefsBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '清理未绑定账号的白名单引用' });

  const saveWhitelistBtn = el('button', { class: 'btn btn-primary', type: 'button', text: '保存白名单' });
  const saveSchedulerBtn = el('button', { class: 'btn btn-primary', type: 'button', text: '保存调度设置' });

  // ---- 状态 --------------------------------------------------------------------
  const draft = {
    whitelist: [],       // 规范形 ref 数组(本账号范围外的现存引用也会保留在这里)
    groups: null,        // GET /api/groups 结果
    groupsLoading: false,
    rules: [],           // per_group 草稿
    lastStatus: null,    // 最近一次 publicSchedulerStatus
    whitelistDirty: false,
    schedulerDirty: false,
  };

  function schedulerSettings() {
    return page.getSettings()?.scheduler || {};
  }

  function currentAccount() {
    return page.getAccount();
  }

  function currentAccountId() {
    const account = currentAccount();
    return String(account?.id || account?.account_id || '').trim();
  }

  function currentAccountRuleScope() {
    const account = currentAccount();
    return String(account?.identity_id || account?.mirror?.identity_id || '').trim()
      || currentAccountId();
  }

  function currentAccountContextIdentity() {
    const context = page.requestContext(currentAccount());
    return `${String(context?.account_id || '').trim()}|${String(
      context?.expected_account_fingerprint || context?.account_fingerprint || '',
    ).trim().toLowerCase()}`;
  }

  // ---------------------------------------------------------------------------
  // 白名单渲染
  // ---------------------------------------------------------------------------
  function renderWhitelist() {
    const refs = draft.whitelist;
    whitelistChips.replaceChildren(...refs.map((ref, index) => {
      const removeBtn = el('button', {
        class: 'chip-x', type: 'button', text: '×', 'aria-label': `移除 ${whitelistRefLabel(ref)}`,
        onclick: () => {
          draft.whitelist = refs.filter((_, i) => i !== index);
          renderWhitelist();
          markDirty();
        },
      });
      syncFormControlsDisabled([removeBtn], page.isBusy());
      const chip = el('span', { class: 'chip' },
        el('span', { class: 'chip-text', text: whitelistRefLabel(ref), title: whitelistRefLabel(ref) }),
        removeBtn,
      );
      return chip;
    }));
    // 现存的旧格式(字符串/未绑账号)引用:服务端会自动保留,本页不展示也不可提交。
    const legacyCount = (Array.isArray(page.getSettings()?.groups?.whitelist) ? page.getSettings().groups.whitelist : [])
      .filter(ref => !canonicalWhitelistRef(ref, '')).length;
    // 其他账号的引用:当前账号上下文无法修改(服务端只允许按当前账号改动)。
    const ownScopes = new Set([
      currentAccountId(),
      currentAccount()?.identity_id,
      currentAccount()?.mirror?.identity_id,
    ].map(value => String(value || '').trim()).filter(Boolean));
    const foreignCount = ownScopes.size
      ? draft.whitelist.filter(ref => !ownScopes.has(String(ref?.account_id || '').trim())).length
      : 0;
    const notes = [];
    if (legacyCount) notes.push(`另有 ${legacyCount} 条未绑定账号引用未在列表中显示;服务端会继续保留它们,可用下方“清理未绑定账号的白名单引用”移除。`);
    if (foreignCount) notes.push(`其中 ${foreignCount} 条属于其他账号,保存时会被保留;如需修改请先切换账号。`);
    whitelistLegacyNote.textContent = notes.join('');
    cleanLegacyRefsBtn.hidden = !legacyCount;
  }

  function whitelistSavedKeys() {
    const list = Array.isArray(page.getSettings()?.groups?.whitelist) ? page.getSettings().groups.whitelist : [];
    // 只统计编辑器可表达的规范形引用;旧格式引用由服务端保留,不参与脏检查。
    return new Set(list.map(ref => canonicalWhitelistRef(ref, '')).filter(Boolean).map(ref => whitelistRefKey(ref)));
  }

  function whitelistDirtyNow() {
    const current = new Set(draft.whitelist.map(ref => whitelistRefKey(ref)));
    const saved = whitelistSavedKeys();
    if (current.size !== saved.size) return true;
    for (const key of current) if (!saved.has(key)) return true;
    return false;
  }

  function renderGroupPicker() {
    const keyword = groupSearch.value.trim().toLowerCase();
    const selected = new Set(draft.whitelist.map(ref => whitelistRefKey(ref)));
    const groups = Array.isArray(draft.groups) ? draft.groups : [];
    const visible = keyword
      ? groups.filter(group => `${groupDisplayName(group)} ${group?.id || ''}`.toLowerCase().includes(keyword))
      : groups;
    pickerList.replaceChildren(...visible.slice(0, 200).map(group => {
      const ref = groupRefFromGroup(group, currentAccountRuleScope());
      const key = ref ? whitelistRefKey(ref) : '';
      const checkbox = el('input', { type: 'checkbox' });
      checkbox.checked = !!key && selected.has(key);
      checkbox.disabled = !ref;
      syncFormControlsDisabled([checkbox], page.isBusy());
      checkbox.addEventListener('change', () => {
        if (!ref) return;
        // 不能闭包捕获渲染时的 selected:连续勾选/取消必须以最新草稿为准。
        const current = new Set(draft.whitelist.map(item => whitelistRefKey(item)));
        if (checkbox.checked) {
          if (!current.has(key)) draft.whitelist = [...draft.whitelist, ref];
        } else {
          draft.whitelist = draft.whitelist.filter(item => whitelistRefKey(item) !== key);
        }
        renderWhitelist();
        markDirty();
      });
      return el('label', { class: 'group-row' },
        checkbox,
        el('span', { class: 'group-name', text: groupDisplayName(group), title: groupDisplayName(group) }),
        el('span', { class: 'group-meta muted', text: String(group?.id || '') }),
      );
    }));
    if (draft.groupsLoading) {
      pickerStatus.textContent = '正在读取群列表(首次读取需要准备本地数据,可能较慢)…';
    } else if (draft.groups === null) {
      pickerStatus.textContent = '群列表未读取;点击“刷新群列表”加载后勾选。';
    } else if (!visible.length) {
      pickerStatus.textContent = keyword ? '没有匹配的群。' : '当前账号没有可读群。';
    } else {
      pickerStatus.textContent = visible.length > 200 ? '匹配结果过多,请继续输入关键字缩小范围。' : '';
    }
  }

  async function loadGroups({ allowIdentityUpgrade = true } = {}) {
    const account = currentAccount();
    const context = page.requestContext(account);
    const accountId = String(context?.account_id || '').trim();
    if (!accountId) {
      pickerStatus.textContent = '请先在左下角选择微信账号。';
      return;
    }
    const expectedFingerprint = String(context?.expected_account_fingerprint || '').trim().toLowerCase();
    if (!expectedFingerprint) {
      pickerStatus.textContent = '当前账号身份凭据尚未就绪;请刷新账号列表后再读取群列表。';
      return;
    }
    const token = page.beginAction('读取群列表', [refreshGroupsBtn]);
    const accountIdentity = currentAccountContextIdentity();
    const accountToken = accountScope.ensure(accountIdentity);
    activeGroupAction = token;
    draft.groupsLoading = true;
    renderGroupPicker();
    try {
      const params = new URLSearchParams();
      params.set('account', accountId);
      params.set('expected_account_fingerprint', expectedFingerprint);
      const result = await api.get(`/api/groups?${params.toString()}`, {
        signal: token.signal,
        timeoutMs: 600_000,
      });
      if (!page.alive(token) || !accountScope.isCurrent(accountToken, currentAccountContextIdentity())) return;
      if (result?.account_identity_upgrade) {
        if (!allowIdentityUpgrade) {
          status.set('群列表账号身份连续变化;请刷新账号列表后重试。', 'warn');
          return;
        }
        const upgradeResult = await refreshPublicAccountIdentityUpgrade(result, {
          accountId,
          fingerprint: expectedFingerprint,
          refreshAccounts: page.refreshAccounts,
          isCurrent: page.isActive,
        });
        if (upgradeResult.status === 'upgraded' && page.isActive() && activeGroupAction === token) {
          const upgradedContext = page.requestContext(upgradeResult.account);
          const upgradedIdentity = `${String(upgradedContext?.account_id || '').trim()}|${String(
            upgradedContext?.expected_account_fingerprint || upgradedContext?.account_fingerprint || '',
          ).trim().toLowerCase()}`;
          if (currentAccountContextIdentity() !== upgradedIdentity) return;
          return loadGroups({ allowIdentityUpgrade: false });
        }
        if (!page.alive(token)
          || !accountScope.isCurrent(accountToken, currentAccountContextIdentity())) return;
        if (upgradeResult.status !== 'stale') {
          status.set(upgradeResult.status === 'refresh_failed'
            ? (upgradeResult.error?.message || '账号列表刷新失败;请稍后重试。')
            : '群列表响应的账号身份尚未完成确认;请刷新账号列表后重试。', 'warn');
        }
        return;
      }
      if (String(result?.account_id || '').trim() !== accountId
        || String(result?.account_fingerprint || '').trim().toLowerCase() !== expectedFingerprint) {
        status.set('群列表响应的账号身份与当前选择不一致;请刷新账号列表后重试。', 'warn');
        return;
      }
      const groups = requireGroupList(result);
      clearDbMirrorAutoFailure({
        accountId,
        accounts: page.getAccounts?.() || [],
        accountFingerprint: expectedFingerprint,
      });
      draft.groups = groups;
      status.set(`已读取 ${draft.groups.length} 个群。`, 'ok');
    } catch (error) {
      if (!page.alive(token)
        || !accountScope.isCurrent(accountToken, currentAccountContextIdentity())
        || isAbortError(error)) return;
      draft.groups = null;
      const mirrorFailure = isDbMirrorFailure(error)
        ? rememberDbMirrorAutoFailure(error, accountId, {
          accounts: page.getAccounts?.() || [],
          accountFingerprint: expectedFingerprint,
        })
        : null;
      const mirrorHint = dbMirrorDiagnosticsReady(mirrorFailure)
        || dbMirrorDiagnosticsReady(readDbMirrorAutoFailure({
          accountId,
          accounts: page.getAccounts?.() || [],
          accountFingerprint: expectedFingerprint,
        }))
        ? '；本地数据连续检查失败,请稍后重试。'
        : '';
      status.set(`${errorText(error, '群列表读取失败')}${mirrorHint}`, 'err');
    } finally {
      if (activeGroupAction === token) activeGroupAction = null;
      if (accountScope.isCurrent(accountToken, currentAccountContextIdentity())) {
        draft.groupsLoading = false;
        if (page.alive(token)) renderGroupPicker();
      }
      page.endAction(token);
    }
  }

  // ---------------------------------------------------------------------------
  // 每群规则
  // ---------------------------------------------------------------------------
  function renderRules() {
    ruleList.replaceChildren(...draft.rules.map((rule, index) => {
      const keywordsInput = el('input', {
        class: 'input', type: 'text', placeholder: '关键词,用逗号分隔;留空表示不过滤',
        'aria-label': '关键词', value: (Array.isArray(rule.keywords) ? rule.keywords : []).join(', '),
      });
      keywordsInput.addEventListener('input', () => {
        rule.keywords = keywordsInput.value.split(/[,，]/).map(x => x.trim()).filter(Boolean).slice(0, 20);
        markDirty();
      });
      const minInput = el('input', {
        class: 'input', type: 'text', inputmode: 'numeric', placeholder: '0',
        'aria-label': '最少消息数覆盖', value: String(Math.max(0, Number(rule.min_messages || 0) || 0)),
      });
      minInput.addEventListener('input', () => {
        const parsed = parseStrictIntegerInput(minInput.value, { min: 0, max: MIN_MESSAGES_LIMIT.max, clamp: true });
        rule.min_messages = parsed.ok ? parsed.value : 0;
        markDirty();
      });
      const removeBtn = el('button', {
        class: 'btn btn-ghost btn-sm', type: 'button', text: '移除',
        onclick: () => {
          draft.rules = draft.rules.filter((_, i) => i !== index);
          renderRules();
          markDirty();
        },
      });
      syncFormControlsDisabled([keywordsInput, minInput, removeBtn], page.isBusy());
      return el('div', { class: 'settings-rule' },
        el('div', { class: 'settings-rule-head' },
          el('span', { class: 'settings-rule-name', text: ruleDisplayName(rule), title: ruleDisplayName(rule) }),
          removeBtn,
        ),
        el('div', { class: 'settings-rule-fields' },
          el('div', { class: 'settings-field' },
            el('label', { class: 'field-label', text: '关键词(逗号分隔,最多 20 个)' }),
            keywordsInput,
          ),
          el('div', { class: 'settings-field settings-field-min' },
            el('label', { class: 'field-label', text: '最少消息数覆盖(0 = 用默认值)' }),
            minInput,
          ),
        ),
      );
    }));
    associateFormLabels(ruleList, { prefix: 'settings-rule' });
  }

  function renderRulePicker() {
    // 入口同时列出白名单群与(已加载的)群列表,方便直接给未进白名单的群配规则。
    const options = [el('option', { value: '', text: '选择群…' })];
    if (draft.whitelist.length) {
      options.push(el('optgroup', { label: '白名单' },
        draft.whitelist.map((ref, index) => el('option', { value: `w:${index}`, text: whitelistRefLabel(ref) }))));
    }
    if (Array.isArray(draft.groups) && draft.groups.length) {
      options.push(el('optgroup', { label: '全部群' },
        draft.groups.slice(0, 300).map((group, index) => el('option', {
          value: `g:${index}`,
          text: groupDisplayName(group),
        }))));
    }
    rulePickerSelect.replaceChildren(...options);
    addRuleBtn.disabled = options.length <= 1 || page.isBusy();
  }

  function addRuleFromPicker() {
    const value = String(rulePickerSelect.value || '');
    let ref = null;
    if (value.startsWith('w:')) {
      ref = draft.whitelist[Number(value.slice(2))] || null;
    } else if (value.startsWith('g:')) {
      ref = groupRefFromGroup(draft.groups?.[Number(value.slice(2))], currentAccountRuleScope());
    }
    if (!ref) {
      status.set('请先选择要添加规则的群。', 'warn');
      return;
    }
    const exists = draft.rules.some(rule => (
      String(rule.account_id || '') === String(ref.account_id || '')
      && ((rule.group_id && rule.group_id === ref.group_id)
        || (!rule.group_id && rule.group_name && rule.group_name === ref.group_name))
    ));
    if (exists) {
      status.set('该群已有每群规则。', 'warn');
      return;
    }
    draft.rules = [...draft.rules, {
      account_id: String(ref.account_id),
      ...(ref.group_id ? { group_id: String(ref.group_id) } : {}),
      ...(ref.group_name ? { group_name: String(ref.group_name) } : {}),
      keywords: [],
      min_messages: 0,
    }];
    renderRules();
    markDirty();
  }

  function rulesSavedSignature() {
    const list = Array.isArray(schedulerSettings().per_group) ? schedulerSettings().per_group : [];
    return JSON.stringify(list.map(rule => ({
      a: String(rule?.account_id || ''),
      g: String(rule?.group_id || ''),
      n: String(rule?.group_name || ''),
      k: [...(Array.isArray(rule?.keywords) ? rule.keywords : [])].sort(),
      m: Math.max(0, Number(rule?.min_messages || 0) || 0),
    })));
  }

  function rulesDraftSignature() {
    return JSON.stringify(draft.rules.map(rule => ({
      a: String(rule?.account_id || ''),
      g: String(rule?.group_id || ''),
      n: String(rule?.group_name || ''),
      k: [...(Array.isArray(rule?.keywords) ? rule.keywords : [])].sort(),
      m: Math.max(0, Number(rule?.min_messages || 0) || 0),
    })));
  }

  // ---------------------------------------------------------------------------
  // 脏检查
  // ---------------------------------------------------------------------------
  function markDirty() {
    draft.whitelistDirty = whitelistDirtyNow();
    draft.schedulerDirty = schedulerDirtyNow();
    page.markDirty('groups', draft.whitelistDirty);
    page.markDirty('scheduler', draft.schedulerDirty);
    saveWhitelistBtn.disabled = !draft.whitelistDirty || page.isBusy();
    saveSchedulerBtn.disabled = !draft.schedulerDirty || page.isBusy();
  }

  function handleDraftChange() {
    // Validation errors describe the previous draft; editing any scheduler field invalidates them.
    setFieldInvalid(arguments[0]?.currentTarget, false);
    status.clear();
    markDirty();
  }

  function schedulerDirtyNow() {
    const saved = schedulerSettings();
    if (enabledToggle.checked !== !!saved.enabled) return true;
    const interval = intervalControl.get();
    if (interval.text !== String(saved.default_interval || '')) return true;
    // Invalid non-empty drafts still need to enable Save so validation can run
    // and return focus to the offending field.
    if (!interval.ok && intervalControl.inputs[0].value.trim()) return true;
    const window = windowControl.get();
    if (window.text !== String(saved.digest_window || '')) return true;
    if (!window.ok && windowControl.inputs[0].value.trim()) return true;
    const minParsed = parseStrictIntegerInput(minMessagesInput.value, MIN_MESSAGES_LIMIT);
    if (minParsed.ok && minParsed.value !== Number(saved.min_messages_per_digest ?? 30)) return true;
    if (!minParsed.ok && minMessagesInput.value.trim()) return true;
    return rulesDraftSignature() !== rulesSavedSignature();
  }

  // ---------------------------------------------------------------------------
  // 填值
  // ---------------------------------------------------------------------------
  function applySettings(settings, { preserveDirty = true } = {}) {
    const savedScheduler = settings?.scheduler || {};
    if (!preserveDirty || !draft.whitelistDirty) {
      // 只保留规范形引用;旧格式引用由服务端保留,不在本编辑器中出现。
      const list = Array.isArray(settings?.groups?.whitelist) ? settings.groups.whitelist : [];
      draft.whitelist = list.map(ref => canonicalWhitelistRef(ref, '')).filter(Boolean);
      draft.whitelistDirty = false;
      page.markDirty('groups', false);
    }
    if (!preserveDirty || !draft.schedulerDirty) {
      enabledToggle.checked = !!savedScheduler.enabled;
      intervalControl.set(String(savedScheduler.default_interval || '30m'));
      windowControl.set(String(savedScheduler.digest_window || '4h'));
      minMessagesInput.value = String(Number(savedScheduler.min_messages_per_digest ?? 30));
      const rules = Array.isArray(savedScheduler.per_group) ? savedScheduler.per_group : [];
      draft.rules = rules
        .map(rule => canonicalWhitelistRef(rule, '') && {
          account_id: String(rule.account_id || ''),
          ...(rule.group_id ? { group_id: String(rule.group_id) } : {}),
          ...(rule.group_name ? { group_name: String(rule.group_name) } : {}),
          keywords: Array.isArray(rule.keywords) ? [...rule.keywords] : [],
          min_messages: Math.max(0, Number(rule.min_messages || 0) || 0),
        })
        .filter(Boolean);
      draft.schedulerDirty = false;
      page.markDirty('scheduler', false);
    }
    const disabledReason = String(savedScheduler.disabled_reason || '').trim();
    disabledReasonNote.textContent = !savedScheduler.enabled && disabledReason
      ? `当前停用原因:${disabledReasonLabel(disabledReason)}`
      : '';
    renderWhitelist();
    renderRules();
    renderRulePicker();
    renderGroupPicker();
    saveWhitelistBtn.disabled = !draft.whitelistDirty || page.isBusy();
    saveSchedulerBtn.disabled = !draft.schedulerDirty || page.isBusy();
  }

  function disabledReasonLabel(reason, publicLabel = '') {
    const normalizedPublicLabel = String(publicLabel || '').trim();
    if (normalizedPublicLabel) return normalizedPublicLabel;
    switch (reason) {
      case 'persisted_disabled': return '设置中未启用';
      case 'user_disabled': return '手动停用';
      case 'setup_required': return '尚未完成初始配置';
      case 'secrets_invalid': return '本机密钥库不可读';
      case 'llm_not_configured': return 'AI 未配置';
      case 'llm_base_url_missing': return '缺少 Base URL';
      case 'llm_api_key_missing': return '缺少 API Key';
      case 'llm_model_missing': return '缺少模型';
      case 'wechat_manual_key_required': return '需要手动数据库密钥';
      case 'manual_key_unverified': return '手动密钥未验证';
      case 'scheduler_no_targets': return '没有可用目标群';
      case 'scheduler_unscoped_targets': return '目标群未绑定账号';
      case 'scheduler_targets_need_review': return '目标群需要复核';
      case 'reschedule_setup_required': return '需要重新配置调度';
      case 'account_list_unavailable': return '微信账号列表读取失败';
      case 'settings_unavailable': return '设置读取失败';
      case 'runtime_stopped': return '后台定时器未运行';
      default: return '未知停用原因';
    }
  }

  // ---------------------------------------------------------------------------
  // 保存
  // ---------------------------------------------------------------------------
  async function saveWhitelist() {
    const account = currentAccount();
    const context = page.requestContext(account);
    if (!context) {
      status.set('修改群白名单需要当前微信账号;请先在左下角选择账号。', 'err');
      return;
    }
    if (draft.whitelist.length > 500) {
      status.set('白名单最多 500 条,请先移除一部分。', 'err');
      return;
    }
    const token = page.beginAction('保存白名单', [saveWhitelistBtn, saveSchedulerBtn]);
    status.set('正在保存白名单…');
    try {
      const result = await page.saveSection({
        groups: { whitelist: draft.whitelist.map(ref => ({ ...ref })) },
        _request_context: context,
      }, { signal: token.signal, ownerToken: token });
      if (!page.alive(token)) return;
      draft.whitelistDirty = false;
      page.markDirty('groups', false);
      status.set(page.saveSummaryText(result, '白名单已保存。'), page.saveHasWarnings(result) ? 'warn' : 'ok');
      applySchedulerMutationResult(applySettings, page.getSettings());
      void pollSchedulerStatus();
    } catch (error) {
      if (!page.alive(token) || isAbortError(error)) return;
      status.set(errorText(error, '保存白名单失败'), 'err');
    } finally {
      page.endAction(token);
    }
  }

  async function saveScheduler() {
    const interval = intervalControl.get();
    const windowValue = windowControl.get();
    if (!interval.ok || !durationToMs(interval.text)) {
      setFieldInvalid(intervalControl.inputs[0], true);
      status.set('检查间隔必须是正整数加单位(分钟/小时/天),例如 30m、4h、1d。', 'err');
      focusFirstInvalid(intervalControl.inputs);
      return;
    }
    setFieldInvalid(intervalControl.inputs[0], false);
    if (!windowValue.ok || !durationToMs(windowValue.text)) {
      setFieldInvalid(windowControl.inputs[0], true);
      status.set('总结窗口必须是正整数加单位(分钟/小时/天),例如 30m、4h、1d。', 'err');
      focusFirstInvalid(windowControl.inputs);
      return;
    }
    setFieldInvalid(windowControl.inputs[0], false);
    const minParsed = parseStrictIntegerInput(minMessagesInput.value, MIN_MESSAGES_LIMIT);
    if (!minParsed.ok) {
      setFieldInvalid(minMessagesInput, true);
      status.set(`最少消息数必须是 ${MIN_MESSAGES_LIMIT.min}–${MIN_MESSAGES_LIMIT.max} 的整数。`, 'err');
      focusFirstInvalid([minMessagesInput]);
      return;
    }
    setFieldInvalid(minMessagesInput, false);
    const enabling = enabledToggle.checked;
    const patch = {
      enabled: enabling,
      ...(enabling ? {} : { disabled_reason: 'user_disabled', disabled_at: new Date().toISOString() }),
      default_interval: interval.text,
      digest_window: windowValue.text,
      min_messages_per_digest: minParsed.value,
      per_group: draft.rules
        .map(rule => ({
          account_id: String(rule.account_id || ''),
          ...(rule.group_id ? { group_id: String(rule.group_id) } : {}),
          ...(rule.group_name ? { group_name: String(rule.group_name) } : {}),
          keywords: (Array.isArray(rule.keywords) ? rule.keywords : []).slice(0, 20),
          min_messages: Math.max(0, Number(rule.min_messages || 0) || 0),
        }))
        // 与服务端 normalizePerGroupOverrides 对齐:空规则(无关键词且无覆盖)不落盘。
        .filter(rule => rule.keywords.length || rule.min_messages > 0),
    };
    const context = page.requestContext(currentAccount());
    const body = { scheduler: patch, ...(context ? { _request_context: context } : {}) };
    const token = page.beginAction('保存调度设置', [saveWhitelistBtn, saveSchedulerBtn]);
    status.set('正在保存调度设置…');
    try {
      const result = await page.saveSection(body, { signal: token.signal, ownerToken: token });
      if (!page.alive(token)) return;
      draft.schedulerDirty = false;
      page.markDirty('scheduler', false);
      status.set(page.saveSummaryText(result, '调度设置已保存。'), page.saveHasWarnings(result) ? 'warn' : 'ok');
      applySchedulerMutationResult(applySettings, page.getSettings());
      void pollSchedulerStatus();
    } catch (error) {
      if (!page.alive(token) || isAbortError(error)) return;
      status.set(errorText(error, '保存调度设置失败'), 'err');
    } finally {
      page.endAction(token);
    }
  }

  // ---------------------------------------------------------------------------
  // 调度状态轮询
  // ---------------------------------------------------------------------------
  function paintSchedulerStatus(payload) {
    const scheduler = payload?.scheduler || null;
    draft.lastStatus = scheduler;
    if (!scheduler) return;
    const kv = (k, v) => el('div', { class: 'settings-kv' },
      el('span', { class: 'settings-kv-k', text: k }),
      el('span', { class: 'settings-kv-v', text: v || '—', title: v || '' }));
    const enabledText = scheduler.enabled
      ? (scheduler.effective_enabled ? '已启用(运行中)' : '已启用(待调度)')
      : '未启用';
    statusGrid.replaceChildren(
      kv('开关状态', enabledText),
      kv('检查间隔', fmtIntervalMs(scheduler.interval_ms)),
      kv('下次检查', fmtDateTime(scheduler.next_run_at)),
      kv('上次开始', fmtDateTime(scheduler.last_started_at)),
      kv('上次结束', fmtDateTime(scheduler.last_finished_at)),
      kv('目标预览', scheduler.target_preview
        ? `${Math.max(0, Number(scheduler.target_preview.target_count || 0))} 个目标`
        : (scheduler.target_preview_error ? '预览不可用' : '—')),
    );
    const notes = [];
    if (scheduler.disabled_reason) {
      notes.push(`停用原因:${disabledReasonLabel(scheduler.disabled_reason, scheduler.disabled_reason_label)}`);
    }
    if (scheduler.target_preview_error) notes.push(`目标预览:${scheduler.target_preview_error}`);
    if (scheduler.last_error) notes.push(`最近错误:${scheduler.last_error}`);
    runStatus.set(notes.join('\n'), notes.length ? 'warn' : '');

    // 运行进度
    const progress = scheduler.active_progress;
    if (scheduler.running && progress) {
      const total = Math.max(0, Number(progress.total_targets || 0));
      const done = Math.max(0, Number(progress.completed_targets || 0));
      const bar = el('div', { class: 'progress-track' },
        el('div', { class: 'progress-fill', style: `width:${total ? Math.round((done / total) * 100) : 0}%` }));
      progressWrap.replaceChildren(
        el('div', { class: 'settings-progress-text', text: `${progress.label || '正在检查'} ${done}/${total || '?'} ${progress.detail || ''}`.trim() }),
        bar,
      );
    } else {
      progressWrap.replaceChildren(
        el('div', { class: 'settings-progress-text', text: scheduler.running ? '正在启动检查…' : '当前没有运行中的检查。' }),
      );
    }

    // 上次结果
    const last = scheduler.last_result;
    if (last) {
      const summary = `检查 ${last.checked} · 生成 ${last.generated} · 跳过 ${last.skipped} · 失败 ${last.failed}${last.at ? `(${fmtDateTime(last.at)})` : ''}`;
      const items = (Array.isArray(last.items) ? last.items : []).slice(0, 12).map(item => el('div', {
        class: 'batch-result-row',
        'data-outcome': item.error ? 'fail' : (item.generated ? 'ok' : ''),
      },
        el('span', { class: 'batch-result-name', text: item.label || '(未命名群)' }),
        el('span', {
          class: `batch-result-status ${item.error ? 'fail' : (item.generated ? 'ok' : 'skip')}`,
          text: item.error ? (item.error_summary || '失败') : (item.generated ? '已生成' : '跳过'),
        }),
      ));
      lastResultWrap.replaceChildren(
        el('div', { class: 'settings-progress-text', text: `上次结果:${summary}` }),
        el('div', { class: 'batch-result-list' }, items),
      );
    } else {
      lastResultWrap.replaceChildren(
        el('div', { class: 'settings-progress-text', text: '还没有检查记录。' }),
      );
    }
    runOnceBtn.disabled = page.isBusy() || scheduler.running === true;
    clearLegacyBtn.disabled = page.isBusy() || scheduler.running === true || !scheduler.legacy_cursor_cleanup_token;
  }

  const schedulerStatusPoll = createLatestSchedulerStatusPoll({
    async fetchStatus({ signal }) {
      const token = page.softToken();
      const accountToken = accountScope.ensure(currentAccountContextIdentity());
      try {
        const payload = requireSchedulerStatusResult(await api.get('/api/scheduler/status', {
          signal,
          timeoutMs: 30_000,
        }));
        return { payload, token, accountToken };
      } catch (error) {
        if (!page.alive(token)
          || !accountScope.isCurrent(accountToken, currentAccountContextIdentity())
          || isAbortError(error)) return null;
        throw error;
      }
    },
    applyStatus(result) {
      if (!result
        || !page.alive(result.token)
        || !accountScope.isCurrent(result.accountToken, currentAccountContextIdentity())) return;
      paintSchedulerStatus(result.payload);
      page.observeRuntimePayload(result.payload);
    },
    onError(error) {
      runStatus.set(errorText(error, '调度状态读取失败'), 'err');
    },
  });

  function pollSchedulerStatus() {
    return schedulerStatusPoll.request();
  }

  // ---------------------------------------------------------------------------
  // 维护操作
  // ---------------------------------------------------------------------------
  async function runOnce() {
    if (!page.getBaseRevision()) {
      runStatus.set('设置尚未加载完成,无法执行检查。', 'err');
      return;
    }
    const confirmed = await ui.confirmDialog({
      title: '立即检查一次',
      message: '将按当前已保存的设置立即检查所有目标群。未保存的草稿不会生效。',
      confirmLabel: '立即检查',
    });
    if (!confirmed) return;
    const revision = page.getBaseRevision();
    if (!revision) {
      runStatus.set('设置状态在确认期间失效,请重新载入后再执行检查。', 'err');
      return;
    }
    const token = page.beginAction('手动检查', [runOnceBtn, saveSchedulerBtn, saveWhitelistBtn]);
    if (!token) return;
    schedulerStatusPoll.invalidate();
    runStatus.set('正在检查所有目标群(可能需要几分钟)…');
    try {
      const result = await api.post('/api/scheduler/run-once', { base_settings_revision: revision }, {
        signal: token.signal,
        timeoutMs: 0,
      });
      if (!page.alive(token)) return;
      const checkedResult = requireSchedulerRunOnceResult(result);
      schedulerStatusPoll.invalidate();
      paintSchedulerStatus(checkedResult);
      page.observeRuntimePayload(checkedResult);
      const summary = `检查完成:检查 ${checkedResult.result.checked} · 生成 ${checkedResult.result.generated} · 跳过 ${checkedResult.result.skipped} · 失败 ${checkedResult.result.failed}`;
      runStatus.set(checkedResult.cancelled_after_commit ? `${summary}(保存后状态复核被取消,请稍后刷新确认)` : summary,
        checkedResult.result.failed || checkedResult.result.ok === false ? 'warn' : 'ok');
    } catch (error) {
      if (!page.alive(token) || isAbortError(error)) return;
      if (error?.status === 428 && error?.code === 'settings_revision_required') {
        runStatus.set('缺少当前设置版本,请重新载入设置页后再执行。', 'err');
      } else if (error?.status === 409) {
        runStatus.set('设置已在别处更新,请重新载入后再执行检查。', 'err');
        page.markStale();
      } else {
        runStatus.set(errorText(error, '手动检查失败'), 'err');
      }
    } finally {
      page.endAction(token);
    }
  }

  async function revalidateStore(store) {
    const label = store === 'cursors' ? '游标文件' : '待提交游标文件';
    const token = page.beginAction(`重新校验${label}`, [revalidateCursorsBtn, revalidatePendingBtn]);
    if (!token) return;
    maintainStatus.set(`正在重新校验${label}…`);
    try {
      const result = await api.post('/api/scheduler/revalidate-store', { store }, { signal: token.signal });
      if (!page.alive(token)) return;
      const blocked = requireSchedulerStoreRevalidationResult(result, store);
      maintainStatus.set(blocked
        ? `${label}已重新校验,仍有 ${blocked} 个调度文件需要处理。`
        : `${label}已重新校验,没有遗留的损坏调度文件。`, blocked ? 'warn' : 'ok');
      void pollSchedulerStatus();
    } catch (error) {
      if (!page.alive(token) || isAbortError(error)) return;
      if (error?.status === 409 && error?.code === 'scheduler_running') {
        maintainStatus.set('后台检查正在运行,请等本轮结束后再重新校验。', 'warn');
      } else {
        maintainStatus.set(errorText(error, '重新校验失败'), 'err');
      }
    } finally {
      page.endAction(token);
    }
  }

  async function clearLegacyCursors() {
    if (!String(draft.lastStatus?.legacy_cursor_cleanup_token || '').trim()) {
      maintainStatus.set('当前没有可清理的未验证游标(或状态令牌已失效,请等待下一次状态刷新)。', 'warn');
      return;
    }
    const confirmed = await ui.confirmDialog({
      title: '清理未验证游标',
      message: '将删除未通过验证的失效调度游标;下次检查会按当前规则重新确定读取位置。确认继续?',
      confirmLabel: '清理',
      danger: true,
    });
    if (!confirmed) return;
    const tokenValue = String(draft.lastStatus?.legacy_cursor_cleanup_token || '').trim();
    if (!tokenValue || draft.lastStatus?.running === true) {
      maintainStatus.set('调度状态在确认期间已变化,请等待状态刷新后重新确认。', 'warn');
      return;
    }
    const token = page.beginAction('清理未验证游标', [clearLegacyBtn]);
    if (!token) return;
    maintainStatus.set('正在清理未验证游标…');
    try {
      const result = await api.post('/api/scheduler/clear-unverified-legacy-cursors', {
        legacy_cursor_cleanup_token: tokenValue,
      }, { signal: token.signal, ownerToken: token });
      if (!page.alive(token)) return;
      const checkedResult = requireSchedulerLegacyCursorCleanupResult(result);
      schedulerStatusPoll.invalidate();
      paintSchedulerStatus(checkedResult);
      if (checkedResult.ok === false) {
        const detail = String(checkedResult.local_action_after_commit_error || '').trim();
        maintainStatus.set(detail || `未验证游标仅部分清理：已清理 ${checkedResult.cleared}，失败 ${checkedResult.failed_count || 0}。`, 'warn');
        void pollSchedulerStatus();
      } else if (checkedResult.cancelled_after_commit === true) {
        maintainStatus.set('清理请求已执行，但保存后状态复核被取消；正在刷新状态，请勿重复点击。', 'warn');
        void pollSchedulerStatus();
      } else {
        maintainStatus.set('未验证游标已清理。', 'ok');
      }
    } catch (error) {
      if (!page.alive(token) || isAbortError(error)) return;
      if (error?.status === 409 && error?.code === 'scheduler_running') {
        maintainStatus.set('后台检查正在运行,请等本轮结束后再清理。', 'warn');
      } else if (error?.code === 'scheduler_legacy_cursor_cleanup_response_invalid') {
        maintainStatus.set('清理请求可能已经执行，但返回响应无效；正在刷新调度状态确认，请勿重复点击。', 'warn');
        void pollSchedulerStatus();
      } else if (error?.status === 409 || error?.status === 428) {
        maintainStatus.set(`${errorText(error, '清理失败')}请等待调度状态刷新后重试。`, 'err');
        void pollSchedulerStatus();
      } else {
        maintainStatus.set(errorText(error, '清理未验证游标失败'), 'err');
      }
    } finally {
      page.endAction(token);
    }
  }

  async function cleanLegacyRefs() {
    const confirmed = await ui.confirmDialog({
      title: '清理未绑定账号的白名单引用',
      message: '将移除白名单里未绑定账号的引用,每群规则中的引用保持不变。此操作会立即保存,确认继续?',
      confirmLabel: '清理并保存',
      danger: true,
    });
    if (!confirmed) return;
    const token = page.beginAction('清理未绑定账号的白名单引用', [cleanLegacyRefsBtn, saveWhitelistBtn]);
    if (!token) return;
    status.set('正在清理未绑定账号的白名单引用…');
    try {
      const result = await page.saveSection({
        settings_ops: {
          remove_unscoped_legacy_whitelist: true,
        },
      }, { signal: token.signal, ownerToken: token });
      if (!page.alive(token)) return;
      status.set(page.saveSummaryText(result, '未绑定账号的白名单引用已清理。'), page.saveHasWarnings(result) ? 'warn' : 'ok');
      applySchedulerMutationResult(applySettings, page.getSettings());
      void pollSchedulerStatus();
    } catch (error) {
      if (!page.alive(token) || isAbortError(error)) return;
      status.set(errorText(error, '清理未绑定账号的白名单引用失败'), 'err');
    } finally {
      page.endAction(token);
    }
  }

  // ---- 事件 ------------------------------------------------------------------
  enabledToggle.addEventListener('change', handleDraftChange);
  minMessagesInput.addEventListener('input', handleDraftChange);
  groupSearch.addEventListener('input', renderGroupPicker);
  refreshGroupsBtn.addEventListener('click', () => { void loadGroups(); });
  addRuleBtn.addEventListener('click', addRuleFromPicker);
  saveWhitelistBtn.addEventListener('click', () => { void saveWhitelist(); });
  saveSchedulerBtn.addEventListener('click', () => { void saveScheduler(); });
  runOnceBtn.addEventListener('click', () => { void runOnce(); });
  revalidateCursorsBtn.addEventListener('click', () => { void revalidateStore('cursors'); });
  revalidatePendingBtn.addEventListener('click', () => { void revalidateStore('pending_cursors'); });
  clearLegacyBtn.addEventListener('click', () => { void clearLegacyCursors(); });
  cleanLegacyRefsBtn.addEventListener('click', () => { void cleanLegacyRefs(); });

  // ---- 装配 ------------------------------------------------------------------
  const section = el('section', { class: 'settings-section', 'data-section': 'groups' },
    el('div', { class: 'settings-section-head' },
      el('h2', { class: 'settings-section-title', text: '群与调度' }),
      el('p', { class: 'muted', text: '选择要总结的群(白名单),并配置后台自动检查。' }),
    ),
    el('div', { class: 'card card-pad settings-card' },
      el('h3', { class: 'card-title', text: '群白名单' }),
      el('div', null,
        el('label', { class: 'field-label', text: '已加入白名单' }),
        whitelistChips,
        whitelistLegacyNote,
      ),
      el('div', { class: 'settings-picker' },
        el('div', { class: 'settings-inline' }, groupSearch, refreshGroupsBtn),
        pickerList,
        pickerStatus,
      ),
      el('div', { class: 'settings-actions' }, saveWhitelistBtn, cleanLegacyRefsBtn),
    ),
    el('div', { class: 'card card-pad settings-card' },
      el('h3', { class: 'card-title', text: '自动检查' }),
      el('div', null, enabledLabel, disabledReasonNote),
      el('div', { class: 'settings-grid' },
        el('div', { class: 'settings-field' },
          el('label', { class: 'field-label', text: '检查间隔(最长 24 天)' }),
          intervalControl.el,
        ),
        el('div', { class: 'settings-field' },
          el('label', { class: 'field-label', text: '总结窗口(最长 24 天)' }),
          windowControl.el,
        ),
        el('div', { class: 'settings-field' },
          el('label', { class: 'field-label', text: `最少消息数(${MIN_MESSAGES_LIMIT.min}–${MIN_MESSAGES_LIMIT.max})` }),
          minMessagesInput,
        ),
      ),
      el('div', null,
        el('label', { class: 'field-label', text: '每群规则(关键词过滤 / 最少消息数覆盖)' }),
        ruleList,
        el('div', { class: 'settings-inline' }, rulePickerSelect, addRuleBtn),
      ),
      el('div', { class: 'settings-actions' }, saveSchedulerBtn, status.el),
    ),
    el('div', { class: 'card card-pad settings-card' },
      el('h3', { class: 'card-title', text: '调度状态' }),
      statusGrid,
      progressWrap,
      lastResultWrap,
      el('div', { class: 'settings-actions' }, runOnceBtn, runStatus.el),
    ),
    el('div', { class: 'card card-pad settings-card' },
      el('h3', { class: 'card-title', text: '调度文件维护' }),
      el('div', { class: 'settings-actions' },
        revalidateCursorsBtn, revalidatePendingBtn, clearLegacyBtn, maintainStatus.el),
    ),
  );

  return {
    id: 'groups',
    el: section,
    applySettings,
    pollSchedulerStatus,
    async saveDraft() {
      if (draft.whitelistDirty) await saveWhitelist();
      if (draft.schedulerDirty) await saveScheduler();
    },
    onAccountChanged() {
      accountScope.switchTo(currentAccountContextIdentity());
      schedulerStatusPoll.invalidate();
      try { activeGroupAction?.controller?.abort(new DOMException('账号已切换', 'AbortError')); } catch {}
      draft.groupsLoading = false;
      draft.groups = null;
      draft.lastStatus = null;
      status.clear();
      runStatus.clear();
      maintainStatus.clear();
      statusGrid.replaceChildren();
      progressWrap.replaceChildren(el('div', { class: 'settings-progress-text', text: '当前没有运行中的检查。' }));
      lastResultWrap.replaceChildren(el('div', { class: 'settings-progress-text', text: '还没有检查记录。' }));
      renderWhitelist();
      renderGroupPicker();
      renderRulePicker();
      void pollSchedulerStatus();
    },
    destroy() {
      schedulerStatusPoll.dispose();
    },
    setBusy(busy) {
      syncFormControlsDisabled([
        groupSearch,
        enabledToggle,
        ...intervalControl.inputs,
        ...windowControl.inputs,
        minMessagesInput,
        rulePickerSelect,
        addRuleBtn,
        ...whitelistChips.querySelectorAll('button'),
        ...pickerList.querySelectorAll('input'),
        ...ruleList.querySelectorAll('input, button'),
      ], busy);
      saveWhitelistBtn.disabled = busy || !draft.whitelistDirty;
      saveSchedulerBtn.disabled = busy || !draft.schedulerDirty;
      refreshGroupsBtn.disabled = busy;
      renderRulePicker();
      runOnceBtn.disabled = busy || draft.lastStatus?.running === true;
      clearLegacyBtn.disabled = busy || draft.lastStatus?.running === true
        || !draft.lastStatus?.legacy_cursor_cleanup_token;
      syncSchedulerMaintenanceButtons({
        cursors: revalidateCursorsBtn,
        pending: revalidatePendingBtn,
        legacyRefs: cleanLegacyRefsBtn,
      }, { busy });
    },
  };
}
