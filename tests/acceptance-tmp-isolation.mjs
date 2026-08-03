import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const runId = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = `outputs/.tmp/acceptance-tmp-isolation-${runId}`;
delete process.env.WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR;

const { DATA_DIR, OUTPUTS_DIR, OUTPUTS_TMP_DIR, TMP_DIR, WXDB_TMP_DIR, isInside, outputDirFromSettings } = await import('../src/lib/paths.js');
const { clearTmpDir } = await import('../src/config/settings.js');

const sharedTmp = OUTPUTS_TMP_DIR;
const sharedSentinel = path.join(sharedTmp, `acceptance-tmp-isolation-sentinel-${runId}.txt`);

try {
  assert.notEqual(path.resolve(TMP_DIR), path.resolve(sharedTmp), 'acceptance mode must never reuse the running service temp root');
  assert.ok(isInside(sharedTmp, TMP_DIR), 'acceptance temp root must stay inside outputs/.tmp');
  assert.ok(isInside(DATA_DIR, TMP_DIR), 'acceptance runtime temp root must be scoped to the acceptance data directory');
  assert.ok(isInside(TMP_DIR, WXDB_TMP_DIR), 'acceptance wxdb temp root must be scoped to the acceptance runtime temp root');
  assert.throws(
    () => outputDirFromSettings({ output: { dir: './outputs/.tmp/not-an-output' } }),
    error => error?.code === 'PATH_INSIDE_TMP',
    'an acceptance-specific runtime tmp must not make the shared outputs/.tmp root eligible for output',
  );

  await fs.mkdir(sharedTmp, { recursive: true });
  await fs.writeFile(sharedSentinel, 'shared runtime sentinel\n', 'utf8');
  await fs.mkdir(path.join(TMP_DIR, 'owned'), { recursive: true });
  await fs.writeFile(path.join(TMP_DIR, 'owned', 'temporary.txt'), 'acceptance-only\n', 'utf8');
  await clearTmpDir();

  assert.equal(await fs.stat(sharedSentinel).then(() => true, () => false), true, 'acceptance cleanup must not delete files in the running service temp root');
  assert.equal(await fs.stat(path.join(TMP_DIR, 'owned', 'temporary.txt')).then(() => true, () => false), false, 'acceptance cleanup must still delete its own temporary files');
} finally {
  await fs.rm(sharedSentinel, { force: true }).catch(() => {});
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
}

console.log('acceptance tmp isolation tests passed');
