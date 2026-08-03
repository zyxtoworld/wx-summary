import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(projectRoot, 'src', 'daemon', 'scheduler.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] !== '}') continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} body is incomplete`);
}

const waitForSchedulerRun = Function(`${extractFunction('waitForSchedulerRun')}; return waitForSchedulerRun;`)();
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const timers = [];
const cleared = new Set();

globalThis.setTimeout = (callback, timeout) => {
  const token = { callback, timeout };
  timers.push(token);
  return token;
};
globalThis.clearTimeout = token => {
  if (token) cleared.add(token);
};

try {
  assert.equal(await waitForSchedulerRun(Promise.resolve('finished'), 30_000), 'finished');
  assert.equal(timers.length, 1);
  assert.equal(cleared.has(timers[0]), true, 'an early scheduler completion must release its timeout timer');

  assert.equal(await waitForSchedulerRun(Promise.reject(new Error('controlled failure')), 30_000), undefined);
  assert.equal(timers.length, 2);
  assert.equal(cleared.has(timers[1]), true, 'a rejected scheduler run is swallowed but must still release its timeout timer');

  const pending = waitForSchedulerRun(new Promise(() => {}), 5_000);
  assert.equal(timers.length, 3);
  timers[2].callback();
  await assert.rejects(pending, /scheduler run did not finish within 5000ms/);
  assert.equal(cleared.has(timers[2]), true, 'the timeout path must settle and release its timer exactly like other paths');
} finally {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}

console.log('scheduler wait timeout lifecycle tests passed');
