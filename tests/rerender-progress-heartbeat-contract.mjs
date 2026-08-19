import assert from 'node:assert/strict';
import { createRenderProgressTracker } from '../src/web/public/js/pages/digest/progress-state.js';

let nowMs = 5_000;
const messages = [];
const tracker = createRenderProgressTracker({
  label: '正在重渲染预览',
  now: () => nowMs,
  intervalMs: 50,
  onUpdate: message => messages.push(message),
});
tracker.start();
assert.match(messages.at(-1), /正在重渲染预览…0 秒/);
nowMs += 1_200;
assert.match(messages.at(-1), /0 秒|1 秒/);
const elapsed = tracker.stop();
assert.equal(elapsed, 1_200);
assert.equal(tracker.isRunning(), false, 'completion/cancellation must stop the matching elapsed ticker');

console.log('rerender progress heartbeat contract passed');
