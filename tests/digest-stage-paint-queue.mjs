import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSerializedStagePaintQueue, digestServerWaitPulseShouldYield } from '../src/web/public/js/digest-stage-paint-queue.js';

const appSource = fs.readFileSync(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
assert.ok(appSource.includes("import { createSerializedStagePaintQueue, digestServerWaitPulseShouldYield } from './digest-stage-paint-queue.js';")
  && appSource.includes('return createSerializedStagePaintQueue({')
  && !appSource.includes('let latestDirectStage = Promise.resolve()'),
  'the digest UI must use the serialized queue instead of a direct same-stage bypass');

assert.equal(digestServerWaitPulseShouldYield({ phase: 'llm_retry_wait' }), true,
  'provider Retry-After waits should keep their explicit status instead of being overwritten by a generic model heartbeat');
assert.equal(digestServerWaitPulseShouldYield({ phase: 'fetch_mirror_batch_recovery_wait' }), true,
  'explicit local-data recovery waits should keep their reason and elapsed time visible');
assert.equal(digestServerWaitPulseShouldYield({ phase: 'llm_wait' }), false,
  'the generic fallback model wait phase must still allow a liveness pulse');
assert.equal(digestServerWaitPulseShouldYield({ phase: 'fetch_wait' }), false,
  'the generic fallback fetch wait phase must still allow a liveness pulse');
assert.equal(digestServerWaitPulseShouldYield({ phase: 'llm_request' }), true,
  'a concrete model request should keep its truthful phase while the UI elapsed timer supplies liveness');
assert.equal(digestServerWaitPulseShouldYield({ phase: 'fetch_db_scan' }), true,
  'a concrete local-data phase should not be replaced by a generic server heartbeat');

let releaseFirst;
const firstGate = new Promise(resolve => { releaseFirst = resolve; });
const delivered = [];
const reported = [];
const queue = createSerializedStagePaintQueue({
  barrierKeyForStage: stage => stage.major || '',
  waitForPreviousBarrier: async () => true,
  waitForPaint: async () => {},
  reportError: error => reported.push(error.message),
  onStage: async stage => {
    if (stage.id === 'fetch-start') await firstGate;
    delivered.push(stage.id);
    if (stage.id === 'broken-detail') throw new Error('paint failed');
  },
});

await queue.enqueue({ id: 'fetch-start', major: 'fetching' });
await queue.enqueue({ id: 'fetch-rows', major: 'fetching' });
await queue.enqueue({ id: 'broken-detail', major: 'fetching' });
await queue.enqueue({ id: 'summarize-start', major: 'summarizing' });
await Promise.resolve();
assert.deepEqual(delivered, [], 'later details must not bypass an earlier stage whose paint is still pending');

releaseFirst();
await queue.flush();
assert.deepEqual(delivered, ['fetch-start', 'fetch-rows', 'broken-detail', 'summarize-start']);
assert.deepEqual(reported, ['paint failed'], 'paint failures should be reported without stopping later progress');

console.log('digest stage paint queue tests passed');
