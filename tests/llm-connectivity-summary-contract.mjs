import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { testLlmConnectivity } from '../src/summarizer/llm.js';

let activeRequests = 0;
let maxActiveRequests = 0;
let rejectSummaryJson = false;
const requestBodies = [];

const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  requestBodies.push({ url: req.url, body });
  activeRequests++;
  maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
  await new Promise(resolve => setTimeout(resolve, 25));
  activeRequests--;

  if (req.url === '/chat/completions') {
    if (rejectSummaryJson && body?.response_format?.type === 'json_object') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'unsupported_response_format', message: 'response_format unsupported' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ headline: '测试', highlights: [], topics: [], todos: [], links: [], quotes: [] }) } }] }));
    return;
  }

  if (req.url === '/responses') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: 'OK' }] }] }));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'not_found', message: 'not found' } }));
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

try {
  const { port } = server.address();
  const input = {
    provider: 'openai',
    base_url: `http://127.0.0.1:${port}`,
    api_key: 'test-key',
    model: 'test-model',
    timeout_ms: 5000,
  };

  const [first, second] = await Promise.all([
    testLlmConnectivity(input),
    testLlmConnectivity(input),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.ok(first.capabilities.some(item => item.name === 'summary_json' && item.ok), 'the required probe must exercise the JSON summary protocol');
  assert.ok(maxActiveRequests <= 2, `connectivity probes must share the global AI queue (observed ${maxActiveRequests} concurrent requests)`);

  const summaryRequest = requestBodies.find(item => item.url === '/chat/completions' && item.body?.response_format?.type === 'json_object');
  assert.ok(summaryRequest, 'the connectivity probe must send the same response_format used by real summaries');
  assert.ok(summaryRequest.body.messages.some(item => item.role === 'system'));
  assert.ok(summaryRequest.body.messages.some(item => item.role === 'user'));

  rejectSummaryJson = true;
  const incompatible = await testLlmConnectivity(input);
  assert.equal(incompatible.ok, false, 'an endpoint that rejects summary JSON must not be reported as ready merely because optional probes work');
  assert.equal(incompatible.partial_ok, true);
  assert.equal(incompatible.capabilities.find(item => item.name === 'summary_json')?.status, 400);
} finally {
  await new Promise(resolve => server.close(resolve));
}

const appSource = await fs.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const settingsSource = await fs.readFile(new URL('../src/config/settings.js', import.meta.url), 'utf8');
assert.ok(appSource.includes('let llmCapabilityResultUnsaved = false;'));
assert.ok(appSource.includes('llmCapabilityResultUnsaved = true;'));
assert.match(appSource, /return\s+llmCapabilityResultUnsaved\s*\|\|/);
assert.ok(appSource.includes('请保存 AI 设置以记录本次结果'));
assert.ok(settingsSource.includes("'summary_json'"), 'the representative capability result must survive settings normalization');

console.log('LLM connectivity summary contract tests passed');
