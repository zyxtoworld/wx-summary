import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { __llmInternals } from '../src/summarizer/llm.js';

const source = await fs.readFile(new URL('../src/summarizer/llm.js', import.meta.url), 'utf8');
assert.ok(source.includes('if (!isLikelyRecoverableChunkFailure(firstError)) throw firstError;'), 'only a safely chunkable full-model failure should enter bounded chunk recovery');
assert.equal(__llmInternals.isLikelyRecoverableChunkFailure(new Error('Model returned empty content')), false, 'empty output must fail after the bounded same-request fallback instead of recursively multiplying calls');
assert.equal(__llmInternals.isLikelyRecoverableChunkFailure(new SyntaxError('Unexpected token in JSON')), false, 'invalid JSON must use its dedicated repair path and must not recursively multiply calls');
assert.equal(__llmInternals.isLikelyRecoverableChunkFailure(Object.assign(new Error('context length exceeded'), { status: 413 })), true, 'explicit oversized input remains eligible for bounded chunking');

const callStart = source.indexOf('async function callJsonModel(');
const callEnd = source.indexOf('\nasync function repairJsonModelText(', callStart);
assert.ok(callStart >= 0 && callEnd > callStart, 'callJsonModel source must be inspectable');
const callSource = source.slice(callStart, callEnd);
const emptyStopAt = callSource.indexOf('if (isModelEmptyContentError(e)) {');
const transientRetryAt = callSource.indexOf('if (!isTransientError(e)) break;');
assert.ok(emptyStopAt >= 0 && transientRetryAt > emptyStopAt, 'an empty model response must stop identical retries before generic transient retry handling');
assert.ok(callSource.slice(emptyStopAt, transientRetryAt).includes('break;'), 'empty response handling must stop the identical request loop');

console.log('LLM empty-response fallback tests passed');
