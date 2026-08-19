import assert from 'node:assert/strict';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

class MemoryStorage {
  #values = new Map();
  get length() { return this.#values.size; }
  key(index) { return [...this.#values.keys()][index] ?? null; }
  getItem(key) { return this.#values.get(String(key)) ?? null; }
  setItem(key, value) { this.#values.set(String(key), String(value)); }
  removeItem(key) { this.#values.delete(String(key)); }
}

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || '').toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    this.hidden = false;
    this.title = '';
    this.classList = {
      toggle: (name, enabled) => {
        const classes = new Set(String(this.className || '').split(/\s+/).filter(Boolean));
        if (enabled) classes.add(name);
        else classes.delete(name);
        this.className = [...classes].join(' ');
      },
    };
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(String(name));
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  append(...children) {
    for (const child of children.flat(Infinity)) {
      if (child !== null && child !== undefined && child !== false) this.children.push(child);
    }
  }

  appendChild(child) {
    this.append(child);
    return child;
  }

  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }
}

globalThis.location = new URL('http://wx-summary.test/#/settings');
globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage();
const createdNodes = [];
globalThis.document = {
  createElement(tag) {
    const node = new FakeNode(tag);
    createdNodes.push(node);
    return node;
  },
};

const { createOutputSection } = await createBrowserModuleLoader().load('js/pages/settings/output.js');
const page = {
  api: {},
  ui: {},
  getSettings: () => ({
    render: { default_theme: 'auto', default_font_size: 'normal' },
    output: { dir: './outputs/digests', retention_days: 0, filename_pattern: '{group}' },
  }),
  getOutputDirIdentity: () => 'render-options-output',
  isBusy: () => false,
  markDirty() {},
  beginAction() { return { signal: new AbortController().signal }; },
  alive() { return true; },
  endAction() {},
};

createOutputSection(page);
const labels = createdNodes
  .filter(node => String(node.className || '').split(/\s+/).includes('segmented-btn'))
  .map(node => node.textContent);
assert.deepEqual(labels, ['跟随系统', '浅色', '深色', '标准', '大'],
  '输出设置只能展示渲染器支持的 auto/light/dark 与 normal/large 选项');

console.log('web settings output render options tests passed');
