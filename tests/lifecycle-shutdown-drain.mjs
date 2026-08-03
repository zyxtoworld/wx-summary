import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

const runId = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = `outputs/.tmp/lifecycle-shutdown-drain-${runId}`;

const paths = await import('../src/lib/paths.js');
const output = await import('../src/renderer/output.js');
const logger = await import('../src/lib/logger.js');

try {
  assert.equal(typeof output.waitForHistoryWorkToSettle, 'function', 'history shutdown drain must include recovery and discovery producers');
  assert.equal(typeof logger.waitForLoggerWritesToSettle, 'function', 'logger must expose a bounded shutdown drain');

  let recoverySettled = false;
  const recovery = output.schedulePendingHistoryRecovery({
    output: { dir: './outputs/.tmp/not-a-history-output' },
  }, {
    reason: 'shutdown_drain_test',
    delayMs: 80,
  }).then(
    () => { recoverySettled = true; },
    () => { recoverySettled = true; },
  );

  const startedAt = Date.now();
  await output.waitForHistoryWorkToSettle();
  const elapsedMs = Date.now() - startedAt;
  assert.equal(recoverySettled, true, 'history shutdown drain must wait for delayed recovery producers before returning');
  assert.ok(elapsedMs >= 50, `history shutdown drain returned before the delayed producer ran (${elapsedMs}ms)`);
  await recovery;

  const logFile = path.join(paths.TMP_DIR, 'shutdown-drain.log');
  logger.configureLogger({ file: logFile, level: 'info', max_mb: 1 });
  logger.logInfo('shutdown_drain_probe', { ok: true });
  assert.equal(await logger.waitForLoggerWritesToSettle(2_000), true, 'logger shutdown drain should settle within its bound');
  const lines = await logger.readLogFileTail(logFile, 10);
  assert.ok(lines.some(line => line.includes('shutdown_drain_probe')), 'logger drain must make the final queued record readable before returning');
} finally {
  await fsp.rm(paths.DATA_DIR, { recursive: true, force: true }).catch(() => {});
}

console.log('lifecycle shutdown drain tests passed');
