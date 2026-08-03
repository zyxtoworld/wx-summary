import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(ROOT, 'outputs', '.tmp', `wxdb-temp-copy-test-${process.pid}-${Date.now()}`);
const source = path.join(fixtureRoot, 'source.db');
const cancelledTarget = path.join(fixtureRoot, 'cancelled.db');
const completedTarget = path.join(fixtureRoot, 'completed.db');

await fsp.mkdir(fixtureRoot, { recursive: true });
try {
  await fsp.writeFile(source, Buffer.alloc(8 * 1024 * 1024, 0x5a));
  const { __wxdbInternals } = await import('../src/wxdb/index.js');
  const { copyDbArtifactWithSignal } = __wxdbInternals;

  const controller = new AbortController();
  const cancelledProgress = [];
  const cancelledState = { copied_bytes: 0, total_bytes: 8 * 1024 * 1024, last_report_at: 0 };
  await assert.rejects(
    copyDbArtifactWithSignal(source, cancelledTarget, {
      signal: controller.signal,
      progressState: cancelledState,
      onProgress(progress) {
        cancelledProgress.push(progress);
        if (progress.phase === 'fetch_temp_copy_progress' && progress.copied_bytes > 0 && !controller.signal.aborted) {
          controller.abort(new Error('fixture copy cancelled'));
        }
      },
    }),
    /fixture copy cancelled/,
    'cancelling after the first copied chunk must stop the temporary DB copy',
  );
  await assert.rejects(fsp.stat(cancelledTarget), error => error?.code === 'ENOENT', 'cancelled temporary DB copies must remove their partial target');
  assert.ok(cancelledProgress.some(progress => progress.copied_bytes > 0), 'temporary DB copies must report real byte progress before cancellation');

  const completedProgress = [];
  const completedState = { copied_bytes: 0, total_bytes: 8 * 1024 * 1024, last_report_at: 0 };
  await copyDbArtifactWithSignal(source, completedTarget, {
    progressState: completedState,
    onProgress: progress => completedProgress.push(progress),
  });
  const completedStat = await fsp.stat(completedTarget);
  assert.equal(completedStat.size, completedState.total_bytes, 'successful temporary DB copies must publish the complete file');
  assert.equal(completedState.copied_bytes, completedState.total_bytes, 'successful temporary DB copy byte accounting must end at the exact source size');
  const copiedByteSamples = completedProgress.map(progress => Number(progress.copied_bytes || 0));
  assert.ok(copiedByteSamples.length >= 2, 'successful temporary DB copies must report initial and terminal byte progress');
  assert.ok(copiedByteSamples.every((value, index) => index === 0 || value >= copiedByteSamples[index - 1]), 'temporary DB copy progress must be monotonic');
  assert.equal(copiedByteSamples.at(-1), completedState.total_bytes, 'the final temporary DB copy progress event must report 100% of bytes');
} finally {
  await fsp.rm(fixtureRoot, { recursive: true, force: true });
}

console.log('wxdb temporary copy cancellation tests passed');
