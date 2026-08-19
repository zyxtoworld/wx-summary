import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as llmDraft from '../src/web/public/js/pages/setup/llm-draft.js';
import { requireSettingsDocument } from '../src/web/public/js/shared/settings-document.js';

const source = await readFile(
  new URL('../src/web/public/js/pages/setup/step-llm.js', import.meta.url),
  'utf8',
);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const ensureSettingsStart = source.indexOf('async function ensureSettingsLoaded(action)');
const ensureSettingsEnd = source.indexOf('\n  function prefill()', ensureSettingsStart);
assert.ok(ensureSettingsStart >= 0 && ensureSettingsEnd > ensureSettingsStart,
  '必须能定位生产 ensureSettingsLoaded owner 边界');
const ensureSettingsSource = source.slice(ensureSettingsStart, ensureSettingsEnd);
function createEnsureSettingsLoaded({ wiz, getSettings, alive }) {
  const action = Object.freeze({ token: 1 });
  const ensureSettingsLoaded = new Function(
    'wiz',
    'ctx',
    'w',
    'llmActionAlive',
    'requireSettingsDocument',
    `${ensureSettingsSource}; return ensureSettingsLoaded;`,
  )(
    wiz,
    { api: { get: getSettings } },
    { signal: new AbortController().signal },
    candidate => candidate === action && alive(),
    requireSettingsDocument,
  );
  return { action, ensureSettingsLoaded };
}

{
  const wiz = { settings: null, baseRevision: 'before-invalid' };
  const harness = createEnsureSettingsLoaded({ wiz, getSettings: async () => null, alive: () => true });
  await assert.rejects(
    harness.ensureSettingsLoaded(harness.action),
    error => error?.code === 'invalid_settings_document' && error?.status === 502,
    '当前动作拿到 200+null 设置响应时必须明确失败',
  );
  assert.equal(wiz.settings, null, '畸形设置响应不得写入 wizard');
  assert.equal(wiz.baseRevision, 'before-invalid', '畸形设置响应不得覆盖 revision');
}

{
  const pendingSettings = deferred();
  let current = true;
  const wiz = { settings: null, baseRevision: 'before-stale' };
  const harness = createEnsureSettingsLoaded({
    wiz,
    getSettings: () => pendingSettings.promise,
    alive: () => current,
  });
  const pending = harness.ensureSettingsLoaded(harness.action);
  current = false;
  pendingSettings.resolve({ settings_revision: 'late-revision', llm: { model: 'late-model' } });
  assert.equal(await pending, false, '失效动作的设置晚到必须返回 false');
  assert.equal(wiz.settings, null, '失效动作不得写入晚到设置');
  assert.equal(wiz.baseRevision, 'before-stale', '失效动作不得覆盖当前 revision');
}

{
  const settings = { settings_revision: 'current-revision', llm: { model: 'auto' } };
  const wiz = { settings: null, baseRevision: '' };
  const harness = createEnsureSettingsLoaded({ wiz, getSettings: async () => settings, alive: () => true });
  assert.equal(await harness.ensureSettingsLoaded(harness.action), true,
    '当前动作必须采用有效设置文档');
  assert.strictEqual(wiz.settings, settings);
  assert.equal(wiz.baseRevision, 'current-revision');
}

{
  const cachedSettings = { settings_revision: 'cached-revision', llm: { model: 'cached-model' } };
  const wiz = { settings: cachedSettings, baseRevision: '' };
  const harness = createEnsureSettingsLoaded({
    wiz,
    getSettings: async () => { throw new Error('缓存设置有效时不应重复请求'); },
    alive: () => true,
  });
  assert.equal(await harness.ensureSettingsLoaded(harness.action), true,
    '缓存设置文档有效时当前动作仍应成功');
  assert.equal(wiz.baseRevision, 'cached-revision',
    '复用缓存设置文档时必须恢复 revision,避免 saved-key 身份退化为空 revision');
}

assert.equal(typeof llmDraft.llmEndpointIdentity, 'function',
  '模型列表必须使用只包含 provider/base_url/api_key 的端点身份');

const endpointForm = {
  provider: 'openai',
  base_url: 'https://example.invalid/v1',
  api_key: 'synthetic-key',
  model: 'auto',
  long_context_model: 'auto-long',
};
assert.equal(
  llmDraft.llmEndpointIdentity(endpointForm),
  llmDraft.llmEndpointIdentity({ ...endpointForm, model: 'another', long_context_model: '' }),
  '选择模型不能使同一端点的模型列表身份变化',
);
assert.notEqual(
  llmDraft.llmEndpointIdentity(endpointForm),
  llmDraft.llmEndpointIdentity({ ...endpointForm, base_url: 'https://other.invalid/v1' }),
  'Base URL 变化必须使旧模型列表失效',
);
assert.notEqual(
  llmDraft.llmEndpointIdentity(endpointForm),
  llmDraft.llmEndpointIdentity({ ...endpointForm, api_key: 'other-synthetic-key' }),
  'API Key 变化必须使旧模型列表失效',
);

assert.match(source, /function beginLlmAction\(kind, focusCandidates = \[\]\)/,
  'AI 步骤必须由单一动作入口独占初始化、模型拉取、连通测试和保存');
assert.match(source, /function finishLlmAction\(action\)/,
  '只有当前动作可以释放 AI 步骤忙态');
assert.match(source, /function syncBusyControls\(\)[\s\S]*providerSelect[\s\S]*baseInput[\s\S]*keyInput[\s\S]*modelInput[\s\S]*longInput[\s\S]*fetchModelsBtn[\s\S]*testBtn/,
  '忙态必须同时锁定身份输入和两个内部动作按钮');

function operation(name, nextName) {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf(`async function ${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, `必须能定位 ${name}`);
  return source.slice(start, end);
}

for (const [name, nextName] of [
  ['fetchModels', 'testConnectivity'],
  ['testConnectivity', 'saveSettings'],
]) {
  const block = operation(name, nextName);
  assert.match(block, /const action = beginLlmAction\(/, `${name} 必须先取得独占动作`);
  assert.match(block, /if \(!action\) return false;/, `${name} 在已有动作时不得发请求`);
  assert.match(block, /finally \{[\s\S]*finishLlmAction\(action\)/,
    `${name} 只能通过当前动作收尾释放忙态`);
}

const saveStart = source.indexOf('async function saveSettings');
const saveEnd = source.indexOf("fetchModelsBtn.addEventListener", saveStart);
const saveBlock = source.slice(saveStart, saveEnd);
assert.match(saveBlock, /const action = beginLlmAction\(/, '保存必须先取得独占动作');
assert.match(saveBlock, /if \(!action\) return false;/, '已有动作时不得并发保存');
assert.match(saveBlock, /finally \{[\s\S]*finishLlmAction\(action\)/,
  '保存只能通过当前动作收尾释放忙态');

assert.match(source, /const identityAtStart = currentModelsIdentity\(\)[\s\S]*currentModelsIdentity\(\) !== identityAtStart[\s\S]*modelsForIdentity = identityAtStart/,
  '模型响应必须只绑定请求开始时的端点身份，变化后丢弃旧响应');
assert.match(source, /wiz\.llm\.modelsForIdentity === currentModelsIdentity\(\)[\s\S]*llmPatch\.available_models/,
  '保存只能携带仍绑定当前端点的模型列表');
assert.match(source, /onEnter\(\) \{[\s\S]*beginLlmAction\('初始化 AI 设置'\)/,
  '步骤初始化必须进入同一个忙态边界，防止预填覆盖用户输入');

console.log('web setup llm action admission tests passed');
