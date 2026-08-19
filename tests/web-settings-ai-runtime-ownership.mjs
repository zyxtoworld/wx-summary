import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateAiBaseUrl } from '../src/web/public/js/shared/ai-base-url.js';
import { requireAiConnectivityResult } from '../src/web/public/js/shared/ai-connectivity-result.js';
import { requireAiModelList } from '../src/web/public/js/shared/ai-model-list.js';
import { llmEndpointIdentity, llmIdentity } from '../src/web/public/js/shared/ai-identity.js';

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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const source = await readFile(
  new URL('../src/web/public/js/pages/settings/ai.js', import.meta.url),
  'utf8',
);
const currentEndpointIdentitySource = extractFunction(source, 'function currentEndpointIdentity()');
const currentLlmIdentitySource = extractFunction(source, 'function currentLlmIdentity()');
const settingsPageSource = await readFile(
  new URL('../src/web/public/js/pages/settings/index.js', import.meta.url),
  'utf8',
);
assert.match(settingsPageSource, /function observeRuntimePayload\([\s\S]*?void focusProbe\.request\(\)/,
  'AI 运行时同步反例必须绑定到设置页真实 focusProbe caller');
assert.match(settingsPageSource, /adoptSettingsDocument\(document, \{ repaint: true, preserveDirty: false \}\)/,
  'AI 运行时同步反例必须覆盖无草稿时真实采用设置文档的路径');

function createActionHarness(kind) {
  const baseUrlInput = { value: 'https://a.example/v1' };
  const apiKeyInput = { value: '' };
  const modelInput = { value: 'model-a' };
  const longModelInput = { value: '' };
  const draft = { provider: 'openai', availableModels: ['saved-model'], dirty: false };
  let currentRevision = 'settings-a';
  const statuses = [];
  const response = deferred();
  let modelDatalistSyncs = 0;
  let rendered = 0;
  let endCalls = 0;
  const testResults = { replaceChildren() {} };
  const token = { signal: new AbortController().signal };
  const page = {
    beginAction() { return token; },
    alive() { return true; },
    endAction() { endCalls += 1; },
    getBaseRevision() { return currentRevision; },
  };
  const currentEndpointIdentity = new Function(
    'baseUrlInput', 'validateAiBaseUrl', 'draft', 'apiKeyInput', 'page', 'llmEndpointIdentity',
    `${currentEndpointIdentitySource}; return currentEndpointIdentity;`,
  )(baseUrlInput, validateAiBaseUrl, draft, apiKeyInput, page, llmEndpointIdentity);
  const currentLlmIdentity = new Function(
    'baseUrlInput', 'validateAiBaseUrl', 'draft', 'apiKeyInput', 'modelInput', 'longModelInput',
    'page', 'llmIdentity',
    `${currentLlmIdentitySource}; return currentLlmIdentity;`,
  )(
    baseUrlInput,
    validateAiBaseUrl,
    draft,
    apiKeyInput,
    modelInput,
    longModelInput,
    page,
    llmIdentity,
  );
  const args = [
    'normalizedBaseUrlForAction',
    'status',
    'testStatus',
    'focusFirstInvalid',
    'baseUrlInput',
    'apiKeyInput',
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
    'testResults',
    'modelInput',
    'longModelInput',
    'renderTestResults',
    'requireAiConnectivityResult',
    'currentEndpointIdentity',
    'currentLlmIdentity',
  ];
  const body = {
    provider: draft.provider,
    base_url: baseUrlInput.value,
    ...(kind === 'test' ? { model: modelInput.value } : {}),
  };
  const fnSource = kind === 'models'
    ? extractFunction(source, 'async function fetchModels()')
    : extractFunction(source, 'async function runTest()');
  const fn = new Function(
    ...args,
    `${fnSource}; return ${kind === 'models' ? 'fetchModels' : 'runTest'};`,
  )(
    () => ({ ok: true, value: baseUrlInput.value }),
    { set(...value) { statuses.push(['status', ...value]); }, clear() {} },
    { set(...value) { statuses.push(['test', ...value]); }, clear() {} },
    () => {},
    baseUrlInput,
    apiKeyInput,
    page,
    {}, {}, {},
    { post(path, actualBody) {
      assert.equal(actualBody.base_url, body.base_url, '请求必须携带 A 的端点');
      return response.promise;
    } },
    value => ({ provider: draft.provider, base_url: value }),
    draft,
    () => { modelDatalistSyncs += 1; },
    () => {},
    () => false,
    (error, fallback) => error?.message || fallback,
    requireAiModelList,
    testResults,
    modelInput,
    longModelInput,
    () => { rendered += 1; },
    requireAiConnectivityResult,
    currentEndpointIdentity,
    currentLlmIdentity,
  );
  return {
    run: fn,
    response,
    form: { baseUrlInput, apiKeyInput, modelInput, longModelInput },
    draft,
    setRevision(value) { currentRevision = value; },
    statuses,
    get modelDatalistSyncs() { return modelDatalistSyncs; },
    get rendered() { return rendered; },
    get endCalls() { return endCalls; },
  };
}

const models = createActionHarness('models');
const modelsRun = models.run();
await Promise.resolve();
models.form.baseUrlInput.value = 'https://b.example/v1';
models.draft.availableModels = null;
models.response.resolve({ ok: true, models: [{ id: 'model-from-a' }] });
await modelsRun;
assert.equal(models.draft.availableModels, null,
  '运行时同步切换到 B 后,A 的晚到模型列表不得写入 B');
assert.equal(models.modelDatalistSyncs, 0, '旧模型列表不得重画 B 的 datalist');
assert.equal(models.endCalls, 1, '旧模型列表动作仍必须释放自己的 token');

const test = createActionHarness('test');
const testRun = test.run();
await Promise.resolve();
test.form.baseUrlInput.value = 'https://b.example/v1';
test.form.modelInput.value = 'model-b';
test.response.resolve({
  ok: true,
  partial_ok: false,
  model_results: [{
    role: 'model',
    model: 'model-a',
    ok: true,
    partial_ok: false,
    capabilities: [{ name: 'summary_json', ok: true, latency_ms: 1 }],
  }],
  latency_ms: 1,
});
await testRun;
assert.equal(test.rendered, 0, 'A 的晚到连通结果不得渲染到 B');
assert.equal(test.statuses.filter(([kind]) => kind === 'test').length, 2,
  '旧连通结果只允许投影一次可操作的过期提示,不得追加成功/失败状态');
assert.match(test.statuses.at(-1)?.[1] || '', /忽略过期连通结果/,
  '过期连通结果必须明确提示用户重新测试');
assert.equal(test.endCalls, 1, '旧连通测试动作仍必须释放自己的 token');

const savedKeyRevision = createActionHarness('models');
const savedKeyRevisionRun = savedKeyRevision.run();
await Promise.resolve();
savedKeyRevision.setRevision('settings-b');
savedKeyRevision.draft.availableModels = null;
savedKeyRevision.response.resolve({ ok: true, models: [{ id: 'model-from-old-key' }] });
await savedKeyRevisionRun;
assert.equal(savedKeyRevision.draft.availableModels, null,
  '可见 AI 字段不变但已保存 Key revision 变化时,旧模型列表必须丢弃');

const savedKeyRevisionTest = createActionHarness('test');
const savedKeyRevisionTestRun = savedKeyRevisionTest.run();
await Promise.resolve();
savedKeyRevisionTest.setRevision('settings-b');
savedKeyRevisionTest.response.resolve({
  ok: true,
  partial_ok: false,
  model_results: [{
    role: 'model',
    model: 'model-a',
    ok: true,
    partial_ok: false,
    capabilities: [{ name: 'summary_json', ok: true, latency_ms: 1 }],
  }],
  latency_ms: 1,
});
await savedKeyRevisionTestRun;
assert.equal(savedKeyRevisionTest.rendered, 0,
  '可见 AI 字段不变但已保存 Key revision 变化时,旧连通结果必须丢弃');
assert.match(savedKeyRevisionTest.statuses.at(-1)?.[1] || '', /忽略过期连通结果/,
  'saved-key revision 变化必须给出重新测试提示');

const sameRevision = createActionHarness('models');
const sameRevisionRun = sameRevision.run();
await Promise.resolve();
sameRevision.response.resolve({ ok: true, models: [{ id: 'model-for-current-key' }] });
await sameRevisionRun;
assert.deepEqual(sameRevision.draft.availableModels, ['model-for-current-key'],
  '相同 settings revision 的合法模型列表必须正常落地');

const sameRevisionTest = createActionHarness('test');
const sameRevisionTestRun = sameRevisionTest.run();
await Promise.resolve();
sameRevisionTest.response.resolve({
  ok: true,
  partial_ok: false,
  model_results: [{
    role: 'model',
    model: 'model-a',
    ok: true,
    partial_ok: false,
    capabilities: [{ name: 'summary_json', ok: true, latency_ms: 1 }],
  }],
  latency_ms: 1,
});
await sameRevisionTestRun;
assert.equal(sameRevisionTest.rendered, 1,
  '相同 settings revision 的合法连通结果必须正常渲染');

console.log('web settings AI runtime ownership tests passed');
