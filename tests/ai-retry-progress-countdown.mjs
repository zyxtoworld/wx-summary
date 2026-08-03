import assert from 'node:assert/strict';
import fs from 'node:fs';
import { __llmInternals } from '../src/summarizer/llm.js';

const retry = __llmInternals.aiRetryWaitDetail(
  { status: 502, retry_after_ms: 60_000 },
  0,
  3,
  { nowMs: 1_000 },
);

assert.equal(retry.waitMs, 60_000);
assert.equal(retry.retryAtMs, 61_000, 'retry progress should expose an absolute deadline for a live countdown');
assert.equal(retry.nextAttempt, 2);
assert.equal(retry.maxAttempts, 3);
assert.equal(retry.reason, 'AI 端点暂时不可用（HTTP 502）');

const longProviderCooldown = __llmInternals.aiRetryWaitDetail(
  { status: 429, retry_after_ms: 300_000 },
  0,
  3,
  { nowMs: 10_000, maxWaitMs: 60_000 },
);
assert.equal(longProviderCooldown.waitMs, 0, 'a provider cooldown longer than the automatic wait budget must not be truncated into an early retry');
assert.equal(longProviderCooldown.requestedWaitMs, 300_000);
assert.equal(longProviderCooldown.retryAtMs, 310_000, 'terminal diagnostics should preserve the provider cooldown deadline');
assert.equal(longProviderCooldown.capped, true);
assert.match(longProviderCooldown.detail, /要求等待 5 分钟/);
assert.match(longProviderCooldown.detail, /未继续请求/);
assert.doesNotMatch(longProviderCooldown.detail, /60 秒后开始/);

const deadlineSignal = { wx_summary_deadline_at_ms: 40_000 };
const deadlineLimitedCooldown = __llmInternals.aiRetryWaitDetail(
  { status: 503, retry_after_ms: 45_000 },
  0,
  3,
  { nowMs: 5_000, signal: deadlineSignal, maxWaitMs: 60_000 },
);
assert.equal(deadlineLimitedCooldown.waitMs, 0, 'a provider cooldown that cannot finish before the request deadline must not cause a partial wait and early retry');
assert.equal(deadlineLimitedCooldown.retryAtMs, 50_000);

const llmSource = fs.readFileSync(new URL('../src/summarizer/llm.js', import.meta.url), 'utf8');
const mainSource = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');

assert.ok(
  llmSource.includes('retry_at_ms: retry.retryAtMs')
    && llmSource.includes('retry_attempt: retry.nextAttempt')
    && llmSource.includes('retry_max_attempts: retry.maxAttempts')
    && llmSource.includes('retry_reason: retry.reason'),
  'the summarizer should attach structured retry timing to the progress event',
);
assert.ok(
  mainSource.includes('retry_at_ms: progress.retry_at_ms')
    && mainSource.includes('retry_attempt: progress.retry_attempt')
    && mainSource.includes('retry_max_attempts: progress.retry_max_attempts')
    && mainSource.includes('retry_reason: progress.retry_reason'),
  'SSE progress and heartbeat should preserve retry timing instead of flattening it into static text',
);
assert.ok(
  appSource.includes('function digestProgressAiRetryWaitDetail(stage = {}, nowMs = Date.now())')
    && appSource.includes("Object.hasOwn(stage, 'retry_wait_ms')")
    && appSource.includes('Number(stage.retry_wait_ms || 0) <= 0')
    && appSource.includes("stage.detail || '自动重试等待预算不足，未继续请求'")
    && appSource.includes('`${seconds} 秒后开始第 ${attempt}/${maxAttempts} 次请求`')
    && appSource.includes("if (phase === 'llm_retry_wait')"),
  'the browser should repaint a second-level retry countdown from the absolute deadline',
);
assert.ok(
  appSource.includes('function syncDigestOutputRunningStatus(snapshot = {})')
    && appSource.includes('syncDigestOutputRunningStatus(snapshot);'),
  'the text/image output status should repaint from the same running-stage clock as the main progress card',
);
assert.equal(
  appSource.includes('服务商建议 ${retryText} 后重试'),
  false,
  'terminal AI failure text must not insert a space between the duration and 后',
);

console.log('AI retry progress countdown tests passed');
