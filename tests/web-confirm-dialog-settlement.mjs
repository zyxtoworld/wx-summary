import assert from 'node:assert/strict';

class FakeElement {
  constructor(tagName, documentTarget) {
    this.tagName = String(tagName || '').toUpperCase();
    this.ownerDocument = documentTarget;
    this.children = [];
    this.parentElement = null;
    this.className = '';
    this.textContent = '';
    this.id = '';
    this.type = '';
    this.tabIndex = 0;
    this.disabled = false;
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = {
      add: name => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        names.add(name);
        this.className = [...names].join(' ');
      },
      remove: name => {
        this.className = this.className.split(/\s+/).filter(item => item && item !== name).join(' ');
      },
    };
  }

  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  appendChild(node) {
    node.parentElement = this;
    this.children.push(node);
    return node;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }
  click() { return this.listeners.get('click')?.({ target: this }); }
  focus() { this.ownerDocument.activeElement = this; }
  contains(node) {
    return node === this || this.children.some(child => child.contains(node));
  }
  querySelectorAll(selector) {
    const descendants = [];
    const visit = node => {
      for (const child of node.children) {
        descendants.push(child);
        visit(child);
      }
    };
    visit(this);
    if (selector === 'button, [href], input, select, textarea, [tabindex]') {
      return descendants.filter(node => ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName)
        || node.attributes.has('href') || node.attributes.has('tabindex'));
    }
    return [];
  }
  remove() {
    if (this.ownerDocument.activeElement && this.contains(this.ownerDocument.activeElement)) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }
  get isConnected() {
    return this === this.ownerDocument.body || !!this.parentElement?.isConnected;
  }
}

function descendants(root) {
  const result = [];
  const visit = node => {
    for (const child of node.children || []) {
      result.push(child);
      visit(child);
    }
  };
  visit(root);
  return result;
}

const documentListeners = new Map();
const documentTarget = {
  activeElement: null,
  createElement(tagName) { return new FakeElement(tagName, this); },
  getElementById(id) {
    return descendants(this.body).find(node => node.id === id || node.getAttribute('id') === id) || null;
  },
  querySelectorAll(selector) {
    if (selector === '[role="dialog"][aria-modal="true"]') {
      return descendants(this.body).filter(node => node.getAttribute('role') === 'dialog'
        && node.getAttribute('aria-modal') === 'true');
    }
    return [];
  },
  addEventListener(type, listener) { documentListeners.set(type, listener); },
  removeEventListener(type, listener) {
    if (documentListeners.get(type) === listener) documentListeners.delete(type);
  },
};
documentTarget.body = new FakeElement('body', documentTarget);
documentTarget.documentElement = new FakeElement('html', documentTarget);
documentTarget.activeElement = documentTarget.body;

const animationFrames = [];
const originalDocument = globalThis.document;
const originalNode = globalThis.Node;
const originalAnimationFrame = globalThis.requestAnimationFrame;
globalThis.document = documentTarget;
globalThis.Node = FakeElement;
globalThis.requestAnimationFrame = callback => animationFrames.push(callback);

try {
  const { confirmDialog, openModal } = await import('../src/web/public/js/ui/modal.js');
  const resultPromise = confirmDialog({ title: '合成确认', message: '合成内容' });
  const dialog = documentTarget.querySelectorAll('[role="dialog"][aria-modal="true"]')[0];
  assert.ok(dialog, '确认对话框必须挂载');
  const buttons = descendants(dialog).filter(node => node.tagName === 'BUTTON');
  assert.deepEqual(buttons.map(button => button.textContent), ['×', '取消', '确定']);

  let settlement = null;
  const observed = resultPromise.then(value => {
    settlement = {
      value,
      dialogCount: documentTarget.querySelectorAll('[role="dialog"][aria-modal="true"]').length,
      activeInsideDialog: dialog.contains(documentTarget.activeElement),
    };
  });
  await buttons.at(-1).click();
  await observed;

  assert.deepEqual(settlement, {
    value: true,
    dialogCount: 0,
    activeInsideDialog: false,
  }, '确认 Promise 必须在弹窗关闭并移除后结算，调用方才能安全恢复焦点');

  const pageAbort = new AbortController();
  const pageScopedPromise = confirmDialog({
    title: '页面级确认',
    message: '页面即将卸载',
    signal: pageAbort.signal,
  });
  assert.equal(
    documentTarget.querySelectorAll('[role="dialog"][aria-modal="true"]').length,
    1,
    '页面级确认必须先显示弹窗',
  );
  pageAbort.abort(new Error('页面已卸载'));
  const pageScopedOutcome = await Promise.race([
    pageScopedPromise.then(value => ({ settled: true, value })),
    new Promise(resolve => setTimeout(() => resolve({ settled: false }), 25)),
  ]);
  assert.deepEqual(pageScopedOutcome, { settled: true, value: false },
    '页面信号中止时确认必须以取消结算,不能悬挂等待');
  assert.equal(
    documentTarget.querySelectorAll('[role="dialog"][aria-modal="true"]').length,
    0,
    '页面信号中止后确认弹窗必须移除',
  );

  const unhandled = [];
  const onUnhandledRejection = reason => unhandled.push(reason);
  const originalConsoleError = console.error;
  const consoleErrors = [];
  process.on('unhandledRejection', onUnhandledRejection);
  console.error = (...args) => consoleErrors.push(args);
  let actionClosed = 0;
  try {
    const failingModal = openModal({
      title: '动作失败',
      content: '动作失败后弹层仍应可操作。',
      onClose: () => { actionClosed += 1; },
      actions: [{
        label: '执行',
        onClick: async () => { throw new Error('模拟动作失败'); },
      }],
    });
    const failingDialog = documentTarget.querySelectorAll('[role="dialog"][aria-modal="true"]')[0];
    const actionButton = descendants(failingDialog).find(button => button.textContent === '执行');
    assert.ok(actionButton, '失败 action 必须可点击');
    actionButton.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, [], 'rejected modal action 不得逃逸为 unhandledRejection');
    assert.equal(
      documentTarget.querySelectorAll('[role="dialog"][aria-modal="true"]').length,
      1,
      'action 失败时弹层不得被错误关闭,用户应能重试或取消',
    );
    assert.equal(actionClosed, 0, 'action 失败时不得触发 onClose');
    assert.equal(consoleErrors[0]?.[0], 'modal action failed', '失败 action 必须进入统一可观测错误收口');
    failingModal.close({ restoreFocus: false });

    const synchronousFailingModal = openModal({
      title: '同步动作失败',
      content: '同步动作失败后弹层仍应可操作。',
      actions: [{
        label: '同步执行',
        onClick: () => { throw new Error('模拟同步动作失败'); },
      }],
    });
    const synchronousDialog = documentTarget.querySelectorAll('[role="dialog"][aria-modal="true"]')[0];
    const synchronousButton = descendants(synchronousDialog).find(button => button.textContent === '同步执行');
    assert.ok(synchronousButton, '同步失败 action 必须可点击');
    synchronousButton.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, [], '同步抛错的 modal action 也不得逃逸为 unhandledRejection');
    assert.equal(consoleErrors.at(-1)?.[0], 'modal action failed');
    synchronousFailingModal.close({ restoreFocus: false });

    const closeError = new Error('模拟关闭清理失败');
    const closeFailingModal = openModal({
      title: '关闭清理失败',
      content: '关闭回调异常也必须可诊断。',
      onClose: () => { throw closeError; },
    });
    closeFailingModal.close({ restoreFocus: false });
    assert.equal(consoleErrors.at(-1)?.[0], 'modal close callback failed',
      '关闭清理回调异常必须进入统一可观测错误收口');
    assert.equal(consoleErrors.at(-1)?.[1], closeError);
  } finally {
    console.error = originalConsoleError;
    process.removeListener('unhandledRejection', onUnhandledRejection);
  }
} finally {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
  if (originalNode === undefined) delete globalThis.Node;
  else globalThis.Node = originalNode;
  if (originalAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
  else globalThis.requestAnimationFrame = originalAnimationFrame;
}

console.log('web confirm dialog settlement checks passed');
