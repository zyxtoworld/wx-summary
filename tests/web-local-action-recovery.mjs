import assert from 'node:assert/strict';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

class MemoryStorage {
  #values = new Map();
  get length() { return this.#values.size; }
  key(index) { return [...this.#values.keys()][index] ?? null; }
  getItem(key) { return this.#values.get(String(key)) ?? null; }
  setItem(key, value) { this.#values.set(String(key), String(value)); }
  removeItem(key) { this.#values.delete(String(key)); }
}

globalThis.location = new URL('http://wx-summary.test/#/digest');
const storage = new MemoryStorage();
globalThis.localStorage = storage;
const now = 1_000_000;

const loader = createBrowserModuleLoader();
const recovery = await loader.load('js/shared/local-action-recovery.js');
const {
  LOCAL_ACTION_PENDING_STORAGE_LIMIT,
  beginLocalActionRecovery,
  completeLocalActionRecoveryAfterError,
  completeLocalActionRecoveryAfterResponse,
  forgetLocalActionRecovery,
  localActionEvidenceSettled,
  localActionKindFromRequest,
  pendingLocalActionStorageKey,
  localWindowActionConflictError,
  readPendingLocalActionRecords,
  settleLocalActionInBackground,
} = recovery;
const recoveryState = await loader.load('js/shared/local-action-recovery-state.js');
assert.equal(
  recoveryState.classifyLocalActionRecovery({
    local_action_committed: true,
    verified: true,
    status: 'verified',
    local_action_after_commit_reason: 'output_dir_changed_after_commit',
  }),
  'committed_unverified',
  '提交后目标换代时，显式 verified 也不能掩盖旧目标已不再是当前上下文',
);
assert.equal(
  recoveryState.classifyLocalActionRecovery({
    local_action_committed: true,
    verified: true,
    status: 'verified',
  }),
  'verified',
  '没有提交后异常说明的显式 verified 结果仍应正常结算',
);

assert.throws(
  () => beginLocalActionRecovery({ actionId: 'reveal_storage_0001', kind: 'reveal', storage: null, now }),
  error => error?.code === 'local_action_recovery_storage_unavailable' && error?.status === 503,
  '恢复日志不可用时必须在发送前失败闭锁',
);

assert.equal(localActionKindFromRequest('/api/reveal', 'reveal_test_0001'), 'reveal');
assert.equal(localActionKindFromRequest('/api/open-output', 'openout_test_0001'), 'open_output');
assert.equal(localActionKindFromRequest('/api/copy-path', 'copypath_test_0001'), 'text_clipboard_copy');
assert.equal(localActionKindFromRequest('/api/history-delete', 'histdel_test_0001'), 'history_delete',
  '历史删除必须在发送前进入本地动作恢复日志');
assert.equal(localActionKindFromRequest('/api/browser-clipboard-action', 'copy_test_0001', {
  kind: 'preview_clipboard_copy',
}), 'preview_clipboard_copy');

for (let index = 0; index < LOCAL_ACTION_PENDING_STORAGE_LIMIT; index += 1) {
  beginLocalActionRecovery({
    actionId: `exportmd_${String(index).padStart(3, '0')}`,
    kind: 'export_preview',
    target: { digest_id: `digest-${index}` },
    now,
  });
}
assert.equal(readPendingLocalActionRecords({ now }).length, LOCAL_ACTION_PENDING_STORAGE_LIMIT);
assert.throws(
  () => beginLocalActionRecovery({ actionId: 'exportmd_overflow', kind: 'export_preview', now }),
  error => error?.code === 'local_action_recovery_capacity_reached' && error?.status === 429,
  '恢复日志达到容量后必须在发送前拒绝新动作',
);
assert.equal(storage.getItem('wx-summary:pending-local-actions:http://wx-summary.test:v2:exportmd_overflow'), null);

for (const record of readPendingLocalActionRecords({ now })) forgetLocalActionRecovery(record.action_id);

// 读取待核对动作时若已枚举的 key 无法读取，不能把未知内容当成坏记录删除。
{
  const previousStorage = globalThis.localStorage;
  const actionId = 'reveal_read_failure_0001';
  const key = pendingLocalActionStorageKey(actionId);
  beginLocalActionRecovery({ actionId, kind: 'reveal', now });
  let removeCalls = 0;
  globalThis.localStorage = {
    get length() { return storage.length; },
    key(index) { return storage.key(index); },
    getItem(name) {
      if (name === key) throw new Error('pending record read denied');
      return storage.getItem(name);
    },
    setItem(name, value) { storage.setItem(name, value); },
    removeItem(name) {
      removeCalls += 1;
      storage.removeItem(name);
    },
  };
  try {
    assert.throws(
      () => readPendingLocalActionRecords({ now }),
      error => error?.code === 'local_action_recovery_storage_unavailable' && error?.status === 503,
      '枚举到的恢复记录无法读取时必须报告存储不可用，而不是当作坏记录删除',
    );
    assert.equal(removeCalls, 0, '读取失败时不得清理无法确认内容的恢复记录');
    assert.notEqual(storage.getItem(key), null, '读取失败时必须保留待核对动作记录');
  } finally {
    globalThis.localStorage = previousStorage;
    forgetLocalActionRecovery(actionId);
  }
}

// 非法/过期 key 无法删除时也不能静默返回空结果,否则它会永久占用恢复日志容量。
{
  const previousStorage = globalThis.localStorage;
  const actionId = 'reveal_remove_failure_0001';
  const key = pendingLocalActionStorageKey(actionId);
  storage.setItem(key, JSON.stringify({ action_id: actionId, kind: 'unsupported_kind', at: now - 1 }));
  globalThis.localStorage = {
    get length() { return storage.length; },
    key(index) { return storage.key(index); },
    getItem(name) { return storage.getItem(name); },
    setItem(name, value) { storage.setItem(name, value); },
    removeItem(name) {
      if (name === key) throw new Error('invalid record cleanup denied');
      storage.removeItem(name);
    },
  };
  try {
    assert.throws(
      () => readPendingLocalActionRecords({ now }),
      error => error?.code === 'local_action_recovery_cleanup_unavailable' && error?.status === 503,
      '非法恢复记录无法删除时必须报告清理不可用,而不是静默返回',
    );
    assert.notEqual(storage.getItem(key), null, '清理失败时必须保留原 key 供后续恢复');
  } finally {
    globalThis.localStorage = previousStorage;
    storage.removeItem(key);
  }
}

const deleteRecord = beginLocalActionRecovery({
  actionId: 'histdel_pending_0001',
  kind: 'history_delete',
  target: {
    digest_id: 'digest-delete-1',
    history_item_key: 'history-delete-1',
    expected_file_version: 'file-delete-1',
  },
  now,
});
assert.equal(deleteRecord.kind, 'history_delete');
assert.equal(readPendingLocalActionRecords({ now }).some(item => item.action_id === 'histdel_pending_0001'), true,
  '历史删除请求发出前必须已持久化恢复记录');
assert.equal(localActionEvidenceSettled('history_delete', {
  local_action_recovery_failed: true,
  evidence_persisted: true,
}), true, '服务端确认原目标仍存在时必须结算为可安全重试的失败终态');
forgetLocalActionRecovery('histdel_pending_0001');

beginLocalActionRecovery({ actionId: 'reveal_first_0001', kind: 'reveal', now });
assert.throws(
  () => beginLocalActionRecovery({ actionId: 'reveal_second_0001', kind: 'reveal', now: now + 1000 }),
  error => error?.code === localWindowActionConflictError().code && error?.status === 409,
  '文件管理器动作在恢复窗口内必须互斥',
);
forgetLocalActionRecovery('reveal_first_0001');

beginLocalActionRecovery({ actionId: 'copyimg_unknown_0001', kind: 'clipboard_copy', now });
const unknown = Object.assign(new Error('响应流中断'), { outcomeUnknown: true });
assert.equal(
  completeLocalActionRecoveryAfterError('copyimg_unknown_0001', unknown, { kind: 'clipboard_copy' }),
  false,
);
assert.equal(readPendingLocalActionRecords({ now }).some(item => item.action_id === 'copyimg_unknown_0001'), true,
  '结果未知必须保留动作记录');
assert.equal(
  completeLocalActionRecoveryAfterError(
    'copyimg_unknown_0001',
    Object.assign(new Error('明确拒绝'), { status: 400 }),
    { kind: 'clipboard_copy' },
  ),
  true,
);
assert.equal(readPendingLocalActionRecords({ now }).some(item => item.action_id === 'copyimg_unknown_0001'), false,
  '明确 HTTP 拒绝才允许删除恢复记录');

beginLocalActionRecovery({ actionId: 'reveal_pending_0001', kind: 'reveal', now });
assert.equal(
  completeLocalActionRecoveryAfterResponse('reveal_pending_0001', {
    local_action_committed: true,
    local_action_id: 'reveal_pending_0001',
    verification_pending: true,
  }, { kind: 'reveal' }),
  false,
);
assert.equal(
  completeLocalActionRecoveryAfterResponse('reveal_pending_0001', {
    local_action_committed: true,
    local_action_id: 'reveal_pending_0001',
    verified: true,
  }, { kind: 'reveal' }),
  true,
);
assert.equal(readPendingLocalActionRecords({ now }).some(item => item.action_id === 'reveal_pending_0001'), false);

beginLocalActionRecovery({ actionId: 'copypath_unsupported_0001', kind: 'text_clipboard_copy', now });
assert.equal(
  localActionEvidenceSettled('text_clipboard_copy', {
    local_action_id: 'copypath_unsupported_0001',
    clipboard_supported: false,
    clipboard_attempted: false,
  }),
  true,
  '系统剪贴板能力明确不可用且未尝试时是已确认拒绝，不得遗留恢复记录',
);
assert.equal(
  completeLocalActionRecoveryAfterResponse('copypath_unsupported_0001', {
    local_action_id: 'copypath_unsupported_0001',
    clipboard_supported: false,
    clipboard_attempted: false,
  }, { kind: 'text_clipboard_copy' }),
  true,
);
assert.equal(readPendingLocalActionRecords({ now }).some(item => item.action_id === 'copypath_unsupported_0001'), false);

beginLocalActionRecovery({ actionId: 'reveal_background_0001', kind: 'reveal', now });
let evidenceCalls = 0;
const settledBackground = await settleLocalActionInBackground({
  api: {
    async get(path) {
      assert.match(path, /kind=reveal/);
      evidenceCalls += 1;
      return {
        evidence: evidenceCalls === 1
          ? { local_action_committed: true, verification_pending: true }
          : { local_action_committed: true, verified: true },
      };
    },
  },
  actionId: 'reveal_background_0001',
  kind: 'reveal',
  intervalMs: 0,
  maxWaitMs: 500,
});
assert.equal(settledBackground.settled, true, '后台核对拿到明确终态后必须清理日志');
assert.equal(evidenceCalls, 2);
assert.equal(readPendingLocalActionRecords({ now }).some(item => item.action_id === 'reveal_background_0001'), false);

beginLocalActionRecovery({
  actionId: 'reveal_target_mismatch_0001',
  kind: 'reveal',
  target: { digest_id: 'digest-target-a' },
  now,
});
let targetMismatchCalls = 0;
const targetMismatch = Object.assign(new Error('本地动作证据不属于当前目标'), {
  status: 409,
  code: 'local_action_evidence_target_mismatch',
});
const targetMismatchRecovery = await settleLocalActionInBackground({
  api: {
    get() {
      targetMismatchCalls += 1;
      return Promise.reject(targetMismatch);
    },
  },
  actionId: 'reveal_target_mismatch_0001',
  kind: 'reveal',
  target: { digest_id: 'digest-target-a' },
  intervalMs: 0,
  maxWaitMs: 20,
});
assert.equal(targetMismatchCalls, 1,
  '服务端已明确拒绝目标绑定时,后台恢复不得继续重复查询');
assert.equal(targetMismatchRecovery.terminal, true,
  '目标绑定冲突必须作为终止恢复结果返回');
assert.equal(
  readPendingLocalActionRecords({ now }).some(item => item.action_id === 'reveal_target_mismatch_0001'),
  false,
  '明确目标拒绝后必须清理待恢复记录,避免下次页面恢复重复查询',
);

// 明确终态但浏览器无法删除恢复记录时,不能把结果伪装成已完成清理。
{
  const previousStorage = globalThis.localStorage;
  const actionId = 'saverender_cleanup_failure_0001';
  beginLocalActionRecovery({ actionId, kind: 'save_render', now });
  const key = pendingLocalActionStorageKey(actionId);
  globalThis.localStorage = {
    get length() { return storage.length; },
    key(index) { return storage.key(index); },
    getItem(name) { return storage.getItem(name); },
    setItem(name, value) { storage.setItem(name, value); },
    removeItem(name) {
      if (name === key) throw new Error('pending cleanup denied');
      storage.removeItem(name);
    },
  };
  try {
    const result = await settleLocalActionInBackground({
      api: {
        get() { return Promise.reject(targetMismatch); },
      },
      actionId,
      kind: 'save_render',
      intervalMs: 0,
      maxWaitMs: 20,
    });
    assert.equal(result.terminal, true,
      '目标绑定冲突仍必须停止当前恢复轮询');
    assert.equal(result.cleanup_failed, true,
      '恢复记录删除失败必须显式投影清理失败');
    assert.equal(
      readPendingLocalActionRecords({ now }).some(item => item.action_id === actionId),
      true,
      '恢复记录删除失败时不得报告已清理');
  } finally {
    globalThis.localStorage = previousStorage;
  }
}

let releaseHangingEvidence;
beginLocalActionRecovery({ actionId: 'reveal_hanging_0001', kind: 'reveal', now });
const hangingRecovery = settleLocalActionInBackground({
  api: {
    get() {
      return new Promise(resolve => { releaseHangingEvidence = resolve; });
    },
  },
  actionId: 'reveal_hanging_0001',
  kind: 'reveal',
  intervalMs: 1,
  maxWaitMs: 20,
});
const boundedRecovery = await Promise.race([
  hangingRecovery.then(() => 'settled'),
  new Promise(resolve => setTimeout(() => resolve('hung'), 100)),
]);
releaseHangingEvidence?.({ evidence: null });
await hangingRecovery;
assert.equal(boundedRecovery, 'settled',
  '后台恢复的 maxWaitMs 必须约束单个永不结束的 evidence 请求，不能永久占住卸载页面的恢复任务');
assert.equal(
  readPendingLocalActionRecords({ now }).some(item => item.action_id === 'reveal_hanging_0001'),
  true,
  '普通超时不得清理仍可能稍后结算的恢复记录',
);
forgetLocalActionRecovery('reveal_hanging_0001');

beginLocalActionRecovery({ actionId: 'reveal_cancelled_late_0001', kind: 'reveal', now });
let resolveCancelledEvidence;
const cancelledEvidence = settleLocalActionInBackground({
  api: {
    get() {
      return new Promise(resolve => { resolveCancelledEvidence = resolve; });
    },
  },
  actionId: 'reveal_cancelled_late_0001',
  kind: 'reveal',
  signal: (() => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('页面已卸载')), 0);
    return controller.signal;
  })(),
  intervalMs: 1,
  maxWaitMs: 100,
});
await new Promise(resolve => setTimeout(resolve, 5));
resolveCancelledEvidence?.({
  evidence: {
    local_action_committed: true,
    verified: true,
    evidence_persisted: true,
  },
});
assert.deepEqual(await cancelledEvidence, { settled: false, cancelled: true },
  '恢复请求取消后晚到的已核验证据不得清理记录或调用收尾回调');
assert.equal(readPendingLocalActionRecords({ now }).some(item => item.action_id === 'reveal_cancelled_late_0001'), true);
forgetLocalActionRecovery('reveal_cancelled_late_0001');

console.log('web local action recovery tests passed');
