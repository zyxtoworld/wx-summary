import assert from 'node:assert/strict';
import { validateAiBaseUrl } from '../src/web/public/js/shared/ai-base-url.js';

assert.deepEqual(validateAiBaseUrl(''), {
  ok: false,
  message: 'Base URL 必须是 http(s) URL,且不能包含用户名、密码、query 或 fragment,例如 https://api.example.com/v1。',
});
assert.deepEqual(validateAiBaseUrl('not-a-url'), {
  ok: false,
  message: 'Base URL 必须是 http(s) URL,且不能包含用户名、密码、query 或 fragment,例如 https://api.example.com/v1。',
});
assert.deepEqual(validateAiBaseUrl('ftp://api.example.com/v1'), {
  ok: false,
  message: 'Base URL 必须是 http(s) URL,且不能包含用户名、密码、query 或 fragment,例如 https://api.example.com/v1。',
});
assert.deepEqual(validateAiBaseUrl('https://api.example.com/v1/'), {
  ok: true,
  value: 'https://api.example.com/v1',
});
assert.deepEqual(validateAiBaseUrl('https://api.example.com/v1////'), {
  ok: true,
  value: 'https://api.example.com/v1',
});
assert.deepEqual(validateAiBaseUrl('http://127.0.0.1:8080'), {
  ok: true,
  value: 'http://127.0.0.1:8080',
});
assert.deepEqual(validateAiBaseUrl('https://api.example.com'), {
  ok: true,
  value: 'https://api.example.com',
});
assert.deepEqual(validateAiBaseUrl('http://[::1]:8080/v1///'), {
  ok: true,
  value: 'http://[::1]:8080/v1',
});
for (const value of [
  'https://user:pass@api.example.com/v1',
  'https://@api.example.com/v1',
  'http:///v1',
  'https://:443/v1',
  'https://api.example.com/v1?token=///',
  'https://api.example.com/v1?x=1',
  'https://api.example.com/v1#fragment',
]) {
  assert.equal(validateAiBaseUrl(value).ok, false, `${value} must be rejected`);
}

console.log('web settings AI validation tests passed');
