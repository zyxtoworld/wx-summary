import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTextPreviewActionState } from '../src/web/public/js/pages/digest/text-preview-action-state.js';

function extractFunction(sourceText, marker) {
  const start = sourceText.indexOf(marker);
  assert.ok(start >= 0, `必须能定位 ${marker}`);
  const open = sourceText.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '`' || char === '\'' || char === '"') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return sourceText.slice(start, index + 1);
  }
  throw new Error(`${marker} 函数体未闭合`);
}

const source = fs.readFileSync(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');
const start = source.indexOf("downloadBtn.addEventListener('click'");
const end = source.indexOf('// -------------------------------------------------------------------------\n  // 中断恢复', start);
assert.ok(start >= 0 && end > start, '必须能定位文本预览下载动作');
const action = source.slice(start, end);
const listenerEnd = action.indexOf('\n    });');
assert.ok(listenerEnd > 0, '必须能定位文本预览下载 listener 的结束位置');
const downloadListener = action.slice(0, listenerEnd + '\n    });'.length);

assert.match(
  action,
  /const focusTarget = document\.activeElement;[\s\S]*?anchor\.click\(\);[\s\S]*?anchor\.remove\(\);[\s\S]*?focusTarget\?\.isConnected[\s\S]*?focusTarget\.focus\(\{ preventScroll: true \}\)/,
  '临时下载链接触发后必须把焦点恢复到仍存在的原控件',
);

// 浏览器实际执行 click/DOM 挂载时也可能抛异常;临时 anchor 与 ObjectURL
// 必须仍然按一次性清理合同收口,不能只在成功 click 后安排 revoke。
for (const scenario of [
  { clickThrows: false, createThrows: false },
  { clickThrows: true, createThrows: false },
  { clickThrows: false, createThrows: true },
]) {
  const { clickThrows, createThrows } = scenario;
  const textPreviewAction = createTextPreviewActionState();
  const downloadButton = {
    listener: null,
    addEventListener(type, listener) {
      assert.equal(type, 'click');
      this.listener = listener;
    },
  };
  let downloadClicks = 0;
  let timerCalls = 0;
  const anchor = {
    href: '',
    download: '',
    removed: false,
    click() {
      downloadClicks += 1;
      if (clickThrows) throw new Error('浏览器拒绝触发下载');
    },
    remove() { this.removed = true; },
  };
  const documentTarget = {
    activeElement: downloadButton,
    body: { appendChild() {} },
    createElement(tag) {
      assert.equal(tag, 'a');
      return anchor;
    },
  };
  const urlApi = {
    createObjectURL() {
      if (createThrows) throw new Error('浏览器无法创建下载地址');
      return `blob:text-preview-${clickThrows ? 'error' : 'ok'}`;
    },
    revokeObjectURL(url) { this.revoked = [...(this.revoked || []), url]; },
    revoked: [],
  };
  const toastErrors = [];
  const releaseAction = current => textPreviewAction.end(current);
  const listener = new Function(
    'downloadBtn',
    'browserDownloadCapability',
    'browserDownloadUnsupportedMessage',
    'document',
    'page',
    'textPreviewAction',
    'syncActionButtons',
    'syncTextPreviewActionControls',
    'restoreActionFocus',
    'releaseAction',
    'URL',
    'setTimeout',
    'globalThis',
    'ui',
    `${downloadListener}; return downloadBtn.listener;`,
  )(
    downloadButton,
    () => ({ supported: true }),
    () => '',
    documentTarget,
    { destroyed: false, previewMarkdown: '# A' },
    textPreviewAction,
    () => {},
    () => {},
    () => {},
    releaseAction,
    urlApi,
    callback => { timerCalls += 1; callback(); return timerCalls; },
    { document: documentTarget },
    { toastError(message) { toastErrors.push(message); } },
  );

  assert.doesNotThrow(() => listener(),
    `${createThrows ? 'ObjectURL 创建失败' : clickThrows ? '浏览器拒绝触发下载' : '下载成功'}不得冒泡为未捕获异常`);
  assert.equal(downloadClicks, createThrows ? 0 : 1);
  assert.equal(anchor.removed, !createThrows,
    `${createThrows ? 'ObjectURL 创建失败' : clickThrows ? '下载失败' : '下载成功'}后临时 anchor 清理状态必须准确`);
  assert.deepEqual(
    urlApi.revoked,
    createThrows ? [] : [`blob:text-preview-${clickThrows ? 'error' : 'ok'}`],
    `${createThrows ? 'ObjectURL 创建失败' : clickThrows ? '下载失败' : '下载成功'}后 ObjectURL 必须按创建事实恰好清理一次`,
  );
  assert.equal(timerCalls, createThrows ? 0 : 1,
    `${createThrows ? 'ObjectURL 创建失败' : clickThrows ? '下载失败' : '下载成功'}后 URL 清理计时器数量必须按创建事实计算`);
  assert.deepEqual(
    toastErrors,
    createThrows ? ['浏览器无法创建下载地址'] : clickThrows ? ['浏览器拒绝触发下载'] : [],
    '下载失败必须投影可操作错误,成功不得误报错误',
  );
  assert.equal(textPreviewAction.isBusy(), false,
    `${createThrows ? 'ObjectURL 创建失败' : clickThrows ? '下载失败' : '下载成功'}后 action lease 必须释放`);
}

const historySource = fs.readFileSync(new URL('../src/web/public/js/pages/history/index.js', import.meta.url), 'utf8');
const historyDownloadBlobSource = extractFunction(historySource, 'function downloadBlob(');
for (const clickThrows of [false, true]) {
  let timerCalls = 0;
  const revoked = [];
  const anchor = {
    removed: false,
    click() {
      if (clickThrows) throw new Error('浏览器拒绝触发下载');
    },
    remove() { this.removed = true; },
  };
  const documentTarget = {
    body: { appendChild() {} },
    createElement(tag) {
      assert.equal(tag, 'a');
      return anchor;
    },
  };
  const urlApi = {
    createObjectURL() { return `blob:history-download-${clickThrows ? 'error' : 'ok'}`; },
    revokeObjectURL(url) { revoked.push(url); },
  };
  const downloadBlob = new Function(
    'URL',
    'document',
    'setTimeout',
    `${historyDownloadBlobSource}; return downloadBlob;`,
  )(
    urlApi,
    documentTarget,
    callback => { timerCalls += 1; callback(); return timerCalls; },
  );
  if (clickThrows) assert.throws(() => downloadBlob(new Uint8Array([1]), 'history.png'), /浏览器拒绝触发下载/);
  else downloadBlob(new Uint8Array([1]), 'history.png');
  assert.equal(anchor.removed, true,
    `历史${clickThrows ? '下载失败' : '下载成功'}后临时 anchor 都必须移除`);
  assert.deepEqual(revoked, [`blob:history-download-${clickThrows ? 'error' : 'ok'}`],
    `历史${clickThrows ? '下载失败' : '下载成功'}后 ObjectURL 必须恰好 revoke 一次`);
  assert.equal(timerCalls, 1,
    `历史${clickThrows ? '下载失败' : '下载成功'}后都必须只安排一次 URL 清理`);
}

console.log('web text preview download focus tests passed');
