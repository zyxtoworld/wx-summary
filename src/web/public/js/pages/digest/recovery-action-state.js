// 恢复卡片的短生命周期 action lease。
// storage/account 变化可能触发整卡重绘;操作期间必须保留当前 DOM 与忙态。
export function createRecoveryActionState() {
  let current = null;

  function abortReason(reason = '恢复操作已失效') {
    return reason instanceof Error ? reason : new Error(String(reason || '恢复操作已失效'));
  }

  return {
    begin(batchId, kind = 'recover') {
      const id = String(batchId || '').trim();
      if (!id || current) return null;
      current = Object.freeze({
        batchId: id,
        kind: String(kind || 'recover'),
        controller: new AbortController(),
      });
      return current;
    },
    isBusy() {
      return !!current;
    },
    isCurrent(action) {
      return !!current && current === action;
    },
    end(action) {
      if (current === action) current = null;
    },
    invalidate(reason = '恢复操作已失效') {
      const action = current;
      const hadCurrent = !!action;
      current = null;
      if (action && !action.controller.signal.aborted) {
        action.controller.abort(abortReason(reason));
      }
      return hadCurrent;
    },
    snapshot() {
      return current;
    },
  };
}
