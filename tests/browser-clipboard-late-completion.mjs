import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { observeBrowserClipboardWriteCompletion } from '../src/web/public/js/clipboard-write-coordinator.js';

const flush = () => new Promise(resolve => setImmediate(resolve));

assert.equal(
  observeBrowserClipboardWriteCompletion(null, {}),
  false,
  'non-promise clipboard completions must not start a detached observer',
);

{
  let resolveCompletion;
  const completion = new Promise(resolve => { resolveCompletion = resolve; });
  const callbackError = new Error('late commit evidence failed');
  const observerErrors = [];
  const observed = observeBrowserClipboardWriteCompletion(completion, {
    onFulfilled: async value => {
      assert.equal(value, 'late-success');
      throw callbackError;
    },
    onObserverError: error => observerErrors.push(error),
  });
  assert.equal(observed, true, 'a late clipboard promise must be observed');
  resolveCompletion('late-success');
  await flush();
  assert.deepEqual(observerErrors, [callbackError], 'errors from an async late-success handler must be terminated and reported');
}

{
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => { rejectCompletion = reject; });
  const clipboardError = new Error('late browser rejection');
  const callbackError = new Error('late rejection evidence failed');
  const observerErrors = [];
  observeBrowserClipboardWriteCompletion(completion, {
    onRejected: async error => {
      assert.equal(error, clipboardError);
      throw callbackError;
    },
    onObserverError: error => observerErrors.push(error),
  });
  rejectCompletion(clipboardError);
  await flush();
  assert.deepEqual(observerErrors, [callbackError], 'errors from an async late-rejection handler must be terminated and reported');
}

const projectRoot = path.resolve(import.meta.dirname, '..');
const appSource = fs.readFileSync(path.join(projectRoot, 'src', 'web', 'public', 'js', 'app.js'), 'utf8');
assert.equal(appSource.includes('void completion.then('), false, 'app code must not detach raw clipboard completion handlers');
assert.ok((appSource.match(/observeBrowserClipboardWriteCompletion\(completion,/g) || []).length >= 2, 'text and image clipboard writes must share the guarded late-completion observer');
assert.ok(appSource.includes('showLateBrowserClipboardCompletionNotice'), 'late clipboard outcomes must converge into visible user feedback');
const rejectedSettleStart = appSource.indexOf('async function settleRejectedBrowserClipboardAction');
const rejectedSettleEnd = appSource.indexOf('function showLateBrowserClipboardCompletionNotice', rejectedSettleStart);
const rejectedSettleSource = appSource.slice(rejectedSettleStart, rejectedSettleEnd);
assert.ok(rejectedSettleSource.includes('try { journalEntry = BROWSER_CLIPBOARD_JOURNAL?.get?.(action?.action_id) || null; } catch {}'), 'detached rejected-write cleanup must contain journal storage failures');
assert.ok(rejectedSettleSource.includes('try { forgetPendingLocalAction(action?.action_id); } catch {}'), 'detached rejected-write cleanup must contain pending-action storage failures');

console.log('browser clipboard late completion contract passed');
