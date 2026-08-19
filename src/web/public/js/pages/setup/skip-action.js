export function createSetupSkipAction({
  button = null,
  isBusy = () => false,
  getStepIndex = () => -1,
  isDestroyed = () => false,
  confirmDialog = async () => false,
  onPendingChange = () => {},
  refreshButtons = () => {},
  gotoStep = () => {},
  markKeySkipped = () => {},
  showNotice = () => {},
} = {}) {
  let pending = false;
  let disposed = false;

  const setPending = value => {
    if (disposed) return;
    pending = value === true;
    onPendingChange(pending);
    if (disposed || isDestroyed()) return;
    if (button) button.disabled = pending;
    refreshButtons();
  };

  const onClick = async () => {
    if (disposed || pending || isBusy()) return false;
    const stepIndex = Number(getStepIndex());
    if (stepIndex === 1) {
      setPending(true);
      try {
        let proceed = false;
        try {
          proceed = await confirmDialog({
            title: '跳过 AI 接入',
            message: '不配置 AI 将无法生成摘要,“完成”时将再次检查。确定暂时跳过吗?',
            confirmLabel: '暂时跳过',
            cancelLabel: '继续配置',
          });
        } catch {
          proceed = false;
        }
        if (!proceed || disposed || isDestroyed() || Number(getStepIndex()) !== stepIndex) return false;
        gotoStep(stepIndex + 1);
        return true;
      } finally {
        setPending(false);
      }
    }
    if (stepIndex === 2) {
      if (disposed || isDestroyed() || Number(getStepIndex()) !== stepIndex) return false;
      markKeySkipped();
      gotoStep(stepIndex + 1);
      showNotice('warn', '已跳过数据库密钥验证;没有可用密钥时将无法读取群消息,可稍后在设置页完成。');
      return true;
    }
    return false;
  };

  button?.addEventListener?.('click', onClick);

  return {
    onClick,
    isPending: () => pending,
    dispose() {
      if (disposed) return;
      disposed = true;
      button?.removeEventListener?.('click', onClick);
      if (pending) {
        pending = false;
        onPendingChange(false);
      }
    },
  };
}
