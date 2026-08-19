import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  classifyHistoryEvidence,
  createHistoryEvidenceLifecycle,
} from '../src/web/public/js/pages/history/evidence-settlement.js';

assert.deepEqual(classifyHistoryEvidence(null), {
  text: '本地服务暂无该动作的证据记录;操作可能没有执行,请核对实际状态。',
  tone: 'warn',
  verified: false,
});

assert.equal(classifyHistoryEvidence({
  local_action_committed: true,
  verified: true,
}).verified, true, 'committed and verified evidence should settle the action');

assert.equal(classifyHistoryEvidence({
  local_action_committed: true,
  verified: true,
  local_action_after_commit_reason: 'verification_pending',
}).verified, false, 'an unresolved post-commit reason must keep the action unverified');

let pageActive = true;
const lifecycle = createHistoryEvidenceLifecycle({ isPageActive: () => pageActive });
const staleOperation = lifecycle.begin();
const currentOperation = lifecycle.begin();
assert.equal(lifecycle.accepts(staleOperation), false, 'a newer query must supersede an older response');
assert.equal(lifecycle.claimVerified(staleOperation, {
  local_action_committed: true,
  verified: true,
}), false, 'a stale verified response must not settle the UI');
assert.equal(lifecycle.claimVerified(currentOperation, {
  local_action_committed: true,
  verified: true,
}), true, 'the current verified response should settle exactly once');
assert.equal(lifecycle.claimVerified(currentOperation, {
  local_action_committed: true,
  verified: true,
}), false, 'repeated queries must not settle the same action twice');

const closedLifecycle = createHistoryEvidenceLifecycle({ isPageActive: () => true });
const closedOperation = closedLifecycle.begin();
closedLifecycle.close();
assert.equal(closedLifecycle.accepts(closedOperation), false, 'closing the evidence modal must invalidate its pending response');
assert.equal(closedLifecycle.claimVerified(closedOperation, {
  local_action_committed: true,
  verified: true,
}), false, 'a response arriving after modal close must not settle the UI');

const unmountedLifecycle = createHistoryEvidenceLifecycle({ isPageActive: () => pageActive });
const unmountedOperation = unmountedLifecycle.begin();
pageActive = false;
assert.equal(unmountedLifecycle.accepts(unmountedOperation), false, 'page unmount must invalidate the evidence operation');

const historySource = fs.readFileSync(new URL('../src/web/public/js/pages/history/index.js', import.meta.url), 'utf8');
assert.match(historySource, /createHistoryEvidenceLifecycle/, 'the production history page must use the evidence lifecycle');
assert.match(historySource, /onVerified/, 'the rerender query path must provide a verified settlement callback');
assert.match(historySource, /claimVerified/, 'the production query path must claim a verified response before reconciling it');
assert.match(historySource, /restoreHistoryDetailActionFocus/, 'verified evidence must return focus to the replacement detail action');

console.log('web history evidence settlement tests passed');
