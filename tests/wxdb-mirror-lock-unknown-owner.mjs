import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

const acceptanceDataDir = `outputs/.tmp/wxdb-mirror-lock-${process.pid}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = acceptanceDataDir;
process.env.WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR = `${acceptanceDataDir}/runtime-tmp/wxdb`;

const { DATA_DIR } = await import('../src/lib/paths.js');
const { __discoveryInternals, processStartIdentity } = await import('../src/wxenv/discovery.js');
const lockFile = path.join(DATA_DIR, '.wxdb-mirror.lock');

try {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(lockFile, JSON.stringify({
    pid: process.pid,
    token: 'unknown-owner-contract',
    acquired_at: Date.now() - 60_000,
  }), { encoding: 'utf8', mode: 0o600 });
  const staleAt = new Date(Date.now() - 60_000);
  await fsp.utimes(lockFile, staleAt, staleAt);

  const startedAt = Date.now();
  await assert.rejects(
    __discoveryInternals.acquireWxDbMirrorProcessLock({ signal: AbortSignal.timeout(5_000) }),
    error => error?.status === 423
      && error?.code === 'wxdb_mirror_process_lock_owner_unknown'
      && error?.public_code === 'wxdb_mirror_process_lock_owner_unknown',
    'a stale lock with an unprovable live owner must fail fast with an actionable locked response',
  );
  assert.ok(Date.now() - startedAt < 4_500, 'unknown-owner detection must not consume the ten-minute lock wait budget');
  assert.equal(await fsp.stat(lockFile).then(stat => stat.isFile(), () => false), true, 'an unknown-owner lock must be preserved instead of being reclaimed unsafely');

  const selfStartId = await processStartIdentity(process.pid);
  if (selfStartId) {
    await fsp.writeFile(lockFile, JSON.stringify({
      pid: process.pid,
      process_start_id: selfStartId,
      token: 'unresponsive-owner-contract',
      acquired_at: Date.now() - 60_000,
    }), 'utf8');
    await fsp.utimes(lockFile, staleAt, staleAt);
    await assert.rejects(
      __discoveryInternals.acquireWxDbMirrorProcessLock({ signal: AbortSignal.timeout(5_000) }),
      error => error?.status === 423 && error?.code === 'wxdb_mirror_process_lock_owner_unresponsive',
      'a proven live owner with an expired heartbeat must fail fast without being reclaimed',
    );
    assert.equal(await fsp.stat(lockFile).then(stat => stat.isFile(), () => false), true, 'an unresponsive live-owner lock must remain intact');
  }

  await fsp.writeFile(lockFile, JSON.stringify({
    pid: 2_147_483_647,
    token: 'legacy-dead-owner-contract',
    acquired_at: Date.now() - 60_000,
  }), 'utf8');
  await fsp.utimes(lockFile, staleAt, staleAt);
  const legacyRelease = await __discoveryInternals.acquireWxDbMirrorProcessLock({ signal: AbortSignal.timeout(5_000) });
  assert.equal(typeof legacyRelease, 'function', 'a legacy stale lock without process_start_id should be reclaimed only when its PID is provably dead');
  await legacyRelease();

  await fsp.writeFile(lockFile, JSON.stringify({
    acquired_at: Date.now() - 60_000,
  }), 'utf8');
  await fsp.utimes(lockFile, staleAt, staleAt);
  await assert.rejects(
    __discoveryInternals.acquireWxDbMirrorProcessLock({ signal: AbortSignal.timeout(5_000) }),
    error => error?.status === 423
      && error?.code === 'wxdb_mirror_process_lock_owner_incomplete'
      && /\.wxdb-mirror\.lock/.test(String(error?.message || ''))
      && !/重启本程序/.test(String(error?.message || '')),
    'a malformed lock without a trustworthy PID and token must stay blocked with a recovery path that does not falsely promise restart will fix it',
  );

  await fsp.writeFile(lockFile, JSON.stringify({
    pid: 2_147_483_647,
    process_start_id: 'dead-owner-contract',
    token: 'dead-owner-contract',
    acquired_at: Date.now() - 60_000,
  }), 'utf8');
  await fsp.utimes(lockFile, staleAt, staleAt);
  const release = await __discoveryInternals.acquireWxDbMirrorProcessLock({ signal: AbortSignal.timeout(5_000) });
  assert.equal(typeof release, 'function', 'a stale lock from a provably dead owner must be reclaimed');
  await release();
  assert.equal(await fsp.stat(lockFile).then(() => true, () => false), false, 'releasing the replacement lease must remove only its own lock');
} finally {
  await fsp.rm(DATA_DIR, { recursive: true, force: true });
}

console.log('wxdb mirror unknown-owner lock tests passed');
