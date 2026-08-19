import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { settingsAccountSwitchBlockedMessage } from '../src/web/public/js/shared/settings-account-switch.js';

function extractHandler(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `必须能定位生产确认 handler: ${marker}`);
  const open = source.indexOf('{', start);
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
    if (char === '`' || char === '\'' || char === '"') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) {
      return source.slice(open + 1, index);
    }
  }
  throw new Error('确认 handler 函数体未闭合');
}

function deferred() {
  let resolve;
  const promise = new Promise(nextResolve => { resolve = nextResolve; });
  return { promise, resolve };
}

const source = await readFile(
  new URL('../src/web/public/js/pages/settings/ai.js', import.meta.url),
  'utf8',
);
const handlerBody = extractHandler(
  source,
  "apiKeyClear.addEventListener('click', async () => {",
);

let currentSettings = { llm: { api_key_set: true, api_key_display: '••••' } };
let generation = 0;
const actions = new Set();
const confirmation = deferred();
let confirmCalls = 0;
let endCalls = 0;
let listener = null;
const draft = { clearApiKey: false, dirty: false };
const apiKeyInput = { value: '' };
const statuses = [];
const page = {
  beginAction(label) {
    const token = { label, generation, active: true };
    actions.add(token);
    return token;
  },
  alive(token) {
    return token?.active === true && token.generation === generation;
  },
  endAction(token) {
    if (actions.delete(token)) endCalls += 1;
  },
  isBusy() { return actions.size > 0; },
};
const ui = {
  confirmDialog() {
    confirmCalls += 1;
    return confirmation.promise;
  },
};
const apiKeyClear = {
  addEventListener(type, callback) {
    assert.equal(type, 'click');
    listener = callback;
  },
};

const registerHandler = new Function(
  'llm',
  'ui',
  'page',
  'apiKeyClear',
  'apiKeyInput',
  'draft',
  'syncApiKeyState',
  'markTestDraftDirty',
  'status',
  'saveBtn',
  `apiKeyClear.addEventListener('click', async () => {${handlerBody}});`,
);
registerHandler(
  () => currentSettings.llm,
  ui,
  page,
  apiKeyClear,
  apiKeyInput,
  draft,
  () => {},
  () => { draft.dirty = true; },
  { set(...value) { statuses.push(value); } },
  {},
);

assert.equal(typeof listener, 'function', '生产确认 handler 必须绑定到清除按钮');

const pending = listener();
await Promise.resolve();
assert.equal(confirmCalls, 1, '用户点击清除后必须等待一次确认');
assert.notEqual(
  settingsAccountSwitchBlockedMessage({ busy: page.isBusy() }),
  '',
  '确认框等待期间必须由设置页 action owner 阻止账号切换',
);

// 模拟真实账号 subscriber 已换代并重新采用 B 的草稿；旧确认随后才返回。
currentSettings = { llm: { api_key_set: false, api_key_display: '' } };
draft.clearApiKey = false;
draft.dirty = false;
for (const token of actions) token.active = false;
generation += 1;
confirmation.resolve(true);
await pending;

assert.equal(draft.clearApiKey, false,
  'A 的晚到确认不得把 B 的 AI 草稿标记为清除 API Key');
assert.equal(draft.dirty, false,
  'A 的晚到确认不得把 B 的草稿标记为脏');
assert.equal(endCalls, 1, '确认 action 必须在换代后幂等释放自己的 owner');
assert.equal(statuses.length, 0, '旧确认不得向 B 写入状态提示');

assert.match(source, /page\.beginAction\(/,
  '清除 API Key 确认必须建立设置页 action owner');
assert.match(source, /page\.alive\(/,
  '确认返回后必须再次核对 action owner');
assert.match(source, /page\.endAction\(/,
  '清除 API Key 确认必须在 finally 释放自己的 owner');

console.log('web settings AI key confirm ownership tests passed');
