import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createStore } from '../src/web/public/js/store.js';
import {
  accountSwitchLoadingMessage,
  createAccountSelectionController,
} from '../src/web/public/js/shared/account-selection.js';

globalThis.window = { __WX_LAUNCH_FOCUS_TOKEN__: '', addEventListener() {} };
globalThis.location = new URL('http://wx-summary.test/#/settings');
globalThis.history = {
  state: null,
  replaceState(_state, _title, value) {
    globalThis.location.href = new URL(String(value), globalThis.location.href).href;
  },
};
globalThis.document = {
  title: '',
  activeElement: null,
  body: {},
  documentElement: {},
  head: { appendChild() {} },
  navEntries: [],
  querySelectorAll(selector) {
    return selector === '.nav-item[data-route]' ? this.navEntries : [];
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

const [{ createRouter }, mainSource] = await Promise.all([
  import('../src/web/public/js/router.js'),
  readFile(new URL('../src/web/public/js/main.js', import.meta.url), 'utf8'),
]);

const accountA = { id: 'account-a', display_name: '账号 A' };
const accountB = { id: 'account-b', display_name: '账号 B' };
const blocked = [];
const store = createStore({
  account: accountA,
  accountSwitchGuard: accountSwitchLoadingMessage(),
});
const selection = createAccountSelectionController({
  store,
  onBlocked: message => blocked.push(message),
});
let releaseModule;
const moduleReady = new Promise(resolve => { releaseModule = resolve; });
let loadStarted;
const loadStartedPromise = new Promise(resolve => { loadStarted = resolve; });
const root = {
  scrollTop: 0,
  replaceChildren() {},
  querySelector() { return null; },
  contains() { return false; },
};
const router = createRouter({
  root,
  routes: {
    settings: {
      load: async () => {
        loadStarted();
        await moduleReady;
        return {
          default: {
            title: '设置',
            async mount() {
              store.set('accountSwitchGuard', () => '');
            },
          },
        };
      },
    },
  },
  onRouteLoading: route => {
    store.set('accountSwitchGuard', accountSwitchLoadingMessage(route));
  },
});

const navigation = router.route();
await loadStartedPromise;
const blockedDuringLoad = selection.select(accountB, { userInitiated: true });
assert.equal(blockedDuringLoad.blocked, true, '账号菜单在动态页面模块加载期间必须 fail-closed');
assert.equal(store.get('account'), accountA, '动态加载期间被拒绝时当前账号必须保持不变');
assert.match(blocked.at(-1), /设置页正在读取当前设置/);

releaseModule();
await navigation;
const acceptedAfterMount = selection.select(accountB, { userInitiated: true });
assert.equal(acceptedAfterMount.blocked, false, '页面挂载并接管 guard 后应允许空闲账号切换');
assert.equal(store.get('account'), accountB);

assert.match(mainSource, /accountSwitchGuard:\s*accountSwitchLoadingMessage\(\)/,
  '壳层初始 store 必须持有 fail-closed 账号 guard');
assert.match(mainSource, /onRouteLoading:\s*name\s*=>\s*\{[\s\S]*?accountSwitchLoadingMessage\(name\)/,
  '壳层必须在路由动态加载窗口设置按路由的 fail-closed guard');

const focusCalls = [];
globalThis.document.navEntries = [{
  dataset: { route: 'old' },
  classList: { toggle() {} },
  setAttribute() {},
  removeAttribute() {},
  focus() { focusCalls.push('old'); },
}];
store.set('account', accountA);
store.set('accountSwitchGuard', () => '');
let loadingGuardShouldThrow = false;
let oldUnmounts = 0;
let nextLoads = 0;
let nextMounts = 0;
const routerWithFailedLoadingGuard = createRouter({
  root,
  routes: {
    old: {
      load: async () => ({
        default: {
          title: '旧页 fixture',
          canLeave: () => true,
          async mount() {},
          async unmount() { oldUnmounts += 1; },
        },
      }),
    },
    next: {
      load: async () => {
        nextLoads += 1;
        return {
          default: {
            title: '新页 fixture',
            async mount() { nextMounts += 1; },
          },
        };
      },
    },
  },
  onRouteLoading: () => {
    if (loadingGuardShouldThrow) throw new Error('fixture loading guard failure');
  },
});

globalThis.location.hash = '#/old';
await routerWithFailedLoadingGuard.route();
loadingGuardShouldThrow = true;
globalThis.location.hash = '#/next';
await routerWithFailedLoadingGuard.route();
assert.equal(routerWithFailedLoadingGuard.currentName(), 'old',
  '加载守卫异常时必须保留旧页');
assert.equal(globalThis.location.hash, '#/old',
  '加载守卫异常时 hash 必须回到旧页');
assert.equal(oldUnmounts, 0,
  '加载守卫异常时不得卸载旧页');
assert.equal(nextLoads, 0,
  '加载守卫异常时不得加载目标页');
assert.equal(nextMounts, 0,
  '加载守卫异常时不得挂载目标页');
assert.equal(store.get('account'), accountA,
  '加载守卫异常时账号必须保持不变');
assert.deepEqual(focusCalls, ['old'],
  '加载守卫异常时焦点必须回到旧页导航项');

console.log('web settings route initialization guard tests passed');
