import assert from 'node:assert/strict';
import { createStore } from '../src/web/public/js/store.js';
import { createAccountSelectionController } from '../src/web/public/js/shared/account-selection.js';

const accountA = { id: 'account-a', display_name: '账号 A' };
const accountB = { id: 'account-b', display_name: '账号 B' };
const persisted = [];
const blocked = [];
const selected = [];
const store = createStore({ account: null, accountSwitchGuard: null });
const controller = createAccountSelectionController({
  store,
  persistConfirmedAccountId: id => persisted.push(id),
  onBlocked: message => blocked.push(message),
  onSelected: (next, previous) => selected.push([next?.id || '', previous?.id || '']),
});

const initial = controller.select(accountA);
assert.equal(initial.blocked, false);
assert.equal(initial.changed, true);
assert.equal(store.get('account'), accountA);
assert.deepEqual(persisted, [], '启动发现或后台同步账号不得覆盖用户跨标签确认值');
assert.deepEqual(selected, [], '非用户选择不得显示“已切换”反馈');

store.set('accountSwitchGuard', () => '摘要仍在生成，完成或离开页面后再切换账号。');
const rejected = controller.select(accountB, { userInitiated: true });
assert.equal(rejected.blocked, true);
assert.equal(rejected.changed, false);
assert.equal(store.get('account'), accountA, '守卫拒绝时当前账号必须保持不变');
assert.deepEqual(persisted, []);
assert.deepEqual(blocked, ['摘要仍在生成，完成或离开页面后再切换账号。']);

store.set('accountSwitchGuard', () => '');
const accepted = controller.select(accountB, { userInitiated: true });
assert.equal(accepted.blocked, false);
assert.equal(accepted.changed, true);
assert.equal(store.get('account'), accountB);
assert.deepEqual(persisted, ['account-b'], '只有用户明确接受的账号切换才能更新共享确认值');
assert.deepEqual(selected, [['account-b', 'account-a']]);

store.set('accountSwitchGuard', () => { throw new Error('守卫失效'); });
const failedGuard = controller.select(accountA, { userInitiated: true });
assert.equal(failedGuard.blocked, true, '守卫异常必须 fail-closed');
assert.equal(store.get('account'), accountB);
assert.match(blocked.at(-1), /暂时无法确认/);

// 共享 store 是所有页面账号/状态订阅的 fan-out 边界:一个页面 listener
// 失败不能阻断后续页面或持久化观察者,但必须留下可诊断的错误记录。
{
  const fanoutStore = createStore({ account: null });
  const order = [];
  const persistedAccounts = [];
  const diagnostics = [];
  const previousConsoleError = console.error;
  console.error = (...args) => diagnostics.push(args);
  try {
    fanoutStore.subscribe('account', () => {
      order.push('key-failing');
      throw new Error('key listener failed');
    });
    fanoutStore.subscribe('account', account => {
      order.push('key-later');
      persistedAccounts.push(account?.id || '');
    });
    fanoutStore.subscribe('*', () => {
      order.push('any-failing');
      throw new Error('any listener failed');
    });
    fanoutStore.subscribe('*', key => {
      order.push(`any-later:${key}`);
    });

    fanoutStore.set('account', accountA);
  } finally {
    console.error = previousConsoleError;
  }
  assert.deepEqual(order, [
    'key-failing',
    'key-later',
    'any-failing',
    'any-later:account',
  ], '坏 listener 后必须按注册顺序继续通知后续 key/全局 listener');
  assert.deepEqual(persistedAccounts, ['account-a'],
    '后续持久化观察者必须仍收到完整账号变更');
  assert.equal(diagnostics.length, 2,
    '每个坏 listener 都必须留下可观测诊断,不能静默吞错');
  assert.equal(diagnostics[0][0], 'store listener failed');
  assert.equal(diagnostics[0][1]?.message, 'key listener failed');
  assert.equal(diagnostics[1][1]?.message, 'any listener failed');
}

// 诊断 hook 自身异常也不能把 fan-out 变成 fail-fast;必须继续通知后续观察者。
{
  const resilientStore = createStore({ account: null });
  const order = [];
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  console.error = () => {
    order.push('diagnostic-error');
    throw new Error('diagnostic sink failed');
  };
  console.warn = (...args) => {
    order.push('diagnostic-fallback');
    assert.equal(args[0], 'store listener failed');
    assert.equal(args[1]?.message, 'listener failed');
  };
  try {
    resilientStore.subscribe('account', () => {
      order.push('listener-failing');
      throw new Error('listener failed');
    });
    resilientStore.subscribe('account', account => {
      order.push(`listener-later:${account?.id || ''}`);
    });
    resilientStore.set('account', accountA);
  } finally {
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  }
  assert.deepEqual(order, [
    'listener-failing',
    'diagnostic-error',
    'diagnostic-fallback',
    'listener-later:account-a',
  ], '主诊断输出 hook 抛错时必须走备用诊断并继续通知后续 listener');
}

console.log('web account switching tests passed');
