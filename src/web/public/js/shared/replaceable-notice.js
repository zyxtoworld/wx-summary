// 同一业务状态只保留一条通知；新状态先撤销旧句柄，再创建新通知。
export function createReplaceableNotice(showNotice) {
  if (typeof showNotice !== 'function') throw new TypeError('通知创建函数无效');
  let current = null;

  function clear() {
    const active = current;
    current = null;
    active?.dismiss?.();
  }

  return {
    show(...args) {
      clear();
      current = showNotice(...args) || null;
      return current;
    },
    clear,
  };
}
