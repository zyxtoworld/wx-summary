const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]';

function isUsable(element) {
  return !!element
    && element.disabled !== true
    && element.getAttribute?.('aria-hidden') !== 'true'
    && element.tabIndex !== -1
    && element.isConnected !== false;
}

export function createDialogFocusManager({
  dialog,
  opener = null,
  documentTarget = globalThis.document,
  requestAnimationFrame = globalThis.requestAnimationFrame || (callback => setTimeout(callback, 0)),
} = {}) {
  if (!dialog) throw new Error('对话框焦点管理器需要 dialog');
  let disposed = false;

  const focusables = () => [...(dialog.querySelectorAll?.(FOCUSABLE_SELECTOR) || [])].filter(isUsable);
  // 多层弹窗共存时,只有最上层的焦点管理器可以消费 Tab。
  // 每个弹窗都把监听器挂在 document 捕获阶段;底层监听器会先收到事件,
  // 若不主动退出就会把焦点抢回自己的第一个控件。
  const isTopmostDialog = () => {
    const dialogs = [...(documentTarget?.querySelectorAll?.('[role="dialog"][aria-modal="true"]') || [])]
      .filter(element => element?.isConnected !== false);
    return !dialogs.length || dialogs[dialogs.length - 1] === dialog;
  };
  const focus = (element, { preventScroll = true } = {}) => {
    if (!isUsable(element) && element !== dialog) return false;
    try { element.focus({ preventScroll }); } catch { element.focus?.(); }
    return true;
  };

  const onKeydown = event => {
    if (disposed || event.key !== 'Tab') return;
    if (!isTopmostDialog()) return;
    const items = focusables();
    if (!items.length) {
      event.preventDefault();
      focus(dialog);
      return;
    }
    const active = documentTarget?.activeElement;
    const index = items.indexOf(active);
    const backwards = event.shiftKey === true;
    if ((!backwards && (index === items.length - 1 || index < 0))
      || (backwards && (index <= 0))) {
      event.preventDefault();
      // 这是对原生 Tab 的人工替代；必须保留原生换焦会把目标滚入可视区的语义。
      focus(backwards ? items[items.length - 1] : items[0], { preventScroll: false });
    }
  };

  const focusInitial = () => {
    if (disposed) return false;
    const items = focusables();
    return focus(items[0] || dialog);
  };

  const restoreFocus = () => {
    requestAnimationFrame(() => {
      const active = documentTarget?.activeElement;
      const inside = active && (active === dialog || dialog.contains?.(active));
      const explicitFocus = active
        && active !== documentTarget?.body
        && active !== documentTarget?.documentElement
        && active.isConnected !== false;
      if (inside || explicitFocus) return;
      if (isUsable(opener)) focus(opener);
    });
  };

  documentTarget?.addEventListener?.('keydown', onKeydown, true);

  return {
    focusInitial,
    dispose({ restore = false } = {}) {
      if (disposed) return;
      disposed = true;
      documentTarget?.removeEventListener?.('keydown', onKeydown, true);
      if (restore) restoreFocus();
    },
  };
}
