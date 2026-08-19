import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = [];

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.connected = true;
    this.sent = [];
    this.stderr = new EventEmitter();
    this.stderr.setEncoding = () => {};
  }

  send(message, callback) {
    this.sent.push(message);
    callback?.();
  }

  markExited() {
    this.exitCode = 0;
    this.connected = false;
  }

  finishExit() {
    if (this.exitCode === null) this.markExited();
    this.emit('exit', this.exitCode, null);
    this.emit('close', this.exitCode, null);
  }
}

mock.module('node:child_process', {
  namedExports: {
    fork() {
      const child = new FakeChild(61000 + children.length);
      children.push(child);
      return child;
    },
    spawn() {
      throw new Error('spawn must not be used by this isolated-worker contract');
    },
    execFile() {
      throw new Error('execFile must not be used by this isolated-worker contract');
    },
  },
});

const { listChatroomsFromWxDbIsolated } = await import(
  pathToFileURL(path.join(root, 'src', 'wxdb', 'isolated.js')).href,
);

const progress = [];
const pending = listChatroomsFromWxDbIsolated({
  account_id: 'wxacc_terminal_progress',
  raw_keys: [],
  onProgress: value => progress.push(value),
});
const child = children.at(-1);
assert.ok(child, 'the production isolated group-read export must create its worker');
const request = child.sent.find(message => message.type === 'groups');
assert.ok(request?.request_id, 'the worker request must carry a request id');

child.markExited();
child.emit('message', {
  type: 'result',
  request_id: request.request_id,
  result: [],
});
child.emit('message', {
  type: 'progress',
  request_id: request.request_id,
  progress: { phase: 'late_after_terminal', label: 'stale progress' },
});

await pending;
assert.equal(
  progress.some(value => value?.phase === 'late_after_terminal'),
  false,
  'progress received after the worker terminal message must not reach the caller',
);
child.finishExit();

console.log('wxdb isolated terminal progress owner tests passed');
