import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateAiBaseUrl } from '../src/web/public/js/shared/ai-base-url.js';

const [settingsSource, setupSource] = await Promise.all([
  readFile(new URL('../src/web/public/js/pages/settings/ai.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/js/pages/setup/step-llm.js', import.meta.url), 'utf8'),
]);

assert.match(settingsSource, /from ['"]\/js\/shared\/ai-base-url\.js['"]/,
  '设置页必须依赖 shared Base URL 校验器');
assert.match(setupSource, /from ['"]\/js\/shared\/ai-base-url\.js['"]/,
  '向导必须依赖 shared Base URL 校验器');
assert.doesNotMatch(setupSource, /pages[\\/]settings[\\/]ai-validation\.js|\.\.\/settings\/ai-validation\.js/,
  '向导不能反向依赖设置页模块');
assert.match(setupSource, /const baseUrl = baseUrlValidation\.ok \? baseUrlValidation\.value : rawBaseUrl/,
  '向导表单必须把规范化 Base URL 作为统一表单值');
assert.match(setupSource, /base_url: form\.base_url/,
  '向导网络请求和保存必须使用统一表单 Base URL');
assert.match(settingsSource, /llmActionBody\(baseUrlValidation\.value\)/,
  '设置页模型请求必须使用校验器返回的规范化 Base URL');
assert.match(settingsSource, /patch\.base_url = baseUrlValidation\.value/,
  '设置页保存必须使用校验器返回的规范化 Base URL');

for (const [value, expected] of [
  ['https://api.example.com/v1/', { ok: true, value: 'https://api.example.com/v1' }],
  ['https://api.example.com/v1////', { ok: true, value: 'https://api.example.com/v1' }],
  ['ftp://api.example.com/v1', { ok: false, message: 'Base URL 必须是 http(s) URL,且不能包含用户名、密码、query 或 fragment,例如 https://api.example.com/v1。' }],
  ['not-a-url', { ok: false, message: 'Base URL 必须是 http(s) URL,且不能包含用户名、密码、query 或 fragment,例如 https://api.example.com/v1。' }],
]) {
  assert.deepEqual(validateAiBaseUrl(value), expected,
    `设置页和向导必须对 ${value} 使用同一规范化结果`);
}

console.log('web AI Base URL consistency tests passed');
