import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { publicAccountAliases } from '../src/web/public/js/shared/account-context.js';

const source = await readFile(
  new URL('../src/web/public/js/pages/digest/index.js', import.meta.url),
  'utf8',
);

function extractFunction(text, marker) {
  const start = text.indexOf(marker);
  assert.ok(start >= 0, `必须能定位生产函数 ${marker}`);
  const open = text.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
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
    else if (char === '}' && --depth === 0) return text.slice(start, index + 1);
  }
  throw new Error(`生产函数 ${marker} 未闭合`);
}

function createNode({ className = '', text = '' } = {}) {
  return {
    className,
    textContent: text,
    type: '',
    disabled: false,
    children: [],
    listeners: new Map(),
    classList: { toggle() {} },
    replaceChildren(...children) { this.children = children.filter(Boolean); },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, listener) { this.listeners.set(type, listener); },
  };
}

function createHarness({ currentAccount, recentRefs, groups }) {
  const recentWrap = createNode();
  const page = {
    recentRefs,
    groups,
    selected: new Set(),
  };
  const store = { get(key) { return key === 'account' ? currentAccount : null; } };
  const recentRefBelongsToAccountSource = extractFunction(source, 'function recentRefBelongsToAccount(');
  const renderRecentRefsSource = extractFunction(source, 'function renderRecentRefs()');
  const renderRecentRefs = new Function(
    'page',
    'recentWrap',
    'el',
    'digestInputsLocked',
    'syncSelectionUi',
    'scheduleDraftSave',
    'store',
    'publicAccountAliases',
    `${recentRefBelongsToAccountSource}\n${renderRecentRefsSource}\nreturn renderRecentRefs;`,
  )(
    page,
    recentWrap,
    (tag, className = '', text = '') => createNode({ className, text }),
    () => false,
    () => {},
    () => {},
    store,
    publicAccountAliases,
  );
  renderRecentRefs();
  return recentWrap;
}

const accountA = { id: 'account-a', account_aliases: ['identity-a'] };
const accountB = { id: 'account-b', account_aliases: ['identity-b'] };

const foreignOnly = createHarness({
  currentAccount: accountA,
  recentRefs: [{ account_id: 'identity-b', group_id: 'shared-group', group_name: 'B 的群' }],
  groups: [{ id: 'shared-group', name: 'A 当前群' }],
});
assert.equal(
  foreignOnly.children.filter(node => node.className === 'recent-chip').length,
  0,
  '摘要页不得把另一账号的最近群引用投影为当前账号的快捷入口',
);

const mixed = createHarness({
  currentAccount: accountA,
  recentRefs: [
    { account_id: 'identity-b', group_id: 'b-only', group_name: 'B 的群' },
    { account_id: 'identity-a', group_id: 'a-only', group_name: 'A 的群' },
  ],
  groups: [
    { id: 'b-only', name: 'B 的群' },
    { id: 'a-only', name: 'A 的群' },
  ],
});
assert.deepEqual(
  mixed.children.filter(node => node.className === 'recent-chip').map(node => node.textContent),
  ['A 的群'],
  '混合最近群引用只应保留当前账号别名范围内的快捷入口',
);

const unscoped = createHarness({
  currentAccount: accountB,
  recentRefs: [{ group_id: 'unscoped', group_name: '无归属群' }],
  groups: [{ id: 'unscoped', name: '无归属群' }],
});
assert.equal(
  unscoped.children.filter(node => node.className === 'recent-chip').length,
  0,
  '无账号作用域的旧最近群引用不得投影到任意当前账号',
);

console.log('web digest recent account isolation tests passed');
