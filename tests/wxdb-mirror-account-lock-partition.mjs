import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';

const acceptanceDataDir = `outputs/.tmp/wxdb-mirror-account-lock-partition-${process.pid}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = acceptanceDataDir;
process.env.WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR = `${acceptanceDataDir}/runtime-tmp/wxdb`;

const { DATA_DIR } = await import('../src/lib/paths.js');
const { __discoveryInternals } = await import('../src/wxenv/discovery.js');

let releaseAccountA = null;
let accountAWork = null;
let lockOwnerChild = null;
let releaseIndexLock = null;
let indexLockWork = null;

function waitForChildLine(child, expected, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => finish(new Error(`child did not report ${expected}; stderr=${stderr}`)), timeoutMs);
    const onStdout = chunk => {
      stdout += String(chunk || '');
      if (stdout.split(/\r?\n/).includes(expected)) finish();
    };
    const onStderr = chunk => { stderr += String(chunk || ''); };
    const onExit = code => finish(new Error(`child exited before ${expected}: ${code}; stderr=${stderr}`));
    function finish(error = null) {
      clearTimeout(timeout);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    }
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('exit', onExit);
  });
}

function waitForChildExit(child, timeoutMs = 2_000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('lock owner child did not exit')), timeoutMs);
    child.once('exit', code => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

try {
  let notifyAccountAStarted;
  const accountAStarted = new Promise(resolve => { notifyAccountAStarted = resolve; });
  const accountAGate = new Promise(resolve => { releaseAccountA = resolve; });
  const events = [];

  accountAWork = __discoveryInternals.runWithWxDbMirrorLock('partition-account-a', async () => {
    events.push('account-a-started');
    notifyAccountAStarted();
    await accountAGate;
    events.push('account-a-finished');
  });
  await accountAStarted;

  const sameAccountWork = __discoveryInternals.runWithWxDbMirrorLock('partition-account-a', async () => {
    events.push('same-account');
  });
  const differentAccountWork = __discoveryInternals.runWithWxDbMirrorLock('partition-account-b', async () => {
    events.push('different-account');
  });

  await Promise.race([
    differentAccountWork,
    new Promise((_, reject) => setTimeout(() => reject(new Error('different account remained blocked by account A')), 750)),
  ]);
  assert.equal(events.includes('different-account'), true, 'different account work must overlap an active account lock');
  assert.equal(events.includes('same-account'), false, 'same-account work must remain serialized');

  releaseAccountA();
  releaseAccountA = null;
  await accountAWork;
  accountAWork = null;
  await sameAccountWork;
  assert.deepEqual(events, [
    'account-a-started',
    'different-account',
    'account-a-finished',
    'same-account',
  ]);

  await assert.rejects(
    __discoveryInternals.runWithWxDbMirrorIndexWriteLock(() => (
      __discoveryInternals.runWithWxDbMirrorLock('partition-reverse-order', async () => {})
    )),
    error => error?.status === 500
      && error?.code === 'wxdb_mirror_lock_order_violation'
      && error?.public_code === 'wxdb_mirror_lock_order_violation',
    'index-to-account lock acquisition must fail closed instead of risking a deadlock',
  );

  const discoveryUrl = new URL('../src/wxenv/discovery.js', import.meta.url).href;
  const childSource = `
    const { __discoveryInternals } = await import(${JSON.stringify(discoveryUrl)});
    await __discoveryInternals.runWithWxDbMirrorLock('partition-process-account-a', async () => {
      process.stdout.write('READY\\n');
      await new Promise(resolve => process.stdin.once('data', resolve));
      process.stdin.destroy();
    });
    process.stdout.write('RELEASED\\n');
  `;
  lockOwnerChild = spawn(process.execPath, ['--input-type=module', '--eval', childSource], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  await waitForChildLine(lockOwnerChild, 'READY');

  await Promise.race([
    __discoveryInternals.runWithWxDbMirrorLock('partition-process-account-b', async () => {}),
    new Promise((_, reject) => setTimeout(() => reject(new Error('cross-process account B remained blocked by account A')), 750)),
  ]);
  await assert.rejects(
    __discoveryInternals.runWithWxDbMirrorLock('partition-process-account-a', async () => {}, {
      deadlineAt: Date.now() + 120,
    }),
    error => error?.status === 503 && error?.code === 'wxdb_mirror_process_lock_timeout',
    'the same account must remain serialized across processes',
  );
  lockOwnerChild.stdin.write('release\n');
  assert.equal(await waitForChildExit(lockOwnerChild), 0, 'the cross-process lock owner should release cleanly');
  lockOwnerChild = null;

  let notifyIndexLockStarted;
  const indexLockStarted = new Promise(resolve => { notifyIndexLockStarted = resolve; });
  const indexLockGate = new Promise(resolve => { releaseIndexLock = resolve; });
  indexLockWork = __discoveryInternals.runWithWxDbMirrorIndexWriteLock(async () => {
    notifyIndexLockStarted();
    await indexLockGate;
  });
  await indexLockStarted;

  let nestedIndexActionRan = false;
  let notifyAccountEntered;
  const accountEntered = new Promise(resolve => { notifyAccountEntered = resolve; });
  const nestedAbort = new AbortController();
  const cancelledNestedIndex = __discoveryInternals.runWithWxDbMirrorLock('partition-cancelled-index-wait', async () => {
    notifyAccountEntered();
    await __discoveryInternals.runWithWxDbMirrorIndexWriteLock(async () => {
      nestedIndexActionRan = true;
    });
  }, {
    deadlineAt: Date.now() + 2_000,
    signal: nestedAbort.signal,
  });
  await accountEntered;
  nestedAbort.abort(Object.assign(new Error('cancel nested index wait'), { name: 'AbortError', status: 499 }));
  const nestedOutcome = await Promise.race([
    cancelledNestedIndex.then(() => 'resolved', error => `rejected:${error?.status || error?.name || error?.code}`),
    new Promise(resolve => setTimeout(() => resolve('pending'), 500)),
  ]);
  assert.equal(nestedOutcome, 'rejected:499', 'a cancelled account request must stop while it waits for the shared index lock');
  assert.equal(nestedIndexActionRan, false, 'a cancelled account request must never commit its queued index callback later');

  let expiredIndexActionRan = false;
  const expiredNestedIndex = __discoveryInternals.runWithWxDbMirrorLock('partition-expired-index-wait', async () => {
    await __discoveryInternals.runWithWxDbMirrorIndexWriteLock(async () => {
      expiredIndexActionRan = true;
    });
  }, {
    deadlineAt: Date.now() + 120,
  });
  const expiredOutcome = await Promise.race([
    expiredNestedIndex.then(() => 'resolved', error => `rejected:${error?.status || error?.name || error?.code}`),
    new Promise(resolve => setTimeout(() => resolve('pending'), 500)),
  ]);
  assert.equal(expiredOutcome, 'rejected:503', 'a nested index wait must retain the account lock absolute acquisition deadline');
  assert.equal(expiredIndexActionRan, false, 'an index callback whose account deadline expired must never run later');

  releaseIndexLock();
  releaseIndexLock = null;
  await indexLockWork;
  indexLockWork = null;
} finally {
  releaseAccountA?.();
  await accountAWork?.catch(() => {});
  if (lockOwnerChild && lockOwnerChild.exitCode === null) {
    lockOwnerChild.stdin?.write('release\n');
    await waitForChildExit(lockOwnerChild).catch(() => lockOwnerChild.kill());
  }
  releaseIndexLock?.();
  await indexLockWork?.catch(() => {});
  await fsp.rm(DATA_DIR, { recursive: true, force: true });
}

console.log('wxdb mirror account lock partition tests passed');
