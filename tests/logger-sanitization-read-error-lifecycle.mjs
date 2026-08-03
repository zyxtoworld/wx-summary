import assert from 'node:assert/strict';
import { once } from 'node:events';
import fsp from 'node:fs/promises';
import readline from 'node:readline';
import { Readable, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import vm from 'node:vm';

const source = await fsp.readFile(new URL('../src/lib/logger.js', import.meta.url), 'utf8');
const sanitizeStart = source.indexOf('async function sanitizeLogFile(');
const sanitizeEnd = source.indexOf('\nfunction sameLogFileSnapshot(', sanitizeStart);
assert.ok(sanitizeStart >= 0 && sanitizeEnd > sanitizeStart, 'logger sanitization source must be inspectable');

const readError = Object.assign(new Error('read failed'), { code: 'EIO' });
let input = null;
let output = null;
let renameCalls = 0;
let removeCalls = 0;
let removedBeforeInputClosed = false;
let removedBeforeOutputClosed = false;

class AsyncEioReadable extends Readable {
  constructor() {
    super();
    this.started = false;
    this.wasClosed = false;
    this.once('close', () => { this.wasClosed = true; });
  }

  _read() {
    if (this.started) return;
    this.started = true;
    this.push('first line\nsecond line\n');
    setImmediate(() => this.destroy(readError));
  }
}

class TrackingWritable extends Writable {
  constructor() {
    super();
    this.wasClosed = false;
    this.once('close', () => { this.wasClosed = true; });
  }

  _write(_chunk, _encoding, callback) {
    setImmediate(callback);
  }
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
      input = new AsyncEioReadable();
      return input;
    },
    createWriteStream() {
      output = new TrackingWritable();
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
    async rm() {
      removeCalls += 1;
      removedBeforeInputClosed ||= !input?.wasClosed;
      removedBeforeOutputClosed ||= !output?.wasClosed;
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
const unhandled = [];
const onUncaughtException = error => { uncaught.push(error); };
const onUnhandledRejection = error => { unhandled.push(error); };
process.on('uncaughtException', onUncaughtException);
process.on('unhandledRejection', onUnhandledRejection);

let outcome;
try {
  outcome = await sandbox.__sanitizeLogFile('legacy.log').then(
    () => ({ status: 'resolved' }),
    error => ({ status: 'rejected', error }),
  );
  await new Promise(resolve => setImmediate(resolve));
} finally {
  process.removeListener('uncaughtException', onUncaughtException);
  process.removeListener('unhandledRejection', onUnhandledRejection);
  input?.destroy();
  output?.destroy();
}

assert.equal(uncaught.length, 0, 'the input error must be owned by the sanitization Promise');
assert.equal(unhandled.length, 0, 'the input error must not leave a rejected lifecycle Promise unobserved');
assert.equal(outcome.status, 'rejected', 'sanitization must reject after a source read failure');
assert.equal(outcome.error, readError, 'sanitization must preserve the original read error');
assert.equal(renameCalls, 0, 'a partially read staging file must never replace the original log');
assert.equal(removeCalls, 1, 'the partially written staging file must be removed');
assert.equal(removedBeforeInputClosed, false, 'cleanup must wait for the source stream to close');
assert.equal(removedBeforeOutputClosed, false, 'cleanup must wait for the destination stream to close');

console.log('logger sanitization async read-error lifecycle tests passed');
