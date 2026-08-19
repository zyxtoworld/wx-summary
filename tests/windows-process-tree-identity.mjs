import assert from 'node:assert/strict';

import { terminateWindowsProcessTree } from '../src/lib/windows-process-tree.js';

const fakePid = 2_000_000_001;
let captureCalls = 0;
let identityAlive = true;
let identityChecks = 0;
let taskkillCalls = 0;
let fallbackKills = 0;
let closeCalls = 0;
const killAttempts = [];
const identity = { handle: 'original-process-handle', pid: fakePid };
const testWait = async timeoutMs => {
  if (Number(timeoutMs) >= 250) await new Promise(resolve => setTimeout(resolve, 5));
};
const child = {
  pid: fakePid,
  exitCode: null,
  signalCode: null,
  kill() {
    fallbackKills += 1;
    return true;
  },
};

const terminated = await terminateWindowsProcessTree(child, {
  isClosed: () => false,
  retryMs: 250,
  pollMs: 25,
  responseWaitMs: 250,
  openProcessIdentity: async pid => {
    captureCalls += 1;
    assert.equal(pid, fakePid);
    return identity;
  },
  processIdentityAlive: captured => {
    identityChecks += 1;
    assert.equal(captured, identity);
    return identityAlive;
  },
  closeProcessIdentity: captured => {
    closeCalls += 1;
    assert.equal(captured, identity);
  },
  killTree: async pid => {
    taskkillCalls += 1;
    assert.equal(pid, fakePid);
    identityAlive = false;
    return true;
  },
  onKillAttempt: detail => killAttempts.push(detail),
  wait: testWait,
});

await terminated.cleanup;
assert.equal(terminated.terminated, true);
assert.equal(captureCalls, 1, 'cleanup must capture the original Windows process object before using its PID');
assert.ok(identityChecks >= 2, 'the captured process identity must be checked before and after taskkill');
assert.equal(taskkillCalls, 1, 'cleanup must stop taskkill retries when the captured original process exits');
assert.equal(fallbackKills, 0, 'a confirmed taskkill must not also invoke the child fallback');
assert.equal(closeCalls, 1, 'the independent Windows process handle must be closed exactly once');
assert.deepEqual(killAttempts, [{ phase: 'tree', result: true }], 'the shared owner must report its kill attempts');

let noIdentityTaskkillCalls = 0;
let noIdentityFallbackKills = 0;
const noIdentityChild = {
  pid: fakePid + 1,
  exitCode: null,
  signalCode: null,
  kill() {
    noIdentityFallbackKills += 1;
    this.exitCode = 1;
    return true;
  },
};
const withoutIdentity = await terminateWindowsProcessTree(noIdentityChild, {
  isClosed: () => false,
  responseWaitMs: 250,
  openProcessIdentity: async () => null,
  processIdentityAlive: () => false,
  closeProcessIdentity: () => { throw new Error('no identity should be closed'); },
  killTree: async () => {
    noIdentityTaskkillCalls += 1;
    return true;
  },
  wait: testWait,
});

await withoutIdentity.cleanup;
assert.equal(noIdentityTaskkillCalls, 0, 'cleanup must not run taskkill against a bare PID when process identity capture failed');
assert.equal(noIdentityFallbackKills, 1, 'identity capture failure may only terminate through the original ChildProcess handle');

const failedAttempts = [];
const falseKillChild = {
  pid: fakePid + 2,
  exitCode: null,
  signalCode: null,
  kill() {
    failedAttempts.push('called');
    return false;
  },
};
const falseKill = await terminateWindowsProcessTree(falseKillChild, {
  openProcessIdentity: async () => null,
  responseWaitMs: 250,
  wait: async () => { falseKillChild.exitCode = 1; },
  onKillAttempt: detail => failedAttempts.push(detail),
});
await falseKill.cleanup;
assert.equal(typeof falseKill.terminated, 'boolean', 'the callback contract test must still return bounded cleanup status');
assert.deepEqual(failedAttempts, ['called', { phase: 'force', result: false }], 'false kill must be observable by the owner');

console.log('Windows process tree identity tests passed');
