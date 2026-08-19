// 设置页 · 渲染与输出分区:默认主题/字号、输出目录(本地动作打开)、保留天数、文件名模板。
import { isMutationOutcomeUnknown } from '/js/api.js';
import { parseStrictIntegerInput } from '/js/shared/numeric-input.js';
import { classifyLocalActionRecovery } from '/js/shared/local-action-recovery-state.js';
import {
  forgetLocalActionRecovery,
  localActionEvidenceQuery,
  localActionEvidenceSettled,
  localActionPendingStoragePrefix,
  readPendingLocalActionRecords,
  settleLocalActionInBackground,
} from '/js/shared/local-action-recovery.js';
import {
  el,
  createStatusLine,
  errorText,
  isAbortError,
  createLocalActionId,
} from './core.js';
import { focusFirstInvalid, setFieldInvalid } from '/js/shared/form-accessibility.js';
import { syncFormControlsDisabled } from '/js/shared/form-busy-controls.js';
import { setSegmentedButtonState } from '../../ui/segmented.js';

const THEMES = Object.freeze([
  ['auto', '跟随系统'],
  ['light', '浅色'],
  ['dark', '深色'],
]);
const FONT_SIZES = Object.freeze([
  ['normal', '标准'],
  ['large', '大'],
]);
const RETENTION_LIMIT = Object.freeze({ min: 0, max: 3650 });
const FILENAME_TOKEN_RE = /\{(?:group|since|until|id8)\}/;

export function latestPendingOutputAction(records = []) {
  const candidates = (Array.isArray(records) ? records : [])
    .filter(record => record?.kind === 'open_output' && String(record.action_id || '').trim())
    .map((record, index) => ({
      record,
      index,
      at: Number(record.at || 0) || 0,
    }))
    .sort((left, right) => left.at - right.at || left.index - right.index);
  const latest = candidates.at(-1)?.record;
  if (!latest) return null;
  const outputDirIdentity = String(latest.target?.output_dir_identity || '').trim();
  return {
    kind: 'open_output',
    actionId: String(latest.action_id).trim(),
    ...(outputDirIdentity ? { target: { output_dir_identity: outputDirIdentity } } : {}),
  };
}

function outputDirValid(value) {
  const text = String(value || '').trim();
  // 与服务端 output.dir 约束对齐:必须在 outputs/ 子目录内,且不是 outputs/.tmp。
  return /^\.?\/?outputs\/[^/\\]+/.test(text) && !/^\.?\/?outputs\/\.tmp(?:\/|$)/.test(text);
}

export function createOutputSection(page) {
  const { api, ui } = page;
  const status = createStatusLine();
  const openStatus = createStatusLine();

  const themeSegmented = el('div', { class: 'segmented', role: 'group', 'aria-label': '默认主题' });
  const themeBtns = new Map();
  for (const [value, label] of THEMES) {
    const btn = el('button', { class: 'segmented-btn', type: 'button', text: label });
    btn.addEventListener('click', () => { draft.theme = value; syncSegmented(); handleDraftChange(); });
    themeBtns.set(value, btn);
    themeSegmented.append(btn);
  }
  const fontSegmented = el('div', { class: 'segmented', role: 'group', 'aria-label': '默认字号' });
  const fontBtns = new Map();
  for (const [value, label] of FONT_SIZES) {
    const btn = el('button', { class: 'segmented-btn', type: 'button', text: label });
    btn.addEventListener('click', () => { draft.fontSize = value; syncSegmented(); handleDraftChange(); });
    fontBtns.set(value, btn);
    fontSegmented.append(btn);
  }

  const dirInput = el('input', {
    class: 'input', type: 'text', placeholder: './outputs/digests',
    'aria-label': '输出目录', spellcheck: 'false',
  });
  const dirHint = el('div', { class: 'settings-hint', text: '必须是项目 outputs/ 下的子目录(不能是 outputs/.tmp);修改后已生成的长图仍留在原目录。' });
  const retentionInput = el('input', {
    class: 'input', type: 'text', inputmode: 'numeric', 'aria-label': '保留天数', placeholder: '0',
  });
  const patternInput = el('input', {
    class: 'input', type: 'text', 'aria-label': '文件名模板', spellcheck: 'false',
  });
  const patternHint = el('div', {
    class: 'settings-hint',
    text: '支持变量 {group} {since} {until} {id8};至少包含其中一个变量,自动补 .png 后缀。',
  });

  const openDirBtn = el('button', { class: 'btn btn-ghost', type: 'button', text: '打开输出目录' });
  const queryActionBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '查询结果', hidden: true });
  const saveBtn = el('button', { class: 'btn btn-primary', type: 'button', text: '保存渲染与输出' });

  const draft = {
    theme: 'auto',
    fontSize: 'normal',
    dirty: false,
    pendingAction: null, // { kind:'open_output', actionId, target } 结果未知时允许查询
  };
  let destroyed = false;
  let pendingRevision = 0;
  let removeStorageListener = () => {};

  function render() { return page.getSettings()?.render || {}; }
  function output() { return page.getSettings()?.output || {}; }

  function syncSegmented() {
    for (const [value, btn] of themeBtns) setSegmentedButtonState(btn, value === draft.theme);
    for (const [value, btn] of fontBtns) setSegmentedButtonState(btn, value === draft.fontSize);
  }

  function computeDirty() {
    const savedRender = render();
    const savedOutput = output();
    if (draft.theme !== String(savedRender.default_theme || 'auto')) return true;
    if (draft.fontSize !== String(savedRender.default_font_size || 'normal')) return true;
    if (dirInput.value.trim() !== String(savedOutput.dir || '')) return true;
    const parsed = parseStrictIntegerInput(retentionInput.value, RETENTION_LIMIT);
    if (parsed.ok && parsed.value !== Number(savedOutput.retention_days ?? 0)) return true;
    if (!parsed.ok && retentionInput.value.trim()) return true;
    if (patternInput.value.trim() !== String(savedOutput.filename_pattern || '')) return true;
    return false;
  }

  function markDirty() {
    draft.dirty = computeDirty();
    page.markDirty('output', draft.dirty);
    saveBtn.disabled = !draft.dirty || page.isBusy();
    syncOpenButton();
  }

  function syncOpenButton() {
    const dirChanged = dirInput.value.trim() !== String(output().dir || '');
    const pendingRecovery = !!draft.pendingAction;
    openDirBtn.disabled = page.isBusy() || dirChanged || pendingRecovery;
    openDirBtn.title = pendingRecovery
      ? '请先查询上一次打开输出目录的结果,不要重复发起请求'
      : (dirChanged ? '输出目录草稿未保存,请先保存后再打开新目录' : '打开当前已保存的输出目录');
  }

  function outputActionTargetIsCurrent(target) {
    const expected = String(target?.output_dir_identity || '').trim();
    const current = String(page.getOutputDirIdentity?.() || '').trim();
    return !!expected && !!current && expected === current;
  }

  function outputActionRecoveryPending(actionId) {
    const cleanId = String(actionId || '').trim();
    if (!cleanId) return { pending: true, error: new Error('本机动作标识无效') };
    try {
      return {
        pending: readPendingLocalActionRecords()
          .some(record => record?.action_id === cleanId),
        error: null,
      };
    } catch (error) {
      // 已确认的本机副作用不能因为浏览器存储暂时不可读而被当成
      // 已完成清理;保留查询入口让用户稍后重试。
      return { pending: true, error };
    }
  }

  function samePendingAction(left, right) {
    return !!left && !!right
      && left.kind === right.kind
      && left.actionId === right.actionId
      && String(left.target?.output_dir_identity || '').trim()
        === String(right.target?.output_dir_identity || '').trim();
  }

  function syncPendingOutputActionFromStorage({ announce = true } = {}) {
    if (destroyed) return false;
    let records;
    try {
      records = readPendingLocalActionRecords();
    } catch {
      return false;
    }
    const next = latestPendingOutputAction(records);
    const previous = draft.pendingAction;
    if (samePendingAction(previous, next)) {
      draft.pendingAction = next;
      syncOpenButton();
      return false;
    }
    pendingRevision += 1;
    draft.pendingAction = next;
    if (next) {
      queryActionBtn.hidden = false;
      if (announce) {
        openStatus.set('另一标签页正在等待打开输出目录的结果;请点击“查询结果”核对,不要重复打开。', 'warn');
      }
    } else {
      queryActionBtn.hidden = true;
      if (previous) openStatus.clear();
    }
    syncOpenButton();
    return true;
  }

  function pendingActionStillCurrent(pending, revision) {
    return !destroyed
      && pendingRevision === revision
      && samePendingAction(draft.pendingAction, pending);
  }

  function applySettings(settings, { preserveDirty = true } = {}) {
    const savedRender = settings?.render || {};
    const savedOutput = settings?.output || {};
    if (!preserveDirty || !draft.dirty) {
      draft.theme = THEMES.some(([value]) => value === savedRender.default_theme) ? savedRender.default_theme : 'auto';
      draft.fontSize = FONT_SIZES.some(([value]) => value === savedRender.default_font_size)
        ? savedRender.default_font_size : 'normal';
      dirInput.value = String(savedOutput.dir || '');
      retentionInput.value = String(Number(savedOutput.retention_days ?? 0));
      patternInput.value = String(savedOutput.filename_pattern || '');
      draft.dirty = false;
      page.markDirty('output', false);
    }
    syncSegmented();
    saveBtn.disabled = !draft.dirty || page.isBusy();
    syncOpenButton();
  }

  async function save() {
    const dir = dirInput.value.trim();
    if (!outputDirValid(dir)) {
      setFieldInvalid(dirInput, true);
      status.set('输出目录必须是 outputs/ 下的子目录(例如 ./outputs/digests),且不能是 outputs/.tmp。', 'err');
      focusFirstInvalid([dirInput]);
      return;
    }
    setFieldInvalid(dirInput, false);
    const retention = parseStrictIntegerInput(retentionInput.value, { ...RETENTION_LIMIT, clamp: true });
    if (!retention.ok) {
      setFieldInvalid(retentionInput, true);
      status.set(`保留天数必须是 ${RETENTION_LIMIT.min}–${RETENTION_LIMIT.max} 的整数(0 = 不自动清理)。`, 'err');
      focusFirstInvalid([retentionInput]);
      return;
    }
    setFieldInvalid(retentionInput, false);
    const pattern = patternInput.value.trim();
    if (!pattern) {
      setFieldInvalid(patternInput, true);
      status.set('文件名模板不能为空。', 'err');
      focusFirstInvalid([patternInput]);
      return;
    }
    if (!FILENAME_TOKEN_RE.test(pattern)) {
      setFieldInvalid(patternInput, true);
      status.set('文件名模板至少包含 {group}、{since}、{until}、{id8} 中的一个变量。', 'err');
      focusFirstInvalid([patternInput]);
      return;
    }
    setFieldInvalid(patternInput, false);
    const token = page.beginAction('保存渲染与输出', [saveBtn, openDirBtn]);
    status.set('正在保存渲染与输出设置…');
    try {
      const result = await page.saveSection({
        render: { default_theme: draft.theme, default_font_size: draft.fontSize },
        output: { dir, retention_days: retention.value, filename_pattern: pattern },
      }, { signal: token.signal, ownerToken: token });
      if (!page.alive(token)) return;
      draft.dirty = false;
      page.markDirty('output', false);
      const switched = result?.output_dir_changed === true;
      status.set(
        page.saveSummaryText(result, `渲染与输出设置已保存。${switched ? '输出目录已切换,进行中的摘要与后台检查已按新目录处理。' : ''}`),
        page.saveHasWarnings(result) || switched ? 'warn' : 'ok',
      );
      applySettings(page.getSettings(), { preserveDirty: false });
    } catch (error) {
      if (!page.alive(token) || isAbortError(error)) return;
      status.set(errorText(error, '保存失败'), 'err');
    } finally {
      page.endAction(token);
    }
  }

  // 本地动作:打开输出目录。结果未知时提供“查询结果”入口。
  async function queryPendingAction() {
    const pending = draft.pendingAction;
    if (!pending) return;
    const revision = pendingRevision;
    const token = page.beginAction('查询本地动作结果', [queryActionBtn]);
    openStatus.set('正在查询本地动作结果…');
    try {
      const result = await api.get(
        localActionEvidenceQuery(pending.kind, pending.actionId, pending.target),
        { signal: token.signal },
      );
      if (!page.alive(token) || !pendingActionStillCurrent(pending, revision)) return;
      const evidence = result?.evidence || null;
      const evidenceSettled = localActionEvidenceSettled(pending.kind, evidence);
      if (evidenceSettled) {
        forgetLocalActionRecovery(pending.actionId);
      }
      const recovery = classifyLocalActionRecovery(evidence);
      if (recovery === 'verified' && !evidenceSettled) {
        openStatus.set('已确认打开输出目录,但本地记录尚未清理;请重试“查询结果”完成清理。', 'warn');
        draft.pendingAction = pending;
        queryActionBtn.hidden = false;
        syncOpenButton();
      } else if (recovery === 'verified' && outputActionTargetIsCurrent(pending.target)) {
        openStatus.set('已确认:输出目录已在文件管理器中打开。', 'ok');
        draft.pendingAction = null;
        queryActionBtn.hidden = true;
        syncOpenButton();
      } else if (recovery === 'verified') {
        openStatus.set('已确认打开之前的输出目录,当前目录已切换;请重新打开当前输出目录。', 'warn');
        // 该 action 已经被确认并清理；当前目录换代后不能把已完成的旧
        // marker 留在内存里，否则 pending gate 会永久锁住当前目录的打开按钮。
        draft.pendingAction = null;
        queryActionBtn.hidden = true;
        syncOpenButton();
      } else if (recovery === 'committed_unverified' || recovery === 'pending') {
        openStatus.set('本地服务已记录该请求,但未能完成核对;请查看文件管理器是否已打开。', 'warn');
      } else {
        openStatus.set('本地服务记录显示该操作未完成;请重试。', 'err');
      }
    } catch (error) {
      if (!page.alive(token) || isAbortError(error)) return;
      if (!pendingActionStillCurrent(pending, revision)) return;
      if (error?.code === 'local_action_evidence_target_mismatch') {
        try {
          forgetLocalActionRecovery(pending.actionId);
        } catch (cleanupError) {
          if (!page.alive(token) || isAbortError(cleanupError)) return;
          openStatus.set(errorText(cleanupError, '无法清理待核对动作记录'), 'err');
          return;
        }
        if (draft.pendingAction?.actionId === pending.actionId) {
          draft.pendingAction = null;
          queryActionBtn.hidden = true;
        }
        openStatus.set('待核对的输出目录动作已失效,请重新打开当前输出目录。', 'err');
        return;
      }
      const pendingTargetIdentity = String(pending.target?.output_dir_identity || '').trim();
      if (pendingTargetIdentity && !outputActionTargetIsCurrent(pending.target)) return;
      openStatus.set(errorText(error, '查询失败'), 'err');
    } finally {
      page.endAction(token);
    }
  }

  async function openOutputDir() {
    if (draft.pendingAction) {
      queryActionBtn.hidden = false;
      openStatus.set('上一次打开输出目录的结果尚未确认,请先点击“查询结果”,不要重复打开。', 'warn');
      syncOpenButton();
      return;
    }
    const identity = page.getOutputDirIdentity();
    if (!identity) {
      openStatus.set('输出目录状态未就绪,请刷新 /api/state 后重试。', 'err');
      return;
    }
    const actionId = createLocalActionId('openout');
    const scheduleRecovery = () => void settleLocalActionInBackground({
      api,
      actionId,
      kind: 'open_output',
      target: { output_dir_identity: identity },
      maxWaitMs: 38_000,
    }).catch(() => {});
    const token = page.beginAction('打开输出目录', [openDirBtn]);
    openStatus.set('正在请求打开输出目录…');
    queryActionBtn.hidden = true;
    try {
      const result = await api.post('/api/open-output', {
        local_action_id: actionId,
        expected_output_dir_identity: identity,
      }, { signal: token.signal, timeoutMs: 60_000 });
      if (!page.alive(token)) return;
      const echoed = String(result?.local_action_id || '') === actionId;
      const recovery = echoed ? classifyLocalActionRecovery(result) : 'pending';
      const cleanup = recovery === 'verified' ? outputActionRecoveryPending(actionId) : null;
      if (recovery === 'verified'
        && outputActionTargetIsCurrent({ output_dir_identity: identity })
        && !cleanup.pending) {
        openStatus.set('输出目录已在文件管理器中打开。', 'ok');
        draft.pendingAction = null;
      } else if (recovery === 'verified' && cleanup.pending) {
        draft.pendingAction = {
          kind: 'open_output',
          actionId,
          target: { output_dir_identity: identity },
        };
        queryActionBtn.hidden = false;
        openStatus.set(cleanup.error
          ? errorText(cleanup.error, '已确认打开输出目录,但本地记录清理失败;请查询结果重试。')
          : '已确认打开输出目录,但本地记录尚未清理;请点击“查询结果”重试清理。', 'warn');
        syncOpenButton();
      } else if (recovery === 'verified') {
        openStatus.set('已确认打开之前的输出目录,当前目录已切换;请重新打开当前输出目录。', 'warn');
        draft.pendingAction = { kind: 'open_output', actionId, target: { output_dir_identity: identity } };
        queryActionBtn.hidden = false;
      } else if (recovery === 'committed_unverified') {
        scheduleRecovery();
        openStatus.set('打开请求已提交,但本地服务未能完成核对;请查看文件管理器。', 'warn');
        draft.pendingAction = { kind: 'open_output', actionId, target: { output_dir_identity: identity } };
        queryActionBtn.hidden = false;
      } else {
        scheduleRecovery();
        openStatus.set('打开请求已发送,但未收到确认;请点击“查询结果”核对,不要重复点击。', 'warn');
        draft.pendingAction = { kind: 'open_output', actionId, target: { output_dir_identity: identity } };
        queryActionBtn.hidden = false;
      }
    } catch (error) {
      if (!page.alive(token) || isAbortError(error)) return;
      if (isMutationOutcomeUnknown(error) || error?.code === 'local_action_outcome_unknown') {
        scheduleRecovery();
        openStatus.set('打开请求超时/断连,结果未知;请点击“查询结果”核对,不要立即重试。', 'warn');
        draft.pendingAction = { kind: 'open_output', actionId, target: { output_dir_identity: identity } };
        queryActionBtn.hidden = false;
      } else if (error?.status === 409 && error?.code === 'output_dir_changed') {
        openStatus.set('输出目录已切换,已停止打开其他输出目录;请重新载入设置后重试。', 'err');
        page.markStale();
      } else if (error?.status === 409 && error?.code === 'local_window_action_in_progress') {
        syncPendingOutputActionFromStorage();
        if (draft.pendingAction) {
          queryActionBtn.hidden = false;
          openStatus.set('另一标签页正在等待打开输出目录的结果;请点击“查询结果”核对。', 'warn');
        } else {
          openStatus.set(errorText(error, '打开输出目录失败'), 'err');
        }
      } else {
        openStatus.set(errorText(error, '打开输出目录失败'), 'err');
      }
    } finally {
      page.endAction(token);
    }
  }

  function handleDraftChange() {
    // Validation errors describe the previous draft; do not leave them visible after editing.
    setFieldInvalid(arguments[0]?.currentTarget, false);
    status.clear();
    markDirty();
  }

  function restorePendingOutputAction() {
    let records;
    try {
      records = readPendingLocalActionRecords();
    } catch {
      return;
    }
    const pending = latestPendingOutputAction(records);
    if (!pending) return;
    draft.pendingAction = pending;
    queryActionBtn.hidden = false;
    openStatus.set('上一次打开输出目录的结果尚未确认;请点击“查询结果”核对,不要立即重试。', 'warn');
  }

  function onStorage(event) {
    if (event?.storageArea && event.storageArea !== globalThis.localStorage) return;
    const key = event?.key;
    if (key !== null && key !== undefined
        && !String(key).startsWith(localActionPendingStoragePrefix())) return;
    syncPendingOutputActionFromStorage();
  }

  for (const input of [dirInput, retentionInput, patternInput]) input.addEventListener('input', handleDraftChange);
  saveBtn.addEventListener('click', () => { void save(); });
  openDirBtn.addEventListener('click', () => { void openOutputDir(); });
  queryActionBtn.addEventListener('click', () => { void queryPendingAction(); });

  const section = el('section', { class: 'settings-section', 'data-section': 'output' },
    el('div', { class: 'settings-section-head' },
      el('h2', { class: 'settings-section-title', text: '渲染与输出' }),
      el('p', { class: 'muted', text: '长图的默认外观与保存位置。' }),
    ),
    el('div', { class: 'card card-pad settings-card' },
      el('h3', { class: 'card-title', text: '渲染默认值' }),
      el('div', { class: 'settings-grid' },
        el('div', { class: 'settings-field' },
          el('label', { class: 'field-label', text: '默认主题' }),
          themeSegmented,
        ),
        el('div', { class: 'settings-field' },
          el('label', { class: 'field-label', text: '默认字号' }),
          fontSegmented,
        ),
      ),
    ),
    el('div', { class: 'card card-pad settings-card' },
      el('h3', { class: 'card-title', text: '输出' }),
      el('div', { class: 'settings-field' },
        el('label', { class: 'field-label', text: '输出目录' }),
        dirInput,
        dirHint,
      ),
      el('div', { class: 'settings-grid' },
        el('div', { class: 'settings-field' },
          el('label', { class: 'field-label', text: `保留天数(${RETENTION_LIMIT.min}–${RETENTION_LIMIT.max},0 = 不自动清理)` }),
          retentionInput,
        ),
        el('div', { class: 'settings-field' },
          el('label', { class: 'field-label', text: '文件名模板' }),
          patternInput,
        ),
      ),
      patternHint,
      el('div', { class: 'settings-actions' }, saveBtn, status.el),
      el('div', { class: 'settings-actions' }, openDirBtn, queryActionBtn, openStatus.el),
    ),
  );

  restorePendingOutputAction();
  const storageTarget = globalThis.window && typeof globalThis.window.addEventListener === 'function'
    ? globalThis.window : globalThis;
  storageTarget.addEventListener?.('storage', onStorage);
  removeStorageListener = () => storageTarget.removeEventListener?.('storage', onStorage);

  return {
    id: 'output',
    el: section,
    applySettings,
    async saveDraft() {
      if (draft.dirty) await save();
    },
    setBusy(busy) {
      syncFormControlsDisabled([
        ...themeBtns.values(),
        ...fontBtns.values(),
        dirInput,
        retentionInput,
        patternInput,
      ], busy);
      saveBtn.disabled = busy || !draft.dirty;
      syncOpenButton();
      if (busy) queryActionBtn.disabled = true;
      else queryActionBtn.disabled = false;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      removeStorageListener();
      removeStorageListener = () => {};
    },
  };
}
