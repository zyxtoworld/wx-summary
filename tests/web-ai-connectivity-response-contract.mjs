import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { requireAiConnectivityResult } from '../src/web/public/js/shared/ai-connectivity-result.js';

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

async function runSettingsTest(payload) {
  const runSource = extractFunction(settingsSource, 'async function runTest()');
  const statuses = [];
  let rendered = 0;
  let endCalls = 0;
  const baseUrlInput = { value: 'https://example.test/v1' };
  const modelInput = { value: 'auto' };
  const longModelInput = { value: 'auto' };
  const testResults = { replaceChildren() {} };
  const runTest = new Function(
    'normalizedBaseUrlForAction',
    'testStatus',
    'focusFirstInvalid',
    'baseUrlInput',
    'currentLlmIdentity',
    'page',
    'fetchModelsBtn',
    'testBtn',
    'saveBtn',
    'testResults',
    'llmActionBody',
    'modelInput',
    'longModelInput',
    'api',
    'renderTestResults',
    'isAbortError',
    'errorText',
    'requireAiConnectivityResult',
    `${runSource}; return runTest;`,
  )(
    () => ({ ok: true, value: 'https://example.test/v1' }),
    { set(text, kind) { statuses.push([text, kind]); } },
    () => {},
    baseUrlInput,
    () => 'settings-test-identity',
    {
      beginAction() { return { signal: new AbortController().signal }; },
      alive() { return true; },
      endAction() { endCalls += 1; },
    },
    {},
    {},
    {},
    testResults,
    () => ({}),
    modelInput,
    longModelInput,
    { async post() { return payload; } },
    () => { rendered += 1; },
    () => false,
    (error, fallback) => error?.message || fallback,
    requireAiConnectivityResult,
  );
  await runTest();
  return { statuses, rendered, endCalls };
}

async function runSetupTest(payload) {
  const runSource = extractFunction(setupSource, 'async function testConnectivity(');
  const wiz = { baseRevision: '', settings: {}, llm: { testedIdentity: 'previous-tested' } };
  const statuses = [];
  let endCalls = 0;
  const testConnectivity = new Function(
    'validateRequired',
    'setStatus',
    'currentIdentity',
    'readForm',
    'beginLlmAction',
    'testBtn',
    'setProgress',
    'ctx',
    'w',
    'llmActionAlive',
    'wiz',
    'formatTestResult',
    'compactErrorSummary',
    'finishLlmAction',
    'requireAiConnectivityResult',
    `${runSource}; return testConnectivity;`,
  )(
    () => '',
    (kind, text) => { statuses.push([kind, text]); },
    () => 'identity-current',
    () => ({
      provider: 'openai',
      base_url: 'https://example.test/v1',
      api_key: '',
      model: 'auto',
      long_context_model: 'auto',
    }),
    () => ({ token: 1 }),
    {},
    () => {},
    { api: { async post() { return payload; } } },
    { signal: new AbortController().signal },
    () => true,
    wiz,
    () => 'synthetic result',
    value => String(value || ''),
    () => { endCalls += 1; },
    requireAiConnectivityResult,
  );
  const result = await testConnectivity();
  return { result, wiz, statuses, endCalls };
}

const malformed = { ok: true };
const settingsMalformed = await runSettingsTest(malformed);
assert.equal(settingsMalformed.rendered, 0, '设置页不得渲染缺少能力明细的成功响应');
assert.equal(settingsMalformed.statuses.at(-1)?.[1], 'err', '设置页必须把畸形成功响应显示为错误');
assert.match(settingsMalformed.statuses.at(-1)?.[0] || '', /响应格式|连通测试/, '设置页错误必须可操作');
assert.equal(settingsMalformed.endCalls, 1, '设置页畸形响应仍必须释放 action token');

const setupMalformed = await runSetupTest(malformed);
assert.equal(setupMalformed.result, false, '向导不得把畸形成功响应视为测试通过');
assert.equal(setupMalformed.wiz.llm.testedIdentity, '', '畸形响应必须清除向导旧测试身份');
assert.equal(setupMalformed.statuses.at(-1)?.[0], 'err', '向导必须显示明确错误态');
assert.match(setupMalformed.statuses.at(-1)?.[1] || '', /响应格式|连通测试/, '向导错误必须可操作');
assert.equal(setupMalformed.endCalls, 1, '向导畸形响应仍必须释放 action lease');

for (const inconsistent of [
  null,
  {},
  { ok: true, partial_ok: false, model_results: [] },
  {
    ok: true,
    partial_ok: false,
    model_results: [{ role: 'model', model: 'auto', ok: false, partial_ok: false, capabilities: [{ name: 'summary_json', ok: false }] }],
  },
  {
    ok: true,
    partial_ok: false,
    model_results: [{ role: 'model', model: 'auto', ok: true, partial_ok: true, capabilities: [{ name: 'summary_json', ok: true }, { name: 'responses', ok: false }] }],
  },
]) {
  assert.throws(
    () => requireAiConnectivityResult(inconsistent),
    error => error?.status === 502 && error?.code === 'ai_connectivity_response_invalid',
    '结构缺失或聚合状态矛盾的连通响应必须使用固定 502 合同拒绝',
  );
}

const valid = {
  ok: true,
  partial_ok: false,
  latency_ms: 12,
  model_results: [{
    role: 'model',
    model: 'auto',
    ok: true,
    partial_ok: false,
    latency_ms: 12,
    capabilities: [{ name: 'summary_json', ok: true, latency_ms: 12 }],
  }],
};
const settingsValid = await runSettingsTest(valid);
assert.equal(settingsValid.rendered, 1, '合法连通响应必须渲染能力明细');
assert.equal(settingsValid.statuses.at(-1)?.[1], 'ok', '合法全通过响应必须保持成功态');

const setupValid = await runSetupTest(valid);
assert.equal(setupValid.result, true, '向导必须接受合法全通过响应');
assert.equal(setupValid.wiz.llm.testedIdentity, 'identity-current', '合法响应必须记录当前测试身份');

const validPartial = {
  ok: true,
  partial_ok: true,
  model_results: [{
    role: 'model',
    model: 'auto',
    ok: true,
    partial_ok: true,
    capabilities: [
      { name: 'summary_json', ok: true },
      { name: 'responses', ok: false },
    ],
  }],
};
assert.strictEqual(requireAiConnectivityResult(validPartial), validPartial,
  '必需摘要能力通过但可选能力失败的合法 partial 响应必须保留');

console.log('web AI connectivity response contract tests passed');
