import { saveProgressMessage } from './progress-state.js';
import { isMutationOutcomeUnknown } from '../../shared/mutation-outcome.js';

export async function trackDigestLocalActionRecovery(request, {
  schedule,
  actionId,
  kind,
  target = null,
} = {}) {
  try {
    const response = await request;
    schedule(actionId, kind, target, response);
    return response;
  } catch (error) {
    if (isMutationOutcomeUnknown(error)) schedule(actionId, kind, target);
    throw error;
  }
}

// 长图结果操作只由当前渲染、一次性保存凭据和批次状态决定。
export function digestResultActionState({
  hasRender = false,
  hasTicket = false,
  saved = false,
  running = false,
  saving = false,
  actionBusy = false,
  clipboardDenied = false,
} = {}) {
  const rendered = hasRender === true;
  const persisted = saved === true;
  const busy = running === true || saving === true || actionBusy === true;
  return {
    saveDisabled: !rendered || hasTicket !== true || busy || persisted,
    copyImageDisabled: !rendered || saving === true || actionBusy === true || (!persisted && clipboardDenied === true),
    copyPathDisabled: !persisted || saving === true || actionBusy === true,
    revealDisabled: !persisted || saving === true || actionBusy === true,
    rerenderDisabled: !rendered || busy || persisted,
  };
}

export function createDigestResultOperationState() {
  let current = null;
  let revision = 0;

  return {
    begin(kind = 'action', label = '操作') {
      if (current) return null;
      const action = Object.freeze({
        kind: String(kind || 'action'),
        label: String(label || '操作'),
        revision: ++revision,
      });
      current = action;
      return action;
    },

    isBusy() {
      return !!current;
    },

    isCurrent(action) {
      return !!current && current === action;
    },

    end(action) {
      if (!this.isCurrent(action)) return false;
      current = null;
      return true;
    },

    invalidate() {
      if (!current) return false;
      current = null;
      revision += 1;
      return true;
    },

    snapshot() {
      return current;
    },
  };
}

export function digestResultStatusText({
  statusText = '',
  saving = false,
  saved = false,
  savedPath = '',
  hasRender = false,
  hasTicket = false,
} = {}) {
  const explicit = String(statusText || '');
  const savingText = saveProgressMessage('saving');
  if (explicit && (saving === true || explicit !== savingText)) return explicit;
  if (saving === true) return savingText;
  if (saved === true) return `已保存:${String(savedPath || '').trim() || '(路径未知)'}`;
  if (hasRender === true && hasTicket !== true) {
    return '该结果缺少保存凭据(可能来自恢复的批次),请重新生成后再保存。';
  }
  return '';
}
