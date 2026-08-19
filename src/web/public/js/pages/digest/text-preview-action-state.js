// 文本预览动作的单一占用边界。
// 预览被替换或页面卸载时，当前动作必须失效并停止其请求；旧动作不能释放新动作。
export function createTextPreviewActionState() {
  let current = null;
  let revision = 0;

  function abortReason(reason = '文本预览已失效') {
    return reason instanceof Error ? reason : new Error(String(reason || '文本预览已失效'));
  }

  return {
    begin(kind = 'action') {
      if (current) return null;
      const controller = new AbortController();
      const action = Object.freeze({
        kind: String(kind || 'action'),
        revision: ++revision,
        controller,
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

    signal(action) {
      return this.isCurrent(action) ? action.controller.signal : null;
    },

    end(action) {
      if (!this.isCurrent(action)) return false;
      current = null;
      return true;
    },

    invalidate(reason = '文本预览已失效') {
      const action = current;
      if (!action) return false;
      current = null;
      revision += 1;
      if (!action.controller.signal.aborted) {
        action.controller.abort(abortReason(reason));
      }
      return true;
    },

    snapshot() {
      return current;
    },
  };
}
