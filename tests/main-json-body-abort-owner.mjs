import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';

process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = 'outputs/.tmp/main-json-body-abort-owner';

const { __mainInternals } = await import(`../src/main.js?main-json-body-abort-owner-${process.pid}`);
const readBody = __mainInternals.readBody;
assert.equal(typeof readBody, 'function', '生产 main 必须暴露 JSON body reader 测试 seam');

class FakeRequest extends EventEmitter {
  constructor() {
    super();
    this.headers = { 'content-length': '3' };
    this.pauseCount = 0;
    this.resumeCount = 0;
  }

  pause() { this.pauseCount += 1; }
  resume() { this.resumeCount += 1; }
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

const request = new FakeRequest();
const controller = new AbortController();
const cancellation = Object.assign(new Error('JSON caller 已取消'), {
  name: 'AbortError',
  status: 499,
});
const pending = readBody(request, 1024, {
  signal: controller.signal,
  requireObject: true,
});
await waitFor(() => request.listenerCount('data') === 1,
  'JSON body reader 必须先接管 request data listener');

controller.abort(cancellation);
await assert.rejects(pending, error => error === cancellation,
  '请求取消必须原样投影 caller reason');
assert.equal(request.pauseCount, 1,
  'signal 取消必须立即暂停仍在上传的 request body');
assert.equal(request.listenerCount('data'), 0, '取消后不得继续持有 data listener');
assert.equal(request.listenerCount('end'), 0, '取消后不得继续持有 end listener');
assert.equal(request.listenerCount('aborted'), 0, '取消后不得继续持有 aborted listener');
assert.equal(request.listenerCount('error'), 0, '取消后不得继续持有 error listener');

request.emit('data', Buffer.from('{"late":true}'));
request.emit('end');
await nextTurn();
assert.equal(request.pauseCount, 1, '取消后的迟到 body 事件不得重新启动读取');

const source = await fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8');
assert.match(source, /requestAbortSignal\(req, res, '设置保存请求已取消。'\)/,
  '设置保存必须绑定真实 request abort owner');
assert.match(source, /readBody\(req, SETTINGS_BODY_LIMIT, \{ signal: abort\.signal, requireObject: true \}\)/,
  '设置保存必须使用带 abort signal 的生产 JSON body reader');

console.log('main JSON body abort owner tests passed');
