import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { requireSettingsDocument } from '../src/web/public/js/shared/settings-document.js';

const source = await readFile(
  new URL('../src/web/public/js/pages/settings/index.js', import.meta.url),
  'utf8',
);

function extractFunction(marker) {
  const start = source.indexOf(`  ${marker}`);
  assert.ok(start >= 0, `必须能定位生产函数: ${marker}`);
  const signatureEnd = source.indexOf(') {', start);
  assert.ok(signatureEnd > start, `必须能定位生产函数体: ${marker}`);
  const open = signatureEnd + 2;
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
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`生产函数未闭合: ${marker}`);
}

const production = [
  extractFunction('function applySettingsToSections('),
  extractFunction('function adoptSettingsDocument('),
  extractFunction('function queueAccountIdentityUpgrade('),
  extractFunction('function adoptSaveResult('),
  extractFunction('async function confirmPersisted('),
].join('\n');

const state = {
  destroyed: false,
  generation: 0,
  settings: null,
  baseRevision: '',
  revisionEpoch: 0,
  stale: false,
  staleDismissedRevision: '',
  drafts: { clear() {} },
};
const applied = [];
const sections = [{
  applySettings(settings) {
    applied.push(settings.settings_revision);
  },
}];
const requests = [];
const api = {
  get(path, options) {
    return new Promise((resolve, reject) => requests.push({ path, options, resolve, reject }));
  },
};
const toasts = [];
const ui = {
  toastWarn() {},
  toast(message) { toasts.push(message); },
};
const factory = new Function(
  'state',
  'sections',
  'requireSettingsDocument',
  'api',
  'pageAbort',
  'ui',
  'hideNotice',
  'isAbortError',
  `${production}\nreturn { adoptSaveResult };`,
);
const { adoptSaveResult } = factory(
  state,
  sections,
  requireSettingsDocument,
  api,
  new AbortController(),
  ui,
  () => {},
  error => error?.name === 'AbortError',
);
const flush = () => new Promise(resolve => setImmediate(resolve));

adoptSaveResult({
  settings_revision: 'rev-1',
  settings: { settings_revision: 'rev-1', marker: 'save-1' },
});
assert.equal(requests.length, 1, '保存 1 必须启动自己的落盘确认');

adoptSaveResult({
  settings_revision: 'rev-2',
  settings: { settings_revision: 'rev-2', marker: 'save-2' },
});
assert.equal(requests.length, 2, '保存 2 必须启动新的落盘确认');
assert.equal(state.baseRevision, 'rev-2');
assert.equal(state.settings.marker, 'save-2');

requests[0].resolve({
  settings_revision: 'rev-between',
  marker: 'response-before-save-2',
});
await flush();

assert.equal(state.baseRevision, 'rev-2', '旧确认晚到不得回滚较新的保存 revision');
assert.equal(state.settings.marker, 'save-2', '旧确认晚到不得采用较新的保存之前的文档');
assert.equal(toasts.length, 0, '旧确认晚到不得提示已经同步过期文档');

requests[1].resolve({
  settings_revision: 'rev-3',
  marker: 'current-confirmation',
});
await flush();

assert.equal(state.baseRevision, 'rev-3', '当前保存 owner 的确认仍应采用之后发生的更新');
assert.equal(state.settings.marker, 'current-confirmation');
assert.equal(toasts.length, 1, '当前确认采用更新后应提示一次');
assert.deepEqual(applied, ['rev-1', 'rev-2', 'rev-3']);

console.log('web settings persisted confirmation ownership tests passed');
