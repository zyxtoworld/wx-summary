// 设置页账号切换闸门：账号相关草稿或在途操作未收口时，必须先停在当前页面。
// 这是同步判断，供壳层在真正修改共享 account 之前 fail-closed。
export function settingsAccountSwitchBlockedMessage({
  destroyed = false,
  initializing = false,
  initializationFailed = false,
  busy = false,
  dirtyCount = 0,
  accountDraftCount = 0,
} = {}) {
  if (destroyed) return '';
  if (initializing) return '设置页正在读取当前设置，请加载完成后再切换账号。';
  if (initializationFailed) return '设置页初始化失败，请点击重试并完成读取后再切换账号。';
  if (busy) return '设置页有操作正在进行，请完成或取消后再切换账号。';
  if (Number(dirtyCount) > 0 || Number(accountDraftCount) > 0) {
    return '设置页有未保存的更改，请先保存或离开设置页后再切换账号。';
  }
  return '';
}
