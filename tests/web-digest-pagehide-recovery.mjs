import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');

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

function extractArrowAssignment(sourceText, marker) {
  const start = sourceText.indexOf(marker);
  assert.ok(start >= 0, `生产摘要页必须包含 ${marker}`);
  const open = sourceText.indexOf('{', start + marker.length - 1);
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
    else if (char === '}' && --depth === 0) {
      const end = sourceText.indexOf(';', index);
      assert.ok(end > index, `${marker} 必须完整结束`);
      return sourceText.slice(start, end + 1);
    }
  }
  throw new Error(`${marker} 处理器函数体未闭合`);
}

const preserveSource = extractFunction(source, 'function preserveInterruptedDigestBatchForUnload()');
const pageHideSource = extractArrowAssignment(source, 'page.onPageHide = event => {');

const page = {
  destroyed: false,
  activeBatch: {
    batch: {
      batch_id: 'batch-pagehide-1',
      batch_token: 'token-pagehide-123456789',
      service_instance_id: 'service-pagehide-1234',
    },
    accountId: 'account-pagehide',
    accountFingerprint: 'a'.repeat(64),
    previewText: true,
  },
};
const account = { id: 'account-pagehide', manual_key_account_fingerprint: 'a'.repeat(64) };
let currentAccount = account;
const store = { get: key => (key === 'account' ? currentAccount : null) };
const persisted = [];
const preserve = new Function(
  'page',
  'store',
  'api',
  'accountIdOf',
  'accountFingerprintOf',
  'rememberInterruptedDigestBatch',
  `${preserveSource}; return preserveInterruptedDigestBatchForUnload;`,
)(
  page,
  store,
  { getServiceInstanceId: () => 'service-fallback-1234' },
  value => String(value?.id || ''),
  value => String(value?.manual_key_account_fingerprint || '').trim().toLowerCase(),
  value => { persisted.push(value); return true; },
);

assert.equal(preserve(), true, '活动批次必须能在 pagehide 同步登记恢复 marker');
assert.deepEqual(persisted, [{
  batch_id: 'batch-pagehide-1',
  batch_token: 'token-pagehide-123456789',
  service_instance_id: 'service-pagehide-1234',
  account_id: 'account-pagehide',
  account_fingerprint: 'a'.repeat(64),
  preview_text: true,
}], 'pagehide marker 必须绑定当前批次与账号身份，不写入正文');

const handler = new Function(
  'page',
  'preserveInterruptedDigestBatchForUnload',
  `${pageHideSource}; return page.onPageHide;`,
)(page, preserve);
const beforeBfcache = persisted.length;
handler({ persisted: true });
assert.equal(persisted.length, beforeBfcache, 'bfcache pagehide 不应新增 marker');
const beforeNonPersisted = persisted.length;
handler({ persisted: false });
assert.equal(persisted.length, beforeNonPersisted + 1, '非 bfcache pagehide 必须调用恢复 marker 留档');
assert.deepEqual(persisted.at(-1), persisted[0], 'pagehide 事件必须调用同一生产留档 helper');

currentAccount = { id: 'account-pagehide-b', manual_key_account_fingerprint: 'b'.repeat(64) };
assert.equal(preserve(), true, 'owner 身份变化期间仍应能留档原活动批次');
assert.equal(persisted.at(-1).account_id, 'account-pagehide',
  '账号切换完成但旧批次仍在收尾时不得把 marker 改绑到新账号');
assert.equal(persisted.at(-1).account_fingerprint, 'a'.repeat(64),
  'pagehide marker 必须沿用活动 owner 的指纹');

page.activeBatch = null;
assert.equal(preserve(), false, '没有活动批次时不得创建空恢复 marker');

console.log('digest pagehide recovery checks passed');
