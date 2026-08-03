import assert from 'node:assert/strict';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { Readable, Writable } from 'node:stream';
import fsp from 'node:fs/promises';
import readline from 'node:readline';
import vm from 'node:vm';

const source = await fsp.readFile(new URL('../src/lib/logger.js', import.meta.url), 'utf8');
const sanitizeStart = source.indexOf('async function sanitizeLogFile(');
const sanitizeEnd = source.indexOf('\nfunction sameLogFileSnapshot(', sanitizeStart);
assert.ok(sanitizeStart >= 0 && sanitizeEnd > sanitizeStart, 'logger sanitization source must be inspectable');

let output = null;
let resolveOutputClosed;
const outputClosed = new Promise(resolve => { resolveOutputClosed = resolve; });
const removedFiles = [];
let removedBeforeOutputClosed = false;
let renameCalls = 0;

class AsyncEnospcWritable extends Writable {
  constructor() {
    super({ decodeStrings: false });
    this.writeResults = [];
    this.wasClosed = false;
    this.once('close', () => {
      this.wasClosed = true;
      resolveOutputClosed();
    });
  }

  write(...args) {
    const result = super.write(...args);
    this.writeResults.push(result);
    return result;
  }

  _write(_chunk, _encoding, callback) {
    setImmediate(() => callback(Object.assign(new Error('disk full'), { code: 'ENOSPC' })));
  }
}

async function* inputChunks() {
  yield 'first line\nsecond line\n';
  await outputClosed;
}

const sandbox = {
  Date,
  Buffer,
  process,
  readline,
  once,
  finished,
  fs: {
    createReadStream() {
      return Readable.from(inputChunks());
    },
    createWriteStream() {
      output = new AsyncEnospcWritable();
      return output;
    },
  },
  fsp: {
    async open() {
      return {
        async read(buffer) {
          buffer[0] = 10;
          return { bytesRead: 1 };
        },
        async close() {},
      };
    },
    async rm(file) {
      removedBeforeOutputClosed ||= !output?.wasClosed;
      removedFiles.push(file);
    },
  },
  async assertSafeTmpPath(file) {
    return {
      resolved: file,
      stat: { size: 64, mtimeMs: 1, ctimeMs: 1 },
    };
  },
  async renameAtomicWithRetry() {
    renameCalls += 1;
  },
  sanitizeSerializedLogLine(value) {
    return String(value || '');
  },
};

vm.runInNewContext(
  `${source.slice(sanitizeStart, sanitizeEnd)}\nglobalThis.__sanitizeLogFile = sanitizeLogFile;`,
  sandbox,
  { timeout: 1000 },
);

const uncaught = [];
const onUncaughtException = error => { uncaught.push(error); };
process.on('uncaughtException', onUncaughtException);

let outcome;
let timeoutTimer = null;
try {
  outcome = await Promise.race([
    sandbox.__sanitizeLogFile('legacy.log').then(
      () => ({ status: 'resolved' }),
      error => ({ status: 'rejected', error }),
    ),
    new Promise(resolve => {
      timeoutTimer = setTimeout(() => resolve({ status: 'timeout' }), 1000);
    }),
  ]);
} finally {
  if (timeoutTimer) clearTimeout(timeoutTimer);
  process.removeListener('uncaughtException', onUncaughtException);
  output?.destroy();
}

assert.equal(
  output?.writeResults[0],
  true,
  `fixture must reproduce an asynchronous error after write() returned true; outcome=${outcome?.status}:${outcome?.error?.stack || outcome?.error?.message || ''}`,
);
assert.equal(uncaught.length, 0, 'the output error must be owned by the sanitization Promise, not uncaughtException');
assert.equal(outcome.status, 'rejected', 'sanitization must reject instead of hanging or resolving after a write failure');
assert.equal(outcome.error?.code, 'ENOSPC', 'sanitization must preserve the original filesystem error');
assert.equal(renameCalls, 0, 'a failed staging file must never replace the original log');
assert.equal(removedFiles.length, 1, 'the failed sanitization staging file must be removed');
assert.equal(removedBeforeOutputClosed, false, 'the staging file must be removed only after its stream closes');

console.log('logger sanitization async write-error lifecycle tests passed');
