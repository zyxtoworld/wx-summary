// 摘要结果只属于当前账号上下文。账号变化时清空所有可见/可保存的结果态，
// 避免没有 activeBatch 的已恢复结果继续出现在下一个账号页面。
export function clearDigestAccountBoundResults(state = {}) {
  if (!state || typeof state !== 'object') return false;
  state.doneResults = [];
  state.currentResultIndex = 0;
  state.currentRender = null;
  state.generationRender = null;
  state.previewProcessingGroup = '';
  state.previewDigests = [];
  state.previewMarkdown = '';
  state.savedItems?.clear?.();
  return true;
}

export function createDigestAccountResultContextHandler({
  state = null,
  slots = {},
  beforeClear = null,
} = {}) {
  const resultSlots = [
    slots.recovery,
    slots.batch,
    slots.result,
    slots.textPreview,
  ].filter(Boolean);

  return {
    handle(change = {}) {
      const status = String(change?.status || '').trim();
      if (status === 'unchanged') return { status, cleared: false };
      if (status !== 'changed' && status !== 'blocked') return { status: 'invalid', cleared: false };
      let cleared = false;
      try {
        beforeClear?.(change);
      } finally {
        // 接线回调可能包含失效/释放等多个动作；其中任何一个抛错，
        // 也不能让旧账号结果和 DOM 留在当前页面。finally 保证清理，
        // 同时不捕获异常，让既有错误边界继续处理它。
        cleared = clearDigestAccountBoundResults(state);
        for (const slot of resultSlots) slot.replaceChildren?.();
      }
      return { status, cleared };
    },
  };
}
