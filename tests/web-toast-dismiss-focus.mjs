import assert from 'node:assert/strict';
import { toast } from '../src/web/public/js/ui/toast.js';

class FakeElement {
  constructor(tagName, documentTarget) {
    this.tagName = String(tagName || '').toUpperCase();
    this.ownerDocument = documentTarget;
    this.children = [];
    this.parentElement = null;
    this.className = '';
    this.textContent = '';
    this.type = '';
    this.attributes = new Map();
    this.listeners = new Map();
    this.focusCalls = [];
    this.dataset = {};
    this.style = {
      properties: new Map(),
      setProperty(name, value) { this.properties.set(name, String(value)); },
    };
    this.classList = {
      add: name => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        names.add(name);
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
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  click() { this.listeners.get('click')?.({ target: this }); }
  focus(options) {
    this.focusCalls.push(options);
    this.ownerDocument.activeElement = this;
  }
  contains(node) {
    return node === this || this.children.some(child => child.contains(node));
  }
  querySelector(selector) {
    if (selector === '.toast-close' && this.className.split(/\s+/).includes('toast-close')) return this;
    for (const child of this.children) {
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
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
  get previousElementSibling() {
    if (!this.parentElement) return null;
    const index = this.parentElement.children.indexOf(this);
    return index > 0 ? this.parentElement.children[index - 1] : null;
  }
  get nextElementSibling() {
    if (!this.parentElement) return null;
    const index = this.parentElement.children.indexOf(this);
    return index >= 0 ? this.parentElement.children[index + 1] || null : null;
  }
  get isConnected() {
    return this === this.ownerDocument.body || !!this.parentElement?.isConnected;
  }
}

const documentTarget = {
  activeElement: null,
  createElement(tag) { return new FakeElement(tag, this); },
  getElementById(id) {
    const find = node => {
      if (node.getAttribute?.('id') === id || node.id === id) return node;
      for (const child of node.children || []) {
        const found = find(child);
        if (found) return found;
      }
      return null;
    };
    return find(this.body);
  },
};
documentTarget.body = new FakeElement('body', documentTarget);
documentTarget.documentElement = new FakeElement('html', documentTarget);
documentTarget.activeElement = documentTarget.body;
globalThis.document = documentTarget;

const first = toast('第一条', { duration: 0 });
const second = toast('第二条', { type: 'error', duration: 0 });
const toastRoot = documentTarget.getElementById('toast-root');
assert.equal(toastRoot.getAttribute('aria-live'), null, '通知容器只负责布局，不能嵌套第二层 live region');
assert.equal(first.el.getAttribute('role'), 'status');
assert.equal(first.el.getAttribute('aria-live'), 'polite');
assert.equal(first.el.getAttribute('aria-atomic'), 'true');
assert.equal(second.el.getAttribute('role'), 'alert', '错误通知必须立即播报');
assert.equal(second.el.getAttribute('aria-live'), 'assertive');
assert.equal(second.el.getAttribute('aria-atomic'), 'true');
const firstClose = first.el.querySelector('.toast-close');
const secondClose = second.el.querySelector('.toast-close');
secondClose.focus();
secondClose.click();
await new Promise(resolve => setTimeout(resolve, 220));

assert.equal(documentTarget.getElementById('toast-root').children.length, 1);
assert.equal(documentTarget.activeElement, firstClose, '关闭聚焦通知后必须把焦点交给相邻通知的关闭按钮');
assert.deepEqual(firstClose.focusCalls.at(-1), { preventScroll: false }, '相邻通知必须滚入可视区域');

const third = toast('第三条', { duration: 0 });
const thirdClose = third.el.querySelector('.toast-close');
const outside = new FakeElement('button', documentTarget);
documentTarget.body.appendChild(outside);
thirdClose.focus();
thirdClose.click();
outside.focus();
await new Promise(resolve => setTimeout(resolve, 220));

assert.equal(documentTarget.activeElement, outside, '关闭动画期间用户已移焦时不得抢回通知焦点');

const raceFirst = toast('交错第一条', { duration: 0 });
const raceSecond = toast('交错第二条', { duration: 0 });
const raceFirstClose = raceFirst.el.querySelector('.toast-close');
const raceSecondClose = raceSecond.el.querySelector('.toast-close');
raceFirstClose.focus();
raceFirstClose.click();
raceSecondClose.focus();
raceSecondClose.click();
documentTarget.body.focus();
await new Promise(resolve => setTimeout(resolve, 190));

assert.equal(
  raceSecondClose.focusCalls.length,
  1,
  '旧通知的延迟收尾不得把焦点交给已经开始离场的新通知',
);

console.log('web toast dismiss focus tests passed');
