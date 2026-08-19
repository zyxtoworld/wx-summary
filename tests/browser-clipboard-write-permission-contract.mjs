import assert from 'node:assert/strict';
import {
  BROWSER_CLIPBOARD_PERMISSION_UPDATED_EVENT,
  clipboardPermissionDenied,
  createClipboardPermissionController,
  normalizeClipboardPermissionState,
} from '../src/web/public/js/shared/clipboard-permission.js';

assert.equal(normalizeClipboardPermissionState('granted'), 'granted');
assert.equal(normalizeClipboardPermissionState('prompt'), 'prompt');
assert.equal(normalizeClipboardPermissionState('denied'), 'denied');
assert.equal(normalizeClipboardPermissionState('unknown-value'), 'unknown');
assert.equal(clipboardPermissionDenied('denied'), true);
assert.equal(clipboardPermissionDenied('prompt'), false);

const listeners = new Map();
const windowTarget = {
  addEventListener(type, listener) { listeners.set(`window:${type}`, listener); },
  removeEventListener(type, listener) {
    if (listeners.get(`window:${type}`) === listener) listeners.delete(`window:${type}`);
  },
  dispatchEvent() {},
};
const documentTarget = {
  visibilityState: 'visible',
  addEventListener(type, listener) { listeners.set(`document:${type}`, listener); },
  removeEventListener(type, listener) {
    if (listeners.get(`document:${type}`) === listener) listeners.delete(`document:${type}`);
  },
};
const queried = [];
const permissionStates = new Map([
  ['clipboard-write', 'prompt'],
  ['clipboard-read', 'granted'],
]);
const controller = createClipboardPermissionController({
  navigatorTarget: {
    permissions: {
      async query({ name }) {
        queried.push(name);
        return { state: permissionStates.get(name) || 'unknown' };
      },
    },
  },
  windowTarget,
  documentTarget,
  eventTarget: windowTarget,
});
const updates = [];
const unsubscribe = controller.subscribe(state => updates.push(state));
assert.deepEqual(await controller.refresh(), { write: 'prompt', read: 'granted' });
assert.equal(controller.isWriteDenied(), false, 'prompt is retryable and must not be treated as a hard denial');
assert.deepEqual(queried, ['clipboard-write', 'clipboard-read']);
assert.equal(updates.length, 1);

permissionStates.set('clipboard-write', 'denied');
listeners.get('window:focus')();
await new Promise(resolve => setImmediate(resolve));
assert.equal(controller.isWriteDenied(), true, 'an explicit denied permission must block browser writes');
assert.equal(updates.at(-1).write, 'denied');
assert.ok(BROWSER_CLIPBOARD_PERMISSION_UPDATED_EVENT.includes('clipboard-permission'));

// 权限通知也是生产页面的 subscriber fan-out：坏观察者不得阻断后续观察者，
// 但异常必须沿可观测诊断路径留下，而不是静默丢失。
const notificationOrder = [];
const notificationDiagnostics = [];
const originalConsoleError = console.error;
console.error = (...args) => notificationDiagnostics.push(args);
const notificationController = createClipboardPermissionController({
  navigatorTarget: {
    permissions: {
      async query() { return { state: 'prompt' }; },
    },
  },
  windowTarget: { addEventListener() {}, removeEventListener() {} },
  documentTarget: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
  eventTarget: { dispatchEvent() {} },
});
notificationController.subscribe(() => {
  notificationOrder.push('bad');
  throw new Error('permission listener failed');
});
notificationController.subscribe(() => notificationOrder.push('later'));
try {
  await notificationController.refresh();
} finally {
  console.error = originalConsoleError;
  notificationController.dispose();
}
assert.deepEqual(notificationOrder, ['bad', 'later'],
  '坏权限观察者不得阻断后续观察者');
assert.equal(notificationDiagnostics.length, 1,
  '坏权限观察者必须留下可观测诊断');
assert.equal(notificationDiagnostics[0][0], 'clipboard permission listener failed');
assert.equal(notificationDiagnostics[0][1]?.message, 'permission listener failed');

// 主诊断 sink 自身异常时，真实权限 fan-out 仍必须保留备用可观测诊断。
{
  const order = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = () => {
    order.push('diagnostic-error');
    throw new Error('diagnostic sink failed');
  };
  console.warn = (...args) => {
    order.push('diagnostic-fallback');
    assert.equal(args[0], 'clipboard permission listener failed');
    assert.equal(args[1]?.message, 'permission listener failed');
  };
  const fallbackController = createClipboardPermissionController({
    navigatorTarget: {
      permissions: {
        async query() { return { state: 'prompt' }; },
      },
    },
    windowTarget: { addEventListener() {}, removeEventListener() {} },
    documentTarget: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    eventTarget: { dispatchEvent() {} },
  });
  fallbackController.subscribe(() => {
    order.push('bad');
    throw new Error('permission listener failed');
  });
  fallbackController.subscribe(() => order.push('later'));
  try {
    await fallbackController.refresh();
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
    fallbackController.dispose();
  }
  assert.deepEqual(order, [
    'bad',
    'diagnostic-error',
    'diagnostic-fallback',
    'later',
  ], '主诊断 sink 失败时权限 fan-out 必须走备用诊断并继续通知');
}

unsubscribe();
controller.dispose();
assert.equal(listeners.has('window:focus'), false, 'disposing a page must remove permission refresh listeners');
assert.equal(listeners.has('document:visibilitychange'), false);

// 初始化刷新与复制点击/窗口 focus 刷新可以并发；旧查询晚到不得覆盖较新的权限快照。
const pendingQueries = [];
const raceController = createClipboardPermissionController({
  navigatorTarget: {
    permissions: {
      query() {
        return new Promise(resolve => pendingQueries.push(resolve));
      },
    },
  },
  windowTarget: { addEventListener() {}, removeEventListener() {} },
  documentTarget: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
  eventTarget: { dispatchEvent() {} },
});
const staleRefresh = raceController.refresh();
await Promise.resolve();
const freshRefresh = raceController.refresh();
await Promise.resolve();
assert.equal(pendingQueries.length, 4, '两次并发权限刷新必须各自查询读写权限');
pendingQueries[2]({ state: 'granted' });
pendingQueries[3]({ state: 'granted' });
await freshRefresh;
pendingQueries[0]({ state: 'denied' });
pendingQueries[1]({ state: 'denied' });
await staleRefresh;
assert.deepEqual(raceController.state(), { write: 'granted', read: 'granted' },
  '旧权限查询晚到时不得覆盖更新一轮的权限状态');
raceController.dispose();

console.log('browser clipboard-write permission contract passed');
