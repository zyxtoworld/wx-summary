import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { renameAtomicWithRetry } from '../src/lib/json-store.js';

const originalRename = fsp.rename;
const originalSetTimeout = globalThis.setTimeout;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const expectedDelays = [25, 50, 100, 200, 400, 800, 1600, 3200];
let calls = 0;
let delays = [];

try {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
  globalThis.setTimeout = (callback, delay) => {
    delays.push(delay);
    queueMicrotask(callback);
    return 0;
  };
  fsp.rename = async () => {
    calls += 1;
    if (calls <= expectedDelays.length) {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    }
  };

  await renameAtomicWithRetry('fixture.tmp', 'fixture.json');
  assert.equal(calls, expectedDelays.length + 1,
    'Windows 原子重命名应允许短暂占用跨过完整有界退避后成功');
  assert.deepEqual(delays, expectedDelays);

  calls = 0;
  delays = [];
  fsp.rename = async () => {
    calls += 1;
    throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  };
  await assert.rejects(
    renameAtomicWithRetry('fixture.tmp', 'fixture.json'),
    error => error?.code === 'EPERM',
    '永久占用必须在有界退避耗尽后保留原错误',
  );
  assert.equal(calls, expectedDelays.length + 1);
  assert.deepEqual(delays, expectedDelays);
} finally {
  fsp.rename = originalRename;
  globalThis.setTimeout = originalSetTimeout;
  Object.defineProperty(process, 'platform', platformDescriptor);
}

console.log('web json store atomic rename retry tests passed');
