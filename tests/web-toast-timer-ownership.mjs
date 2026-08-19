import assert from 'node:assert/strict';
import { toast } from '../src/web/public/js/ui/toast.js';

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || '').toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this.className = '';
    this.id = '';
    this.dataset = {};
    this.listeners = new Map();
    this.attributes = new Map();
    this.style = { setProperty() {} };
    this.classList = {
      add: name => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        names.add(String(name));
        this.className = [...names].join(' ');
      },
    };
  }

  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }

  appendChild(node) {
    node.parentElement = this;
    this.children.push(node);
    return node;
  }

  setAttribute(name, value) { this.attributes.set(String(name), String(value)); }

  addEventListener(type, listener) { this.listeners.set(String(type), listener); }

  click() { this.listeners.get('click')?.({ target: this }); }

  querySelector(selector) {
    if (selector === '.toast-close'
      && this.className.split(/\s+/).includes('toast-close')) return this;
    for (const child of this.children) {
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  contains(node) { return node === this || this.children.some(child => child.contains(node)); }

  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }
}

const documentTarget = {
  activeElement: null,
  createElement(tagName) { return new FakeElement(tagName, documentTarget); },
  getElementById(id) {
    const visit = node => {
      if (node.id === id) return node;
      for (const child of node.children) {
        const found = visit(child);
        if (found) return found;
      }
      return null;
    };
    return visit(documentTarget.body);
  },
};
documentTarget.body = new FakeElement('body', documentTarget);
documentTarget.documentElement = new FakeElement('html', documentTarget);
documentTarget.activeElement = documentTarget.body;
globalThis.document = documentTarget;

const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const timers = new Map();
const cleared = [];
let nextTimerId = 0;
globalThis.setTimeout = (callback, delay) => {
  const id = ++nextTimerId;
  timers.set(id, { callback, delay });
  return id;
};
globalThis.clearTimeout = id => {
  cleared.push(id);
  timers.delete(id);
};

try {
  const notice = toast('可手动关闭的通知', { duration: 3600 });
  const autoTimerId = [...timers.keys()][0];
  assert.ok(autoTimerId, '自动关闭必须登记自己的 timer');
  const close = notice.el.querySelector('.toast-close');
  assert.ok(close, '通知必须提供关闭按钮');

  close.click();

  assert.ok(cleared.includes(autoTimerId),
    '手动关闭必须取消该通知尚未触发的自动关闭 timer');
  assert.equal(timers.size, 1,
    '手动关闭后只能保留一次性的离场动画 timer');
  assert.deepEqual([...timers.values()].map(timer => timer.delay), [180]);
} finally {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}

console.log('web toast timer ownership tests passed');
