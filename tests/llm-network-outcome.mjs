import assert from 'node:assert/strict';
import { __llmInternals } from '../src/summarizer/llm.js';

assert.equal(
  __llmInternals.aiNetworkRequestOutcome({ cause: { code: 'ECONNREFUSED' } }),
  'not_sent',
  'a refused connection is safe to retry because no provider accepted the request',
);
assert.equal(
  __llmInternals.aiNetworkRequestOutcome({ cause: { code: 'ENOTFOUND' } }),
  'not_sent',
  'DNS lookup failure is safe to retry because the request was not submitted',
);
assert.equal(
  __llmInternals.aiNetworkRequestOutcome({ cause: { code: 'ECONNRESET' } }),
  'ambiguous',
  'a reset connection may have failed after the provider received the body and must not auto-retry',
);
assert.equal(
  __llmInternals.aiNetworkRequestOutcome({ cause: { code: 'UND_ERR_SOCKET' } }),
  'ambiguous',
  'a generic socket failure must fail closed as an unknown provider outcome',
);
assert.equal(
  __llmInternals.aiNetworkRequestOutcome(new Error('fetch failed')),
  'ambiguous',
  'unknown transport failures must not risk duplicate provider billing',
);

console.log('LLM network outcome tests passed');
