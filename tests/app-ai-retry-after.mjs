import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function digestAiRetryAfterMs(');
const end = source.indexOf('\nfunction setProgressAiRecovery(', start);
assert.ok(start >= 0 && end > start, 'AI retry-after helper must remain independently testable');

const sandbox = { Math, Number };
vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.__retryAfter = digestAiRetryAfterMs;`, sandbox, { timeout: 1000 });

assert.equal(sandbox.__retryAfter({
  ai_diagnostics: { retry_after_ms: 12_000 },
}), 12_000, 'the direct retry button must honor Retry-After nested in SSE AI diagnostics');

assert.equal(sandbox.__retryAfter({}, [{
  meta: { ai_diagnostics: { retry_after_ms: 45_000 } },
}]), 45_000, 'retrying failed groups must honor the longest Retry-After nested in each result');

assert.equal(sandbox.__retryAfter({
  retry_after_ms: 5_000,
  diagnostics: { retry_after_ms: 10_000 },
  ai_diagnostics: { retry_after_ms: 15_000 },
}, [{
  meta: { retry_after_ms: 20_000, ai_diagnostics: { retry_after_ms: 30_000 } },
}]), 30_000, 'the cooldown must use the longest provider wait across all diagnostic shapes');

console.log('app AI retry-after tests passed');
