export function setupHasUnsavedDraft(wiz = null) {
  return wiz?.llm?.dirty === true || String(wiz?.key?.draft || '').trim().length > 0;
}

export async function confirmSetupLeave({
  wiz = null,
  busy = false,
  confirmDialog = null,
} = {}) {
  const reason = busy ? 'busy' : (setupHasUnsavedDraft(wiz) ? 'draft' : '');
  if (!reason) return true;
  if (typeof confirmDialog !== 'function') return false;

  const message = reason === 'busy'
    ? '当前有验证或保存正在进行;离开页面会取消页面侧的请求(服务端已提交的部分不受影响)。确定离开吗?'
    : '当前有未保存的 AI 或数据库密钥输入;离开页面会丢失这些内容。确定离开吗?';
  try {
    return await confirmDialog({
      title: '离开配置向导',
      message,
      confirmLabel: '离开',
      cancelLabel: '留下',
    }) === true;
  } catch (error) {
    try { console.error('setup 离开确认失败', error); } catch {}
    return false;
  }
}

// 同一页面的排队导航共享一次用户决定;router 可能在确认等待期间收到多个 hash。
export function createSetupLeaveGuard(getOptions = () => ({})) {
  let pendingDecision = null;
  return () => {
    if (pendingDecision) return pendingDecision;
    let decision;
    try {
      decision = confirmSetupLeave(getOptions());
    } catch (error) {
      decision = Promise.reject(error);
    }
    const scheduleClear = () => {
      // router 会在同一轮确认结算后重新消费最新 hash;让它复用刚才的决定,
      // 但不把该决定带到下一次用户操作。
      setTimeout(() => {
        if (pendingDecision === sharedDecision) pendingDecision = null;
      }, 0);
    };
    const sharedDecision = Promise.resolve(decision).then(
      value => {
        scheduleClear();
        return value;
      },
      error => {
        scheduleClear();
        throw error;
      },
    );
    pendingDecision = sharedDecision;
    return sharedDecision;
  };
}
