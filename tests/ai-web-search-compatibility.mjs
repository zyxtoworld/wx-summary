import assert from 'node:assert/strict';
import { __llmInternals, testLlmConnectivity } from '../src/summarizer/llm.js';

const originalFetch = globalThis.fetch;
const calls = [];

globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  assert.equal(target, 'https://chatgpt2api.example/v1/responses');
  const body = JSON.parse(String(options.body || '{}'));
  const toolType = body.tools?.[0]?.type || '';
  calls.push(toolType);
  if (toolType === 'web_search') {
    return new Response(JSON.stringify({ error: { message: 'unsupported tool web_search_preview' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (toolType === 'web_search_preview') {
    const outputText = body.input?.includes('链接研究助手')
      ? JSON.stringify({
          results: [{
            url: 'https://example.com/',
            status: 'verified',
            title: 'Example Domain',
            summary: '示例页面',
            evidence: ['页面可访问'],
            sources: ['https://docs.example.org/example'],
          }],
        })
      : '网页搜索能力可用';
    return new Response(JSON.stringify({ output_text: outputText }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ error: { message: 'missing web search tool' } }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
};

try {
  const result = await testLlmConnectivity({
    provider: 'openai',
    base_url: 'https://chatgpt2api.example/v1',
    api_key: 'test-key',
    model: 'gpt-5-search-api',
    timeout_ms: 10_000,
    capabilities: ['responses_web_search'],
  });
  const capability = result.capabilities.find(item => item.name === 'responses_web_search');
  assert.equal(capability?.ok, true, 'web search capability should pass when either supported tool name succeeds');
  assert.equal(capability?.tool_type, 'web_search_preview', 'capability result should retain the working tool name');
  assert.deepEqual(calls, ['web_search', 'web_search_preview'], 'compatibility probe should try the alternate tool name only after an unsupported-tool response');

  __llmInternals.clearAiWebSearchRuntimeSupportCache();
  assert.equal(
    __llmInternals.shouldUseAiLinkResearch(
      ['https://example.com/'],
      {
        llm: {
          provider: 'openai',
          base_url: 'https://chatgpt2api.example/v1',
          api_key: 'test-key',
          model: 'gpt-5-search-api',
          capabilities: {
            provider: 'openai',
            base_url: 'https://chatgpt2api.example/v1',
            model: 'gpt-5-search-api',
            responses_web_search: { ok: false },
          },
        },
      },
      { ai_web_search: true },
    ),
    true,
    'an old capability snapshot without a tool name must be re-probed instead of permanently disabling AI link research',
  );

  calls.length = 0;
  const settings = {
    llm: {
      provider: 'openai',
      base_url: 'https://chatgpt2api.example/v1',
      api_key: 'test-key',
      model: 'gpt-5-search-api',
      timeout_ms: 10_000,
      ai_concurrency: 1,
    },
  };
  const research = await __llmInternals.fetchAiLinkResearchBatch(['https://example.com/'], settings);
  assert.equal(research.get('https://example.com/')?.summary, '示例页面', 'link research should parse the response after tool-name fallback');
  assert.deepEqual(research.get('https://example.com/')?.sources, ['https://docs.example.org/example'], 'link research should retain a valid external evidence source when the result URL matches the requested link');
  assert.deepEqual(calls, ['web_search', 'web_search_preview'], 'link research should retry only the alternate tool name');
  assert.deepEqual(
    __llmInternals.aiWebSearchToolCandidates(settings),
    ['web_search_preview', 'web_search'],
    'successful link research should remember the working tool name for the next batch',
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log('AI web search compatibility tests passed');
