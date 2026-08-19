import assert from 'node:assert/strict';

globalThis.window = {
  __WX_LAUNCH_FOCUS_TOKEN__: '',
  addEventListener() {},
};
globalThis.location = new URL('http://wx-summary.test/#/unknown-page');
globalThis.history = {
  state: null,
  replaceState(_state, _title, value) {
    globalThis.location.href = new URL(String(value), globalThis.location.href).href;
  },
};
globalThis.document = {
  title: '',
  head: { appendChild() {} },
  navEntries: [],
  querySelectorAll(selector) {
    if (selector === '.nav-item[data-route]') return this.navEntries;
    return [];
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

const {
  PRODUCTION_ROUTE_NAMES,
  createProductionRoutes,
} = await import('../src/web/public/js/production-routes.js');
const { createRouter } = await import('../src/web/public/js/router.js');

const loadCalls = [];
const mountCalls = [];
let blockHistoryLeave = false;
let historyLeaveHandler = null;
const routes = createProductionRoutes(async path => {
  loadCalls.push(path);
  const name = path.match(/pages\/([^/]+)\/index\.js$/)?.[1] || '';
  return {
    default: {
      title: name,
      async mount() { mountCalls.push(name); },
      async canLeave(target) {
        if (name !== 'history') return true;
        return historyLeaveHandler ? historyLeaveHandler(target) : !blockHistoryLeave;
      },
    },
  };
});

assert.deepEqual(PRODUCTION_ROUTE_NAMES, ['digest', 'history', 'settings', 'setup']);
assert.deepEqual(Object.keys(routes), PRODUCTION_ROUTE_NAMES, '生产路由必须显式且只注册四个页面');
for (const name of PRODUCTION_ROUTE_NAMES) await routes[name].load();
assert.deepEqual(loadCalls, PRODUCTION_ROUTE_NAMES.map(name => `./pages/${name}/index.js`));

loadCalls.length = 0;
const root = {
  scrollTop: 127,
  replaceChildren() {},
  appendChild() {},
};
const navFocusCalls = [];
globalThis.document.navEntries = PRODUCTION_ROUTE_NAMES.map(name => ({
  dataset: { route: name },
  classList: { toggle() {} },
  setAttribute() {},
  removeAttribute() {},
  focus() { navFocusCalls.push(name); },
}));
const router = createRouter({ root, routes });
await router.route();
assert.equal(root.scrollTop, 0, '切换到新页面前必须从内容顶部开始');
assert.equal(router.currentName(), 'digest', '未知路由必须 fail-closed 到默认页面');
assert.equal(globalThis.location.hash, '#/digest', '未知路由必须把地址栏规范化为明确默认页面');
assert.deepEqual(mountCalls, ['digest']);

globalThis.location.hash = '#/unknown-after-digest';
await router.route();
assert.equal(globalThis.location.hash, '#/digest', '默认页已挂载时未知 hash 仍必须规范化地址栏');
assert.deepEqual(mountCalls, ['digest'], '未知 hash 回落到当前默认页不得重复挂载');

for (const name of ['history', 'settings', 'setup']) {
  globalThis.location.hash = `#/${name}`;
  await router.route();
}
assert.deepEqual(mountCalls, ['digest', 'history', 'settings', 'setup'], '四个生产页面必须都能通过同一路由表挂载');

globalThis.location.hash = '#/history';
await router.route();
blockHistoryLeave = true;
globalThis.location.hash = '#/unknown-while-history-blocks';
await router.route();
assert.equal(router.currentName(), 'history', '离开守卫拒绝未知路由时必须保留当前页面');
assert.equal(globalThis.location.hash, '#/history', '离开守卫拒绝未知路由时必须恢复当前页 hash');
assert.equal(navFocusCalls.at(-1), 'history', '离开守卫拒绝后焦点必须回到当前活动路由入口');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

blockHistoryLeave = false;
const firstGuardStarted = deferred();
const firstGuardResult = deferred();
const guardedTargets = [];
historyLeaveHandler = target => {
  guardedTargets.push(target);
  if (guardedTargets.length === 1) {
    firstGuardStarted.resolve();
    return firstGuardResult.promise;
  }
  return true;
};

globalThis.location.hash = '#/settings';
const rejectedSettingsRoute = router.route();
await firstGuardStarted.promise;
globalThis.location.hash = '#/setup';
const latestSetupRoute = router.route();
firstGuardResult.resolve(false);
await Promise.all([rejectedSettingsRoute, latestSetupRoute]);

assert.deepEqual(guardedTargets, ['settings', 'setup'], '等待守卫期间的新目标必须继续进入下一轮守卫');
assert.equal(router.currentName(), 'setup', '旧导航被拒绝后仍必须处理最新的有效路由');
assert.equal(globalThis.location.hash, '#/setup', '拒绝旧导航不得覆盖等待期间的新 hash');

historyLeaveHandler = null;
globalThis.location.hash = '#/history';
await router.route();

const allowedGuardStarted = deferred();
const allowedGuardResult = deferred();
const targetSpecificCalls = [];
historyLeaveHandler = target => {
  targetSpecificCalls.push(target);
  if (targetSpecificCalls.length === 1) {
    allowedGuardStarted.resolve();
    return allowedGuardResult.promise;
  }
  return false;
};

globalThis.location.hash = '#/settings';
const obsoleteAllowedSettingsRoute = router.route();
await allowedGuardStarted.promise;
globalThis.location.hash = '#/setup';
const rejectedLatestSetupRoute = router.route();
allowedGuardResult.resolve(true);
await Promise.all([obsoleteAllowedSettingsRoute, rejectedLatestSetupRoute]);

assert.deepEqual(targetSpecificCalls, ['settings', 'setup'], '旧目标的离开许可不得放行等待期间出现的新目标');
assert.equal(router.currentName(), 'history', '最新 setup 导航被第二次守卫拒绝后必须保留 history');
assert.equal(globalThis.location.hash, '#/history', '第二次守卫拒绝最新目标时必须恢复 history hash');
assert.equal(navFocusCalls.at(-1), 'history', '最新目标被拒绝后焦点仍必须回到当前活动路由入口');

console.log('web route registry tests passed');
