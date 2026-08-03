import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const source = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function bindHistoryArtifactRevalidationOnReturn(');
const end = source.indexOf('\nfunction historyMarkdownSourceReferenceAvailable(', start);
assert.ok(start >= 0 && end > start, 'history revalidation helper must remain available');

const listeners = new Map();
const windowTarget = {
  addEventListener(type, listener) { listeners.set(`window:${type}`, listener); },
  removeEventListener(type, listener) {
    if (listeners.get(`window:${type}`) === listener) listeners.delete(`window:${type}`);
  },
};
const documentTarget = {
  visibilityState: 'visible',
  addEventListener(type, listener) { listeners.set(`document:${type}`, listener); },
  removeEventListener(type, listener) {
    if (listeners.get(`document:${type}`) === listener) listeners.delete(`document:${type}`);
  },
};
const timers = new Map();
let timerSeq = 0;
const fakeSetTimeout = callback => {
  const id = ++timerSeq;
  timers.set(id, callback);
  return id;
};
const fakeClearTimeout = id => timers.delete(id);
const flushTimer = async () => {
  const entry = timers.entries().next().value;
  assert.ok(entry, 'expected a scheduled revalidation');
  const [id, callback] = entry;
  timers.delete(id);
  callback();
  await Promise.resolve();
  await Promise.resolve();
};

let busy = true;
let apiCalls = 0;
let applied = 0;
const api = async () => {
  apiCalls += 1;
  return { item: { digest_id: 'digest-1' } };
};
const factory = Function(
  'api',
  'historyItemStatusApiPath',
  'window',
  'document',
  'setTimeout',
  'clearTimeout',
  `${source.slice(start, end)}; return bindHistoryArtifactRevalidationOnReturn;`,
);
const bind = factory(api, () => '/status', windowTarget, documentTarget, fakeSetTimeout, fakeClearTimeout);
const cleanup = bind({
  item: { digest_id: 'digest-1' },
  isActive: () => true,
  isBusy: () => busy,
  onItem: () => { applied += 1; },
});

listeners.get('window:focus')();
await flushTimer();
assert.equal(apiCalls, 0, 'a busy modal must not revalidate against a moving action target');
assert.equal(timers.size, 1, 'a revalidation skipped while busy must remain queued');

busy = false;
await flushTimer();
assert.equal(apiCalls, 1, 'the queued revalidation must run once the modal becomes idle');
assert.equal(applied, 1, 'the eventual status result must reach the modal');

cleanup();
assert.equal(timers.size, 0, 'closing the modal must clear a queued retry');

console.log('history modal busy revalidation tests passed');
