import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  readDigestDraftSnapshot,
  writeDigestDraftSnapshot,
} from '../src/web/public/js/shared/digest-draft-store.js';

const pageSource = await fs.readFile(
  new URL('../src/web/public/js/pages/digest/index.js', import.meta.url),
  'utf8',
);
const accountContextSource = await fs.readFile(
  new URL('../src/web/public/js/pages/digest/account-context.js', import.meta.url),
  'utf8',
);
const mainSource = await fs.readFile(
  new URL('../src/web/public/js/main.js', import.meta.url),
  'utf8',
);

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}()`);
  assert.ok(start >= 0, `生产摘要页必须包含 ${name}`);
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
    else if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} 函数体未闭合`);
}

const draftScopeSource = extractFunction(pageSource, 'draftScope');
const productionDraftScope = new Function(
  'store',
  'accountIdOf',
  'accountFingerprintOf',
  `${draftScopeSource}\nreturn draftScope;`,
);
const scopeState = { project_root: 'project-same-id' };
const scopeAccountA = { id: 'same-id', manual_key_account_fingerprint: 'fingerprint-a' };
const scopeAccountB = { id: 'same-id', manual_key_account_fingerprint: 'fingerprint-b' };
const scopeStore = {
  account: scopeAccountA,
  state: scopeState,
  stateAccountContext: {
    accountId: scopeAccountA.id,
    accountFingerprint: scopeAccountA.manual_key_account_fingerprint,
  },
  get(key) { return this[key]; },
};
const scopeForAccountA = productionDraftScope(
  scopeStore,
  account => String(account?.id || account?.account_id || '').trim(),
  account => String(account?.manual_key_account_fingerprint || '').trim().toLowerCase(),
)();
scopeStore.account = scopeAccountB;
scopeStore.stateAccountContext = {
  accountId: scopeAccountB.id,
  accountFingerprint: scopeAccountB.manual_key_account_fingerprint,
};
const scopeForAccountB = productionDraftScope(
  scopeStore,
  account => String(account?.id || account?.account_id || '').trim(),
  account => String(account?.manual_key_account_fingerprint || '').trim().toLowerCase(),
)();
assert.notEqual(scopeForAccountA, scopeForAccountB,
  '同 ID 不同 fingerprint 必须使用不同草稿 scope,否则 A/B 草稿会互相覆盖');
const draftStorage = new Map();
const draftStorageAdapter = {
  getItem(key) { return draftStorage.get(key) ?? null; },
  setItem(key, value) { draftStorage.set(key, String(value)); },
  removeItem(key) { draftStorage.delete(key); },
};
assert.equal(writeDigestDraftSnapshot(draftStorageAdapter, 'drafts', scopeForAccountA, {
  selected_group_ids: ['group-a'],
  render_options: { theme: 'dark', font_size: 'large' },
}, { accountFingerprint: scopeAccountA.manual_key_account_fingerprint, now: 1000 }), true);
assert.equal(writeDigestDraftSnapshot(draftStorageAdapter, 'drafts', scopeForAccountB, {
  selected_group_ids: ['group-b'],
  render_options: { theme: 'light', font_size: 'normal' },
}, { accountFingerprint: scopeAccountB.manual_key_account_fingerprint, now: 1001 }), true);
assert.deepEqual(
  readDigestDraftSnapshot(draftStorageAdapter, 'drafts', scopeForAccountA, {
    accountFingerprint: scopeAccountA.manual_key_account_fingerprint,
    now: 1002,
  }).draft.selected_group_ids,
  ['group-a'],
  'A→B→A 必须恢复 A 自己的草稿而不是被同 ID 的 B 覆盖',
);
assert.deepEqual(
  readDigestDraftSnapshot(draftStorageAdapter, 'drafts', scopeForAccountB, {
    accountFingerprint: scopeAccountB.manual_key_account_fingerprint,
    now: 1002,
  }).draft.render_options,
  { theme: 'light', font_size: 'normal' },
  '同 ID B 必须恢复自己的渲染选项',
);
scopeStore.stateAccountContext = {
  accountId: scopeAccountA.id,
  accountFingerprint: scopeAccountA.manual_key_account_fingerprint,
};
assert.equal(productionDraftScope(
  scopeStore,
  account => String(account?.id || account?.account_id || '').trim(),
  account => String(account?.manual_key_account_fingerprint || '').trim().toLowerCase(),
)(), '', 'state owner fingerprint 不匹配时不得生成可读草稿 scope');

assert.match(
  pageSource,
  /digestDraftHasMeaningfulInput[\s\S]*readDigestDraftSnapshot[\s\S]*writeDigestDraftSnapshot/,
  '总结页必须使用共享草稿归一化/持久化合同',
);
assert.match(
  mainSource,
  /stateAccountContext: null[\s\S]*store\.set\('stateAccountContext',[\s\S]*store\.set\('state', nextState\)/,
  '按账号读取 state 的上下文必须先于 state 事件发布',
);
assert.match(
  pageSource,
  /const stateAccountContext = store\.get\('stateAccountContext'\) \|\| \{\};[\s\S]*stateAccountId !== accountId[\s\S]*stateAccountFingerprint !== accountFingerprint/,
  '草稿 scope 必须等待当前账号的 state 上下文就绪',
);
assert.match(
  pageSource,
  /accountFingerprintOf\(account\)[\s\S]*accountFingerprint[^\n]*\]\)/,
  '草稿 scope 必须纳入当前账号 fingerprint,隔离同 ID 的身份代际',
);
assert.match(
  pageSource,
  /function currentDraftSnapshot\(\)[\s\S]*render_options:[\s\S]*font_size: page\.renderOptions\.fontSize/,
  '总结草稿快照必须包含渲染主题和字号',
);
assert.match(
  pageSource,
  /draftScopeLifecycle = createDigestDraftScopeLifecycle\([\s\S]*isMeaningful: digestDraftHasMeaningfulInput/,
  '总结页必须把草稿持久化交给 scope 生命周期协调器',
);
assert.match(
  pageSource,
  /function saveDraft\(\)[\s\S]*draftScopeLifecycle\?\.persist\(draftScope\(\),[\s\S]*page\.draftPersistenceFailed = result\.persistenceFailed === true/,
  '草稿写入失败状态必须由 scope 生命周期回传并留下离开保护',
);
assert.match(
  pageSource,
  /function applyDraftState\(draft = \{\}\)[\s\S]*theme: draft\.render_options\?\.theme[\s\S]*fontSize: draft\.render_options\?\.font_size/,
  '目标账号草稿存在时必须恢复目标账号自己的渲染选择',
);
assert.match(
  pageSource,
  /function confirmDraftPersistenceBeforeLeave\(\)[\s\S]*saveDraft\(\)[\s\S]*digestDraftPersistenceRisk\(\)[\s\S]*ui\.confirmDialog/,
  '离开总结页前必须核对草稿持久化风险',
);
assert.match(
  pageSource,
  /page\.renderOptions\.theme = btn\.dataset\.renderTheme;[\s\S]*scheduleDraftSave\(\);[\s\S]*page\.renderOptions\.fontSize = btn\.dataset\.renderFontsize;[\s\S]*scheduleDraftSave\(\);/,
  '主题和字号点击都必须触发草稿保存',
);
assert.match(
  accountContextSource,
  /export function digestAccountContextIdentity\(account\)[\s\S]*return `id:\$\{accountId\}\|fingerprint:\$\{fingerprint\}`/,
  '账号上下文 helper 必须使用 ID+fingerprint 稳定身份而不是对象实例',
);
assert.match(
  pageSource,
  /import \{[\s\S]*digestAccountContextIdentity[\s\S]*\} from '\.\/account-context\.js';[\s\S]*digestAccountContextIdentity\(store\.get\('account'\)\)/,
  '恢复草稿必须绑定稳定账号身份',
);
assert.match(
  pageSource,
  /draftScopeLifecycle\.beginContextChange\([\s\S]*digestAccountContextIdentity\(store\.get\('account'\)\)/,
  '账号订阅必须把稳定身份传入生命周期协调器',
);
assert.match(
  pageSource,
  /page\.draftSaveTimer \|\| draftScopeLifecycle\?\.hasPendingPersistence\?\.\(\)/,
  '账号切换守卫必须覆盖已调度和未持久化编辑',
);

console.log('web digest draft render options tests passed');
