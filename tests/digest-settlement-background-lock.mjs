import assert from 'node:assert/strict';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

globalThis.location = new URL('http://wx-summary.test/#/digest');
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.sessionStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: null } });

const loader = createBrowserModuleLoader();
const { isMutationOutcomeUnknown } = await loader.load('js/api.js');
const { runDigestBatch } = await loader.load('js/pages/digest/batch-runner.js');

const calls = [];
const unknownApi = {
  getServiceInstanceId() { return 'service-instance-settlement'; },
  async post(path, body) {
    calls.push(path);
    if (path === '/api/digest-batch-start') return {
      ok: true,
      batch_id: body.batch_id,
      service_instance_id: body.service_instance_id,
      account_id: body.account_id,
      account_fingerprint: 'f'.repeat(64),
    };
    if (path === '/api/digest-result') return { status: 'missing' };
    return { ok: true };
  },
  async postStream(path) {
    calls.push(path);
    throw Object.assign(new Error('后台连接断开'), { outcomeUnknown: true });
  },
};

const recoveryEvents = [];
await assert.rejects(
  runDigestBatch(unknownApi, {
    accountId: 'account-settlement',
    accountFingerprint: 'f'.repeat(64),
    targets: [{ group_id: 'group-1', group_name: '群一' }],
    onRecoveryPending: event => recoveryEvents.push(event),
  }),
  error => isMutationOutcomeUnknown(error),
);
assert.equal(recoveryEvents[0]?.phase, 'terminal_results_pending_recovery');
assert.equal(calls.includes('/api/digest-batch-finish'), false,
  '结果未知时必须保留服务端结算状态，不能自动 finish');
assert.equal(calls.includes('/api/digest-cancel'), false,
  '结果未知时不能把可能已执行的摘要当作普通失败 cancel');

const cancelCalls = [];
const controller = new AbortController();
const cancelApi = {
  getServiceInstanceId() { return 'service-instance-settlement'; },
  async post(path, body) {
    cancelCalls.push(path);
    if (path === '/api/digest-batch-start') return {
      ok: true,
      batch_id: body.batch_id,
      service_instance_id: body.service_instance_id,
      account_id: body.account_id,
      account_fingerprint: 'f'.repeat(64),
    };
    if (path === '/api/digest-batch-finish') {
      return { ok: true, settled: true, pending: false, released: false };
    }
    return { ok: true };
  },
  async postStream(path) {
    cancelCalls.push(path);
    controller.abort(new Error('用户取消'));
    throw controller.signal.reason;
  },
};
await assert.rejects(
  runDigestBatch(cancelApi, {
    accountId: 'account-settlement',
    accountFingerprint: 'f'.repeat(64),
    signal: controller.signal,
    targets: [{ group_id: 'group-cancel', group_name: '取消' }],
  }),
  error => error?.name === 'AbortError',
);
assert.equal(cancelCalls.filter(path => path === '/api/digest-batch-finish').length, 1,
  '用户明确取消后才允许释放批次结算资源');

console.log('digest settlement background lock tests passed');
