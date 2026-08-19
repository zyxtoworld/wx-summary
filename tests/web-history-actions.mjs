import assert from 'node:assert/strict';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';
import {
  createHistoryDeleteEvidence,
  resolveHistoryDeleteEvidence,
} from '../src/lib/history-delete-evidence.js';

globalThis.location = new URL('http://wx-summary.test/#/history');

const loader = createBrowserModuleLoader();
const { createHistoryActions } = await loader.load('js/pages/history/actions.js');
const localActionRecovery = await loader.load('js/shared/local-action-recovery.js');
const historyPaths = await loader.load('js/pages/history/paths.js');

class MemoryStorage {
  #values = new Map();
  get length() { return this.#values.size; }
  key(index) { return [...this.#values.keys()][index] ?? null; }
  getItem(key) { return this.#values.get(String(key)) ?? null; }
  setItem(key, value) { this.#values.set(String(key), String(value)); }
  removeItem(key) { this.#values.delete(String(key)); }
}

globalThis.localStorage = new MemoryStorage();

const item = {
  digest_id: 'digest-history-1',
  history_item_key: 'history-key-1',
  relative_path: 'summary.png',
  file_version: 'file-v1',
  digest_file_version: 'digest-v1',
  output_dir_identity: 'output-v1',
  export_policy_revision: 'policy-v1',
  rerender_file_version: 'rerender-v1',
};
const store = {
  get(key) {
    if (key === 'state') return {
      output_dir_identity: 'output-v1',
      settings_revision: 'settings-v1',
      export_policy_revision: 'policy-v1',
    };
    return null;
  },
};

let lastPost = null;
const evidenceRequests = [];
let deleteResponseMode = 'verified';
const api = {
  async post(path, body, options = {}) {
    lastPost = { path, body, options };
    if (path === '/api/rerender-history') {
      const error = new Error('请求被取消');
      error.name = 'AbortError';
      error.status = 499;
      if (options.signal?.aborted) throw error;
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(error), { once: true });
      });
    }
    if (path === '/api/reveal') {
      return { local_action_id: 'another-action', local_action_committed: true, verified: true };
    }
    if (path === '/api/history-delete') {
      if (deleteResponseMode === 'mismatch') {
        return {
          local_action_id: 'another-delete-action',
          digest_id: item.digest_id,
          history_item_key: item.history_item_key,
          deleted: true,
        };
      }
      return {
        local_action_id: body.local_action_id,
        digest_id: item.digest_id,
        history_item_key: item.history_item_key,
        deleted: true,
      };
    }
    if (path === '/api/copy-image') {
      return {
        local_action_id: body.local_action_id,
        local_action_committed: true,
        verification_pending: true,
      };
    }
    return { ok: true };
  },
  async get(path) {
    if (String(path).includes('/api/local-action-evidence')) {
      evidenceRequests.push(String(path));
      return {
        evidence: {
          local_action_committed: true,
          verified: true,
          evidence_persisted: true,
          relative_path: item.relative_path,
        },
      };
    }
    return null;
  },
};
const actions = createHistoryActions({ api, store });

let observedEvidenceOptions = null;
const evidenceSignal = new AbortController();
const evidenceSignalActions = createHistoryActions({
  api: {
    async get(path, options = {}) {
      assert.match(path, /local-action-evidence/);
      observedEvidenceOptions = options;
      return {
        evidence: {
          local_action_committed: true,
          verified: true,
          evidence_persisted: true,
        },
      };
    },
  },
  store,
});
await evidenceSignalActions.fetchEvidence('history-evidence-signal-0001', {
  kind: 'reveal',
  item,
  signal: evidenceSignal.signal,
});
assert.strictEqual(
  observedEvidenceOptions?.signal,
  evidenceSignal.signal,
  '历史动作证据查询必须绑定弹层 AbortSignal,关闭或卸载后不得继续占用请求',
);

// 详情关闭/页面卸载会 abort 同一个 detail controller；所有直接写操作也必须
// 把该 signal 交给 API，否则页面虽然清理了 owner，请求仍会在后台继续运行。
const detailActionSignal = new AbortController();
const detailActionOptions = new Map();
const detailActionApi = {
  async post(path, body, options = {}) {
    detailActionOptions.set(path, options);
    if (path === '/api/history-delete') {
      return {
        local_action_id: body.local_action_id,
        digest_id: item.digest_id,
        history_item_key: item.history_item_key,
        deleted: true,
      };
    }
    return {
      local_action_id: body.local_action_id,
      local_action_committed: true,
      verified: true,
      clipboard_supported: path === '/api/copy-path' ? true : undefined,
    };
  },
};
const detailSignalActions = createHistoryActions({ api: detailActionApi, store });
await detailSignalActions.revealItem(item, { signal: detailActionSignal.signal });
await detailSignalActions.copyImage(item, { signal: detailActionSignal.signal });
await detailSignalActions.copyPath(item, { signal: detailActionSignal.signal });
await detailSignalActions.deleteItem(item, { signal: detailActionSignal.signal });
await detailSignalActions.copyToCurrentOutput(item, { signal: detailActionSignal.signal });
for (const path of [
  '/api/reveal',
  '/api/copy-image',
  '/api/copy-path',
  '/api/history-delete',
  '/api/history-copy-current-output',
]) {
  assert.equal(
    detailActionOptions.get(path)?.signal,
    detailActionSignal.signal,
    `${path} 必须绑定详情 AbortSignal,关闭或卸载后不得继续占用请求`,
  );
}

{
  const actionId = 'reveal_query_mismatch_0001';
  localActionRecovery.beginLocalActionRecovery({
    actionId,
    kind: 'reveal',
    target: item,
    now: Date.now(),
  });
  const mismatchError = Object.assign(new Error('本地动作证据不属于当前目标'), {
    status: 409,
    code: 'local_action_evidence_target_mismatch',
  });
  const mismatchActions = createHistoryActions({
    api: { get: async () => { throw mismatchError; } },
    store,
  });
  await assert.rejects(
    mismatchActions.fetchEvidence(actionId, { kind: 'reveal', item }),
    error => error === mismatchError,
    '证据目标拒绝应沿用明确错误合同',
  );
  assert.equal(
    localActionRecovery.readPendingLocalActionRecords()
      .some(record => record.action_id === actionId),
    false,
    '历史查询遇到明确目标拒绝后必须清理 pending 记录',
  );
}

// 证据已明确结算但浏览器无法删除恢复记录时，历史页不得把它当成已核对完成。
{
  const previousStorage = globalThis.localStorage;
  const actionId = 'history_cleanup_failure_0001';
  localActionRecovery.beginLocalActionRecovery({
    actionId,
    kind: 'save_render',
    target: item,
    now: Date.now(),
  });
  const key = localActionRecovery.pendingLocalActionStorageKey(actionId);
  globalThis.localStorage = {
    get length() { return previousStorage.length; },
    key(index) { return previousStorage.key(index); },
    getItem(name) { return previousStorage.getItem(name); },
    setItem(name, value) { previousStorage.setItem(name, value); },
    removeItem(name) {
      if (name === key) throw new Error('历史恢复记录清理被拒绝');
      previousStorage.removeItem(name);
    },
  };
  try {
    const cleanupActions = createHistoryActions({
      api: {
        async get() {
          return {
            evidence: {
              local_action_committed: true,
              verified: true,
              evidence_persisted: true,
              relative_path: item.relative_path,
            },
          };
        },
      },
      store,
    });
    await assert.rejects(
      cleanupActions.fetchEvidence(actionId, { kind: 'save_render', item }),
      error => error?.code === 'local_action_recovery_cleanup_unavailable'
        && error?.status === 503,
      '证据已结算但恢复记录清理失败时必须显式报错，不能伪装成已核对',
    );
    assert.equal(
      localActionRecovery.readPendingLocalActionRecords()
        .some(record => record.action_id === actionId),
      true,
      '历史页清理失败时必须保留待恢复记录供后续核对',
    );
  } finally {
    globalThis.localStorage = previousStorage;
    previousStorage.removeItem(key);
  }
}

let exportPostOptions = null;
const exportApi = {
  post(path, _body, options = {}) {
    assert.equal(path, '/api/export-preview');
    exportPostOptions = options;
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        const error = new Error('导出已取消');
        error.name = 'AbortError';
        error.status = 499;
        reject(error);
      }, { once: true });
    });
  },
  async get() {
    return null;
  },
};
const exportActions = createHistoryActions({ api: exportApi, store });
const exportController = new AbortController();
const pendingExport = exportActions.exportMarkdown(item, {
  digest: { digest_id: item.digest_id, group: '历史摘要' },
  markdown: '# 历史摘要\n',
  signal: exportController.signal,
});
assert.equal(
  exportPostOptions?.signal,
  exportController.signal,
  '历史导出动作必须把详情 AbortSignal 传入第二个写入请求',
);
exportController.abort(new Error('关闭历史详情'));
assert.equal((await pendingExport).status, 'cancelled', '详情关闭后的导出请求必须安静取消');

// API 在写请求已经进入 fetch 后才收到详情关闭时，会把 499 标记为
// outcomeUnknown 并保留恢复 marker。历史导出 caller 仍应安静返回 cancelled，
// 但必须启动一次证据核对，不能把 marker 孤立到 TTL 后才被动清理。
{
  let entered = null;
  let releaseEntered;
  let rejectExport;
  let evidenceQueries = 0;
  let unknownActionId = '';
  entered = new Promise(resolve => { releaseEntered = resolve; });
  const unknownExportActions = createHistoryActions({
    api: {
      post(path, body) {
        assert.equal(path, '/api/export-preview');
        unknownActionId = body.local_action_id;
        localActionRecovery.beginLocalActionRecovery({
          actionId: unknownActionId,
          kind: 'export_preview',
          target: item,
          now: Date.now(),
        });
        return new Promise((_resolve, reject) => {
          rejectExport = reject;
          releaseEntered();
        });
      },
      async get(path) {
        evidenceQueries += 1;
        assert.match(path, /local-action-evidence/);
        return {
          evidence: {
            local_action_committed: true,
            verified: true,
            evidence_persisted: true,
            relative_path: item.relative_path,
          },
        };
      },
    },
    store,
  });
  const unknownController = new AbortController();
  const unknownExport = unknownExportActions.exportMarkdown(item, {
    digest: { digest_id: item.digest_id, group: '历史摘要' },
    markdown: '# 历史摘要\n',
    signal: unknownController.signal,
  });
  await entered;
  unknownController.abort(new Error('关闭历史详情'));
  const unknownError = new Error('写请求取消但结果未知');
  unknownError.name = 'AbortError';
  unknownError.status = 499;
  unknownError.outcomeUnknown = true;
  rejectExport(unknownError);
  assert.equal((await unknownExport).status, 'cancelled',
    '详情关闭后的结果未知导出仍不得弹出失败提示');
  for (let index = 0; index < 5 && evidenceQueries === 0; index += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(evidenceQueries, 1,
    '历史导出取消但结果未知时必须启动一次证据核对');
  for (let index = 0; index < 5; index += 1) {
    if (!localActionRecovery.readPendingLocalActionRecords()
      .some(record => record.action_id === unknownActionId)) break;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(
    localActionRecovery.readPendingLocalActionRecords()
      .some(record => record.action_id === unknownActionId),
    false,
    '结果已核对后历史导出不得遗留恢复 marker',
  );
}

const controller = new AbortController();
const pending = actions.commitRerender(item, {
  render: { theme: 'dark', font_size: 'normal', accent_color: '' },
  rerenderInputVersion: 'a'.repeat(64),
  previewToken: 'preview-token',
  previewSha256: 'b'.repeat(64),
  signal: controller.signal,
});
assert.equal(lastPost.options.signal, controller.signal, '重渲染保存必须把弹层 AbortSignal 传入 API');
controller.abort(new Error('关闭重渲染弹层'));
const cancelled = await pending;
assert.equal(cancelled.status, 'cancelled', '弹层关闭后的取消不得显示保存失败或结果未知');

const mismatched = await actions.revealItem(item);
assert.equal(mismatched.status, 'unknown', '响应 local_action_id 串号不得报已在文件夹显示');
assert.match(mismatched.message, /标识不一致/);

// copyPath 的特殊剪贴板字段不能绕过统一 local_action_id 校验；否则串号响应
// 会被误投影成“剪贴板不可用”的普通失败，用户可能立即重复一个结果未知动作。
const mismatchedCopyPathActions = createHistoryActions({
  api: {
    async post(path) {
      assert.equal(path, '/api/copy-path');
      return {
        local_action_id: 'another-copy-path-action',
        clipboard_supported: false,
      };
    },
    async get() {
      // 串号响应会按生产合同启动后台证据核对；给夹具一个已结算结果，
      // 让该后台任务在本测内收敛，不把 36 秒恢复窗口变成 Node 进程悬挂。
      return {
        evidence: {
          local_action_committed: true,
          verified: true,
          evidence_persisted: true,
          relative_path: item.relative_path,
        },
      };
    },
  },
  store,
});
const mismatchedCopyPath = await mismatchedCopyPathActions.copyPath(item);
assert.equal(mismatchedCopyPath.status, 'unknown',
  'copyPath 串号响应不得被 clipboard_supported 特殊字段降级成普通失败');
assert.match(mismatchedCopyPath.message, /标识不一致/);

const unsupportedCopyPathActions = createHistoryActions({
  api: {
    async post(path, body) {
      assert.equal(path, '/api/copy-path');
      return { local_action_id: body.local_action_id, clipboard_supported: false };
    },
    async get() { return null; },
  },
  store,
});
const unsupportedCopyPath = await unsupportedCopyPathActions.copyPath(item);
assert.equal(unsupportedCopyPath.status, 'failed',
  '匹配 action-id 但系统剪贴板不可用时仍必须保留普通失败语义');
assert.match(unsupportedCopyPath.message, /剪贴板不可用/);

const evidenceCountBeforePending = evidenceRequests.length;
const committedUnverified = await actions.copyImage(item);
assert.equal(committedUnverified.status, 'committed_unverified', '已提交待核验响应必须保留警告状态');
assert.equal(evidenceRequests.length, evidenceCountBeforePending + 1,
  '已提交待核验响应必须立即启动一次后台证据核验');
assert.match(evidenceRequests.at(-1), /kind=clipboard_copy/,
  '后台证据核验必须绑定原动作类型');

const deleted = await actions.deleteItem(item);
assert.equal(deleted.status, 'verified', '删除响应必须绑定本次 local_action_id 后才能确认成功');

deleteResponseMode = 'mismatch';
const evidenceCountBeforeDeleteMismatch = evidenceRequests.length;
const mismatchedDelete = await actions.deleteItem(item);
assert.equal(mismatchedDelete.status, 'unknown', '删除响应串号必须保持结果未知');
assert.equal(evidenceRequests.length, evidenceCountBeforeDeleteMismatch + 1,
  '删除响应串号必须立即启动原 action_id 的后台证据核验');
assert.match(evidenceRequests.at(-1), /kind=history_delete/,
  '历史删除后台核验必须使用独立的恢复动作类型');

// 删除结果未知时,前端会把历史条目的 export policy revision 作为证据目标
// 发给 /api/local-action-evidence。后端准备的同一条证据必须回显该 revision,
// 否则服务端会把本来属于当前删除目标的证据误判为 target mismatch 并清掉 marker。
const revisionDeletePayload = historyPaths.historyRequestPayload(item);
assert.equal(revisionDeletePayload.expected_settings_revision, item.export_policy_revision,
  '历史删除真实请求必须携带当前条目的 settings revision');
const revisionEvidence = createHistoryDeleteEvidence({
  actionId: 'histdel_revision_binding_0001',
  lookup: {
    ...revisionDeletePayload,
    expected_settings_revision: revisionDeletePayload.expected_settings_revision,
  },
});
assert.equal(revisionEvidence.settings_revision, item.export_policy_revision,
  '历史删除证据必须回显请求的 settings revision,避免恢复查询误判目标串号');
const revisionEvidencePath = historyPaths.localActionEvidencePath({
  kind: 'history_delete',
  actionId: revisionEvidence.action_id,
  item,
});
assert.equal(
  new URL(`http://wx-summary.test${revisionEvidencePath}`).searchParams.get('settings_revision'),
  revisionEvidence.settings_revision,
  '删除恢复查询的目标 revision 必须与服务端证据一致');

// 真实历史 caller 交错:删除 POST 的结果未知后,恢复 GET 必须能接受服务端
// 同一目标的证据。旧实现会因证据缺少 settings_revision 走 target mismatch;
// 该终端拒绝虽然会停止轮询,却会把一个本应可核对的动作误分类为串号。
let recoveryEvidenceAccepted = false;
let recoveryTargetMismatch = 0;
let recoveryActionId = '';
const unknownDeleteActions = createHistoryActions({
  api: {
    async post(path, body) {
      assert.equal(path, '/api/history-delete');
      assert.equal(body.expected_settings_revision, item.export_policy_revision);
      recoveryActionId = body.local_action_id;
      localActionRecovery.beginLocalActionRecovery({
        actionId: recoveryActionId,
        kind: 'history_delete',
        target: item,
        now: Date.now(),
      });
      throw Object.assign(new Error('删除请求结果未知'), {
        status: 504,
        code: 'api_timeout',
        outcomeUnknown: true,
      });
    },
    async get(path) {
      const url = new URL(`http://wx-summary.test${path}`);
      const evidence = createHistoryDeleteEvidence({
        actionId: url.searchParams.get('action_id'),
        lookup: revisionDeletePayload,
      });
      resolveHistoryDeleteEvidence(evidence, { targetPresent: false });
      if (evidence.settings_revision !== url.searchParams.get('settings_revision')) {
        recoveryTargetMismatch += 1;
        throw Object.assign(new Error('证据目标不匹配'), {
          status: 409,
          code: 'local_action_evidence_target_mismatch',
        });
      }
      recoveryEvidenceAccepted = true;
      return { evidence };
    },
  },
  store,
});
const unknownDelete = await unknownDeleteActions.deleteItem(item);
assert.equal(unknownDelete.status, 'unknown', '删除请求结果未知必须进入可查询恢复态');
for (let index = 0; index < 8; index += 1) {
  const markerStillPending = recoveryActionId
    && localActionRecovery.readPendingLocalActionRecords()
      .some(record => record.action_id === recoveryActionId);
  if (recoveryEvidenceAccepted && recoveryTargetMismatch === 0 && !markerStillPending) break;
  await new Promise(resolve => setImmediate(resolve));
}
assert.equal(recoveryTargetMismatch, 0,
  '同一删除目标的恢复证据不得因 settings revision 缺失被误判为串号');
assert.equal(recoveryEvidenceAccepted, true,
  '结果未知的历史删除必须能通过目标绑定恢复查询');
assert.equal(
  localActionRecovery.readPendingLocalActionRecords()
    .some(record => record.action_id === recoveryActionId),
  false,
  '恢复查询拿到已结算删除证据后必须清理对应 marker');

console.log('web history actions tests passed');
