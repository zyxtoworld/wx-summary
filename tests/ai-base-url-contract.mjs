import assert from 'node:assert/strict';
import { defaultSettings, normalizeBaseUrl, validateSettingsObject } from '../src/config/settings.js';
import { validateAiBaseUrl } from '../src/web/public/js/shared/ai-base-url.js';
import { listModels, testLlmConnectivity } from '../src/summarizer/llm.js';

const validCases = [
  ['https://api.example.com', 'https://api.example.com'],
  ['https://api.example.com/', 'https://api.example.com'],
  ['https://api.example.com/v1////', 'https://api.example.com/v1'],
  ['https://api.example.com:8443/v1/', 'https://api.example.com:8443/v1'],
  ['http://[::1]:8080/v1///', 'http://[::1]:8080/v1'],
];
for (const [input, expected] of validCases) {
  assert.deepEqual(validateAiBaseUrl(input), { ok: true, value: expected }, `frontend contract: ${input}`);
  assert.equal(normalizeBaseUrl(input), expected, `backend contract: ${input}`);
}

const invalidCases = [
  'ftp://api.example.com/v1',
  'http:///v1',
  'https://:443/v1',
  'https://user:pass@api.example.com/v1',
  'https://api.example.com/v1?token=///',
  'https://api.example.com/v1?x=1',
  'https://api.example.com/v1#fragment',
];
for (const input of invalidCases) {
  assert.equal(validateAiBaseUrl(input).ok, false, `frontend must reject ${input}`);
  assert.equal(normalizeBaseUrl(input), '', `backend must not normalize ${input} into a request URL`);
  const settings = defaultSettings();
  settings.llm.base_url = input;
  assert.ok(
    validateSettingsObject(settings, { requireBaseUrl: true }).some(error => error.includes('llm.base_url')),
    `server settings validation must reject ${input}`,
  );
  await assert.rejects(
    () => listModels({ provider: 'openai', base_url: input, api_key: 'test-only' }),
    error => error?.status === 400 && error?.message === 'Missing base_url',
    `model listing must reject ${input} before endpoint construction`,
  );
  await assert.rejects(
    () => testLlmConnectivity({ provider: 'openai', base_url: input, api_key: 'test-only', model: 'auto' }),
    error => error?.status === 400 && error?.message === 'Missing base_url',
    `connectivity testing must reject ${input} before endpoint construction`,
  );
}

console.log('AI Base URL contract tests passed');
