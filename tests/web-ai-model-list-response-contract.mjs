import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { requireAiModelList } from '../src/web/public/js/shared/ai-model-list.js';

function extractFunction(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `必须能定位 ${marker}`);
  const signatureEnd = source.indexOf(') {', start);
  assert.ok(signatureEnd >= 0, `${marker} 必须有可定位的函数体`);
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
  throw new Error(`${marker} 函数体未闭合`);
}

const settingsSource = await readFile(
  new URL('../src/web/public/js/pages/settings/ai.js', import.meta.url),
  'utf8',
);
const setupSource = await readFile(
  new URL('../src/web/public/js/pages/setup/step-llm.js', import.meta.url),
  'utf8',
);

async function runSettingsFetch(payload) {
  const fetchSource = extractFunction(settingsSource, 'async function fetchModels()');
  const draft = { availableModels: ['kept-settings-model'] };
  const baseUrlInput = { value: 'https://example.test/v1' };
  const statuses = [];
  let dirtyCalls = 0;
  let datalistSyncs = 0;
  const fetchModels = new Function(
    'normalizedBaseUrlForAction',
    'status',
    'focusFirstInvalid',
    'baseUrlInput',
    'currentEndpointIdentity',
    'page',
    'fetchModelsBtn',
    'testBtn',
    'saveBtn',
    'api',
    'llmActionBody',
    'draft',
    'syncModelDatalists',
    'markDirty',
    'isAbortError',
    'errorText',
    'requireAiModelList',
    `${fetchSource}; return fetchModels;`,
  )(
    () => ({ ok: true, value: 'https://example.test/v1' }),
    { set(text, kind) { statuses.push([text, kind]); } },
    () => {},
    baseUrlInput,
    () => 'settings-test-identity',
    {
      beginAction() { return { signal: new AbortController().signal }; },
      alive() { return true; },
      endAction() {},
    },
    {},
    {},
    {},
    { async post() { return payload; } },
    () => ({}),
    draft,
    () => { datalistSyncs += 1; },
    () => { dirtyCalls += 1; },
    () => false,
    (error, fallback) => error?.message || fallback,
    requireAiModelList,
  );
  await fetchModels();
  return { draft, statuses, dirtyCalls, datalistSyncs };
}

async function runSetupFetch(payload) {
  const fetchSource = extractFunction(setupSource, 'async function fetchModels(');
  const wiz = {
    llm: {
      available_models: [{ id: 'kept-setup-model' }],
      modelsForIdentity: 'identity-a',
    },
  };
  const statuses = [];
  let paintedModels = null;
  const fetchModels = new Function(
    'validateRequiredForModels',
    'setStatus',
    'readForm',
    'currentModelsIdentity',
    'beginLlmAction',
    'setProgress',
    'ctx',
    'w',
    'llmActionAlive',
    'wiz',
    'paintModelOptions',
    'compactErrorSummary',
    'finishLlmAction',
    'fetchModelsBtn',
    'requireAiModelList',
    `${fetchSource}; return fetchModels;`,
  )(
    () => '',
    (kind, text) => { statuses.push([kind, text]); },
    () => ({ provider: 'openai', base_url: 'https://example.test/v1', api_key: '' }),
    () => 'identity-a',
    () => ({ token: 1 }),
    () => {},
    { api: { async post() { return payload; } } },
    { signal: new AbortController().signal },
    () => true,
    wiz,
    models => { paintedModels = models; },
    value => String(value || ''),
    () => {},
    {},
    requireAiModelList,
  );
  const result = await fetchModels();
  return { result, wiz, statuses, paintedModels };
}

for (const malformed of [
  null,
  {},
  { ok: true, models: null },
  { ok: true, models: {} },
  { ok: true, models: [null] },
  { ok: true, models: ['model-as-string'] },
  { ok: true, models: [{ id: '' }] },
]) {
  const settings = await runSettingsFetch(malformed);
  assert.deepEqual(settings.draft.availableModels, ['kept-settings-model'],
    '设置页不得用畸形模型列表清掉当前模型缓存');
  assert.equal(settings.dirtyCalls, 0, '畸形响应不得把设置草稿标成用户修改');
  assert.equal(settings.datalistSyncs, 0, '畸形响应不得重画模型 datalist');
  assert.match(settings.statuses.at(-1)?.[0] || '', /响应格式|模型列表/,
    '设置页必须把畸形响应显示为读取失败');

  const setup = await runSetupFetch(malformed);
  assert.deepEqual(setup.wiz.llm.available_models, [{ id: 'kept-setup-model' }],
    '向导不得用畸形模型列表清掉当前模型缓存');
  assert.equal(setup.paintedModels, null, '畸形响应不得重画向导模型 datalist');
  assert.equal(setup.result, false, '向导畸形响应必须返回失败');
  assert.match(setup.statuses.at(-1)?.[1] || '', /响应格式|模型列表/,
    '向导必须把畸形响应显示为读取失败');
}

const settingsEmpty = await runSettingsFetch({ ok: true, models: [] });
assert.deepEqual(settingsEmpty.draft.availableModels, [], '合法空数组必须保留提供方空列表业务语义');
assert.equal(settingsEmpty.dirtyCalls, 1, '合法模型列表才允许更新设置草稿');

const setupEmpty = await runSetupFetch({ ok: true, models: [] });
assert.deepEqual(setupEmpty.wiz.llm.available_models, [], '向导必须接受合法空模型数组');
assert.deepEqual(setupEmpty.paintedModels, [], '合法空模型数组必须重画向导 datalist');

console.log('web AI model list response contract tests passed');
