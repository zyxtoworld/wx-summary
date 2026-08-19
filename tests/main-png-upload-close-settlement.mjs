import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';

const runRoot = path.join('outputs', '.tmp', `main-png-upload-close-${process.pid}-${Date.now()}`);
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = runRoot;

const { __mainInternals } = await import(`../src/main.js?main-png-upload-close-${process.pid}`);
const readPngUploadToTemp = __mainInternals.readPngUploadToTemp;
assert.equal(typeof readPngUploadToTemp, 'function', '生产 main 必须暴露 PNG 上传器测试 seam');

class FakeRequest extends EventEmitter {
  constructor() {
    super();
    this.headers = { 'content-type': 'image/png', 'content-length': '3' };
    this.paused = 0;
    this.resumed = 0;
  }

  pause() { this.paused += 1; }
  resume() { this.resumed += 1; }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function nextTurn() {
  await new Promise(resolve => setImmediate(resolve));
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await nextTurn();
  }
}

async function runUpload({ abortDuringClose = false, rejectClose = false } = {}) {
  const originalOpen = fsp.open;
  const originalRm = fsp.rm;
  const syncGate = deferred();
  const closeGate = deferred();
  const syncStarted = deferred();
  const closeStarted = deferred();
  const cancellation = Object.assign(new Error('上传 caller 已取消'), {
    name: 'AbortError',
    status: 499,
  });
  const closeFailure = Object.assign(new Error('close failed'), { code: 'EIO' });
  let closeCount = 0;
  let removedCount = 0;
  let openedFile = '';
  const handle = {
    async write(chunk, offset, length) {
      return { bytesWritten: length };
    },
    async sync() {
      syncStarted.resolve();
      return syncGate.promise;
    },
    async close() {
      closeCount += 1;
      closeStarted.resolve();
      return closeGate.promise;
    },
  };
  fsp.open = async file => {
    openedFile = String(file);
    return handle;
  };
  fsp.rm = async file => {
    if (String(file) === openedFile) removedCount += 1;
  };

  const request = new FakeRequest();
  const controller = new AbortController();
  try {
    const pending = readPngUploadToTemp(request, 1024, {
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    await waitFor(() => request.listenerCount('data') === 1,
      'PNG 上传器必须先挂载 request data listener');
    request.emit('data', Buffer.from('png'));
    await nextTurn();
    request.emit('end');
    await syncStarted.promise;
    syncGate.resolve();
    await closeStarted.promise;
    if (abortDuringClose) controller.abort(cancellation);
    if (rejectClose) closeGate.reject(closeFailure);
    else closeGate.resolve();
    const outcome = await pending.then(
      value => ({ value }),
      error => ({ error }),
    );
    return { ...outcome, cancellation, closeFailure, closeCount, removedCount, request };
  } finally {
    fsp.open = originalOpen;
    fsp.rm = originalRm;
  }
}

const cancelled = await runUpload({ abortDuringClose: true });
assert.equal(cancelled.error, cancelled.cancellation,
  '完整 PNG 已读完但 close 尚未完成时取消，必须原样拒绝 caller reason');
assert.equal(cancelled.closeCount, 1, '取消路径只能关闭上传句柄一次');
assert.equal(cancelled.removedCount, 1, '取消路径不得留下已上传的临时 PNG');

const cancelledCloseFailure = await runUpload({ abortDuringClose: true, rejectClose: true });
assert.equal(cancelledCloseFailure.error, cancelledCloseFailure.cancellation,
  '取消与 close 失败竞态时，caller cancellation 必须优先于底层 close 错误');
assert.equal(cancelledCloseFailure.closeCount, 1, 'close 失败路径仍只能关闭一次');
assert.equal(cancelledCloseFailure.removedCount, 1, 'close 失败取消路径仍不得留下临时 PNG');

const normal = await runUpload();
assert.equal(normal.error, undefined, '正常 PNG 上传仍必须成功');
assert.equal(normal.value.bytes, 3, '正常上传必须报告完整字节数');
assert.equal(normal.closeCount, 1, '正常路径只能关闭上传句柄一次');
assert.equal(normal.removedCount, 0, '正常上传的临时文件交由真实 caller finally 清理');

const source = await fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const saveRoute = source.slice(source.indexOf("pathname === '/api/save-render'"), source.indexOf("pathname === '/api/export-preview'"));
const previewRoute = source.slice(source.indexOf("pathname === '/api/preview-rerender-history'"), source.indexOf("pathname === '/api/history-copy-current-output'"));
assert.match(saveRoute, /await readPngUploadToTemp\(req, SAVE_RENDER_BODY_LIMIT/,
  'save-render 必须走生产 PNG 上传器');
assert.match(previewRoute, /await readPngUploadToTemp\(req, HISTORY_RERENDER_PREVIEW_CACHE_ITEM_MAX_BYTES/,
  '历史预览必须走同一个生产 PNG 上传器');

await fsp.rm(runRoot, { recursive: true, force: true }).catch(() => {});
console.log('main PNG upload close settlement tests passed');
