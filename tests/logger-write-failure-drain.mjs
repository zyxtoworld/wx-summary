import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { TMP_DIR, toProjectRelative } from '../src/lib/paths.js';
import {
  configureLogger,
  logInfo,
  readLogFileTail,
  waitForLoggerWritesToSettle,
} from '../src/lib/logger.js';

const root = path.join(TMP_DIR, `logger-write-failure-${process.pid}-${crypto.randomUUID()}`);
const invalidLogTarget = path.join(root, 'log-target-is-a-directory');
const recoveredLogTarget = path.join(root, 'recovered.log');
const uncaught = [];
const unhandled = [];
const onUncaughtException = error => { uncaught.push(error); };
const onUnhandledRejection = error => { unhandled.push(error); };

process.on('uncaughtException', onUncaughtException);
process.on('unhandledRejection', onUnhandledRejection);

try {
  await fsp.mkdir(root, { recursive: true });
  configureLogger({ file: `./${toProjectRelative(invalidLogTarget)}`, level: 'info', max_mb: 1 });
  assert.equal(
    await waitForLoggerWritesToSettle(2_000),
    true,
    'missing legacy logs should complete initialization before the write-failure fixture starts',
  );
  await fsp.mkdir(invalidLogTarget);
  logInfo('logger_write_failure_probe', { ok: true });
  configureLogger({ file: `./${toProjectRelative(recoveredLogTarget)}`, level: 'info', max_mb: 1 });
  logInfo('logger_write_recovery_probe', { ok: true });

  assert.equal(
    await waitForLoggerWritesToSettle(2_000),
    false,
    'logger drain must retain an older producer failure after newer producers replace the queue pointer',
  );
  assert.ok(
    (await readLogFileTail(recoveredLogTarget, 10)).some(line => line.includes('logger_write_recovery_probe')),
    'a failed producer must not prevent later queued producers from running',
  );
  assert.equal(
    await waitForLoggerWritesToSettle(2_000),
    true,
    'once a settled failure has been reported, a later empty drain must reflect the recovered queue state',
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(uncaught, [], 'a failed log write must not escape as uncaughtException');
  assert.deepEqual(unhandled, [], 'a failed log write must not escape as unhandledRejection');
} finally {
  process.removeListener('uncaughtException', onUncaughtException);
  process.removeListener('unhandledRejection', onUnhandledRejection);
  await fsp.rm(root, { recursive: true, force: true });
}

console.log('logger write-failure drain tests passed');
