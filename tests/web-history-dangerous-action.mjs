import assert from 'node:assert/strict';
import { revalidateHistoryActionTarget } from '../src/web/public/js/pages/history/action-guard.js';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

const original = { history_item_key: 'history-key-1', file_version: 'v1' };
let current = original;

const refreshed = await revalidateHistoryActionTarget({
  captured: original,
  getCurrent: () => current,
  revalidate: async item => ({ ...item, file_version: 'v2' }),
  validate: item => ({ ok: item.file_version === 'v2' }),
});
assert.deepEqual(refreshed, { ok: true, code: '', item: { history_item_key: 'history-key-1', file_version: 'v2' } });

current = { history_item_key: 'history-key-2' };
const changedBefore = await revalidateHistoryActionTarget({
  captured: original,
  getCurrent: () => current,
  revalidate: async () => original,
});
assert.equal(changedBefore.code, 'target_changed');

current = original;
let resolve;
const pending = revalidateHistoryActionTarget({
  captured: original,
  getCurrent: () => current,
  revalidate: () => new Promise(done => { resolve = done; }),
});
current = { history_item_key: 'history-key-2' };
resolve({ ...original, file_version: 'v3' });
assert.equal((await pending).code, 'target_changed', '重验期间目标变化不得继续危险操作');

current = original;
const rejected = await revalidateHistoryActionTarget({
  captured: original,
  getCurrent: () => current,
  revalidate: async () => original,
  validate: () => ({ ok: false, code: 'version_changed', reason: '版本已变化' }),
});
assert.deepEqual(rejected, {
  ok: false,
  code: 'version_changed',
  reason: '版本已变化',
  item: original,
});

class FakeNode {
  constructor(tagName, ownerDocument, text = '') {
    this.tagName = String(tagName || '').toUpperCase();
    this.ownerDocument = ownerDocument;
    this.nodeType = this.tagName === '#DOCUMENT-FRAGMENT' ? 11 : 1;
    this.children = [];
    this.parentElement = null;
    this.className = '';
    this.textContent = String(text || '');
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = {
      add: (...names) => names.forEach(name => this._toggleClass(name, true)),
      remove: (...names) => names.forEach(name => this._toggleClass(name, false)),
      toggle: (name, force) => {
        const next = force === undefined ? !this.classList.contains(name) : force === true;
        this._toggleClass(name, next);
        return next;
      },
      contains: name => this.className.split(/\s+/).includes(name),
    };
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.type = '';
    this.title = '';
    this.download = '';
  }

  _toggleClass(name, present) {
    const names = new Set(this.className.split(/\s+/).filter(Boolean));
    if (present) names.add(name);
    else names.delete(name);
    this.className = [...names].join(' ');
  }

  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }

  appendChild(node) {
    if (!node) return node;
    if (node.nodeType === 11) {
      for (const child of [...node.children]) this.appendChild(child);
      node.children = [];
      return node;
    }
    if (node.parentElement) {
      const index = node.parentElement.children.indexOf(node);
      if (index >= 0) node.parentElement.children.splice(index, 1);
    }
    node.parentElement = this;
    this.children.push(node);
    return node;
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...nodes);
  }

  setAttribute(name, value) {
    const normalized = String(name);
    const text = String(value);
    this.attributes.set(normalized, text);
    if (normalized === 'id') this.id = text;
  }

  getAttribute(name) { return this.attributes.get(String(name)) ?? null; }

  addEventListener(type, listener) { this.listeners.set(String(type), listener); }

  removeEventListener(type, listener) {
    if (this.listeners.get(String(type)) === listener) this.listeners.delete(String(type));
  }

  click() {
    if (this.disabled) return undefined;
    if (this.tagName === 'A') this.ownerDocument.downloadClicks?.push(this);
    return this.listeners.get('click')?.({
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() {},
    });
  }

  focus() { this.ownerDocument.activeElement = this; }

  contains(node) {
    return node === this || this.children.some(child => child.contains(node));
  }

  _matchesSimple(selector) {
    const clean = String(selector || '').trim();
    if (!clean) return false;
    const descendant = clean.match(/^(.*)\s+([.#\[][^ ]+|[a-z][a-z0-9-]*)$/i);
    if (descendant) {
      if (!this._matchesSimple(descendant[2])) return false;
      let parent = this.parentElement;
      while (parent) {
        if (parent._matchesSimple(descendant[1])) return true;
        parent = parent.parentElement;
      }
      return false;
    }
    if (clean.startsWith('.')) return this.classList.contains(clean.slice(1));
    if (clean.startsWith('#')) return this.id === clean.slice(1);
    const attr = clean.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    if (attr) {
      const name = attr[1];
      const value = name.startsWith('data-')
        ? this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]
        : this.getAttribute(name);
      return value !== undefined && value !== null
        && (attr[2] === undefined || String(value) === attr[2]);
    }
    return this.tagName.toLowerCase() === clean.toLowerCase();
  }

  matches(selector) { return this._matchesSimple(selector); }

  querySelectorAll(selector) {
    const selectors = String(selector || '').split(',').map(item => item.trim()).filter(Boolean);
    const result = [];
    const visit = node => {
      for (const child of node.children) {
        if (selectors.some(candidate => child.matches(candidate))) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }

  get isConnected() {
    if (this === this.ownerDocument.body || this === this.ownerDocument.documentElement) return true;
    return !!this.parentElement?.isConnected;
  }
}

const VALID_TEST_PNG = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10,
  0, 0, 0, 13, 73, 72, 68, 82,
  0, 0, 0, 1, 0, 0, 0, 1,
  73, 69, 78, 68, 174, 66, 96, 130,
]);

class FakeCanvasNode extends FakeNode {
  constructor(ownerDocument) {
    super('canvas', ownerDocument);
    this.width = 0;
    this.height = 0;
  }

  getContext() {
    return {
      measureText: value => ({ width: String(value || '').length * 8 }),
      beginPath() {},
      moveTo() {},
      arcTo() {},
      closePath() {},
      arc() {},
      fill() {},
      fillRect() {},
      fillText() {},
      scale() {},
    };
  }

  toBlob(callback) {
    if (this.ownerDocument.deferCanvasEncoding) {
      this.ownerDocument.canvasBlobRequests.push({ callback });
      return;
    }
    callback(new Blob([VALID_TEST_PNG], { type: 'image/png' }));
  }
}

function createFakeBrowser() {
  const listeners = new Map();
  const documentTarget = {
    activeElement: null,
    createElement(tagName) {
      return String(tagName).toLowerCase() === 'canvas'
        ? new FakeCanvasNode(documentTarget)
        : new FakeNode(tagName, documentTarget);
    },
    createDocumentFragment() { return new FakeNode('#document-fragment', documentTarget); },
    createTextNode(text) { return new FakeNode('#text', documentTarget, text); },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    querySelectorAll(selector) { return documentTarget.body.querySelectorAll(selector); },
    querySelector(selector) { return documentTarget.body.querySelector(selector); },
  };
  documentTarget.canvasBlobRequests = [];
  documentTarget.deferCanvasEncoding = false;
  documentTarget.downloadClicks = [];
  documentTarget.body = new FakeNode('body', documentTarget);
  documentTarget.documentElement = new FakeNode('html', documentTarget);
  documentTarget.activeElement = documentTarget.body;

  const windowTarget = {
    addEventListener(type, listener) { listeners.set(`window:${type}`, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(`window:${type}`) === listener) listeners.delete(`window:${type}`);
    },
  };
  const storageData = new Map();
  const storage = {
    writes: [],
    getItem(key) { return storageData.get(String(key)) ?? null; },
    setItem(key, value) {
      storage.writes.push({ key: String(key), value: String(value) });
      storageData.set(String(key), String(value));
    },
    removeItem(key) { storageData.delete(String(key)); },
    clear() { storageData.clear(); },
  };
  return { documentTarget, windowTarget, storage };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flushHistoryTasks() {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setImmediate(resolve));
}

async function waitForHistory(condition, message) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return;
    await flushHistoryTasks();
  }
  assert.fail(message);
}

async function runConfirmDeleteScenario(mode) {
  const browser = createFakeBrowser();
  const originalAbortController = globalThis.AbortController;
  const trackedControllers = [];
  class TrackingAbortController extends originalAbortController {
    constructor() {
      super();
      this.abortCalls = 0;
      trackedControllers.push(this);
    }

    abort(reason) {
      this.abortCalls += 1;
      return super.abort(reason);
    }
  }
  globalThis.AbortController = TrackingAbortController;
  const objectUrlCalls = [];
  const originalUrlMethods = {
    createObjectURL: globalThis.URL?.createObjectURL,
    revokeObjectURL: globalThis.URL?.revokeObjectURL,
  };
  if (globalThis.URL) {
    globalThis.URL.createObjectURL = blob => {
      const url = `blob:history-test-${objectUrlCalls.length + 1}`;
      objectUrlCalls.push({ kind: 'create', blob, url });
      return url;
    };
    globalThis.URL.revokeObjectURL = url => {
      objectUrlCalls.push({ kind: 'revoke', url });
    };
  }
  const originalGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    localStorage: globalThis.localStorage,
    location: globalThis.location,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    CSS: globalThis.CSS,
    AbortController: originalAbortController,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  globalThis.document = browser.documentTarget;
  globalThis.window = browser.windowTarget;
  globalThis.localStorage = browser.storage;
  globalThis.location = { origin: 'http://history.test', hash: '#/history' };
  globalThis.requestAnimationFrame = callback => {
    callback();
    return 0;
  };
  globalThis.CSS = { escape: value => String(value) };

  const isDownload = mode.startsWith('download-');
  const isViewer = mode.startsWith('viewer-');
  const isSource = mode.startsWith('source-');
  const isExport = mode.startsWith('export-');
  const isRerender = mode.startsWith('rerender-');
  const isRerenderCanvasClose = mode === 'rerender-canvas-close';
  const isRerenderPreviewClose = mode === 'rerender-preview-close';
  const isRerenderSaveClose = mode === 'rerender-save-close';
  const isActionEmphasis = mode === 'action-emphasis';
  const isThumbWatcherDedup = mode === 'thumb-watcher-dedup';
  const rejectSource = mode.includes('-reject');
  const rejectExport = mode.includes('-reject');
  const isViewerRepeat = mode.includes('repeat');
  const isMarkdownDownload = (isDownload || isViewer) && mode.includes('markdown');
  const isMarkdownItemScenario = isMarkdownDownload || isSource;
  const closesDownload = mode.endsWith('-close');
  const closesDuringBody = mode.endsWith('-body-close');
  const rejectsDownload = mode.endsWith('-cancel');
  const switchesAccount = mode.endsWith('-account-switch');
  browser.documentTarget.deferCanvasEncoding = isRerenderCanvasClose;
  const activeIntervals = new Map();
  let nextIntervalId = 0;
  if (isThumbWatcherDedup) {
    globalThis.setInterval = callback => {
      const id = ++nextIntervalId;
      activeIntervals.set(id, callback);
      return id;
    };
    globalThis.clearInterval = id => activeIntervals.delete(id);
  }
  const itemA = {
    digest_id: 'digest-a',
    history_item_key: 'history-a',
    group: 'A',
    relative_path: isMarkdownItemScenario ? 'a.md' : 'a.png',
    file_exists: isActionEmphasis || isDownload || isViewer || isSource || isExport || isRerender || isThumbWatcherDedup,
    ...(isMarkdownItemScenario ? { artifact_type: 'text_preview_md' } : {}),
    file_version: isActionEmphasis ? '' : 'file-a',
    ...(isActionEmphasis ? { file_version_unknown: true } : {}),
    digest_exists: true,
    digest_file_version: 'digest-a-v1',
    output_dir_identity: 'out-v1',
    export_policy_revision: 'policy-v1',
    history_current: true,
  };
  const itemB = { ...itemA, digest_id: 'digest-b', history_item_key: 'history-b', group: 'B', relative_path: 'b.png' };
  const items = mode.includes('target-change') ? [itemA, itemB] : [itemA];
  const statusRequests = [];
  const downloadRequests = [];
  const sourceRequests = [];
  const digestRequests = [];
  const previewRequests = [];
  const rerenderRequests = [];
  const thumbRequests = [];
  let deleteCalls = 0;
  let deleteButton = null;
  const deleteBusySnapshots = [];
  const viewerControllersForCleanupAssertion = [];
  const api = {
    get(path, { signal } = {}) {
      if (String(path).startsWith('/api/history?')) {
        return Promise.resolve({ items, total: items.length, total_exact: true, has_more: false });
      }
      if (String(path).startsWith('/api/history-item-status/')) {
        const request = { path: String(path), signal, ...deferred() };
        statusRequests.push(request);
        return request.promise;
      }
      if (String(path).startsWith('/api/digest-thumb/')) {
        const request = { path: String(path), signal, ...deferred() };
        thumbRequests.push(request);
        return request.promise;
      }
      if (String(path).includes('/api/history-markdown-source/')) {
        const request = { path: String(path), signal, ...deferred() };
        sourceRequests.push(request);
        return request.promise;
      }
      if (String(path).includes('/api/history-digest/')) {
        const request = { path: String(path), signal, ...deferred() };
        digestRequests.push(request);
        return request.promise;
      }
      if (String(path).includes('/api/digest-file/') || String(path).includes('/api/output-file')) {
        const request = { path: String(path), signal, ...deferred() };
        downloadRequests.push(request);
        // 故意忽略 abort:覆盖请求实现晚到 resolve 时,生产代码仍必须自行
        // 校验详情身份,不能把 AbortController 当成唯一防线。
        return request.promise;
      }
      return Promise.resolve({});
    },
    post(path, body, options = {}) {
      if (path === '/api/history-delete') {
        deleteCalls += 1;
        deleteBusySnapshots.push(deleteButton?.disabled === true);
        return Promise.resolve({
          digest_id: body.digest_id,
          history_item_key: body.history_item_key,
          local_action_id: body.local_action_id,
          deleted: true,
          cleanup_pending: false,
        });
      }
      if (path === '/api/rerender-history') {
        const request = { path, body, options, ...deferred() };
        rerenderRequests.push(request);
        return request.promise;
      }
      return Promise.resolve({});
    },
    postRaw(path, bytes, headers, options = {}) {
      const request = { path, bytes, headers, options, ...deferred() };
      previewRequests.push(request);
      return request.promise;
    },
  };
  const values = new Map([
    ['account', { id: 'account-a' }],
    ['state', { output_dir_identity: 'out-v1' }],
  ]);
  const subscriptions = new Map();
  const store = {
    get(key) { return values.get(key); },
    set(key, value) {
      values.set(key, value);
      for (const listener of subscriptions.get(key) || []) listener(value);
    },
    subscribe(key, listener) {
      const listenersForKey = subscriptions.get(key) || new Set();
      listenersForKey.add(listener);
      subscriptions.set(key, listenersForKey);
      return () => listenersForKey.delete(listener);
    },
  };
  const modalEntries = new Set();
  const uiEvents = [];
  const recordUiEvent = (kind, ...args) => uiEvents.push({ kind, args });
  const ui = {
    spinner() { return browser.documentTarget.createElement('span'); },
    toast(...args) { recordUiEvent('toast', ...args); },
    toastWarn(...args) { recordUiEvent('toastWarn', ...args); },
    toastError(...args) { recordUiEvent('toastError', ...args); },
    toastSuccess(...args) { recordUiEvent('toastSuccess', ...args); },
    openModal({ content, onClose } = {}) {
      const modalEl = browser.documentTarget.createElement('div');
      if (content) modalEl.appendChild(content);
      browser.documentTarget.body.appendChild(modalEl);
      let closed = false;
      const modal = {
        el: modalEl,
        close() {
          if (closed) return;
          closed = true;
          modalEl.remove();
          onClose?.();
        },
      };
      modalEntries.add(modal);
      return modal;
    },
    confirmDialog() { return Promise.resolve(true); },
  };
  const root = browser.documentTarget.createElement('main');
  browser.documentTarget.body.appendChild(root);
  const moduleLoader = createBrowserModuleLoader();
  const historyPage = await moduleLoader.load('js/pages/history/index.js');
  const cleanup = await historyPage.default.mount(root, {
    api,
    store,
    ui,
    navigate() {},
  });
  let viewerUrlForCleanupAssertion = '';

  try {
    await waitForHistory(
      () => root.querySelectorAll('.history-card-open').length === items.length,
      '历史列表必须先挂载可打开详情的记录',
    );
    const cardButtons = root.querySelectorAll('.history-card-open');
    cardButtons[0].click();
    await waitForHistory(
      () => statusRequests.some(request => request.path.includes('history-a')),
      '打开详情必须发出初始状态核验请求',
    );
    const initialA = [...statusRequests].find(request => request.path.includes('history-a'));
    if (isThumbWatcherDedup) {
      await waitForHistory(() => thumbRequests.length === 1,
        '打开详情时必须启动唯一缩略图请求');
      assert.equal(activeIntervals.size, 1,
        '缩略图 pending 时详情必须只有一个状态 watcher');
      initialA.resolve({ item: itemA });
      await flushHistoryTasks();
      assert.equal(activeIntervals.size, 1,
        '状态重验触发详情重绘时不得为同一 pending 缩略图叠加 watcher');
      thumbRequests[0].resolve(VALID_TEST_PNG);
      await flushHistoryTasks();
      const [, runThumbWatcher] = activeIntervals.entries().next().value;
      runThumbWatcher();
      assert.equal(activeIntervals.size, 0,
        '缩略图进入终态后 watcher 必须立即从详情生命周期中注销');
      [...modalEntries][0]?.close();
      assert.equal(activeIntervals.size, 0,
        '终态 watcher 已注销后关闭详情不得留下或重复建立 interval');
      return;
    }
    initialA.resolve({ item: itemA });
    await flushHistoryTasks();
    const objectUrlCallsBeforeAction = objectUrlCalls.length;

    if (isActionEmphasis) {
      const unavailableOpen = browser.documentTarget.querySelector('[data-history-detail-action="open-image"]');
      const unavailableDelete = browser.documentTarget.querySelector('[data-history-detail-action="delete"]');
      assert.equal(unavailableOpen?.disabled, true, '缺少文件版本时打开原图必须禁用');
      assert.equal(unavailableOpen?.classList.contains('btn-primary'), false,
        '不可用的打开原图不得保留主操作强调');
      assert.equal(unavailableOpen?.classList.contains('btn-ghost'), true,
        '不可用的打开原图必须使用中性按钮语义');
      assert.equal(unavailableDelete?.disabled, true, '缺少文件版本时删除必须禁用');
      assert.equal(unavailableDelete?.classList.contains('btn-danger'), false,
        '不可用的删除不得保留危险操作强调');
      assert.equal(unavailableDelete?.classList.contains('btn-ghost'), true,
        '不可用的删除必须使用中性按钮语义');

      const refreshButton = browser.documentTarget.querySelector('[data-history-detail-action="refresh-status"]');
      refreshButton.click();
      await waitForHistory(
        () => statusRequests.filter(request => request.path.includes('history-a')).length >= 2,
        '刷新状态必须重新核验动作可用性',
      );
      const refreshedItem = { ...itemA, file_version: 'file-a', file_version_unknown: false };
      statusRequests.filter(request => request.path.includes('history-a')).at(-1).resolve({ item: refreshedItem });
      await flushHistoryTasks();
      const availableOpen = browser.documentTarget.querySelector('[data-history-detail-action="open-image"]');
      const availableDelete = browser.documentTarget.querySelector('[data-history-detail-action="delete"]');
      assert.equal(availableOpen?.disabled, false, '文件版本就绪后打开原图必须恢复可用');
      assert.equal(availableOpen?.classList.contains('btn-primary'), true,
        '可用的打开原图必须保留主操作强调');
      assert.equal(availableDelete?.disabled, false, '文件版本就绪后删除必须恢复可用');
      assert.equal(availableDelete?.classList.contains('btn-danger'), true,
        '可用的删除必须保留危险操作强调');
      return;
    }

    if (isSource) {
      const sourceButton = browser.documentTarget.querySelector('[data-history-detail-action="view-markdown-source"]');
      assert.ok(sourceButton, 'MD 详情必须提供查看源摘要动作');
      sourceButton.click();
      await waitForHistory(
        () => sourceRequests.length === 1,
        '查看源摘要必须发出源定位请求',
      );
      const sourceRequest = sourceRequests[0];
      cardButtons[1].click();
      await waitForHistory(
        () => statusRequests.filter(request => request.path.includes('history-b')).length >= 1,
        '切换目标后必须挂载 B 详情并发出核验请求',
      );
      for (const request of statusRequests.filter(request => request.path.includes('history-b'))) {
        request.resolve({ item: itemB });
      }
      await flushHistoryTasks();
      const bModal = [...modalEntries].at(-1);
      assert.ok(bModal?.el?.isConnected, 'B 详情核验完成后必须仍连接在页面');
      const bStatusEl = bModal.el.querySelector('.history-action-status');
      const bStatusBeforeLateSource = bStatusEl?.textContent || '';
      if (rejectSource) {
        sourceRequest.reject(new Error('源定位失败'));
      } else {
        sourceRequest.resolve({
          item: {
            ...itemA,
            digest_id: 'digest-source',
            history_item_key: 'history-source',
            relative_path: 'source.png',
            artifact_type: 'digest_png',
          },
        });
      }
      await flushHistoryTasks();
      assert.equal(sourceRequest.signal?.aborted, true, '切换详情必须中止 A 源定位请求');
      assert.equal(bModal.el.isConnected, true,
        'A 的晚到源定位响应不得关闭或替换 B 详情');
      assert.deepEqual(uiEvents, [], 'A 的晚到源定位失败不得向 B 投影 toast');
      assert.equal(bStatusEl?.textContent || '', bStatusBeforeLateSource,
        'A 的晚到源定位响应不得改写 B 详情状态');
      return;
    }

    if (isExport) {
      const exportButton = browser.documentTarget.querySelector('[data-history-detail-action="export-markdown"]');
      assert.ok(exportButton, 'PNG 详情必须提供导出 MD 动作');
      exportButton.click();
      await waitForHistory(
        () => digestRequests.length === 1,
        '导出 MD 必须先发出原摘要读取请求',
      );
      const digestRequest = digestRequests[0];
      cardButtons[1].click();
      await waitForHistory(
        () => statusRequests.filter(request => request.path.includes('history-b')).length >= 1,
        '切换目标后必须挂载 B 详情并发出核验请求',
      );
      for (const request of statusRequests.filter(request => request.path.includes('history-b'))) {
        request.resolve({ item: itemB });
      }
      await flushHistoryTasks();
      const bModal = [...modalEntries].at(-1);
      assert.ok(bModal?.el?.isConnected, 'B 详情核验完成后必须仍连接在页面');
      const bStatusEl = bModal.el.querySelector('.history-action-status');
      const bStatusBeforeLateExport = bStatusEl?.textContent || '';
      if (rejectExport) digestRequest.reject(new Error('导出失败'));
      else digestRequest.resolve({ digest: { ...itemA, digest_id: 'digest-a', group: 'A' } });
      await flushHistoryTasks();
      assert.equal(digestRequest.signal?.aborted, true, '切换详情必须中止 A 导出预读取请求');
      assert.equal(bModal.el.isConnected, true, 'A 的晚到导出响应不得关闭或替换 B 详情');
      assert.deepEqual(uiEvents, [], 'A 的晚到导出响应不得向 B 投影 toast');
      assert.equal(bStatusEl?.textContent || '', bStatusBeforeLateExport,
        'A 的晚到导出响应不得改写 B 详情状态');
      return;
    }

    if (isRerender) {
      const rerenderButton = browser.documentTarget.querySelector('[data-history-detail-action="rerender"]');
      assert.ok(rerenderButton, 'PNG 详情必须提供重渲染动作');
      rerenderButton.click();
      await waitForHistory(
        () => digestRequests.length === 1,
        '重渲染弹层必须先发出原摘要读取请求',
      );
      const digestRequest = digestRequests[0];
      const rerenderModal = [...modalEntries].at(-1);
      assert.ok(rerenderModal !== [...modalEntries][0], '重渲染必须创建独立弹层');
      const rerenderStatus = rerenderModal.el.querySelector('.history-rerender .history-action-status');
      assert.ok(rerenderStatus, '重渲染弹层必须有状态节点');
      if (isRerenderCanvasClose || isRerenderPreviewClose || isRerenderSaveClose) {
        digestRequest.resolve({
          digest: {
            digest_id: itemA.digest_id,
            group: 'A',
            headline: '测试摘要',
            topics: [{ title: '主题', summary: '摘要内容' }],
            created_at: '2026-01-01T00:00:00.000Z',
          },
          rerender_input_version: 'a'.repeat(64),
          render: { theme: 'light', font_size: 'normal', accent_color: '#07c160' },
        });
        await waitForHistory(
          () => rerenderModal.el.querySelector('.history-rerender-actions button')?.disabled === false,
          '重渲染原摘要读取完成后必须启用预览按钮',
        );
        const previewButton = rerenderModal.el.querySelector('.history-rerender-actions button');
        const previewSlot = rerenderModal.el.querySelector('.history-rerender-preview');
        const previewChildrenBeforeAction = [...previewSlot.children];
        const listCountBeforeAction = root.querySelectorAll('.history-card').length;
        const storageWritesBeforeAction = browser.storage.writes.length;
        previewButton.focus();
        const activeElementBeforeAction = browser.documentTarget.activeElement;
        previewButton.click();
        if (isRerenderCanvasClose) {
          await waitForHistory(
            () => browser.documentTarget.canvasBlobRequests.length === 1,
            '生成预览必须真实进入 Canvas 编码等待点',
          );
          const canvasRequest = browser.documentTarget.canvasBlobRequests[0];
          const statusBeforeClose = { text: rerenderStatus.textContent, className: rerenderStatus.className };
          rerenderModal.close();
          canvasRequest.callback(new Blob([VALID_TEST_PNG], { type: 'image/png' }));
          await flushHistoryTasks();
          assert.equal(previewRequests.length, 0,
            'Canvas 编码期间关闭后不得继续发起预览上传请求');
          assert.equal(objectUrlCalls.length, objectUrlCallsBeforeAction,
            'Canvas 编码期间关闭后的晚到回调不得创建 ObjectURL');
          assert.deepEqual([...previewSlot.children], previewChildrenBeforeAction,
            'Canvas 编码期间关闭后的晚到回调不得改写预览 DOM');
          assert.equal(rerenderStatus.textContent, statusBeforeClose.text,
            'Canvas 编码期间关闭后的晚到回调不得改写弹层状态');
          assert.equal(rerenderStatus.className, statusBeforeClose.className,
            'Canvas 编码期间关闭后的晚到回调不得改写弹层状态样式');
          assert.equal(root.querySelectorAll('.history-card').length, listCountBeforeAction,
            'Canvas 编码期间关闭后的晚到回调不得改写历史列表');
          assert.equal(browser.storage.writes.length, storageWritesBeforeAction,
            'Canvas 编码期间关闭后的晚到回调不得广播列表更新');
          assert.equal(browser.documentTarget.activeElement, activeElementBeforeAction,
            'Canvas 编码期间关闭后的晚到回调不得恢复或改写焦点');
          assert.deepEqual(uiEvents, [], 'Canvas 编码期间关闭后的晚到回调不得产生 toast');
          return;
        }
        await waitForHistory(
          () => previewRequests.length === 1,
          '生成预览必须真实发出预览上传请求',
        );
        const previewRequest = previewRequests[0];
        if (isRerenderPreviewClose) {
          const statusBeforeClose = { text: rerenderStatus.textContent, className: rerenderStatus.className };
          rerenderModal.close();
          assert.equal(previewRequest.options.signal?.aborted, true,
            '关闭重渲染弹层必须中止预览上传请求');
          previewRequest.resolve({
            rerender_input_version: 'a'.repeat(64),
            cache: { stored: true, preview_token: 'preview-a', preview_sha256: 'b'.repeat(64) },
          });
          await flushHistoryTasks();
          assert.equal(objectUrlCalls.length, objectUrlCallsBeforeAction,
            '关闭后的晚到预览响应不得创建 ObjectURL');
          assert.deepEqual([...previewSlot.children], previewChildrenBeforeAction,
            '关闭后的晚到预览响应不得改写预览 DOM');
          assert.equal(rerenderStatus.textContent, statusBeforeClose.text,
            '关闭后的晚到预览响应不得改写弹层状态');
          assert.equal(rerenderStatus.className, statusBeforeClose.className,
            '关闭后的晚到预览响应不得改写弹层状态样式');
          assert.equal(root.querySelectorAll('.history-card').length, listCountBeforeAction,
            '关闭后的晚到预览响应不得改写历史列表');
          assert.equal(browser.storage.writes.length, storageWritesBeforeAction,
            '关闭后的晚到预览响应不得广播列表更新');
          assert.equal(browser.documentTarget.activeElement, activeElementBeforeAction,
            '关闭后的晚到预览响应不得恢复或改写焦点');
          assert.deepEqual(uiEvents, [], '关闭后的晚到预览响应不得产生 toast');
          return;
        }
        previewRequest.resolve({
          rerender_input_version: 'a'.repeat(64),
          cache: { stored: true, preview_token: 'preview-a', preview_sha256: 'b'.repeat(64) },
        });
        await waitForHistory(
          () => rerenderModal.el.querySelectorAll('.history-rerender-actions button')[1]?.disabled === false,
          '预览凭据就绪后必须启用保存按钮',
        );
        const saveButton = rerenderModal.el.querySelectorAll('.history-rerender-actions button')[1];
        const detailModal = [...modalEntries].find(entry => entry !== rerenderModal);
        const detailStatus = detailModal?.el.querySelector('.history-action-status');
        const detailStatusBeforeClose = detailStatus?.textContent || '';
        saveButton.focus();
        const saveActiveElementBeforeClose = browser.documentTarget.activeElement;
        saveButton.click();
        await waitForHistory(
          () => rerenderRequests.length === 1,
          '确认保存必须真实发出重渲染提交请求',
        );
        const rerenderRequest = rerenderRequests[0];
        rerenderModal.close();
        assert.equal(rerenderRequest.options.signal?.aborted, true,
          '关闭重渲染弹层必须中止保存请求');
        rerenderRequest.resolve({
          local_action_id: rerenderRequest.body.local_action_id,
          local_action_committed: true,
          item: { ...itemA, file_version: 'file-a-new' },
        });
        await flushHistoryTasks();
        assert.equal(root.querySelectorAll('.history-card').length, items.length,
          '关闭后的晚到保存响应不得改写历史列表');
        assert.equal(detailStatus?.textContent || '', detailStatusBeforeClose,
          '关闭后的晚到保存响应不得改写详情状态');
        assert.equal(root.querySelectorAll('.history-card').length, listCountBeforeAction,
          '关闭后的晚到保存响应不得改写历史列表');
        assert.equal(browser.storage.writes.length, storageWritesBeforeAction,
          '关闭后的晚到保存响应不得广播列表更新');
        assert.equal(browser.documentTarget.activeElement, saveActiveElementBeforeClose,
          '关闭后的晚到保存响应不得恢复或改写焦点');
        assert.deepEqual(uiEvents, [], '关闭后的晚到保存响应不得产生 toast');
        return;
      }
      const statusBeforeClose = { text: rerenderStatus.textContent, className: rerenderStatus.className };
      rerenderModal.close();
      await flushHistoryTasks();
      digestRequest.reject(new Error('原摘要读取失败'));
      await flushHistoryTasks();
      assert.equal(digestRequest.signal?.aborted, true, '关闭重渲染弹层必须中止原摘要读取请求');
      assert.equal(rerenderModal.el.isConnected, false, '关闭后重渲染弹层必须从 DOM 移除');
      assert.equal(rerenderStatus.textContent, statusBeforeClose.text,
        '关闭后的晚到重渲染错误不得改写已移除弹层状态');
      assert.equal(rerenderStatus.className, statusBeforeClose.className,
        '关闭后的晚到重渲染错误不得改写已移除弹层样式');
      assert.deepEqual(uiEvents, [], '关闭后的晚到重渲染错误不得产生 toast');
      return;
    }

    if (isViewer) {
      const action = isMarkdownDownload ? 'view-markdown' : 'open-image';
      const viewerButton = browser.documentTarget.querySelector(`[data-history-detail-action="${action}"]`);
      assert.ok(viewerButton, `详情必须提供${isMarkdownDownload ? '查看 MD' : '打开原图'}动作`);
      viewerButton.click();
      await waitForHistory(
        () => downloadRequests.length >= 1,
        '查看器必须先发出文件预检请求',
      );
      const viewerController = trackedControllers.find(controller => controller.signal === downloadRequests.at(-1).signal);
      assert.ok(viewerController, '查看器请求必须持有可追踪的局部 controller');
      viewerControllersForCleanupAssertion.push(viewerController);
      const detailModal = [...modalEntries][0];
      const viewerModal = [...modalEntries].at(-1);
      assert.notEqual(viewerModal, detailModal, '查看器必须创建独立子弹层');
      const viewerWrap = viewerModal.el.children[0];
      const viewerChildrenBeforeClose = [...viewerWrap.children];
      const viewerStatusEl = viewerWrap.querySelector('.history-viewer-status');
      const detailStatusEl = detailModal.el.querySelector('.history-action-status');
      assert.ok(viewerStatusEl, '查看器必须有状态节点');
      assert.ok(detailStatusEl, '详情必须有状态节点');
      const viewerStatusBeforeClose = viewerStatusEl.textContent;
      if (isViewerRepeat) {
        const initialRequestStart = downloadRequests.length - 1;
        downloadRequests[initialRequestStart].resolve({ ok: true });
        await waitForHistory(
          () => downloadRequests.length >= initialRequestStart + 2,
          '首个重复 viewer 预检成功后必须读取正文',
        );
        downloadRequests[initialRequestStart + 1].resolve(new Uint8Array([137, 80, 78, 71]));
        if (isMarkdownDownload) {
          await waitForHistory(
            () => !!viewerWrap.querySelector('.history-md-view'),
            '首个重复 MD viewer 必须渲染正文',
          );
        } else {
          await waitForHistory(
            () => objectUrlCalls.slice(objectUrlCallsBeforeAction)
              .filter(call => call.kind === 'create').length === 1,
            '首个重复 PNG viewer 必须创建一个 ObjectURL',
          );
        }
        viewerModal.close();
        await flushHistoryTasks();
        assert.equal(viewerController.abortCalls, 1,
          '关闭首个重复 viewer 必须只中止一次局部 controller');
        for (let repeat = 1; repeat < 3; repeat += 1) {
          const requestStart = downloadRequests.length;
          const repeatButton = browser.documentTarget.querySelector(`[data-history-detail-action="${action}"]`);
          assert.ok(repeatButton, '重复打开 viewer 前必须仍有入口');
          repeatButton.click();
          await waitForHistory(
            () => downloadRequests.length >= requestStart + 1,
            '重复 viewer 必须再次发出预检请求',
          );
          const repeatController = trackedControllers.find(controller => controller.signal === downloadRequests.at(-1).signal);
          assert.ok(repeatController, '重复 viewer 请求必须持有局部 controller');
          viewerControllersForCleanupAssertion.push(repeatController);
          const repeatModal = [...modalEntries].at(-1);
          const repeatWrap = repeatModal.el.children[0];
          downloadRequests[requestStart].resolve({ ok: true });
          await waitForHistory(
            () => downloadRequests.length >= requestStart + 2,
            '重复 viewer 预检成功后必须读取正文',
          );
          downloadRequests[requestStart + 1].resolve(new Uint8Array([137, 80, 78, 71]));
          if (isMarkdownDownload) {
            await waitForHistory(
              () => !!repeatWrap.querySelector('.history-md-view'),
              '重复 MD viewer 必须渲染正文',
            );
          } else {
            await waitForHistory(
              () => objectUrlCalls.slice(objectUrlCallsBeforeAction)
                .filter(call => call.kind === 'create').length === repeat + 1,
              '重复 PNG viewer 必须各创建一个 ObjectURL',
            );
          }
          repeatModal.close();
          await flushHistoryTasks();
          assert.equal(repeatController.abortCalls, 1,
            '关闭重复 viewer 必须只中止一次局部 controller');
        }
        return;
      }
      if (switchesAccount) {
        store.set('account', {
          id: 'account-b',
          manual_key_account_fingerprint: 'b'.repeat(64),
        });
        await flushHistoryTasks();
        for (const request of downloadRequests) {
          request.resolve(new Uint8Array([137, 80, 78, 71]));
        }
        await flushHistoryTasks();
        assert.equal(downloadRequests.length, 1,
          '账号换代期间旧查看器不得启动正文文件请求');
        assert.equal(browser.documentTarget.downloadClicks.length, 0,
          '账号换代后的旧查看器响应不得触发文件下载');
        assert.equal(objectUrlCalls.slice(objectUrlCallsBeforeAction)
          .filter(call => call.kind === 'create').length, 0,
        '账号换代后的旧查看器响应不得创建 ObjectURL');
        assert.deepEqual(uiEvents, [], '账号换代后的旧查看器响应不得产生 toast');
        return;
      }
      if (mode.endsWith('-unmount')) {
        downloadRequests[0].resolve({ ok: true });
        await waitForHistory(
          () => downloadRequests.length >= 2,
          '未关闭 viewer 预检成功后必须读取正文',
        );
        downloadRequests[1].resolve(new Uint8Array([137, 80, 78, 71]));
        await flushHistoryTasks();
        const viewerCalls = objectUrlCalls.slice(objectUrlCallsBeforeAction);
        const viewerCreates = viewerCalls.filter(call => call.kind === 'create');
        assert.equal(viewerCreates.length, isMarkdownDownload ? 0 : 1,
          '未关闭 viewer 成功路径只有 PNG 可以创建 ObjectURL');
        if (viewerCreates[0]) viewerUrlForCleanupAssertion = viewerCreates[0].url;
        return;
      }
      if (mode.endsWith('-success')) {
        downloadRequests[0].resolve({ ok: true });
        await waitForHistory(
          () => downloadRequests.length >= 2,
          'viewer 预检成功后必须读取正文',
        );
        downloadRequests[1].resolve(new Uint8Array([137, 80, 78, 71]));
        if (isMarkdownDownload) {
          await waitForHistory(
            () => !!viewerWrap.querySelector('.history-md-view'),
            'MD viewer 成功后必须渲染正文',
          );
        } else {
          await waitForHistory(
            () => objectUrlCalls.slice(objectUrlCallsBeforeAction)
              .filter(call => call.kind === 'create').length === 1,
            'PNG viewer 成功后必须创建一个 ObjectURL',
          );
        }
        const viewerCalls = objectUrlCalls.slice(objectUrlCallsBeforeAction);
        const viewerCreates = viewerCalls.filter(call => call.kind === 'create');
        const viewerUrl = viewerCreates[0]?.url || '';
        assert.equal(viewerCreates.length, isMarkdownDownload ? 0 : 1,
          '只有 PNG viewer 成功路径可以创建 ObjectURL');
        viewerModal.close();
        await flushHistoryTasks();
        const viewerRevokes = objectUrlCalls.filter(call => call.kind === 'revoke' && call.url === viewerUrl);
        assert.equal(viewerRevokes.length, isMarkdownDownload ? 0 : 1,
          '关闭成功 viewer 必须立即且只释放一次 ObjectURL');
        viewerUrlForCleanupAssertion = viewerUrl;
        return;
      }
      const closeDuringBody = mode.endsWith('-body-close') || mode.endsWith('-body-cancel');
      const rejectDuringBody = mode.endsWith('-body-cancel');
      if (closeDuringBody) {
        downloadRequests[0].resolve({ ok: true });
        await waitForHistory(
          () => downloadRequests.length >= 2,
          '查看器预检成功后必须进入正文读取',
        );
      }
      viewerModal.close();
      assert.equal(viewerButton.disabled, false,
        '关闭查看器必须立即释放详情忙态');
      const refreshButton = detailModal.el.querySelector('[data-history-detail-action="refresh-status"]');
      assert.ok(refreshButton, '关闭查看器后详情必须仍可刷新状态');
      refreshButton.click();
      await waitForHistory(
        () => statusRequests.filter(request => request.path.includes('history-a')).length >= 2,
        '关闭查看器后必须允许启动新的详情动作',
      );
      const refreshRequest = [...statusRequests].filter(request => request.path.includes('history-a')).at(-1);
      assert.equal(refreshButton.disabled, true, '新的详情动作必须持有忙态');
      const detailStatusAfterNewAction = detailStatusEl.textContent;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        for (const request of downloadRequests) {
          if (rejectDuringBody) {
            request.reject(Object.assign(new Error('已取消'), { status: 499 }));
          } else {
            request.resolve(new Uint8Array([137, 80, 78, 71]));
          }
        }
        await flushHistoryTasks();
      }
      assert.equal(downloadRequests.length, closeDuringBody ? 2 : 1,
        closeDuringBody
          ? '正文读取期间关闭查看器后不得启动额外文件请求'
          : '预检期间关闭查看器后不得启动正文文件请求');
      assert.equal(objectUrlCalls.length, objectUrlCallsBeforeAction,
        '关闭查看器后的旧响应不得创建 ObjectURL');
      assert.deepEqual([...viewerWrap.children], viewerChildrenBeforeClose,
        '关闭查看器后的旧响应不得改写已移除 viewer DOM');
      assert.equal(viewerStatusEl.textContent, viewerStatusBeforeClose,
        '关闭查看器后的旧响应不得改写 viewer 状态');
      assert.deepEqual(uiEvents, [], '关闭查看器后的旧响应不得产生 toast');
      assert.equal(refreshButton.disabled, true,
        '旧 viewer 响应不得释放新详情动作的忙态');
      assert.equal(detailStatusEl.textContent, detailStatusAfterNewAction,
        '旧 viewer 响应不得清掉新详情动作状态');
      refreshRequest.resolve({ item: itemA });
      await flushHistoryTasks();
      return;
    }

    if (isDownload) {
      const action = isMarkdownDownload ? 'download-markdown' : 'download-png';
      const downloadButton = browser.documentTarget.querySelector(`[data-history-detail-action="${action}"]`);
      assert.ok(downloadButton, `详情必须提供${isMarkdownDownload ? '下载 MD' : '下载 PNG'}动作`);
      downloadButton.click();
      await waitForHistory(
        () => downloadRequests.length >= 1,
        '下载动作必须先发出文件请求',
      );
      const detailModal = [...modalEntries][0];
      const statusEl = detailModal.el.querySelector('.history-action-status');
      assert.ok(statusEl, '下载动作必须显示详情状态节点');
      const statusBeforeClose = { text: statusEl.textContent, className: statusEl.className };
      if (closesDuringBody) {
        downloadRequests[0].resolve({ ok: true });
        await waitForHistory(
          () => downloadRequests.length >= 2,
          '下载预检成功后必须进入正文读取,才能覆盖正文挂起关闭时序',
        );
        detailModal.close();
        await flushHistoryTasks();
        for (let attempt = 0; attempt < 3; attempt += 1) {
          for (const request of downloadRequests) {
            request.resolve(new Uint8Array([137, 80, 78, 71]));
          }
          await flushHistoryTasks();
        }
        assert.equal(downloadRequests.length, 2,
          '正文读取期间关闭详情后不得再启动额外文件请求');
        assert.equal(downloadRequests[1].signal?.aborted, true,
          '正文读取期间关闭详情必须中止正文请求');
        assert.equal(browser.documentTarget.downloadClicks.length, 0,
          '正文晚到响应不得触发文件下载');
        assert.deepEqual(uiEvents, [], '正文晚到取消不得产生 toast');
        assert.equal(statusEl.textContent, statusBeforeClose.text,
          '正文晚到响应不得改写旧详情状态');
        assert.equal(statusEl.className, statusBeforeClose.className,
          '正文晚到响应不得改写旧详情状态样式');
        return;
      }
      if (closesDownload || rejectsDownload) {
        detailModal.close();
        await flushHistoryTasks();
        for (let attempt = 0; attempt < 3; attempt += 1) {
          for (const request of downloadRequests) {
            if (rejectsDownload) {
              request.reject(Object.assign(new Error('已取消'), { status: 499 }));
            } else {
              request.resolve(new Uint8Array([137, 80, 78, 71]));
            }
          }
          await flushHistoryTasks();
        }
        assert.equal(downloadRequests[0].signal?.aborted, true,
          '关闭详情必须中止下载请求');
        assert.equal(downloadRequests.length, 1,
          '预检期间关闭详情后不得启动正文文件请求');
        assert.equal(browser.documentTarget.downloadClicks.length, 0,
          '关闭详情后晚到下载响应不得触发文件下载');
        assert.deepEqual(uiEvents, [], '关闭详情后的取消不得产生 toast');
        assert.equal(statusEl.textContent, statusBeforeClose.text,
          '关闭详情后的晚到响应不得改写旧详情状态');
        assert.equal(statusEl.className, statusBeforeClose.className,
          '关闭详情后的晚到响应不得改写旧详情状态样式');
        return;
      }
      downloadRequests[0].resolve({ ok: true });
      await waitForHistory(
        () => downloadRequests.length >= 2,
        '下载预检成功后必须读取文件内容',
      );
      downloadRequests[1].resolve(new Uint8Array([137, 80, 78, 71]));
      await waitForHistory(
        () => browser.documentTarget.downloadClicks.length === 1,
        '当前详情下载成功必须触发一次文件下载',
      );
      assert.equal(downloadRequests[0].signal?.aborted, false,
        '当前详情下载预检期间不得被取消');
      assert.equal(downloadRequests[1].signal?.aborted, false,
        '当前详情读取期间不得被取消');
      assert.equal(uiEvents.filter(event => event.kind === 'toastSuccess').length, 1,
        '当前详情下载成功必须提示成功');
      return;
    }

    deleteButton = browser.documentTarget.querySelector('[data-history-detail-action="delete"]');
    assert.ok(deleteButton, '详情必须提供删除动作');
    deleteButton.click();
    await waitForHistory(
      () => statusRequests.filter(request => request.path.includes('history-a')).length >= 2,
      '确认删除后必须发出静默状态核验请求',
    );
    const confirmA = [...statusRequests].filter(request => request.path.includes('history-a')).at(-1);
    assert.equal(deleteButton.disabled, true, '静默核验挂起时必须仍由 confirmDelete 持有忙态');

    if (mode === 'success') {
      confirmA.resolve({ item: { ...itemA, file_version: 'file-a-new' } });
      await waitForHistory(() => deleteCalls === 1, '状态核验成功后删除动作必须真实执行');
      assert.equal(deleteCalls, 1);
      assert.deepEqual(deleteBusySnapshots, [true], '删除请求发出时必须由真正的删除动作重新持有忙态');
    } else if (mode === 'failure') {
      confirmA.reject(new Error('状态核验失败'));
      await flushHistoryTasks();
      assert.equal(deleteCalls, 0, '状态核验失败不得删除历史');
      assert.equal(deleteButton.disabled, false, '失败后必须交还 confirmDelete 自己的忙态');
    } else if (mode === 'cancel') {
      confirmA.reject(Object.assign(new Error('已取消'), { name: 'AbortError' }));
      await flushHistoryTasks();
      assert.equal(deleteCalls, 0, '状态核验取消不得删除历史');
      assert.equal(deleteButton.disabled, false, '取消后必须交还 confirmDelete 自己的忙态');
    } else {
      cardButtons[1].click();
      await waitForHistory(
        () => statusRequests.filter(request => request.path.includes('history-b')).length >= 1,
        '切换目标后必须启动新详情核验',
      );
      const bRefresh = browser.documentTarget.querySelector('[data-history-detail-action="refresh-status"]');
      assert.ok(bRefresh, '新详情必须提供刷新动作');
      bRefresh.click();
      await waitForHistory(
        () => statusRequests.filter(request => request.path.includes('history-b')).length >= 2,
        '新详情的显式刷新必须发出请求',
      );
      confirmA.resolve({ item: itemA });
      await flushHistoryTasks();
      assert.equal(deleteCalls, 0, '目标换代期间旧 confirmDelete 不得删除新目标');
      const bDelete = browser.documentTarget.querySelector('[data-history-detail-action="delete"]');
      assert.equal(bDelete?.disabled, true, '旧 confirmDelete 不得释放新详情的忙态');
      for (const request of statusRequests.filter(request => request.path.includes('history-b'))) {
        request.resolve({ item: itemB });
      }
      await flushHistoryTasks();
    }
  } finally {
    await cleanup?.();
    await historyPage.default.unmount?.();
    root.remove();
    if (viewerUrlForCleanupAssertion) {
      assert.equal(
        objectUrlCalls.filter(call => call.kind === 'revoke' && call.url === viewerUrlForCleanupAssertion).length,
        1,
        '页面 cleanup 不得重复释放已由 viewer 关闭释放的 ObjectURL',
      );
    }
    for (const controller of viewerControllersForCleanupAssertion) {
      assert.equal(controller.abortCalls, 1,
        '已关闭 viewer 的 page cleanup 不得再次调用其 disposer');
    }
    for (const [key, value] of Object.entries(originalGlobals)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
    if (globalThis.URL) {
      if (originalUrlMethods.createObjectURL === undefined) delete globalThis.URL.createObjectURL;
      else globalThis.URL.createObjectURL = originalUrlMethods.createObjectURL;
      if (originalUrlMethods.revokeObjectURL === undefined) delete globalThis.URL.revokeObjectURL;
      else globalThis.URL.revokeObjectURL = originalUrlMethods.revokeObjectURL;
    }
  }
}

await runConfirmDeleteScenario('success');
await runConfirmDeleteScenario('failure');
await runConfirmDeleteScenario('cancel');
await runConfirmDeleteScenario('download-success');
await runConfirmDeleteScenario('download-markdown-success');
await runConfirmDeleteScenario('download-cancel');
await runConfirmDeleteScenario('download-markdown-cancel');
await runConfirmDeleteScenario('download-close');
await runConfirmDeleteScenario('download-markdown-close');
await runConfirmDeleteScenario('download-body-close');
await runConfirmDeleteScenario('download-markdown-body-close');
await runConfirmDeleteScenario('viewer-png-precheck-close');
await runConfirmDeleteScenario('viewer-markdown-precheck-close');
await runConfirmDeleteScenario('viewer-png-account-switch');
await runConfirmDeleteScenario('viewer-png-body-close');
await runConfirmDeleteScenario('viewer-markdown-body-close');
await runConfirmDeleteScenario('viewer-png-body-cancel');
await runConfirmDeleteScenario('viewer-markdown-body-cancel');
await runConfirmDeleteScenario('viewer-png-success');
await runConfirmDeleteScenario('viewer-markdown-success');
await runConfirmDeleteScenario('viewer-png-unmount');
await runConfirmDeleteScenario('viewer-markdown-unmount');
await runConfirmDeleteScenario('source-markdown-target-change-resolve');
await runConfirmDeleteScenario('source-markdown-target-change-reject');
await runConfirmDeleteScenario('export-markdown-target-change-resolve');
await runConfirmDeleteScenario('export-markdown-target-change-reject');
await runConfirmDeleteScenario('rerender-late-reject');
await runConfirmDeleteScenario('rerender-canvas-close');
await runConfirmDeleteScenario('rerender-preview-close');
await runConfirmDeleteScenario('rerender-save-close');
await runConfirmDeleteScenario('target-change');
await runConfirmDeleteScenario('action-emphasis');
await runConfirmDeleteScenario('thumb-watcher-dedup');

console.log('web history dangerous action tests passed');
