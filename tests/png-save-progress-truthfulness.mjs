import assert from 'node:assert/strict';
import {
  createRenderProgressTracker,
  formatElapsedProgress,
  saveProgressMessage,
} from '../src/web/public/js/pages/digest/progress-state.js';

assert.equal(formatElapsedProgress(0), '0 秒');
assert.equal(formatElapsedProgress(61_000), '1 分 01 秒');
assert.equal(saveProgressMessage('saving'), '正在保存 PNG…');
assert.equal(saveProgressMessage('confirmed'), 'PNG 已保存并完成历史记录提交。');
assert.match(saveProgressMessage('warning'), /历史记录复核/);
assert.match(saveProgressMessage('unknown'), /结果未知/);

let nowMs = 1_000;
const updates = [];
const tracker = createRenderProgressTracker({
  now: () => nowMs,
  intervalMs: 10_000,
  onUpdate: text => updates.push(text),
});
tracker.start();
assert.equal(tracker.isRunning(), true);
assert.match(updates.at(-1), /正在渲染长图…0 秒/);
nowMs += 2_500;
// The public stop result is the authoritative elapsed time; no artificial wait is inserted after a render response.
assert.equal(tracker.stop(), 2_500);
assert.equal(tracker.isRunning(), false);
assert.equal(tracker.stop(), 0);

console.log('PNG save progress truthfulness tests passed');
