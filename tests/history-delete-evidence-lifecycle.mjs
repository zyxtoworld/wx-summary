import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createHistoryDeleteEvidence,
  resolveHistoryDeleteEvidence,
} from '../src/lib/history-delete-evidence.js';

const target = {
  digest_id: 'digest-delete-contract',
  history_item_key: 'history-delete-contract',
  expected_file_version: 'file-delete-contract',
  expected_digest_file_version: 'digest-file-delete-contract',
  expected_output_dir_identity: 'output-delete-contract',
};
const prepared = createHistoryDeleteEvidence({
  actionId: 'histdel_contract_0001',
  lookup: target,
  now: '2026-08-12T00:00:00.000Z',
});
assert.deepEqual({
  kind: prepared.kind,
  action_id: prepared.action_id,
  digest_id: prepared.digest_id,
  history_item_key: prepared.history_item_key,
  file_version: prepared.file_version,
  digest_file_version: prepared.digest_file_version,
  output_dir_identity: prepared.output_dir_identity,
  action_state: prepared.action_state,
  verification_pending: prepared.verification_pending,
}, {
  kind: 'history_delete',
  action_id: 'histdel_contract_0001',
  digest_id: target.digest_id,
  history_item_key: target.history_item_key,
  file_version: target.expected_file_version,
  digest_file_version: target.expected_digest_file_version,
  output_dir_identity: target.expected_output_dir_identity,
  action_state: 'prepared',
  verification_pending: true,
}, '删除前证据必须精确绑定原历史目标');

const committed = resolveHistoryDeleteEvidence(prepared, {
  targetPresent: false,
  result: { deleted: true, cleanup_pending: false, cleanup_pending_count: 0 },
  now: '2026-08-12T00:00:01.000Z',
});
assert.equal(committed.local_action_committed, true);
assert.equal(committed.verified, true);
assert.equal(committed.deleted, true);
assert.equal(committed.verification_pending, false);

const retained = resolveHistoryDeleteEvidence(createHistoryDeleteEvidence({
  actionId: 'histdel_contract_0002',
  lookup: target,
  now: '2026-08-12T00:00:02.000Z',
}), {
  targetPresent: true,
  now: '2026-08-12T00:00:03.000Z',
});
assert.equal(retained.local_action_committed, false);
assert.equal(retained.local_action_recovery_failed, true);
assert.equal(retained.action_state, 'failed');
assert.equal(retained.verification_pending, false);

const mainSource = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const routeStart = mainSource.indexOf("if (pathname === '/api/history-delete' && req.method === 'POST')");
const routeEnd = mainSource.indexOf("if (pathname.startsWith('/api/history-markdown-source/')", routeStart);
assert.ok(routeStart >= 0 && routeEnd > routeStart, '必须能定位生产历史删除路由');
const routeSource = mainSource.slice(routeStart, routeEnd);
const prepareAt = routeSource.indexOf('preparedDeleteEvidence = prepareHistoryDeleteEvidence(');
const persistAt = routeSource.indexOf('persistRecordedLocalActionEvidence(preparedDeleteEvidence)', prepareAt);
const deleteAt = routeSource.indexOf('await deleteHistoryItem(', persistAt);
const commitAt = routeSource.indexOf('resolveHistoryDeleteEvidence(preparedDeleteEvidence, { targetPresent: false, result })', deleteAt);
const abortAfterCommitAt = routeSource.indexOf("throwIfRequestSignalAborted(abort.signal, '历史删除请求已取消。')", commitAt);
assert.ok(prepareAt >= 0 && persistAt > prepareAt && deleteAt > persistAt,
  '生产路由必须先持久化精确目标证据，再开始不可逆删除');
assert.ok(commitAt > deleteAt && abortAfterCommitAt > commitAt,
  '删除提交后必须先记录核验终态，再处理客户端断开');
assert.match(mainSource, /await reconcileHistoryDeleteEvidenceForQuery\(kind, actionId\)/,
  '证据查询路由必须实际执行历史删除恢复核对');

console.log('history delete evidence lifecycle tests passed');
