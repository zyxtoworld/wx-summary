import assert from 'node:assert/strict';
import { __llmInternals } from '../src/summarizer/llm.js';

const progress = [];
const budget = __llmInternals.createAiCallBudget(2);
assert.deepEqual(__llmInternals.consumeAiCallBudget(budget, {
  mode: 'full',
  onProgress: event => progress.push(event),
}), { used: 1, limit: 2, remaining: 1 });
assert.deepEqual(__llmInternals.consumeAiCallBudget(budget, {
  mode: 'chunk 1/2',
  onProgress: event => progress.push(event),
}), { used: 2, limit: 2, remaining: 0 });

assert.equal(progress.length, 2, 'every provider request should expose its real call count');
assert.equal(progress[1].phase, 'ai_request_budget');
assert.match(progress[1].detail, /第 2\/2 次服务商请求/);

assert.throws(
  () => __llmInternals.consumeAiCallBudget(budget, { mode: 'merge' }),
  error => error?.code === 'ai_call_budget_exceeded'
    && error?.public_code === 'ai_call_budget_exceeded'
    && error?.ai_call_budget?.used === 2
    && error?.ai_call_budget?.limit === 2,
  'one group must stop before exceeding its shared provider-call budget',
);

const defaultBudget = __llmInternals.createAiCallBudget();
assert.equal(defaultBudget.limit, 24, 'the default per-group provider-call ceiling must remain explicit and bounded');

console.log('LLM call-budget tests passed');
