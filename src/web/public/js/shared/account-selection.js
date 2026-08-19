function accountIdOf(account) {
  return String(account?.id || account?.account_id || '').trim();
}

// 路由模块尚未挂载时,壳层仍然可能已经展示账号菜单。此期间必须保持
// fail-closed;设置页给出更具体的提示,其他页面使用通用加载提示。
export function accountSwitchLoadingMessage(route = '') {
  return String(route || '').trim() === 'settings'
    ? '设置页正在读取当前设置，请加载完成后再切换账号。'
    : '页面正在加载，请稍后再切换账号。';
}

function accountSwitchBlockedMessage(store) {
  const guard = store.get('accountSwitchGuard');
  if (!guard) return '';
  try {
    const result = typeof guard === 'function' ? guard() : guard;
    if (!result) return '';
    if (typeof result === 'object') return String(result.message || '').trim();
    return String(result).trim();
  } catch {
    return '暂时无法确认当前页面是否可以切换账号，请完成当前操作后重试。';
  }
}

// 账号菜单自身可滚动；键盘移动焦点时必须保留原生“把焦点项滚入视口”语义。
export function focusAccountMenuOption(option, options = []) {
  if (typeof option?.focus !== 'function') return false;
  const items = Array.from(options || []);
  for (const item of items) item.tabIndex = item === option ? 0 : -1;
  option.focus({ preventScroll: false });
  return true;
}

export function createAccountSelectionController({
  store,
  persistConfirmedAccountId = () => {},
  onBlocked = () => {},
  onSelected = () => {},
} = {}) {
  if (!store?.get || !store?.set) throw new Error('账号选择控制器需要 store');

  return {
    select(account, { userInitiated = false } = {}) {
      if (userInitiated) {
        const message = accountSwitchBlockedMessage(store);
        if (message) {
          onBlocked(message);
          return { blocked: true, changed: false, account: store.get('account') || null };
        }
      }

      const previous = store.get('account') || null;
      const next = account || null;
      const changed = !Object.is(previous, next);
      store.set('account', next);

      if (userInitiated) {
        persistConfirmedAccountId(accountIdOf(next));
        if (changed && previous && next && accountIdOf(previous) !== accountIdOf(next)) {
          onSelected(next, previous);
        }
      }
      return { blocked: false, changed, account: next };
    },
  };
}
