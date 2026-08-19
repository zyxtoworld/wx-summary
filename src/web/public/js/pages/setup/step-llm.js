// 第 2 步:AI 接入(provider / base_url / api_key / model)。
// 契约(src/main.js):
// - GET /api/settings → publicSettings(llm.api_key 已脱敏,用 llm.api_key_set 判断是否已配置)。
// - POST /api/list-models { provider, base_url, api_key? } → { ok, models:[{id,...}] };
//   api_key 省略时服务端用已保存 key(bodyValueOrSaved)。
// - POST /api/test-llm { provider, base_url, api_key?, model, long_context_model }
//   → { ok, partial_ok, model_results:[{role, model, ok, ...}], latency_ms }。
// - PUT /api/settings { llm:{...}, base_settings_revision } → { settings, settings_revision,
//   need_setup, need_setup_reason, warnings, account_identity_upgrade, account };
//   缺 revision 报 428 settings_revision_required;版本冲突报 409 settings_revision_conflict。
import { isMutationOutcomeUnknown } from '/js/api.js';
import {
  compactErrorSummary,
  confirmInvalidSecretsReplacement,
  saveWizardSettings,
  syncWizardStateFromSettingsResponse,
} from './state.js';
import { configureLiveRegion } from '/js/ui/live-region.js';
import { focusFirstInvalid, setFieldInvalid } from './validation.js';
import {
  llmFormPrefillValues,
  rememberLlmDraft,
} from './llm-draft.js';
import { llmEndpointIdentity, llmIdentity } from '/js/shared/ai-identity.js';
import { validateAiBaseUrl } from '/js/shared/ai-base-url.js';
import { requireAiModelList } from '/js/shared/ai-model-list.js';
import { requireAiConnectivityResult } from '/js/shared/ai-connectivity-result.js';
import { captureActionFocus, restoreActionFocus } from '/js/shared/action-focus.js';
import { requireSettingsDocument } from '/js/shared/settings-document.js';

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const PROVIDERS = [
  ['openai', 'OpenAI 兼容接口(推荐)'],
  ['anthropic', 'Anthropic(Claude)'],
];

export function createLlmStep(w) {
  const { ctx, wiz } = w;
  const root = el('div', 'setup-section');
  root.append(
    el('h2', 'setup-title', '接入 AI 服务'),
    el('p', 'setup-desc',
      '摘要由你指定的 AI 接口生成。需要 OpenAI 兼容(或 Anthropic)的 Base URL、API Key 和模型名;'
      + 'Key 只保存在本机密钥库,不会上传。'),
  );

  const secretsAlert = el('div', 'alert-bar alert-warn');
  secretsAlert.hidden = true;
  const secretsText = el('span', 'alert-text', '');
  secretsAlert.append(secretsText);
  root.append(secretsAlert);

  const form = el('div', 'setup-form');

  // provider
  const providerField = el('div', 'setup-field');
  const providerLabel = el('label', 'field-label', '接口类型');
  const providerSelect = document.createElement('select');
  providerSelect.id = 'setup-llm-provider';
  providerLabel.htmlFor = providerSelect.id;
  providerSelect.className = 'select';
  for (const [value, label] of PROVIDERS) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    providerSelect.appendChild(option);
  }
  providerField.append(providerLabel, providerSelect);

  // base_url
  const baseField = el('div', 'setup-field');
  const baseLabel = el('label', 'field-label', 'Base URL(接口地址)');
  const baseInput = document.createElement('input');
  baseInput.id = 'setup-llm-base-url';
  baseLabel.htmlFor = baseInput.id;
  baseInput.className = 'input';
  baseInput.type = 'url';
  baseInput.placeholder = 'https://api.openai.com/v1 或你的兼容服务地址';
  baseInput.autocomplete = 'off';
  baseField.append(baseLabel, baseInput);

  // api_key
  const keyField = el('div', 'setup-field');
  const keyLabel = el('label', 'field-label', 'API Key');
  const keyInput = document.createElement('input');
  keyInput.id = 'setup-llm-api-key';
  keyLabel.htmlFor = keyInput.id;
  keyInput.className = 'input';
  keyInput.type = 'password';
  keyInput.placeholder = '粘贴你的 API Key';
  keyInput.autocomplete = 'new-password';
  keyField.append(keyLabel, keyInput);
  const keyHint = el('p', 'muted', '');
  keyField.appendChild(keyHint);

  // model(输入框 + datalist 拉取建议,允许自定义)
  const modelField = el('div', 'setup-field');
  const modelLabel = el('label', 'field-label', '模型');
  const modelRow = el('div', 'setup-field-row');
  const modelInput = document.createElement('input');
  modelInput.id = 'setup-llm-model';
  modelLabel.htmlFor = modelInput.id;
  modelInput.className = 'input';
  modelInput.type = 'text';
  modelInput.placeholder = '例如 gpt-4o-mini;可直接填写自定义模型名';
  modelInput.autocomplete = 'off';
  const modelListId = 'setup-model-list';
  modelInput.setAttribute('list', modelListId);
  const modelDatalist = document.createElement('datalist');
  modelDatalist.id = modelListId;
  const fetchModelsBtn = el('button', 'btn btn-ghost', '获取模型列表');
  fetchModelsBtn.type = 'button';
  modelRow.append(modelInput, fetchModelsBtn);
  modelField.append(modelLabel, modelRow, modelDatalist);

  // long_context_model(可选)
  const longField = el('div', 'setup-field');
  const longLabel = el('label', 'field-label', '长上下文模型(可选,留空则与上面相同)');
  const longInput = document.createElement('input');
  longInput.id = 'setup-llm-long-context-model';
  longLabel.htmlFor = longInput.id;
  longInput.className = 'input';
  longInput.type = 'text';
  longInput.placeholder = '消息特别多时使用的模型,可留空';
  longInput.autocomplete = 'off';
  const longListId = 'setup-model-long-list';
  longInput.setAttribute('list', longListId);
  const longDatalist = document.createElement('datalist');
  longDatalist.id = longListId;
  longField.append(longLabel, longInput, longDatalist);

  const status = configureLiveRegion(el('div', 'setup-status'));
  const progress = configureLiveRegion(el('div', 'setup-progress-line'));

  form.append(providerField, baseField, keyField, modelField, longField, status, progress);
  root.append(form);

  const testBtn = el('button', 'btn btn-ghost', '测试连接');
  testBtn.type = 'button';
  const saveNote = el('span', 'muted', '点“下一步”会自动测试并保存');
  const inlineActions = el('div', 'setup-subtle-actions');
  inlineActions.append(testBtn, saveNote);
  root.append(inlineActions);

  let activeAction = null;

  function syncBusyControls() {
    if (w.destroyed) return;
    const busy = !!activeAction;
    for (const control of [
      providerSelect,
      baseInput,
      keyInput,
      modelInput,
      longInput,
      fetchModelsBtn,
      testBtn,
    ]) {
      control.disabled = busy;
    }
    w.refreshButtons();
  }

  function beginLlmAction(kind, focusCandidates = []) {
    if (activeAction || w.destroyed) return null;
    const action = Object.freeze({
      kind: String(kind || 'AI 操作'),
      token: w.beginAsync(),
      focusTarget: captureActionFocus(focusCandidates, globalThis.document?.activeElement),
    });
    activeAction = action;
    syncBusyControls();
    return action;
  }

  function llmActionAlive(action) {
    return activeAction === action && w.alive(action?.token);
  }

  function finishLlmAction(action) {
    if (activeAction !== action) return false;
    activeAction = null;
    if (w.destroyed) return true;
    syncBusyControls();
    restoreActionFocus(action.focusTarget, {
      activeElement: globalThis.document?.activeElement,
      body: globalThis.document?.body,
    });
    return true;
  }

  function setStatus(kind, text) {
    if (w.destroyed) return;
    status.className = `setup-status${kind ? ` setup-status-${kind}` : ''}`;
    status.replaceChildren();
    if (!text) return;
    const icon = el('span', 'setup-status-icon', { ok: '✓', warn: '⚠', err: '✗', info: '…' }[kind] || '');
    status.append(icon, el('span', 'setup-status-text', text));
  }

  function setProgress(text, detail = '') {
    if (w.destroyed) return;
    progress.replaceChildren();
    if (!text) return;
    progress.append(ctx.ui.spinner(14), el('span', '', text));
    if (detail) progress.append(el('span', 'setup-progress-detail', detail));
  }

  function readForm({ syncBaseUrl = false } = {}) {
    const rawBaseUrl = baseInput.value.trim();
    const baseUrlValidation = validateAiBaseUrl(rawBaseUrl);
    const baseUrl = baseUrlValidation.ok ? baseUrlValidation.value : rawBaseUrl;
    if (syncBaseUrl && baseUrlValidation.ok && baseInput.value !== baseUrl) {
      baseInput.value = baseUrl;
    }
    return {
      provider: providerSelect.value || 'openai',
      base_url: baseUrl,
      baseUrlValidation,
      api_key: keyInput.value.trim(),
      model: modelInput.value.trim(),
      long_context_model: longInput.value.trim(),
    };
  }

  function currentIdentity() {
    return llmIdentity({ ...readForm(), settings_revision: wiz.baseRevision });
  }

  function currentModelsIdentity() {
    return llmEndpointIdentity({ ...readForm(), settings_revision: wiz.baseRevision });
  }

  function paintModelOptions(models) {
    modelDatalist.replaceChildren();
    longDatalist.replaceChildren();
    for (const item of Array.isArray(models) ? models : []) {
      const id = String(item?.id || item?.name || '').trim();
      if (!id) continue;
      const optionA = document.createElement('option');
      optionA.value = id;
      modelDatalist.appendChild(optionA);
      const optionB = document.createElement('option');
      optionB.value = id;
      longDatalist.appendChild(optionB);
    }
  }

  function paintKeyHint() {
    const savedSet = wiz.settings?.llm?.api_key_set === true;
    keyHint.textContent = wiz.llm.apiKeyTouched
      ? '将使用本次输入的新 Key。'
      : (savedSet ? '已保存过 Key;留空表示继续使用已保存的 Key。' : '尚未配置 Key,请填写。');
  }

  // 表单变化即作废旧的测试结论。
  function onFormInput() {
    rememberLlmDraft(wiz, readForm());
    if (currentIdentity() !== wiz.llm.testedIdentity) wiz.llm.testedIdentity = '';
    if (wiz.llm.modelsForIdentity
      && currentModelsIdentity() !== wiz.llm.modelsForIdentity) {
      wiz.llm.available_models = [];
      wiz.llm.modelsForIdentity = '';
      paintModelOptions([]);
    }
    for (const input of [baseInput, keyInput, modelInput]) setFieldInvalid(input, false);
    setStatus('', '');
    w.refreshButtons();
  }
  providerSelect.addEventListener('change', onFormInput);
  baseInput.addEventListener('input', onFormInput);
  keyInput.addEventListener('input', () => {
    wiz.llm.apiKeyTouched = !!keyInput.value.trim();
    paintKeyHint();
    onFormInput();
  });
  modelInput.addEventListener('input', onFormInput);
  longInput.addEventListener('input', onFormInput);

  async function ensureSettingsLoaded(action) {
    if (!llmActionAlive(action)) return false;
    if (wiz.settings) {
      const settings = requireSettingsDocument(wiz.settings);
      // 账号上下文切换会清空向导的 revision,但设置文档本身是服务级缓存;
      // 复用它时必须同步恢复 revision,否则 saved-key 身份会退化为空 revision。
      wiz.baseRevision = String(settings.settings_revision).trim();
      return true;
    }
    const response = await ctx.api.get('/api/settings', { signal: w.signal });
    if (!llmActionAlive(action)) return false;
    const settings = requireSettingsDocument(response);
    wiz.settings = settings;
    wiz.baseRevision = String(settings.settings_revision).trim();
    return true;
  }

  function prefill() {
    const values = llmFormPrefillValues(wiz);
    providerSelect.value = values.provider;
    baseInput.value = values.base_url;
    keyInput.value = values.api_key;
    modelInput.value = values.model;
    longInput.value = values.long_context_model;
    const llm = wiz.settings?.llm || {};
    if (Array.isArray(llm.available_models) && llm.available_models.length) {
      wiz.llm.available_models = llm.available_models;
      wiz.llm.modelsForIdentity = currentModelsIdentity();
      paintModelOptions(llm.available_models);
    }
    paintKeyHint();
    secretsAlert.hidden = wiz.state?.secrets_invalid !== true;
    secretsText.textContent = '本机密钥文件无法用当前 Windows 用户解密(可能换了系统用户);'
      + '请重新填写 API Key 并保存,系统会先备份旧密文再建立新密钥库。';
  }

  function validateRequired() {
    const form = readForm({ syncBaseUrl: true });
    const baseUrlValidation = form.baseUrlValidation;
    setFieldInvalid(baseInput, !baseUrlValidation.ok);
    setFieldInvalid(modelInput, !form.model);
    const keyMissing = !form.api_key && wiz.settings?.llm?.api_key_set !== true;
    setFieldInvalid(keyInput, keyMissing);
    if (!form.base_url) return '请填写 Base URL。';
    if (!baseUrlValidation.ok) return baseUrlValidation.message;
    if (keyMissing) return '请填写 API Key。';
    if (!form.model) return '请填写或选择模型;可以先点“获取模型列表”。';
    return '';
  }

  function formatTestResult(result) {
    const items = Array.isArray(result?.model_results) && result.model_results.length
      ? result.model_results
      : [{ role: 'model', model: result?.model || '', ok: result?.ok === true }];
    return items.map(item => {
      const label = item.role === 'long_context' ? '长上下文模型' : '模型';
      const name = String(item.model || '').trim() || '(未命名)';
      return `${label} ${name}${item.ok ? '连通正常' : '未通过'}`;
    }).join(';');
  }

  // 拉模型列表;失败只提示,不阻塞(允许自定义模型名)。
  async function fetchModels({ silent = false } = {}) {
    const message = validateRequiredForModels();
    if (message) {
      setStatus('warn', message);
      return false;
    }
    const form = readForm({ syncBaseUrl: true });
    const identityAtStart = currentModelsIdentity();
    const action = beginLlmAction('获取模型列表', [fetchModelsBtn]);
    if (!action) return false;
    setProgress('正在获取模型列表…');
    try {
      const body = { provider: form.provider, base_url: form.base_url };
      if (form.api_key) body.api_key = form.api_key;
      const result = await ctx.api.post('/api/list-models', body, { signal: w.signal });
      if (!llmActionAlive(action)) return false;
      setProgress('');
      if (currentModelsIdentity() !== identityAtStart) {
        setStatus('warn', '获取期间端点或密钥已变化,旧模型列表已忽略;请重新获取。');
        return false;
      }
      const models = requireAiModelList(result);
      wiz.llm.available_models = models;
      wiz.llm.modelsForIdentity = identityAtStart;
      paintModelOptions(models);
      if (models.length) {
        setStatus('ok', `已获取 ${models.length} 个可用模型,可在模型输入框中挑选,也可以直接输入自定义名称。`);
        return true;
      }
      setStatus('warn', '接口没有返回模型列表;请直接填写模型名。');
      return false;
    } catch (error) {
      if (!llmActionAlive(action) || error?.name === 'AbortError' || error?.status === 499) return false;
      setProgress('');
      if (!silent) setStatus('err', `获取模型列表失败:${compactErrorSummary(error?.message)} 也可以直接手动填写模型名。`);
      return false;
    } finally {
      finishLlmAction(action);
    }
  }

  function validateRequiredForModels() {
    const form = readForm({ syncBaseUrl: true });
    const baseUrlValidation = form.baseUrlValidation;
    setFieldInvalid(baseInput, !baseUrlValidation.ok);
    const keyMissing = !form.api_key && wiz.settings?.llm?.api_key_set !== true;
    setFieldInvalid(keyInput, keyMissing);
    if (!form.base_url) return '请先填写 Base URL 再获取模型列表。';
    if (!baseUrlValidation.ok) return baseUrlValidation.message;
    if (keyMissing) return '请先填写 API Key 再获取模型列表。';
    return '';
  }

  // 测试连接;通过返回 true。失败时 setStatus 并返回 false(调用方决定是否允许跳过)。
  async function testConnectivity({ interactive = true } = {}) {
    const message = validateRequired();
    if (message) {
      setStatus('warn', message);
      return false;
    }
    const identityAtStart = currentIdentity();
    const form = readForm({ syncBaseUrl: true });
    const action = beginLlmAction('测试 AI 连接', [testBtn]);
    if (!action) return false;
    setProgress('正在测试所选模型连通性…');
    try {
      const body = {
        provider: form.provider,
        base_url: form.base_url,
        model: form.model,
        long_context_model: form.long_context_model,
        // 带上当前 revision:服务端 409 时说明设置已被别处修改,提示后要求重载。
        ...(wiz.baseRevision ? { expected_settings_revision: wiz.baseRevision } : {}),
      };
      if (form.api_key) body.api_key = form.api_key;
      const result = await ctx.api.post('/api/test-llm', body, { signal: w.signal, timeoutMs: 30000 });
      if (!llmActionAlive(action)) return false;
      setProgress('');
      if (currentIdentity() !== identityAtStart) {
        setStatus('warn', '测试期间端点、密钥或模型已变化,旧连通结果已忽略;请再测试一次。');
        return false;
      }
      const checkedResult = requireAiConnectivityResult(result);
      if (checkedResult.ok === true) {
        wiz.llm.testedIdentity = identityAtStart;
        setStatus('ok', `基础连通测试通过:${formatTestResult(checkedResult)}。`);
        return true;
      }
      wiz.llm.testedIdentity = '';
      setStatus(checkedResult.partial_ok ? 'warn' : 'err',
        `基础连通测试${checkedResult.partial_ok ? '部分未通过' : '未通过'}:${formatTestResult(checkedResult)}。`);
      return false;
    } catch (error) {
      if (!llmActionAlive(action) || error?.name === 'AbortError' || error?.status === 499) return false;
      setProgress('');
      wiz.llm.testedIdentity = '';
      if (error?.status === 409 && error?.code === 'settings_revision_conflict') {
        setStatus('err', '设置已在别处变化;请回到本步骤重新载入后再试。');
        wiz.settings = null; // 触发下次进入时重拉
        return false;
      }
      if (interactive) {
        setStatus('err', `连通测试失败:${compactErrorSummary(error?.message)} 请检查 Base URL、API Key 和模型名。`);
      }
      return false;
    } finally {
      finishLlmAction(action);
    }
  }

  // 保存 llm 设置;返回 true 表示已保存(或无需保存)。
  async function saveSettings() {
    const form = readForm({ syncBaseUrl: true });
    const baseUrlValidation = form.baseUrlValidation;
    if (!baseUrlValidation.ok) {
      setFieldInvalid(baseInput, true);
      setStatus('warn', baseUrlValidation.message);
      focusFirstInvalid([baseInput]);
      return false;
    }
    const activeElement = globalThis.document?.activeElement;
    const action = beginLlmAction(
      '保存 AI 设置',
      activeElement?.tagName === 'BUTTON' ? [activeElement] : [],
    );
    if (!action) return false;
    setProgress('正在保存 AI 设置…');
    try {
      if (!await ensureSettingsLoaded(action)) return false;
      const llmPatch = {
        provider: form.provider,
        base_url: form.base_url,
        model: form.model,
        long_context_model: form.long_context_model,
      };
      if (form.api_key) llmPatch.api_key = form.api_key;
      if (wiz.llm.modelsForIdentity === currentModelsIdentity()
        && Array.isArray(wiz.llm.available_models)
        && wiz.llm.available_models.length) {
        llmPatch.available_models = wiz.llm.available_models;
        llmPatch.models_fetched_at = new Date().toISOString();
      }
      const patch = { llm: llmPatch };
      // 写入新 Key 且本机密钥库已失效时,需先确认建立新密钥库(服务端 428 闸门)。
      if (llmPatch.api_key) {
        const replacement = await confirmInvalidSecretsReplacement(ctx, wiz);
        if (!llmActionAlive(action)) return false;
        if (replacement.required && !replacement.confirmed) {
          setProgress('');
          setStatus('warn', '已取消保存;没有建立新密钥库,已保存的其他设置不受影响。');
          return false;
        }
        if (replacement.confirmed) {
          patch._request_context = { replace_invalid_secrets: true };
        }
      }
      const response = await saveWizardSettings(ctx, wiz, patch, {
        signal: w.signal,
        timeoutMs: 240_000,
        isCurrent: () => llmActionAlive(action),
      });
      if (!llmActionAlive(action)) return false;
      syncWizardStateFromSettingsResponse(wiz, response);
      // 账号身份升级:用响应里的最新账号刷新本地指纹(防旧指纹继续发请求)。
      if (response?.account_identity_upgrade && response?.account) {
        const stateReady = await w.applyAccountIdentityUpgrade(response.account, { ownerToken: action.token });
        if (!stateReady || !llmActionAlive(action)) return false;
      } else {
        ctx.store.set('state', {
          ...(ctx.store.get('state') || {}),
          need_setup: response?.need_setup,
          need_setup_reason: response?.need_setup_reason,
        });
      }
      wiz.llm.saved = true;
      wiz.llm.apiKeyTouched = false;
      wiz.llm.api_key = '';
      wiz.llm.dirty = false;
      keyInput.value = '';
      paintKeyHint();
      setProgress('');
      const warnings = Array.isArray(response?.warnings)
        ? response.warnings.map(item => item?.message).filter(Boolean)
        : [];
      setStatus('ok', warnings.length
        ? `AI 设置已保存。注意:${warnings.join(';')}`
        : 'AI 设置已保存。');
      return true;
    } catch (error) {
      if (!llmActionAlive(action) || error?.name === 'AbortError' || error?.status === 499) return false;
      setProgress('');
      if (isMutationOutcomeUnknown(error)) {
        setStatus('warn', '保存请求超时或断连,结果未知:设置可能已写入也可能没有。请点“重新检测”核对 AI 设置状态后再决定是否重试。');
        wiz.settings = null; // 下次进入重新拉取核对
        return false;
      }
      if (error?.status === 409 && error?.code === 'settings_revision_conflict') {
        setStatus('err', '设置已在别处变化;已放弃本次保存,请重新进入本步骤后再保存。');
        wiz.settings = null;
        return false;
      }
      if (error?.status === 428 && error?.code === 'settings_revision_required') {
        wiz.settings = null;
        setStatus('err', '缺少设置版本号,已重新拉取;请再点一次“下一步”。');
        return false;
      }
      if (error?.status === 428 && error?.code === 'secrets_replacement_confirmation_required') {
        setStatus('warn', '本机密钥库已失效,保存新 Key 需要先确认建立新密钥库;请再点一次“下一步”并在弹窗中确认。');
        wiz.state = { ...(wiz.state || {}), secrets_invalid: true };
        return false;
      }
      setStatus('err', `保存 AI 设置失败:${compactErrorSummary(error?.message)}`);
      return false;
    } finally {
      finishLlmAction(action);
    }
  }

  fetchModelsBtn.addEventListener('click', () => { void fetchModels(); });
  testBtn.addEventListener('click', () => { void testConnectivity(); });

  return {
    el: root,
    onEnter() {
      const action = beginLlmAction('初始化 AI 设置');
      if (!action) return;
      (async () => {
        try {
          if (!await ensureSettingsLoaded(action)) return;
          prefill();
          // 已有可用模型列表且端点未变时直接展示;否则不自动拉(避免无谓外网请求)。
          w.refreshButtons();
        } catch (error) {
          if (!llmActionAlive(action) || error?.name === 'AbortError' || error?.status === 499) return;
          setStatus('err', `读取当前 AI 设置失败:${compactErrorSummary(error?.message)}`);
        } finally {
          finishLlmAction(action);
        }
      })();
    },
    isBusy: () => !!activeAction,
    // 下一步:校验 → 测试(未通过给用户“仍然继续”警告)→ 保存。
    async beforeNext() {
      const message = validateRequired();
      if (message) {
        setStatus('warn', message);
        focusFirstInvalid([baseInput, keyInput, modelInput]);
        return false;
      }
      // 端点/密钥/模型与上次通过测试时不一致,重新测试。
      if (wiz.llm.testedIdentity !== currentIdentity()) {
        const passed = await testConnectivity();
        if (!passed) {
          if (!w.wiz.llm.skipWarned) {
            const proceed = await ctx.ui.confirmDialog({
              title: '连通测试未通过',
              message: 'AI 连通测试未通过,继续保存后很可能无法生成摘要。确定仍要保存并继续吗?',
              confirmLabel: '仍然保存并继续',
              cancelLabel: '返回修改',
              danger: true,
            });
            if (!proceed) return false;
            wiz.llm.skipWarned = true;
          }
        }
      }
      return await saveSettings();
    },
  };
}
