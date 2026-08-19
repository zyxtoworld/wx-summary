import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../src/web/public/js/main.js', import.meta.url), 'utf8');

function extractFunction(sourceText, marker, { async = false } = {}) {
  const start = sourceText.indexOf(`${async ? 'async ' : ''}function ${marker}(`);
  assert.ok(start >= 0, `壳层必须包含 ${marker}`);
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

const refreshSource = extractFunction(source, 'refreshStateAfterPageRestore', { async: true });
const pageShowSource = extractFunction(source, 'handlePageShow');

let currentAccount = { id: 'restore-account', manual_key_account_fingerprint: 'r'.repeat(64) };
const store = { get: key => (key === 'account' ? currentAccount : null) };
const refreshCalls = [];
const refreshStateForAccount = account => {
  refreshCalls.push(account);
  return Promise.resolve({ ok: true, account_id: account.id });
};
const refreshStateAfterPageRestore = new Function(
  'store',
  'refreshStateForAccount',
  `let latestAccountStateRefresh = Promise.resolve(null); ${refreshSource}; return refreshStateAfterPageRestore;`,
)(store, refreshStateForAccount);
const handlePageShow = new Function(
  'refreshStateAfterPageRestore',
  `${pageShowSource}; return handlePageShow;`,
)(refreshStateAfterPageRestore);

handlePageShow({ persisted: false });
assert.equal(refreshCalls.length, 0, '普通 pageshow 不得重复刷新账号状态');
handlePageShow({ persisted: true });
await Promise.resolve();
assert.equal(refreshCalls.length, 1, 'bfcache 恢复必须刷新一次当前账号状态');
assert.strictEqual(refreshCalls[0], currentAccount, 'bfcache 刷新必须使用恢复时的当前账号对象');

currentAccount = null;
handlePageShow({ persisted: true });
await Promise.resolve();
assert.equal(refreshCalls.length, 1, '没有当前账号时不得发起无作用的状态请求');

assert.match(source, /window\.addEventListener\('pageshow',\s*handlePageShow\)/,
  '壳层必须把 bfcache 恢复 handler 接到 pageshow');

console.log('bootstrap pageshow refresh checks passed');
