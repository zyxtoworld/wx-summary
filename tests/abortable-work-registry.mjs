import assert from 'node:assert/strict';
import { createAbortableWorkRegistry } from '../src/lib/abortable-work-registry.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const registry = createAbortableWorkRegistry({
  closingError: () => Object.assign(new Error('closing'), { name: 'AbortError', code: 'work_registry_closing' }),
});
const cleanupGate = deferred();
let taskSignal = null;
const task = registry.run(async signal => {
  taskSignal = signal;
  await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
});
task.catch(() => {});
await waitFor(() => taskSignal !== null, 'registered work did not start');

const trackedCleanup = registry.track(cleanupGate.promise);
registry.cancel(Object.assign(new Error('service shutdown'), { name: 'AbortError' }));
assert.equal(taskSignal.aborted, true, 'cancelling the registry must abort active work');

const pending = await registry.waitForSettled(20);
assert.equal(pending.settled, false, 'drain must not report success while cleanup is still pending');
assert.equal(pending.active, 1, 'only the pending cleanup should remain after the aborted task settles');

cleanupGate.resolve('clean');
assert.equal(await trackedCleanup, 'clean');
const settled = await registry.waitForSettled(200);
assert.deepEqual(settled, { settled: true, active: 0, timed_out: false });
await assert.rejects(
  registry.run(async () => 'late'),
  error => error?.code === 'work_registry_closing',
  'new work must be rejected after terminal shutdown starts',
);

console.log('abortable work registry tests passed');
