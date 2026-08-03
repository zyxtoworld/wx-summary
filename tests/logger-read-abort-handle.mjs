import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import vm from 'node:vm';

const source = await fsp.readFile(new URL('../src/lib/logger.js', import.meta.url), 'utf8');
const readStart = source.indexOf('export async function readLogFileTail(');
const readEnd = source.indexOf('\nfunction throwIfLogReadAborted(', readStart);
const abortEnd = source.indexOf('\nfunction writeLog(', readEnd);
assert.ok(readStart >= 0 && readEnd > readStart && abortEnd > readEnd, 'logger tail reader source must be inspectable');

let resolveOpen;
let closeCalls = 0;
const handle = {
  async read() {
    throw new Error('read must not start after cancellation');
  },
  async close() {
    closeCalls += 1;
  },
};
const sandbox = {
  Buffer,
  LOG_TAIL_MAX_BYTES: 1024 * 1024,
  targetFile: 'test.log',
  assertSafeTmpPath: async () => ({
    resolved: 'test.log',
    stat: { size: 32 },
  }),
  fsp: {
    stat: async () => ({ size: 32 }),
    open: async () => new Promise(resolve => { resolveOpen = resolve; }),
  },
};
const executableSource = source
  .slice(readStart, abortEnd)
  .replace('export async function readLogFileTail(', 'async function readLogFileTail(');
vm.runInNewContext(`${executableSource}\nglobalThis.__readLogFileTail = readLogFileTail;`, sandbox, { timeout: 1000 });

const controller = new AbortController();
const read = sandbox.__readLogFileTail('test.log', 10, { signal: controller.signal });
while (!resolveOpen) await new Promise(resolve => setImmediate(resolve));
controller.abort(Object.assign(new Error('日志读取已取消。'), { status: 499 }));
resolveOpen(handle);

await assert.rejects(read, error => error?.status === 499);
assert.equal(closeCalls, 1, 'a handle acquired after cancellation must still be closed exactly once');

console.log('logger abort-after-open handle lifecycle tests passed');
