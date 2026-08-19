import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { requireGroupList } from '../src/web/public/js/shared/group-list-contract.js';
import { requireServiceStatePayload } from '../src/web/public/js/shared/service-state.js';
import { requireSettingsDocument } from '../src/web/public/js/shared/settings-document.js';
import {
  canonicalWhitelistRef as sharedCanonicalWhitelistRef,
  groupRefFromGroup as sharedGroupRefFromGroup,
  whitelistRefKey as sharedWhitelistRefKey,
} from '../src/web/public/js/shared/whitelist-contract.js';

assert.deepEqual(sharedCanonicalWhitelistRef({ group_id: 'group-a', group_name: '群 A' }, 'account-a'), {
  account_id: 'account-a', group_id: 'group-a', group_name: '群 A',
}, '共享白名单合同应为缺省账号的群引用补当前账号');
assert.deepEqual(sharedGroupRefFromGroup({ id: 'group-a', name: '群 A' }, 'account-a'), {
  account_id: 'account-a', group_id: 'group-a', group_name: '群 A',
}, '向导与设置页必须使用同一群引用生成器');
assert.equal(sharedWhitelistRefKey({ account_id: 'account-a', group_id: 'group-a' }),
  'account-a::id:group-a', '共享白名单 key 必须稳定');

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.hidden = false;
    this.type = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.attributes = new Map();
    this.listeners = new Map();
  }

  append(...children) { this.children.push(...children.filter(Boolean)); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children.filter(Boolean); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'type') this.type = String(value);
    if (name === 'value') this.value = String(value);
  }
  dispatch(type) { return this.listeners.get(type)?.({ target: this }); }
  click() { return this.dispatch('click'); }
  querySelectorAll(selector) {
    const found = [];
    const matches = node => selector === 'input[type="checkbox"]'
      ? node?.tagName === 'input' && node?.type === 'checkbox'
      : false;
    const visit = node => {
      for (const child of node?.children || []) {
        if (matches(child)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
}

function descendantText(node) {
  return [String(node?.textContent || ''), ...(node?.children || []).map(descendantText)].join('');
}

function findElementByText(node, text) {
  if (String(node?.textContent || '') === text) return node;
  for (const child of node?.children || []) {
    const match = findElementByText(child, text);
    if (match) return match;
  }
  return null;
}

globalThis.document = {
  createElement(tagName) { return new FakeElement(tagName); },
};
globalThis.__testRequireGroupList = requireGroupList;
globalThis.__testRequireServiceStatePayload = requireServiceStatePayload;
globalThis.__testRequireSettingsDocument = requireSettingsDocument;

let source = await readFile(
  new URL('../src/web/public/js/pages/setup/step-finish.js', import.meta.url),
  'utf8',
);
source = source.replace(
  /import \{[\s\S]*?\} from '\.\/state\.js';/,
  `const applyWizardAccountState = (_store, wiz, state) => { wiz.state = state; };
const accountIdOf = account => String(account?.id || account?.account_id || '');
const accountFingerprintOf = account => String(account?.manual_key_account_fingerprint || '').trim().toLowerCase();
const stateMatchesAccountContext = () => true;
const compactErrorSummary = value => String(value || '');
const saveWizardSettings = (...args) => globalThis.__testSaveWizardSettings(...args);
const syncWizardStateFromSettingsResponse = (wiz, response) => {
  if (response?.settings) wiz.settings = response.settings;
  if (response?.settings_revision) wiz.baseRevision = response.settings_revision;
};
const wizardAccountRequestContext = wiz => ({
  body: { _request_context: {
    account_id: accountIdOf(wiz.account),
    expected_account_fingerprint: accountFingerprintOf(wiz.account),
  } },
});`,
);
source = source.replace(
  "import { configureLiveRegion } from '/js/ui/live-region.js';",
  'const configureLiveRegion = node => node;',
);
source = source.replace(
  "import { captureActionFocus, restoreActionFocus } from '/js/shared/action-focus.js';",
  'const captureActionFocus = () => null; const restoreActionFocus = () => false;',
);
source = source.replace(
  "import { requireGroupList } from '/js/shared/group-list-contract.js';",
  'const requireGroupList = globalThis.__testRequireGroupList;',
);
source = source.replace(
  "import { requireServiceStatePayload } from '/js/shared/service-state.js';",
  'const requireServiceStatePayload = globalThis.__testRequireServiceStatePayload;',
);
source = source.replace(
  "import { requireSettingsDocument } from '/js/shared/settings-document.js';",
  'const requireSettingsDocument = globalThis.__testRequireSettingsDocument;',
);
source = source.replace(
  /import \{[\s\S]*?\} from '\/js\/shared\/whitelist-contract\.js';/,
  `const canonicalWhitelistRef = (ref, accountId = '') => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
    const account = String(ref.account_id || accountId || '').trim();
    const groupId = String(ref.group_id || '').trim();
    const groupName = String(ref.group_name || '').trim();
    if (!account || (!groupId && !groupName)) return null;
    return { account_id: account, ...(groupId ? { group_id: groupId } : {}), ...(groupName ? { group_name: groupName } : {}) };
  };
const whitelistRefKey = ref => typeof ref === 'string'
  ? \`legacy:\${ref}\`
  : \`\${String(ref?.account_id || '').trim()}::\${ref?.group_id ? \`id:\${String(ref.group_id).trim()}\` : \`name:\${String(ref?.group_name || '').trim()}\`}\`;
const groupRefFromGroup = (group, accountId) => ({
  account_id: String(accountId || ''),
  group_id: String(group?.id || ''),
  group_name: String(group?.name || group?.id || ''),
});
const groupDisplayName = group => String(group?.name || group?.id || '(未命名群)');`,
);
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const { createFinishStep } = await import(moduleUrl);

const account = { id: 'setup-whitelist-account', manual_key_account_fingerprint: 'fingerprint-a' };
const groups = [
  { id: 'group-a', name: '群 A' },
  { id: 'group-b', name: '群 B' },
  { id: 'group-c', name: '群 C' },
];
const wiz = {
  account,
  accounts: [account],
  state: { scheduler: {}, settings_limits: { group_whitelist_refs: 2 } },
  settings: {
    settings_revision: 'settings-rev-a',
    groups: {
      whitelist: [
        { account_id: 'other-account', group_id: 'foreign-group', group_name: '其他账号群' },
        'legacy-group@chatroom',
      ],
    },
  },
  groups: null,
};
const saveCalls = [];
let malformedSettings = false;
globalThis.__testSaveWizardSettings = async (_ctx, _wiz, patch, options) => {
  saveCalls.push({ patch, options });
  return {
    ok: true,
    settings_revision: 'settings-rev-b',
    settings: { settings_revision: 'settings-rev-b', groups: patch.groups },
  };
};
const controller = new AbortController();
let generation = 0;
const ctx = {
    api: {
      get(url) {
      if (url === '/api/settings' && malformedSettings) {
        return Promise.resolve({ settings_revision: '' });
      }
      if (url.startsWith('/api/groups?')) {
        return Promise.resolve({
          ok: true,
          groups,
          account_id: account.id,
          account_fingerprint: account.manual_key_account_fingerprint,
        });
      }
      if (url.startsWith('/api/state?')) {
        return Promise.resolve({
          ok: true,
          need_setup: true,
          wechat: { accounts: [account] },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    },
  },
  store: { set() {} },
  ui: { spinner: () => new FakeElement('spinner') },
};
const w = {
  ctx,
  wiz,
  get destroyed() { return false; },
  signal: controller.signal,
  beginAsync() { generation += 1; return generation; },
  alive(token) { return token === generation; },
  applyAccountIdentityUpgrade() { return false; },
  refreshButtons() {},
  gotoStep() {},
};

const step = createFinishStep(w);
step.onEnter();
await new Promise(resolve => setImmediate(resolve));

const checkboxes = step.el.querySelectorAll('input[type="checkbox"]');
assert.equal(checkboxes.length, groups.length,
  '完成步骤应为读取到的每个群提供可操作的白名单 checkbox');

checkboxes[0].checked = true;
await checkboxes[0].dispatch('change');
checkboxes[1].checked = true;
await checkboxes[1].dispatch('change');
checkboxes[2].checked = true;
await checkboxes[2].dispatch('change');
assert.equal(checkboxes[2].checked, false,
  '超过白名单上限时应立即回滚被拒绝的 checkbox');
assert.match(descendantText(step.el), /最多 2/,
  '超过白名单上限时应展示可操作的限制说明');
assert.match(descendantText(step.el), /白名单已选 2\/2/,
  '白名单计数应同时展示当前选择和上限');
await findElementByText(step.el, '全选当前').click();
assert.match(descendantText(step.el), /有 1 个群未加入/,
  '全选当前超过上限时应报告被拒绝数量');

const finished = await step.finish();
assert.equal(finished, false, '状态仍需配置时完成动作应停留在向导');
assert.equal(saveCalls.length, 1, '白名单有修改时完成动作应恰好保存一次');
assert.deepEqual(saveCalls[0].patch.groups.whitelist
  .filter(ref => typeof ref === 'object')
  .map(ref => ref.group_id), ['foreign-group', 'group-a', 'group-b'],
  '保存只能替换当前账号选择，并保留其他账号的规范引用');
assert.equal(saveCalls[0].patch.groups.whitelist.includes('legacy-group@chatroom'), true,
  '保存必须保留服务端已有的无账号旧引用');
assert.equal(saveCalls[0].patch._request_context.account_id, account.id,
  '白名单保存必须携带当前账号上下文');

malformedSettings = true;
wiz.settings = null;
wiz.whitelist = [];
wiz.whitelistBaseline = [];
wiz.whitelistDirty = false;
wiz.whitelistAccountIdentity = '';
step.onEnter();
await new Promise(resolve => setImmediate(resolve));
const malformedCheckbox = step.el.querySelectorAll('input[type="checkbox"]')[0];
malformedCheckbox.checked = true;
await malformedCheckbox.dispatch('change');
const saveCountBeforeMalformedFinish = saveCalls.length;
assert.equal(await step.finish(), false,
  '畸形设置响应不能解锁完成动作');
assert.equal(saveCalls.length, saveCountBeforeMalformedFinish,
  '畸形设置响应下不得发起会覆盖服务端白名单的保存');

console.log('setup whitelist limit behavior passed');
