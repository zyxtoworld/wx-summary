import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const acceptanceDataDir = `outputs/.tmp/wxdb-mirror-queue-timeout-${process.pid}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = acceptanceDataDir;
process.env.WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR = `${acceptanceDataDir}/runtime-tmp/wxdb`;

const { DATA_DIR } = await import('../src/lib/paths.js');
const { __discoveryInternals } = await import('../src/wxenv/discovery.js');

let releaseFirstLock = null;
let firstLock = null;

try {
  let notifyFirstLockStarted;
  const firstLockStarted = new Promise(resolve => { notifyFirstLockStarted = resolve; });
  const firstLockGate = new Promise(resolve => { releaseFirstLock = resolve; });
  firstLock = __discoveryInternals.runWithWxDbMirrorLock('queue-timeout-owner', async () => {
    notifyFirstLockStarted();
    await firstLockGate;
  });
  await firstLockStarted;

  let timedOutActionRan = false;
  const timeoutGuard = new AbortController();
  const timeoutGuardTimer = setTimeout(() => {
    timeoutGuard.abort(Object.assign(new Error('queue timeout test guard expired'), {
      name: 'AbortError',
      status: 499,
    }));
  }, 750);
  const startedAt = Date.now();
  try {
    await assert.rejects(
      __discoveryInternals.runWithWxDbMirrorLock('queue-timeout-owner', async () => {
        timedOutActionRan = true;
      }, {
        deadlineAt: Date.now() + 50,
        signal: timeoutGuard.signal,
      }),
      error => error?.status === 503
        && error?.code === 'wxdb_mirror_process_lock_timeout'
        && error?.public_code === 'wxdb_mirror_process_lock_timeout',
      'a same-account in-process FIFO wait must consume the same deadline as cross-process lock acquisition',
    );
  } finally {
    clearTimeout(timeoutGuardTimer);
  }
  const elapsedMs = Date.now() - startedAt;
  assert.equal(timedOutActionRan, false, 'an expired queued mirror action must never enter its critical section');
  assert.ok(elapsedMs >= 20 && elapsedMs < 500, `the queued mirror action should stop near its lock deadline, observed ${elapsedMs}ms`);

  releaseFirstLock();
  releaseFirstLock = null;
  await firstLock;
  firstLock = null;

  let recoveryActionRan = false;
  await __discoveryInternals.runWithWxDbMirrorLock('queue-timeout-owner', async () => {
    recoveryActionRan = true;
  }, { signal: AbortSignal.timeout(750) });
  assert.equal(recoveryActionRan, true, 'removing a timed-out waiter must leave the same account mirror queue usable');

  let notifyLongActionStarted;
  let releaseLongAction;
  const longActionStarted = new Promise(resolve => { notifyLongActionStarted = resolve; });
  const longActionGate = new Promise(resolve => { releaseLongAction = resolve; });
  const longActionDeadlineAt = Date.now() + 500;
  let longActionCompleted = false;
  const longAction = __discoveryInternals.runWithWxDbMirrorLock('queue-timeout-long-action', async () => {
    notifyLongActionStarted();
    await longActionGate;
    longActionCompleted = true;
  }, { deadlineAt: longActionDeadlineAt });
  await longActionStarted;
  await new Promise(resolve => setTimeout(resolve, Math.max(1, longActionDeadlineAt - Date.now() + 20)));
  releaseLongAction();
  await longAction;
  assert.equal(longActionCompleted, true, 'the lock acquisition deadline must not terminate work after its critical section has started');
} finally {
  releaseFirstLock?.();
  await firstLock?.catch(() => {});
  await fsp.rm(DATA_DIR, { recursive: true, force: true });
}

console.log('wxdb mirror queue timeout tests passed');
