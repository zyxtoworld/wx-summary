import assert from 'node:assert/strict';
import http from 'node:http';
import { __llmInternals } from '../src/summarizer/llm.js';
import { summarizeDigest } from '../src/summarizer/llm.js';
import { __mainInternals } from '../src/main.js';

const headers = new Headers({ 'x-request-id': 'req-safe-123' });
const providerSummary = __llmInternals.providerErrorSummary(
  400,
  headers,
  {
    error: {
      code: 'context_length_exceeded',
      message: 'raw private chat text and sk-secret-must-not-escape',
    },
  },
  '',
);

assert.equal(providerSummary.category, 'input_too_large');
assert.equal(providerSummary.code, 'context_length_exceeded');
assert.equal(providerSummary.detail, '模型上下文上限已超出');
assert.equal(providerSummary.request_id, 'req-safe-123');
assert.doesNotMatch(JSON.stringify(providerSummary), /raw private chat|sk-secret-must-not-escape/);

const unsafeCodeSummary = __llmInternals.providerErrorSummary(
  400,
  new Headers(),
  { error: { code: 'bad code with spaces and secret=value', message: 'invalid request' } },
  '',
);
assert.equal(unsafeCodeSummary.code, '', 'provider codes with non-protocol characters must not be propagated');

assert.equal(
  __mainInternals.digestAiErrorCode({
    status: 400,
    message: 'AI input exceeds model context length',
    lower: 'ai input exceeds model context length',
    providerErrorCategory: 'input_too_large',
  }),
  'ai_input_too_large',
  'structured provider input errors must not be misclassified as truncated model output',
);

assert.equal(
  __mainInternals.digestAiErrorCode({
    status: 504,
    message: 'AI service unavailable',
    lower: 'ai service unavailable',
    providerErrorCategory: 'provider_unavailable',
  }),
  'ai_timeout',
  'provider-unavailable responses with a gateway timeout status should remain a timeout',
);

const classified = __mainInternals.classifyDigestAiError({
  status: 400,
  message: 'AI input exceeds model context length',
  provider_error_category: 'input_too_large',
  provider_error_code: 'context_length_exceeded',
  provider_error_detail: '模型上下文上限已超出',
  ai_request_mode: 'final/full',
  ai_request_attempt: 3,
  ai_request_body_bytes: 123456,
  ai_request_text_chars: 45678,
  ai_request_media_count: 2,
  ai_call_budget: { used: 3, limit: 24, remaining: 21 },
}, { stage: 'summarizing', phase: 'llm_request' });

assert.equal(classified.code, 'ai_input_too_large');
assert.equal(classified.diagnostics.provider_error_code, 'context_length_exceeded');
assert.equal(classified.diagnostics.provider_error_detail, '模型上下文上限已超出');
assert.equal(classified.diagnostics.ai_request_mode, 'final/full');
assert.equal(classified.diagnostics.ai_request_attempt, 3);
assert.equal(classified.diagnostics.ai_request_body_bytes, 123456);
assert.equal(classified.diagnostics.ai_request_text_chars, 45678);
assert.equal(classified.diagnostics.ai_request_media_count, 2);
assert.deepEqual(classified.diagnostics.ai_call_budget, { used: 3, limit: 24, remaining: 21 });
const failureLog = __mainInternals.digestFailureLogFields({
  status: 400,
  public_code: classified.code,
  message: 'AI request failed without prompt content',
  ai_diagnostics: classified.diagnostics,
}, { stage: 'summarizing', phase: 'llm_request' });
assert.equal(failureLog.ai_request_mode, 'final/full');
assert.equal(failureLog.ai_request_attempt, 3);
assert.equal(failureLog.ai_request_body_bytes, 123456);
assert.equal(failureLog.ai_request_text_chars, 45678);
assert.equal(failureLog.ai_request_media_count, 2);
assert.deepEqual(failureLog.ai_call_budget, { used: 3, limit: 24, remaining: 21 });

const server = http.createServer(async (req, res) => {
  for await (const _ of req) {}
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'invalid_request', message: 'private-chat-marker must stay out of diagnostics' } }));
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
try {
  const { port } = server.address();
  await assert.rejects(
    () => summarizeDigest({
      settings: {
        llm: {
          provider: 'openai',
          base_url: `http://127.0.0.1:${port}`,
          api_key: 'test-key',
          model: 'test-model',
          temperature: 0,
          timeout_ms: 5000,
          ai_concurrency: 1,
        },
        privacy: {},
      },
      groupName: '测试群',
      since: '2026-08-03 10:00',
      until: '2026-08-03 10:10',
      messages: [{ time: '10:01', sender: '用户', type: 'text', content: 'sensitive-message-marker' }],
    }),
    error => {
      assert.equal(error.ai_request_mode, 'final/full');
      assert.equal(error.ai_request_attempt, 1);
      assert.ok(error.ai_request_body_bytes > 0);
      assert.ok(error.ai_request_text_chars > 0);
      assert.equal(error.ai_request_media_count, 0);
      assert.deepEqual(error.ai_call_budget, { used: 1, limit: 24, remaining: 23 });
      assert.doesNotMatch(JSON.stringify({
        mode: error.ai_request_mode,
        attempt: error.ai_request_attempt,
        bytes: error.ai_request_body_bytes,
        chars: error.ai_request_text_chars,
        media: error.ai_request_media_count,
        budget: error.ai_call_budget,
      }), /sensitive-message-marker|private-chat-marker/);
      return true;
    },
  );
} finally {
  await new Promise(resolve => server.close(resolve));
}

console.log('digest AI provider classification tests passed');
