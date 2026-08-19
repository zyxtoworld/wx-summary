import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

const stepSource = await readFile(
  new URL('../src/web/public/js/pages/setup/step-llm.js', import.meta.url),
  'utf8',
);
assert.match(stepSource, /import \{[^}]*llmIdentity[^}]*\} from ['"]\/js\/shared\/ai-identity\.js['"]/,
  '向导必须使用统一的 LLM 身份计算器');
assert.match(stepSource, /return llmIdentity\(\{ \.\.\.readForm\(\), settings_revision: wiz\.baseRevision \}\)/,
  '向导表单身份必须由统一计算器并绑定当前设置 revision');

const currentIdentitySource = extractFunction(stepSource, 'function currentIdentity()');
const currentModelsIdentitySource = extractFunction(stepSource, 'function currentModelsIdentity()');
const form = {
  provider: 'openai',
  base_url: 'https://api.example.com/v1',
  api_key: '',
  model: 'auto',
  long_context_model: 'auto-long',
};
const readForm = () => ({ ...form });
const wiz = { baseRevision: 'settings-a' };
const currentIdentity = new Function(
  'readForm', 'wiz', 'llmIdentity',
  `${currentIdentitySource}; return currentIdentity;`,
)(readForm, wiz, llmIdentity);
const currentModelsIdentity = new Function(
  'readForm', 'wiz', 'llmEndpointIdentity',
  `${currentModelsIdentitySource}; return currentModelsIdentity;`,
)(readForm, wiz, llmEndpointIdentity);

const setupIdentityA = currentIdentity();
const setupModelsIdentityA = currentModelsIdentity();
wiz.baseRevision = 'settings-b';
assert.notEqual(currentIdentity(), setupIdentityA,
  '向导真实 LLM caller 必须把 saved-key settings revision 纳入身份');
assert.notEqual(currentModelsIdentity(), setupModelsIdentityA,
  '向导真实模型列表 caller 必须把 saved-key settings revision 纳入身份');

const base = {
  provider: 'openai',
  base_url: 'https://api.example.com/v1',
  api_key: 'first-test-key',
  model: 'auto',
  long_context_model: 'auto-long',
};

assert.notEqual(
  llmIdentity(base),
  llmIdentity({ ...base, api_key: 'second-test-key' }),
  '更换 API Key 后必须使旧连通测试失效',
);
assert.notEqual(
  llmIdentity(base),
  llmIdentity({ ...base, long_context_model: 'different-long-model' }),
  '更换长上下文模型后必须使旧连通测试失效',
);
assert.equal(
  llmIdentity({ ...base, api_key: '' }),
  llmIdentity({ ...base, api_key: '' }),
  '留空 API Key 时沿用已保存 Key,相同输入必须保持稳定身份',
);
assert.notEqual(
  llmIdentity({ ...base, api_key: '', settings_revision: 'settings-a' }),
  llmIdentity({ ...base, api_key: '', settings_revision: 'settings-b' }),
  '留空 API Key 时已保存 Key 的 settings revision 变化必须使旧连通测试失效',
);
assert.equal(
  llmIdentity({ ...base, api_key: '', settings_revision: 'settings-a' }),
  llmIdentity({ ...base, api_key: '', settings_revision: 'settings-a' }),
  '相同 settings revision 的 saved-key 身份必须稳定',
);

console.log('web setup llm identity tests passed');
