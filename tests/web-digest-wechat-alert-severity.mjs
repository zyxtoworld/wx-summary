import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/web/public/js/pages/digest/index.js', import.meta.url),
  'utf8',
);
const start = source.indexOf('function renderWechatAlerts()');
const end = source.indexOf('\n  // -------------------------------------------------------------------------', start + 1);
assert.ok(start >= 0 && end > start, '必须能定位生产微信状态提示渲染函数');
const renderSource = source.slice(start, end);

class FakeNode {
  constructor(className = '', text = '') {
    this.className = className;
    this.textContent = text;
    this.children = [];
  }

  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = [...nodes]; }
}

function renderFor(wechat) {
  const alertSlot = new FakeNode('alert-slot');
  const page = { accountContextBlocked: false, groups: [] };
  const store = { get: key => key === 'state' ? { wechat } : null };
  const el = (_tag, className = '', text = '') => new FakeNode(className, text);
  const render = new Function(
    'store',
    'alertSlot',
    'page',
    'digestGroupSessionWarning',
    'digestWechatStatusMessageTone',
    'el',
    `${renderSource}; return renderWechatAlerts;`,
  )(
    store,
    alertSlot,
    page,
    () => '',
    value => value?.running === true
      && Number(value?.account_count || 0) > 0
      && Number(value?.source_ambiguous_count || 0) === 0
      && Number(value?.source_unreadable_count || 0) === 0
      && Number(value?.mirror_without_source_count || 0) === 0
      ? 'info'
      : 'warn',
    el,
  );
  render();
  return alertSlot.children;
}

const healthy = renderFor({
  running: true,
  account_count: 1,
  available_account_count: 1,
  source_ambiguous_count: 0,
  source_unreadable_count: 0,
  mirror_without_source_count: 0,
  message: '已检测到 1 个微信本地工作数据账号。',
});
assert.equal(healthy.length, 1, '健康状态的公开说明仍可显示一次');
assert.match(healthy[0].className, /alert-info/, '健康状态说明必须是中性信息，不能显示为警告');
assert.doesNotMatch(healthy[0].className, /alert-warn/);

const stopped = renderFor({
  running: false,
  account_count: 1,
  message: '已检测到账号；当前未检测到正在运行的微信。',
});
assert.ok(stopped.length >= 1, '微信未运行必须保留可见警告');
assert.ok(stopped.every(node => /alert-warn/.test(node.className)),
  '微信未运行的公开说明不得降级为普通信息');

const ambiguous = renderFor({
  running: true,
  account_count: 1,
  available_account_count: 0,
  source_ambiguous_count: 1,
  message: '账号数据源需要确认。',
});
assert.equal(ambiguous.length, 1);
assert.match(ambiguous[0].className, /alert-warn/,
  '存在数据源歧义时即使微信运行也必须保持警告');

console.log('web digest WeChat alert severity tests passed');
