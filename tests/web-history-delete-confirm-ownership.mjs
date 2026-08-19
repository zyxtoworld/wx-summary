import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function extractFunction(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `必须能定位生产函数 ${marker}`);
  const signatureEnd = source.indexOf(') {', start);
  assert.ok(signatureEnd >= 0, `${marker} 必须有可定位签名`);
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

function deferred() {
  let resolve;
  const promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
}

const source = await readFile(
  new URL('../src/web/public/js/pages/history/index.js', import.meta.url),
  'utf8',
);
const item = {
  history_item_key: 'history-delete-confirm-owner',
  digest_id: 'digest-delete-confirm-owner',
  group: '测试群',
  relative_path: 'summary.png',
};
const detail = {
  item,
  busy: false,
  controller: new AbortController(),
};
const page = { destroyed: false, detail };
const confirmations = [];
let confirmCalls = 0;
const ui = {
  confirmDialog() {
    confirmCalls += 1;
    const next = deferred();
    confirmations.push(next);
    return next.promise;
  },
  toastWarn() {},
};
const busyTransitions = [];
let deleteActionCalls = 0;
const detailBusy = flag => {
  const current = page.detail;
  if (!current) return;
  current.busy = flag === true;
  busyTransitions.push(current.busy);
};

const confirmDelete = new Function(
  'item',
  'page',
  'ui',
  'deleteCheck',
  'detailBusy',
  'restoreHistoryDetailActionFocus',
  'revalidateHistoryActionTarget',
  'refreshItemStatus',
  'setDetailStatus',
  'runDetailAction',
  'actions',
  `${extractFunction(source, 'async function confirmDelete(item)')}; return confirmDelete;`,
)(
  item,
  page,
  ui,
  () => ({ ok: true }),
  detailBusy,
  () => {},
  async () => ({ ok: true, item }),
  async () => ({ ok: true, item }),
  () => {},
  async () => {
    deleteActionCalls += 1;
    assert.equal(detail.busy, false,
      '目标核验通过后才可把详情 busy 交给真正删除动作的 owner');
  },
  {},
);

const first = confirmDelete(item);
await Promise.resolve();
assert.equal(confirmCalls, 1, '第一次删除确认等待期间必须持有唯一确认 owner');
assert.equal(detail.busy, true, '第一次删除确认等待期间必须立即进入详情 busy');

const duplicate = confirmDelete(item);
await Promise.resolve();
assert.equal(confirmCalls, 1, '确认框未结算时第二次删除点击不得创建第二个确认流程');
await duplicate;

confirmations[0].resolve(false);
await first;
assert.deepEqual(busyTransitions, [true, false],
  '取消唯一确认流程后必须只释放自己的详情 busy');
assert.equal(detail.busy, false);

const successful = confirmDelete(item);
await Promise.resolve();
assert.equal(confirmCalls, 2);
assert.equal(detail.busy, true, '第二次独立删除必须重新取得自己的确认 owner');
confirmations[1].resolve(true);
await successful;
assert.equal(deleteActionCalls, 1, '确认并核验通过后删除动作必须只执行一次');
assert.deepEqual(busyTransitions, [true, false, true, false],
  '确认 owner 释放与删除 action 接管之间必须保持一次一次配对');
assert.equal(detail.deleteConfirmPending, false, '删除确认 owner 结束后必须释放 pending 标记');

const staleDetail = {
  item,
  busy: false,
  controller: new AbortController(),
};
page.detail = staleDetail;
const stale = confirmDelete(item);
await Promise.resolve();
assert.equal(staleDetail.busy, true);
page.detail = { item, busy: false, controller: new AbortController() };
confirmations[2].resolve(true);
await stale;
assert.equal(deleteActionCalls, 1,
  '详情换代后旧确认的晚到结果不得进入新详情删除动作');
assert.equal(staleDetail.deleteConfirmPending, false,
  '详情换代后旧确认仍必须释放自己的 pending owner');

console.log('web history delete confirmation ownership tests passed');
