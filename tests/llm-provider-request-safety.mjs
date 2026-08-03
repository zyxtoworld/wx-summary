import assert from 'node:assert/strict';
import http from 'node:http';
import { __llmInternals, summarizeDigest } from '../src/summarizer/llm.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function settings(baseUrl, model) {
  return {
    llm: {
      provider: 'openai',
      base_url: baseUrl,
      api_key: 'test-key',
      model,
      temperature: 0,
      timeout_ms: 5000,
      max_messages_per_call: 2,
      max_input_chars: 400,
      ai_concurrency: 2,
    },
    privacy: {},
    link_preview: { enabled: false },
  };
}

function messages(count = 1) {
  return Array.from({ length: count }, (_, index) => ({
    time: `2026-07-30 09:${String(index).padStart(2, '0')}`,
    sender: '测试成员',
    type: 'text',
    content: `第 ${index + 1} 条具体聊天内容`,
  }));
}

function options(baseUrl, model, overrides = {}) {
  return {
    settings: settings(baseUrl, model),
    accountId: 'wxacc_test_account',
    groupId: 'test-group@chatroom',
    groupName: '测试群',
    since: '2026-07-30 09:00',
    until: '2026-07-30 10:00',
    messages: messages(),
    ...overrides,
  };
}

let releaseHeldResponse;
let heldRequestStarted;
const heldRequestPromise = new Promise(resolve => { heldRequestStarted = resolve; });
const counts = { held: 0, redirected: 0, empty: 0, transientEmpty: 0, structured: 0, filtered: 0 };
const validDigest = {
  headline: '测试群聊摘要',
  highlights: ['群里确认了测试结论'],
  topics: [{ title: '测试结论', category: '讨论结果', participants: ['测试成员'], summary: '群里明确确认了测试结论。', need_followup: false }],
  todos: [],
  links: [],
  quotes: [],
};
const server = http.createServer(async (req, res) => {
  if (req.url === '/redirected') {
    counts.redirected++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (body.model === 'redirect-model') {
    res.writeHead(307, { Location: '/redirected' });
    res.end();
    return;
  }
  if (body.model === 'empty-model') {
    counts.empty++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '' } }] }));
    return;
  }
  if (body.model === 'transient-empty-model') {
    counts.transientEmpty++;
    if (counts.transientEmpty === 1) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'temporary gateway failure' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: { content: counts.transientEmpty === 2 ? '' : JSON.stringify(validDigest) },
      }],
    }));
    return;
  }
  if (body.model === 'structured-model') {
    counts.structured++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: { content: [{ type: 'text', text: JSON.stringify(validDigest) }] },
      }],
    }));
    return;
  }
  if (body.model === 'filtered-model') {
    counts.filtered++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ finish_reason: 'content_filter', message: { content: null } }],
    }));
    return;
  }
  counts.held++;
  heldRequestStarted();
  await new Promise(resolve => { releaseHeldResponse = resolve; });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify(validDigest),
      },
    }],
  }));
});

await listen(server);
const baseUrl = `http://127.0.0.1:${server.address().port}`;
try {
  const first = summarizeDigest(options(baseUrl, 'held-model'));
  await heldRequestPromise;
  await assert.rejects(
    () => summarizeDigest(options(baseUrl, 'held-model')),
    error => error?.code === 'ai_group_generation_in_progress' && error?.status === 409,
    'the same account and group must not start a second provider-call budget concurrently',
  );
  assert.equal(counts.held, 1, 'the rejected duplicate must not reach the provider');
  releaseHeldResponse();
  await first;

  await assert.rejects(
    () => summarizeDigest(options(baseUrl, 'redirect-model', { groupId: 'redirect@chatroom' })),
    error => error?.code === 'ai_network_failed',
    'provider redirects must fail closed instead of creating uncounted HTTP requests',
  );
  assert.equal(counts.redirected, 0, 'the provider redirect target must never be followed automatically');

  await assert.rejects(
    () => summarizeDigest(options(baseUrl, 'empty-model', { groupId: 'empty@chatroom' })),
    error => {
      assert.match(String(error?.message || ''), /empty content/i);
      assert.equal(error?.ai_request_mode, 'final/full');
      assert.equal(error?.ai_request_attempt, 1);
      assert.ok(Number(error?.ai_request_body_bytes || 0) > 0);
      assert.ok(Number(error?.ai_request_text_chars || 0) > 0);
      return true;
    },
    'an in-limit empty model output should be surfaced without repeated requests',
  );
  assert.equal(counts.empty, 1, 'an in-limit empty output must stop after one text request when no media downgrade is needed');

  const recoveredAfterTransientEmpty = await summarizeDigest(options(baseUrl, 'transient-empty-model', { groupId: 'transient-empty@chatroom' }));
  assert.equal(recoveredAfterTransientEmpty.headline, validDigest.headline, 'an empty completion immediately after a transient gateway failure should use the remaining bounded retry');
  assert.equal(counts.transientEmpty, 3, 'transient gateway failure, empty recovery response, and final successful response must stay within the three-attempt limit');

  const structured = await summarizeDigest(options(baseUrl, 'structured-model', { groupId: 'structured@chatroom' }));
  assert.equal(structured.headline, validDigest.headline, 'OpenAI-compatible structured text blocks must be parsed as completion text');
  assert.equal(counts.structured, 1, 'structured completion text should not trigger an unnecessary repair request');

  assert.equal(
    __llmInternals.extractOpenAiChatCompletionText({
      content: [
        { type: 'reasoning', text: '不能作为摘要正文' },
        { type: 'text', text: '可用摘要正文' },
      ],
    }),
    '可用摘要正文',
    'only explicit text blocks may become the completion body',
  );

  await assert.rejects(
    () => summarizeDigest(options(baseUrl, 'filtered-model', { groupId: 'filtered@chatroom' })),
    error => error?.code === 'ai_content_filtered',
    'content-filter completion results must be surfaced as a corrective-action failure',
  );
  assert.equal(counts.filtered, 1, 'content-filtered responses must not be retried as transient 502 failures');
} finally {
  if (releaseHeldResponse) releaseHeldResponse();
  await close(server);
}

console.log('LLM provider request-safety tests passed');
