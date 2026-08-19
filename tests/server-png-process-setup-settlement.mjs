import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = relative => pathToFileURL(path.join(root, relative)).href;
const runRoot = `outputs/.tmp/server-png-process-setup-settlement-${process.pid}-${Date.now()}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = runRoot;

class FakeChild extends EventEmitter {
  constructor(setupError) {
    super();
    this.pid = 72001;
    this.exitCode = null;
    this.killCount = 0;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdout.setEncoding = () => { throw setupError; };
    this.stderr.setEncoding = () => {};
    this.stdin = new EventEmitter();
    this.stdin.end = () => {};
  }

  kill() {
    this.killCount += 1;
    return true;
  }
}

const setupError = new Error('renderer stream setup failed');
const child = new FakeChild(setupError);
const activeTimers = new Set();
const previousSetTimeout = globalThis.setTimeout;
const previousClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (callback, delay, ...args) => {
  const handle = { callback, delay, args, unref() {} };
  activeTimers.add(handle);
  return handle;
};
globalThis.clearTimeout = handle => {
  activeTimers.delete(handle);
};

mock.module('node:child_process', {
  namedExports: {
    spawn() {
      return child;
    },
  },
});
mock.module(sourceUrl('src/lib/windows-process-tree.js'), {
  namedExports: {
    attachWindowsProcessCleanup: error => error,
    terminateWindowsProcessTree: async () => {
      child.kill();
      return { pid: child.pid, terminated: true, cleanup: Promise.resolve() };
    },
    windowsProcessCleanupForError: () => null,
  },
});

try {
  const { renderDigestPngBuffer, serverRenderWorkStatus } = await import(`${sourceUrl('src/renderer/server-png.js')}?process-setup-settlement`);
  await assert.rejects(
    renderDigestPngBuffer({ headline: 'setup failure', topics: [], todos: [], links: [] }, {}, { timeout_ms: 1000 }),
    error => error === setupError,
    'renderer stream setup failure must reach the real render caller',
  );
  assert.equal(child.killCount, 1, 'stream setup failure must terminate the spawned renderer child');
  assert.equal(activeTimers.size, 0, 'stream setup failure must clear the renderer timeout');
  const status = serverRenderWorkStatus();
  assert.equal(status.renders, 0, 'stream setup failure must release the render slot');
  assert.equal(status.queued, 0, 'stream setup failure must not leave a queued render');
} finally {
  activeTimers.clear();
  globalThis.setTimeout = previousSetTimeout;
  globalThis.clearTimeout = previousClearTimeout;
  await fsp.rm(runRoot, { recursive: true, force: true });
}

console.log('server PNG process setup settlement tests passed');
