import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

globalThis.location = new URL('http://wx-summary.test/#/settings');

const loader = createBrowserModuleLoader();
const core = await loader.load('js/pages/settings/core.js');
const schedulerSource = await fs.readFile(
  new URL('../src/web/public/js/pages/settings/scheduler.js', import.meta.url),
  'utf8',
);

function extractFunction(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `生产调度分区必须包含 ${marker}`);
  const signatureEnd = source.indexOf(') {', start);
  assert.ok(signatureEnd >= 0, `${marker} 必须有可定位的函数体`);
  const open = source.indexOf('{', signatureEnd + 2);
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
    else if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${marker} 函数体未闭合`);
}

function fakeElement(tag, attrs = {}, children = []) {
  return {
    tag,
    ...attrs,
    children,
    listeners: new Map(),
    classList: { toggle() {} },
    addEventListener(type, listener) { this.listeners.set(type, listener); },
  };
}

const renderSource = extractFunction(schedulerSource, 'function renderGroupPicker()');

function runRender({ account, savedRef }) {
  const draft = {
    whitelist: [savedRef],
    groups: [{ id: 'scope-group@chatroom', name: '作用域群' }],
    groupsLoading: false,
  };
  const groupSearch = { value: '' };
  const pickerStatus = { textContent: '' };
  const pickerList = {
    children: [],
    replaceChildren(...children) { this.children = children; },
  };
  const page = { isBusy: () => false };
  const renderGroupPicker = new Function(
    'groupSearch',
    'draft',
    'pickerList',
    'pickerStatus',
    'groupDisplayName',
    'groupRefFromGroup',
    'whitelistRefKey',
    'el',
    'syncFormControlsDisabled',
    'page',
    'currentAccountId',
    'currentAccountRuleScope',
    `${renderSource}; return renderGroupPicker;`,
  )(
    groupSearch,
    draft,
    pickerList,
    pickerStatus,
    core.groupDisplayName,
    core.groupRefFromGroup,
    core.whitelistRefKey,
    (tag, attrs, ...children) => fakeElement(tag, attrs, children),
    () => {},
    page,
    () => account.id,
    () => account.identity_id || account.id,
  );
  renderGroupPicker();
  const checkbox = pickerList.children[0]?.children?.find(child => child?.tag === 'input');
  return { checkbox, draft };
}

const verifiedAccount = {
  id: 'wxacc_scheduler_scope',
  account_id: 'wxacc_scheduler_scope',
  identity_id: 'wxacct_0123456789abcdef01234567',
};
const verifiedResult = runRender({
  account: verifiedAccount,
  savedRef: {
    account_id: verifiedAccount.identity_id,
    group_id: 'scope-group@chatroom',
    group_name: '作用域群',
  },
});
assert.equal(verifiedResult.checkbox?.checked, true,
  '已验证账号的 identity_id 作用域白名单必须在群选择器中保持选中');

const unverifiedAccount = {
  id: 'wxacc_scheduler_unverified',
  account_id: 'wxacc_scheduler_unverified',
};
const unverifiedResult = runRender({
  account: unverifiedAccount,
  savedRef: {
    account_id: unverifiedAccount.id,
    group_id: 'scope-group@chatroom',
    group_name: '作用域群',
  },
});
assert.equal(unverifiedResult.checkbox?.checked, true,
  '没有 verified identity_id 时必须回退到当前账号 ID 生成白名单作用域');

console.log('web-settings-scheduler-account-scope: passed');
