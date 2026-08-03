import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const source = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} source should remain extractable`);
  return source.slice(start, end);
}

const requestRevealSource = sourceBetween(
  'async function requestLocalRevealWithProgress',
  '\nfunction makeLocalRevealSettlementUpdater',
);

function revealRequestHarness({ current = true } = {}) {
  const calls = [];
  const progressCalls = [];
  const settlements = [];
  const request = new Function(
    'startLocalRevealProgress',
    'api',
    'createLocalActionId',
    'settleLocalActionEvidence',
    'digestAbortError',
    `${requestRevealSource}; return requestLocalRevealWithProgress;`,
  )(
    (paintStatus, options) => {
      progressCalls.push({ paintStatus, options });
      return () => {};
    },
    async (endpoint, options) => {
      calls.push({ endpoint, options });
      return { ok: true, verification_pending: true };
    },
    () => `retry-${calls.length + 1}`,
    async (kind, actionId, initialResult, options) => {
      settlements.push({ kind, actionId, initialResult, options });
      return initialResult;
    },
    message => Object.assign(new Error(message), { name: 'AbortError' }),
  );
  return {
    request,
    calls,
    progressCalls,
    settlements,
    isCurrent: () => current,
    setCurrent(value) {
      current = value;
    },
  };
}

{
  const harness = revealRequestHarness();
  const controller = new AbortController();
  const paintStatus = () => {};
  const onBackgroundSettlement = () => true;
  await harness.request('/api/reveal', {
    signal: controller.signal,
    body: { local_action_id: 'initial' },
    subject: '历史 PNG',
    paintStatus,
    isCurrent: harness.isCurrent,
    onBackgroundSettlement,
  });
  assert.equal(harness.calls.length, 1);
  const retryAction = harness.settlements[0].options.retryAction;
  harness.setCurrent(false);
  await assert.rejects(
    retryAction(),
    error => error?.name === 'AbortError' && /重新打开/.test(error.message),
    'a notice from a stale page must not submit another local reveal side effect',
  );
  assert.equal(harness.calls.length, 1, 'stale retry must stop before the second POST');

  harness.setCurrent(true);
  await retryAction();
  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls[1].options.signal, controller.signal, 'retry must retain the original cancellation signal');
  assert.equal(harness.progressCalls[1].paintStatus, paintStatus, 'retry must retain the original status painter');
  assert.equal(harness.progressCalls[1].options.isCurrent, harness.isCurrent, 'retry progress must retain the original validity check');
  assert.equal(
    harness.settlements[1].options.onBackgroundSettlement,
    onBackgroundSettlement,
    'retry must retain the original background settlement handler',
  );
}

const scheduleSettlementSource = sourceBetween(
  'function scheduleLocalActionBackgroundSettlement',
  '\nfunction localActionEvidenceSettled',
);

async function noticesAfterHandledSettlement({ throwDuringPoll = false } = {}) {
  const monitors = new Map();
  const notices = [];
  const schedule = new Function(
    'LOCAL_ACTION_BACKGROUND_MONITORS',
    'waitForLocalActionEvidence',
    'LOCAL_ACTION_RECOVERY_TIMEOUT_MS',
    'localActionEvidenceSettled',
    'localActionResultFromEvidence',
    'localActionBackgroundSettlementHandled',
    'showLocalActionStatusNotice',
    'retryLocalActionFromNotice',
    'forgetPendingLocalAction',
    'openDirectoryResultStatus',
    'revealResultStatus',
    'localActionAfterCommitStatus',
    'compactErrorSummary',
    `${scheduleSettlementSource}; return scheduleLocalActionBackgroundSettlement;`,
  )(
    monitors,
    async () => {
      if (throwDuringPoll) throw new Error('poll failed');
      return { evidence: null, accepted: false };
    },
    100,
    () => false,
    () => null,
    (handler, details) => handler?.(details) === true,
    (...args) => notices.push(args),
    async () => false,
    () => {},
    () => ({ className: 'status warn', text: 'open' }),
    () => ({ className: 'status warn', text: 'reveal' }),
    status => status,
    value => String(value || ''),
  );
  schedule('reveal', `handled-${throwDuringPoll}`, {}, {}, {
    onSettled: () => true,
    retryAction: async () => ({}),
  });
  const monitor = monitors.get(`reveal:handled-${throwDuringPoll}`);
  assert.ok(monitor, 'background monitor should be registered');
  await monitor;
  return notices;
}

assert.equal(
  (await noticesAfterHandledSettlement()).length,
  0,
  'a timeout already painted by the owning modal must not create a duplicate global notice',
);
assert.equal(
  (await noticesAfterHandledSettlement({ throwDuringPoll: true })).length,
  0,
  'a polling error already painted by the owning modal must not create a duplicate global notice',
);

console.log('local action background settlement runtime tests passed');
