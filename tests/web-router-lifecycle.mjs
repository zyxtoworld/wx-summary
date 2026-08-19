import assert from 'node:assert/strict';
import { createPageTaskScope } from '../src/web/public/js/shared/page-task.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

globalThis.window = {
  __WX_LAUNCH_FOCUS_TOKEN__: '',
  addEventListener() {},
};
globalThis.location = new URL('http://wx-summary.test/#/digest');
globalThis.history = {
  state: null,
  replaceState(_state, _title, value) {
    globalThis.location.href = new URL(String(value), globalThis.location.href).href;
  },
};
let focusedRoute = '';
const navItems = ['digest', 'history'].map(route => ({
  dataset: { route },
  classList: { toggle() {} },
  setAttribute() {},
  removeAttribute() {},
  focus() { focusedRoute = route; },
}));
globalThis.document = {
  title: '',
  head: { appendChild() {} },
  querySelectorAll(selector) {
    return selector === '.nav-item[data-route]' ? navItems : [];
  },
  createElement(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      dataset: {},
      classList: { toggle() {}, add() {} },
      setAttribute() {},
      removeAttribute() {},
      append() {},
      appendChild() {},
    };
  },
};

const { createRouter } = await import('../src/web/public/js/router.js');

let digestScope = null;
const mounted = [];
const routes = {
  digest: {
    async load() {
      return {
        default: {
          title: 'digest',
          async mount() {
            mounted.push('digest');
            digestScope = createPageTaskScope();
            return () => digestScope.dispose();
          },
        },
      };
    },
  },
  history: {
    async load() {
      return { default: { title: 'history', async mount() { mounted.push('history'); } } };
    },
  },
};
const root = { replaceChildren() {}, appendChild() {} };
let rejectRouteLoading = false;
const routeLoadingCalls = [];
const router = createRouter({
  root,
  routes,
  onRouteLoading(name, from) {
    routeLoadingCalls.push([name, from]);
    if (rejectRouteLoading) throw new Error('route loading guard unavailable');
  },
});
await router.route();
assert.deepEqual(routeLoadingCalls, [['digest', '']], '首次挂载也必须经过路由加载守卫');

// 首次挂载没有旧页可以恢复。关键加载守卫失败时必须渲染明确故障状态，
// 不能让 #app 保持空白并把用户留在不可重试的目标 hash。
{
  const initialRootChildren = [];
  let initialLoads = 0;
  let initialMounts = 0;
  const initialFailureRouter = createRouter({
    root: {
      replaceChildren() { initialRootChildren.length = 0; },
      appendChild(node) { initialRootChildren.push(node); },
      scrollTop: 0,
    },
    routes: {
      settings: {
        async load() {
          initialLoads += 1;
          return {
            default: {
              title: 'settings',
              async mount() { initialMounts += 1; },
            },
          };
        },
      },
    },
    onRouteLoading() {
      throw new Error('initial loading guard unavailable');
    },
  });
  globalThis.location.hash = '#/settings';
  await initialFailureRouter.route();
  assert.equal(initialLoads, 0, '初始加载守卫失败时不得继续加载目标模块');
  assert.equal(initialMounts, 0, '初始加载守卫失败时不得挂载目标页面');
  assert.equal(initialRootChildren.at(-1)?.className, 'page-load-failure',
    '初始加载守卫失败时必须显示显式故障占位,不能留下空白 app');
}

rejectRouteLoading = true;
const routeGuardErrors = [];
const originalConsoleError = console.error;
console.error = (...args) => { routeGuardErrors.push(args.map(String).join(' ')); };
try {
  globalThis.location.hash = '#/history';
  await router.route();
} finally {
  console.error = originalConsoleError;
}
assert.deepEqual(mounted, ['digest'], '加载守卫抛错时不得卸载旧页或挂载新页');
assert.equal(router.currentName(), 'digest', '加载守卫抛错时当前页必须保持不变');
assert.equal(globalThis.location.hash, '#/digest', '加载守卫抛错时 hash 必须恢复到旧页');
assert.equal(focusedRoute, 'digest', '加载守卫抛错时焦点必须回到旧页导航项');
assert.deepEqual(routeLoadingCalls.at(-1), ['history', 'digest']);
assert.match(routeGuardErrors.join('\n'), /route loading guard failed/);

rejectRouteLoading = false;
globalThis.location.hash = '#/digest';
await router.route();

const successGate = deferred();
const uiWrites = [];
const lateSuccess = digestScope.run(
  () => successGate.promise,
  {
    onSuccess: value => uiWrites.push(`success:${value}`),
    onError: error => uiWrites.push(`error:${error.message}`),
  },
);
globalThis.location.hash = '#/history';
await router.route();
successGate.resolve('late');
assert.deepEqual(await lateSuccess, { status: 'stale' });
assert.deepEqual(uiWrites, [], '路由 cleanup 后晚到的成功响应不得回写新页面 UI');

globalThis.location.hash = '#/digest';
await router.route();
const failureGate = deferred();
const lateFailure = digestScope.run(
  () => failureGate.promise,
  {
    onSuccess: value => uiWrites.push(`success:${value}`),
    onError: error => uiWrites.push(`error:${error.message}`),
  },
);
globalThis.location.hash = '#/history';
await router.route();
failureGate.reject(new Error('late failure'));
assert.deepEqual(await lateFailure, { status: 'stale' });
assert.deepEqual(uiWrites, [], '路由 cleanup 后晚到的异常不得弹出旧页面错误');

const activeScope = createPageTaskScope();
const applied = await activeScope.run(
  async () => 'current',
  { onSuccess: value => uiWrites.push(`success:${value}`) },
);
assert.deepEqual(applied, { status: 'applied', value: 'current' });
assert.deepEqual(uiWrites, ['success:current']);

const accountScope = createPageTaskScope();
const lateAccountTask = deferred();
const lateAccountRun = accountScope.run(
  () => lateAccountTask.promise,
  { onSuccess: value => uiWrites.push(`late-account:${value}`) },
);
assert.equal(accountScope.invalidate(), true,
  '账号上下文变化必须能失效页面任务但保留 scope 供新账号继续使用');
lateAccountTask.resolve('old-account');
assert.deepEqual(await lateAccountRun, { status: 'stale' },
  '账号切换后旧 task 晚到不得继续投影');
const newAccountRun = await accountScope.run(
  async () => 'new-account',
  { onSuccess: value => uiWrites.push(`new-account:${value}`) },
);
assert.deepEqual(newAccountRun, { status: 'applied', value: 'new-account' });
assert.equal(uiWrites.includes('late-account:old-account'), false,
  '旧账号任务不得写入当前 UI');
assert.equal(uiWrites.includes('new-account:new-account'), true,
  '失效旧任务后新账号任务仍必须可正常执行');
assert.deepEqual(mounted, ['digest', 'history', 'digest', 'history']);

console.log('web router lifecycle tests passed');
