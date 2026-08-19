import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = `outputs/.tmp/digest-result-pending-account-owner-${process.pid}`;

const mainSource = await fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const { __mainInternals } = await import('../src/main.js?digest-result-pending-account-owner');
const findPending = __mainInternals.activeDigestRequestForTerminalResult;

assert.equal(typeof findPending, 'function',
  'digest-result recovery must expose the production pending-request owner seam');

const accountId = 'wxacc_pending_owner';
const fingerprintA = 'a'.repeat(64);
const fingerprintB = 'b'.repeat(64);
const requestA = {
    batch_id: 'batch_pending_owner',
    batch_index: 0,
    account_id: accountId,
    account_fingerprint: fingerprintA,
    group_id: 'pending-owner@chatroom',
};
const requestB = {
  ...requestA,
  account_fingerprint: fingerprintB,
};
const active = new Map([[1, requestA]]);

assert.equal(
  findPending({
    batchId: 'batch_pending_owner',
    batchIndex: 0,
    accountId,
    accountFingerprint: fingerprintA,
    groupId: 'pending-owner@chatroom',
    requests: active,
  }),
  active.get(1),
  'the exact account generation must find its own active request',
);
assert.equal(
  findPending({
    batchId: 'batch_pending_owner',
    batchIndex: 0,
    accountId,
    accountFingerprint: fingerprintB,
    groupId: 'pending-owner@chatroom',
    requests: active,
  }),
  null,
  'a same-ID account fingerprint change must not expose A pending to B',
);
assert.equal(
  findPending({
    batchId: 'batch_pending_owner',
    batchIndex: 0,
    accountId,
    groupId: 'pending-owner@chatroom',
    requests: active,
  }),
  active.get(1),
  'legacy callers without an expected fingerprint may retain the account-ID lookup',
);

active.set(2, requestB);
assert.equal(
  findPending({
    batchId: requestB.batch_id,
    batchIndex: requestB.batch_index,
    accountId,
    accountFingerprint: fingerprintB,
    groupId: requestB.group_id,
    requests: active,
  }),
  requestB,
  '同批次同 ID 的新指纹必须只找到 B 的 pending owner',
);
assert.equal(
  findPending({
    batchId: requestA.batch_id,
    batchIndex: requestA.batch_index,
    accountId,
    accountFingerprint: fingerprintA,
    groupId: requestA.group_id,
    requests: new Map([[2, requestB]]),
  }),
  null,
  'A 取消/失败并从 active map 移除后，迟到的 A 终态不得重新暴露 pending',
);
assert.equal(
  findPending({
    batchId: requestB.batch_id,
    batchIndex: requestB.batch_index,
    accountId,
    accountFingerprint: fingerprintB,
    groupId: requestB.group_id,
    requests: new Map([[2, requestB]]),
  }),
  requestB,
  'A 被移除后 B 的并发 pending owner 仍必须可恢复',
);

const digestRouteStart = mainSource.indexOf("if (pathname === '/api/digest' && req.method === 'POST')");
const resultRouteStart = mainSource.indexOf("if (pathname === '/api/digest-result' && req.method === 'POST')");
const saveRenderStart = mainSource.indexOf("if (pathname === '/api/save-render' && req.method === 'POST')");
assert.ok(digestRouteStart >= 0 && resultRouteStart > digestRouteStart && saveRenderStart > resultRouteStart,
  'digest and digest-result production route boundaries must exist');
const digestRoute = mainSource.slice(digestRouteStart, resultRouteStart);
const resultRoute = mainSource.slice(resultRouteStart, saveRenderStart);
assert.match(digestRoute, /account_fingerprint:\s*expectedAccountFingerprintFromRequest\(null, body\)/,
  'the live digest request owner must retain the exact requested account fingerprint');
assert.match(resultRoute, /activeDigestRequestForTerminalResult\(\{[\s\S]*?accountFingerprint:\s*accountContext\.account_fingerprint/,
  'digest-result must pass the currently verified fingerprint into the pending owner lookup');

console.log('digest result pending account owner tests passed');
