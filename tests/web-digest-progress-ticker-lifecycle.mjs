import assert from 'node:assert/strict';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

let stageTimeWrites = 0;

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.className = '';
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.isConnected = true;
    this.listeners = new Map();
    this._textContent = '';
    this._nodes = new Map();
  }

  set textContent(value) {
    if (String(this.className).split(/\s+/).includes('stage-time')) stageTimeWrites += 1;
    this._textContent = String(value ?? '');
  }

  get textContent() {
    return this._textContent;
  }

  set innerHTML(value) {
    this._innerHTML = String(value || '');
    for (const classAttribute of this._innerHTML.matchAll(/class="([^"]+)"/g)) {
      for (const className of classAttribute[1].split(/\s+/).filter(Boolean)) {
        if (!this._nodes.has(`.${className}`)) {
          const node = new FakeElement('div');
          node.className = className;
          this._nodes.set(`.${className}`, node);
        }
      }
    }
  }

  get innerHTML() {
    return this._innerHTML || '';
  }

  querySelector(selector) {
    return this._nodes.get(selector) || null;
  }

  querySelectorAll() {
    return [];
  }

  append(...nodes) {
    for (const node of nodes.filter(Boolean)) {
      node.parent = this;
      this.children.push(node);
    }
  }

  appendChild(node) {
    if (node) {
      node.parent = this;
      this.children.push(node);
    }
    return node;
  }

  insertBefore(node, before) {
    if (!node) return node;
    node.parent = this;
    if (!before) this.children.push(node);
    else this.children.splice(Math.max(0, this.children.indexOf(before)), 0, node);
    return node;
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = nodes.filter(Boolean);
    for (const node of this.children) node.parent = this;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  setAttribute() {}

  after(node) {
    this.parent?.appendChild(node);
  }

  remove() {
    if (this.parent) {
      const index = this.parent.children.indexOf(this);
      if (index >= 0) this.parent.children.splice(index, 1);
      this.parent = null;
    }
    this.isConnected = false;
  }
}

globalThis.location = new URL('http://wx-summary.test/#/digest');
globalThis.document = {
  createElement(tagName) {
    const node = new FakeElement(tagName);
    return node;
  },
};
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.sessionStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };

const loader = createBrowserModuleLoader();
const { createProgressView } = await loader.load('js/pages/digest/progress.js');
const previousSetInterval = globalThis.setInterval;
const previousClearInterval = globalThis.clearInterval;
const timers = [];
const cleared = new Set();
globalThis.setInterval = callback => {
  const id = timers.length + 1;
  timers.push(callback);
  return id;
};
globalThis.clearInterval = id => { cleared.add(id); };

try {
  const view = createProgressView();
  view.onStage({ name: 'context', status: 'running' });
  assert.equal(timers.length, 1, '生成进度卡必须启动一个 ticker');
  const lateTicker = timers[0];
  lateTicker();
  assert.equal(stageTimeWrites > 0, true, 'ticker 必须能更新运行中 stage 的 elapsed DOM');
  stageTimeWrites = 0;
  view.dispose();
  assert.equal(cleared.has(1), true, '进度卡销毁必须清理 ticker');
  lateTicker();
  assert.equal(stageTimeWrites, 0,
    '进度卡销毁后已排队的 ticker 不得再写旧 stage DOM');

  const stageList = view.el._nodes.get('.stage-list');
  const logBox = view.el._nodes.get('.progress-log');
  const count = view.el._nodes.get('.progress-count');
  const current = view.el._nodes.get('.progress-current');
  const stageChildren = stageList.children.length;
  const logChildren = logBox.children.length;
  const countText = count.textContent;
  const currentText = current.textContent;
  view.onStage({ name: 'late-stage', status: 'running', detail: 'late response' });
  view.log('late response');
  view.setTotal(9, 10);
  view.setCurrentGroup('late group');
  view.resetStages();
  view.setTerminal('error');
  assert.equal(stageList.children.length, stageChildren,
    '进度卡销毁后迟到 stage 不得再写旧 DOM');
  assert.equal(logBox.children.length, logChildren,
    '进度卡销毁后迟到日志不得再写旧 DOM');
  assert.equal(count.textContent, countText,
    '进度卡销毁后迟到总进度不得再写旧 DOM');
  assert.equal(current.textContent, currentText,
    '进度卡销毁后迟到群名不得再写旧 DOM');
  assert.equal(view.el.dataset.status, undefined,
    '进度卡销毁后迟到终态不得再写旧 DOM');
} finally {
  globalThis.setInterval = previousSetInterval;
  globalThis.clearInterval = previousClearInterval;
}

{
  const view = createProgressView();
  const stageList = view.el._nodes.get('.stage-list');
  view.onStage({
    name: 'summarizing',
    status: 'running',
    retry_at_ms: Date.now() + 5_000,
    retry_attempt: 1,
    retry_max_attempts: 2,
  });
  assert.equal(
    stageList.children.some(child => String(child.className).split(/\s+/).includes('stage-retry')),
    true,
    '重试中的进度卡必须展示倒计时',
  );
  view.setTerminal('done');
  assert.equal(
    stageList.children.some(child => String(child.className).split(/\s+/).includes('stage-retry')),
    false,
    '进入完成终态时不得保留过期的模型重试倒计时',
  );
  view.dispose();
}

console.log('web digest progress ticker lifecycle tests passed');
