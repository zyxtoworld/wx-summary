import assert from 'node:assert/strict';
import http from 'node:http';
import { summarizeDigest } from '../src/summarizer/llm.js';

const requests = [];
const progress = [];
const publishableDigest = {
  headline: '群里集中讨论了工具选择和后续发布安排',
  highlights: [
    '大家比较了两种工具在实际使用中的差异',
    '群友补充了发布前需要核对的几个信息点',
    '本轮讨论形成了可继续参考的经验汇总',
  ],
  topics: [{
    title: '工具选择与发布安排',
    category: '经验交流',
    participants: ['小张', '小李'],
    summary: '大家结合实际使用情况比较了工具差异，并交流了发布前需要核对的信息。',
    need_followup: false,
  }],
  todos: [],
  links: [],
  quotes: [],
};

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const content = body.messages?.[1]?.content;
  const text = Array.isArray(content)
    ? content.map(part => part?.text || '').join('\n')
    : String(content || '');
  const mode = text.match(/任务模式：([^\n]+)/)?.[1]?.trim() || '';
  requests.push({ mode, textChars: text.length });

  if (mode === 'final/full') {
    res.writeHead(413, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'request body exceeds the gateway limit' } }));
    return;
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(publishableDigest) } }],
  }));
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

try {
  const { port } = server.address();
  const digest = await summarizeDigest({
    settings: {
      llm: {
        provider: 'openai',
        base_url: `http://127.0.0.1:${port}`,
        api_key: 'test-key',
        model: 'test-model',
        long_context_model: 'test-model',
        temperature: 0,
        timeout_ms: 10_000,
        max_input_chars: 1_000,
        max_messages_per_call: 2,
        ai_concurrency: 1,
      },
      privacy: {},
      link_preview: { enabled: false },
    },
    groupName: '测试群',
    since: '2026-08-02 00:00:00',
    until: '2026-08-03 06:00:00',
    messages: Array.from({ length: 6 }, (_, index) => ({
      time: `2026-08-02 09:0${index}`,
      sender: index % 2 ? '小李' : '小张',
      type: 'text',
      content: `第 ${index + 1} 条工具讨论：${'具体使用差异和发布注意事项。'.repeat(18)}`,
    })),
    onProgress: event => progress.push(event),
  });

  assert.equal(digest.headline, publishableDigest.headline);
  assert.ok(
    progress.some(event => event?.phase === 'llm_prechunk' && /直接分为 \d+ 段/.test(String(event?.detail || ''))),
    'the progress stream should explain proactive chunking before provider requests begin',
  );
  assert.ok(requests.some(request => request.mode.startsWith('chunk ')), 'an oversized timeline should start with bounded chunk requests');
  assert.ok(requests.some(request => request.mode === 'merge'), 'proactive chunks should still be merged into one digest');
  assert.equal(
    requests.some(request => request.mode === 'final/full'),
    false,
    'a timeline already over the configured text or message limit must not waste a known-oversized full request first',
  );
} finally {
  await new Promise(resolve => server.close(resolve));
}

console.log('LLM proactive chunking tests passed');
