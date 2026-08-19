import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const source = await fsp.readFile(new URL('../src/config/dpapi.js', import.meta.url), 'utf8');
const start = source.indexOf('function runPowerShell(');
const end = source.indexOf('\nfunction macKeychainStatusError(', start);
assert.ok(start >= 0 && end > start, 'DPAPI PowerShell runner must remain inspectable');

function emitter({ setEncodingError = null, throwOnOnEvent = null, throwOnOnError = null } = {}) {
  const listeners = new Map();
  return {
    on(event, handler) {
      if (event === throwOnOnEvent) {
        throwOnOnEvent = null;
        throw throwOnOnError || new Error(`fake ${event}.on failed`);
      }
      const list = listeners.get(event) || [];
      list.push(handler);
      listeners.set(event, list);
      return this;
    },
    once(event, handler) {
      const wrapper = (...args) => {
        this.removeListener(event, wrapper);
        handler(...args);
      };
      wrapper.listener = handler;
      return this.on(event, wrapper);
    },
    removeListener(event, handler) {
      const list = listeners.get(event) || [];
      const index = list.findIndex(listener => listener === handler || listener.listener === handler);
      if (index >= 0) list.splice(index, 1);
      if (list.length === 0) listeners.delete(event);
      return this;
    },
    emit(event, ...args) {
      const list = [...(listeners.get(event) || [])];
      if (event === 'error' && list.length === 0) {
        throw args[0] || new Error('unhandled fake stream error');
      }
      for (const handler of list) handler(...args);
      return list.length > 0;
    },
    listenerCount(event) {
      return (listeners.get(event) || []).length;
    },
    setEncoding() {
      if (setEncodingError) throw setEncodingError;
    },
  };
}

function createRunner({
  killError = null,
  killReturnsFalse = false,
  stdinEndError = null,
  stdoutEncodingError = null,
  stderrEncodingError = null,
  childOnError = null,
  stdinOnError = null,
  terminationPending = false,
  terminationConfirmed = null,
  cleanupPending = false,
} = {}) {
  const stdout = emitter({ setEncodingError: stdoutEncodingError });
  const stderr = emitter({ setEncodingError: stderrEncodingError });
  const stdin = Object.assign(emitter({
    throwOnOnEvent: stdinOnError ? 'error' : null,
    throwOnOnError: stdinOnError,
  }), {
    end() {
      if (stdinEndError) throw stdinEndError;
    },
  });
  const child = Object.assign(emitter({
    throwOnOnEvent: childOnError ? 'error' : null,
    throwOnOnError: childOnError,
  }), {
    stdout,
    stderr,
    stdin,
    pid: 2_000_000_001,
    exitCode: null,
    signalCode: null,
    killCalls: 0,
    kill() {
      this.killCalls += 1;
      if (killError) throw killError;
      if (killReturnsFalse) return false;
      return true;
    },
  });
  let timerCallback = null;
  let timeoutFired = false;
  let clearCalls = 0;
  let terminationCalls = 0;
  let releaseTermination = null;
  let releaseCleanup = null;
  const terminationGate = new Promise(resolve => { releaseTermination = resolve; });
  const cleanupGate = new Promise(resolve => { releaseCleanup = resolve; });
  const terminateProcessTree = async (target, options = {}) => {
    terminationCalls += 1;
    try {
      const result = target.kill('SIGKILL');
      options.onKillAttempt?.({ phase: 'force', result });
    } catch (error) {
      options.onKillAttempt?.({ phase: 'force', error });
    }
    if (terminationPending) await terminationGate;
    const confirmed = terminationConfirmed ?? !(killError || killReturnsFalse);
    return {
      pid: target.pid,
      terminated: confirmed,
      cleanup: (cleanupPending || !confirmed) ? cleanupGate : Promise.resolve(),
    };
  };
  const attachCleanup = (error, cleanup) => {
    error.cleanupPromise = cleanup;
    return error;
  };
  const runner = new Function(
    'spawn',
    'windowsPowerShellExecutablePath',
    'appendLimited',
    'setTimeout',
    'clearTimeout',
    'terminateWindowsProcessTree',
    'attachWindowsProcessCleanup',
    `${source.slice(start, end)}\nreturn runPowerShell;`,
  )(
    () => child,
    () => 'powershell.exe',
    (current, chunk) => `${current}${chunk}`,
    callback => {
      timerCallback = callback;
      return { timer: true };
    },
    () => {
      clearCalls += 1;
    },
    terminateProcessTree,
    attachCleanup,
  );
  return {
    runner,
    child,
    fireTimeout() {
      timeoutFired = true;
      timerCallback?.();
    },
    get timeoutFired() { return timeoutFired; },
    get clearCalls() { return clearCalls; },
    get terminationCalls() { return terminationCalls; },
    releaseTermination() { releaseTermination?.(); },
    releaseCleanup() { releaseCleanup?.(); },
  };
}

function assertPendingTerminationListeners(fixture, label) {
  assert.equal(fixture.child.stdout.listenerCount('data'), 0, `${label}: stdout business listener must be removed`);
  assert.equal(fixture.child.stderr.listenerCount('data'), 0, `${label}: stderr business listener must be removed`);
  assert.equal(fixture.child.listenerCount('close'), 1, `${label}: close owner must remain attached until cleanup is confirmed`);
  assert.equal(fixture.child.listenerCount('error'), 1, `${label}: child must retain one bounded error drain`);
  assert.equal(fixture.child.stdin.listenerCount('error'), 1, `${label}: stdin must retain one bounded error drain`);
}

function assertClosedListeners(fixture, label) {
  assert.equal(fixture.child.stdout.listenerCount('data'), 0, `${label}: stdout listener must be removed`);
  assert.equal(fixture.child.stderr.listenerCount('data'), 0, `${label}: stderr listener must be removed`);
  assert.equal(fixture.child.listenerCount('close'), 0, `${label}: close listener must be removed`);
  assert.equal(fixture.child.listenerCount('error'), 0, `${label}: child error listener must be removed`);
  assert.equal(fixture.child.stdin.listenerCount('error'), 0, `${label}: stdin error listener must be removed`);
}

{
  const killError = new Error('simulated kill failure');
  const fixture = createRunner({ killError });
  const pending = fixture.runner('script', 'secret', 1);
  let timerError = null;
  try {
    fixture.fireTimeout();
  } catch (error) {
    timerError = error;
  }
  assert.equal(timerError, null, 'timeout cleanup must not let child.kill throw out of the timer callback');
  await assert.rejects(
    pending,
    error => /timed out/i.test(error?.message || '') && error.cause === killError,
    'kill failure must preserve its cause while publishing the timeout terminal error',
  );
  assert.equal(fixture.child.killCalls, 1, 'timeout must attempt to kill the PowerShell child exactly once');
  assert.equal(fixture.clearCalls, 1, 'timeout must clear its timer exactly once');
  assertPendingTerminationListeners(fixture, 'timeout kill throw');
  assert.doesNotThrow(() => fixture.child.emit('error', new Error('late child error')));
  assert.doesNotThrow(() => fixture.child.stdin.emit('error', new Error('late stdin error')));
  assert.equal(fixture.child.killCalls, 1, 'late child close/error must not trigger a second terminal action');
  fixture.releaseCleanup();
  await Promise.resolve();
  assertPendingTerminationListeners(fixture, 'timeout kill throw after cleanup before close');
  fixture.child.emit('close', -9);
  assertClosedListeners(fixture, 'timeout kill throw after cleanup');
  assert.equal(fixture.child.listenerCount('error'), 0, 'child error drain must be one-shot');
  assert.equal(fixture.child.stdin.listenerCount('error'), 0, 'stdin error drain must be one-shot');
}

{
  const fixture = createRunner({ killReturnsFalse: true });
  const pending = fixture.runner('script', 'secret', 1);
  fixture.fireTimeout();
  await assert.rejects(
    pending,
    error => /timed out/i.test(error?.message || '') && /kill/i.test(error?.cause?.message || ''),
    'kill returning false must remain observable as the timeout error cause',
  );
  assert.equal(fixture.child.killCalls, 1, 'kill=false timeout must attempt cleanup once');
  assert.equal(fixture.clearCalls, 1, 'kill=false timeout must clear its timer');
  assertPendingTerminationListeners(fixture, 'timeout kill false');
  assert.doesNotThrow(() => fixture.child.emit('error', new Error('late child error')));
  assert.doesNotThrow(() => fixture.child.stdin.emit('error', new Error('late stdin error')));
  fixture.releaseCleanup();
  await Promise.resolve();
  assertPendingTerminationListeners(fixture, 'timeout kill false after cleanup before close');
  fixture.child.emit('close', -9);
  assertClosedListeners(fixture, 'timeout kill false after cleanup');
}

{
  const fixture = createRunner({ terminationConfirmed: true });
  const pending = fixture.runner('script', 'secret', 1);
  fixture.fireTimeout();
  await assert.rejects(pending, /timed out/i, 'confirmed timeout must preserve the timeout error');
  assertPendingTerminationListeners(fixture, 'confirmed timeout before child close');
  assert.doesNotThrow(() => fixture.child.emit('error', new Error('late child error 1')));
  assert.doesNotThrow(() => fixture.child.emit('error', new Error('late child error 2')));
  assert.doesNotThrow(() => fixture.child.stdin.emit('error', new Error('late stdin error 1')));
  assert.doesNotThrow(() => fixture.child.stdin.emit('error', new Error('late stdin error 2')));
  fixture.child.emit('close', -9);
  assertClosedListeners(fixture, 'confirmed timeout after child close');
}

{
  const fixture = createRunner({ terminationPending: true, terminationConfirmed: false, cleanupPending: true });
  const pending = fixture.runner('script', 'secret', 1);
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  fixture.fireTimeout();
  await Promise.resolve();
  assert.equal(fixture.terminationCalls, 1, 'timeout must create exactly one termination owner');
  assert.equal(settled, false, 'terminal error must not publish before bounded cleanup ownership is returned');
  assertPendingTerminationListeners(fixture, 'pending timeout owner');
  fixture.releaseTermination();
  await assert.rejects(
    pending,
    error => error.cleanup_confirmed === false && error.cleanupPromise instanceof Promise,
    'an unconfirmed owner must preserve the original timeout and attach its cleanup promise',
  );
  assertPendingTerminationListeners(fixture, 'unconfirmed timeout owner');
  fixture.child.emit('close', -9);
  assertClosedListeners(fixture, 'late close after unconfirmed timeout');
  fixture.releaseCleanup();
  await Promise.resolve();
  assert.equal(fixture.terminationCalls, 1, 'late close/cleanup must not create a second owner');
}

{
  const fixture = createRunner();
  const pending = fixture.runner('script', 'secret', 1);
  const stdinError = new Error('stdin write failed');
  assert.doesNotThrow(() => fixture.child.stdin.emit('error', stdinError), 'stdin errors must be owned by the runner');
  await assert.rejects(pending, error => error === stdinError, 'stdin error must reject with the original error');
  assert.equal(fixture.clearCalls, 1, 'stdin error must clear its timer exactly once');
  assert.equal(fixture.child.killCalls, 1, 'stdin error must perform bounded child cleanup');
  assertPendingTerminationListeners(fixture, 'stdin error before child close');
  assert.doesNotThrow(() => fixture.child.emit('error', new Error('late child error 1')));
  assert.doesNotThrow(() => fixture.child.emit('error', new Error('late child error 2')));
  assert.doesNotThrow(() => fixture.child.stdin.emit('error', new Error('late stdin error 1')));
  assert.doesNotThrow(() => fixture.child.stdin.emit('error', new Error('late stdin error 2')));
  fixture.child.emit('close', -9);
  assertClosedListeners(fixture, 'stdin error after child close');
  assert.equal(fixture.child.killCalls, 1, 'late stdin/close events must not settle twice');
}

{
  const endError = new Error('stdin.end failed');
  const killError = new Error('cleanup kill failed');
  const fixture = createRunner({ stdinEndError: endError, killError });
  const pending = fixture.runner('script', 'secret', 1);
  await assert.rejects(
    pending,
    error => error === endError && error.cause === killError,
    'synchronous stdin.end failure must preserve cleanup failure as its cause',
  );
  assert.equal(fixture.clearCalls, 1, 'synchronous stdin.end failure must clear its timer');
  assert.equal(fixture.child.killCalls, 1, 'synchronous stdin.end failure must attempt bounded cleanup');
  assertPendingTerminationListeners(fixture, 'stdin.end failure');
  assert.doesNotThrow(() => fixture.child.emit('error', new Error('late child error')));
  assert.doesNotThrow(() => fixture.child.stdin.emit('error', new Error('late stdin error')));
  fixture.releaseCleanup();
  await Promise.resolve();
  assertPendingTerminationListeners(fixture, 'stdin.end failure after cleanup before close');
  fixture.child.emit('close', -9);
  assertClosedListeners(fixture, 'stdin.end failure after cleanup');
  fixture.fireTimeout();
  assert.equal(fixture.child.killCalls, 1, 'a stale timeout must not kill or settle a second time');
}

{
  const setupError = new Error('stdout setup failed');
  const fixture = createRunner({ stdoutEncodingError: setupError });
  const pending = fixture.runner('script', 'secret', 1);
  await assert.rejects(pending, error => error === setupError, 'stream setup failure must reject with its original error');
  assert.equal(fixture.clearCalls, 1, 'stream setup failure must clear its timer');
  assert.equal(fixture.child.killCalls, 1, 'stream setup failure must attempt bounded cleanup');
  assertPendingTerminationListeners(fixture, 'stream setup failure before child close');
  assert.doesNotThrow(() => fixture.child.emit('error', new Error('late child error')));
  assert.doesNotThrow(() => fixture.child.stdin.emit('error', new Error('late stdin error')));
  fixture.child.emit('close', -9);
  assertClosedListeners(fixture, 'stream setup failure after child close');
  fixture.fireTimeout();
  assert.equal(fixture.child.killCalls, 1, 'a stale timeout must not perform a second cleanup');
}

{
  const onError = new Error('stdin.on setup failed');
  const fixture = createRunner({ stdinOnError: onError });
  const pending = fixture.runner('script', 'secret', 1);
  await assert.rejects(pending, error => error === onError, 'synchronous stream on failure must reject with its original error');
  assert.equal(fixture.clearCalls, 1, 'synchronous stream on failure must clear its timer');
  assert.equal(fixture.child.killCalls, 1, 'synchronous stream on failure must attempt bounded cleanup');
  assertPendingTerminationListeners(fixture, 'stream on failure before child close');
  assert.doesNotThrow(() => fixture.child.emit('error', new Error('late child error')));
  assert.doesNotThrow(() => fixture.child.stdin.emit('error', new Error('late stdin error')));
  fixture.child.emit('close', -9);
  assertClosedListeners(fixture, 'stream on failure after child close');
}

{
  const onError = new Error('child.on setup failed');
  const fixture = createRunner({ childOnError: onError });
  const pending = fixture.runner('script', 'secret', 1);
  await assert.rejects(pending, error => error === onError, 'synchronous child.on failure must reject with its original error');
  assert.equal(fixture.clearCalls, 1, 'synchronous child.on failure must clear its timer');
  assert.equal(fixture.child.killCalls, 1, 'synchronous child.on failure must attempt bounded cleanup');
  assertPendingTerminationListeners(fixture, 'child.on failure before child close');
  assert.doesNotThrow(() => fixture.child.emit('error', new Error('late child error')));
  assert.doesNotThrow(() => fixture.child.stdin.emit('error', new Error('late stdin error')));
  fixture.child.emit('close', -9);
  assertClosedListeners(fixture, 'child.on failure after child close');
}

{
  const fixture = createRunner();
  const pending = fixture.runner('script', 'secret', 1);
  fixture.child.stdout.emit('data', 'result');
  fixture.child.stderr.emit('data', 'ignored');
  fixture.child.emit('close', 0);
  assert.equal(await pending, 'result', 'normal close must preserve the stdout result');
  assert.equal(fixture.clearCalls, 1, 'normal close must clear its timer exactly once');
  assert.equal(fixture.child.killCalls, 0, 'normal close must not kill the child');
  assertClosedListeners(fixture, 'normal close');
  fixture.child.emit('close', -9);
  assert.equal(fixture.child.killCalls, 0, 'duplicate close must not perform a terminal action');
}

{
  const fixture = createRunner();
  const pending = fixture.runner('script', 'secret', 1);
  const childError = new Error('spawned child failed');
  fixture.child.emit('error', childError);
  await assert.rejects(pending, error => error === childError, 'child error must preserve the original error');
  assert.equal(fixture.clearCalls, 1, 'child error must clear its timer exactly once');
  assertPendingTerminationListeners(fixture, 'child error before child close');
  assert.doesNotThrow(() => fixture.child.emit('error', new Error('late child error')));
  assert.doesNotThrow(() => fixture.child.stdin.emit('error', new Error('late stdin error')));
  fixture.child.emit('close', -9);
  assertClosedListeners(fixture, 'child error after child close');
  assert.equal(fixture.child.killCalls, 1, 'child error must use the termination owner once');
}

{
  const fixture = createRunner();
  const pending = fixture.runner('script', 'secret', 1);
  fixture.child.stderr.emit('data', 'PowerShell failed');
  fixture.child.emit('close', 7);
  await assert.rejects(pending, error => error?.message === 'PowerShell failed', 'non-zero close must preserve stderr semantics');
  assert.equal(fixture.clearCalls, 1, 'non-zero close must clear its timer exactly once');
  assert.equal(fixture.child.killCalls, 0, 'non-zero close must not kill the already closed child');
  assertClosedListeners(fixture, 'non-zero close');
}

console.log('DPAPI PowerShell timeout lifecycle tests passed');
