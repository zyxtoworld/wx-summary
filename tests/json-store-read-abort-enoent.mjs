import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { readJson } from '../src/lib/json-store.js';

const originalOpen = fsp.open;
const controller = new AbortController();
const cancellation = Object.assign(new Error('read cancelled'), {
  name: 'AbortError',
  status: 499,
});

try {
  fsp.open = async () => {
    controller.abort(cancellation);
    throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
  };

  await assert.rejects(
    readJson('missing.json', { stale: true }, { signal: controller.signal }),
    error => error === cancellation,
    'a cancellation racing with a missing JSON file must not be converted to fallback data',
  );
} finally {
  fsp.open = originalOpen;
}

assert.deepEqual(
  await readJson(`outputs/.tmp/json-store-read-abort-enoent-${process.pid}.json`, { stale: true }),
  { stale: true },
  'a normal missing JSON file must still return its fallback when no cancellation raced',
);

console.log('json-store read abort ENOENT test passed');
