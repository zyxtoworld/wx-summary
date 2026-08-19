import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const routerSource = await readFile(
  new URL('../src/web/public/js/router.js', import.meta.url),
  'utf8',
);

function extractFunction(moduleSource, marker) {
  const start = moduleSource.indexOf(marker);
  assert.ok(start >= 0, `缺少生产函数: ${marker}`);
  const open = moduleSource.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < moduleSource.length; index += 1) {
    const char = moduleSource[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return moduleSource.slice(start, index + 1);
  }
  throw new Error(`生产函数未闭合: ${marker}`);
}

const setupSource = await readFile(
  new URL('../src/web/public/js/pages/setup/index.js', import.meta.url),
  'utf8',
);
assert.match(routerSource,
  /function reportRouteLoadingFailure\([\s\S]*?page\?\.onRouteLoadingFailure\?\./,
  'router 必须把加载守卫失败反馈给仍在当前页的模块');
assert.match(setupSource, /onRouteLoadingFailure\(\)\s*\{[\s\S]*activePage\?\.handleRouteLoadingFailure\?\./,
  'setup 模块必须接收 router 加载失败反馈');
const goFinishSource = extractFunction(setupSource, '  async function goFinish()');

let currentHash = '#/setup';
const hashListeners = [];
const hashChanges = [];
const locationObject = {
  get hash() { return currentHash; },
  set hash(value) {
    currentHash = String(value);
    const change = new Promise(resolve => {
      setImmediate(() => {
        for (const listener of hashListeners) listener();
        resolve();
      });
    });
    hashChanges.push(change);
  },
  get href() { return `http://wx-summary-setup.test/${currentHash}`; },
};

globalThis.window = {
  __WX_LAUNCH_FOCUS_TOKEN__: '',
  addEventListener(type, listener) {
    if (type === 'hashchange') hashListeners.push(listener);
  },
};
globalThis.location = locationObject;
globalThis.history = {
  state: null,
  replaceState(_state, _title, value) {
    currentHash = new URL(String(value), locationObject.href).hash;
  },
};
globalThis.document = {
  title: '',
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

const { createRouter } = await import('../src/web/public/js/router.js');

let shell = null;
let rejectDigestLoading = true;
let routeFailureCalls = 0;
let digestMounts = 0;
const routes = {
  setup: {
    async load() {
      return {
        default: {
          title: 'setup fixture',
          async mount() {
            return () => {
              if (shell) {
                shell.page.destroyed = true;
                shell.page.completionNavigationPending = false;
              }
            };
          },
          canLeave: () => true,
          onRouteLoadingFailure() {
            routeFailureCalls += 1;
            shell?.onNavigationFailure();
          },
        },
      };
    },
  },
  digest: {
    async load() {
      return {
        default: {
          title: 'digest fixture',
          async mount() { digestMounts += 1; },
        },
      };
    },
  },
};
const router = createRouter({
  root: { replaceChildren() {}, appendChild() {}, scrollTop: 0 },
  routes,
  onRouteLoading(name) {
    if (name === 'digest' && rejectDigestLoading) {
      throw new Error('fixture route loading guard failure');
    }
  },
});

router.start();
await router.route();

function createSetupShell() {
  const page = {
    destroyed: false,
    busy: false,
    completionNavigationPending: false,
  };
  let finishCalls = 0;
  const notices = [];
  const step = {
    async finish() {
      finishCalls += 1;
      router.navigate('#/digest');
      return true;
    },
  };
  const goFinish = new Function(
    'stepBusy',
    'currentStep',
    'w',
    'page',
    'refreshButtons',
    'showPageNotice',
    `${goFinishSource}\nreturn goFinish;`,
  )(
    () => page.busy,
    () => step,
    { beginAsync() { return 1; } },
    page,
    () => {},
    (kind, text) => notices.push({ kind, text }),
  );
  return {
    page,
    goFinish,
    notices,
    get finishCalls() { return finishCalls; },
    onNavigationFailure() {
      page.completionNavigationPending = false;
      notices.push({ kind: 'err', text: '进入总结页失败,请重试。' });
    },
  };
}

shell = createSetupShell();
await shell.goFinish();
await hashChanges.at(-1);
await router.route();
assert.equal(router.currentName(), 'setup', '加载守卫失败时必须留在 setup 页面');
assert.equal(currentHash, '#/setup', '加载守卫失败时 hash 必须恢复到 setup');
assert.equal(routeFailureCalls, 1, '旧 setup 必须收到一次导航失败反馈');
assert.equal(shell.page.completionNavigationPending, false,
  '导航失败后必须释放 setup completionNavigationPending');
assert.equal(shell.notices.length, 1, '导航失败必须给出一次可操作错误提示');

await shell.goFinish();
assert.equal(shell.finishCalls, 2,
  '导航失败恢复后第二次完成必须允许重新执行 finish');
await hashChanges.at(-1);
await router.route();
assert.equal(router.currentName(), 'setup');

rejectDigestLoading = false;
await shell.goFinish();
assert.equal(shell.finishCalls, 3, '恢复后的成功导航只能提交一次');
await hashChanges.at(-1);
await router.route();
assert.equal(router.currentName(), 'digest', '加载守卫恢复后必须完成真实路由切换');
assert.equal(digestMounts, 1, '成功导航必须只挂载一次总结页');

console.log('web setup finish navigation failure tests passed');
