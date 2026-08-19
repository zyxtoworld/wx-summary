// 运行日志面板只允许展示与当前选择一致的内容。
// 同一视图刷新失败可保留上次成功结果；跨视图失败必须替换旧内容。
export function normalizeSettingsLogView(value) {
  return value === 'summary' ? 'summary' : 'raw';
}

function requestView(request) {
  return normalizeSettingsLogView(
    request && typeof request === 'object' ? request.view : request,
  );
}

export function createSettingsLogViewLifecycle() {
  let displayed = '';
  let generation = 0;

  function isCurrent(request) {
    return Number.isSafeInteger(request?.generation)
      && request.generation > 0
      && request.generation === generation;
  }

  return {
    begin(view) {
      const requested = normalizeSettingsLogView(view);
      return {
        view: requested,
        replaceContent: displayed !== requested,
        generation: ++generation,
      };
    },

    commit(request) {
      if (!isCurrent(request)) return false;
      displayed = requestView(request);
      return true;
    },

    shouldReplaceAfterFailure(request) {
      return isCurrent(request) && displayed !== requestView(request);
    },

    isCurrent,

    displayedView() {
      return displayed;
    },
  };
}
