// 模态框与确认对话框。挂载到 #modal-root,Esc / 遮罩点击关闭(可配置)。
import { createDialogFocusManager } from './dialog-focus.js';
import { createModalStack } from './modal-stack.js';

let openCount = 0;
let modalId = 0;
const modalStack = createModalStack();

function modalRoot() {
  let root = document.getElementById('modal-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'modal-root';
    document.body.appendChild(root);
  }
  return root;
}

function lockScroll() {
  openCount += 1;
  document.body.classList.add('modal-open');
}

function unlockScroll() {
  openCount = Math.max(0, openCount - 1);
  if (!openCount) document.body.classList.remove('modal-open');
}

// options: { title, content(Node|string), actions: [{label, kind, danger, onClick}],
//            dismissible=true, wide=false, onClose }
// 返回 { close, el }。action 的 onClick 返回 false 可阻止自动关闭。
export function openModal(options = {}) {
  const {
    title = '',
    content = null,
    actions = [],
    dismissible = true,
    wide = false,
    onClose = null,
  } = options;

  // aria-modal 节点插入 DOM 时，部分浏览器会先把焦点退回 body。
  // 必须在任何 DOM 变更前记录触发控件，否则关闭后无从恢复。
  const opener = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const dialog = document.createElement('div');
  dialog.className = `modal${wide ? ' modal-wide' : ''}`;
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.tabIndex = -1;

  let titleEl = null;
  if (title) {
    const head = document.createElement('div');
    head.className = 'modal-head';
    titleEl = document.createElement('h3');
    titleEl.id = `modal-title-${++modalId}`;
    titleEl.textContent = String(title);
    head.appendChild(titleEl);
    if (dismissible) {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'modal-x';
      close.setAttribute('aria-label', '关闭');
      close.textContent = '×';
      close.addEventListener('click', () => api.close());
      head.appendChild(close);
    }
    dialog.appendChild(head);
    dialog.setAttribute('aria-labelledby', titleEl.id);
  }

  const body = document.createElement('div');
  body.className = 'modal-body';
  if (typeof content === 'string') body.textContent = content;
  else if (content instanceof Node) body.appendChild(content);
  dialog.appendChild(body);

  if (actions.length) {
    const foot = document.createElement('div');
    foot.className = 'modal-foot';
    for (const action of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn ${action.kind === 'primary' ? 'btn-primary' : 'btn-ghost'}${action.danger ? ' btn-danger' : ''}`;
      btn.textContent = String(action.label || '确定');
      const reportActionFailure = error => {
        console.error('modal action failed', error);
      };
      btn.addEventListener('click', () => {
        if (typeof action.onClick !== 'function') {
          api.close();
          return;
        }
        let result;
        try {
          result = action.onClick(api);
        } catch (error) {
          reportActionFailure(error);
          return;
        }
        Promise.resolve(result)
          .then(value => {
            if (value !== false) api.close();
          })
          .catch(reportActionFailure);
      });
      foot.appendChild(btn);
    }
    dialog.appendChild(foot);
  }

  overlay.appendChild(dialog);
  modalRoot().appendChild(overlay);
  lockScroll();

  let closed = false;
  let focusManager = null;
  const api = {
    el: dialog,
    setTopmost(topmost) {
      dialog.setAttribute('aria-modal', topmost ? 'true' : 'false');
      dialog.setAttribute('aria-hidden', topmost ? 'false' : 'true');
      overlay.inert = !topmost;
      if (topmost) overlay.classList.remove('modal-covered');
      else overlay.classList.add('modal-covered');
    },
    close({ restoreFocus = true } = {}) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKeydown, true);
      modalStack.remove(api);
      focusManager?.dispose({ restore: restoreFocus });
      overlay.remove();
      unlockScroll();
      try { onClose?.(); } catch (error) {
        console.error('modal close callback failed', error);
      }
    },
  };

  focusManager = createDialogFocusManager({ dialog, opener });
  focusManager.focusInitial();
  modalStack.push(api);

  const onKeydown = event => {
    if (event.key === 'Escape' && dismissible && modalStack.isTop(api)) {
      event.stopImmediatePropagation?.();
      event.stopPropagation();
      api.close();
    }
  };
  document.addEventListener('keydown', onKeydown, true);
  if (dismissible) {
    overlay.addEventListener('mousedown', event => {
      if (event.target === overlay) api.close();
    });
  }
  return api;
}

// 确认对话框:resolve true/false。danger=true 时主按钮为红色。
export function confirmDialog({
  title = '确认操作',
  message = '',
  confirmLabel = '确定',
  cancelLabel = '取消',
  danger = false,
  signal = null,
} = {}) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    let choice = false;
    let modal = null;
    let abortListener = null;
    const body = document.createElement('p');
    body.className = 'confirm-message';
    body.textContent = String(message || '');
    const settle = value => {
      if (abortListener && typeof signal?.removeEventListener === 'function') {
        signal.removeEventListener('abort', abortListener);
      }
      resolve(value);
    };
    modal = openModal({
      title,
      content: body,
      onClose: () => settle(choice),
      actions: [
        { label: cancelLabel, onClick: () => { choice = false; } },
        {
          label: confirmLabel,
          kind: 'primary',
          danger,
          onClick: () => { choice = true; },
        },
      ],
    });
    if (typeof signal?.addEventListener === 'function') {
      abortListener = () => {
        choice = false;
        modal.close({ restoreFocus: false });
      };
      signal.addEventListener('abort', abortListener, { once: true });
      if (signal.aborted) abortListener();
    }
  });
}
