import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { OUTPUTS_DIR, toProjectRelative } from '../src/lib/paths.js';
import { listHistory, waitForHistoryWorkToSettle } from '../src/renderer/output.js';

const testRoot = path.join(OUTPUTS_DIR, `history-list-abort-listener-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
const settings = {
  output: { dir: `./${toProjectRelative(testRoot)}` },
};

function createTrackedAbortSignal() {
  const listeners = new Set();
  const signal = {
    aborted: false,
    addCount: 0,
    removeCount: 0,
    addEventListener(type, listener) {
      if (type !== 'abort' || typeof listener !== 'function') return;
      this.addCount += 1;
      listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type !== 'abort' || typeof listener !== 'function') return;
      this.removeCount += 1;
      listeners.delete(listener);
    },
    abort() {
      if (this.aborted) return;
      this.aborted = true;
      for (const listener of [...listeners]) listener({ type: 'abort' });
    },
  };
  return signal;
}

const previousScope = process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE;
const originalReaddir = fsp.readdir;
let releaseBlockedReaddir;
let readdirStartedResolve;
const readdirStarted = new Promise(resolve => { readdirStartedResolve = resolve; });
let blockedReaddir = false;

try {
  process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE = testRoot;
  await fsp.mkdir(testRoot, { recursive: true });
  fsp.readdir = async function delayedHistoryDiscoveryReaddir(directory, ...args) {
    const resolved = path.resolve(String(directory));
    if (!blockedReaddir && resolved === path.resolve(testRoot)) {
      blockedReaddir = true;
      readdirStartedResolve();
      await new Promise(resolve => { releaseBlockedReaddir = resolve; });
      return [];
    }
    return originalReaddir.call(this, directory, ...args);
  };

  const signal = createTrackedAbortSignal();
  const listPromise = listHistory(settings, { signal, readOnly: true });
  await Promise.race([
    readdirStarted,
    new Promise((_, reject) => setTimeout(() => reject(new Error('history discovery did not reach the deferred directory read')), 2_000)),
  ]);
  assert.ok(signal.addCount >= 1, 'real listHistory must attach cancellation to the shared discovery wait');

  signal.abort();
  await assert.rejects(listPromise, error => error?.status === 499, 'cancelled listHistory must reject with the existing 499 contract');
  assert.equal(
    signal.removeCount,
    signal.addCount,
    'cancelling a shared history read must immediately remove every listener owned by the cancelled caller',
  );

  releaseBlockedReaddir();
  await waitForHistoryWorkToSettle();
  assert.equal(signal.removeCount, signal.addCount, 'producer settlement must leave the signal listener count balanced');
} finally {
  fsp.readdir = originalReaddir;
  if (previousScope === undefined) delete process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE;
  else process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE = previousScope;
  await fsp.rm(testRoot, { recursive: true, force: true });
}

console.log('history list abort listener lifecycle test passed');
