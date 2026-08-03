import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_NO_RUNTIME_FILE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = `outputs/.tmp/trusted-command-test-${process.pid}`;

const { __mainInternals } = await import('../src/main.js');

const attackerDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wx-summary-path-'));
const attackerCommand = path.join(attackerDir, process.platform === 'win32' ? 'xdg-open.cmd' : 'xdg-open');
const priorPath = process.env.PATH;
try {
  await fsp.writeFile(attackerCommand, process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n', 'utf8');
  if (process.platform !== 'win32') await fsp.chmod(attackerCommand, 0o755);
  process.env.PATH = attackerDir;

  const candidates = __mainInternals.trustedPosixSystemCommandCandidates('xdg-open', 'linux');
  assert.deepEqual(candidates, ['/usr/bin/xdg-open', '/bin/xdg-open']);
  assert.deepEqual(__mainInternals.trustedPosixSystemCommandCandidates('../xdg-open', 'linux'), []);
  assert.deepEqual(__mainInternals.trustedPosixSystemCommandCandidates('unknown-opener', 'linux'), []);

  const resolved = await __mainInternals.resolveTrustedSystemCommandPath('xdg-open', { platform: 'linux' });
  assert.notEqual(path.resolve(resolved || ''), path.resolve(attackerCommand), 'service PATH must not select an attacker-controlled opener');
} finally {
  if (priorPath === undefined) delete process.env.PATH;
  else process.env.PATH = priorPath;
  await fsp.rm(attackerDir, { recursive: true, force: true });
}

await assert.rejects(
  __mainInternals.launchDetachedOpener(
    process.execPath,
    ['-e', "process.stderr.write('actionable opener failure'); process.exit(7)"],
  ),
  error => error?.code === 'opener_exited_early' && /actionable opener failure/.test(error.message),
  'an opener that exits early should preserve a bounded, sanitized stderr detail',
);

console.log('trusted local command path tests passed');
