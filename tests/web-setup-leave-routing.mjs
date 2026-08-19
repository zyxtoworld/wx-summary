import assert from 'node:assert/strict';
import { createSetupLeaveGuard } from '../src/web/public/js/pages/setup/leave-guard.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

globalThis.window = {
  __WX_LAUNCH_FOCUS_TOKEN__: '',
  addEventListener() {},
};
globalThis.location = new URL('http://wx-summary-setup.test/#/setup');
globalThis.history = {
  state: null,
  replaceState(_state, _title, value) {
    globalThis.location.href = new URL(String(value), globalThis.location.href).href;
  },
};
globalThis.document = {
  title: '',
  body: { closest: () => null },
  documentElement: {},
  activeElement: null,
  head: { appendChild() {} },
  querySelectorAll() { return []; },
  createElement(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      dataset: {},
      classList: { toggle() {} },
      setAttribute() {},
      removeAttribute() {},
      append() {},
      appendChild() {},
    };
  },
};
globalThis.document.activeElement = globalThis.document.body;

const { createRouter } = await import('../src/web/public/js/router.js');

const root = {
  scrollTop: 0,
  replaceChildren() {},
  appendChild() {},
  contains() { return false; },
  querySelector() { return null; },
};
const wizard = { llm: { dirty: true }, key: { draft: '' } };
const confirmations = [];
const mounted = [];
const confirmLeave = createSetupLeaveGuard(() => ({
  wiz: wizard,
  busy: false,
  confirmDialog: () => {
    const confirmation = deferred();
    confirmations.push(confirmation);
    return confirmation.promise;
  },
}));
const routes = {};
for (const name of ['setup', 'history', 'digest']) {
  routes[name] = {
    async load() {
      return {
        default: {
          title: name,
          async mount() { mounted.push(name); },
          ...(name === 'setup' ? {
            canLeave: confirmLeave,
          } : {}),
        },
      };
    },
  };
}

const router = createRouter({ root, routes });
await router.route();
assert.deepEqual(mounted, ['setup']);

// 第一个确认尚未结算时，用户又点击了另一个真实导航入口。
globalThis.location.hash = '#/history';
const firstRoute = router.route();
for (let attempt = 0; attempt < 20 && confirmations.length < 1; attempt += 1) {
  await Promise.resolve();
}
assert.equal(confirmations.length, 1, '第一次离开请求必须只打开一个确认');

globalThis.location.hash = '#/digest';
const latestRoute = router.route();
for (let attempt = 0; attempt < 20; attempt += 1) await Promise.resolve();

confirmations[0].resolve(true);
for (let attempt = 0; attempt < 20 && confirmations.length < 2; attempt += 1) {
  await Promise.resolve();
}
assert.equal(confirmations.length, 1,
  '旧目标被最新 hash 取代后,一次确认应授权最后意图,不得再次弹确认');

await firstRoute;
await latestRoute;
assert.equal(router.currentName(), 'digest');
assert.deepEqual(mounted, ['setup', 'digest'], '确认一次后必须直接挂载最后目标页面');

// 本轮决定只覆盖当前事件循环;下一次用户操作必须重新确认。
await new Promise(resolve => setTimeout(resolve, 0));
const laterDecision = confirmLeave();
assert.equal(confirmations.length, 2, '旧离开决定过期后下一次操作必须重新确认');
confirmations[1].resolve(false);
assert.equal(await laterDecision, false, '后续取消决定必须阻止离开');

// StrictMode/重装得到独立 guard,不得继承旧页面的决定或 pending。
const remountedConfirmation = deferred();
let remountedConfirmCalls = 0;
const remountedGuard = createSetupLeaveGuard(() => ({
  wiz: wizard,
  busy: false,
  confirmDialog: () => {
    remountedConfirmCalls += 1;
    return remountedConfirmation.promise;
  },
}));
const remountedFirst = remountedGuard();
const remountedSecond = remountedGuard();
assert.equal(remountedConfirmCalls, 1, '重装页面自己的 guard 仍只能打开一个确认');
remountedConfirmation.resolve(false);
assert.equal(await remountedFirst, false);
assert.equal(await remountedSecond, false);

console.log('web setup leave routing tests passed');
