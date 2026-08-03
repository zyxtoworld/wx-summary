import assert from 'node:assert/strict';

import { __mainInternals } from '../src/main.js';

let waitCalled = false;
const outcome = await __mainInternals.stopExistingRuntimeForSourceChange({ pid: 91 }, {
  requestShutdown: async () => false,
  waitForExit: async () => {
    waitCalled = true;
    return true;
  },
});

assert.equal(waitCalled, true, 'source-change replacement must verify process exit even when the shutdown HTTP response is lost');
assert.deepEqual(outcome, {
  shutdownAccepted: false,
  exited: true,
}, 'an identity-bound process exit should permit replacement even when shutdown acknowledgement was uncertain');

console.log('existing runtime source-change shutdown tests passed');
