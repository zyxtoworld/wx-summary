// 历史页本机操作(local_action)执行器。
// 语义约定(与 api.js 错误 shape 对齐):
// - 响应 local_action_committed === true + local_action_id 回显一致,才按 classifyLocalActionRecovery 定三态;
// - 网络超时/断连(新旧结果未知字段)= 结果未知,绝不说成功,给"查询结果"入口(GET /api/local-action-evidence);
// - 409 版本/上下文冲突一律引导刷新状态,不自动重试。
import { isMutationOutcomeUnknown } from '/js/api.js';
import { classifyLocalActionRecovery } from '/js/shared/local-action-recovery-state.js';
import {
  forgetLocalActionRecovery,
  localActionEvidenceSettled,
  settleLocalActionInBackground,
} from '/js/shared/local-action-recovery.js';
import { createLocalActionId } from './format.js';
import {
  deleteRequestPayload,
  historyRequestPayload,
  localActionEvidencePath,
  rerenderRequestPayload,
  settingsContextPayload,
} from './paths.js';

const EVIDENCE_LOOKUP_TIMEOUT_MS = 12 * 1000;

function responseMatchesAction(result, localActionId) {
  return !!result
    && typeof result === 'object'
    && String(result.local_action_id || '').trim() === localActionId;
}

// 本地动作统一结果对象。
function actionResult({ status, message, tone = 'info', result = null, item = null, error = null, actionId = '' }) {
  return { status, message, tone, result, item, error, actionId };
}

function recoveryMessage(label, recovery) {
  if (recovery === 'verified') return '';
  if (recovery === 'committed_unverified') return `${label}已提交,本地服务未能完成核对;请查看实际结果。`;
  return `${label}已提交,但缺少完成凭据;请查询结果或核对后再决定是否重试。`;
}

export function createHistoryActions({ api, store }) {
  function currentState() {
    return store?.get?.('state') || null;
  }

  function currentOutputDirIdentity() {
    return String(currentState()?.output_dir_identity || '').trim();
  }

  function scheduleRecovery(actionId, { kind = '', item = null } = {}) {
    void settleLocalActionInBackground({
      api,
      actionId,
      kind,
      target: item,
      maxWaitMs: EVIDENCE_LOOKUP_TIMEOUT_MS * 3,
    }).catch(() => {});
  }

  async function fetchEvidence(actionId, { kind = '', item = null, signal = null } = {}) {
    try {
      const result = await api.get(localActionEvidencePath({ kind, actionId, item }), {
        timeoutMs: EVIDENCE_LOOKUP_TIMEOUT_MS,
        signal,
      });
      const evidence = result?.evidence || null;
      if (localActionEvidenceSettled(kind, evidence)) {
        forgetLocalActionRecovery(actionId);
      }
      return evidence;
    } catch (error) {
      if (error?.code === 'local_action_evidence_target_mismatch') {
        forgetLocalActionRecovery(actionId);
      }
      throw error;
    }
  }

  // 结果未知时给用户一个可点的"查询结果"入口。
  function unknownOutcome(label, error, actionId, { kind = '', item = null } = {}) {
    scheduleRecovery(actionId, { kind, item });
    return actionResult({
      status: 'unknown',
      tone: 'warn',
      message: `${label}请求超时或断连,结果未知;请先查询结果或核对实际状态,不要立即重复操作。(${error?.message || '网络异常'})`,
      error,
      actionId,
      item,
      result: { __evidenceKind: kind },
    });
  }

  function classifyResult(label, result, localActionId, kind = '', item = null) {
    if (!responseMatchesAction(result, localActionId)) {
      scheduleRecovery(localActionId, { kind, item });
      return actionResult({
        status: 'unknown',
        tone: 'warn',
        message: `${label}的响应与本次动作标识不一致;操作可能已执行,请查询结果或刷新列表核对。`,
        result,
        actionId: localActionId,
      });
    }
    const recovery = classifyLocalActionRecovery(result);
    if (recovery === 'pending' || recovery === 'committed_unverified') {
      scheduleRecovery(localActionId, { kind, item });
    }
    return actionResult({
      status: recovery === 'verified' ? 'verified' : recovery === 'failed' ? 'failed' : 'committed_unverified',
      tone: recovery === 'verified' ? 'success' : 'warn',
      message: recoveryMessage(label, recovery),
      result,
      item: result?.item && typeof result.item === 'object' ? result.item : null,
      actionId: localActionId,
    });
  }

  function classifyError(label, error, actionId, { kind = '', item = null } = {}) {
    if (isMutationOutcomeUnknown(error)) {
      // 请求已进入写入阶段后详情关闭仍可能只是客户端取消；API 会把这类
      // 499 标为结果未知并保留 marker。继续安静返回 cancelled，但必须核对
      // 一次，否则历史页没有任何入口收敛这个 marker。
      if (error?.name === 'AbortError' || error?.status === 499) {
        scheduleRecovery(actionId, { kind, item });
        return actionResult({ status: 'cancelled', tone: 'info', message: '', error, actionId });
      }
      return unknownOutcome(label, error, actionId, { kind, item });
    }
    // 用户取消/页面卸载:安静结束,不当失败提示。
    if (error?.name === 'AbortError' || error?.status === 499) {
      return actionResult({ status: 'cancelled', tone: 'info', message: '', error, actionId });
    }
    return actionResult({
      status: 'failed',
      tone: 'error',
      message: error?.message || `${label}失败`,
      error,
      actionId,
    });
  }

  // -- 在文件夹显示(PNG 走 /api/reveal,MD 走 /api/reveal-output)--
  async function revealItem(item, { signal = null } = {}) {
    const markdown = String(item?.artifact_type || '').trim() === 'text_preview_md';
    const localActionId = createLocalActionId('reveal');
    const label = '在文件夹显示';
    try {
      const result = await api.post(markdown ? '/api/reveal-output' : '/api/reveal', {
        ...historyRequestPayload(item),
        local_action_id: localActionId,
      }, { signal });
      const outcome = classifyResult(label, result, localActionId, 'reveal', item);
      if (outcome.status === 'verified') outcome.message = '已在文件夹中显示。';
      return outcome;
    } catch (error) {
      return classifyError(label, error, localActionId, { kind: 'reveal', item });
    }
  }

  // -- 复制图片到系统剪贴板 --
  async function copyImage(item, { signal = null } = {}) {
    const localActionId = createLocalActionId('copyimg');
    const label = '复制图片';
    try {
      const result = await api.post('/api/copy-image', {
        ...historyRequestPayload(item),
        local_action_id: localActionId,
      }, { signal });
      const outcome = classifyResult(label, result, localActionId, 'clipboard_copy', item);
      if (outcome.status === 'verified') outcome.message = '图片已复制到剪贴板。';
      return outcome;
    } catch (error) {
      return classifyError(label, error, localActionId, { kind: 'clipboard_copy', item });
    }
  }

  // -- 复制文件路径到系统剪贴板 --
  async function copyPath(item, { signal = null } = {}) {
    const localActionId = createLocalActionId('copypath');
    const label = '复制路径';
    try {
      const result = await api.post('/api/copy-path', {
        ...historyRequestPayload(item),
        local_action_id: localActionId,
        copy_to_system: true,
      }, { signal });
      if (!responseMatchesAction(result, localActionId)) {
        return classifyResult(label, result, localActionId, 'text_clipboard_copy', item);
      }
      if (result?.clipboard_supported === false) {
        return actionResult({
          status: 'failed',
          tone: 'warn',
          message: '系统剪贴板不可用,请手动复制路径。',
          result,
          actionId: localActionId,
        });
      }
      if (result?.clipboard_error) {
        return actionResult({
          status: 'failed',
          tone: 'error',
          message: `复制路径失败:${result.clipboard_error}`,
          result,
          actionId: localActionId,
        });
      }
      const outcome = classifyResult(label, result, localActionId, 'text_clipboard_copy', item);
      if (outcome.status === 'verified') outcome.message = '路径已复制。';
      return outcome;
    } catch (error) {
      return classifyError(label, error, localActionId, { kind: 'text_clipboard_copy', item });
    }
  }

  // -- 删除历史记录(调用方负责二次确认)--
  async function deleteItem(item, { signal = null } = {}) {
    const localActionId = createLocalActionId('histdel');
    const label = '删除历史记录';
    try {
      const result = await api.post('/api/history-delete', {
        ...deleteRequestPayload(item),
        local_action_id: localActionId,
      }, { signal });
      // 删除响应必须同时回显本次动作标识和目标身份;API 边界也会做同一校验。
      const matches = String(result?.digest_id || '').trim() === String(item?.digest_id || '').trim()
        && String(result?.history_item_key || '').trim() === String(item?.history_item_key || '').trim()
        && String(result?.local_action_id || '').trim() === localActionId
        && result?.deleted === true;
      if (!matches) {
        scheduleRecovery(localActionId, { kind: 'history_delete', item });
        return actionResult({
          status: 'unknown',
          tone: 'warn',
          message: '删除请求可能已执行,但返回的历史记录身份与提交目标不一致;请刷新列表核对。',
          result,
          actionId: localActionId,
        });
      }
      const cleanupPending = result?.cleanup_pending === true;
      return actionResult({
        status: 'verified',
        tone: cleanupPending ? 'warn' : 'success',
        message: cleanupPending
          ? '历史记录已删除;部分暂存文件将在下次启动时继续清理。'
          : '历史记录及不再被引用的本地文件已删除。',
        result,
        actionId: localActionId,
      });
    } catch (error) {
      return classifyError(label, error, localActionId, { kind: 'history_delete', item });
    }
  }

  // -- 非当前输出目录 PNG 复制到当前输出目录 --
  async function copyToCurrentOutput(item, { signal = null } = {}) {
    const localActionId = createLocalActionId('histcopy');
    const label = '复制到当前输出目录';
    const currentIdentity = currentOutputDirIdentity();
    if (!currentIdentity) {
      return actionResult({
        status: 'failed',
        tone: 'error',
        message: '当前输出目录身份未就绪,请刷新页面后重试。',
        actionId: localActionId,
      });
    }
    try {
      const result = await api.post('/api/history-copy-current-output', {
        ...rerenderRequestPayload(item),
        expected_current_output_dir_identity: currentIdentity,
        local_action_id: localActionId,
      }, { signal });
      const outcome = classifyResult(label, result, localActionId, 'history_copy_current_output', item);
      if (outcome.status === 'verified') {
        const target = String(outcome.item?.relative_path || '').trim();
        outcome.message = `已复制到当前输出目录${target ? `:${target}` : ''};原目录文件保持不变。`;
      } else if (outcome.status === 'committed_unverified' && outcome.item) {
        outcome.message = `已复制到当前输出目录,但提交后复核未全部通过;请刷新列表查看新副本。${outcome.message}`;
      }
      return outcome;
    } catch (error) {
      return classifyError(label, error, localActionId, { kind: 'history_copy_current_output', item });
    }
  }

  // -- 提交重渲染(第二阶段;预览凭据来自 preview-rerender-history)--
  async function commitRerender(item, {
    render,
    rerenderInputVersion,
    previewToken,
    previewSha256,
    restoreToCurrentOutput = false,
    timeoutMs = 180 * 1000,
    signal = null,
  }) {
    const localActionId = createLocalActionId('histrerender');
    const label = restoreToCurrentOutput ? '恢复到当前目录' : '重渲染保存';
    try {
      const body = {
        ...rerenderRequestPayload(item),
        render,
        rerender_input_version: String(rerenderInputVersion || '').trim().toLowerCase(),
        preview_token: String(previewToken || '').trim(),
        preview_sha256: String(previewSha256 || '').trim().toLowerCase(),
        local_action_id: localActionId,
      };
      if (restoreToCurrentOutput) body.restore_to_current_output = true;
      const result = await api.post('/api/rerender-history', body, { timeoutMs, signal });
      const outcome = classifyResult(label, result, localActionId, 'history_rerender', item);
      if (outcome.status === 'verified') {
        const target = String(outcome.item?.relative_path || '').trim();
        outcome.message = restoreToCurrentOutput
          ? `已恢复到当前输出目录,原目录文件保持不变${target ? `:${target}` : ''}。`
          : `已保存重渲染结果${target ? `:${target}` : ''}。`;
      }
      return outcome;
    } catch (error) {
      return classifyError(label, error, localActionId, { kind: 'history_rerender', item });
    }
  }

  // -- 导出 MD(服务端按已验证的原摘要 JSON 生成 Markdown)--
  async function exportMarkdown(item, { digest = null, title = '', markdown = '', signal = null } = {}) {
    const localActionId = createLocalActionId('exportmd');
    const label = '导出 MD';
    const context = settingsContextPayload(currentState() || {});
    if (!context.expected_export_policy_revision || !context.expected_output_dir_identity) {
      return actionResult({
        status: 'failed',
        tone: 'error',
        message: '设置上下文未就绪(缺少设置状态标识或输出目录身份),请刷新页面后重试。',
        actionId: localActionId,
      });
    }
    const group = String(digest?.group || item?.group || '历史摘要').trim() || '历史摘要';
    const digestId = String(digest?.digest_id || item?.digest_id || '').trim();
    const messageCount = Math.max(0, Number(digest?.message_count ?? item?.message_count ?? 0) || 0);
    const source = historyRequestPayload(item);
    try {
      const result = await api.post('/api/export-preview', {
        ...context,
        title: group,
        markdown: markdown || '# 历史摘要\n\n服务端会根据已验证的原摘要 JSON 生成 Markdown。\n',
        history: {
          artifact_type: 'text_preview_md',
          title: group,
          group,
          groups: group ? [group] : [],
          digest_ids: digestId ? [digestId] : [],
          account_id: String(digest?.account_id || item?.account_id || '').trim(),
          account_label: String(digest?.account_label || item?.account_label || '').trim(),
          since: String(digest?.since || item?.since || '').trim(),
          until: String(digest?.until || item?.until || '').trim(),
          model: String(digest?.model || item?.model || '').trim(),
          message_count: messageCount,
          headline: String(digest?.headline || item?.headline || '').trim(),
          search_text: String(digest?.headline || item?.headline || group).trim(),
          complete: true,
          done: 1,
          total: 1,
          source_digest_id: source.digest_id || '',
          source_history_item_key: source.history_item_key || '',
          source_expected_file_version: source.expected_file_version || '',
          source_expected_digest_file_version: source.expected_digest_file_version || '',
          source_digest_revision: String(item?.source_digest_revision || '').trim(),
        },
        history_source: source,
        local_action_id: localActionId,
      }, { timeoutMs: 180 * 1000, signal });
      const outcome = classifyResult(label, result, localActionId, 'export_preview', item);
      if (outcome.status === 'verified') {
        const target = String(outcome.item?.relative_path || '').trim();
        const redacted = result?.redacted === true ? '(已按隐私设置脱敏保存)' : '';
        outcome.message = `已导出 MD${target ? `:${target}` : ''}${redacted}`;
      }
      return outcome;
    } catch (error) {
      return classifyError(label, error, localActionId, { kind: 'export_preview', item });
    }
  }

  return {
    fetchEvidence,
    revealItem,
    copyImage,
    copyPath,
    deleteItem,
    copyToCurrentOutput,
    commitRerender,
    exportMarkdown,
  };
}
