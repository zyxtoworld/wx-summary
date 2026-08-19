import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/web/public/js/pages/history/index.js', import.meta.url),
  'utf8',
);

function extractFunction(marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `生产历史页必须包含 ${marker}`);
  const open = source.indexOf('{', start + marker.length);
  assert.ok(open >= 0, `${marker} 必须有函数体`);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '`' || char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${marker} 函数体未闭合`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const documentEvents = [];
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: {
    activeElement: null,
    body: {},
    createElement(tag) {
      documentEvents.push(['createElement', tag]);
      return { className: '', alt: '', src: '' };
    },
  },
});

try {
  const generatePreviewSource = extractFunction('async function generatePreview()');

  function createPreviewHarness({ encodeDeferred = null, uploadDeferred = null } = {}) {
    const controller = new AbortController();
    const state = {
      controller,
      digest: { digest_id: 'digest-rerender' },
      selection: { theme: 'dark', fontSize: 'normal', accentColor: '#07c160' },
      rerenderInputVersion: 'a'.repeat(64),
      preview: null,
      restore: false,
      busy: false,
    };
    const page = { destroyed: false };
    const item = { digest_id: 'digest-rerender' };
    const previewBtn = { disabled: false };
    const saveBtn = { disabled: true };
    const optionsRow = { querySelectorAll: () => [] };
    const previewSlot = { replaceChildren: (...children) => record('dom', children.length) };
    const events = [];
    let closed = false;
    let uploadCalls = 0;
    let objectUrlCalls = 0;
    let focusWrites = 0;

    function record(kind, value = '') {
      events.push({ kind, value, afterClose: closed });
    }

    const generatePreview = new Function(
      'state',
      'page',
      'item',
      'previewBtn',
      'saveBtn',
      'optionsRow',
      'previewSlot',
      'captureActionFocus',
      'setBusy',
      'setStatus',
      'renderHistoryDigestCanvas',
      'RERENDER_PREVIEW_EXPECTED_WIDTH',
      'canvasToValidatedPngBytes',
      'historyItemStableKey',
      'itemRerenderFileVersion',
      'api',
      'RERENDER_HTTP_TIMEOUT_MS',
      'selectionKey',
      'URL',
      'el',
      'isMutationOutcomeUnknown',
      'restoreActionFocus',
      `${generatePreviewSource}; return generatePreview;`,
    )(
      state,
      page,
      item,
      previewBtn,
      saveBtn,
      optionsRow,
      previewSlot,
      () => previewBtn,
      flag => { state.busy = flag; record('busy', flag); },
      (text, tone = '') => record('status', `${tone}:${text}`),
      () => ({
        canvas: {},
        width: 800,
        theme: 'dark',
        fontSize: 'normal',
        accentColor: '#07c160',
      }),
      800,
      () => encodeDeferred?.promise || Promise.resolve(new Uint8Array([1, 2, 3])),
      () => 'history-key',
      () => '',
      {
        postRaw() {
          uploadCalls += 1;
          return uploadDeferred?.promise || Promise.resolve({
            rerender_input_version: state.rerenderInputVersion,
            cache: { stored: true },
          });
        },
      },
      60000,
      () => JSON.stringify(state.selection),
      {
        createObjectURL() {
          objectUrlCalls += 1;
          return 'blob:rerender-preview';
        },
        revokeObjectURL() {},
      },
      () => ({}),
      () => false,
      () => { focusWrites += 1; record('focus'); },
    );

    return {
      state,
      events,
      generatePreview,
      close() {
        closed = true;
        controller.abort(new Error('重渲染弹层已关闭'));
      },
      get uploadCalls() { return uploadCalls; },
      get objectUrlCalls() { return objectUrlCalls; },
      get focusWrites() { return focusWrites; },
    };
  }

  // A: Canvas 编码忽略 abort 并晚到；关闭后不得继续上传预览或恢复焦点。
  {
    const encode = deferred();
    const harness = createPreviewHarness({ encodeDeferred: encode });
    const pending = harness.generatePreview();
    await nextTurn();
    harness.close();
    encode.resolve(new Uint8Array([1, 2, 3]));
    await pending;
    assert.equal(harness.uploadCalls, 0,
      '编码期间关闭重渲染弹层后，晚到 PNG 不得启动预览上传');
    assert.equal(harness.objectUrlCalls, 0);
    assert.equal(harness.focusWrites, 0, '关闭弹层后不得恢复已失效按钮焦点');
    assert.deepEqual(harness.events.filter(event => event.afterClose), [],
      '编码晚到不得在关闭后写 busy/status/DOM/focus');
  }

  // B: 预览上传忽略 abort 并晚到；关闭后不得创建 URL、替换预览 DOM 或写状态。
  {
    const upload = deferred();
    const harness = createPreviewHarness({ uploadDeferred: upload });
    const pending = harness.generatePreview();
    await nextTurn();
    assert.equal(harness.uploadCalls, 1, '预览上传必须已进入在途状态');
    harness.close();
    upload.resolve({
      rerender_input_version: harness.state.rerenderInputVersion,
      cache: { stored: true },
    });
    await pending;
    assert.equal(harness.objectUrlCalls, 0, '上传晚到不得创建预览 ObjectURL');
    assert.equal(harness.state.preview, null, '上传晚到不得提交已关闭弹层的预览状态');
    assert.equal(harness.focusWrites, 0);
    assert.deepEqual(harness.events.filter(event => event.afterClose), [],
      '上传晚到不得在关闭后写 busy/status/DOM/focus');
  }

  const commitSaveSource = extractFunction('async function commitSave()');
  {
    const controller = new AbortController();
    const selection = { theme: 'dark', fontSize: 'normal', accentColor: '#07c160' };
    const state = {
      controller,
      selection,
      rerenderInputVersion: 'b'.repeat(64),
      preview: {
        renderKey: JSON.stringify(selection),
        cache: { preview_token: 'preview-token', preview_sha256: 'c'.repeat(64) },
      },
      restore: false,
      busy: false,
    };
    const page = { destroyed: false, pendingRerender: 0, detail: {} };
    const saveBtn = { disabled: false };
    const statusLine = { appendChild: () => record('dom') };
    const action = deferred();
    const events = [];
    let closed = false;
    let modalCloseCalls = 0;
    let applyCalls = 0;
    let focusWrites = 0;
    function record(kind, value = '') {
      events.push({ kind, value, afterClose: closed });
    }
    const modal = {
      el: { isConnected: true },
      close() { modalCloseCalls += 1; record('modal-close'); },
    };
    const commitSave = new Function(
      'state',
      'page',
      'item',
      'saveBtn',
      'statusLine',
      'captureActionFocus',
      'setBusy',
      'setStatus',
      'selectionKey',
      'invalidatePreview',
      'actions',
      'RERENDER_HTTP_TIMEOUT_MS',
      'ui',
      'applyOutcomeItem',
      'modal',
      'restoreHistoryDetailActionFocus',
      'setDetailStatus',
      'el',
      'openEvidenceModal',
      'restoreActionFocus',
      `${commitSaveSource}; return commitSave;`,
    )(
      state,
      page,
      { digest_id: 'digest-rerender' },
      saveBtn,
      statusLine,
      () => saveBtn,
      flag => { state.busy = flag; record('busy', flag); },
      (text, tone = '') => record('status', `${tone}:${text}`),
      () => JSON.stringify(state.selection),
      () => record('invalidate-preview'),
      { commitRerender: () => action.promise },
      60000,
      {
        toastSuccess: message => record('toast-success', message),
      },
      () => { applyCalls += 1; record('apply'); },
      modal,
      () => { focusWrites += 1; record('detail-focus'); },
      (message, tone) => record('detail-status', `${tone}:${message}`),
      () => ({}),
      () => record('evidence-modal'),
      () => { focusWrites += 1; record('focus'); },
    );

    const pending = commitSave();
    await nextTurn();
    assert.equal(page.pendingRerender, 1, '保存提交必须已进入在途状态');
    closed = true;
    modal.el.isConnected = false;
    controller.abort(new Error('重渲染弹层已关闭'));
    action.resolve({ status: 'verified', message: '保存完成', item: { digest_id: 'digest-new' } });
    await pending;
    assert.equal(page.pendingRerender, 0, '关闭后旧保存仍必须释放页面离开守卫计数');
    assert.equal(applyCalls, 0, '保存晚到不得更新历史列表或广播变更');
    assert.equal(modalCloseCalls, 0, '已关闭弹层不得被旧保存结果再次关闭');
    assert.equal(focusWrites, 0, '保存晚到不得恢复弹层或详情焦点');
    assert.deepEqual(events.filter(event => event.afterClose), [],
      '保存晚到不得在关闭后写 DOM/toast/status/busy/focus');
  }
} finally {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete globalThis.document;
}

assert.deepEqual(documentEvents, [],
  '三个关闭时序均不得在晚到响应后创建预览 DOM');

console.log('web history rerender modal async lifecycle tests passed');
