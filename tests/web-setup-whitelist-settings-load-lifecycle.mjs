import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { requireGroupList } from '../src/web/public/js/shared/group-list-contract.js';
import { requireServiceStatePayload } from '../src/web/public/js/shared/service-state.js';
import { requireSettingsDocument } from '../src/web/public/js/shared/settings-document.js';

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
const saveWizardSettings = async () => ({ ok: true });
const syncWizardStateFromSettingsResponse = () => {};
const wizardAccountRequestContext = wiz => ({ body: { _request_context: {
  account_id: accountIdOf(wiz.account),
  expected_account_fingerprint: accountFingerprintOf(wiz.account),
} } });`,
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
const groupDisplayName = group => String(group?.name || group?.id || '(未命名群)');
const groupRefFromGroup = (group, accountId) => ({
  account_id: String(accountId || ''),
  group_id: String(group?.id || ''),
  group_name: String(group?.name || group?.id || ''),
});
const whitelistRefKey = ref => typeof ref === 'string'
  ? \`legacy:\${ref}\`
  : \`\${String(ref?.account_id || '').trim()}::\${ref?.group_id
    ? \`id:\${String(ref.group_id).trim()}\`
    : \`name:\${String(ref?.group_name || '').trim()}\`}\`;`,
);

const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const { createFinishStep } = await import(moduleUrl);

function deferred() {
  let resolve;
  const promise = new Promise(nextResolve => { resolve = nextResolve; });
  return { promise, resolve };
}

const account = {
  id: 'setup-whitelist-account',
  manual_key_account_fingerprint: 'fingerprint-a',
};
const settingsRequests = [];
const groups = [{ id: 'group-a', name: '群 A' }];
const settingsA = {
  settings_revision: 'settings-revision-a',
  groups: { whitelist: [{ account_id: account.id, group_id: 'group-a', group_name: '来自 A' }] },
};
const settingsB = {
  settings_revision: 'settings-revision-b',
  groups: { whitelist: [{ account_id: account.id, group_id: 'group-b', group_name: '来自 B' }] },
};
const wiz = {
  account,
  accounts: [account],
  state: { settings_limits: { group_whitelist_refs: 10 } },
  settings: null,
  groups: null,
};
const pageAbort = new AbortController();
let generation = 0;
const ctx = {
  api: {
    get(url, { signal } = {}) {
      if (url === '/api/settings') {
        const request = deferred();
        settingsRequests.push({ ...request, signal });
        return request.promise;
      }
      if (url.startsWith('/api/groups?')) {
        return Promise.resolve({
          ok: true,
          groups,
          account_id: account.id,
          account_fingerprint: account.manual_key_account_fingerprint,
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
  signal: pageAbort.signal,
  get destroyed() { return false; },
  beginAsync() { generation += 1; return generation; },
  alive(token) { return token === generation; },
  refreshButtons() {},
  gotoStep() {},
  showPageNotice() {},
};

const step = createFinishStep(w);
step.onEnter();
await new Promise(resolve => setImmediate(resolve));
assert.equal(settingsRequests.length, 1, '首次进入完成步骤应发起一次设置读取');
assert.equal(settingsRequests[0].signal.aborted, false);

step.onExit();
assert.equal(settingsRequests[0].signal.aborted, true,
  '离开步骤必须立即取消第一代设置请求');

step.onEnter();
await new Promise(resolve => setImmediate(resolve));
assert.equal(settingsRequests.length, 2,
  '同账号重新进入时必须立即创建第二代设置请求，不能继续等待已取消的旧 Promise');
assert.equal(settingsRequests[1].signal.aborted, false);

settingsRequests[1].resolve(settingsB);
await new Promise(resolve => setImmediate(resolve));
assert.equal(wiz.settings?.settings_revision, 'settings-revision-b',
  '第二代设置响应必须被当前向导采用');

// 第一代底层实现可能忽略 abort；它的迟到响应不得覆盖第二代文档或白名单。
settingsRequests[0].resolve(settingsA);
await new Promise(resolve => setImmediate(resolve));
assert.equal(wiz.settings?.settings_revision, 'settings-revision-b',
  '第一代迟到设置响应不得覆盖当前文档');
assert.deepEqual(wiz.settings?.groups?.whitelist, settingsB.groups.whitelist,
  '第一代迟到设置响应不得覆盖当前账号的白名单');

step.onExit();
console.log('web setup whitelist settings load lifecycle tests passed');
