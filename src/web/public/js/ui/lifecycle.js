// 将页面级生命周期绑定到需要等待用户决定的 UI 操作。
// 页面卸载时由 signal 关闭仍在等待的确认,全局通知不走这个作用域。
export function createScopedUi(baseUi, signal) {
  const ui = baseUi && typeof baseUi === 'object' ? baseUi : {};
  return {
    ...ui,
    confirmDialog(options = {}) {
      if (typeof ui.confirmDialog !== 'function') return Promise.resolve(false);
      return ui.confirmDialog({ ...options, signal });
    },
  };
}
