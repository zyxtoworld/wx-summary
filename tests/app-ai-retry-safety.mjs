import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function digestAiDirectRetryAllowed(');
const end = source.indexOf('\nfunction setProgressAiRecovery(', start);
assert.ok(start >= 0 && end > start, 'AI retry-safety helpers must remain independently testable');

const sandbox = { String, Array };
vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.__direct = digestAiDirectRetryAllowed;\nglobalThis.__confirm = digestAiRetryNeedsConfirmation;`, sandbox, { timeout: 1000 });

for (const code of ['ai_timeout', 'ai_network_failed', 'ai_empty_output', 'ai_json_parse_failed', 'ai_quality_failed']) {
  assert.equal(sandbox.__direct({ code }), true, `${code} should offer a direct retry`);
}

for (const code of ['ai_input_too_large', 'ai_request_invalid', 'ai_auth_failed', 'ai_content_filtered', 'ai_group_generation_in_progress']) {
  assert.equal(sandbox.__direct({ code }), false, `${code} should require corrective action instead of a blind retry`);
}

assert.ok(source.includes("if (code === 'ai_group_generation_in_progress') return 'in_progress';"), 'a duplicate same-group request must be presented as existing work, not as a provider/settings failure');
assert.ok(source.includes('本次没有再次请求 AI'), 'the progress card must say that the duplicate request was stopped before another provider call');

assert.equal(sandbox.__confirm({
  ai_diagnostics: { provider_response_unknown: true },
}), true, 'an unknown provider response must require confirmation before retry');

assert.equal(sandbox.__confirm({}, [{
  meta: { ai_diagnostics: { request_outcome: 'ambiguous' } },
}]), true, 'one ambiguous failed group must protect a batch retry');

assert.equal(sandbox.__confirm({
  ai_diagnostics: { request_outcome: 'definitely_not_sent' },
}), false, 'a request known not to have been sent should retry without a billing warning');

console.log('app AI retry-safety tests passed');
