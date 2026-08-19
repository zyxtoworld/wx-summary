// 设置页 · AI 接入分区:provider/base_url/API Key/模型/高级项 + 拉取模型 + 连通测试。
import { parseStrictIntegerInput } from '/js/shared/numeric-input.js';
import {
  el,
  createStatusLine,
  errorText,
  isAbortError,
  fmtDateTime,
} from './core.js';
import { focusFirstInvalid, setFieldInvalid } from '/js/shared/form-accessibility.js';
import { syncFormControlsDisabled } from '/js/shared/form-busy-controls.js';
import { setSegmentedButtonState } from '../../ui/segmented.js';
import { validateAiBaseUrl } from '/js/shared/ai-base-url.js';
import { requireAiModelList } from '/js/shared/ai-model-list.js';
import { requireAiConnectivityResult } from '/js/shared/ai-connectivity-result.js';
import { llmEndpointIdentity, llmIdentity } from '/js/shared/ai-identity.js';

const PROVIDERS = Object.freeze([
  ['openai', 'OpenAI 兼容'],
  ['anthropic', 'Anthropic'],
]);

// 与 src/config/settings.js normalizeSettings 对齐的取值范围。
const LIMITS = Object.freeze({
  ai_concurrency: { min: 1, max: 8, fallback: 2, label: 'AI 并发' },
  timeout_ms: { min: 1000, max: 600000, fallback: 120000, label: '超时(毫秒)' },
  max_input_chars: { min: 1000, max: 1000000, fallback: 60000, label: '单次输入字符上限' },
  max_messages_per_call: { min: 1, max: 20000, fallback: 800, label: '单次消息条数上限' },
  max_image_chars_per_call: { min: 100000, max: 2 * 1024 * 1024, fallback: 300000, label: '图片 OCR 字符上限' },
});

function clampTemperature(value, fallback = 0.3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(2, Math.max(0, n));
}

function capabilityLabel(name) {
  switch (String(name || '')) {
    case 'summary_json': return '摘要生成';
    case 'responses': return 'Responses';
    case 'responses_web_search': return '联网搜索';
    case 'chat': return '对话';
    case 'messages': return 'Messages';
    default: return String(name || '未知能力');
  }
}

export function createAiSection(page) {
  const { api, ui } = page;
  const status = createStatusLine();
  const testStatus = createStatusLine();

  // ---- 控件 ----------------------------------------------------------------
  const providerBtns = new Map();
  const providerSegmented = el('div', { class: 'segmented', role: 'group', 'aria-label': 'AI 提供方' });
  for (const [value, label] of PROVIDERS) {
    const btn = el('button', { class: 'segmented-btn', type: 'button', text: label });
    btn.addEventListener('click', () => { draft.provider = value; syncProviderButtons(); markTestDraftDirty(); });
    providerBtns.set(value, btn);
    providerSegmented.append(btn);
  }

  const baseUrlInput = el('input', {
    class: 'input', type: 'url', placeholder: 'https://api.example.com/v1',
    'aria-label': 'Base URL', spellcheck: 'false',
  });

  const apiKeyInput = el('input', {
    class: 'input', type: 'password', placeholder: '粘贴新的 API Key(只写不回读)',
    'aria-label': 'API Key', autocomplete: 'off', spellcheck: 'false',
  });
  const apiKeyToggle = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '显示' });
  const apiKeyClear = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '清除已保存' });
  const apiKeyState = el('div', { class: 'settings-hint' });

  const modelInput = el('input', {
    class: 'input', type: 'text', placeholder: '选择或自定义输入模型名',
    'aria-label': '模型', spellcheck: 'false',
  });
  const modelList = el('datalist', { id: 'settings-ai-models' });
  const longModelInput = el('input', {
    class: 'input', type: 'text', placeholder: '留空则与主模型相同',
    'aria-label': '长上下文模型', spellcheck: 'false',
  });
  const longModelList = el('datalist', { id: 'settings-ai-long-models' });
  const modelsHint = el('div', { class: 'settings-hint' });

  const fetchModelsBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '拉取模型列表' });
  const testBtn = el('button', { class: 'btn btn-ghost', type: 'button', text: '连通测试' });
  const saveBtn = el('button', { class: 'btn btn-primary', type: 'button', text: '保存 AI 接入' });

  // 高级项
  const advancedInputs = {};
  const advancedGrid = el('div', { class: 'settings-grid' });
  for (const [key, limit] of Object.entries(LIMITS)) {
    const input = el('input', {
      class: 'input', type: 'text', inputmode: 'numeric',
      'aria-label': limit.label, placeholder: String(limit.fallback),
    });
    input.addEventListener('input', markTestDraftDirty);
    advancedInputs[key] = input;
    advancedGrid.append(el('div', { class: 'settings-field' },
      el('label', { class: 'field-label', text: `${limit.label}(${limit.min}–${limit.max})` }),
      input,
    ));
  }
  const temperatureInput = el('input', {
    class: 'input', type: 'text', inputmode: 'decimal', 'aria-label': 'temperature', placeholder: '0.3',
  });
  temperatureInput.addEventListener('input', markTestDraftDirty);
  advancedGrid.append(el('div', { class: 'settings-field' },
    el('label', { class: 'field-label', text: 'temperature(0–2)' }),
    temperatureInput,
  ));
  const advanced = el('details', { class: 'settings-advanced' },
    el('summary', { text: '高级项(并发 / temperature / 超时 / 截断上限)' }),
    advancedGrid,
  );

  const testResults = el('div', { class: 'settings-test-results' });

  // ---- 草稿状态 --------------------------------------------------------------
  const draft = {
    provider: 'openai',
    apiKeyTouched: false,   // 用户输入了新 Key
    clearApiKey: false,     // 用户点了清除
    availableModels: null,  // null = 未改动;数组 = 新拉取
    dirty: false,
  };

  function syncProviderButtons() {
    for (const [value, btn] of providerBtns) setSegmentedButtonState(btn, value === draft.provider);
  }

  function llm() {
    return page.getSettings()?.llm || {};
  }

  function currentModels() {
    if (Array.isArray(draft.availableModels)) return draft.availableModels;
    const list = Array.isArray(llm().available_models) ? llm().available_models : [];
    return list.map(item => String(item?.id || '').trim()).filter(Boolean);
  }

  function syncModelDatalists() {
    const options = currentModels().map(id => el('option', { value: id }));
    modelList.replaceChildren(...options.map(node => node.cloneNode(true)));
    longModelList.replaceChildren(...options);
    const fetchedAt = String(llm().models_fetched_at || '').trim();
    const count = currentModels().length;
    modelsHint.textContent = count
      ? `已记录 ${count} 个模型${fetchedAt ? `(${fmtDateTime(fetchedAt)} 拉取)` : ''};也可以直接输入自定义模型名。`
      : '尚未拉取模型列表;可以直接输入自定义模型名。';
  }

  function syncApiKeyState() {
    const saved = llm().api_key_set === true;
    if (draft.clearApiKey) {
      apiKeyState.textContent = '保存后将清除已保存的 API Key。';
      apiKeyClear.disabled = true;
      return;
    }
    apiKeyClear.disabled = !saved || page.isBusy();
    const display = String(llm().api_key_display || '').trim();
    apiKeyState.textContent = saved
      ? `已保存 API Key${display ? `(${display})` : ''};输入新 Key 会覆盖,留空则保持不变。`
      : '尚未保存 API Key。';
  }

  function markDirty() {
    draft.dirty = computeDirty();
    page.markDirty('ai', draft.dirty);
    saveBtn.disabled = !draft.dirty || page.isBusy();
  }

  function clearTestResult() {
    testResults.replaceChildren();
    if (testStatus.el.textContent) testStatus.clear();
  }

  function markTestDraftDirty() {
    setFieldInvalid(arguments[0]?.currentTarget, false);
    status.clear();
    clearTestResult();
    markDirty();
  }

  function computeDirty() {
    const saved = llm();
    if (draft.clearApiKey || apiKeyInput.value.trim()) return true;
    if (draft.provider !== String(saved.provider || 'openai')) return true;
    const baseUrl = baseUrlInput.value.trim();
    const baseUrlValidation = validateAiBaseUrl(baseUrl);
    const normalizedBaseUrl = baseUrlValidation.ok ? baseUrlValidation.value : baseUrl;
    if (normalizedBaseUrl !== String(saved.base_url || '')) return true;
    if (modelInput.value.trim() !== String(saved.model || '')) return true;
    if (longModelInput.value.trim() !== String(saved.long_context_model || '')) return true;
    if (Array.isArray(draft.availableModels)) return true;
    for (const [key, limit] of Object.entries(LIMITS)) {
      const parsed = parseStrictIntegerInput(advancedInputs[key].value, { min: limit.min, max: limit.max });
      const current = Number(saved[key] ?? limit.fallback);
      if (parsed.ok && parsed.value !== current) return true;
      if (!parsed.ok && advancedInputs[key].value.trim()) return true;
    }
    const temp = Number(temperatureInput.value);
    if (temperatureInput.value.trim() && !Number.isFinite(temp)) return true;
    if (temperatureInput.value.trim() && temp !== Number(saved.temperature ?? 0.3)) return true;
    return false;
  }

  // ---- 填值 ------------------------------------------------------------------
  function applySettings(settings, { preserveDirty = true } = {}) {
    const saved = settings?.llm || {};
    if (!preserveDirty || !draft.dirty) {
      draft.provider = ['openai', 'anthropic'].includes(saved.provider) ? saved.provider : 'openai';
      draft.clearApiKey = false;
      draft.availableModels = null;
      apiKeyInput.value = '';
      baseUrlInput.value = String(saved.base_url || '');
      modelInput.value = String(saved.model || '');
      longModelInput.value = String(saved.long_context_model || '');
      for (const [key, limit] of Object.entries(LIMITS)) {
        advancedInputs[key].value = String(Number(saved[key] ?? limit.fallback));
      }
      temperatureInput.value = String(Number(saved.temperature ?? 0.3));
      draft.dirty = false;
      page.markDirty('ai', false);
    }
    syncProviderButtons();
    syncModelDatalists();
    syncApiKeyState();
    saveBtn.disabled = !draft.dirty || page.isBusy();
  }

  // ---- 动作 ------------------------------------------------------------------
  function normalizedBaseUrlForAction({ required = false } = {}) {
    const raw = baseUrlInput.value.trim();
    if (!raw && !required) {
      setFieldInvalid(baseUrlInput, false);
      return { ok: true, value: '' };
    }
    const validation = validateAiBaseUrl(raw);
    if (!validation.ok) {
      setFieldInvalid(baseUrlInput, true);
      return validation;
    }
    setFieldInvalid(baseUrlInput, false);
    if (baseUrlInput.value !== validation.value) baseUrlInput.value = validation.value;
    return validation;
  }

  function llmActionBody(baseUrlValue) {
    // 只传用户显式修改的值;缺省时服务端回落到已保存设置。
    const body = { provider: draft.provider };
    const baseUrl = baseUrlValue === undefined ? baseUrlInput.value.trim() : baseUrlValue;
    if (baseUrl) body.base_url = baseUrl;
    const key = apiKeyInput.value.trim();
    if (key) body.api_key = key;
    return body;
  }

  function currentEndpointIdentity() {
    const raw = baseUrlInput.value.trim();
    const validation = validateAiBaseUrl(raw);
    return llmEndpointIdentity({
      provider: draft.provider,
      base_url: validation.ok ? validation.value : raw,
      api_key: apiKeyInput.value.trim(),
      settings_revision: page.getBaseRevision?.() || '',
    });
  }

  function currentLlmIdentity() {
    const raw = baseUrlInput.value.trim();
    const validation = validateAiBaseUrl(raw);
    return llmIdentity({
      provider: draft.provider,
      base_url: validation.ok ? validation.value : raw,
      api_key: apiKeyInput.value.trim(),
      model: modelInput.value.trim(),
      long_context_model: longModelInput.value.trim(),
      settings_revision: page.getBaseRevision?.() || '',
    });
  }

  async function fetchModels() {
    const baseUrlValidation = normalizedBaseUrlForAction();
    if (!baseUrlValidation.ok) {
      status.set(baseUrlValidation.message, 'err');
      focusFirstInvalid([baseUrlInput]);
      return;
    }
    const identityAtStart = currentEndpointIdentity();
    const token = page.beginAction('拉取模型列表', [fetchModelsBtn, testBtn, saveBtn]);
    status.set('正在拉取模型列表…');
    try {
      const result = await api.post('/api/list-models', llmActionBody(baseUrlValidation.value), {
        signal: token.signal,
        timeoutMs: 60_000,
      });
      if (!page.alive(token)) return;
      if (currentEndpointIdentity() !== identityAtStart) {
        status.set('表单已更新,已忽略过期模型列表,请重新拉取。', 'warn');
        return;
      }
      const models = requireAiModelList(result)
        .map(item => String(item?.id || '').trim())
        .filter(Boolean);
      draft.availableModels = models;
      syncModelDatalists();
      status.set(models.length ? `已拉取 ${models.length} 个模型,保存后生效。` : '提供方返回了空模型列表。', models.length ? 'ok' : 'warn');
      markDirty();
    } catch (error) {
      if (!page.alive(token) || isAbortError(error)) return;
      status.set(errorText(error, '拉取模型列表失败'), 'err');
    } finally {
      page.endAction(token);
    }
  }

  function renderTestResults(result) {
    testResults.replaceChildren();
    const rows = Array.isArray(result?.model_results) && result.model_results.length
      ? result.model_results
      : (result ? [result] : []);
    for (const item of rows) {
      const role = item?.role === 'long_context' ? '长上下文模型' : '主模型';
      const caps = Array.isArray(item?.capabilities) ? item.capabilities : [];
      const head = el('div', { class: 'settings-test-model-head' },
        el('span', { class: `settings-cap ${item?.ok ? 'ok' : 'fail'}`, text: item?.ok ? '通过' : '未通过' }),
        el('strong', { text: `${role}:${String(item?.model || '—')}` }),
        el('span', { class: 'muted', text: `耗时 ${Math.max(0, Number(item?.latency_ms || 0))} ms` }),
      );
      const capList = el('div', { class: 'settings-cap-list' },
        caps.map(cap => el('span', {
          class: `settings-cap ${cap?.ok ? 'ok' : 'fail'}`,
          title: cap?.ok ? '' : String(cap?.error || ''),
          text: `${capabilityLabel(cap?.name)} ${cap?.ok ? '✓' : '✗'} ${Math.max(0, Number(cap?.latency_ms || 0))}ms`,
        })),
      );
      const errors = caps.filter(cap => !cap?.ok && cap?.error)
        .map(cap => el('div', { class: 'settings-hint', text: `${capabilityLabel(cap.name)}:${String(cap.error)}` }));
      testResults.append(el('div', { class: 'settings-test-model' }, head, capList, errors));
    }
  }

  async function runTest() {
    const baseUrlValidation = normalizedBaseUrlForAction();
    if (!baseUrlValidation.ok) {
      testStatus.set(baseUrlValidation.message, 'err');
      focusFirstInvalid([baseUrlInput]);
      return;
    }
    const identityAtStart = currentLlmIdentity();
    const token = page.beginAction('连通测试', [fetchModelsBtn, testBtn, saveBtn]);
    testStatus.set('正在测试 AI 连通性(每个模型逐项能力测试)…');
    testResults.replaceChildren();
    try {
      const body = llmActionBody(baseUrlValidation.value);
      const model = modelInput.value.trim();
      if (model) body.model = model;
      const longModel = longModelInput.value.trim();
      if (longModel) body.long_context_model = longModel;
      const result = await api.post('/api/test-llm', body, {
        signal: token.signal,
        timeoutMs: 120_000,
      });
      if (!page.alive(token)) return;
      if (currentLlmIdentity() !== identityAtStart) {
        testStatus.set('表单已更新,已忽略过期连通结果,请重新测试。', 'warn');
        return;
      }
      const checkedResult = requireAiConnectivityResult(result);
      renderTestResults(checkedResult);
      // 可选能力失败时服务端仍可能保留 ok=true;partial_ok 优先级更高。
      const allOk = checkedResult.ok === true && checkedResult.partial_ok !== true;
      const partial = checkedResult.partial_ok === true;
      testStatus.set(
        allOk
          ? `全部通过,总耗时 ${Math.max(0, Number(checkedResult.latency_ms || 0))} ms。`
          : (partial ? '部分能力可用,请查看各项结果。' : '连通测试未通过,请检查 Base URL、Key 与模型名。'),
        allOk ? 'ok' : (partial ? 'warn' : 'err'),
      );
    } catch (error) {
      if (!page.alive(token) || isAbortError(error)) return;
      testStatus.set(errorText(error, '连通测试失败'), 'err');
    } finally {
      page.endAction(token);
    }
  }

  async function save() {
    const baseUrlValidation = normalizedBaseUrlForAction({ required: true });
    if (!baseUrlValidation.ok) {
      setFieldInvalid(baseUrlInput, true);
      status.set(baseUrlValidation.message, 'err');
      focusFirstInvalid([baseUrlInput]);
      return;
    }
    setFieldInvalid(baseUrlInput, false);
    const patch = { provider: draft.provider };
    const newKey = apiKeyInput.value.trim();
    if (draft.clearApiKey) {
      patch.clear_api_key = true;
    } else if (newKey) {
      patch.api_key = newKey;
    }
    patch.base_url = baseUrlValidation.value;
    const model = modelInput.value.trim();
    const longModel = longModelInput.value.trim();
    const models = currentModels();
    patch.model = model;
    patch.long_context_model = longModel;
    patch.custom_model = !!model && !models.includes(model);
    patch.custom_long_context_model = !!longModel && !models.includes(longModel);
    if (Array.isArray(draft.availableModels)) {
      patch.available_models = draft.availableModels.map(id => ({ id }));
    }
    for (const [key, limit] of Object.entries(LIMITS)) {
      const parsed = parseStrictIntegerInput(advancedInputs[key].value, { min: limit.min, max: limit.max, clamp: true });
      if (!parsed.ok) {
        setFieldInvalid(advancedInputs[key], true);
        status.set(`${limit.label}必须是 ${limit.min}–${limit.max} 的整数。`, 'err');
        focusFirstInvalid([advancedInputs[key]]);
        return;
      }
      setFieldInvalid(advancedInputs[key], false);
      patch[key] = parsed.value;
    }
    const temperature = Number(temperatureInput.value);
    if (!temperatureInput.value.trim() || !Number.isFinite(temperature)) {
      setFieldInvalid(temperatureInput, true);
      status.set('temperature 必须是 0–2 的数字。', 'err');
      focusFirstInvalid([temperatureInput]);
      return;
    }
    setFieldInvalid(temperatureInput, false);
    patch.temperature = clampTemperature(temperature);

    const token = page.beginAction('保存 AI 接入', [saveBtn, fetchModelsBtn, testBtn]);
    status.set('正在保存 AI 接入设置…');
    try {
      const result = await page.saveSection({ llm: patch }, { signal: token.signal, ownerToken: token });
      if (!page.alive(token)) return;
      apiKeyInput.value = '';
      draft.clearApiKey = false;
      draft.availableModels = null;
      draft.dirty = false;
      page.markDirty('ai', false);
      // 用保存后的最新设置回填(api_key_set / available_models 等已变化)。
      applySettings(page.getSettings(), { preserveDirty: false });
      status.set(page.saveSummaryText(result, 'AI 接入设置已保存。'), page.saveHasWarnings(result) ? 'warn' : 'ok');
    } catch (error) {
      if (!page.alive(token) || isAbortError(error)) return;
      status.set(errorText(error, '保存失败'), 'err');
    } finally {
      page.endAction(token);
    }
  }

  // ---- 装配 ------------------------------------------------------------------
  for (const input of [baseUrlInput, modelInput, longModelInput]) input.addEventListener('input', markTestDraftDirty);
  apiKeyInput.addEventListener('input', () => {
    if (apiKeyInput.value.trim()) draft.clearApiKey = false;
    markTestDraftDirty();
    syncApiKeyState();
  });
  apiKeyToggle.addEventListener('click', () => {
    const show = apiKeyInput.type === 'password';
    apiKeyInput.type = show ? 'text' : 'password';
    apiKeyToggle.textContent = show ? '隐藏' : '显示';
  });
  apiKeyClear.addEventListener('click', async () => {
    if (llm().api_key_set !== true) return;
    const token = page.beginAction('确认清除 API Key', [apiKeyClear, saveBtn]);
    try {
      const confirmed = await ui.confirmDialog({
        title: '清除已保存的 API Key',
        message: '清除后需要重新输入 Key 才能拉取模型与生成摘要。确认在下次保存时清除已保存的 API Key?',
        confirmLabel: '标记清除',
        danger: true,
      });
      if (!confirmed || !page.alive(token)) return;
      draft.clearApiKey = true;
      apiKeyInput.value = '';
      syncApiKeyState();
      markTestDraftDirty();
      status.set('已标记清除 API Key,点击“保存 AI 接入”后生效。', 'warn');
    } finally {
      page.endAction(token);
    }
  });
  fetchModelsBtn.addEventListener('click', () => { void fetchModels(); });
  testBtn.addEventListener('click', () => { void runTest(); });
  saveBtn.addEventListener('click', () => { void save(); });

  const section = el('section', { class: 'settings-section', 'data-section': 'ai' },
    el('div', { class: 'settings-section-head' },
      el('h2', { class: 'settings-section-title', text: 'AI 接入' }),
      el('p', { class: 'muted', text: '配置兼容 OpenAI 或 Anthropic 的模型服务;API Key 只写不回读,保存在本机密钥库。' }),
    ),
    el('div', { class: 'card card-pad settings-card' },
      el('h3', { class: 'card-title', text: '提供方与密钥' }),
      el('div', { class: 'settings-field' },
        el('label', { class: 'field-label', text: '提供方' }),
        providerSegmented,
      ),
      el('div', { class: 'settings-field' },
        el('label', { class: 'field-label', text: 'Base URL' }),
        baseUrlInput,
      ),
      el('div', { class: 'settings-field' },
        el('label', { class: 'field-label', text: 'API Key' }),
        el('div', { class: 'settings-secret-wrap' }, apiKeyInput, apiKeyToggle, apiKeyClear),
        apiKeyState,
      ),
    ),
    el('div', { class: 'card card-pad settings-card' },
      el('h3', { class: 'card-title', text: '模型' }),
      el('div', { class: 'settings-grid' },
        el('div', { class: 'settings-field' },
          el('label', { class: 'field-label', text: '模型' }),
          modelInput,
        ),
        el('div', { class: 'settings-field' },
          el('label', { class: 'field-label', text: '长上下文模型' }),
          longModelInput,
        ),
      ),
      modelList,
      longModelList,
      el('div', { class: 'settings-inline' }, fetchModelsBtn, modelsHint),
      advanced,
    ),
    el('div', { class: 'card card-pad settings-card' },
      el('h3', { class: 'card-title', text: '连通测试' }),
      el('div', { class: 'settings-actions' }, testBtn, testStatus.el),
      testResults,
    ),
    el('div', { class: 'card card-pad settings-card' },
      el('div', { class: 'settings-actions' }, saveBtn, status.el),
    ),
  );

  return {
    id: 'ai',
    el: section,
    applySettings,
    async saveDraft() {
      if (draft.dirty) await save();
    },
    setBusy(busy) {
      syncFormControlsDisabled([
        ...providerBtns.values(),
        baseUrlInput,
        apiKeyInput,
        apiKeyToggle,
        apiKeyClear,
        modelInput,
        longModelInput,
        ...Object.values(advancedInputs),
        temperatureInput,
      ], busy);
      saveBtn.disabled = busy || !draft.dirty;
      fetchModelsBtn.disabled = busy;
      testBtn.disabled = busy;
      syncApiKeyState();
    },
  };
}
