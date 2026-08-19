import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(
  new URL('../src/web/public/js/pages/digest/index.js', import.meta.url),
  'utf8',
);

function extractFunction(sourceText, marker) {
  const start = sourceText.indexOf(marker);
  assert.ok(start >= 0, `生产摘要页必须包含 ${marker}`);
  const signatureEnd = sourceText.indexOf(') {', start);
  assert.ok(signatureEnd >= 0, `${marker} 必须有可定位的函数体`);
  const open = sourceText.indexOf('{', signatureEnd + 2);
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

function extractBlock(sourceText, marker) {
  const start = sourceText.indexOf(marker);
  assert.ok(start >= 0, `生产摘要页必须包含 ${marker}`);
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
    else if (char === '}' && --depth === 0) return sourceText.slice(open + 1, index);
  }
  throw new Error(`${marker} 代码块未闭合`);
}

const matchSource = extractFunction(source, 'function whitelistRefMatchesGroup(');
const whitelistRefMatchesGroup = new Function(
  'accountIdOf',
  `${matchSource}; return whitelistRefMatchesGroup;`,
)(account => String(account?.id || account?.account_id || '').trim());

const group = { id: 'scope-group@chatroom', name: '作用域群' };
const account = {
  id: 'wxacc_digest_scope',
  account_id: 'wxacc_digest_scope',
  identity_id: 'wxacct_abcdef0123456789abcdef01',
  account_aliases: ['wxid_digest_scope'],
};

assert.equal(
  whitelistRefMatchesGroup({ account_id: account.identity_id, group_id: group.id }, group, account),
  true,
  '摘要页白名单全选必须接受当前账号的 verified identity_id 作用域',
);
assert.equal(
  whitelistRefMatchesGroup({ account_id: account.id, group_id: group.id }, group, account),
  true,
  '摘要页白名单全选必须兼容当前账号的存储 ID 作用域',
);
assert.equal(
  whitelistRefMatchesGroup({ account_id: 'wxacct_other0123456789abcdef01', group_id: group.id }, group, account),
  false,
  '摘要页白名单全选不得接受其他账号的 identity_id 作用域',
);
assert.equal(
  whitelistRefMatchesGroup({ group_id: group.id }, group, account),
  false,
  '摘要页白名单全选必须拒绝无账号作用域的引用',
);

const whitelistClickBody = extractBlock(source, "whitelistBtn.addEventListener('click', () => {");
const selected = new Set();
const page = {
  groups: [group],
  whitelistRefs: [{ account_id: account.identity_id, group_id: group.id }],
  selected,
};
const store = { get(key) { return key === 'account' ? account : null; } };
const notices = [];
const clickWhitelist = new Function(
  'store',
  'page',
  'whitelistRefMatchesGroup',
  'syncSelectionUi',
  'renderGroupList',
  'scheduleDraftSave',
  'ui',
  `return () => {${whitelistClickBody}};`,
)(
  store,
  page,
  whitelistRefMatchesGroup,
  () => {},
  () => {},
  () => {},
  { toast(message) { notices.push(message); }, toastSuccess(message) { notices.push(message); } },
);
clickWhitelist();
assert.deepEqual([...selected], [group.id],
  '真实白名单全选点击必须把当前 identity_id 作用域的群加入选中集合');
assert.equal(notices.length, 1, '真实白名单全选成功路径只应生成一次提示');

console.log('web-digest-whitelist-account-scope: passed');
